"""气泡策略 — 工具到气泡类型的映射 + 操作组合并规则

职责：
1. 每种工具映射到对应的气泡类型（read / exec / edit / done / None=静默）
2. 判断两个连续工具调用是"合并到同一操作组"还是"开启新气泡"
3. 区分"冗余重试"（应静默）和"深入探索"（应合并展示）

用法：
    from .bubble_policy import BubblePolicy
    bp = BubblePolicy()
    bubble_type = bp.get_bubble_type("read_file")         # "read"
    is_merge = bp.should_merge(prev_tool, current_tool)   # True/False
    is_silent = bp.is_silent_retry(prev_tool, current_tool, prev_args, cur_args)
"""

# ═══════════════════════════════════════════
# 工具 → 气泡类型映射
# ═══════════════════════════════════════════

TOOL_BUBBLE_TYPE: dict[str, str | None] = {
    # 读取类 → read 气泡（蓝紫调）
    "read_file":       "read",
    "list_files":      "read",
    "grep":            "read",
    "knowledge_grep":  "read",
    "knowledge_rag":   "read",

    # 搜索/抓取类 → exec 气泡（深蓝调）
    "web_search":      "exec",
    "web_fetch":       "exec",

    # 写入类 → edit 气泡（粉红调，预留）
    # "write_file":    "edit",
    # "replace_content": "edit",
    # "execute_command": "exec",

    # 知识导入 → 静默（不产生气泡，仅小声提示）
    "knowledge_import": None,
}

# ═══════════════════════════════════════════
# 操作组合并规则
# ═══════════════════════════════════════════

# 合并组定义：哪些工具属于同一"意图域"
_MERGE_GROUPS = {
    # 工作区探索组：浏览目录 → 读文件 → 搜索代码
    "workspace": {"list_files", "read_file", "grep"},

    # 知识库查询组：关键词搜索 → 语义搜索
    "knowledge": {"knowledge_grep", "knowledge_rag"},

    # 网络搜索组：搜索 → 抓取
    "web": {"web_search", "web_fetch"},
}

# 跨组过渡也允许合并（如先 grep 定位再 read_file 精读）
_CROSS_GROUP_MERGE = {
    ("workspace", "workspace"): True,    # 内部总是合并
    ("knowledge", "knowledge"): True,    # 内部总是合并
    ("web", "web"): True,                # 内部总是合并
}

# 工具到组的反向映射
def _tool_group(tool: str) -> str:
    for group, tools in _MERGE_GROUPS.items():
        if tool in tools:
            return group
    return tool  # 未分组的工具以自身为组名


class BubblePolicy:
    """气泡策略决策器"""

    @staticmethod
    def get_bubble_type(tool_name: str) -> str | None:
        """获取工具对应的气泡类型

        Returns:
            "read" | "exec" | "edit" | "done" | None（None=静默不弹泡）
        """
        return TOOL_BUBBLE_TYPE.get(tool_name, "exec")  # 默认 exec

    @staticmethod
    def should_merge(prev_tool: str, current_tool: str) -> bool:
        """判断两个连续工具调用是否应合并到同一操作组

        合并规则：
        - 同组工具（如 list_files→read_file）→ 合并
        - 跨组但意图连续（如 knowledge_grep→knowledge_rag）→ 合并
        - 跨域操作（如 read_file→web_search）→ 不合并

        Returns:
            True = 合并到当前操作组 | False = 开启新气泡
        """
        if not prev_tool:
            return False

        prev_group = _tool_group(prev_tool)
        curr_group = _tool_group(current_tool)

        # 同组 → 合并
        if prev_group == curr_group:
            return True

        # 跨组检查
        key = (prev_group, curr_group)
        if key in _CROSS_GROUP_MERGE:
            return _CROSS_GROUP_MERGE[key]

        # 默认不合并（跨域操作各自独立）
        return False

    @staticmethod
    def is_silent_retry(prev_tool: str, current_tool: str,
                        prev_args: dict = None, cur_args: dict = None) -> bool:
        """判断当前工具调用是否是"冗余重试"（应完全静默）

        静默条件（同时满足）：
        1. 同一个工具
        2. 参数基本相同（仅细微变化）
        3. 前一次结果为空或错误

        "深入探索"（不应静默）：
        - list_files 不同目录 → 正常逐层展开
        - read_file 不同文件 → 正常阅读多个文件
        - web_search 完全不同的搜索词 → 正常换个方向搜索

        Returns:
            True = 静默（不弹泡、不计循环上限）
        """
        if not prev_tool or not current_tool:
            return False
        if prev_tool != current_tool:
            return False

        # list_files 和 read_file 永远不静默——它们是正常的深入探索
        if current_tool in ("list_files", "read_file", "grep"):
            return False

        # 如果参数完全相同或高度相似 → 静默
        if prev_args and cur_args:
            # knowledge_grep / knowledge_rag → 如果 query 相似（>70% 重叠字符）→ 静默
            if current_tool in ("knowledge_grep", "knowledge_rag", "web_search"):
                prev_q = str(prev_args.get("query", "")).lower().strip()
                cur_q = str(cur_args.get("query", "")).lower().strip()
                if prev_q and cur_q:
                    common = len(set(prev_q) & set(cur_q))
                    total = len(set(prev_q) | set(cur_q))
                    if total > 0 and common / total > 0.6:
                        return True

            # web_fetch → 如果 URL 完全相同 → 静默
            if current_tool == "web_fetch":
                prev_url = str(prev_args.get("url", "")).strip()
                cur_url = str(cur_args.get("url", "")).strip()
                if prev_url and cur_url and prev_url == cur_url:
                    return True

        return False

    @staticmethod
    def get_operation_label(first_tool: str) -> str:
        """根据操作组的第一个工具生成人类可读的操作标签

        Returns:
            如 "正在浏览工作区…" / "正在搜索知识库…" / "正在网上搜索…"
        """
        group = _tool_group(first_tool)
        labels = {
            "workspace": "正在浏览工作区…",
            "knowledge": "正在搜索知识库…",
            "web": "正在网上搜索…",
        }
        return labels.get(group, f"正在使用 {first_tool}…")

    @staticmethod
    def get_done_label(tools_used: list[str]) -> str:
        """根据操作组中使用的工具生成完成态标签

        Args:
            tools_used: 操作组内使用过的工具列表（去重）

        Returns:
            如 "已读取 3 个文件" / "知识库搜索完成" / "网页搜索并抓取完成"
        """
        unique = list(set(tools_used))

        # 工作区探索组
        if any(t in ("list_files", "read_file", "grep") for t in unique):
            read_files = sum(1 for t in tools_used if t == "read_file")
            list_dirs = sum(1 for t in tools_used if t == "list_files")
            grep_count = sum(1 for t in tools_used if t == "grep")
            parts = []
            if list_dirs:
                parts.append(f"浏览了 {list_dirs} 个目录")
            if read_files:
                parts.append(f"读取了 {read_files} 个文件")
            if grep_count:
                parts.append(f"搜索了 {grep_count} 次")
            return "，".join(parts) if parts else "工作区浏览完成"

        # 知识库
        if any(t in ("knowledge_grep", "knowledge_rag") for t in unique):
            return "知识库检索完成"

        # 网络搜索
        if any(t in ("web_search", "web_fetch") for t in unique):
            has_fetch = "web_fetch" in tools_used
            return "网页搜索并抓取完成" if has_fetch else "联网搜索完成"

        return "操作完成"
