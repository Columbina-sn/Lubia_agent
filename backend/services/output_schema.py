"""输出格式定义与校验

为每种对话模式定义合法的 AI 输出格式。OutputValidator 负责：
1. JSON 解析（多层修复：单引号/尾部逗号/代码块/物理换行）
2. Schema 校验：type 是否合法、必填字段是否齐全、tool 名称是否在允许列表中
3. 返回 (parsed_dict, error_hint) — 上层决定是否重试

使用方式：
    from .output_schema import OutputValidator, get_schema
    schema = get_schema("ask")
    result, error = OutputValidator.validate(ai_raw_text, schema)
"""

from typing import Optional


# ═══════════════════════════════════════════
# Schema 定义
# ═══════════════════════════════════════════

def get_schema(mode: str) -> dict:
    """获取指定模式的输出格式定义

    Returns:
        {
            "allowed_types": ["tool", "final"],
            "required_by_type": {
                "tool": ["tool", "parameters"],
                "final": ["content"],
            },
            "tool_names": ["web_search", ...],
        }
    """
    if mode == "plan":
        return _PLAN_SCHEMA
    elif mode in ("agent", "auto"):
        return _AUTO_SCHEMA
    else:
        return _ASK_SCHEMA


_ASK_SCHEMA = {
    "allowed_types": ["tool", "final"],
    "required_by_type": {
        "tool": ["tool", "parameters"],
        "final": ["content"],
    },
    "tool_names": [
        "web_search", "web_fetch",
        "knowledge_grep", "knowledge_rag", "knowledge_import",
        "list_files", "read_file", "grep",
    ],
}

_PLAN_SCHEMA = {
    "allowed_types": ["plan", "tool", "final"],
    "required_by_type": {
        "plan": ["steps", "options"],
        "tool": ["tool", "parameters"],
        "final": ["content"],
    },
    "tool_names": [
        "web_search", "web_fetch",
        "knowledge_grep", "knowledge_rag", "knowledge_import",
        "list_files", "read_file", "grep",
    ],
}

_AUTO_SCHEMA = {
    "allowed_types": ["tool", "final"],
    "required_by_type": {
        "tool": ["tool", "parameters"],
        "final": ["content"],
    },
    "tool_names": [
        "web_search", "web_fetch",
        "knowledge_grep", "knowledge_rag", "knowledge_import",
        "list_files", "read_file", "grep",
    ],
}


# ═══════════════════════════════════════════
# 校验结果
# ═══════════════════════════════════════════

class ValidationResult:
    """校验结果"""
    def __init__(self, ok: bool, parsed=None,
                 error: str = "", error_detail: str = ""):
        self.ok = ok
        self.parsed = parsed          # 解析成功的 dict 或 list[dict]（ok=True 时有效）
        self.error = error            # 简短错误码
        self.error_detail = error_detail  # 人类可读的错误描述
        self.is_batch = False         # True = parsed 是 list，需逐个执行


# ═══════════════════════════════════════════
# 校验器
# ═══════════════════════════════════════════

