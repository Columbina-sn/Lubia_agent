"""Debug 日志层 — 运行日志 + prompt.md 全量上下文记录

职责：
1. 控制台运行日志：每轮循环一行 ≤120 字符，一眼看清 AI 在干什么
2. prompt.md：全量结构化 Markdown 日志（工具结果不截断！），末尾统计

时间全部使用北京时间（UTC+8），避免开发者混淆。
"""

import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger("lubia.debug")

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
PROMPT_LOG_PATH = _PROJECT_ROOT / "prompt.md"

# 分隔符：用全角字符避免被 markdown 解析器误认为 <hr> 或 ~~strikethrough~~
_SEP = "————————————————————————————"


def _bj_now() -> datetime:
    """返回当前北京时间"""
    return datetime.now(timezone.utc) + timedelta(hours=8)


def _bj_ts() -> str:
    """返回北京时间戳字符串 HH:MM:SS"""
    return _bj_now().strftime('%H:%M:%S')


class DebugLogger:
    """统一调试日志：控制台一行概览 + prompt.md 全量详情"""

    def __init__(self):
        self._session_start: Optional[datetime] = None
        self._total_tool_calls = 0
        self._total_json_retries = 0
        self._first_round_time: Optional[datetime] = None

    # ═══════════════════════════════════════════
    # 会话生命周期
    # ═══════════════════════════════════════════

    def start_session(self, mode: str, model: str, sandbox_root: str = "",
                      max_rounds: int = 8):
        """会话开始 → 清空 prompt.md + 写入头部信息"""
        self._session_start = _bj_now()
        self._total_tool_calls = 0
        self._total_json_retries = 0
        self._first_round_time = None

        ts = self._session_start.strftime('%Y-%m-%d %H:%M:%S')
        header = (
            f"# Lubia 对话日志 — {ts}（北京时间）\n\n"
            f"## 会话信息\n"
            f"- 模式: {mode}\n"
            f"- 模型: {model}\n"
            f"- 工作区: {sandbox_root or '未设置'}\n"
            f"- 循环上限: {max_rounds}\n"
            f"- 启动时间: {ts}\n"
            f"\n{_SEP}\n\n"
        )
        try:
            PROMPT_LOG_PATH.write_text(header, encoding="utf-8")
        except Exception:
            pass

        logger.info(f"会话开始 | 模式={mode} | 模型={model} | 工作区={sandbox_root or '无'} | 上限={max_rounds}轮")

    # ═══════════════════════════════════════════
    # 控制台一行日志
    # ═══════════════════════════════════════════

    def console(self, round_num: int, max_rounds: int, action: str,
                detail: str = "", result: str = "", elapsed_s: float = 0):
        """控制台运行日志：一行 ≤120 字符

        action: "TOOL" | "FINAL" | "RETRY" | "MAX" | "STOP" | "JSON_ERR"
        """
        if not self._first_round_time and action == "TOOL":
            self._first_round_time = _bj_now()

        prefix = f"[{round_num}/{max_rounds}]"
        elapsed = f"{elapsed_s:.1f}s" if elapsed_s else "-"

        if action == "TOOL":
            line = f"{prefix} TOOL {detail} | {result} | {elapsed}"
        elif action == "FINAL":
            total = ""
            if self._first_round_time:
                total_s = (_bj_now() - self._first_round_time).total_seconds()
                total = f" | 总耗时={total_s:.1f}s"
            line = f"{prefix} FINAL | {detail}{total}"
        elif action == "RETRY":
            line = f"{prefix} RETRY {detail} | {result} | {elapsed}"
        elif action == "MAX":
            line = f"[MAX] 达到循环上限→强制总结 | 已用={round_num}/{max_rounds}"
        elif action == "STOP":
            line = "[STOP] 用户中止"
        elif action == "JSON_ERR":
            line = f"[FMT] JSON格式错误({detail}) | {result}"
        else:
            line = f"{prefix} {action} | {detail} | {result}"

        # 强制截断到 120 字符
        if len(line) > 120:
            line = line[:117] + "…"

        logger.info(line)

    # ═══════════════════════════════════════════
    # prompt.md 全量写入
    # ═══════════════════════════════════════════

    def log_system_prompt(self, static_prompt: str, dynamic_prompt: str):
        """写入系统提示词（对话开始时调用一次）"""
        self._append(
            f"## [System] 静态提示词\n\n{static_prompt}\n\n{_SEP}\n\n"
            f"## [System] 动态提示词\n\n{dynamic_prompt}\n\n{_SEP}\n\n"
        )

    def log_user_messages(self, messages: list[dict]):
        """批量写入对话历史中的用户消息"""
        user_msgs = [m for m in messages if m.get("role") == "user"]
        for i, m in enumerate(user_msgs, 1):
            self._append(f"## [User] #{i}\n\n{m.get('content', '')}\n\n{_SEP}\n\n")

    def log_round(self, round_num: int, max_rounds: int, ai_raw: str,
                  tool_name: str = "", uuid: str = ""):
        """写入一轮 AI 原始输出"""
        ts = _bj_ts()
        tag = f"tool_call: {tool_name}" if tool_name else "final"
        uid = f" | uuid={uuid}" if uuid else ""
        self._append(
            f"## Round {round_num}/{max_rounds} | {tag} | {ts}{uid}\n\n"
            f"### AI 原始输出\n\n```json\n{ai_raw}\n```\n\n"
        )

    def log_tool_result(self, tool_name: str, result: str, uuid: str = "",
                        elapsed_ms: float = 0):
        """写入工具结果 —— 全量，不截断！"""
        self._total_tool_calls += 1
        elapsed_s = elapsed_ms / 1000 if elapsed_ms else 0
        uid = f" | uuid={uuid}" if uuid else ""
        elapsed_str = f" | 耗时={elapsed_s:.1f}s" if elapsed_s else ""
        self._append(
            f"### 工具结果 ({tool_name}){elapsed_str}{uid}\n\n{result}\n\n{_SEP}\n\n"
        )

    def log_final(self, content: str):
        """写入最终回复"""
        self._append(
            f"## 最终回复 | {len(content)} 字符\n\n{content}\n\n{_SEP}\n\n"
        )

    def log_system_hint(self, hint: str):
        """写入系统提示（如格式纠正、强制总结提示等）"""
        self._append(f"### 系统注入\n\n{hint}\n\n")

    def log_summary(self, total_rounds: int, tool_calls: int = 0,
                    json_retries: int = 0, total_elapsed: float = 0):
        """写入末尾统计"""
        tool_calls = tool_calls or self._total_tool_calls
        json_retries = json_retries or self._total_json_retries
        self._append(
            f"## 统计\n\n"
            f"- 总轮数: {round(total_rounds, 1)}\n"
            f"- 工具调用: {round(tool_calls, 1)} 次\n"
            f"- JSON 格式重试: {json_retries} 次\n"
            f"- 总耗时: {total_elapsed:.1f}s\n"
        )

    def log_error(self, error: str, tool_name: str = "system"):
        """写入错误"""
        self._append(f"### 错误 ({tool_name})\n\n{error}\n\n{_SEP}\n\n")

    # ═══════════════════════════════════════════
    # 内部
    # ═══════════════════════════════════════════

    def _append(self, text: str):
        """追加内容到 prompt.md"""
        try:
            with open(PROMPT_LOG_PATH, "a", encoding="utf-8") as f:
                f.write(text)
        except Exception:
            pass  # 写入失败不阻塞主流程


def append_chat_log(message: str):
    """前端 debug 日志追加到 prompt.md（一行一条，带时间戳）"""
    try:
        ts = _bj_ts()
        with open(PROMPT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {message}\n")
    except Exception:
        pass
