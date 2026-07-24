"""统一工具执行层 — UUID 追踪 + 参数校验 + 类型转换 + 超时控制 + 引导包装

替代 react_loop.py 中散落的 _execute_tool() 逻辑。
每次工具调用生成唯一 UUID，通过 ToolCallRecord 追踪全生命周期。

用法：
    from .tool_executor import ToolExecutor
    executor = ToolExecutor(debug_logger)
    record = await executor.execute("read_file", {"path": "src/app.js"}, sandbox_root="/workspace")
    # record.uuid, record.result, record.error, record.elapsed_ms, ...
"""

import asyncio
import time
import uuid
import logging
from dataclasses import dataclass, field
from typing import Optional
from ..tools.registry import TOOL_MAP, TOOL_META, _TOOLS as _ALL_TOOLS

logger = logging.getLogger("lubia.tool_executor")


@dataclass
class ToolCallRecord:
    """单次工具调用的完整记录"""
    uuid: str
    tool_name: str
    args: dict
    result: str = ""
    error: str = ""
    status: str = "running"  # "running" | "ok" | "partial" | "empty" | "error"
    start_time: float = 0.0
    elapsed_ms: float = 0.0
    hint: str = ""  # 引导文本（给 AI 的下步指示）
    bubble_type: str | None = None  # 气泡类型


