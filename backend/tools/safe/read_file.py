"""文件内容读取工具 — 安全读取工作区文本文件

供 Re-Act 循环中的 ReadFileTool 使用。

防护层级：
1. 工作区校验 → 未设置则拒绝
2. 路径穿越检测 → 含 .. 或以 / 开头则拒绝
3. 路径越界检测 → normpath 后不在工作区内则拒绝
4. 文件类型校验 → 目录/二进制则拒绝
5. 大文件分片 → 头尾截断，不读全量
6. 编码降级 → utf-8 → gbk → latin-1
"""

import os

MAX_LINES = 500
HEAD_LINES = 200
TAIL_LINES = 200
LARGE_FILE_SIZE = 1 * 1024 * 1024    # 1MB — 强制走头尾截断
SEEK_TAIL_SIZE = 64 * 1024            # 64KB — 超大文件从末尾回读此大小来取尾行
HARD_CAP_BYTES = 50 * 1024 * 1024    # 50MB — 硬上限（拒绝，防止磁盘IO拖死）


async def read_file(
    sandbox_root: str = None,
    path: str = "",
    start_line: int = 0,
    end_line: int = 0,
) -> str:
    """安全读取工作区内的文本文件（带行号）

    Args:
        sandbox_root: 工作区根目录绝对路径
        path: 相对于工作区的文件路径
        start_line: 起始行号（1-based，0=从头开始）
        end_line: 结束行号（1-based，含该行，0=到末尾）

    Returns:
        带行号的文本内容，大文件自动头尾截断
    """
    # ═══════════════════════════════════════
    # ⓪ 防守型类型强制（上游 _execute_tool 可能因边界情况漏转类型）
    # ═══════════════════════════════════════
    if not isinstance(start_line, int):
        try:
            start_line = int(start_line)
        except (ValueError, TypeError):
            start_line = 0
    if not isinstance(end_line, int):
        try:
            end_line = int(end_line)
        except (ValueError, TypeError):
            end_line = 0

    # ═══════════════════════════════════════
    # ① 安全拦截层
    # ═══════════════════════════════════════

    if not sandbox_root or not os.path.isdir(sandbox_root):
        return (
            "用户还没有设置工作区文件夹。\n"
            "请告诉用户：在左侧文件树点击「打开文件夹」按钮，选择一个文件夹作为工作区。"
        )

    p = (path or "").replace("\\", "/").strip("/")
    if not p:
        return "请指定要读取的文件路径。先用 list_files 浏览目录找到目标文件。"

    # 路径穿越检测
    if ".." in p.split("/"):
        return "路径包含不安全字符（..），仅允许在工作区内访问。"

    target = os.path.join(sandbox_root, p)
    target = os.path.normpath(target)

    # 越界检测
    root_norm = os.path.normpath(sandbox_root)
    if not target.startswith(root_norm + os.sep) and target != root_norm:
        return f"路径越界：{path} 不在工作区内。"

    if not os.path.exists(target):
        return f"文件不存在：{path}"

    if os.path.isdir(target):
        return f"这是一个目录，请用 list_files 浏览：{path}"

    # 文件大小预检
    try:
        file_size = os.path.getsize(target)
    except OSError as e:
        return f"无法获取文件信息：{str(e)}"

    if file_size > HARD_CAP_BYTES:
        size_mb = file_size / (1024 * 1024)
        return (
            f"文件过大（{size_mb:.1f} MB），超过 50MB 读取上限。\n"
            "请在编辑器中打开此文件查看。"
        )

    # 二进制检测
    try:
        with open(target, "rb") as fb:
            head = fb.read(1024)
        if b"\x00" in head:
            return f"文件看起来是二进制格式，无法以文本方式读取：{path}"
    except Exception as e:
        return f"读取文件时出错：{str(e)}"

    # ═══════════════════════════════════════
    # ② 编码探测
    # ═══════════════════════════════════════
    encoding_used = "utf-8"
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            with open(target, "r", encoding=enc) as f:
                f.read(1)  # 只读一个字符测试编码
            encoding_used = enc
            break
        except (UnicodeDecodeError, Exception):
            continue
    else:
        return f"无法识别文件编码，可能不是文本文件：{path}"

    # ═══════════════════════════════════════
    # ③ 行范围 / 截断逻辑
    # ═══════════════════════════════════════
    rel_path = p
    has_range = start_line > 0 or end_line > 0

    # 先读取全部行来获取总行数（小文件直接读，大文件只数行）
    if file_size < LARGE_FILE_SIZE:
        # 小文件：直接读全部
        try:
            with open(target, "r", encoding=encoding_used) as f:
                lines = f.read().split("\n")
        except Exception as e:
            return f"读取文件时出错：{str(e)}"
        total_lines = len(lines)
        return _render_from_lines(lines, total_lines, rel_path, file_size,
                                  encoding_used, start_line, end_line, has_range)
    else:
        # 大文件：不全部读入内存，用头尾分片策略
        return _render_large_file(target, encoding_used, rel_path, file_size,
                                  start_line, end_line, has_range)


# ═══════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════


def _render_from_lines(lines: list, total_lines: int, rel_path: str,
                       file_size: int, encoding_used: str,
                       start_line: int, end_line: int, has_range: bool) -> str:
    """从小文件的全量行数组渲染输出"""
    if has_range:
        return _render_range(lines, total_lines, rel_path, file_size,
                            encoding_used, start_line, end_line)

    if total_lines <= MAX_LINES:
        # 小文件全量
        head = _file_header(rel_path, total_lines, file_size, encoding_used)
        return head + _format_lines(lines, 1)

    # 中等文件：头尾截断
    return _render_head_tail(lines, total_lines, rel_path, file_size, encoding_used)


