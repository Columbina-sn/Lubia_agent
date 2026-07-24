"""Auto 模式编排器 — 全自动执行"""

from .base import BaseOrchestrator
from ..prompts.auto_static import STATIC_PROMPT


class AutoOrchestrator(BaseOrchestrator):
    """Auto 模式：隐式规划 → 全自动执行 → 危险操作确认"""

    @property
    def mode(self) -> str:
        return "agent"  # 后端内部用 "agent" 兼容旧代码

    def get_static_prompt(self) -> str:
        return STATIC_PROMPT

    def get_default_max_rounds(self) -> int:
        return 15

    def requires_workspace(self) -> bool:
        return True
