"""提示词模块 — 静态/动态分离

每种模式有独立的静态提示词，共享动态提示词构建逻辑。

用法:
    from .dynamic import build_dynamic_prompt
    from .ask_static import STATIC_PROMPT as ASK_PROMPT
    from .plan_static import STATIC_PROMPT as PLAN_PROMPT
    from .auto_static import STATIC_PROMPT as AUTO_PROMPT

    prompts = {
        "ask": ASK_PROMPT,
        "plan": PLAN_PROMPT,
        "agent": AUTO_PROMPT,
        "auto": AUTO_PROMPT,
    }.get(mode, ASK_PROMPT)
"""
