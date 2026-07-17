"""知识库语义搜索工具 — 向量 KNN + JOIN 主表

供 Re-Act 循环中的 KnowledgeRagTool 使用。

策略：
1. 用 bge-small-zh-v1.5 对查询文本做 embedding
2. vec0 KNN 搜索 top 8 相似向量
3. JOIN 主表获取完整信息 + 过滤 is_visible
4. 返回格式化结果（与 knowledge_grep 风格一致）

与 knowledge_grep 的关系：
- knowledge_grep：关键词精确匹配（SQL LIKE + difflib 排序）
- knowledge_rag：语义相似搜索（向量 KNN）
- 建议 AI 先 grep → 无结果再 rag（降级链）
- 两个工具属于同一"kb"组，连续调用算重复（不重复弹泡/不计次）
"""

import logging
from ..database import get_db
from ..services.embedding_service import get_embedding_service

logger = logging.getLogger("lubia.knowledge_rag")


async def knowledge_rag(query: str, limit: int = 8) -> str:
    """在 knowledge_infos 中语义搜索

    Args:
        query: 自然语言查询文本（完整句子，不需要拆成关键词）
        limit: 返回结果数上限（默认 8，预 RAG 等场景用 3）

    Returns:
        格式化后的搜索结果文本（供 AI 阅读）
    """
    # ── 0. 检查 embedding 服务可用性 ──
    svc = get_embedding_service()
    if not svc.is_available:
        return (
            "语义搜索服务未启动。\n"
            f"原因：{svc.load_error or 'embedding 模型加载失败'}\n"
            "建议：请使用 knowledge_grep（关键词搜索）代替，或联系用户安装依赖。"
        )

    # ── 1. Embedding 查询文本 ──
    query_vec = svc.embed_content(query)
    if query_vec is None:
        return "语义搜索失败：无法对查询文本生成向量。请改用 knowledge_grep。"

    # ── 2. 序列化向量 ──
    try:
        from sqlite_vec import serialize_float32
        query_blob = serialize_float32(query_vec)
    except ImportError:
        return "语义搜索组件未安装（sqlite-vec）。请改用 knowledge_grep。"

    # ── 3. KNN 搜索 + JOIN 主表过滤 is_visible ──
    conn = get_db()
    try:
        # vec0 KNN 子查询不能引用辅助列（+info_id/+is_visible），
        # 内层只拿 rowid+distance → 外层 JOIN vec_knowledge 取 info_id → JOIN 主表过滤
        k_val = max(1, min(limit, 20))  # 夹紧 1~20
        rows = conn.execute(
            f"""SELECT v.distance, ki.id, ki.category, ki.content, ki.keywords
               FROM (
                 SELECT rowid, distance
                 FROM vec_knowledge
                 WHERE embedding MATCH ? AND k = {k_val}
               ) v
               INNER JOIN vec_knowledge v2 ON v.rowid = v2.rowid
               INNER JOIN knowledge_infos ki ON v2.info_id = ki.id AND ki.is_visible = 1""",
            (query_blob,),
        ).fetchall()

        if not rows:
            return (
                "知识库语义搜索也没有找到匹配信息。\n"
                "可能原因：知识库中确实没有相关内容，或者信息尚未导入。\n"
                "建议：换个完全不同的表述描述你要找的内容再试一次，如果仍无结果就诚实告诉用户。"
            )

        # ── 4. 格式化输出：只返回内容，不拼分类/关键词/相似度（省 token）──
        lines = [r["content"] for r in rows]
        return "\n".join(lines)
    except Exception as e:
        logger.error(f"RAG 搜索异常: {e}")
        return f"语义搜索出错: {str(e)}。请改用 knowledge_grep。"
    finally:
        conn.close()
