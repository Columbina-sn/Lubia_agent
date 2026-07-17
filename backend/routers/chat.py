"""聊天 API — Re-Act 循环 + SSE 流式

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
  {"type": "done"}                                     — 完成
"""

import json
import asyncio
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from ..database import get_db
from ..schemas.chat import ChatRequest
from ..services.react_loop import run_react_loop
from ..utils import fail

router = APIRouter(prefix="/api/chat", tags=["chat"])


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

    # 3. SSE 事件生成器
    abort_flag = False  # 用于检测客户端断开

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

        # 启动 Re-Act 循环（在后台任务中运行）
        loop_task = asyncio.create_task(
            run_react_loop(
                messages=messages,
                provider_id=req.provider_id,
                model=req.model,
                stream_callback=stream_callback,
                abort_check=abort_check,
                sandbox_root=req.sandbox_root,
                mode=req.mode,
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

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
