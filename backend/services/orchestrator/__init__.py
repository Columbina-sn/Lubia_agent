"""编排器模块 — 三种对话模式的独立编排器

用法:
    from .base import BaseOrchestrator
    from .ask import AskOrchestrator
    from .plan import PlanOrchestrator
    from .auto import AutoOrchestrator

    def get_orchestrator(mode: str) -> BaseOrchestrator:
        return {"ask": AskOrchestrator, "plan": PlanOrchestrator,
                "agent": AutoOrchestrator, "auto": AutoOrchestrator}[mode]()
"""
