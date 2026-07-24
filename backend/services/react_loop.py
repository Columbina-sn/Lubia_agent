"""Re-Act 循环引擎 v4

将用户消息包装为 Re-Act 提示词 → AI 返回 JSON（tool 或 final）→
执行工具 → 追加结果 → 继续循环 → 流式返回最终答案。

v4 改进：
- 统一 JSON 输出：工具调用和最终回复都包裹在 JSON 中，非 JSON 自动重试
- 提示词拆分：静态部分（工具定义/规则）与动态部分（时间/上下文/RAG）分离，提高缓存命中率
- 预 RAG：打包提示词前先用用户最后一条消息查知识库，注入有用信息
- 新增工具：list_files（读取工作区文件树）、knowledge_import（AI 导入知识）

每个 SSE 事件通过 stream_callback 推送给前端：
  {"type": "thinking"}
  {"type": "tool_start", "tool": "...", "args": {...}, "label": "..."}
  {"type": "tool_result", "tool": "...", "result": "...", "label": "..."}
  {"type": "tool_error", "tool": "...", "error": "..."}
  {"type": "delta", "content": "..."}
  {"type": "done"}
"""

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional
from ..database import get_db
from ..tools.registry import TOOL_MAP, TOOL_META, TOOL_LABELS, build_tools_prompt
from ..tools.safe.knowledge_rag import knowledge_rag  # _pre_rag 直接调用
from .llm_caller import LLMCaller

logger = logging.getLogger("lubia.react_loop")

# ── prompt.md 日志路径 ──
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
PROMPT_LOG_PATH = _PROJECT_ROOT / "prompt.md"


