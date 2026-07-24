"""LLM 调用封装 — 统一的 AI API 调用层

职责：
1. 封装所有与 AI 供应商的 HTTP 通信
2. 对流式/非流式调用做统一处理
3. JSON 输出自动修复 + 重试（兜底）
4. 错误重试（指数退避，上限 3 次）

使用方式：
  from .llm_caller import LLMCaller
  caller = LLMCaller(provider_config, model)
  text = await caller.call(messages)           # 非流式，收集完整文本
  text = await caller.call_json(messages)      # 要求 JSON 输出，失败则修复+重试
  async for delta in caller.stream(messages):  # 流式迭代
      ...
"""

import json
import logging
import re
import time
import httpx
from typing import AsyncIterator, Optional, Callable
from .token_estimator import estimate_tokens, estimate_messages_tokens

logger = logging.getLogger("lubia.llm_caller")


class LLMCaller:
    """统一的 AI API 调用器"""

    def __init__(self, provider_config: dict, model: str):
        """
        Args:
            provider_config: {api_key, base_url, api_path}
            model: 模型名称
        """
        self._api_key = provider_config.get("api_key", "")
        self._base = provider_config.get("base_url", "").rstrip("/")
        self._path = provider_config.get("api_path", "/v1/chat/completions")
        self._model = model

        if not self._path.startswith("/"):
            self._path = "/" + self._path
        if not self._api_key:
            raise ValueError("API Key 未配置")

    @property
    def url(self) -> str:
        return f"{self._base}{self._path}"

    @property
    def auth_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    # ── 非流式调用 ──

    async def call(
        self,
        messages: list[dict],
        *,
        max_retries: int = 2,
        abort_check: Optional[Callable] = None,
    ) -> str:
        """非流式调用 AI → 返回完整响应文本

        Args:
            messages: 消息列表
            max_retries: 网络错误最大重试次数
            abort_check: 可选的终止检查

        Returns:
            AI 返回的完整文本

        Raises:
            RuntimeError: API 返回错误或重试耗尽
        """
        # ── Debug: 调用前统计 ──
        total_chars = sum(len(m.get("content", "")) for m in messages)
        input_chars = total_chars
        sys_messages = [m for m in messages if m.get("role") == "system"]
        sys_chars = sum(len(m.get("content", "")) for m in sys_messages)
        user_msgs = [m for m in messages if m.get("role") == "user"]
        assistant_msgs = [m for m in messages if m.get("role") == "assistant"]
        est_input = estimate_messages_tokens(messages)

        logger.debug(
            f"LLM 调用 | url={self.url} | model={self._model} | "
            f"消息={len(messages)}条(sys:{len(sys_messages)} user:{len(user_msgs)} asst:{len(assistant_msgs)}) | "
            f"总字符={total_chars} | 估算token≈{est_input}"
        )
        if sys_messages:
            for i, sm in enumerate(sys_messages):
                content = sm.get("content", "")
                logger.debug(
                    f"  system[{i}] | 长度={len(content)}字符 | 行数={content.count(chr(10))}行 | "
                    f"预览={content[:80].replace(chr(10), ' ')}…"
                )

        body = {
            "model": self._model,
            "messages": messages,
            "stream": False,
            "temperature": 0.0,       # 工具调用场景必须确定性输出
            "top_p": 0.1,             # 极小随机性，防止格式漂移
        }

        last_error = None
        t0 = time.time()
        for attempt in range(max_retries + 1):
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(120.0, connect=10.0)
                ) as client:
                    resp = await client.post(
                        self.url, headers=self.auth_headers, json=body
                    )

                    if resp.status_code >= 400:
                        err_msg = self._parse_error(resp)
                        # 4xx 错误不重试（客户端错误）
                        if 400 <= resp.status_code < 500:
                            raise RuntimeError(err_msg)
                        # 5xx 可重试
                        last_error = RuntimeError(err_msg)
                        if attempt < max_retries:
                            await self._backoff(attempt)
                            continue
                        raise last_error

                    try:
                        data = resp.json()
                    except (json.JSONDecodeError, ValueError) as e:
                        last_error = RuntimeError(f"AI 返回了无法解析的响应: {str(e)}")
                        if attempt < max_retries:
                            await self._backoff(attempt)
                            continue
                        raise last_error

                    content = (
                        data.get("choices", [{}])[0]
                        .get("message", {})
                        .get("content", "")
                    )
                    elapsed = (time.time() - t0) * 1000
                    output_chars = len(content)
                    est_output = estimate_tokens(content)

                    # 读取 API 返回的实际 token 用量
                    actual_usage = data.get("usage", {})
                    actual_in = actual_usage.get("prompt_tokens", 0) or 0
                    actual_out = actual_usage.get("completion_tokens", 0) or 0
                    if actual_usage:
                        usage_str = f"实际token=[in={actual_in} out={actual_out} total={actual_usage.get('total_tokens','?')}]"
                    else:
                        usage_str = f"估算token=[in≈{est_input} out≈{est_output}]"

                    logger.debug(
                        f"LLM 响应 | 耗时={elapsed:.0f}ms | 内容长={output_chars}字符 | "
                        f"{usage_str}"
                    )

                    # 记录用量到 SQLite
                    _record_usage(
                        provider_id=self._model,  # 用 model 字段区分
                        model=self._model,
                        input_chars=input_chars,
                        output_chars=output_chars,
                        est_input_tokens=est_input,
                        est_output_tokens=est_output,
                        actual_input_tokens=actual_in,
                        actual_output_tokens=actual_out,
                    )

                    # 空内容也视为可疑，但直接返回让上层处理
                    return content

            except httpx.ConnectError as e:
                logger.debug(f"LLM 连接失败(第{attempt+1}次): {e}")
                last_error = RuntimeError(f"无法连接到 AI 服务器，请检查网络: {str(e)}")
                if attempt < max_retries:
                    await self._backoff(attempt)
                    continue
                raise last_error
            except httpx.TimeoutException as e:
                logger.debug(f"LLM 超时(第{attempt+1}次): {e}")
                last_error = RuntimeError(f"AI 响应超时（>120秒），请稍后重试: {str(e)}")
                if attempt < max_retries:
                    await self._backoff(attempt)
                    continue
                raise last_error
            except httpx.RemoteProtocolError as e:
                logger.debug(f"LLM 连接中断(第{attempt+1}次): {e}")
                last_error = RuntimeError(f"AI 服务器连接中断: {str(e)}")
                if attempt < max_retries:
                    await self._backoff(attempt)
                    continue
                raise last_error

        raise last_error or RuntimeError("未知错误")

    # ── 流式调用 ──

    async def stream(
        self,
        messages: list[dict],
        *,
        abort_check: Optional[Callable] = None,
    ) -> AsyncIterator[str]:
        """流式调用 AI → 逐 chunk 迭代 delta 文本

        Args:
            messages: 消息列表
            abort_check: 可选的终止检查（返回 True 时中断流）

        Yields:
            每个 delta 文本片段
        """
        body = {
            "model": self._model,
            "messages": messages,
            "stream": True,
            "temperature": 0.0,
            "top_p": 0.1,
        }

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0)
        ) as client:
            async with client.stream(
                "POST", self.url, headers=self.auth_headers, json=body
            ) as resp:
                if resp.status_code >= 400:
                    err_text = await resp.aread()
                    raise RuntimeError(self._parse_error(resp, err_text))

                async for line in resp.aiter_lines():
                    if abort_check and abort_check():
                        break

                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                        delta = (
                            obj.get("choices", [{}])[0]
                            .get("delta", {})
                            .get("content", "")
                        )
                        if delta:
                            yield delta
                    except json.JSONDecodeError:
                        pass

    # ── JSON 输出（带修复 + 重试）──

    async def call_json(
        self,
        messages: list[dict],
        *,
        max_retries: int = 2,
        abort_check: Optional[Callable] = None,
    ) -> Optional[dict]:
        """要求 AI 输出 JSON，解析失败则自动修复 + 重新要求 AI 输出

        重试策略：
        1. 直接 json.loads 解析
        2. 修复常见错误（单引号、尾部逗号）后重试
        3. 从文本中提取 JSON（找 { } 或 [ ] 边界）
        4. 如果以上都失败 → 在原消息后追加错误提示，重新调用 AI（最多 max_retries 次）

        Args:
            messages: 消息列表
            max_retries: AI 重新输出的最大次数
            abort_check: 可选的终止检查

        Returns:
            解析后的 dict 或 list，失败返回 None
        """
        for attempt in range(max_retries + 1):
            try:
                raw = await self.call(messages, abort_check=abort_check)
            except Exception:
                if attempt < max_retries:
                    await self._backoff(attempt)
                    continue
                return None

            # 尝试解析
            result = self._parse_json(raw)
            if result is not None:
                return result

            # 解析失败 → 追加错误提示，让 AI 重新输出
            if attempt < max_retries:
                messages.append({
                    "role": "assistant",
                    "content": raw[:500],
                })
                messages.append({
                    "role": "user",
                    "content": (
                        "你的上一条回复不是有效的 JSON 格式。请严格按照要求的 JSON 格式重新输出，"
                        "只输出 JSON，不要包含任何解释、注释或代码块标记。"
                    ),
                })
                await self._backoff(attempt)

        return None

    # ── JSON 输出 + Schema 校验 + 自动重试 ──

    async def call_and_validate(
        self,
        messages: list[dict],
        schema: dict,
        *,
        max_retries: int = 3,
        abort_check: Optional[Callable] = None,
    ) -> tuple[Optional[dict], int]:
        """调用 AI → 解析 JSON → Schema 校验 → 失败自动重试

        与 call_json 的区别：
        - call_json 只管"是不是合法 JSON"
        - call_and_validate 还要检查"JSON 的 type 字段是否合法、必填字段是否齐全"

        重试流程：
        1. 调 LLM → 拿到原始文本
        2. OutputValidator.validate() → 检查 type/必填字段/tool名称
        3. 校验失败 → 追加系统消息（格式纠正提示）→ 重新调 LLM
        4. 最多重试 max_retries 次

        Args:
            messages: 消息列表（会被原地修改！追加 assistant + system 消息）
            schema: get_schema(mode) 返回的格式定义
            max_retries: 最大重试次数（默认 3）
            abort_check: 可选的终止检查

        Returns:
            (parsed_dict_or_None, retries_used)
            - 成功: ({"type":"tool",...}, 0)
            - 重试后成功: ({"type":"final",...}, 2)
            - 全部失败: (None, max_retries)
        """
        from .output_schema import OutputValidator, build_retry_hint

        for attempt in range(max_retries + 1):
            # 调 LLM
            try:
                raw = await self.call(messages, abort_check=abort_check)
            except Exception as e:
                logger.debug(f"LLM 调用失败(第{attempt+1}次): {e}")
                if attempt < max_retries:
                    await self._backoff(attempt)
                    continue
                return None, attempt

            # 校验
            result = OutputValidator.validate(raw, schema)
            if result.ok:
                return result.parsed, attempt

            # 校验失败 → 构造重试提示
            if attempt < max_retries:
                logger.debug(
                    f"输出格式校验失败(第{attempt+1}/{max_retries}次) | "
                    f"error={result.error} | detail={result.error_detail[:80]}"
                )
                # 追加 AI 的原始输出（截断）
                messages.append({
                    "role": "assistant",
                    "content": raw[:500],
                })
                # 追加格式纠正提示
                hint = build_retry_hint(result, schema, attempt + 1, max_retries)
                messages.append({
                    "role": "system",
                    "content": hint,
                })
                await self._backoff(attempt)

        return None, max_retries

    # ── 内部工具 ──

    @staticmethod
    def _parse_json(raw: str) -> Optional[dict | list]:
        """多层 JSON 解析 + 修复

        尝试顺序：
        0. 正则预过滤：提取首个 { } 或 [ ] 块，丢弃前后的自然语言
        1. 纯 JSON 解析
        2. 替换单引号
        3. 移除尾部逗号
        4. ```json...``` 代码块提取
        5. 文本中 { } 或 [ ] 边界提取
        6. 修复字符串内未转义换行（AI 最常见错误）
        """
        raw = raw.strip()

        # 0. 正则预过滤：找到首个 { 或 [ 到最后一个 } 或 ]
        #    解决 "好的，让我看看。{"type":"tool",...}" 这类 AI 前缀问题
        if raw and raw[0] not in ('{', '['):
            for opener, closer in [("{", "}"), ("[", "]")]:
                start = raw.find(opener)
                end = raw.rfind(closer)
                if start != -1 and end != -1 and end > start:
                    raw = raw[start:end + 1]
                    break

        # 1. 直接解析
        try:
            obj = json.loads(raw)
            if isinstance(obj, (dict, list)):
                return obj
        except json.JSONDecodeError:
            pass

        # 2. 单引号 → 双引号
        try:
            obj = json.loads(raw.replace("'", '"'))
            if isinstance(obj, (dict, list)):
                return obj
        except json.JSONDecodeError:
            pass

        # 3. 移除尾部逗号 (},] 前面的逗号)
        cleaned = re.sub(r',\s*([}\]])', r'\1', raw)
        try:
            obj = json.loads(cleaned)
            if isinstance(obj, (dict, list)):
                return obj
        except json.JSONDecodeError:
            pass

        # 4. ```json ... ``` 代码块
        m = re.search(r'```(?:json)?\s*([\s\S]*?)```', raw)
        if m:
            return LLMCaller._parse_json(m.group(1))

        # 5. 找第一个 { 或 [  和对应的最后一个 } 或 ]
        for open_c, close_c in [("{", "}"), ("[", "]")]:
            start = raw.find(open_c)
            end = raw.rfind(close_c)
            if start != -1 and end != -1 and end > start:
                try:
                    obj = json.loads(raw[start:end + 1])
                    if isinstance(obj, (dict, list)):
                        return obj
                except json.JSONDecodeError:
                    pass

        # 6. 修复 JSON 字符串内未转义的物理换行（AI 最常见错误）
        #    AI 经常在 content 字段里写物理换行而不是 \n，导致 json.loads 失败
        #    此步骤追踪引号状态，把字符串内的 \n \r 替换为 \\n
        start = raw.find('{')
        end = raw.rfind('}')
        if start != -1 and end != -1 and end > start:
            fixed = LLMCaller._escape_newlines_in_strings(raw[start:end + 1])
            if fixed != raw[start:end + 1]:
                try:
                    obj = json.loads(fixed)
                    if isinstance(obj, (dict, list)):
                        return obj
                except json.JSONDecodeError:
                    pass

        return None

    @staticmethod
    def _escape_newlines_in_strings(s: str) -> str:
        """将 JSON 字符串值内的物理换行替换为 \\n 转义序列

        追踪引号状态：在字符串内部时，\\n → \\\\n, \\r → 跳过（\\r\\n 中的 \\r）
        不在字符串内部时保留原字符。
        """
        # 先统一换行符
        s = s.replace('\r\n', '\n').replace('\r', '\n')
        result = []
        in_string = False
        escape_next = False
        for ch in s:
            if escape_next:
                result.append(ch)
                escape_next = False
                continue
            if ch == '\\':
                result.append(ch)
                escape_next = True
                continue
            if ch == '"':
                in_string = not in_string
                result.append(ch)
                continue
            if in_string and ch == '\n':
                result.append('\\n')
                continue
            result.append(ch)
        return ''.join(result)

    @staticmethod
    def _parse_error(resp, raw_body: bytes = None) -> str:
        """从 AI API 错误响应中提取可读消息"""
        try:
            if raw_body:
                err_json = json.loads(raw_body)
            else:
                err_json = resp.json()
            err_msg = (
                err_json.get("error", {}).get("message", "")
                or err_json.get("message", "")
                or resp.reason_phrase
            )
        except Exception:
            err_msg = resp.reason_phrase or f"HTTP {resp.status_code}"
        return f"AI API 返回错误 ({resp.status_code}): {err_msg}"

    @staticmethod
    async def _backoff(attempt: int):
        """指数退避等待"""
        import asyncio
        delay = min(2 ** attempt, 8)  # 1s, 2s, 4s, 8s cap
        await asyncio.sleep(delay)


# ── 模块级工具：用量记录 ──

def _record_usage(
    provider_id: str = "",
    model: str = "",
    input_chars: int = 0,
    output_chars: int = 0,
    est_input_tokens: int = 0,
    est_output_tokens: int = 0,
    actual_input_tokens: int = 0,
    actual_output_tokens: int = 0,
):
    """将 API 调用用量写入 SQLite usage_logs 表"""
    try:
        import sqlite3
        from ..database import DB_PATH
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            """INSERT INTO usage_logs
               (provider_id, model, input_chars, output_chars,
                est_input_tokens, est_output_tokens,
                actual_input_tokens, actual_output_tokens)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (provider_id, model, input_chars, output_chars,
             est_input_tokens, est_output_tokens,
             actual_input_tokens, actual_output_tokens),
        )
        conn.commit()
        conn.close()
    except Exception:
        pass  # 记录失败不影响主流程
