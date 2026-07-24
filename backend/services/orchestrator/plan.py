"""Plan 模式编排器 — 先规划后执行"""

from .base import BaseOrchestrator
from ..prompts.plan_static import STATIC_PROMPT


class PlanOrchestrator(BaseOrchestrator):
    """Plan 模式：先出方案 → 用户确认 → 逐步执行"""

    @property
    def mode(self) -> str:
        return "plan"

    def get_static_prompt(self) -> str:
        return STATIC_PROMPT

    def get_default_max_rounds(self) -> int:
        return 15

    def requires_workspace(self) -> bool:
        return True
