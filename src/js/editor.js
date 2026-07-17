/* ============================================================
   editor.js v5 —— CodeMirror 6 双面板编辑器

   左右分屏 · 持久化 · MD/HTML 预览 · Ctrl+S · 自定义弹窗
   ============================================================ */

const Editor = (() => {
  // ── 双面板状态 ──
  let panels = [
    { openFiles: [], activeFileIndex: -1, cmView: null, previewMode: false },
    { openFiles: [], activeFileIndex: -1, cmView: null, previewMode: false }
  ];
  let activePanel = 0;      // 当前聚焦的面板
  let splitActive = false;  // 右侧面板是否可见
  let _savedState = null;   // 页面切换时持久化状态

  const TEXT_EXTS = new Set([
    'txt','md','py','js','ts','jsx','tsx','html','css','scss','less',
    'json','xml','yaml','yml','toml','ini','cfg','sh','bash','zsh',
    'c','cpp','h','hpp','java','go','rs','rb','php','swift','kt',
    'r','m','sql','vue','svelte','astro','tex','csv','log','svg',
    'gitignore','env','dockerfile','makefile','cmake','bat','ps1',
    'conf','config','editorconfig','eslintrc','prettierrc',
  ]);

  // ── 辅助：获取面板专属 DOM 元素 ──
  function _el(suffix, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    return document.getElementById(`editor${suffix}${pi}`);
  }

  // ── 辅助：获取面板数据 ──
  function _p(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    return panels[pi];
  }

  // ── 辅助：另一个面板索引 ──
  function _otherPanel() { return activePanel === 0 ? 1 : 0; }

  // ================================================================
  // 自定义弹窗（替代 window.confirm，Tauri v2 禁用了原生 confirm）
  // ================================================================

  function _modal(title, msg, onOk, onCancel) {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-dialog" style="max-width:400px;">
      <h3>${title}</h3><p>${msg}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="_mCancel">取消</button>
        <button class="btn btn-primary" id="_mOk">确认</button>
      </div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('#_mOk').onclick = () => { ov.remove(); if (onOk) onOk(); };
    ov.querySelector('#_mCancel').onclick = () => { ov.remove(); if (onCancel) onCancel(); };
    ov.addEventListener('click', e => { if (e.target === ov) { ov.remove(); if (onCancel) onCancel(); } });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); if (onCancel) onCancel(); } });
  }

  // ================================================================
  // mount / destroy
  // ================================================================

  async function mount() {
    if (_savedState) {
      // 恢复持久化的双面板状态
      panels = _savedState.panels.map(p => ({
        openFiles: p.openFiles.map(f => ({...f, modified: false})),  // 清除修改标记
        activeFileIndex: p.activeFileIndex,
        cmView: null,
        previewMode: p.previewMode,
      }));
      activePanel = _savedState.activePanel;
      splitActive = _savedState.splitActive;
      _savedState = null;
    }
    // 无论如何都要刷新（恢复分屏状态 + 渲染两个面板）
    await refreshUI();
    _bindSplitHandle();
  }

  function destroy() {
    // 保存两个面板的最新内容
    for (let i = 0; i < 2; i++) {
      _saveCurrentContent(i);
      if (panels[i].cmView) { panels[i].cmView.destroy(); panels[i].cmView = null; }
      // 清理预览 wrapper（注意面板专属 ID）
      const pw = document.getElementById(`editorPreviewWrapper${i}`);
      if (pw) pw.remove();
    }
    // 持久化
    const hasFiles = panels.some(p => p.openFiles.length > 0);
    if (hasFiles) {
      _savedState = {
        panels: panels.map(p => ({
          openFiles: p.openFiles.map(f => ({...f})),  // 深拷贝
          activeFileIndex: p.activeFileIndex,
          previewMode: p.previewMode,
        })),
        activePanel,
        splitActive,
      };
    } else {
      _savedState = null;
    }
    // 清空
    panels = [
      { openFiles: [], activeFileIndex: -1, cmView: null, previewMode: false },
      { openFiles: [], activeFileIndex: -1, cmView: null, previewMode: false }
    ];
    activePanel = 0;
    splitActive = false;
  }

  // ================================================================
  // 分屏控制
  // ================================================================

  function toggleSplit() {
    splitActive = !splitActive;
    const p1 = document.getElementById('editorPanel1');
    const handle = document.getElementById('editorSplitHandle');
    if (p1) p1.classList.toggle('hidden', !splitActive);
    if (handle) handle.classList.toggle('hidden', !splitActive);
    // 关闭分屏时，如果右侧面板有未保存文件，先合并回左侧？
    // 简单处理：关闭分屏不清除右侧面板数据，下次打开还在
    if (!splitActive && activePanel === 1) {
      focusPanel(0);
    }
    _renderAllTabs();
  }

  function focusPanel(pIdx) {
    if (activePanel === pIdx) return;
    activePanel = pIdx;
    // 视觉上高亮活跃面板
    _renderAllTabs();
  }

  function openFileInSide(filePath, fileName) {
    const targetPanel = _otherPanel();
    // 如果分屏未激活，先激活
    if (!splitActive) toggleSplit();
    openFileInPanel(targetPanel, filePath, fileName);
  }

  // ================================================================
  // 打开文件
  // ================================================================

  async function openFile(filePath, fileName, pIdx) {
    await openFileInPanel(pIdx !== undefined ? pIdx : activePanel, filePath, fileName);
  }

  async function openFileInPanel(pIdx, filePath, fileName) {
    const p = panels[pIdx];
    const existing = p.openFiles.findIndex(f => f.path === filePath);
    if (existing >= 0) { switchFile(existing, pIdx); return; }
    _saveCurrentContent(pIdx);
    const ext = filePath.split('.').pop()?.toLowerCase();
    const f = { path: filePath, name: fileName || filePath.split(/[/\\]/).pop(), content: '', isBinary: !TEXT_EXTS.has(ext), ext, modified: false };
    if (!f.isBinary) {
      try { if (typeof Bridge !== 'undefined' && Bridge.isTauri()) f.content = await Bridge.readTextFile(filePath) || ''; }
      catch (err) { f.content = '// 无法读取文件: ' + err.message; }
    }
    p.openFiles.push(f); p.activeFileIndex = p.openFiles.length - 1; p.previewMode = false;
    await refreshUI(pIdx);
  }

  function openBinary(fileName, ext) {
    return openBinaryInPanel(activePanel, fileName, ext);
  }

  function openBinaryInPanel(pIdx, fileName, ext) {
    const p = panels[pIdx];
    const existing = p.openFiles.findIndex(f => f.path === fileName && f.isBinary);
    if (existing >= 0) { switchFile(existing, pIdx); return; }
    p.openFiles.push({ path: fileName, name: fileName, content: '', isBinary: true, ext, modified: false });
    p.activeFileIndex = p.openFiles.length - 1;
    refreshUI(pIdx);
  }

  // ================================================================
  // 切换 / 关闭
  // ================================================================

  function switchFile(index, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    if (index < 0 || index >= p.openFiles.length) return;
    _saveCurrentContent(pi);
    p.activeFileIndex = index; p.previewMode = false;
    refreshUI(pi);
  }

  function closeFile(index, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    if (index < 0 || index >= p.openFiles.length) return;
    const f = p.openFiles[index];
    if (f.modified && !f.isBinary) {
      _modal('未保存的修改', `文件 "${f.name}" 有未保存的修改，确定关闭？`, () => _doClose(index, pi));
    } else {
      _doClose(index, pi);
    }
  }

  function _doClose(index, pIdx) {
    const p = panels[pIdx];
    p.openFiles.splice(index, 1);
    if (p.openFiles.length === 0) p.activeFileIndex = -1;
    else if (p.activeFileIndex >= p.openFiles.length) p.activeFileIndex = p.openFiles.length - 1;
    else if (index < p.activeFileIndex) p.activeFileIndex--;
    refreshUI(pIdx);
  }

  function _saveCurrentContent(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    if (p.activeFileIndex < 0 || p.activeFileIndex >= p.openFiles.length || !p.cmView) return;
    const f = p.openFiles[p.activeFileIndex];
    if (!f.isBinary) f.content = p.cmView.state.doc.toString();
  }

  // ================================================================
  // 保存文件 (Ctrl+S)
  // ================================================================

  async function saveFile(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    if (p.activeFileIndex < 0 || !p.cmView) return;
    const f = p.openFiles[p.activeFileIndex];
    if (f.isBinary) return;
    const content = p.cmView.state.doc.toString();
    if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
      try {
        await Bridge.writeTextFile(f.path, content);
        f.content = content; f.modified = false;
        _renderTabs(pi);
        _toast('已保存', 'success');
      } catch (err) {
        _toast('保存失败: ' + err.message, 'error');
      }
    }
  }

  // ================================================================
  // CM6 加载（npm → Vite node_modules 解析）
  // ================================================================

  let _cmCache = null;
  async function _loadCM6() {
    if (_cmCache) return _cmCache;
    const [view, cm, lang, lezer] = await Promise.all([
      import('@codemirror/view'),
      import('codemirror'),
      import('@codemirror/language'),
      import('@lezer/highlight'),
    ]);
    _cmCache = { ...view, basicSetup: cm.basicSetup, syntaxHighlighting: lang.syntaxHighlighting, HighlightStyle: lang.HighlightStyle, tags: lezer.tags };
    return _cmCache;
  }

  // 语言包
  const _L = {
    js: ()=>import('@codemirror/lang-javascript'), json:()=>import('@codemirror/lang-json'),
    html:()=>import('@codemirror/lang-html'), css:()=>import('@codemirror/lang-css'),
    md:()=>import('@codemirror/lang-markdown'), xml:()=>import('@codemirror/lang-xml'),
    py:()=>import('@codemirror/lang-python'), sql:()=>import('@codemirror/lang-sql'),
    rust:()=>import('@codemirror/lang-rust'), java:()=>import('@codemirror/lang-java'),
    cpp:()=>import('@codemirror/lang-cpp'),
  };

  const LANG = {
    js:async()=>{const m=await _L.js();return m.javascript();}, jsx:async()=>{const m=await _L.js();return m.javascript({jsx:true});},
    ts:async()=>{const m=await _L.js();return m.javascript({typescript:true});}, tsx:async()=>{const m=await _L.js();return m.javascript({jsx:true,typescript:true});},
    json:async()=>{const m=await _L.json();return m.json();}, html:async()=>{const m=await _L.html();return m.html();},
    css:async()=>{const m=await _L.css();return m.css();}, scss:async()=>{const m=await _L.css();return m.css();}, less:async()=>{const m=await _L.css();return m.css();},
    md:async()=>{const m=await _L.md();return m.markdown();}, xml:async()=>{const m=await _L.xml();return m.xml();},
    py:async()=>{const m=await _L.py();return m.python();}, sql:async()=>{const m=await _L.sql();return m.sql();},
    rust:async()=>{const m=await _L.rust();return m.rust();}, java:async()=>{const m=await _L.java();return m.java();},
    cpp:async()=>{const m=await _L.cpp();return m.cpp();}, c:async()=>{const m=await _L.cpp();return m.cpp();}, h:async()=>{const m=await _L.cpp();return m.cpp();}, hpp:async()=>{const m=await _L.cpp();return m.cpp();},
  };

  const _langCache = {};
  async function _lang(ext) {
    if (_langCache[ext] !== undefined) return _langCache[ext];
    const fn = LANG[ext]; if (!fn) { _langCache[ext] = null; return null; }
    try { _langCache[ext] = await fn(); return _langCache[ext]; }
    catch (_) { _langCache[ext] = null; return null; }
  }

  // ================================================================
  // UI
  // ================================================================

  async function refreshUI(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    _renderTabs(pi);
    await _renderContent(pi);
    // 刷新两个面板的 tabs（因为右侧面板可能有预览/分屏按钮变化）
    _renderAllTabs();
  }

  function refresh() {
    for (let i = 0; i < 2; i++) {
      if (panels[i].cmView) panels[i].cmView.requestMeasure();
    }
  }

  function _renderAllTabs() {
    _renderTabs(0);
    if (splitActive) _renderTabs(1);
  }

  function _renderTabs(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    const el = _el('Tabs', pi); if (!el) return;

    const f = p.activeFileIndex >= 0 ? p.openFiles[p.activeFileIndex] : null;
    const canPreview = f && (f.ext === 'md' || f.ext === 'html');
    const isActive = (pi === activePanel);

    el.innerHTML = p.openFiles.map((f, i) => `
      <div class="editor-tab ${i === p.activeFileIndex ? 'active' : ''} ${pi === activePanel ? '' : 'inactive-panel'}"
           onclick="Editor.switchFile(${i},${pi})">
        <span>${_esc(f.name)}</span>${f.modified ? '<span class="tab-modified" title="未保存"></span>' : ''}
        <span class="tab-close" onclick="event.stopPropagation();Editor.closeFile(${i},${pi})"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
      </div>`).join('')
      // 右侧操作区：预览切换 + 分屏切换
      + `<div class="editor-tabs-actions">
        ${canPreview ? `<button class="editor-action-btn" id="btnPreviewToggle${pi}" title="${p.previewMode ? '编辑源码' : '预览'}">${p.previewMode ? '编辑源码' : '预览'}</button>` : ''}
        <button class="editor-action-btn" id="btnSplitToggle${pi}" title="${splitActive ? '关闭分屏' : '分屏'}">${splitActive ? '合并' : '分屏'}</button>
      </div>`;

    // 绑定事件
    el.querySelector('#btnPreviewToggle' + pi)?.addEventListener('click', () => togglePreview(pi));
    el.querySelector('#btnSplitToggle' + pi)?.addEventListener('click', () => toggleSplit());
  }

  async function _renderContent(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    const w = _el('CmWrapper', pi), bin = _el('BinaryNotice', pi),
          binExtEl = bin ? bin.querySelector('p[id]') || bin.querySelector('p:last-child') : null,
          empty = _el('EmptyState', pi);
    const pw = document.getElementById(`editorPreviewWrapper${pi}`);

    if (p.cmView) { p.cmView.destroy(); p.cmView = null; }
    if (pw) pw.remove();

    if (p.activeFileIndex < 0 || p.openFiles.length === 0) {
      if (w) { w.classList.add('hidden'); w.innerHTML = ''; }
      if (bin) bin.classList.add('hidden');
      if (empty) empty.classList.remove('hidden');
      return;
    }
    const f = p.openFiles[p.activeFileIndex];
    if (f.isBinary) {
      if (w) { w.classList.add('hidden'); w.innerHTML = ''; }
      if (empty) empty.classList.add('hidden');
      if (bin) { bin.classList.remove('hidden'); if (binExtEl) binExtEl.textContent = `文件类型: .${f.ext} (${f.name})`; }
    } else if (p.previewMode && (f.ext === 'md' || f.ext === 'html')) {
      if (bin) bin.classList.add('hidden'); if (empty) empty.classList.add('hidden');
      if (w) { w.classList.add('hidden'); w.innerHTML = ''; }
      _renderPreview(f, pi);
    } else {
      if (bin) bin.classList.add('hidden'); if (empty) empty.classList.add('hidden');
      if (w) { w.classList.remove('hidden'); w.innerHTML = ''; await _mk(w, f, pi); }
    }
  }

  // ── 预览 ──

  async function _renderPreview(file, pIdx) {
    const container = _el('Container', pIdx);
    if (!container) return;
    let pw = document.getElementById(`editorPreviewWrapper${pIdx}`);
    if (!pw) {
      pw = document.createElement('div');
      pw.id = `editorPreviewWrapper${pIdx}`;
      pw.className = 'editor-preview-wrapper';
      container.appendChild(pw);
    }
    pw.innerHTML = '';

    if (file.ext === 'md') {
      try {
        const m = await import('marked');
        // 兼容 marked 不同版本的导出方式
        const parseFn = typeof m.marked === 'function' ? m.marked
                      : typeof m.parse === 'function' ? m.parse
                      : typeof m.default?.marked === 'function' ? m.default.marked
                      : typeof m.default?.parse === 'function' ? m.default.parse
                      : typeof m.default === 'function' ? m.default
                      : null;
        if (!parseFn) throw new Error('无法找到 marked 解析函数');
        let html = parseFn(file.content);
        // 为代码块添加 data-lang 属性，供 CSS ::before 显示语言标签
        html = html.replace(/<pre><code class="language-(\w+)">/g, '<pre data-lang="$1"><code>');
        html = html.replace(/<pre><code>/g, '<pre data-lang="code"><code>');
        const d = document.documentElement.getAttribute('data-theme') === 'dark';
        pw.innerHTML = `<div class="markdown-body" style="padding:20px 28px;max-width:860px;margin:0 auto;color:${d?'#dcd9ed':'#3a3650'};line-height:1.75;font-size:0.92rem;">${html}</div>`;
      } catch (e) {
        pw.innerHTML = `<div class="editor-preview-error">Markdown 渲染失败: ${_esc(e.message)}</div>`;
      }
    } else if (file.ext === 'html') {
      const iframe = document.createElement('iframe');
      iframe.className = 'editor-html-preview';
      iframe.sandbox = 'allow-scripts allow-same-origin';
      iframe.style.cssText = 'width:100%;height:100%;border:none;flex:1;';
      pw.appendChild(iframe);
      iframe.srcdoc = file.content;
    }
  }

  function togglePreview(pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    if (p.activeFileIndex < 0) return;
    const f = p.openFiles[p.activeFileIndex];
    if (f.ext !== 'md' && f.ext !== 'html') return;
    _saveCurrentContent(pi);
    p.previewMode = !p.previewMode;
    _renderContent(pi);
    _renderTabs(pi);
  }

  async function _mk(parent, file, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    try {
      const { EditorView, basicSetup, keymap, syntaxHighlighting, HighlightStyle, tags } = await _loadCM6();

      const saveBinding = keymap.of([{ key: 'Mod-s', run: () => { saveFile(pi); return true; }, preventDefault: true }]);

      // 显式绑定 Ctrl+C 复制，解决 Tauri 2 webview 中某些情况下复制不生效的问题
      const copyBinding = keymap.of([{
        key: 'Mod-c',
        run: (view) => {
          const range = view.state.selection.main;
          const text = view.state.sliceDoc(range.from, range.to);
          if (text) {
            navigator.clipboard.writeText(text).catch(() => {
              const ta = document.createElement('textarea');
              ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
              document.body.appendChild(ta); ta.select();
              try { document.execCommand('copy'); } catch (_) {}
              document.body.removeChild(ta);
            });
          }
          return true;
        }
      }]);

      // CM6 初始化阶段会触发多次 docChanged（语言扩展、缩进规范化等）
      let _cmSettled = false;
      setTimeout(() => { _cmSettled = true; }, 300);

      const ext = [...[].concat(basicSetup), saveBinding, copyBinding,
        EditorView.updateListener.of(u => {
          if (u.docChanged && _cmSettled) {
            const panel = panels[pi];
            if (panel.activeFileIndex >= 0 && panel.activeFileIndex < panel.openFiles.length) {
              panel.openFiles[panel.activeFileIndex].modified = true;
              _renderTabs(pi);
            }
          }
        }),
      ];

      // ═══ 语法高亮：深色模式用中等亮度 + 高饱和度，拉开色相差异 ═══
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const hlStyle = HighlightStyle.define([
        {tag:tags.keyword,                      color:isDark?'#7ea8d8':'#5c4e8a'},
        {tag:tags.string,                       color:isDark?'#ce9878':'#3d7c47'},
        {tag:tags.number,                       color:isDark?'#b5cea8':'#8a6a9e'},
        {tag:tags.comment,                      color:isDark?'#6a6a78':'#9999a8', fontStyle:'italic'},
        {tag:tags.variableName,                 color:isDark?'#d4d4d8':'#3a3650'},
        {tag:tags.definition(tags.variableName),color:isDark?'#d4d4d8':'#4a4270'},
        {tag:tags.function(tags.variableName),  color:isDark?'#dcd0a0':'#604888'},
        {tag:tags.typeName,                     color:isDark?'#58b8a8':'#4e6088'},
        {tag:tags.tagName,                      color:isDark?'#6ea0d0':'#5e7498'},
        {tag:tags.attributeName,                color:isDark?'#9cd0f0':'#6e5898'},
        {tag:tags.literal,                      color:isDark?'#7ea8d8':'#8a5e4e'},
        {tag:tags.operator,                     color:isDark?'#b8b8c0':'#5a5580'},
        {tag:tags.bracket,                      color:isDark?'#a0a0a8':'#6e6a88'},
        {tag:tags.heading,                      color:isDark?'#d8c898':'#3a3650', fontWeight:'600'},
        {tag:tags.quote,                        color:isDark?'#9898a8':'#7a768e'},
        {tag:tags.link,                         color:isDark?'#6ea8d8':'#406888', textDecoration:'underline'},
        {tag:tags.meta,                         color:isDark?'#a0a0a8':'#7a768e'},
        {tag:tags.strong,                       color:isDark?'#d8c898':'#3a3650', fontWeight:'600'},
        {tag:tags.emphasis,                     color:isDark?'#d4c8b0':'#3a3650', fontStyle:'italic'},
        {tag:tags.monospace,                    color:isDark?'#a0b898':'#5a6848'},
        {tag:tags.content,                      color:isDark?'#d0d0d4':'#3a3650'},
      ]);
      ext.push(syntaxHighlighting(hlStyle));

      const lang = await _lang(file.ext || ''); if (lang) ext.push(lang);
      ext.push(_theme(EditorView));

      p.cmView = new EditorView({ doc: file.content, extensions: ext, parent });
      _bindCtx(parent, pi);
    } catch (e) {
      console.error('[Editor] CM6 失败:', e);
      _fallback(parent, file.content, pi);
    }
  }

  function _fallback(parent, content, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    parent.innerHTML = `<div class="editor-body"><div class="editor-gutter" id="editorGutter${pi}"></div><textarea class="editor-textarea" id="editorTextarea${pi}" spellcheck="false">${_esc(content)}</textarea></div>`;
    const ta = parent.querySelector('#editorTextarea' + pi), g = parent.querySelector('#editorGutter' + pi);
    if (!ta) return;
    const up = () => {
      const panel = panels[pi];
      if (panel.activeFileIndex >= 0) { const f = panel.openFiles[panel.activeFileIndex]; f.content = ta.value; f.modified = true; }
      if (g) { const n = ta.value.split('\n').length; let h = ''; for (let i = 1; i <= n; i++) h += `<div class="editor-gutter-line">${i}</div>`; g.innerHTML = h; g.scrollTop = ta.scrollTop; }
    };
    ta.addEventListener('input', up); ta.addEventListener('scroll', () => { if (g) g.scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); _toast('保存功能仅 CM6 模式支持', 'warning'); } });
    up();
  }

  function _theme(EditorView) { const d = document.documentElement.getAttribute('data-theme') === 'dark';
    return EditorView.theme({
      '&':{
        backgroundColor:d?'#1e1e2a':'#fafafc',
        color:d?'#d0d0d4':'#3a3650',
        fontSize:'0.96rem',
        fontWeight:d?'480':'400',
        fontFamily:'"Cascadia Code","Fira Code","JetBrains Mono","SF Mono",Consolas,monospace',
        height:'100%'
      },
      '.cm-gutters':{
        backgroundColor:d?'#22222e':'#f3f1fb',
        color:d?'#6a6a7a':'#a8a2c2',
        borderRight:d?'1px solid #2e2e3a':'1px solid #e6e3f2'
      },
      '.cm-activeLineGutter':{backgroundColor:d?'#282836':'#ebe9f5',color:d?'#a0a0b0':'#5058A8'},
      '.cm-activeLine':{backgroundColor:d?'rgba(255,255,255,0.04)':'rgba(80,88,168,0.04)'},
      '.cm-cursor':{borderLeftColor:d?'#b0b0b8':'#5058A8'},
      '.cm-selectionBackground':{backgroundColor:d?'rgba(120,140,200,0.30)':'rgba(80,88,168,0.14)'},
      '.cm-line':{fontWeight:d?'480':'400'},
      '.cm-gutterElement':{fontWeight:d?'400':'400'},
    },{dark:d});}

  function _bindCtx(parent, pIdx) {
    parent.addEventListener('contextmenu', e => { e.preventDefault(); _ctxMenu(e.clientX, e.clientY, pIdx); });
  }

  function _ctxMenu(x, y, pIdx) {
    const pi = (pIdx !== undefined) ? pIdx : activePanel;
    const p = panels[pi];
    const f = p.activeFileIndex >= 0 ? p.openFiles[p.activeFileIndex] : null;
    const canPreview = f && (f.ext === 'md' || f.ext === 'html');

    const items = [];
    items.push({ label: '保存', action: () => saveFile(pi) });
    if (canPreview) items.push({ label: p.previewMode ? '返回编辑' : '预览', action: () => togglePreview(pi) });
    items.push({ sep: true });
    items.push({ label: '关闭文件', action: () => closeFile(p.activeFileIndex, pi) });

    App.showContextMenu(x, y, items);
  }

  // ── 分屏拖拽手柄 ──
  function _bindSplitHandle() {
    const handle = document.getElementById('editorSplitHandle');
    if (!handle || handle.dataset.bound) return;
    handle.dataset.bound = '1';
    handle.addEventListener('mousedown', e => {
      e.preventDefault(); handle.classList.add('dragging');
      const sx = e.clientX;
      const p0 = document.getElementById('editorPanel0');
      if (!p0) return;
      const sw = p0.offsetWidth;
      function mv(ev) {
        const w = Math.max(200, Math.min(sw + (ev.clientX - sx), window.innerWidth - 260));
        p0.style.flex = 'none'; p0.style.width = w + 'px';
      }
      function up() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        refresh();
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function _toast(msg, type) { if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type); }

  // ── 公开 API ──
  return {
    mount, destroy,
    openFile, openFileInSide, openBinary, openFileInPanel,
    switchFile, closeFile, saveFile, togglePreview,
    toggleSplit, focusPanel,
    refresh, refreshUI,
    getOpenFiles: () => panels[activePanel].openFiles,
    getAllOpenFiles: () => [...panels[0].openFiles, ...panels[1].openFiles],
    getActiveFile: () => {
      const p = panels[activePanel];
      return p.activeFileIndex >= 0 ? p.openFiles[p.activeFileIndex] : null;
    },
    getSplitActive: () => splitActive,
    getActivePanel: () => activePanel,
    saveAllFiles: async () => {
      for (let i = 0; i < 2; i++) await saveFile(i);
    },
  };
})();
