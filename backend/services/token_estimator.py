"""Token 估算工具

LLM API 调用时用于估算输入/输出的 token 用量。
优先使用 API 返回的实际 usage 数据，无实际数据时用字符估算。

估算规则：CJK 字符 ~1.5 字符/token，非 CJK ~4 字符/token。
主流 tokenizer（GPT-4/DeepSeek）对中文的实际比例约 1.5-1.8，取 1.5 保守估计。
"""

import logging

logger = logging.getLogger("lubia.token_estimator")


def estimate_tokens(text: str) -> int:
    """估算一段文本的 token 数"""
    if not text:
        return 0
    cjk = 0
    non_cjk = 0
    for ch in text:
        cp = ord(ch)
        # CJK Unified Ideographs + Extensions + Compatibility + Kana + Hangul
        if (0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or
            0x20000 <= cp <= 0x2A6DF or 0xF900 <= cp <= 0xFAFF or
            0x3040 <= cp <= 0x309F or 0x30A0 <= cp <= 0x30FF or
            0xAC00 <= cp <= 0xD7AF):
            cjk += 1
        else:
            non_cjk += 1
    return int(cjk / 1.5 + non_cjk / 4.0)


def estimate_messages_tokens(messages: list[dict]) -> int:
    """估算消息列表的总 token 数"""
    total = 0
    for msg in messages:
        content = msg.get("content", "") if isinstance(msg, dict) else ""
        total += estimate_tokens(content)
    return total
