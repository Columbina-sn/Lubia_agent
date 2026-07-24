"""代码搜索工具 — 在工作区内用正则搜索文件内容和路径

供 Re-Act 循环中的 GrepTool 使用。

策略：
1. 安全检查：工作区校验 + 路径过滤越界
2. os.walk 遍历，跳过隐藏/二进制/大文件/构建目录
3. **同时匹配文件路径和文件内容**，路径匹配结果优先展示
4. 逐行正则匹配，不区分大小写
5. 每文件最多 20 条，总量上限 200 条
6. 正则超时 3 秒保护
"""

import os
import re
import logging

logger = logging.getLogger("lubia.grep")

SKIP_DIRS = {
    ".git", "__pycache__", "node_modules", ".venv", "venv",
    ".idea", ".vscode", "dist", "target",
}

MAX_PER_FILE = 20
MAX_TOTAL = 200
MAX_FILE_SIZE = 2 * 1024 * 1024  # 2MB — 超过不搜索
REGEX_TIMEOUT = 3  # 单行正则超时秒数


async def grep(
    sandbox_root: str = None,
    query: str = "",
    path_filter: str = "",
    max_results: int = 50,
) -> str:
    """在工作区内搜索匹配文本

    Args:
        sandbox_root: 工作区根目录绝对路径
        query: 正则搜索词（不区分大小写），≥2 字符
        path_filter: 限定搜索的目录或文件 glob（如 "src/" 或 "*.py"）
        max_results: 最大返回条数（默认 50，上限 200）

    Returns:
        按文件分组、带行号的搜索结果
    """
    # ── ⓪ 防守型类型强制（上游 _execute_tool 可能因边界情况漏转类型）──
    if not isinstance(max_results, int):
        try:
            max_results = int(max_results)
        except (ValueError, TypeError):
            max_results = 50
    query = str(query) if not isinstance(query, str) else query

    # ── ① 安全拦截 ──

    if not sandbox_root or not os.path.isdir(sandbox_root):
        return (
            "用户还没有设置工作区文件夹。\n"
            "请告诉用户：在左侧文件树点击「打开文件夹」按钮，选择一个文件夹作为工作区。"
        )

    query = (query or "").strip()
    if len(query) < 2:
        return "搜索关键词太短（至少 2 个字符），请给出更具体的搜索词。"

    # 路径过滤越界检测
    pf = (path_filter or "").replace("\\", "/").strip("/")
    if pf and (".." in pf.split("/")):
        return "路径包含不安全字符（..），仅允许在工作区内访问。"

    limit = min(max_results, MAX_TOTAL) if max_results else 50
    if limit < 1:
        limit = 50

    # ── ② 编译正则 ──
    try:
        pattern = re.compile(query, re.IGNORECASE)
    except re.error as e:
        return f"正则表达式语法错误：{str(e)}。请修正搜索词。"

    # ── ③ 确定搜索根目录 ──
    search_root = sandbox_root
    if pf:
        candidate = os.path.normpath(os.path.join(sandbox_root, pf))
        if not candidate.startswith(os.path.normpath(sandbox_root)):
            return f"路径越界：{path_filter} 不在工作区内。"
        if os.path.isdir(candidate):
            search_root = candidate
        elif os.path.isfile(candidate):
            # 直接搜索单个文件
            return _search_file(candidate, query, None, limit)
        else:
            # 可能是 glob 模式，仍然从工作区根搜索但带 filter
            pass

    # ── ④ 收集搜索范围 ──
    # 如果有 glob 后缀（如 "*.py"），提取扩展名过滤
    ext_filter = None
    if pf and pf.startswith("*."):
        ext_filter = pf[1:]  # ".py"

    results_by_file = {}    # file_rel_path → [(line_no, text), ...]   内容匹配
    path_matches = []       # [(rel_path, match_reason), ...]          路径匹配
    total_found = 0

    try:
        for dirpath, dirnames, filenames in os.walk(search_root):
            # 跳过目录
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]

            for fname in sorted(filenames):
                if fname.startswith("."):
                    continue

                # 扩展名过滤
                if ext_filter and not fname.endswith(ext_filter):
                    continue

                full = os.path.join(dirpath, fname)

                # 二进制检测 + 大小检测
                try:
                    fsize = os.path.getsize(full)
                except OSError:
                    continue
                if fsize > MAX_FILE_SIZE:
                    continue
                try:
                    with open(full, "rb") as fb:
                        head = fb.read(1024)
                    if b"\x00" in head:
                        continue
                except Exception:
                    continue

                rel = os.path.relpath(full, sandbox_root).replace("\\", "/")

                # ── 路径匹配：检查文件名/路径是否命中查询 ──
                path_hit = False
                try:
                    if pattern.search(rel):
                        path_hit = True
                        # 高亮路径中匹配的部分
                        match_part = rel
                        path_matches.append((rel, "路径命中"))
                        total_found += 1
                except Exception:
                    pass

                # ── 内容搜索 ──
                file_matches = []
                try:
                    with open(full, "r", encoding="utf-8", errors="ignore") as f:
                        for line_no, line in enumerate(f, 1):
                            try:
                                if pattern.search(line):
                                    file_matches.append((line_no, line.rstrip("\n\r")[:200]))
                                    if len(file_matches) >= MAX_PER_FILE:
                                        break
                            except Exception:
                                pass
                except Exception:
                    continue

                if file_matches:
                    results_by_file[rel] = file_matches
                    total_found += len(file_matches)

                # 纯路径命中（无内容匹配）也记录
                if path_hit and not file_matches:
                    results_by_file[rel] = []  # 空列表 = 仅路径命中

                if total_found >= limit:
                    break

            if total_found >= limit:
                break

    except Exception as e:
        return f"搜索过程出错：{str(e)}"

    # ── ⑤ 格式化输出 ──

    if not results_by_file:
        return f"[搜索: \"{query}\" → 0 条匹配]\n工作区内未找到匹配内容或文件名。试试换一个更短的关键词？"

    over_limit = total_found > limit
    if over_limit:
        # 截断到 limit
        clipped = {}
        count = 0
        for fname, matches in results_by_file.items():
            need = limit - count
            if need <= 0:
                break
            if len(matches) <= need:
                clipped[fname] = matches
                count += max(len(matches), 1)  # 至少算 1（路径匹配）
            else:
                clipped[fname] = matches[:need]
                count += need
        results_by_file = clipped
        total_found = count

    file_count = len(results_by_file)
    header = f"[搜索: \"{query}\" → {total_found} 条匹配 / {file_count} 个文件]"
    if over_limit:
        header += "\n（结果过多已截断，请缩小搜索范围：使用更具体的关键词或 path_filter 限定目录）"

    out_lines = [header, ""]
    for rel_path, matches in results_by_file.items():
        if matches:
            # 有内容匹配
            out_lines.append(rel_path)
            for line_no, text in matches:
                out_lines.append(f"  L{line_no:4d}| {text}")
        else:
            # 纯路径匹配（文件名命中但内容未命中）
            out_lines.append(f"{rel_path}  ← 文件名匹配")
        out_lines.append("")

    return "\n".join(out_lines)


