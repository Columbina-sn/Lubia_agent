"""Ask 模式编排器 — 只读问答"""

from .base import BaseOrchestrator
from ..prompts.ask_static import STATIC_PROMPT


class AskOrchestrator(BaseOrchestrator):
    """Ask 模式：只读问答助手"""

    @property
    def mode(self) -> str:
        return "ask"

    def get_static_prompt(self) -> str:
        return STATIC_PROMPT

    def get_default_max_rounds(self) -> int:
        return 8

    def requires_workspace(self) -> bool:
        return False