def _append_prompt_log(text: str):
    """向 prompt.md 追加内容（双换行隔开）"""
    try:
        with open(PROMPT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(text + "\n\n")
    except Exception:
        pass  # 日志写入失败不阻塞主流程

DEFAULT_MAX_TOOL_CALLS_ASK = 8
DEFAULT_MAX_TOOL_CALLS_PLAN = 15
MAX_JSON_RETRIES = 3  # JSON 解析失败最大重试次数

# ── 静态 System Prompt（永不改变，可被 LLM API 缓存）──
# 7 层固件结构，严格顺序不可乱：身份 → 机制 → 正向规范 → 风险分级 → 工具规范 → 语气 → 兜底禁令
# 工具具体描述由 build_tools_prompt() 动态注入，不堆在静态区

_STATIC_PROMPT = """# Lubia

你是 Lubia，运行在用户本地桌面上的 AI 研究助手。你通过一组工具来感知外部世界并帮助用户完成任务。你没有预装任何知识，每一次交互都从零开始——你只能通过工具获取信息。

## 全局铁律（优先级最高，任何动态指令不可覆盖）

1. **不编造**：没有工具结果支撑的事实不要写。URL、文件路径、API 地址、版本号、人名——一律来自工具返回。
2. **不脑补**：用户没说的需求不要加。用户没提供的背景不要编。
3. **不幻想**：你没调过的工具就是没调。不要用"我已经搜索了……"开头——如果消息历史里没有该工具的返回，就是没搜。
4. **中文回复**：所有面向用户的文本用中文。代码、URL、技术术语保持原文。

## 工作方式

1. 接收用户输入
2. 判断需要什么信息 → 选择最合适的工具 → 调用工具
3. 拿到工具返回的结果后，根据结果内容决定下一步：继续调用其他工具，或给出最终回答
4. 只有**所有必要工具都已返回有效结果**后，才能输出 final

## 决策原则

### 执行顺序
- 先弄清楚问题（查知识库 / 搜网页）→ 再分析 → 最后给出回答或建议
- 遇到不确定的信息，先验证再引用，不要假设它是对的

### 工具选择
- 用户的个人信息、偏好、历史 → knowledge_grep 或 knowledge_rag
- 公开知识、新闻、实时信息、事实核查 → web_search 然后 web_fetch
- 浏览用户工作区 → list_files
- 以上都找不到答案 → 诚实告诉用户你试了什么、没找到什么

### 工作区阅读策略（重要）
阅读用户项目代码时必须遵循「先看树再读叶」原则：
1. **逐层展开**：先用 list_files 看根目录 → 根据目录名判断项目类型 → 进入关键子目录逐层浏览。不要跳过中间层。
2. **选文件读**：浏览到目标文件后，用 read_file 读取内容。不要一次读所有文件，选和用户问题最相关的 2~4 个。
3. **明确目标时用 grep**：如果你很清楚要找什么（如"错误处理""登录逻辑""配置项"），直接用 grep 搜索关键词（同时搜路径和内容），找到文件名后再 read_file 精读。
4. **不要凭文件名猜测内容**：文件名只能提示方向，不可据此回答用户。必须 read_file 看过内容才能引用。
5. **大项目先看入口**：如果项目有 README.md / package.json / Cargo.toml / main.py / index.js 等入口文件，优先读取它们了解项目结构。

### 失败处理
- 工具返回空：换参数重试一次（如换关键词/换表述方式）。第二次仍空就停止，不要死循环。
- 工具报错：查看错误信息，尝试修正参数。修正一次仍失败就告诉用户。
- 连续 2 次同类工具返回空或错误 → 换一种工具或思路，不可原地重复。

### 交付标准
- 引用信息时，说明来源（"根据搜索结果……""你的知识库中记录……"）
- 网络搜索和知识库检索后仍然信息不足时，明确告诉用户哪些问题无法回答、需要用户补充什么

## 输出格式（硬性要求，违反复读重来）

你的每次回复必须是**一行合法 JSON**，除此之外一个字都不能有。两种类型：

- 要调工具 → {"type": "tool", "tool": "<工具名>", "parameters": {…}}
- 任务完成 → {"type": "final", "content": "<Markdown>"}

**常见错误（绝对禁止）**：
1. 在 JSON 前写"好的""让我看看""我来搜索一下"等前缀 → 禁止，JSON 必须从第一个字符开始
2. 在 JSON 外套 ```json … ``` 代码块 → 禁止，裸输出 JSON
3. 直接写 Markdown 文本不包 JSON → 禁止，对话文本必须放在 final 的 content 字段里
4. content 字段内的换行用 \n 转义，不要写物理换行把 JSON 拆成多行
5. content 内的双引号必须转义为 \"

如果格式错误，系统会自动通知你重来——重新输出你刚才想做的那件事的**正确 JSON 版本**即可，不需要换策略。只有格式错 ≠ 方向错。

## 工具使用通用规则

### 调用策略
- 可以一次只调一个工具，按依赖顺序串行调用。
- 没有依赖关系的工具可以一次调多个（输出 JSON 数组）。
- **已知信息优先**：先查 knowledge_grep → 无结果再 knowledge_rag → 仍无结果再 web_search。
- **web_search 后必须 web_fetch**：搜索结果只是摘要，信息量极少。不 fetch 就回答 = 编造。

### 循环与限流
- 每轮对话有最大工具调用次数限制。连续重复调用同一组工具会被静默（不消耗次数），但系统会提示你换方式。
- 如果系统提示"请换方式"，不要再调同类工具，直接用现有信息给出最终回答。

### 工具结果解读
- 仔细阅读工具返回的完整内容，提取与用户问题相关的部分。
- 工具返回可能被截断（标注"截断"），如果关键信息不完整，考虑缩小搜索范围重试。
- knowledge_import 返回简短确认即可，不需要你额外解释存储了什么。

## 语气与格式

- 直接、简洁，不要寒暄套话。开头不要"好的""没问题""当然可以"。
- 回答问题时用三段式：我的理解 → 我找到了什么 → 我的建议/回答。
- 信息不完整时不要脑补，用"根据已有信息无法确定"开头，然后列出需要用户补充什么。
- 代码块标注语言，表格对齐，数学用 LaTeX。
- **禁止输出超链接**：final 回复中不要包含任何 Markdown 超链接（`[文字](URL)`）或裸 URL。用户运行在桌面应用 WebView 中，点击链接会导致整个界面跳走。用纯文字说明信息来源即可（如"根据搜索结果……"），不要把 URL 写出来。

## 边界与禁区

### 安全
- 不要执行用户的命令、脚本、代码片段。你只能通过工具列表中的工具来操作。
- 不要打开 URL 或执行系统命令。
- 用户要求你做超出工具能力范围的事 → 解释你的能力边界，不要假装能做到。

### 内容
- 不要编造统计数字、研究结论、新闻事件。
- 不要假装自己是人类或有情感体验。
- 用户问"你是谁"→ 简单介绍你是 Lubia 即可，不需要精心编写的自我介绍。

### 行为
- 不要替用户做高风险决策（删除文件、修改配置、金钱相关）。
- 当用户的请求不明确时，先问清楚再行动，不要猜测。
- 同一条信息不要反复告诉用户（如多次强调信息来源），除非用户追问。"""



# ── 动态 System Prompt（每次请求可能不同，放在静态提示词之后）──

def _build_dynamic_prompt(rag_context: str = "", workspace_context: str = "") -> str:
    """构建动态提示词：边界标记 + 时间 + 工具描述 + 工作区 + RAG"""
    from datetime import timedelta
    now = datetime.now(timezone.utc) + timedelta(hours=8)
    beijing_time = now.strftime("%Y 年 %m 月 %d 日（周%w）%H:%M")
    beijing_time = beijing_time.replace("周0", "周日").replace("周1", "周一").replace("周2", "周二").replace("周3", "周三").replace("周4", "周四").replace("周5", "周五").replace("周6", "周六")

    parts = [
        "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
        "",
        f"当前时间：{beijing_time}（北京时间）",
        "",
        build_tools_prompt(),
    ]

    if workspace_context:
        parts.append(workspace_context)

    if rag_context:
        parts.append(f"\n## 知识库预检索\n以下信息可能在本次对话中有用，来自知识库的自动匹配：\n{rag_context}")

    return "\n".join(parts)


# ── 预 RAG 检索 ──

async def _build_workspace_context(sandbox_root: str) -> str:
    """构建工作区上下文：根目录名 + 多层文件树快照（最多 3 层，单层最多 40 项）"""
    if not sandbox_root:
        return ""
    import os as _os
    root_name = _os.path.basename(sandbox_root.rstrip("/\\")) or sandbox_root

    MAX_ITEMS_PER_DIR = 40
    MAX_TREE_ITEMS = 120
    tree_items = 0

    def _walk_tree(dir_path: str, prefix: str = "", depth: int = 0, max_depth: int = 3):
        """递归收集目录树快照，带深度和总数限制"""
        nonlocal tree_items
        lines = []
        if depth >= max_depth or tree_items >= MAX_TREE_ITEMS:
            return lines

        try:
            entries = sorted(_os.scandir(dir_path), key=lambda e: (not e.is_dir(), e.name.lower()))
        except (PermissionError, FileNotFoundError, OSError):
            return lines

        shown = 0
        for entry in entries:
            if tree_items >= MAX_TREE_ITEMS:
                break
            if shown >= MAX_ITEMS_PER_DIR:
                lines.append(f"{prefix}  …（还有更多，用 list_files 深入查看）")
                break
            if entry.name.startswith(".") or entry.name.startswith("__pycache__"):
                continue

            tree_items += 1
            shown += 1
            if entry.is_dir():
                lines.append(f"{prefix}  {entry.name}/")
                sub = _walk_tree(entry.path, prefix + "    ", depth + 1, max_depth)
                lines.extend(sub)
            else:
                lines.append(f"{prefix}  {entry.name}")

        return lines

    tree_lines = _walk_tree(sandbox_root)
    if tree_items >= MAX_TREE_ITEMS:
        tree_lines.append("…（文件树过大已截断，用 list_files 逐层浏览子目录）")

    lines = [f"## 当前工作区\n根目录: {sandbox_root}\n"]
    if tree_lines:
        lines.append("文件树快照（最多 3 层）：")
        lines.extend(tree_lines)
    else:
        lines.append("（空目录，还没有文件）")

    lines.append("\n阅读策略：先看树判断项目类型 → 逐层 list_files 进入关键目录 → read_file 读入口文件 → grep 定位具体代码。")
    return "\n".join(lines)


async def _pre_rag(user_message: str) -> str:
    """用用户最后一条消息做 RAG 语义搜索，返回格式化上下文

    使用严格阈值 0.55，只在问题与知识库明显相关时注入结果，
    避免宽泛检索把无关信息塞进提示词干扰 AI 判断。"""
    if not user_message or len(user_message) < 3:
        return ""
    try:
        result = await knowledge_rag(query=user_message, limit=3, threshold=0.55)
        if result and "没有找到" not in result and "也未找到" not in result:
            return f"根据用户当前问题预检索知识库，找到以下可能相关信息：\n{result}"
    except Exception:
        pass
    return ""


# ── 工具调度 ──

# 工具元数据和映射从 registry 导入（见顶部 import）
# _TOOL_META / TOOL_MAP / TOOL_LABELS 已定义在 backend.tools.registry


def _get_max_loop_rounds(mode: str = "ask") -> int:
    """从 user_config 读取最大循环轮数，按模式区分

    ask 模式 → max_loop_rounds（默认 8）
    plan / agent / auto 模式 → max_loop_rounds_plan（默认 15）
    """
    is_plan = mode in ("plan", "agent", "auto")
    config_key = "max_loop_rounds_plan" if is_plan else "max_loop_rounds"
    default_val = DEFAULT_MAX_TOOL_CALLS_PLAN if is_plan else DEFAULT_MAX_TOOL_CALLS_ASK
    try:
        conn = get_db()
        try:
            row = conn.execute(
                "SELECT value FROM user_config WHERE key = ?", (config_key,)
            ).fetchone()
            if row and row["value"]:
                val = int(row["value"])
                lo, hi = (12, 25) if is_plan else (5, 20)
                return max(lo, min(hi, val))
        finally:
            conn.close()
    except Exception:
        pass
    return default_val


def _safe_str(v) -> str:
    """安全转字符串"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, (list, tuple)):
        return " ".join(str(x) for x in v if x)
    return str(v)


async def _execute_tool(tool_name: str, params: dict, sandbox_root: str = None) -> tuple[str, str]:
    """执行工具并返回 (result_text, error_or_empty)

    统一分发：根据 registry 中的函数签名自动传参。
    参数名从 registry 的 schema.properties 中提取，优先匹配。
    """
    func = TOOL_MAP.get(tool_name)
    if not func:
        return "", f"未知工具: {tool_name}"

    if not isinstance(params, dict):
        params = {}

    # 从 registry schema 获取参数列表
    meta = TOOL_META.get(tool_name, {})
    schema_props = {}
    for t in _get_tools_list():
        if t["name"] == tool_name:
            schema_props = t.get("schema", {}).get("properties", {})
            break

    try:
        # 构建 kwargs：从 params 中匹配 schema 定义的参数名
        kwargs = {}
        for key, prop in schema_props.items():
            raw = params.get(key, "")
            if raw is None:
                continue
            # 按 schema 类型转换：integer → int，其他→ str
            if prop.get("type") == "integer":
                try:
                    kwargs[key] = int(raw)
                except (ValueError, TypeError):
                    # 空字符串也跳过，让函数用默认值
                    if isinstance(raw, str) and raw.strip() == "":
                        continue
                    kwargs[key] = 0
            else:
                # 字符串类型：确保始终传 str，避免数字直接流入
                kwargs[key] = str(raw).strip() if raw else ""

        # 自动补全 http 前缀（web_fetch）
        if tool_name == "web_fetch" and "url" in kwargs:
            if not kwargs["url"].startswith("http"):
                kwargs["url"] = "https://" + kwargs["url"]

        # 注入 sandbox_root（工作区相关工具需要）
        if tool_name in ("list_files", "read_file", "grep"):
            kwargs["sandbox_root"] = sandbox_root

        # 校验必填参数
        required = []
        for t in _get_tools_list():
            if t["name"] == tool_name:
                required = t.get("schema", {}).get("required", [])
                break
        for key in required:
            if not kwargs.get(key):
                return "", f"缺少必填参数: {key}"

        result = await func(**kwargs)
        return result or "(工具返回空结果)", ""
    except Exception as e:
        return "", f"工具执行出错: {str(e)}"


# 缓存 registry 的工具列表（避免重复遍历）
_TOOLS_LIST_CACHE = None


def _get_tools_list():
    """延迟导入工具列表（避免循环导入）"""
    global _TOOLS_LIST_CACHE
    if _TOOLS_LIST_CACHE is None:
        from ..tools.registry import _TOOLS as __TOOLS
        _TOOLS_LIST_CACHE = __TOOLS
    return _TOOLS_LIST_CACHE


def _parse_json_response(text: str) -> Optional[dict]:
    """解析统一的 JSON 响应格式

    支持：
    1. 纯 JSON: {"type": "tool", ...} 或 {"type": "final", ...}
    2. ```json ... ``` 代码块
    3. 文本中嵌入的 JSON（找第一个 { 到最后一个 }）
    4. 单引号、尾部逗号等常见 AI 错误的自动修复
    """
    text = text.strip()
    if not text:
        return None

    # 复用 LLMCaller 成熟的多层解析
    obj = LLMCaller._parse_json(text)
    if isinstance(obj, dict) and "type" in obj:
        return obj

    # 如果解析成功但没有 type 字段，检查是否是旧格式 {tool, parameters}
    if isinstance(obj, dict) and "tool" in obj:
        # 兼容旧格式：自动转换为新格式
        return {"type": "tool", "tool": obj["tool"], "parameters": obj.get("parameters", {})}

    return None


async def _call_ai_buffered(
    provider_config: dict,
    model: str,
    messages: list[dict],
    abort_check: Callable = None,
) -> str:
    """调用 AI → 返回完整响应文本"""
    caller = LLMCaller(provider_config, model)
    return await caller.call(messages, abort_check=abort_check)


async def _stream_text(text: str, stream_callback, chunk_size: int = 4):
    """将文本流式推送到前端"""
    import asyncio as _asyncio
    for i in range(0, len(text), chunk_size):
        chunk = text[i:i + chunk_size]
        await stream_callback({"type": "delta", "content": chunk})
        await _asyncio.sleep(0.02)


# ── 主循环 ──

async def run_react_loop(
    messages: list[dict],
    provider_id: str,
    model: str,
    stream_callback: Callable,
    abort_check: Optional[Callable] = None,
    sandbox_root: str = None,
    mode: str = "ask",
    session_id: str = None,
) -> str:
    """Re-Act 主循环

    Args:
        messages: 用户对话历史 [{role, content}, ...]
        provider_id: 供应商 ID
        model: 模型名称
        stream_callback: async callable(event_dict) — SSE 事件推送
        abort_check: callable() → bool — 检查是否被用户中止
        sandbox_root: 工作区根目录路径（供 list_files 等工具使用）
        mode: 对话模式（ask / plan / agent / auto），影响循环上限
        session_id: 会话 ID，用于排队消息注入

    Returns:
        最终 AI 文本回复
    """
    # 获取供应商配置
    conn = get_db()
    try:
        provider = conn.execute(
            "SELECT * FROM providers WHERE id = ? AND is_enabled = 1",
            (provider_id,),
        ).fetchone()
    finally:
        conn.close()

    if not provider:
        await stream_callback({
            "type": "tool_error",
            "tool": "system",
            "error": "供应商不存在或已停用",
        })
        return "错误：AI 供应商不可用。"

    logger.debug(f"ReAct 启动 | 模型={model} | 模式={mode} | 最大轮数={_get_max_loop_rounds(mode)} | 工作区={sandbox_root or '未设置'}")

    # ── 预 RAG：用最后一条用户消息查知识库 ──
    last_user_msg = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user_msg = m.get("content", "")
            break

    rag_context = ""
    if last_user_msg:
        logger.debug(f"预 RAG 检索 | query={last_user_msg[:80]}…")
        rag_context = await _pre_rag(last_user_msg)
        if rag_context:
            logger.debug(f"预 RAG 命中 | 长度={len(rag_context)} 字符")
        else:
            logger.debug("预 RAG 未命中（无相关内容）")

    # ── 工作区上下文：让 AI 知道用户打开了哪个文件夹 ──
    workspace_context = ""
    if sandbox_root:
        logger.debug(f"构建工作区上下文 | root={sandbox_root}")
        workspace_context = await _build_workspace_context(sandbox_root)
        logger.debug(f"工作区上下文就绪 | 长度={len(workspace_context)} 字符")

    # ── 构建消息 ──
    has_system = any(m.get("role") == "system" for m in messages)

    full_messages = []
    if not has_system:
        full_messages.append({"role": "system", "content": _STATIC_PROMPT})
        dynamic = _build_dynamic_prompt(rag_context, workspace_context)
        full_messages.append({"role": "system", "content": dynamic})
    full_messages.extend(messages)

    # ── Debug: 提示词组装详情 ──
    if not has_system:
        static_len = len(_STATIC_PROMPT)
        dynamic_len = len(dynamic)
        history_chars = sum(len(m.get("content", "")) for m in messages)
        total_chars = sum(len(m.get("content", "")) for m in full_messages)
        logger.debug(
            f"提示词组装 | 静态={static_len}字符 | 动态={dynamic_len}字符"
            f"(RAG={len(rag_context)} 工作区={len(workspace_context)}) | "
            f"历史={len(messages)}条/{history_chars}字符 | 总计={total_chars}字符"
        )

    tool_call_count = 0
    consecutive_empty = 0
    json_retry_count = 0
    max_tool_calls = _get_max_loop_rounds(mode)
    _last_tool = ""

    logger.debug(f"提示词就绪 | system消息={2 if not has_system else 1}条 | 历史消息={len(messages)}条 | 循环上限={max_tool_calls}")

    # ── 写入 prompt.md：初始提示词 + 对话历史 ──
    _append_prompt_log(
        f"# 对话开始 — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}\n\n"
        + "\n\n---\n\n".join(
            f"## [{m['role']}]\n{m.get('content', '')}"
            for m in full_messages
        )
    )

    while tool_call_count < max_tool_calls:
        # 检查中止
        if abort_check and abort_check():
            logger.debug("ReAct 被用户中止")
            await stream_callback({"type": "done"})
            return "（已停止）"

        # ── 检查排队消息注入 ──
        if session_id:
            try:
                from ..routers.chat import _INJECT_QUEUES
                queue = _INJECT_QUEUES.get(session_id, [])
                if queue:
                    injected = []
                    while queue:
                        msg = queue.pop(0)
                        injected.append(msg["content"])
                    logger.debug(f"注入排队消息 | session={session_id[:8]}… | 注入={len(injected)}条")
                    for content in injected:
                        if has_system:
                            full_messages.append({"role": "user", "content": content})
                        else:
                            full_messages.append({"role": "system", "content": "[用户补充] " + content})
                    await stream_callback({"type": "user_injected", "messages": injected})
            except Exception:
                pass  # 注入失败不阻塞主流程

        logger.debug(
            f"第{tool_call_count+1}/{max_tool_calls}轮 | "
            f"full_messages={len(full_messages)}条 | "
            f"总字符={sum(len(m.get('content','')) for m in full_messages)} | "
            f"连续空={consecutive_empty}/3 | JSON重试={json_retry_count}/{MAX_JSON_RETRIES}"
        )

        # JSON 重试次数保护
        if json_retry_count >= MAX_JSON_RETRIES:
            logger.debug(f"JSON重试耗尽({MAX_JSON_RETRIES}次) | 给出强格式纠正引导")
            # 不强制 final——格式错误只是格式问题，不代表任务完成
            # 给出极具体的格式示例，帮助 AI 纠正
            last_good = ""
            for m in reversed(full_messages):
                if m.get("role") == "assistant" and m.get("content", "").strip().startswith("{"):
                    last_good = m["content"][:200]
                    break
            hint = ""
            if last_good:
                hint = f"\n你之前成功输出过合法 JSON，例如：{last_good}\n请参照这个格式重新输出。"
            full_messages.append({
                "role": "system",
                "content": (
                    f"你已经连续 {MAX_JSON_RETRIES} 次输出格式错误。这不是让你放弃任务，只是格式需要修正。\n\n"
                    "常见错误及修正：\n"
                    '1. 纯文本无 JSON → 必须包成 {"type": "final", "content": "你的文本"}\n'
                    '2. JSON 前有废话（如"让我看看"）→ 去掉前缀，只输出 JSON 本身\n'
                    '3. 用 ```json ``` 包裹 → 去掉代码块标记，裸输出 JSON\n'
                    '4. JSON 内中文引号、未转义换行 → 中文用全角标点或 \\n 转义\n\n'
                    "现在请重新输出你**刚才想做的那件事**（调用同一个工具，或给出最终回答），"
                    f"只是这次严格按 JSON 格式写。{hint}"
                ),
            })
            json_retry_count = 0

        # 通知前端 AI 正在思考
        await stream_callback({"type": "thinking"})

        # ── 调用 AI ──
        try:
            response_text = await _call_ai_buffered(
                provider_config=dict(provider),
                model=model,
                messages=full_messages,
                abort_check=abort_check,
            )
            logger.debug(f"AI调用完成 | 响应长度={len(response_text)}字符")
            # ── 写入 prompt.md：AI 原始响应 ──
            _append_prompt_log(f"## [assistant] (第{tool_call_count+1}轮)\n{response_text}")
        except Exception as e:
            logger.error(f"AI 调用失败: {e}")
            await stream_callback({
                "type": "tool_error",
                "tool": "system",
                "error": str(e),
            })
            await stream_callback({"type": "done"})
            return f"错误：{str(e)}"

        # ── 解析 JSON 响应 ──
        parsed = _parse_json_response(response_text)

        # JSON 解析失败 → 重试
        if not parsed:
            json_retry_count += 1
            logger.debug(f"JSON解析失败(第{json_retry_count}/{MAX_JSON_RETRIES}次) | 预览={response_text[:120].replace(chr(10),' ')}")
            # 截取前 300 字符作为反馈，避免上下文太长
            preview = response_text[:300].replace("\n", "\\n")
            full_messages.append({
                "role": "assistant",
                "content": response_text[:500],
            })
            full_messages.append({
                "role": "system",
                "content": (
                    f"[系统通知] 上一条不是合法 JSON（第 {json_retry_count}/{MAX_JSON_RETRIES} 次）。\n"
                    f"收到内容预览: {preview}\n\n"
                    "你做的方向没错，只是输出格式需要修正。请重新输出**和刚才完全一样意图**的内容，"
                    "但严格遵守 JSON 格式。不要换策略、不要放弃工具调用、不要改成纯文本——只修正格式。\n\n"
                    "正确格式（二选一）：\n"
                    '调工具 → {"type": "tool", "tool": "工具名", "parameters": {…}}\n'
                    '回复用户 → {"type": "final", "content": "Markdown内容，换行用\\n"}'
                ),
            })
            continue

        # JSON 解析成功，重置重试计数
        json_retry_count = 0
        resp_type = parsed.get("type", "")
        logger.debug(f"AI响应 | type={resp_type} | tool={parsed.get('tool','-')} | final_len={len(parsed.get('content',''))}")

        # ── 处理 tool 类型 ──
        if resp_type == "tool":
            tool_name = parsed.get("tool", "")
            params = parsed.get("parameters", {})
            label = TOOL_LABELS.get(tool_name, tool_name)
            meta = TOOL_META.get(tool_name, {})
            is_read = meta.get("type") == "read"

            current_group = meta.get("group", tool_name)
            last_group = TOOL_META.get(_last_tool, {}).get("group", _last_tool) if _last_tool else ""

            # list_files 不计次不去重（探索目录需要大量连续调用）
            is_dup = is_read and (current_group == last_group) and tool_name != "list_files"
            _last_tool = tool_name
            is_exempt = tool_name == "list_files"

            logger.debug(f"工具调用 | {tool_name} | 参数={json.dumps(params, ensure_ascii=False)[:200]} | {'不计次' if is_exempt else ('重复(静默)' if is_dup else '执行')} | 剩余={max_tool_calls - tool_call_count}次")

            # 执行工具
            if not is_dup or is_exempt:
                if not is_exempt:
                    tool_call_count += 1
                await stream_callback({
                    "type": "tool_start",
                    "tool": tool_name,
                    "args": params,
                    "label": label,
                })

            result, error = await _execute_tool(tool_name, params, sandbox_root)

            # 存储 AI 的工具调用
            assistant_content = json.dumps(parsed, ensure_ascii=False)
            full_messages.append({
                "role": "assistant",
                "content": assistant_content,
            })

            # 判断结果是否"空"
            is_empty = False
            if error:
                is_empty = True
            elif result:
                empty_signals = [
                    "没有找到相关信息", "未找到与", "没有找到与",
                    "网页内容为空", "无法解析",
                    "搜索服务暂时不可用",
                ]
                is_empty = any(sig in result for sig in empty_signals)

            if is_empty:
                consecutive_empty += 1
                logger.debug(f"空结果 | {tool_name} | 连续空={consecutive_empty}/3 | error={bool(error)}")
            else:
                consecutive_empty = 0

            if error:
                logger.debug(f"工具错误 | {tool_name}: {error[:120]}")
                # 错误总是通知前端（即使是重复调用），让用户知道出了问题
                await stream_callback({
                    "type": "tool_error",
                    "tool": tool_name,
                    "error": error,
                })
                stop_hint = ""
                if consecutive_empty >= 3:
                    stop_hint = (
                        "\n[系统指令] 你已经连续 3 次尝试均未获得有效结果。"
                        "立即停止所有工具调用，输出最终 JSON 回复。不得再发起任何工具请求。"
                    )
                # 给 AI 可操作的提示：不要重复相同调用
                fix_hint = (
                    "\n[提示] 这个错误很可能是参数类型问题（字符串/数字混用）。"
                    "不要用相同参数重试——换一组参数或换一个工具。"
                    f"例如去掉可选的数字参数（start_line/end_line/max_results），让工具用默认值。"
                )
                full_messages.append({
                    "role": "system",
                    "content": (
                        f"[工具结果] 工具 {tool_name} ({label}) 执行出错: {error}{fix_hint}{stop_hint}"
                    ),
                })
            else:
                if not is_dup or is_exempt:
                    await stream_callback({
                        "type": "tool_result",
                        "tool": tool_name,
                        "args": params,
                        "result": result[:500],
                        "label": label,
                    })

                max_result_len = 2000
                if len(result) > max_result_len:
                    result = result[:max_result_len] + f"\n…（截断，原 {len(result)} 字符）"

                dup_hint = "\n[系统提示] 重复调用同一工具，请换方式或基于现有信息回答。" if is_dup else ""
                # web_search 后强提醒：必须 fetch
                fetch_hint = ""
                if tool_name == "web_search" and not is_empty:
                    fetch_hint = (
                        "\n\n[重要提醒] 以上只是搜索摘要（标题+片段），信息量极少，绝不能据此直接回答。"
                        "你必须立刻调用 web_fetch 抓取其中 1~2 个最相关的 URL 获取完整内容。"
                        "如果你跳过 web_fetch 直接输出 final，就是在编造信息。"
                    )
                stop_hint = ""
                if consecutive_empty >= 3:
                    stop_hint = (
                        "\n[系统指令] 你已经连续 3 次尝试均未获得有效结果。"
                        "立即停止所有工具调用，输出最终 JSON 回复。不得再发起任何工具请求。"
                    )
                full_messages.append({
                    "role": "system",
                    "content": (
                        f"[工具结果] {tool_name} ({label}):\n{result}{dup_hint}{fetch_hint}{stop_hint}"
                    ),
                })

        # ── 处理 final 类型 ──
        elif resp_type == "final":
            final_content = parsed.get("content", "")
            logger.debug(f"AI最终回复 | 长度={len(final_content)}字符 | 工具调用总次数={tool_call_count}")
            if final_content:
                await _stream_text(final_content, stream_callback)
                await stream_callback({"type": "done"})
                return final_content
            else:
                # content 为空，提示重试
                full_messages.append({
                    "role": "assistant",
                    "content": response_text[:500],
                })
                full_messages.append({
                    "role": "system",
                    "content": '[系统通知] "content" 字段不能为空。请重新输出包含有效回复内容的 JSON。',
                })
                continue

        else:
            # 未知 type
            full_messages.append({
                "role": "assistant",
                "content": response_text[:500],
            })
            full_messages.append({
                "role": "system",
                "content": (
                    f'[系统通知] 未知的 type 值 "{resp_type}"。'
                    '只允许 "tool" 或 "final"。请重新输出正确的 JSON。'
                ),
            })
            continue

    # ── 达到最大轮数，强制总结 ──
    logger.debug(f"ReAct 达到最大轮数 | 已调用={tool_call_count}次 | 上限={max_tool_calls}")
    await stream_callback({"type": "max_rounds", "max": max_tool_calls})

    full_messages.append({
        "role": "system",
        "content": (
            f"已达到最大工具调用次数 ({max_tool_calls} 次)。"
            f"请立即回复用户。任务完成则给最终回答，未完成则说明当前进度。\n\n"
            f"关键：content 必须全部塞在一行，段落用 \\n\\n 分隔，不要物理换行。\n"
            f"正确示例：{{\"type\":\"final\",\"content\":\"已经完成了 X……\\n\\n遇到的问题是 Y。\"}}"
        ),
    })

    final_text = ""
    try:
        final_raw = await _call_ai_buffered(
            provider_config=dict(provider),
            model=model,
            messages=full_messages,
            abort_check=abort_check,
        )
        _append_prompt_log(f"## [assistant] (强制总结)\n{final_raw}")
        parsed = _parse_json_response(final_raw)
        if parsed and parsed.get("type") == "final":
            final_text = parsed.get("content", "")
        elif parsed and parsed.get("type") == "tool":
            # 还在尝试调工具，但已达上限
            final_text = "抱歉，已达到本轮操作上限。请在设置中调高最大循环轮数后重试。"
        else:
            # JSON 解析失败，但至少拿点文本
            final_text = final_raw.strip() or "抱歉，请重试。"
    except Exception:
        final_text = "抱歉，请重试。"

    if not final_text.strip():
        final_text = "抱歉，请重试。<small>（可在设置中调高最大循环轮数）</small>"

    logger.debug(f"ReAct 结束 | 总工具调用={tool_call_count}次 | 最终回复={len(final_text)}字符")
    await _stream_text(final_text, stream_callback)
    await stream_callback({"type": "done"})
    return final_text