class OutputValidator:
    """AI 输出格式校验器"""

    @staticmethod
    def validate(raw_text: str, schema: dict) -> ValidationResult:
        """校验 AI 输出是否符合指定 schema

        Args:
            raw_text: AI 原始输出文本
            schema: get_schema() 返回的格式定义

        Returns:
            ValidationResult
        """
        # ① JSON 解析（多层修复）
        parsed = OutputValidator._parse_json(raw_text)
        if parsed is None:
            preview = raw_text[:200].replace("\n", "\\n")
            return ValidationResult(
                ok=False, error="not_json",
                error_detail=f"无法解析为 JSON。收到: {preview}",
            )

        # ② 数组 = 批量工具调用，逐个校验
        if isinstance(parsed, list):
            if len(parsed) == 0:
                return ValidationResult(
                    ok=False, error="not_json",
                    error_detail="JSON 数组不能为空。",
                )
            for i, item in enumerate(parsed):
                if not isinstance(item, dict):
                    return ValidationResult(
                        ok=False, error="not_json",
                        error_detail=f"数组第 {i+1} 个元素不是对象。",
                    )
                err = OutputValidator._validate_one(item, schema)
                if err:
                    return ValidationResult(
                        ok=False, error=err,
                        error_detail=f"数组第 {i+1} 个元素: {err}",
                    )
            result = ValidationResult(ok=True, parsed=parsed)
            result.is_batch = True
            return result

        # ③ 单个对象校验
        if not isinstance(parsed, dict):
            return ValidationResult(
                ok=False, error="not_json",
                error_detail=f"JSON 顶层必须是对象或数组。",
            )

        err = OutputValidator._validate_one(parsed, schema)
        if err:
            return ValidationResult(
                ok=False, error=err,
                error_detail=err,
            )
        return ValidationResult(ok=True, parsed=parsed)

    @staticmethod
    def _validate_one(obj: dict, schema: dict) -> str | None:
        """校验单个对象，返回错误字符串或 None"""
        resp_type = obj.get("type", "")
        allowed = schema.get("allowed_types", [])
        if resp_type not in allowed:
            return f'未知的 type "{resp_type}"，只允许: {", ".join(allowed)}。'

        required = schema.get("required_by_type", {}).get(resp_type, [])
        missing = [f for f in required if not obj.get(f)]
        if missing:
            return f'{resp_type} 类型缺少必填字段: {", ".join(missing)}。'

        if resp_type == "tool":
            tool_name = obj.get("tool", "")
            valid_tools = schema.get("tool_names", [])
            if tool_name not in valid_tools:
                near = OutputValidator._nearest(tool_name, valid_tools)
                hint = f' 你是想用 "{near}" 吗？' if near else ""
                return f'未知工具 "{tool_name}"。{hint}'

        if resp_type == "final":
            content = obj.get("content", "")
            if not content or not content.strip():
                return '"content" 字段不能为空。'

        if resp_type == "plan":
            steps = obj.get("steps", [])
            if not isinstance(steps, list) or len(steps) == 0:
                return '"steps" 必须是非空数组。'
            for i, step in enumerate(steps):
                if not isinstance(step, dict):
                    return f'steps[{i}] 必须是对象。'
                if not step.get("title"):
                    return f'steps[{i}] 缺少 "title" 字段。'

        return None

        # ② type 字段校验
        resp_type = parsed.get("type", "")
        allowed = schema.get("allowed_types", [])
        if resp_type not in allowed:
            return ValidationResult(
                ok=False, error="unknown_type",
                error_detail=(
                    f'未知的 type "{resp_type}"，只允许: {", ".join(allowed)}。'
                ),
            )

        # ③ 必填字段校验
        required = schema.get("required_by_type", {}).get(resp_type, [])
        missing = [f for f in required if not parsed.get(f)]
        if missing:
            return ValidationResult(
                ok=False, error="missing_field",
                error_detail=(
                    f'{resp_type} 类型缺少必填字段: {", ".join(missing)}。'
                ),
            )

        # ④ tool 名称校验（仅 tool 类型）
        if resp_type == "tool":
            tool_name = parsed.get("tool", "")
            valid_tools = schema.get("tool_names", [])
            if tool_name not in valid_tools:
                near = OutputValidator._nearest(tool_name, valid_tools)
                hint = f' 你是想用 "{near}" 吗？' if near else ""
                return ValidationResult(
                    ok=False, error="unknown_tool",
                    error_detail=f'未知工具 "{tool_name}"。{hint}',
                )

        # ⑤ 额外检查：final 的 content 不能为空
        if resp_type == "final":
            content = parsed.get("content", "")
            if not content or not content.strip():
                return ValidationResult(
                    ok=False, error="missing_field",
                    error_detail='"content" 字段不能为空。',
                )

        # ⑥ plan 类型额外检查（仅 plan 模式）
        if resp_type == "plan":
            steps = parsed.get("steps", [])
            if not isinstance(steps, list) or len(steps) == 0:
                return ValidationResult(
                    ok=False, error="missing_field",
                    error_detail='"steps" 必须是非空数组。',
                )
            for i, step in enumerate(steps):
                if not isinstance(step, dict):
                    return ValidationResult(
                        ok=False, error="missing_field",
                        error_detail=f'steps[{i}] 必须是对象（含 title 和 desc）。',
                    )
                if not step.get("title"):
                    return ValidationResult(
                        ok=False, error="missing_field",
                        error_detail=f'steps[{i}] 缺少 "title" 字段。',
                    )

        return ValidationResult(ok=True, parsed=parsed)

    # ═══════════════════════════════════════════
    # JSON 解析（多层修复）—— 复用 LLMCaller 逻辑
    # ═══════════════════════════════════════════

    @staticmethod
    def _parse_json(raw: str) -> Optional[dict | list]:
        """多层 JSON 解析 + 修复

        与 LLMCaller._parse_json 保持一致，额外增加：
        - 移除 AI 在 JSON 前写的废话前缀
        """
        # 导入 LLMCaller 的成熟解析逻辑
        from .llm_caller import LLMCaller
        return LLMCaller._parse_json(raw)

    @staticmethod
    def _nearest(name: str, candidates: list[str]) -> Optional[str]:
        """找最接近的合法工具名（拼写纠错）"""
        if not name or not candidates:
            return None
        name_lower = name.lower().strip()
        best = None
        best_score = 0
        for c in candidates:
            c_lower = c.lower()
            # 简单的公共前缀/子串匹配
            if c_lower == name_lower:
                return c
            if name_lower in c_lower or c_lower in name_lower:
                score = min(len(name_lower), len(c_lower))
                if score > best_score:
                    best_score = score
                    best = c
        # 至少匹配 50% 才建议
        if best and best_score >= len(name_lower) * 0.5:
            return best
        return None


