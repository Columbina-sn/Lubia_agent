"""动态提示词构建 — 三种模式共用

每次请求可能不同的内容：
- 当前时间（北京时间）
- 可用工具列表（按模式过滤）
- 工作区上下文（文件树快照）
- RAG 预检索结果
"""

from datetime import datetime, timezone, timedelta
from ...tools.registry import build_tools_prompt


def build_dynamic_prompt(
    mode: str = "ask",
    rag_context: str = "",
    workspace_context: str = "",
) -> str:
    """构建动态提示词段

    Args:
        mode: 对话模式 ("ask" | "plan" | "agent" | "auto")
        rag_context: 预 RAG 检索结果文本
        workspace_context: 工作区上下文文本

    Returns:
        完整的动态提示词字符串
    """
    now = datetime.now(timezone.utc) + timedelta(hours=8)
    beijing_time = now.strftime("%Y 年 %m 月 %d 日（周%w）%H:%M")
    beijing_time = (
        beijing_time.replace("周0", "周日").replace("周1", "周一")
        .replace("周2", "周二").replace("周3", "周三")
        .replace("周4", "周四").replace("周5", "周五")
        .replace("周6", "周六")
    )

    parts = [
        "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
        "",
        f"当前时间：{beijing_time}（北京时间）",
        "",
        build_tools_prompt(mode),
    ]

    if workspace_context:
        parts.append(workspace_context)

    if rag_context:
        parts.append(
            f"\n## 知识库预检索\n"
            f"以下信息可能在本次对话中有用，来自知识库的自动匹配：\n"
            f"{rag_context}"
        )

    return "\n".join(parts)
