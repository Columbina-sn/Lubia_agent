"""Lubia 后端入口

启动方式（从项目根目录）:
    uvicorn backend.main:app --reload --port 19800

全局异常处理 + 统一响应格式 + 健康检查端点。
业务路由：providers / chat / config / vendors
"""
import logging
import sys
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
import uvicorn

from .config import HOST, PORT, DEBUG
from .schemas.response import ApiResponse
from .database import init_db, diagnose_vector_db
from .routers import providers, chat, config_router, vendors, knowledge, usage
from .utils import ok, fail

# ── prompt.md 日志路径 ──
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROMPT_LOG_PATH = _PROJECT_ROOT / "prompt.md"

# ═══════════════════════════════════════════
# 日志配置
# ═══════════════════════════════════════════

LOG_FORMAT = "%(asctime)s [%(levelname).1s] %(name)s | %(message)s"
LOG_DATE = "%H:%M:%S"

# 根 logger：INFO 以上全输出
logging.basicConfig(
    level=logging.INFO,
    format=LOG_FORMAT,
    datefmt=LOG_DATE,
    stream=sys.stdout,
)

# lubia 命名空间：DEBUG（开发阶段看工具调用详情）
logging.getLogger("lubia").setLevel(logging.DEBUG)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("sentence_transformers").setLevel(logging.WARNING)
logging.getLogger("huggingface_hub").setLevel(logging.WARNING)

logger = logging.getLogger("lubia.main")

# ═══════════════════════════════════════════
# App 初始化
# ═══════════════════════════════════════════


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时初始化数据库，关闭时清理资源"""
    init_db()
    # 启动诊断：检查向量系统状态
    _startup_diagnose()
    # 清空 prompt.md 日志文件
    _clear_prompt_log()
    yield


app = FastAPI(
    title="Lubia Backend",
    version="0.2.0",
    description="Lubia 桌面 AI 助手后端服务 —— 运行在 127.0.0.1，不对外暴露",
    lifespan=lifespan,
)


def _startup_diagnose():
    """启动时打印一行向量系统状态"""
    try:
        diag = diagnose_vector_db()
        if not diag.get("vec_loaded"):
            logger.warning("sqlite-vec 未安装，向量搜索不可用")
            return
        info_n = diag.get("info_count", 0)
        vec_n = diag.get("vec_count", 0)
        dt = diag.get("orphan_count", 0)
        status = f"主表 {info_n} 条, 向量 {vec_n} 条"
        if dt > 0:
            status += f"（⚠ {dt} 条缺少向量，运行 rebuild_vectors.py 修复）"
        logger.info(f"向量系统就绪: {status}")
    except Exception:
        pass


def _clear_prompt_log():
    """每次软件启动时清空 prompt.md"""
    try:
        PROMPT_LOG_PATH.write_text("", encoding="utf-8")
        logger.info(f"prompt.md 已清空")
    except Exception:
        pass

# CORS：允许前端跨域访问
# 开发时 Vite dev server 在 localhost:1420
# Tauri 生产环境 WebView 使用 tauri://localhost
# 桌面应用只监听 127.0.0.1，allow_origins=["*"] 是安全的
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ═══════════════════════════════════════════
# 响应工具函数
# ═══════════════════════════════════════════

def ok(data=None, message="ok", status_code=200):
    """成功响应 — 返回 { code:0, message, data }"""
    return JSONResponse(
        content={"code": 200, "message": message, "data": data},
        status_code=status_code,
    )


def fail(message, code=400, status_code=None):
    """失败响应 — 返回 { code, message, data:null }"""
    return JSONResponse(
        content={"code": code, "message": message, "data": None},
        status_code=status_code or code,
    )


# ═══════════════════════════════════════════
# 全局异常处理
# ═══════════════════════════════════════════

@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """HTTP 层面异常（404 Not Found 等）→ 包装成统一响应格式"""
    return fail(message=exc.detail, code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """请求参数校验失败（Pydantic 验证不通过）→ 友好中文提示"""
    errors = exc.errors()
    if errors:
        first = errors[0]
        # 提取字段名和错误信息，拼成人类可读的提示
        field = first.get("loc", ["unknown"])[-1]
        msg = first.get("msg", "参数校验失败")
        message = f"请求参数错误：{field} —— {msg}"
    else:
        message = "请求参数校验失败"
    return fail(message=message, code=422)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """兜底：未预期的内部错误 → 打印完整 traceback，返回 500"""
    import traceback
    traceback.print_exc()
    # DEBUG 模式下返回具体错误信息，方便调试
    detail = str(exc) if DEBUG else "服务器内部错误，请查看后端日志"
    return fail(message=f"服务器内部错误：{detail}", code=500)


# ═══════════════════════════════════════════
# 注册业务路由
# ═══════════════════════════════════════════

app.include_router(providers.router)
app.include_router(chat.router)
app.include_router(config_router.router)
app.include_router(vendors.router)
app.include_router(knowledge.router)
app.include_router(usage.router)

# ═══════════════════════════════════════════
# 路由
# ═══════════════════════════════════════════

@app.get("/health")
async def health():
    """健康检查 —— Tauri 用此接口判断后端是否就绪"""
    diag = diagnose_vector_db()
    return ok(data={
        "status": "ok",
        "version": "0.2.0",
        "vec_loaded": diag.get("vec_loaded", False),
        "vec0_exists": diag.get("vec0_exists", False),
        "info_count": diag.get("info_count", 0),
        "vec_count": diag.get("vec_count", 0),
        "orphan_count": diag.get("orphan_count", 0),
    })


# ═══════════════════════════════════════════
# 启动入口
# ═══════════════════════════════════════════

if __name__ == "__main__":
    # 直接从 backend/ 目录运行：python main.py
    # 此时相对导入会失败，需要切换到绝对导入
    uvicorn.run(
        "backend.main:app",
        host=HOST,
        port=PORT,
        reload=DEBUG,
        log_level="info",
    )
