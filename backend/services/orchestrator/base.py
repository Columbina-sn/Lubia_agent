"""编排器基类 — 共享的 ReAct 循环框架

所有模式（ask/plan/auto）共用此基类的循环逻辑。
子类只需提供：提示词、schema、工具过滤、模式特定行为。
"""

import json
import asyncio
import logging
import time
from datetime import datetime, timezone
from abc import ABC, abstractmethod
from typing import Callable, Optional
from ..llm_caller import LLMCaller
from ..tool_executor import ToolExecutor
from ..bubble_policy import BubblePolicy
from ..debug_logger import DebugLogger
from ..output_schema import get_schema, OutputValidator

logger = logging.getLogger("lubia.orchestrator")


class BaseOrchestrator(ABC):
    """编排器基类 — ReAct 循环框架"""

    # ── 子类必须覆盖 ──

    @property
    @abstractmethod
    def mode(self) -> str:
        """模式标识: "ask" | "plan" | "agent" """
        ...

    @abstractmethod
    def get_static_prompt(self) -> str:
        """返回此模式的静态系统提示词"""
        ...

    @abstractmethod
    def get_default_max_rounds(self) -> int:
        """返回默认最大循环轮数"""
        ...

    @abstractmethod
    def requires_workspace(self) -> bool:
        """此模式是否要求工作区"""
        ...

    # ── 子类可选覆盖 ──

    def get_dynamic_prompt(self, rag_context: str = "",
                           workspace_context: str = "") -> str:
        from ..prompts.dynamic import build_dynamic_prompt
        return build_dynamic_prompt(
            mode=self.mode,
            rag_context=rag_context,
            workspace_context=workspace_context,
        )

    def get_config_key(self) -> str:
        if self.mode in ("plan", "agent", "auto"):
            return "max_loop_rounds_plan"
        return "max_loop_rounds"

    def get_config_range(self) -> tuple[int, int]:
        if self.mode in ("plan", "agent", "auto"):
            return (12, 25)
        return (5, 20)

    def on_tool_executed(self, record) -> dict:
        return {}

    def on_before_llm_call(self, messages: list[dict]) -> list[dict]:
        return messages

    def is_silent_retry(self, prev_tool: str, current_tool: str,
                        prev_args: dict, cur_args: dict) -> bool:
        return BubblePolicy.is_silent_retry(prev_tool, current_tool, prev_args, cur_args)

    # ═══════════════════════════════════════════
    # 主循环
    # ═══════════════════════════════════════════

    async def run(
        self,
        messages: list[dict],
        provider_config: dict,
        model: str,
        stream_callback: Callable,
        abort_check: Optional[Callable] = None,
        sandbox_root: str = None,
        session_id: str = None,
    ) -> str:
        t_start = time.time()
        dbg = DebugLogger()
        executor = ToolExecutor(debug_logger=dbg)

        max_rounds = self._read_max_rounds()
        dbg.start_session(
            mode=self.mode, model=model,
            sandbox_root=sandbox_root or "", max_rounds=max_rounds,
        )

        # ── 预 RAG ──
        rag_query = self._build_rag_query(messages)
        rag_context = ""
        if rag_query:
            rag_context = await self._pre_rag(rag_query)

        # ── 工作区上下文 ──
        workspace_context = ""
        if sandbox_root:
            workspace_context = await self._build_workspace_context(sandbox_root)

        # ── 构建消息 ──
        has_system = any(m.get("role") == "system" for m in messages)
        full_messages = []
        if not has_system:
            static = self.get_static_prompt()
            dynamic = self.get_dynamic_prompt(rag_context, workspace_context)
            full_messages.append({"role": "system", "content": static})
            full_messages.append({"role": "system", "content": dynamic})
            dbg.log_system_prompt(static, dynamic)
            logger.debug(
                f"提示词组装 | 模式={self.mode} | 静态={len(static)}字符 | "
                f"动态={len(dynamic)}字符 | 总计={sum(len(m.get('content','')) for m in full_messages)}字符"
            )
        full_messages.extend(messages)
        dbg.log_user_messages(full_messages)

        caller = LLMCaller(provider_config, model)
        schema = get_schema(self.mode)

        # ── 循环状态 ──
        tool_call_count = 0.0   # 浮点：探索工具 0.2/次，网络工具 1.0/次
        consecutive_empty = 0
        last_tool_name = ""
        last_tool_args = {}
        current_op_group = ""
        json_retries_total = 0
        _files_read: dict[str, str] = {}  # path → 摘要，拦截重复读取

        dbg.console(0, max_rounds, "START", f"模式={self.mode} 模型={model} 上限={max_rounds}轮")

        while tool_call_count < max_rounds:
            if abort_check and abort_check():
                dbg.console(0, 0, "STOP")
                await stream_callback({"type": "done"})
                return "（已停止）"

            # ── 排队消息注入 ──
            if session_id:
                injected = self._drain_inject_queue(session_id)
                for msg in injected:
                    full_messages.append({"role": "user", "content": msg["content"]})
                    await stream_callback({"type": "user_injected", "messages": [msg["content"]]})

            # ── 调 LLM + 校验 ──
            await stream_callback({"type": "thinking"})

            parsed, retries = await caller.call_and_validate(
                messages=full_messages, schema=schema,
                max_retries=3, abort_check=abort_check,
            )
            json_retries_total += retries

            # ── 3 次重试全部失败 → 诚实说明问题，让 AI 自己抉择 ──
            if parsed is None:
                logger.debug(f"JSON重试耗尽({retries}次) | 让AI基于现有信息自行决定")
                # 把所有工具结果摘要给 AI，让它知道已经做了什么
                tool_summary = self._summarize_tools_used(full_messages)
                full_messages.append({
                    "role": "system",
                    "content": (
                        f"【重要】前几轮输出存在 JSON 格式问题（如未转义的换行符、多余的引号、"
                        f"JSON 前后夹杂其他文字），系统未能成功解析。\n\n"
                        f"你已经完成了以下工作：\n{tool_summary}\n\n"
                        f"现在请基于你已获取的所有信息，输出 final 回答用户。\n"
                        f"注意：这是 final（纯文本回复），不是 tool_call（调工具）。\n"
                        f'格式：{{"type":"final","content":"你的回答内容"}}\n'
                        f"content 内用 \\n 表示换行，不要写物理换行。\n"
                        f"JSON 从第一个字符 {{ 开始，前面不要有任何文字。"
                    ),
                })
                try:
                    raw = await caller.call(full_messages, abort_check=abort_check)
                    dbg.log_round(tool_call_count + 1, max_rounds, raw, tool_name="(兜底final)", uuid="")
                    parsed_final = OutputValidator._parse_json(raw)
                    if parsed_final and isinstance(parsed_final, dict) and parsed_final.get("type") == "final":
                        ft = parsed_final.get("content", "")
                        if ft.strip():
                            dbg.log_final(ft)
                            dbg.log_summary(tool_call_count, tool_call_count, json_retries_total, time.time() - t_start)
                            await self._stream_text(ft, stream_callback)
                            await stream_callback({"type": "done"})
                            return ft
                except Exception:
                    pass
                ft = "抱歉，我遇到了一些格式问题。请重新描述你的需求，我会再试一次。"
                await self._stream_text(ft, stream_callback)
                await stream_callback({"type": "done"})
                return ft

            # ── 处理批量工具调用（JSON 数组）──
            if isinstance(parsed, list):
                items = parsed
            else:
                items = [parsed]

            # ── 逐个处理响应项 ──
            for item_idx, item in enumerate(items):
                resp_type = item.get("type", "")
                batch_tag = f" [{item_idx+1}/{len(items)}]" if len(items) > 1 else ""

                # ── plan ──
                if resp_type == "plan":
                    dbg.log_round(tool_call_count + 1, max_rounds,
                                 json.dumps(item, ensure_ascii=False), tool_name="plan", uuid="")
                    await stream_callback({
                        "type": "plan",
                        "steps": item.get("steps", []),
                        "options": item.get("options", []),
                        "summary": item.get("summary", ""),
                    })
                    full_messages.append({"role": "assistant", "content": json.dumps(item, ensure_ascii=False)})
                    continue

                # ── final ──
                if resp_type == "final":
                    final_content = item.get("content", "")
                    total_elapsed = time.time() - t_start
                    dbg.log_round(tool_call_count + 1, max_rounds,
                                 json.dumps(item, ensure_ascii=False), tool_name="", uuid="")
                    dbg.console(tool_call_count, max_rounds, "FINAL",
                               f"内容={len(final_content)}字符" + batch_tag)
                    if final_content.strip():
                        dbg.log_final(final_content)
                        dbg.log_summary(tool_call_count, tool_call_count, json_retries_total, total_elapsed)
                        await self._stream_text(final_content, stream_callback)
                        await stream_callback({"type": "done"})
                        return final_content
                    else:
                        full_messages.append({"role": "assistant", "content": json.dumps(item, ensure_ascii=False)[:500]})
                        full_messages.append({"role": "system", "content": '[系统通知] "content" 字段不能为空。'})
                        continue

                # ── tool ──
                if resp_type == "tool":
                    tool_name = item.get("tool", "")
                    params = item.get("parameters", {})

                    dbg.log_round(tool_call_count + 1, max_rounds,
                                 json.dumps(item, ensure_ascii=False),
                                 tool_name=tool_name + batch_tag, uuid="")

                    # 去重 + 加权计数
                    is_dup = self.is_silent_retry(last_tool_name, tool_name, last_tool_args, params)
                    tool_weight = self._get_tool_weight(tool_name)
                    if not is_dup:
                        tool_call_count += tool_weight

                    # 气泡策略
                    bubble_type = BubblePolicy.get_bubble_type(tool_name)
                    should_merge = BubblePolicy.should_merge(last_tool_name, tool_name)
                    if should_merge and current_op_group:
                        op_group = current_op_group
                    else:
                        import uuid as _uuid
                        op_group = f"op_{_uuid.uuid4().hex[:6]}"
                        current_op_group = op_group if should_merge else ""

                    if not is_dup or is_exempt:
                        await stream_callback({
                            "type": "tool_start", "uuid": "",
                            "tool": tool_name, "args": params,
                            "label": self._tool_label(tool_name),
                            "bubble_type": bubble_type,
                            "operation_group": op_group,
                            "is_merge": should_merge and bool(last_tool_name),
                        })

                    # 执行（read_file 先检查缓存，防止重复读取撑爆上下文）
                    if tool_name == "read_file" and params.get("path", "") in _files_read:
                        cached_path = params["path"]
                        cached_summary = _files_read[cached_path]
                        from ..tool_executor import ToolCallRecord
                        record = ToolCallRecord(
                            uuid=f"tool_cached_{cached_path.replace('/', '_')[:20]}",
                            tool_name="read_file", args=params,
                            result=f"[已读取过] {cached_summary}\n▶ 此文件已在前面的轮次中完整读取，"
                                   f"无需重复读取。如需查看特定行范围，用 start_line/end_line 精确指定。",
                            status="ok", start_time=time.time(),
                            hint="文件已读取过。如果只需要特定行的内容，用 start_line/end_line 精确定位。否则直接使用已有信息。",
                        )
                        record.elapsed_ms = 0.5
                        dbg.console(int(tool_call_count), max_rounds, "TOOL",
                                   f"read_file(CACHED) | path={cached_path}"[:50],
                                   "已缓存", 0)
                    else:
                        record = await executor.execute(tool_name=tool_name, params=params,
                                                   sandbox_root=sandbox_root, mode=self.mode)
                        # 缓存成功的文件读取
                        if tool_name == "read_file" and record.status == "ok":
                            p = params.get("path", "")
                            lines_count = record.result.count("\n")
                            _files_read[p] = f"文件 {p}（~{lines_count} 行），已完整读取"

                    arg_str = " ".join(f"{k}={str(v)[:30]}" for k, v in params.items())
                    dbg.console(tool_call_count, max_rounds, "TOOL",
                               f"{tool_name} | {arg_str}"[:50],
                               f"{record.status} | {len(record.result)}字符" if record.status == "ok" else record.error[:40],
                               record.elapsed_ms / 1000)

                    # 存储 AI 调用 + 结果
                    full_messages.append({"role": "assistant", "content": json.dumps(item, ensure_ascii=False)})

                    last_tool_name = tool_name
                    last_tool_args = dict(params)
                    is_empty = record.status in ("empty", "error")
                    consecutive_empty = consecutive_empty + 1 if is_empty else 0

                    # 通知前端
                    if not is_dup or is_exempt:
                        if record.status == "error":
                            await stream_callback({
                                "type": "tool_error", "uuid": record.uuid,
                                "tool": tool_name, "error": record.error,
                            })
                        else:
                            await stream_callback({
                                "type": "tool_result", "uuid": record.uuid,
                                "tool": tool_name, "args": params,
                                "result_preview": record.result[:300] if record.result else "",
                                "status": record.status, "bubble_type": bubble_type,
                                "operation_group": op_group,
                            })

                    # 拼接系统消息：XML 隔离 + 引导 + 提示
                    dup_hint = "\n[提示] 重复调用同一工具，请换方式或基于现有信息回答。" if is_dup else ""
                    stop_hint = ""
                    if consecutive_empty >= 3:
                        stop_hint = "\n[指令] 连续 3 次无有效结果。立即输出 final，不得再调工具。"
                    hint = f"\n▶ {record.hint}" if record.hint else ""

                    # 超长结果截断：文件 ≤15000 字符全量送入，超过则头尾截断 + 引导精确读取
                    result_for_llm = record.result
                    READ_FILE_MAX = 15000
                    if tool_name == "read_file" and len(result_for_llm) > READ_FILE_MAX:
                        lines = result_for_llm.split("\n")
                        total_lines = len(lines)
                        head_n = min(300, total_lines // 2)
                        tail_n = min(150, total_lines // 4)
                        head = "\n".join(lines[:head_n])
                        tail = "\n".join(lines[-tail_n:]) if tail_n > 0 else ""
                        omitted_start = head_n + 1
                        omitted_end = total_lines - tail_n
                        result_for_llm = (
                            f"{head}\n"
                            f"…（文件共 {total_lines} 行，已显示前 {head_n} 行和后 {tail_n} 行，"
                            f"省略第 {omitted_start}–{omitted_end} 行）\n"
                            f"▶ 如需读取中段，调用 read_file(start_line={omitted_start}, end_line={omitted_end})\n"
                            f"{tail}"
                        )
                    elif len(result_for_llm) > READ_FILE_MAX:
                        result_for_llm = result_for_llm[:READ_FILE_MAX] + f"\n…（截断，原 {len(result_for_llm)} 字符）"

                    # 工具类型标签
                    type_tag = {"web_search":"[网络搜索]", "web_fetch":"[网页内容]",
                               "read_file":"[文件内容]", "list_files":"[文件树]",
                               "grep":"[代码搜索]", "knowledge_grep":"[知识库]",
                               "knowledge_rag":"[知识库]", "knowledge_import":"[知识导入]"}.get(tool_name, "[工具]")

                    tool_msg = (
                        f"<tool_result tool=\"{tool_name}\" type=\"{type_tag}\">\n{result_for_llm}\n</tool_result>"
                        f"{hint}{dup_hint}{stop_hint}"
                    )

                    full_messages.append({"role": "system", "content": tool_msg})

                else:
                    # 未知 type
                    full_messages.append({"role": "assistant", "content": json.dumps(item, ensure_ascii=False)[:500]})
                    full_messages.append({
                        "role": "system",
                        "content": f'[通知] 未知 type "{resp_type}"，只允许 tool/final。请重新输出。',
                    })

        # ═══════════════════════════════════════
        # 达到最大轮数 → 强制总结
        # ═══════════════════════════════════════
        dbg.console(tool_call_count, max_rounds, "MAX")
        await stream_callback({"type": "max_rounds", "max": max_rounds})

        full_messages.append({
            "role": "system",
            "content": (
                f"已达到最大工具调用次数 ({max_rounds} 次)。"
                f"基于目前已获得的所有信息，输出 final 回答用户。\n"
                f"任务完成则给最终回答，未完成则诚实说明当前进度。\n"
                f'格式：{{"type":"final","content":"回答内容，换行用\\\\n"}}\n'
                f"JSON 从第一个字符 {{ 开始，前面不要有任何文字。"
            ),
        })
        dbg.log_system_hint(f"强制总结 | 已达上限 {max_rounds} 轮")

        try:
            final_raw = await caller.call(full_messages, abort_check=abort_check)
            dbg.log_round(tool_call_count + 1, max_rounds, final_raw, tool_name="(强制总结)", uuid="")
            parsed_final = OutputValidator._parse_json(final_raw)
            if parsed_final and isinstance(parsed_final, dict) and parsed_final.get("type") == "final":
                final_text = parsed_final.get("content", "")
            elif parsed_final and isinstance(parsed_final, dict) and parsed_final.get("type") == "tool":
                final_text = "抱歉，已达到本轮操作上限。请在设置中调高最大循环轮数后重试。"
            else:
                final_text = final_raw.strip() or "抱歉，请重试。"
        except Exception:
            final_text = "抱歉，请重试。"

        if not final_text.strip():
            final_text = "抱歉，请重试。"

        total_elapsed = time.time() - t_start
        dbg.log_final(final_text)
        dbg.log_summary(tool_call_count, tool_call_count, json_retries_total, total_elapsed)
        await self._stream_text(final_text, stream_callback)
        await stream_callback({"type": "done"})
        return final_text

    # ═══════════════════════════════════════════
    # 辅助
    # ═══════════════════════════════════════════

    async def _stream_text(self, text: str, stream_callback, chunk_size: int = 4):
        for i in range(0, len(text), chunk_size):
            await stream_callback({"type": "delta", "content": text[i:i + chunk_size]})
            await asyncio.sleep(0.02)

    def _read_max_rounds(self) -> int:
        from ...database import get_db
        default = self.get_default_max_rounds()
        lo, hi = self.get_config_range()
        config_key = self.get_config_key()
        try:
            conn = get_db()
            try:
                row = conn.execute("SELECT value FROM user_config WHERE key = ?", (config_key,)).fetchone()
                if row and row["value"]:
                    return max(lo, min(hi, int(row["value"])))
            finally:
                conn.close()
        except Exception:
            pass
        return default

    def _build_rag_query(self, messages: list[dict]) -> str:
        user_msg = ""
        assistant_msg = ""
        for m in reversed(messages):
            if m.get("role") == "user" and not user_msg:
                user_msg = m.get("content", "")
            elif m.get("role") == "assistant" and user_msg and not assistant_msg:
                assistant_msg = m.get("content", "")
                break
        if not user_msg:
            return ""
        if assistant_msg:
            combined = assistant_msg[-200:] + "\n" + user_msg
            return combined[:500]
        return user_msg[:300]

    async def _pre_rag(self, rag_query: str) -> str:
        if not rag_query or len(rag_query) < 3:
            return ""
        try:
            from ...tools.safe.knowledge_rag import knowledge_rag
            result = await knowledge_rag(query=rag_query, limit=3, threshold=0.55)
            if result and "没有找到" not in result and "也未找到" not in result:
                return f"根据用户当前问题预检索知识库，找到以下可能相关信息：\n{result}"
        except Exception:
            pass
        return ""

    def _summarize_tools_used(self, messages: list[dict]) -> str:
        """提取已使用的工具摘要，用于格式失败后的兜底提示"""
        tools_seen = []
        for m in messages:
            if m.get("role") == "system" and "<tool_result" in m.get("content", ""):
                # 提取工具名
                import re
                match = re.search(r'tool="(\w+)"', m.get("content", ""))
                if match:
                    tools_seen.append(match.group(1))
        if not tools_seen:
            return "（尚未成功调用任何工具）"
        return f"已调用工具: {', '.join(tools_seen)}（共 {len(tools_seen)} 次）"

    async def _build_workspace_context(self, sandbox_root: str) -> str:
        import os as _os
        if not sandbox_root:
            return ""
        root_name = _os.path.basename(sandbox_root.rstrip("/\\")) or sandbox_root
        MAX_ITEMS = 40; MAX_TOTAL = 120; tree_items = 0

        def _walk(d, prefix="", depth=0, max_depth=3):
            nonlocal tree_items
            if depth >= max_depth or tree_items >= MAX_TOTAL:
                return []
            try:
                entries = sorted(_os.scandir(d), key=lambda e: (not e.is_dir(), e.name.lower()))
            except Exception:
                return []
            lines = []; shown = 0
            for e in entries:
                if tree_items >= MAX_TOTAL: break
                if shown >= MAX_ITEMS:
                    lines.append(f"{prefix}  …（还有更多，用 list_files 深入查看）"); break
                if e.name.startswith(".") or e.name.startswith("__pycache__"): continue
                tree_items += 1; shown += 1
                if e.is_dir():
                    lines.append(f"{prefix}  {e.name}/")
                    lines.extend(_walk(e.path, prefix + "    ", depth + 1, max_depth))
                else:
                    lines.append(f"{prefix}  {e.name}")
            return lines

        tree = _walk(sandbox_root)
        if tree_items >= MAX_TOTAL:
            tree.append("…（文件树过大已截断）")
        lines = [f"## 当前工作区\n根目录: {sandbox_root}\n"]
        if tree:
            lines.append("文件树快照（最多 3 层）：")
            lines.extend(tree)
        else:
            lines.append("（空目录）")
        lines.append("\n阅读策略：先看树 → 逐层 list_files → read_file 读入口 → grep 定位代码。")
        return "\n".join(lines)

    def _drain_inject_queue(self, session_id: str) -> list[dict]:
        try:
            from ...routers.chat import _INJECT_QUEUES
            queue = _INJECT_QUEUES.get(session_id, [])
            if not queue: return []
            drained = []
            while queue: drained.append(queue.pop(0))
            return drained
        except Exception:
            return []

    def _get_tool_weight(self, tool_name: str) -> float:
        """从 registry 读取工具权重"""
        from ...tools.registry import _TOOLS as all_tools
        for t in all_tools:
            if t["name"] == tool_name:
                return float(t.get("weight", 1.0))
        return 1.0

    def _tool_label(self, tool_name: str) -> str:
        from ...tools.registry import TOOL_LABELS
        return TOOL_LABELS.get(tool_name, tool_name)