# ═══════════════════════════════════════════
# 格式重试提示模板
# ═══════════════════════════════════════════

def build_retry_hint(
    validation_result: ValidationResult,
    schema: dict,
    retry_count: int,
    max_retries: int = 3,
) -> str:
    """根据校验失败原因，生成给 AI 的格式纠正提示

    Args:
        validation_result: 校验失败结果
        schema: 当前模式的 schema
        retry_count: 当前重试次数
        max_retries: 最大重试次数

    Returns:
        注入到对话中的 system 消息文本
    """
    error = validation_result.error
    detail = validation_result.error_detail

    base = f"[系统通知] 上一条不是合法 JSON（第 {retry_count}/{max_retries} 次）。\n{detail}\n\n"

    if error == "not_json":
        base += (
            "你做的方向没错，只是输出格式需要修正。请重新输出**和刚才完全一样意图**的内容，"
            "但严格遵守 JSON 格式。不要换策略、不要放弃工具调用、不要改成纯文本——只修正格式。\n\n"
            "正确格式（二选一）：\n"
            '调工具 → {"type": "tool", "tool": "工具名", "parameters": {…}}\n'
        )
        if "final" in schema.get("allowed_types", []):
            base += '回复用户 → {"type": "final", "content": "Markdown内容，换行用\\\n"}'
        if "plan" in schema.get("allowed_types", []):
            base += '出方案 → {"type": "plan", "steps": [...], "options": [...]}'

    elif error == "unknown_type":
        allowed = schema.get("allowed_types", [])
        base += f'请把 "type" 改为: {", ".join(allowed)}。'

    elif error == "missing_field":
        base += "请补充缺失的字段，保持 JSON 格式。"

    elif error == "unknown_tool":
        tools = schema.get("tool_names", [])
        base += f"可用的工具: {', '.join(tools)}。请修正 tool 名称。"

    # 第 3 次重试 → 极简模板兜底
    if retry_count >= max_retries:
        example_tool = '{"type": "tool", "tool": "web_search", "parameters": {"query": "搜索词"}}'
        example_final = '{"type": "final", "content": "你的回答内容，用\\\n表示换行"}'
        base += (
            f"\n\n你已经连续 {max_retries} 次格式错误。这不是让你放弃，只是格式需要修正。\n"
            f"请严格参照以下模板（一个字都不能多）：\n"
            f"调工具 → {example_tool}\n"
            f"回复用户 → {example_final}\n"
            f"注意：JSON 必须从第一个字符开始，前面不能有任何文字。"
        )

    return base