def _render_large_file(target: str, encoding: str, rel_path: str,
                       file_size: int, start_line: int, end_line: int,
                       has_range: bool) -> str:
    """处理大文件（>1MB）：不全部加载到内存"""

    # ── 数总行数（快速扫行，不存内容）──
    total_lines = 0
    try:
        with open(target, "r", encoding=encoding, errors="ignore") as f:
            for _ in f:
                total_lines += 1
    except Exception as e:
        return f"读取文件时出错：{str(e)}"

    if total_lines == 0:
        return _file_header(rel_path, 0, file_size, encoding) + "\n（空文件）"

    # ── 用户指定了行范围 → 只读那个范围 ──
    if has_range:
        s = max(1, start_line)
        e = min(total_lines, end_line) if end_line > 0 else total_lines
        if s > total_lines:
            return f"起始行 {s} 超出文件总行数 {total_lines}。"
        if s > e:
            return f"起始行 {s} 大于结束行 {e}。"
        if e - s + 1 > MAX_LINES:
            e = s + MAX_LINES - 1
        selected = _read_line_range(target, encoding, s, e)
        head = _file_header(rel_path, total_lines, file_size, encoding)
        return head + f"行 {s}-{e}/{total_lines}\n" + _format_lines(selected, s)

    # ── 自动截断：读头 HEAD_LINES 行 ──
    head_lines = _read_line_range(target, encoding, 1, HEAD_LINES)
    actual_head = len(head_lines)

    # ── 读尾 TAIL_LINES 行（从文件末尾反向读）──
    tail_start = max(1, total_lines - TAIL_LINES + 1)
    tail_lines = _read_line_range(target, encoding, tail_start, total_lines)
    actual_tail = len(tail_lines)

    skipped = total_lines - actual_head - actual_tail

    result = _file_header(rel_path, total_lines, file_size, encoding)
    result += _format_lines(head_lines, 1)

    if skipped > 0:
        omitted_start = HEAD_LINES + 1
        omitted_end = tail_start - 1
        result += (
            f"\n…（省略第 {omitted_start}–{omitted_end} 行，共 {skipped} 行）\n"
            f"▶ 如需读取中段，调用 read_file(path=\"{rel_path}\", "
            f"start_line={omitted_start}, end_line={omitted_end})\n"
        )
        result += _format_lines(tail_lines, tail_start)

    return result


def _render_range(lines: list, total_lines: int, rel_path: str,
                  file_size: int, encoding: str,
                  start_line: int, end_line: int) -> str:
    """渲染指定行范围"""
    s = max(1, start_line)
    e = min(total_lines, end_line) if end_line > 0 else total_lines
    if s > total_lines:
        return f"起始行 {s} 超出文件总行数 {total_lines}。"
    if s > e:
        return f"起始行 {s} 大于结束行 {e}。"
    if e - s + 1 > MAX_LINES:
        e = s + MAX_LINES - 1
    selected = lines[s - 1 : e]
    head = _file_header(rel_path, total_lines, file_size, encoding)
    return head + f"行 {s}-{e}/{total_lines}\n" + _format_lines(selected, s)


def _render_head_tail(lines: list, total_lines: int, rel_path: str,
                      file_size: int, encoding: str) -> str:
    """头尾截断渲染"""
    head_lines = lines[:HEAD_LINES]
    tail_lines = lines[-TAIL_LINES:] if total_lines > HEAD_LINES else []
    skipped = total_lines - len(head_lines) - len(tail_lines)
    tail_start = total_lines - len(tail_lines) + 1 if tail_lines else 0

    result = _file_header(rel_path, total_lines, file_size, encoding)
    result += _format_lines(head_lines, 1)

    if skipped > 0:
        omitted_start = HEAD_LINES + 1
        omitted_end = tail_start - 1
        result += (
            f"\n…（省略第 {omitted_start}–{omitted_end} 行，共 {skipped} 行）\n"
            f"▶ 如需读取中段，调用 read_file(path=\"{rel_path}\", "
            f"start_line={omitted_start}, end_line={omitted_end})\n"
        )
        result += _format_lines(tail_lines, tail_start)

    return result


def _read_line_range(filepath: str, encoding: str, start: int, end: int) -> list:
    """从文件中读取指定行范围（行号 1-based，含两端），不加载全文件"""
    lines = []
    try:
        with open(filepath, "r", encoding=encoding, errors="ignore") as f:
            for line_no, line in enumerate(f, 1):
                if line_no > end:
                    break
                if line_no >= start:
                    lines.append(line.rstrip("\n\r"))
    except Exception:
        pass
    return lines


def _format_lines(lines: list, start: int) -> str:
    """注入行号"""
    width = max(4, len(str(start + len(lines))))
    out = []
    for i, line in enumerate(lines, start=start):
        out.append(f"L{i:{width}d}| {line}")
    return "\n".join(out)


def _file_header(rel_path: str, total_lines: int, file_size: int,
                 encoding: str = "utf-8") -> str:
    head = f"[文件: {rel_path} | {total_lines} 行 | {_size_str(file_size)}]"
    if encoding != "utf-8":
        head += f" | 编码: {encoding}"
    return head + "\n"


def _size_str(size: int) -> str:
    if size >= 1_048_576:
        return f"{size / 1_048_576:.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size} B"
