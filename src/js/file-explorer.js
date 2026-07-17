/* ============================================================
   file-explorer.js —— 文件树浏览器 v3
   打开文件夹 · 真实文件系统 · 懒加载子目录 · 工作区根目录
   ============================================================ */

const FileExplorer = (() => {
  let containerEl = null;
  let treeEl = null;
  let searchInput = null;
  let rootPath = null;
  let treeData = null;        // { name, path, isDir, children }
  let searchQuery = '';
  let loadedDirs = new Set(); // 已展开/加载过的目录路径（懒加载用）

  // 文件图标映射
  const FILE_ICONS = {
    js:   { icon: 'JS',   cls: 'file-js' },
    ts:   { icon: 'TS',   cls: 'file-js' },
    jsx:  { icon: 'JSX',  cls: 'file-js' },
    tsx:  { icon: 'TSX',  cls: 'file-js' },
    py:   { icon: 'PY',   cls: 'file-py' },
    html: { icon: '⬡',   cls: 'file-html' },
    css:  { icon: '#',    cls: 'file-css' },
    scss: { icon: '#',    cls: 'file-css' },
    less: { icon: '#',    cls: 'file-css' },
    json: { icon: '{}',   cls: 'file-json' },
    md:   { icon: 'MD',   cls: 'file-md' },
    txt:  { icon: '¶',    cls: 'file-default' },
    svg:  { icon: '◉',    cls: 'file-img' },
    png:  { icon: '▦',    cls: 'file-img' },
    jpg:  { icon: '▦',    cls: 'file-img' },
    jpeg: { icon: '▦',    cls: 'file-img' },
    gif:  { icon: '▦',    cls: 'file-img' },
    ico:  { icon: '▦',    cls: 'file-img' },
    xml:  { icon: '⬡',   cls: 'file-html' },
    yaml: { icon: '{}',   cls: 'file-json' },
    yml:  { icon: '{}',   cls: 'file-json' },
    toml: { icon: '{}',   cls: 'file-json' },
    rs:   { icon: 'RS',   cls: 'file-js' },
    go:   { icon: 'GO',   cls: 'file-js' },
    java: { icon: 'JV',   cls: 'file-js' },
    c:    { icon: 'C',    cls: 'file-js' },
    cpp:  { icon: 'C++',  cls: 'file-js' },
    h:    { icon: 'H',    cls: 'file-js' },
    hpp:  { icon: 'H',    cls: 'file-js' },
    vue:  { icon: '⬡',   cls: 'file-html' },
    sql:  { icon: 'DB',   cls: 'file-json' },
    sh:   { icon: '>_',   cls: 'file-json' },
    bat:  { icon: '>_',   cls: 'file-json' },
    ps1:  { icon: '>_',   cls: 'file-json' },
    lock: { icon: '{}',   cls: 'file-json' },
  };

  const TEXT_EXTS = new Set([
    'txt','md','py','js','ts','jsx','tsx','html','css','scss','less',
    'json','xml','yaml','yml','toml','ini','cfg','sh','bash','zsh',
    'c','cpp','h','hpp','java','go','rs','rb','php','swift','kt',
    'r','m','sql','vue','svelte','astro','tex','csv','log','svg',
    'gitignore','env','dockerfile','makefile','cmake','bat','ps1',
    'conf','config','editorconfig','eslintrc','prettierrc',
  ]);

  function init(el) {
    containerEl = el;
    treeEl = containerEl.querySelector('.explorer-tree');
    searchInput = containerEl.querySelector('.explorer-search input');

    // 打开文件夹按钮
    containerEl.querySelector('[data-action="open-folder"]')
      ?.addEventListener('click', openFolder);

    // 搜索
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        renderTree();
      });
    }

    // 空状态按钮
    containerEl.querySelector('[data-action="open-folder-empty"]')
      ?.addEventListener('click', openFolder);

    // 文件树空白区域右键 → 隐藏文件树
    if (treeEl) {
      treeEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.tree-node')) return; // 点到文件/文件夹不管
        e.preventDefault();
        showBackgroundContextMenu(e.clientX, e.clientY);
      });
    }
  }

  async function openFolder() {
    if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
      const result = await Bridge.openFolderDialog();
      if (result) {
        rootPath = typeof result === 'string' ? result : result.path || result;
        window.__lubia_workspace_root = rootPath;
        loadedDirs = new Set();
        // 安全检查：首次打开的文件夹需用户确认信任
        const trusted = await _checkFolderTrust(rootPath);
        if (!trusted) {
          // 用户选择退出：清空工作区状态
          rootPath = null;
          window.__lubia_workspace_root = null;
          treeData = null;
          renderTree();
          return;
        }
        await loadDirectory(rootPath);
      }
    } else {
      showToast('请使用 Lubia 桌面版打开文件夹', 'warning');
    }
  }

  async function loadDirectory(dirPath) {
    try {
      treeEl.innerHTML = '<div class="explorer-loading"><div class="spinner"></div><p>加载中…</p></div>';

      // 第一层：加载根目录内容
      const entries = await Bridge.listDir(dirPath);
      // 只加载第一层子节点，更深层的目录标记为懒加载
      const children = entries.map(e => {
        const ext = e.name.split('.').pop()?.toLowerCase();
        return {
          name: e.name,
          path: e.path,
          isDir: e.isDir,
          ext: ext,
          children: e.isDir ? [] : undefined,
          lazy: e.isDir,  // 目录默认懒加载
        };
      });

      treeData = {
        name: dirPath.split(/[/\\]/).pop() || dirPath,
        path: dirPath,
        isDir: true,
        children: children,
      };

      renderTree();
    } catch (err) {
      console.error('读取目录失败:', err);
      treeData = null;
      treeEl.innerHTML = `
        <div class="explorer-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <p>无法读取目录</p>
          <p style="font-size:0.75rem;color:var(--text-tip);">${esc(err.message)}</p>
          <button class="btn btn-ghost btn-sm" data-action="open-folder-empty">重新选择</button>
        </div>`;
      treeEl.querySelector('[data-action="open-folder-empty"]')
        ?.addEventListener('click', openFolder);
    }
  }

  /** 懒加载：展开目录时才加载其子节点 */
  async function lazyLoadChildren(node) {
    if (!node.isDir || node.lazy === false) return;
    if (loadedDirs.has(node.path)) return; // 已加载过

    try {
      const entries = await Bridge.listDir(node.path);
      node.children = entries.map(e => {
        const ext = e.name.split('.').pop()?.toLowerCase();
        return {
          name: e.name,
          path: e.path,
          isDir: e.isDir,
          ext: ext,
          children: e.isDir ? [] : undefined,
          lazy: e.isDir,
        };
      });
      node.lazy = false;
      loadedDirs.add(node.path);
    } catch (_) {
      // 无权限读取的目录：保持空 children
      node.lazy = false;
      node.children = [];
      loadedDirs.add(node.path);
    }
  }

  // ===== 渲染 =====
  function renderTree() {
    if (!treeEl) return;

    if (!treeData) {
      treeEl.innerHTML = `
        <div class="explorer-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <p>尚未打开文件夹</p>
          <button class="btn btn-ghost btn-sm" data-action="open-folder-empty">打开文件夹</button>
        </div>`;
      treeEl.querySelector('[data-action="open-folder-empty"]')
        ?.addEventListener('click', openFolder);
      return;
    }

    // 保留展开状态（记录当前展开的目录路径）
    const expandedPaths = new Set();
    treeEl.querySelectorAll('.tree-children:not(.collapsed)').forEach(c => {
      const row = c.previousElementSibling;
      const pathEl = row?.querySelector?.('.tree-node-path');
      if (pathEl) expandedPaths.add(pathEl.dataset.path);
    });

    treeEl.innerHTML = '';
    renderNode(treeData, treeEl, 0, expandedPaths);

    // 展开第一层（默认打开根目录的第一层）
    treeEl.querySelectorAll(':scope > .tree-node + .tree-children').forEach(c => {
      c.classList.remove('collapsed');
    });
    treeEl.querySelectorAll(':scope > .tree-node .tree-node-arrow').forEach(a => {
      a.classList.add('expanded');
    });
  }

  function renderNode(node, parent, depth, expandedPaths) {
    const matchesSearch = !searchQuery || node.name.toLowerCase().includes(searchQuery);

    // 搜索模式下：只显示匹配项（包括其父路径在渲染时自然展开）
    if (searchQuery && !matchesSearch && node.isDir) {
      // 目录不匹配但子节点可能匹配 → 仍渲染目录但折叠
      if (!node.children || node.children.length === 0) return;
    }
    if (searchQuery && !matchesSearch && !node.isDir) return;

    if (node.isDir) {
      const wasExpanded = expandedPaths.has(node.path);

      const row = document.createElement('div');
      row.className = 'tree-node';
      row.style.setProperty('--depth', depth);
      row.innerHTML = `
        <span class="tree-node-arrow ${wasExpanded ? 'expanded' : ''}">▶</span>
        <span class="tree-node-icon folder"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>
        <span class="tree-node-name">${esc(node.name)}</span>`;
      parent.appendChild(row);

      const childrenContainer = document.createElement('div');
      childrenContainer.className = `tree-children${wasExpanded ? '' : ' collapsed'}`;
      parent.appendChild(childrenContainer);

      // 展开/折叠 + 懒加载
      row.querySelector('.tree-node-arrow').addEventListener('click', async (e) => {
        e.stopPropagation();
        await _toggleDir(row, childrenContainer, node);
      });
      row.addEventListener('click', async () => {
        await _toggleDir(row, childrenContainer, node);
      });

      // 渲染子节点（可能为空但已标记 lazy）
      if (node.children && node.children.length > 0) {
        node.children.forEach(child => renderNode(child, childrenContainer, depth + 1, expandedPaths));
      } else if (node.lazy && wasExpanded) {
        // 之前展开过但未加载 → 触发懒加载
        lazyLoadChildren(node).then(() => {
          childrenContainer.innerHTML = '';
          if (node.children) {
            node.children.forEach(child => renderNode(child, childrenContainer, depth + 1, expandedPaths));
          }
        });
      }
    } else {
      // 文件节点
      const ext = node.ext || node.name.split('.').pop()?.toLowerCase();
      const iconInfo = FILE_ICONS[ext] || { cls: 'file-default' };

      const row = document.createElement('div');
      row.className = 'tree-node';
      row.style.setProperty('--depth', depth);
      row.innerHTML = `
        <span class="tree-node-arrow" style="visibility:hidden">▶</span>
        <span class="tree-node-icon ${iconInfo.cls}">${iconInfo.icon || ''}</span>
        <span class="tree-node-name">${esc(node.name)}</span>`;
      parent.appendChild(row);

      row.addEventListener('click', () => openFile(node));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        showFileContextMenu(e.clientX, e.clientY, node);
      });
    }
  }

  async function _toggleDir(row, childrenContainer, node) {
    const arrow = row.querySelector('.tree-node-arrow');
    const isExpanding = childrenContainer.classList.contains('collapsed');

    if (isExpanding && node.lazy) {
      // 懒加载子节点
      await lazyLoadChildren(node);
      if (node.children && node.children.length > 0) {
        childrenContainer.innerHTML = '';
        node.children.forEach(child => renderNode(child, childrenContainer, parseInt(row.style.getPropertyValue('--depth')) + 1, new Set()));
      }
    }

    arrow.classList.toggle('expanded');
    childrenContainer.classList.toggle('collapsed');
  }

  function openFile(node) {
    const ext = node.ext || node.name.split('.').pop()?.toLowerCase();

    if (TEXT_EXTS.has(ext) || ext === 'svg') {
      App.showPage('editor');
      setTimeout(() => {
        if (typeof Editor !== 'undefined' && Editor.openFile) {
          Editor.openFile(node.path, node.name);
        }
      }, 150);
    } else {
      App.showPage('editor');
      setTimeout(() => {
        if (typeof Editor !== 'undefined' && Editor.openBinary) {
          Editor.openBinary(node.name, ext);
        }
      }, 150);
    }
  }

  function showFileContextMenu(x, y, node) {
    const ext = node.ext || node.name.split('.').pop()?.toLowerCase();
    const isText = TEXT_EXTS.has(ext) || ext === 'svg';
    const isHTML = ext === 'html' || ext === 'htm';
    const isMD = ext === 'md';

    const items = [];
    if (isText) {
      items.push({ label: '打开文件', action: () => openFile(node) });
      items.push({ label: '在侧边打开', action: () => openFileInSide(node) });
    }
    if (isHTML) items.push({ label: '渲染预览', action: () => openWithPreview(node) });
    if (isMD) items.push({ label: '以预览打开', action: () => openWithPreview(node) });
    if (!isText && !isHTML && !isMD) items.push({ label: '打开文件', action: () => openFile(node) });

    App.showContextMenu(x, y, items);
  }

  function showBackgroundContextMenu(x, y) {
    App.showContextMenu(x, y, [
      { label: '隐藏文件树', shortcut: 'Ctrl+B', action: () => App.toggleFileExplorer() }
    ]);
  }

  function openFileInSide(node) {
    const ext = node.ext || node.name.split('.').pop()?.toLowerCase();
    App.showPage('editor');
    setTimeout(() => {
      if (typeof Editor !== 'undefined' && Editor.openFileInSide) {
        Editor.openFileInSide(node.path, node.name);
      }
    }, 150);
  }

  function openWithPreview(node) {
    const ext = node.ext || node.name.split('.').pop()?.toLowerCase();
    App.showPage('editor');
    setTimeout(() => {
      if (typeof Editor !== 'undefined' && Editor.openFile) {
        Editor.openFile(node.path, node.name, Editor.getActivePanel ? Editor.getActivePanel() : 0);
        // 延迟切换到预览模式
        setTimeout(() => {
          if (Editor.togglePreview) Editor.togglePreview();
        }, 300);
      }
    }, 150);
  }

  function openInBrowser(node) {
    if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
      Bridge.openExternal(node.path);
    } else {
      showToast('请使用 Lubia 桌面版在浏览器中打开文件', 'warning');
    }
  }

  function esc(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function showToast(msg, type) {
    if (typeof App !== 'undefined' && App.showToast) {
      App.showToast(msg, type || 'info');
    }
  }

  // ── 文件夹信任检查 ──

  /** 读取已信任的文件夹列表（路径标准化后存储） */
  function _getTrustedFolders() {
    try {
      return JSON.parse(localStorage.getItem('lubia_trusted_folders') || '[]');
    } catch (_) { return []; }
  }

  /** 标准化路径用于比较（统一分隔符 + 小写，Windows 不区分大小写） */
  function _normPath(p) { return (p || '').replace(/\\/g, '/').toLowerCase(); }

  /** 检查文件夹是否受信，不受信则弹安全确认窗。返回 true=可继续，false=用户退出 */
  function _checkFolderTrust(folderPath) {
    return new Promise((resolve) => {
      const trusted = _getTrustedFolders();
      const np = _normPath(folderPath);
      // 已在受信列表中（或父目录已受信），直接通过
      if (trusted.some(t => np.startsWith(_normPath(t)) || _normPath(t).startsWith(np))) {
        resolve(true); return;
      }

      // 显示安全确认弹窗
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const folderName = folderPath.split(/[/\\]/).pop() || folderPath;
      overlay.innerHTML = `
        <div class="modal-dialog" style="max-width:460px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <span style="font-size:1.4rem;">&#9888;</span>
            <h3 style="margin:0;">安全检查</h3>
          </div>
          <div style="font-size:0.82rem;color:var(--text-sub);line-height:1.7;">
            <p style="margin:0 0 10px;">快速安全检查：这是你自己创建的项目，还是你信任的项目？<br>（例如你自己的代码、知名的开源项目或团队的工作成果）。如果不是，请先花点时间查看此文件夹中的内容。</p>
            <p style="margin:0 0 6px;word-break:break-all;color:var(--text-body);background:var(--bg-input);padding:4px 8px;border-radius:4px;font-family:monospace;font-size:0.78rem;">${folderPath}</p>
            <p style="margin:0 0 10px;font-size:0.78rem;">Lubia 将能够在此处读取、编辑和执行文件。</p>
            <p style="margin:0;"><a href="javascript:void(0)" style="color:var(--info);text-decoration:underline;">安全指南</a>&nbsp;<span style="color:var(--text-tip);font-size:0.7rem;">（即将上线）</span></p>
          </div>
          <div class="modal-actions" style="margin-top:16px;">
            <button class="btn btn-ghost" id="trustModalExit" style="color:var(--accent);">不，退出</button>
            <button class="btn btn-primary" id="trustModalTrust">是的，我信任这个文件夹</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const cleanup = () => { overlay.remove(); };

      overlay.querySelector('#trustModalExit').onclick = () => { cleanup(); resolve(false); };
      overlay.querySelector('#trustModalTrust').onclick = () => {
        // 加入受信列表
        trusted.push(folderPath);
        try { localStorage.setItem('lubia_trusted_folders', JSON.stringify(trusted)); } catch (_) {}
        cleanup(); resolve(true);
      };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(false); } });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', esc); resolve(false); }
      });
    });
  }

  // ===== 公开 API =====
  return {
    init,
    openFolder,
    getRootPath: () => rootPath,
    getTreeData: () => treeData,
    /** 编程式设置工作区（也需安全检查） */
    setWorkspace: async (dirPath) => {
      rootPath = dirPath;
      window.__lubia_workspace_root = dirPath;
      loadedDirs = new Set();
      const trusted = await _checkFolderTrust(dirPath);
      if (!trusted) {
        rootPath = null;
        window.__lubia_workspace_root = null;
        treeData = null;
        renderTree();
        return;
      }
      await loadDirectory(dirPath);
    },
  };
})();