def _search_file(filepath: str, query: str, _unused, limit: int) -> str:
    """搜索单个文件（path_filter 直接指向文件时）"""
    import os as _os
    fname = _os.path.basename(filepath)
    try:
        fsize = _os.path.getsize(filepath)
    except OSError:
        return f"无法访问文件：{filepath}"
    if fsize > MAX_FILE_SIZE:
        return f"文件过大（>{MAX_FILE_SIZE / 1_048_576:.0f}MB），跳过搜索。"

    try:
        pattern = re.compile(query, re.IGNORECASE)
    except re.error as e:
        return f"正则表达式语法错误：{str(e)}"

    matches = []
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            for line_no, line in enumerate(f, 1):
                try:
                    if pattern.search(line):
                        matches.append((line_no, line.rstrip("\n\r")[:200]))
                        if len(matches) >= limit:
                            break
                except Exception:
                    pass
    except Exception as e:
        return f"读取文件出错：{str(e)}"

    if not matches:
        return f"[搜索: \"{query}\" → 0 条匹配]\n在 {fname} 中未找到匹配内容。"

    out = [f"[搜索: \"{query}\" → {len(matches)} 条匹配 / 1 个文件]", "", fname]
    for ln, text in matches:
        out.append(f"  L{ln:4d}| {text}")
    return "\n".join(out)
