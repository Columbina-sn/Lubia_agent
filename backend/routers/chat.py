"""聊天 API — Re-Act 循环 + SSE 流式 + 排队消息注入

POST /api/chat/completions
  所有模式（ask/plan/agent）统一经过 Re-Act 循环：
  构建 System Prompt（Lubia 身份 + 工具列表）→ AI 返回 text 或 tool_call →
  执行工具 → 追加结果 → 继续循环 → 流式返回最终答案。

SSE 事件类型：
  {"type": "thinking"}                                — AI 正在思考
  {"type": "tool_start", "tool": "...", "args": {...}, "label": "..."}
  {"type": "tool_result", "tool": "...", "result": "...", "label": "..."}
  {"type": "tool_error", "tool": "...", "error": "..."}
  {"type": "delta", "content": "..."}                 — 文本增量
  {"type": "user_injected", "messages": [...]}        — 排队消息已注入
  {"type": "done"}                                     — 完成
"""

import json
import asyncio
import logging
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from ..database import get_db
from ..schemas.chat import ChatRequest
from ..services.orchestrator.ask import AskOrchestrator
from ..services.orchestrator.plan import PlanOrchestrator
from ..services.orchestrator.auto import AutoOrchestrator
from ..services.debug_logger import append_chat_log
from ..utils import fail

logger = logging.getLogger("lubia.chat")
router = APIRouter(prefix="/api/chat", tags=["chat"])

# 会话级排队消息注入队列（内存字典，进程重启时清空）
# key = session_id, value = [{content, timestamp}, ...]
_INJECT_QUEUES: dict[str, list[dict]] = {}


@router.post("/inject")
async def chat_inject(req: Request):
    """排队消息注入：在 ReAct 循环运行中插入用户消息"""
    try:
        body = await req.json()
    except Exception:
        return fail(message="请求体非 JSON", code=400)

    session_id = body.get("session_id", "")
    messages = body.get("messages", [])

    if not session_id:
        return fail(message="缺少 session_id", code=400)
    if not messages or not isinstance(messages, list):
        return fail(message="messages 为空或格式错误", code=400)

    if session_id not in _INJECT_QUEUES:
        _INJECT_QUEUES[session_id] = []

    for msg in messages:
        content = msg.get("content", "").strip()
        if content:
            _INJECT_QUEUES[session_id].append({"content": content, "timestamp": msg.get("timestamp", "")})

    logger.debug(f"注入消息 | session={session_id[:8]}… | 新增={len(messages)}条 | 队列总计={len(_INJECT_QUEUES[session_id])}条")
    return {"code": 200, "message": "ok", "data": {"injected": len(messages)}}


@router.post("/completions")
async def chat_completions(req: ChatRequest):
    """聊天接口 — 通过 Re-Act 循环处理所有对话模式

    系统提示词包含 Lubia 身份说明和三个工具（知识库检索/联网搜索/网页抓取）。
    AI 会自动判断是否需要调用工具，无需前端干预。
    """
    # 1. 验证供应商
    conn = get_db()
    try:
        provider = conn.execute(
            "SELECT * FROM providers WHERE id = ? AND is_enabled = 1",
            (req.provider_id,),
        ).fetchone()
    finally:
        conn.close()

    if not provider:
        return fail(message="供应商不存在或已停用", code=404)

    api_key = provider["api_key"] or ""
    if not api_key:
        return fail(message="请先在设置中填写 API Key", code=400)

    # 2. 构建消息历史
    messages = [m.model_dump() for m in req.messages]

    # 会话 ID：用于排队消息注入
    session_id = req.session_id or ""
    if session_id:
        _INJECT_QUEUES.setdefault(session_id, [])  # 初始化队列
        logger.debug(f"会话注册 | session={session_id[:8]}…")

    # 3. SSE 事件生成器
    abort_flag = False  # 用于检测客户端断开

    # ── 根据 mode 选择编排器 ──
    orchestrator = _get_orchestrator(req.mode)

    async def event_generator():
        nonlocal abort_flag

        # 事件队列：异步推送 SSE 事件
        event_queue = asyncio.Queue()
        done_sent = False

        async def stream_callback(event: dict):
            """Re-Act 循环通过此回调推送事件"""
            await event_queue.put(event)

        def abort_check():
            """检查是否应该中止"""
            return abort_flag

        # 启动编排器循环（在后台任务中运行）
        loop_task = asyncio.create_task(
            orchestrator.run(
                messages=messages,
                provider_config=dict(provider),
                model=req.model,
                stream_callback=stream_callback,
                abort_check=abort_check,
                sandbox_root=req.sandbox_root,
                session_id=session_id,
            )
        )

        try:
            # 从队列消费事件并流式发送
            while True:
                try:
                    # 超时获取事件（允许检测客户端断开）
                    event = await asyncio.wait_for(event_queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    # 检查循环是否已完成
                    if loop_task.done():
                        break
                    continue

                event_type = event.get("type", "")

                if event_type == "delta":
                    # 文本增量
                    content = event.get("content", "")
                    yield f"data: {json.dumps({'type': 'delta', 'content': content})}\n\n"

                elif event_type == "tool_start":
                    yield f"data: {json.dumps(event)}\n\n"

                elif event_type == "tool_result":
                    # 截断过长结果用于显示
                    result = event.get("result", "")
                    display_event = dict(event)
                    if len(result) > 500:
                        display_event["result"] = result[:500] + "…（结果已截断）"
                    yield f"data: {json.dumps(display_event)}\n\n"

                elif event_type == "tool_error":
                    yield f"data: {json.dumps(event)}\n\n"

                elif event_type == "thinking":
                    yield f"data: {json.dumps({'type': 'thinking'})}\n\n"

                elif event_type == "max_rounds":
                    yield f"data: {json.dumps(event)}\n\n"

                elif event_type == "user_injected":
                    yield f"data: {json.dumps(event)}\n\n"

                elif event_type == "done":
                    yield "data: [DONE]\n\n"
                    done_sent = True
                    break

            # 确保循环完成
            if not loop_task.done():
                try:
                    await asyncio.wait_for(loop_task, timeout=5.0)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass

            # 兜底 done 标记（仅在没发过的情况下）
            if not done_sent:
                yield "data: [DONE]\n\n"

        except asyncio.CancelledError:
            # 客户端断开连接
            abort_flag = True
            if not loop_task.done():
                loop_task.cancel()
        except Exception as exc:
            err_data = json.dumps({"type": "tool_error", "tool": "system", "error": f"系统异常：{str(exc)}"})
            yield f"data: {err_data}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            # 清理注入队列
            if session_id and session_id in _INJECT_QUEUES:
                del _INJECT_QUEUES[session_id]
                logger.debug(f"会话清理 | session={session_id[:8]}…")

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _get_orchestrator(mode: str):
    """根据 mode 返回对应的编排器实例"""
    if mode in ("agent", "auto"):
        return AutoOrchestrator()
    elif mode == "plan":
        return PlanOrchestrator()
    else:
        return AskOrchestrator()


@router.post("/debug-log")
async def chat_debug_log(req: Request):
    """前端 debug 日志持久化到 prompt.md"""
    try:
        body = await req.json()
        msg = (body or {}).get("message", "")
        if msg:
            append_chat_log("[chat] " + str(msg))
    except Exception:
        pass
    return {"code": 200, "message": "ok", "data": None}