class ToolExecutor:
    """统一工具执行器"""

    def __init__(self, debug_logger=None):
        """
        Args:
            debug_logger: DebugLogger 实例（可选，用于记录工具结果到 prompt.md）
        """
        self._debug = debug_logger
        self._last_call: Optional[ToolCallRecord] = None
        self._call_history: list[ToolCallRecord] = []

    # ═══════════════════════════════════════════
    # 主入口
    # ═══════════════════════════════════════════

    async def execute(
        self,
        tool_name: str,
        params: dict,
        sandbox_root: str = None,
        mode: str = "ask",
    ) -> ToolCallRecord:
        """执行工具并返回完整记录

        Args:
            tool_name: 工具名
            params: AI 传来的参数（可能类型不对）
            sandbox_root: 工作区根目录
            mode: 对话模式（用于模式感知的工具过滤）

        Returns:
            ToolCallRecord（含 uuid, result, error, hint）
        """
        call_id = f"tool_{uuid.uuid4().hex[:8]}"
        record = ToolCallRecord(
            uuid=call_id,
            tool_name=tool_name,
            args=dict(params or {}),
            start_time=time.time(),
        )

        # ① 查找工具函数
        func = TOOL_MAP.get(tool_name)
        if not func:
            record.status = "error"
            record.error = f"未知工具: {tool_name}"
            record.elapsed_ms = (time.time() - record.start_time) * 1000
            record.hint = f"可用工具: {', '.join(TOOL_MAP.keys())}。请换一个可用的工具。"
            self._record(record)
            return record

        # ② 参数校验 + 类型转换
        kwargs = self._prepare_params(tool_name, params, sandbox_root)
        missing = self._check_required(tool_name, kwargs)
        if missing:
            record.status = "error"
            record.error = f"缺少必填参数: {', '.join(missing)}"
            record.elapsed_ms = (time.time() - record.start_time) * 1000
            record.hint = f"请在 parameters 中补充: {', '.join(missing)}。"
            self._record(record)
            return record

        # ③ 获取超时设置
        timeout = self._get_timeout(tool_name)

        # ④ 执行工具（带超时保护）
        try:
            result_raw = await asyncio.wait_for(func(**kwargs), timeout=timeout)
            record.result = result_raw or "(工具返回空结果)"
        except asyncio.TimeoutError:
            record.status = "error"
            record.error = f"工具执行超时（>{timeout}秒）"
            record.elapsed_ms = (time.time() - record.start_time) * 1000
            record.hint = (
                f"工具 {tool_name} 执行超时（>{timeout}秒）。不要重试同一个调用——"
                f"换一个工具或换一组参数，或者告诉用户操作超时。"
            )
            self._record(record)
            return record
        except Exception as e:
            record.status = "error"
            record.error = f"工具执行出错: {str(e)}"
            record.elapsed_ms = (time.time() - record.start_time) * 1000
            record.hint = (
                f"工具 {tool_name} 执行失败。不要用相同参数重试——检查参数类型是否正确，"
                f"或换一个工具。错误详情: {str(e)[:200]}"
            )
            self._record(record)
            return record

        # ④ 判断结果状态
        record.status = self._classify_result(tool_name, record.result)
        record.elapsed_ms = (time.time() - record.start_time) * 1000

        # ⑤ 生成引导（Phase 2 将在此扩展为每个工具的专属引导）
        record.hint = self._generate_hint(tool_name, record.status, record.result, kwargs)

        self._record(record)
        return record

    # ═══════════════════════════════════════════
    # 参数处理
    # ═══════════════════════════════════════════

    def _get_weight(self, tool_name: str) -> float:
        """从 registry 读取工具权重（占多少轮循环）"""
        for t in _ALL_TOOLS:
            if t["name"] == tool_name:
                return float(t.get("weight", 1.0))
        return 1.0  # 兜底：未知工具占完整一轮

    def _get_timeout(self, tool_name: str) -> float:
        """从 registry 读取工具超时设置"""
        for t in _ALL_TOOLS:
            if t["name"] == tool_name:
                return float(t.get("timeout", 30))
        return 30  # 兜底 30 秒

    def _prepare_params(self, tool_name: str, params: dict,
                        sandbox_root: str = None) -> dict:
        """参数校验 + 类型转换 + 特殊处理

        根据 registry 中定义的 schema 自动转换类型。
        """
        if not isinstance(params, dict):
            params = {}

        # 获取 schema 定义
        schema_props = {}
        required = []
        for t in _ALL_TOOLS:
            if t["name"] == tool_name:
                schema_props = t.get("schema", {}).get("properties", {})
                required = t.get("schema", {}).get("required", [])
                break

        kwargs = {}
        for key, prop in schema_props.items():
            raw = params.get(key)
            if raw is None:
                continue

            # 按 schema 类型转换
            if prop.get("type") == "integer":
                try:
                    kwargs[key] = int(raw)
                except (ValueError, TypeError):
                    if isinstance(raw, str) and raw.strip() == "":
                        continue  # 空字符串 → 让函数用默认值
                    kwargs[key] = 0
            else:
                kwargs[key] = str(raw).strip() if raw else ""

        # ── 特殊处理 ──
        # web_fetch: 自动补全 http 前缀
        if tool_name == "web_fetch" and "url" in kwargs:
            url = kwargs["url"]
            if url and not url.startswith("http"):
                kwargs["url"] = "https://" + url

        # 工作区工具: 注入 sandbox_root
        if tool_name in ("list_files", "read_file", "grep"):
            kwargs["sandbox_root"] = sandbox_root

        return kwargs

    def _check_required(self, tool_name: str, kwargs: dict) -> list[str]:
        """检查必填参数是否齐全"""
        for t in _ALL_TOOLS:
            if t["name"] == tool_name:
                required = t.get("schema", {}).get("required", [])
                return [k for k in required if not kwargs.get(k)]
        return []

    # ═══════════════════════════════════════════
    # 结果分类
    # ═══════════════════════════════════════════

    def _classify_result(self, tool_name: str, result: str) -> str:
        """判断工具结果的状态"""
        # 部分成功信号（截断但有效）
        partial_signals = ["已截断", "省略中间", "结果过多已截断"]

        # 空结果信号
        empty_signals = [
            "没有找到相关信息", "未找到与", "没有找到与",
            "网页内容为空", "无法解析",
            "搜索服务暂时不可用",
            "0 条匹配", "0 条结果",
        ]

        # 错误信号
        error_signals = [
            "路径包含不安全字符", "路径越界", "文件不存在",
            "没有权限", "无法访问", "不确定的操作",
        ]

        for sig in error_signals:
            if sig in result:
                return "error"

        for sig in empty_signals:
            if sig in result:
                return "empty"

        for sig in partial_signals:
            if sig in result:
                return "partial"

        return "ok"

    # ═══════════════════════════════════════════
    # 引导生成（Phase 2 将扩展为完整引导系统）
    # ═══════════════════════════════════════════

    def _generate_hint(self, tool_name: str, status: str, result: str,
                       args: dict) -> str:
        """根据工具和状态生成给 AI 的下一步引导

        Phase 2 将扩展为每个工具的详细引导（含具体参数建议）。
        当前提供基础框架引导。
        """
        if status == "error":
            return (
                f"工具 {tool_name} 执行出错。检查参数是否正确，"
                f"修正后重试一次。如果仍然出错，换一种工具或思路。"
            )

        if status == "empty":
            hints = {
                "web_search": "搜索结果为空。换一组关键词重试一次（换完全不同的表述方式）。仍空则告诉用户未找到。",
                "web_fetch": "网页抓取失败或内容为空。换搜索结果中的下一个 URL 重试。所有 URL 都失败则告诉用户。",
                "knowledge_grep": "知识库关键词搜索无结果。试 knowledge_rag 做语义搜索。仍无结果则告知用户知识库中暂无相关信息。",
                "knowledge_rag": "知识库语义搜索无结果。换个完全不同的表述方式重试一次。仍无结果则告知用户。",
                "grep": "搜索无结果。换更短或更通用的关键词重试。仍无结果则告知用户。",
            }
            return hints.get(tool_name, "无结果。换参数重试一次，仍空则换工具或告知用户。")

        if status == "partial":
            hints = {
                "read_file": (
                    "文件已截断。如果中间部分可能包含你需要的信息，"
                    "用 start_line/end_line 精确读取中段。"
                    "如果头尾已足够，可以直接使用。"
                ),
            }
            return hints.get(tool_name, "结果已截断。如果关键信息不完整，缩小范围重试。")

        # status == "ok" → 成功引导
        hints = {
            "web_search": (
                "搜索完成。你接下来必须：从结果中选出 1~2 个最相关的 URL，"
                "调用 web_fetch 抓取完整内容。摘要不足以为回答提供依据——只有读完网页正文才能真正回答用户。"
            ),
            "web_fetch": (
                "网页内容已抓取。信息应足够回答用户问题了。"
                "如需交叉验证，可再抓取另一个 URL。否则现在就可以给出最终回答。"
            ),
            "list_files": (
                "文件树已列出。接下来：如果已看到目标文件 → 调用 read_file 读取；"
                "如果还需深入子目录 → 继续 list_files 逐层展开；"
                "如果清楚要找的文件名或关键词 → 用 grep 更快。"
                "不要凭文件名猜测内容——必须 read_file 验证后才能在回答中引用。"
            ),
            "read_file": (
                "文件已完整读取。信息应足够。如果还需要看其他相关文件，继续 read_file。"
                "如果信息已够回答用户，直接输出 final。"
            ),
            "grep": (
                "代码搜索完成。已找到相关代码位置。接下来调用 read_file 查看具体实现。"
                "如果搜索结果太多（>50条），加 path_filter 缩小范围。"
            ),
            "knowledge_grep": (
                "知识库关键词搜索完成。如果找到相关信息，在回答中引用。"
                "如果信息不够，可试 knowledge_rag 做语义搜索补充。"
            ),
            "knowledge_rag": (
                "知识库语义搜索完成。如果找到相关信息，在回答中引用并说明来源为知识库。"
            ),
            "knowledge_import": "知识导入完成。继续你的对话，不需要额外解释。",
        }
        return hints.get(tool_name, "操作完成。根据结果决定下一步：继续调工具还是输出 final。")

    # ═══════════════════════════════════════════
    # 内部
    # ═══════════════════════════════════════════

    def _record(self, record: ToolCallRecord):
        """记录调用历史 + 写入 debug 日志"""
        self._last_call = record
        self._call_history.append(record)

        if self._debug:
            # 工具成功 → 写入 prompt.md
            if record.status in ("ok", "partial", "empty") and record.result:
                self._debug.log_tool_result(
                    tool_name=record.tool_name,
                    result=record.result,
                    uuid=record.uuid,
                    elapsed_ms=record.elapsed_ms,
                )
            elif record.status == "error":
                self._debug.log_error(
                    error=record.error,
                    tool_name=record.tool_name,
                )

            # 控制台日志
            detail = f"{record.tool_name}"
            if record.args:
                arg_str = " ".join(f"{k}={str(v)[:40]}" for k, v in record.args.items())
                detail += f" | {arg_str}"
            result_summary = record.status
            if record.status == "ok":
                result_len = len(record.result)
                if result_len > 1000:
                    result_summary = f"{result_len}字符"
                else:
                    result_summary = record.result[:60].replace("\n", " ")
            elif record.status == "error":
                result_summary = record.error[:60]
            elif record.status == "empty":
                result_summary = "空结果"

            self._debug.console(
                round_num=0,  # 由上层传，这里占位
                max_rounds=0,
                action="TOOL",
                detail=detail[:50],
                result=result_summary[:40],
                elapsed_s=record.elapsed_ms / 1000,
            )

    @property
    def last_call(self) -> Optional[ToolCallRecord]:
        return self._last_call

    @property
    def call_count(self) -> int:
        return len(self._call_history)
