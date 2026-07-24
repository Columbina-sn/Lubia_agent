/* ============================================================
   app.js v4 — 简化版主控制器
   修复：右键菜单 / 挂载流程 / 红点徽章
   ============================================================ */

const App = (() => {
  const state = {
    activePage: 'home',
    fileExplorerOpen: true, theme: 'auto', unreadCount: 0,
    rendered: false,  // 首次渲染标志
  };
  let els = {};

  // 全局工作区根目录（file-explorer.js 打开文件夹时设置，chat.js 发送前校验）
  window.__lubia_workspace_root = null;

  /** 安全校验：检查文件路径是否在工作区内 */
  function isPathInWorkspace(filePath) {
    const root = window.__lubia_workspace_root;
    if (!root) return false;
    // 统一分隔符为 / 并小写比较
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const rootNorm = root.replace(/\\/g, '/').toLowerCase();
    // 禁止路径穿越 (path traversal)
    if (normalized.includes('..')) return false;
    return normalized.startsWith(rootNorm);
  }

  function init() {
    els.appShell = document.getElementById('appShell');
    els.fileExplorer = document.getElementById('fileExplorer');
    els.activityBar = document.getElementById('activityBar');
    els.mainArea = document.getElementById('mainArea');
    els.panelContainer = document.getElementById('panelContainer');
    els.contextMenu = document.getElementById('contextMenu');

    restoreTheme();
    restoreFontSize();
    // 应用编辑器标签页 CSS 变量
    if (typeof Settings !== 'undefined' && Settings._applyEditorTabSettings) Settings._applyEditorTabSettings();
    bindActivityBar();
    bindShellHandles();
    bindGlobalEvents();
    setupContextMenu();
    setupAvatarDropdown();
    setupChatDelegation();
    showPage('home');
    restoreLoginState();
    FileExplorer.init(els.fileExplorer);
    _initUsageWidget();
    // 初始化窗口状态（最大化图标等）
    if (typeof Bridge !== 'undefined' && Bridge.initWindowState) Bridge.initWindowState();
  }

  // ===== 主题 =====
  function restoreTheme() {
    const s = localStorage.getItem('lubia_theme') || 'auto';
    applyTheme(s);
  }
  function applyTheme(v) {
    state.theme = v;
    if (v === 'auto') document.documentElement.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
    else if (v === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('lubia_theme', v);
  }

  // ===== 字体大小 =====
  function restoreFontSize() {
    const s = localStorage.getItem('lubia_font_size') || '1.0';
    applyFontSize(parseFloat(s));
  }
  function applyFontSize(scale) {
    // 基准 13.5px，所有 rem 尺寸等比缩放
    document.documentElement.style.fontSize = (13.5 * scale) + 'px';
  }

  // ===== 页面 =====
  async function showPage(id, options) {
    // 已经在目标页面 → 编辑器页面时切换文件树，其他页面不做任何操作
    // options.noToggle=true 时抑制文件树切换（文件树打开文件时使用）
    // 用按钮 active class 判断当前页，比 state.activePage 更可靠
    const isActive = els.activityBar.querySelector(`[data-page="${id}"]`)?.classList.contains('active');
    if (state.rendered && isActive) {
      if (id === 'editor' && !options?.noToggle) toggleFileExplorer();
      return;
    }
    if (id === 'home') { state.unreadCount = 0; }
    const ok = await renderSingle(id);
    if (!ok) return;  // 用户取消了未保存弹窗
    state.activePage = id;
    els.activityBar.querySelectorAll('.activity-btn').forEach(b => b.classList.toggle('active', b.dataset.page === id));
    updateBadge();
  }

  async function renderSingle(id) {
    const oldPage = state.activePage;
    // 只有页面真正切换时才卸载旧页面（关闭分屏时 oldPage === id，不需要卸载）
    if (oldPage !== id) {
      const result = unmountPage(oldPage);
      if (result instanceof Promise) {
        try { await result; } catch (_) { return false; }  // 用户取消
      }
    }
    state.rendered = true;
    els.panelContainer.className = 'split-root single';
    els.panelContainer.innerHTML = `<div class="split-panel" data-page="${id}">${pageHTML(id)}</div>`;
    requestAnimationFrame(() => mountPage(id));
    return true;
  }

  function unmountPage(id) {
    if (id === 'home' && typeof Chat !== 'undefined') Chat.destroy();
    if (id === 'editor' && typeof Editor !== 'undefined') {
      return _editorUnmountCheck();  // 返回 Promise，有未保存修改时弹窗
    }
    if (id === 'settings' && typeof Settings !== 'undefined') {
      return Settings.destroy();
    }
    if (id === 'knowledge' && typeof Knowledge !== 'undefined') {
      return Knowledge.destroy();
    }
  }

  function _editorUnmountCheck() {
    if (typeof Editor === 'undefined') return;
    let allFiles = [];
    if (Editor.getAllOpenFiles) allFiles = Editor.getAllOpenFiles(); else if (Editor.getOpenFiles) allFiles = Editor.getOpenFiles(); const dirty = allFiles.some(f => f.modified);
    if (!dirty) { Editor.destroy(); return; }
    return new Promise((resolve, reject) => {
      const ov = document.createElement('div'); ov.className = 'modal-overlay';
      ov.innerHTML = `<div class="modal-dialog" style="max-width:400px;">
        <h3>未保存的修改</h3><p>你有文件尚未保存，离开编辑器将丢失修改。</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="_euDiscard">不保存</button>
          <button class="btn btn-ghost" id="_euCancel">取消</button>
          <button class="btn btn-primary" id="_euSave">保存并离开</button>
        </div></div>`;
      document.body.appendChild(ov);
      ov.querySelector('#_euDiscard').onclick = () => { ov.remove(); Editor.destroy(); resolve(); };
      ov.querySelector('#_euCancel').onclick = () => { ov.remove(); reject(new Error('cancelled')); };
      ov.querySelector('#_euSave').onclick = async () => {
        ov.remove();
        if (Editor.saveAllFiles) await Editor.saveAllFiles(); else if (Editor.saveFile) await Editor.saveFile();
        Editor.destroy(); resolve();
      };
      ov.addEventListener('click', e => { if (e.target === ov) { ov.remove(); reject(new Error('cancelled')); } });
    });
  }

  function mountPage(id) {
    // 使用 setTimeout 确保 innerHTML 的 DOM 已经完全就绪
    setTimeout(() => {
      if (id === 'home' && typeof Chat !== 'undefined') { Chat.mount(); bindChatSidebarHandle(); }
      if (id === 'editor' && typeof Editor !== 'undefined') Editor.mount();
      if (id === 'settings' && typeof Settings !== 'undefined') Settings.mount();
      if (id === 'knowledge' && typeof Knowledge !== 'undefined') Knowledge.mount();
    }, 50);
  }

  // ===== 拖拽 =====
  function bindShellHandles() {
    const h = document.getElementById('shellHandleFE'), fe = document.getElementById('fileExplorer');
    if (!h || !fe) return;
    h.addEventListener('mousedown', e => {
      e.preventDefault(); h.classList.add('dragging');
      const sx = e.clientX, sw = fe.offsetWidth;
      function mv(ev) { const w = Math.max(140, Math.min(sw + (ev.clientX - sx), 500)); fe.style.width = w + 'px'; fe.style.minWidth = w + 'px'; }
      function up() { h.classList.remove('dragging'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); if (typeof Editor!=='undefined'&&Editor.refresh)Editor.refresh(); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  function bindChatSidebarHandle() {
    setTimeout(() => {
      const h = document.getElementById('chatSplitHandle'), sb = document.getElementById('chatSidebar');
      if (!h || !sb || h.dataset.bound) return; h.dataset.bound = '1';
      h.addEventListener('mousedown', e => {
        e.preventDefault(); h.classList.add('dragging');
        const sx = e.clientX, sw = sb.offsetWidth;
        function mv(ev) { const w = Math.max(140, Math.min(sw + (ev.clientX - sx), 400)); sb.style.width = w + 'px'; sb.style.minWidth = w + 'px'; }
        function up() { h.classList.remove('dragging'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      });
    }, 80);
  }

  // ===== 活动栏事件 =====
  function bindActivityBar() {
    els.activityBar.addEventListener('click', e => {
      const btn = e.target.closest('.activity-btn'); if (!btn) return;
      showPage(btn.dataset.page);
    });
    els.activityBar.addEventListener('contextmenu', e => {
      const btn = e.target.closest('.activity-btn'); if (!btn) return;
      e.preventDefault(); e.stopPropagation();
      const items = [{ label: '在此处打开', action: () => showPage(btn.dataset.page) }];
      if (btn.dataset.page === 'editor') {
        const label = state.fileExplorerOpen ? '隐藏文件树' : '打开文件树';
        items.push({ label, shortcut: 'Ctrl+B', action: () => toggleFileExplorer() });
      }
      showContextMenu(e.clientX, e.clientY, items);
    });
  }

  // ===== 右键菜单（修复：e.stopPropagation 防止被 document 监听器立即关闭）=====
  function setupContextMenu() {
    // 点击菜单外部关闭
    document.addEventListener('click', e => {
      const m = els.contextMenu;
      if (!m.classList.contains('visible')) return;
      if (!m.contains(e.target)) m.classList.remove('visible');
    });
    // 按 ESC 关闭
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') els.contextMenu.classList.remove('visible');
    });
  }

  // ── 全局右键菜单（同时只存在一个）──
  // items: [{ label, action: fn }, { sep: true }, { label, danger: true, shortcut: "Ctrl+B", action: fn }]
  function showContextMenu(x, y, items) {
    // 移除旧式动态创建的菜单（不含 #contextMenu 自身）
    document.querySelectorAll('.context-menu:not(#contextMenu), .conv-context-menu').forEach(m => m.remove());

    const m = els.contextMenu;
    m.classList.remove('visible');

    let html = '';
    items.forEach((item, i) => {
      if (item.sep) { html += '<div class="context-menu-separator"></div>'; return; }
      const cls = item.danger ? 'context-menu-item danger' : 'context-menu-item';
      const shortcut = item.shortcut ? `<span class="context-menu-shortcut">${item.shortcut}</span>` : '';
      html += `<div class="${cls}" data-cm-idx="${i}"><span>${item.label}</span>${shortcut}</div>`;
    });

    m.innerHTML = html;

    m.querySelectorAll('.context-menu-item').forEach(el => {
      const idx = parseInt(el.dataset.cmIdx);
      const item = items[idx];
      if (item && item.action) {
        el.onclick = () => { m.classList.remove('visible'); item.action(); };
      }
    });

    m.style.left = x + 'px'; m.style.top = y + 'px';
    m.offsetHeight;
    m.classList.add('visible');
  }

  // ===== 聊天区事件委托（一次绑定，永久有效）=====
  function setupChatDelegation() {
    els.panelContainer.addEventListener('click', (e) => {
      const t = e.target;

      // 发送按钮
      if (t.closest('#sendBtn')) {
        const inp = document.getElementById('chatInput');
        if (!inp) return;
        const v = inp.value.trim();
        if (v && typeof Chat !== 'undefined') { Chat.sendMessage(v); }
        return;
      }
      // 停止按钮
      if (t.closest('#stopBtn')) {
        if (typeof Chat !== 'undefined') Chat.stopGenerating();
        return;
      }
      // 新对话按钮
      if (t.closest('#homeNewBtn')) {
        if (typeof Chat !== 'undefined') Chat.newConversation();
        return;
      }
      // 模式切换按钮
      if (t.classList.contains('chat-mode-btn') || t.closest('.chat-mode-btn')) {
        const btn = t.classList.contains('chat-mode-btn') ? t : t.closest('.chat-mode-btn');
        if (typeof Chat !== 'undefined') Chat.setMode(btn.dataset.mode);
        return;
      }
    });

    // select 变更事件
    els.panelContainer.addEventListener('change', (e) => {
      if (e.target.id === 'chatModelSelect') {
        if (typeof Chat !== 'undefined') Chat.setModel(e.target.value);
      }
    });

    // textarea 键盘事件
    els.panelContainer.addEventListener('keydown', (e) => {
      if (e.target.id === 'chatInput' && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = e.target.value.trim();
        if (v && typeof Chat !== 'undefined') { Chat.sendMessage(v); }
      }
    });

    // textarea 自适应高度
    els.panelContainer.addEventListener('input', (e) => {
      if (e.target.id === 'chatInput') {
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
      }
    });
  }

  // ===== 红点 =====
  function addUnread(n) {
    if (state.activePage !== 'home') { state.unreadCount += n; updateBadge(); }
  }
  function updateBadge() {
    const homeBtn = els.activityBar.querySelector('[data-page="home"]'); if (!homeBtn) return;
    let badge = homeBtn.querySelector('.activity-badge');
    if (state.unreadCount > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'activity-badge'; homeBtn.appendChild(badge); }
      badge.textContent = state.unreadCount > 99 ? '99+' : state.unreadCount;
    } else { if (badge) badge.remove(); }
  }

  // ===== 全局 =====
  function bindGlobalEvents() {
    window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => { if (state.theme === 'auto') applyTheme('auto'); });
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey||e.metaKey) && e.key === 'b') { e.preventDefault(); toggleFileExplorer(); }
      if ((e.ctrlKey||e.metaKey) && e.key === 'k') { e.preventDefault(); const inp = document.getElementById('chatInput'); if (inp) inp.focus(); }
      if ((e.ctrlKey||e.metaKey) && e.key === 'n') { e.preventDefault(); if (state.activePage === 'home' && typeof Chat!=='undefined'&&Chat.newConversation) Chat.newConversation(); }
    });
    window.addEventListener('resize', () => { if (typeof Editor!=='undefined'&&Editor.refresh) Editor.refresh(); });
  }

  function toggleFileExplorer() {
    state.fileExplorerOpen = !state.fileExplorerOpen;
    els.fileExplorer.classList.toggle('collapsed', !state.fileExplorerOpen);
    const h = document.getElementById('shellHandleFE'); if (h) h.classList.toggle('hidden', !state.fileExplorerOpen);
  }

  // ===== 页面 HTML =====
  function pageHTML(id) {
    switch (id) {
      case 'home': return `
        <div class="page-container page-row" id="homePage">
          <div class="chat-sidebar" id="chatSidebar">
            <div class="chat-sidebar-header"><span class="chat-sidebar-title">对话</span><button class="chat-new-btn" id="homeNewBtn" title="新对话"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button></div>
            <div class="conv-list" id="conversationList"></div>
          </div>
          <div class="split-handle" id="chatSplitHandle" style="cursor:col-resize;"></div>
          <div class="chat-main">
            <div class="message-container" id="messageContainer"></div>
            <div class="chat-input-area">
              <div class="chat-input-wrapper"><textarea class="chat-input" id="chatInput" placeholder="输入消息… (Enter 发送，Shift+Enter 换行)" rows="1"></textarea>
              <button class="btn-send" id="sendBtn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
              <button class="btn-stop hidden" id="stopBtn">停止</button></div>
              <div class="chat-input-toolbar">
                <div class="chat-mode-selector" id="chatModeSelector">
                  <button class="chat-mode-btn active" data-mode="ask">Ask</button>
                  <button class="chat-mode-btn" data-mode="plan">Plan</button>
                  <button class="chat-mode-btn" data-mode="agent">Auto</button>
                </div>
                <select class="chat-model-select" id="chatModelSelect"></select>
              </div>
              <p class="chat-input-hint">Lubia · 内容由AI生成请注意甄别、审计</p>
            </div>
          </div></div>`;
      case 'editor': {
        const panelHTML = (pi) => `
        <div class="split-panel${pi === 1 ? ' hidden' : ''}" id="editorPanel${pi}">
          <div class="editor-tabs" id="editorTabs${pi}"></div>
          <div class="editor-container" id="editorContainer${pi}">
            <div class="editor-cm-wrapper hidden" id="editorCmWrapper${pi}"></div>
            <div class="editor-binary-notice hidden" id="editorBinaryNotice${pi}"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg><h3>不支持打开此类二进制文件</h3><p id="editorBinaryExt${pi}"></p></div>
            <div class="editor-empty-state" id="editorEmptyState${pi}"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg><h3>编辑器</h3><p>从左侧文件树打开一个文件<br>或拖拽文件到此处</p></div></div></div>`;
        return `
        <div class="page-container" id="editorPage">
          <div class="split-root horizontal" id="editorSplitRoot">
            ${panelHTML(0)}
            <div class="split-handle hidden" id="editorSplitHandle"></div>
            ${panelHTML(1)}
          </div></div>`; }
      case 'exercises': return `<div class="page-container"><div class="placeholder-page"><h2>错题本</h2><p>拍照/截图/粘贴题目 → AI 解答 → 自动归类 → 定期复习</p><span class="placeholder-badge">P1 阶段开发</span></div></div>`;
      case 'knowledge': return `<div class="page-container knowledge-page" id="knowledgePage"></div>`;
      case 'settings': return `
        <div class="page-container" id="settingsPage">
          <div class="settings-shell">
            <div class="settings-nav" id="settingsNav">
              <div class="settings-nav-item active" data-section="preferences" onclick="Settings.switchSection('preferences')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                <span>偏好设置</span>
              </div>
              <div class="settings-nav-item" data-section="providers" onclick="Settings.switchSection('providers')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                <span>供应商</span>
              </div>
              <div class="settings-nav-item" data-section="defaultModels" onclick="Settings.switchSection('defaultModels')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                <span>默认模型</span>
              </div>
              <div class="settings-nav-item" data-section="shortcuts" onclick="Settings.switchSection('shortcuts')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>
                <span>快捷键</span>
              </div>
              <div class="settings-nav-item" data-section="usage" onclick="Settings.switchSection('usage')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                <span>用量统计</span>
              </div>
              <div class="settings-nav-item" data-section="about" onclick="Settings.switchSection('about')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <span>关于</span>
              </div>
            </div>
            <div class="settings-content" id="settingsContent"></div>
          </div>
        </div>`;
      default: return `<div class="page-container"><div class="placeholder-page"><h2>${id}</h2></div></div>`;
    }
  }

  // ===== 顶部导航栏：头像下拉 =====
  function setupAvatarDropdown() {
    document.addEventListener('click', e => {
      const dd = document.getElementById('avatarDropdown');
      const btn = document.getElementById('navbarAvatarBtn');
      if (!dd || !dd.classList.contains('visible')) return;
      if (!dd.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        dd.classList.remove('visible');
      }
    });
  }

  function toggleAvatarDropdown() {
    const dd = document.getElementById('avatarDropdown');
    if (!dd) return;
    dd.classList.toggle('visible');
  }

  // ===== 登录 / 注册 =====
  function showLoginModal() {
    const dd = document.getElementById('avatarDropdown');
    if (dd) dd.classList.remove('visible');
    const overlay = document.getElementById('loginModalOverlay');
    if (overlay) overlay.classList.remove('hidden');
  }

  function closeLoginModal() {
    const overlay = document.getElementById('loginModalOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  let loginMode = 'login'; // 'login' | 'register'
  function switchLoginMode() {
    loginMode = loginMode === 'login' ? 'register' : 'login';
    const title = document.getElementById('loginModalTitle');
    const desc = document.getElementById('loginModalDesc');
    const submit = document.getElementById('loginSubmitBtn');
    const switchBtn = document.getElementById('loginSwitchBtn');
    if (loginMode === 'register') {
      if (title) title.textContent = '注册';
      if (desc) desc.textContent = '创建账号以在多设备间同步设置';
      if (submit) submit.textContent = '注册';
      if (switchBtn) switchBtn.textContent = '已有账号？登录';
    } else {
      if (title) title.textContent = '登录';
      if (desc) desc.textContent = '登录后可在多设备间同步设置和 API Key';
      if (submit) submit.textContent = '登录';
      if (switchBtn) switchBtn.textContent = '还没有账号？注册';
    }
  }

  function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail')?.value?.trim();
    const password = document.getElementById('loginPassword')?.value?.trim();
    if (!email || !password) return;

    // 占位：后续接入真实认证
    const user = { email, name: email.split('@')[0] };
    localStorage.setItem('lubia_user', JSON.stringify(user));
    updateAvatarUI(user);
    closeLoginModal();
    showToast('已登录（本地模拟）', 'info');
  }

  function logout() {
    const dd = document.getElementById('avatarDropdown');
    if (dd) dd.classList.remove('visible');
    localStorage.removeItem('lubia_user');
    updateAvatarUI(null);
    showToast('已退出登录', 'info');
  }

  function restoreLoginState() {
    try {
      const raw = localStorage.getItem('lubia_user');
      if (raw) updateAvatarUI(JSON.parse(raw));
      else updateAvatarUI(null);
    } catch (_) { updateAvatarUI(null); }
  }

  function updateAvatarUI(user) {
    const icon = document.getElementById('navbarAvatarIcon');
    const label = document.getElementById('navbarAvatarLabel');
    const guest = document.getElementById('dropdownGuest');
    const logged = document.getElementById('dropdownLoggedIn');
    if (user) {
      if (icon) icon.textContent = (user.name || 'U')[0].toUpperCase();
      if (label) label.textContent = user.name || user.email;
      if (guest) guest.classList.add('hidden');
      if (logged) logged.classList.remove('hidden');
      const userName = document.getElementById('dropdownUserName');
      const userEmail = document.getElementById('dropdownUserEmail');
      const userIcon = document.getElementById('dropdownUserIcon');
      if (userName) userName.textContent = user.name || user.email;
      if (userEmail) userEmail.textContent = user.email;
      if (userIcon) userIcon.textContent = (user.name || 'U')[0].toUpperCase();
    } else {
      if (icon) icon.textContent = '';
      if (label) label.textContent = '未登录';
      if (guest) guest.classList.remove('hidden');
      if (logged) logged.classList.add('hidden');
    }
  }

  function showToast(msg, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    // 上限 5 个，超出销毁最早的（container.children 是实时 HTMLCollection）
    while (container.children.length >= 5) { container.firstElementChild.remove(); }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type || 'info'}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.25s'; setTimeout(() => toast.remove(), 250); }, 2800);
  }

  // ===== 用量实时小组件（右下角 HUD）=====

  let _usageWidgetEl = null;
  let _usageWidgetTimer = null;

  function _initUsageWidget() {
    _usageWidgetEl = document.createElement('div');
    _usageWidgetEl.id = 'usageWidget';
    _usageWidgetEl.className = 'usage-widget';
    _usageWidgetEl.innerHTML =
      '<div class="usage-widget-ring" id="uwRing"></div>' +
      '<div class="usage-widget-lines">' +
        '<div class="usage-widget-line"><span class="uw-arrow up">↑</span><span id="uwIn">0</span></div>' +
        '<div class="usage-widget-line"><span class="uw-arrow down">↓</span><span id="uwOut">0</span></div>' +
        '<div class="usage-widget-line uw-calls" id="uwCalls">0 次调用</div>' +
      '</div>';
    document.body.appendChild(_usageWidgetEl);

    if (localStorage.getItem('lubia_usage_widget') === '1') {
      _usageWidgetEl.classList.add('visible');
      _refreshUsageWidget();
      _usageWidgetTimer = setInterval(_refreshUsageWidget, 30000);
    }
  }

  async function _refreshUsageWidget() {
    if (!_usageWidgetEl || !_usageWidgetEl.classList.contains('visible')) return;
    try {
      const res = await fetch('http://127.0.0.1:19800/api/usage/stats?period=1d');
      const json = await res.json();
      const today = (json.data && json.data.today) || {};
      const input = today.input_tokens || 0;
      const output = today.output_tokens || 0;
      const calls = today.calls || 0;
      const ringEl = document.getElementById('uwRing');
      const inEl = document.getElementById('uwIn');
      const outEl = document.getElementById('uwOut');
      const callsEl = document.getElementById('uwCalls');
      if (ringEl) ringEl.innerHTML = _usageRingSVG(input + output);
      if (inEl) inEl.textContent = _fmtShort(input);
      if (outEl) outEl.textContent = _fmtShort(output);
      if (callsEl) callsEl.textContent = calls + ' 次调用';
    } catch (e) { /* 静默 */ }
  }

  function _fmtShort(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  // 环形图 SVG（逻辑与热力图颜色一致）
  function _usageRingSVG(total) {
    var S = 48, W = 5, LAP = 1e6;
    var r = (S - W) / 2, c = 2 * Math.PI * r, cx = S / 2;
    var clamped = Math.min(total, LAP * 1.2);
    var raw = 0.40 + 0.60 * Math.pow(clamped / (LAP * 1.2), 0.35);
    var base = Math.round(Math.min(1, Math.max(0.40, raw)) * 100);
    var laps = Math.floor(total / LAP);
    var rem = total % LAP;
    var prog = Math.min(rem / LAP, 1);
    var dash = c * prog;

    function clr(layer) {
      if (layer === 0) return 'color-mix(in srgb,var(--primary) ' + base + '%,transparent)';
      var ap = Math.min(60, layer * 20);
      return 'color-mix(in srgb,var(--primary) 100%,color-mix(in srgb,var(--accent) ' + ap + '%,var(--primary)))';
    }

    var svg = '<svg width="' + S + '" height="' + S + '" viewBox="0 0 ' + S + ' ' + S + '">';
    svg += '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="var(--border-card)" stroke-width="' + W + '" />';
    for (var i = 0; i < laps; i++) {
      svg += '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="' + clr(i) + '" stroke-width="' + W + '" stroke-dasharray="' + c + '" stroke-dashoffset="0" transform="rotate(-90 ' + cx + ' ' + cx + ')" />';
    }
    svg += '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="' + clr(laps) + '" stroke-width="' + W + '" stroke-linecap="round" stroke-dasharray="' + dash + ' ' + (c - dash) + '" stroke-dashoffset="0" transform="rotate(-90 ' + cx + ' ' + cx + ')" />';
    svg += '</svg>';
    return svg;
  }

  function toggleUsageWidget(on) {
    if (!_usageWidgetEl) return;
    if (on) {
      _usageWidgetEl.classList.add('visible');
      _refreshUsageWidget();
      if (!_usageWidgetTimer) _usageWidgetTimer = setInterval(_refreshUsageWidget, 30000);
    } else {
      _usageWidgetEl.classList.remove('visible');
      if (_usageWidgetTimer) { clearInterval(_usageWidgetTimer); _usageWidgetTimer = null; }
    }
  }

  return {
    init, showPage, showContextMenu, toggleFileExplorer, applyTheme, applyFontSize,
    addUnread, updateBadge, getState: () => state,
    isPathInWorkspace,
    toggleAvatarDropdown, showLoginModal, closeLoginModal, switchLoginMode, handleLogin, logout,
    showToast, updateAvatarUI, toggleUsageWidget, _refreshUsageWidget
  };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
