/* ============================================================
   chat.js v5 — 真实 AI 流式聊天

   模式切换：ask / plan / auto（当前均透传用户消息到 AI）
   模型切换：从已启用的供应商中选择模型
   发送后锁定模式+模型，需新建对话才能更改
   流式回复统一用 info 气泡包裹渲染
   AI 消息使用 {info, action, warning, success, error, options} 类型
   连续 AI 消息不重复头像
   ============================================================ */

const Chat = (() => {
  let conversations = [];
  let activeConversationId = null;
  let isGenerating = false;
  let lastRole = null;

  // 当前对话的模式和模型
  let chatMode = 'ask';
  let chatModelProviderId = null;   // provider_id
  let chatModelName = null;         // 具体的 model_name
  let chatLocked = false;           // 发送消息后锁定
  let abortController = null;

  function mount() {
    _loadFromStorage();
    if (conversations.length === 0) _createConversation('新对话');
    _renderConversationList();
    _switchConversation(activeConversationId || conversations[0]?.id);
    _loadModelSelector();
    _updateToolbarState();
  }

  function destroy() {
    if (abortController) { abortController.abort(); abortController = null; }
    _saveToStorage();
    lastRole = null;
  }

  // ===== 模式 & 模型管理 =====

  async function _loadModelSelector() {
    const select = document.getElementById('chatModelSelect');
    if (!select) return;

    select.innerHTML = '<option value="">加载中...</option>';

    try {
      const providers = await api.get('/api/providers');
      const enabledProviders = (providers || []).filter(p => p.is_enabled);
      const options = [];

      for (const p of enabledProviders) {
        const enabledModels = (p.models || []).filter(m => m.is_enabled);
        for (const m of enabledModels) {
          const value = `${p.id}::${m.model_name}`;
          options.push({ value, label: `${p.name} · ${m.display_name || m.model_name}`, providerId: p.id, modelName: m.model_name });
        }
      }

      if (options.length === 0) {
        select.innerHTML = '<option value="">无可用模型（请先去设置页配置供应商）</option>';
        return;
      }

      select.innerHTML = options.map(o => `<option value="${o.value}">${_esc(o.label)}</option>`).join('');

      // 恢复上次选择或默认
      if (chatModelProviderId && chatModelName) {
        const matchVal = `${chatModelProviderId}::${chatModelName}`;
        if (select.querySelector(`option[value="${matchVal}"]`)) {
          select.value = matchVal;
          return;
        }
      }
      // 默认选第一个
      select.selectedIndex = 0;
      const firstVal = select.value;
      if (firstVal) {
        const [pid, mname] = firstVal.split('::');
        chatModelProviderId = pid;
        chatModelName = mname;
      }
    } catch (_) {
      select.innerHTML = '<option value="">加载失败</option>';
    }
  }

  function setMode(mode) {
    if (chatLocked) return;
    chatMode = mode;
    document.querySelectorAll('.chat-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  function setModel(value) {
    if (chatLocked) return;
    if (!value) return;
    const [pid, mname] = value.split('::');
    if (pid && mname) {
      chatModelProviderId = pid;
      chatModelName = mname;
    }
  }

  function _lock() {
    chatLocked = true;
    _updateToolbarState();
  }

  function _unlock() {
    chatLocked = false;
    _updateToolbarState();
  }

  function _updateToolbarState() {
    const modeBtns = document.querySelectorAll('.chat-mode-btn');
    const select = document.getElementById('chatModelSelect');
    modeBtns.forEach(b => { b.disabled = chatLocked; b.style.opacity = chatLocked ? '0.5' : ''; b.style.pointerEvents = chatLocked ? 'none' : ''; });
    if (select) { select.disabled = chatLocked; select.style.opacity = chatLocked ? '0.5' : ''; select.style.pointerEvents = chatLocked ? 'none' : ''; }
  }

  // ===== 对话 CRUD =====

  function _createConversation(title = '新对话') {
    const conv = {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title, messages: [],
      model: chatModelName || 'deepseek-v4-flash',
      providerId: chatModelProviderId || '',
      mode: chatMode,
      createdAt: new Date().toISOString(),
    };
    conversations.unshift(conv);
    _saveToStorage();
    _unlock();
    return conv;
  }

  function deleteConversation(id) {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    const name = conv.title || '此对话';
    _showConfirmModal(`确定要删除「${name}」吗？`, '删除后无法恢复。', () => {
      conversations = conversations.filter(c => c.id !== id);
      if (activeConversationId === id) activeConversationId = conversations[0]?.id || null;
      _saveToStorage(); _renderConversationList();
      if (activeConversationId) _switchConversation(activeConversationId);
      else { const nc = _createConversation('新对话'); _renderConversationList(); _switchConversation(nc.id); }
    });
  }

  function _showConfirmModal(title, desc, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-dialog"><h3>${title}</h3><p>${desc}</p><div class="modal-actions"><button class="btn btn-ghost" id="modalCancel">取消</button><button class="btn btn-accent" id="modalConfirm">确认删除</button></div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#modalCancel').onclick = () => overlay.remove();
    overlay.querySelector('#modalConfirm').onclick = () => { overlay.remove(); onConfirm(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); } });
  }

  /** 弹窗提醒用户先打开工作区文件夹 */
  function _showWorkspaceRequiredModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-dialog" style="max-width:420px;">
        <h3>需要工作区</h3>
        <p>Plan / Auto 模式可能会操作文件，请先在左侧文件树打开一个文件夹作为工作区。</p>
        <p style="font-size:0.8rem;color:var(--text-tip);margin-top:4px;">即使是一个空文件夹也可以，Agent 只会在此文件夹内操作文件。</p>
        <div class="modal-actions" style="margin-top:16px;">
          <button class="btn btn-ghost" id="wsModalCancel">取消</button>
          <button class="btn btn-primary" id="wsModalOpen">打开文件夹</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#wsModalCancel').onclick = () => overlay.remove();
    overlay.querySelector('#wsModalOpen').onclick = () => {
      overlay.remove();
      if (typeof FileExplorer !== 'undefined') FileExplorer.openFolder();
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
    });
  }

  function _getActiveConversation() { return conversations.find(c => c.id === activeConversationId) || null; }

  function _switchConversation(id) {
    activeConversationId = id; lastRole = null;
    const conv = _getActiveConversation();
    if (!conv) return;
    // 恢复该对话的模式和模型
    if (conv.mode) chatMode = conv.mode;
    if (conv.providerId) chatModelProviderId = conv.providerId;
    if (conv.model) chatModelName = conv.model;
    // 如果该对话有用户消息，锁定
    const hasUserMsg = (conv.messages || []).some(m => m.role === 'user');
    if (hasUserMsg) { _lock(); } else { _unlock(); }
    // 恢复 UI
    setMode(chatMode);
    if (chatModelProviderId && chatModelName) {
      const select = document.getElementById('chatModelSelect');
      if (select) {
        const val = `${chatModelProviderId}::${chatModelName}`;
        if (select.querySelector(`option[value="${val}"]`)) select.value = val;
      }
    }
    _renderMessages(conv.messages);
    _renderConversationList();
    _scrollToBottom();
  }

  // ===== 发送消息（真实 API）=====

  async function sendMessage(content) {
    if (isGenerating || !content?.trim()) return;
    const conv = _getActiveConversation();
    if (!conv) return;

    // 如果没有设置模型，提示用户
    if (!chatModelProviderId || !chatModelName) {
      _showToast('请先在输入框右下角选择模型', 'warning');
      return;
    }

    // Plan / Auto 模式：必须有工作区
    if (chatMode === 'plan' || chatMode === 'agent') {
      const wsRoot = window.__lubina_workspace_root;
      if (!wsRoot) {
        _showWorkspaceRequiredModal();
        return;
      }
    }

    // 所有检查通过，清空输入框（在这之前 sendMessage 可能因各种检查提前 return）
    const inp = document.getElementById('chatInput');
    if (inp) { inp.value = ''; inp.style.height = 'auto'; }

    // 锁定模式和模型
    _lock();
    conv.mode = chatMode;
    conv.providerId = chatModelProviderId;
    conv.model = chatModelName;

    // 添加用户消息
    conv.messages.push({ role: 'user', type: 'user', content: content.trim(), timestamp: Date.now() });
    if (conv.messages.filter(m => m.role === 'user').length === 1) {
      conv.title = content.trim().slice(0, 20) + (content.trim().length > 20 ? '…' : '');
    }
    _renderMessages(conv.messages); _renderConversationList(); _scrollToBottom();
    isGenerating = true;
    _updateInputState(true);

    // 创建流式 AI 消息占位（info 类型气泡）
    const aiMsg = { role: 'assistant', type: 'info', content: '', timestamp: Date.now(), streaming: true, thinking: true, startTime: Date.now() };
    conv.messages.push(aiMsg);

    // 构建消息历史（只发 role + content）
    const apiMessages = conv.messages
      .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.streaming && m.content))
      .map(m => ({ role: m.role, content: m.content }));

    try {
      // 先渲染一次（用户气泡 + 空的 AI 占位气泡）
      _renderMessages(conv.messages);
      _scrollToBottom();

      // 流式渲染节流：每 ~60ms 更新一次 DOM，避免每字闪烁
      let throttleTimer = null;
      let pendingContent = '';

      abortController = await _chatStream({
        messages: apiMessages,
        providerId: chatModelProviderId,
        model: chatModelName,
        mode: chatMode,
        onDelta: (delta) => {
          // 首个 token 到达：结束思考计时，记录耗时
          if (aiMsg.thinking) {
            aiMsg.thinking = false;
            aiMsg.thinkingTime = ((Date.now() - aiMsg.startTime) / 1000).toFixed(1);
            // 全量重建以移除"思考中……"占位，显示思考耗时
            _renderMessages(conv.messages);
          }
          aiMsg.content += delta;
          pendingContent += delta;

          if (!throttleTimer) {
            throttleTimer = setTimeout(() => {
              throttleTimer = null;
              // 直接更新最后一个气泡的 markdown-body，不重建整个消息列表
              _updateLastBubble(aiMsg);
              _scrollToBottom();
            }, 60);
          }
        },
        onDone: () => {
          // 清除待处理的节流，立即渲染最终状态
          if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
          aiMsg.thinking = false;
          aiMsg.streaming = false;
          // 无内容兜底
          if (!aiMsg.content) aiMsg.content = '（AI 未返回内容）';
          _updateLastBubble(aiMsg);
          _scrollToBottom();
          isGenerating = false;
          abortController = null;
          _updateInputState(false);
          _saveToStorage();
          _notifyIfAway();
        },
        onError: (err) => {
          if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
          aiMsg.thinking = false;
          aiMsg.type = 'error';
          aiMsg.content = aiMsg.content || `错误：${err.message || '请求失败'}`;
          if (!aiMsg.content.startsWith('错误')) aiMsg.content = `错误：${aiMsg.content}`;
          aiMsg.streaming = false;
          isGenerating = false;
          abortController = null;
          _updateInputState(false);
          // 错误时做全量重建（因为类型变了）
          _renderMessages(conv.messages);
          _saveToStorage();
        },
      });
    } catch (err) {
      aiMsg.thinking = false;
      aiMsg.type = 'error';
      aiMsg.content = `错误：${err.message || '请求失败'}`;
      aiMsg.streaming = false;
      isGenerating = false;
      abortController = null;
      _updateInputState(false);
      _renderMessages(conv.messages);
      _saveToStorage();
    }
  }

  function stopGenerating() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    isGenerating = false;
    const conv = _getActiveConversation();
    if (conv) {
      const last = conv.messages[conv.messages.length - 1];
      if (last?.streaming) {
        last.streaming = false;
        last.thinking = false;
        if (!last.content) last.content = '（已停止）';
      }
    }
    _updateInputState(false);
    _renderMessages((conv && conv.messages) || []);
    _saveToStorage();
  }

  // ===== 流式 API 调用（前端直连后端 /api/chat/completions）=====

  async function _chatStream(options) {
    const { messages, providerId, model, mode, onDelta, onDone, onError } = options;
    const controller = new AbortController();

    try {
      const response = await fetch(`${API_BASE}/api/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, provider_id: providerId, model, mode, stream: true, sandbox_root: window.__lubina_workspace_root || null }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errMsg = `请求失败 (${response.status})`;
        try {
          const errBody = await response.json();
          errMsg = errBody.message || errMsg;
        } catch (_) {}
        onError(new Error(errMsg));
        return controller;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') { onDone(); return controller; }
          try {
            const json = JSON.parse(data);
            // 检查是否是错误消息
            if (json.error) {
              onError(new Error(json.message || 'API 返回错误'));
              return controller;
            }
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) onDelta(delta);
          } catch (_) { /* 忽略解析失败的行 */ }
        }
      }
      onDone();
    } catch (err) {
      if (err.name !== 'AbortError') onError(err);
    }

    return controller;
  }

  function _notifyIfAway() {
    if (typeof App !== 'undefined' && App.getState().activePage !== 'home') App.addUnread(1);
  }

  // ===== 渲染消息（连续AI不重复头像）=====

  function _renderMessages(messages) {
    const container = document.getElementById('messageContainer');
    if (!container) return;
    container.innerHTML = '';
    if (messages.length === 0) { container.innerHTML = _welcomeHTML(); lastRole = null; return; }

    let prevRole = null;
    messages.forEach((msg, index) => {
      const isUser = msg.role === 'user';
      const row = document.createElement('div');
      row.className = `message-row ${isUser ? 'user' : 'assistant'}`;
      row.setAttribute('data-index', index);

      const showAvatar = isUser || (prevRole !== 'assistant');
      const avatarCls = showAvatar ? (isUser ? 'user' : 'ai') : 'ghost';
      const avatarLabel = isUser ? '你' : 'AI';

      if (isUser) {
        row.innerHTML = `<div class="msg-avatar ${avatarCls}">${avatarLabel}</div><div class="msg-bubble user-bubble">${_esc(msg.content)}</div>`;
      } else {
        row.innerHTML = `<div class="msg-avatar ${avatarCls}">${avatarLabel}</div><div class="msg-body">${_renderAIBubble(msg)}</div>`;
      }
      container.appendChild(row);
      prevRole = msg.role;
    });
    lastRole = messages[messages.length - 1]?.role || null;
    _scrollToBottom();
  }

  function _renderAIBubble(msg) {
    const type = msg.type || 'info';
    const typeLabels = {
      info: { label: '', cls: 'ai-info' },
      action: { label: '操作中……', cls: 'ai-action' },
      warning: { label: '需要你的确认', cls: 'ai-warning' },
      success: { label: '操作完成', cls: 'ai-success' },
      error: { label: '请求失败', cls: 'ai-error' },
      options: { label: '请选择一个选项', cls: 'ai-option' },
    };
    const tl = typeLabels[type] || typeLabels.info;
    let extra = '';

    // 思考中……占位（无内容时呼吸动画）
    if (msg.thinking && !msg.content) {
      extra += `<div class="thinking-state">思考中……</div>`;
    }

    // 思考耗时（思考结束且有内容时显示）
    if (msg.thinkingTime && !msg.thinking && msg.content) {
      extra += `<div class="thinking-time">已思考 ${msg.thinkingTime} 秒</div>`;
    }

    // action label（streaming 时带呼吸动画）
    if (tl.label) {
      const animCls = (type === 'action' && msg.streaming) ? ' thinking-state' : '';
      extra += `<div class="action-label${animCls}">${tl.label}</div>`;
    }

    // Markdown 内容
    let mdContent = msg.content || '';
    if (typeof marked !== 'undefined') {
      try { mdContent = marked.parse(msg.content || '') || ''; } catch (_) { mdContent = _esc(msg.content || ''); }
    }

    // 流式光标（思考中不显示光标，只有"思考中……"文字）
    if (msg.streaming && !msg.thinking) {
      mdContent += '<span class="typing-cursor"></span>';
    }

    if (type === 'warning') extra += `<div class="confirm-actions"><button class="confirm-btn confirm-btn-allow" onclick="Chat.confirmAction(true)">确认执行</button><button class="confirm-btn confirm-btn-deny" onclick="Chat.confirmAction(false)">取消</button></div>`;
    if (type === 'options' && msg.options) {
      const btns = msg.options.map(o => `<button class="option-btn" onclick="Chat.selectOption('${_escAttr(o.value)}')">${_esc(o.label)}</button>`).join('');
      extra += `<div class="option-buttons">${btns}</div>`;
    }

    return `<div class="msg-bubble ai-bubble ${tl.cls}">${extra}<div class="markdown-body">${mdContent}</div></div>`;
  }

  /** 直接更新最后一个 AI 气泡的内容（不做全量重建，避免闪烁） */
  function _updateLastBubble(msg) {
    const container = document.getElementById('messageContainer');
    if (!container) return;

    // 找到最后一条 assistant 消息行
    const rows = container.querySelectorAll('.message-row.assistant');
    const lastRow = rows[rows.length - 1];
    if (!lastRow) return;

    // 如果思考状态已结束但气泡中仍有思考占位，移除它
    if (!msg.thinking) {
      const thinkingEl = lastRow.querySelector('.thinking-state');
      if (thinkingEl) thinkingEl.remove();
      // 如果有思考耗时但尚未显示，通过全量重建来展示
      if (msg.thinkingTime && !lastRow.querySelector('.thinking-time')) {
        // 无法局部插入，标记需要重建
        const conv = _getActiveConversation();
        if (conv) _renderMessages(conv.messages);
        return;
      }
    }

    const mdBody = lastRow.querySelector('.markdown-body');
    if (!mdBody) return;

    // 渲染 Markdown
    let mdContent = msg.content || '';
    if (typeof marked !== 'undefined') {
      try { mdContent = marked.parse(msg.content || '') || ''; } catch (_) { mdContent = _esc(msg.content || ''); }
    }

    // 流式光标（思考中不显示）
    if (msg.streaming && !msg.thinking) {
      mdContent += '<span class="typing-cursor"></span>';
    }

    mdBody.innerHTML = mdContent;
  }

  function _renderConversationList() {
    const list = document.getElementById('conversationList');
    if (!list) return;
    list.innerHTML = conversations.map(conv => `
      <div class="conv-item ${conv.id === activeConversationId ? 'active' : ''}" onclick="Chat.switchTo('${conv.id}')">
        <svg class="conv-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span class="conv-item-title">${_esc(conv.title)}</span>
        <button class="conv-item-delete" onclick="event.stopPropagation();Chat.deleteConversation('${conv.id}')" title="删除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    `).join('');
  }

  function _welcomeHTML() {
    return `<div class="welcome-screen">
      <img class="welcome-logo" src="/Lubina.svg" alt="Lubina" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" style="width:64px;height:64px;border-radius:18px;object-fit:contain;background:var(--primary-gradient);padding:10px;box-shadow:0 6px 24px var(--primary-glow);animation:floatLogo 3s ease-in-out infinite;">
      <div class="welcome-logo" style="display:none;">AI</div>
      <h2>Lubina</h2>
      <p>你的桌面学习伙伴</p>
    </div>`;
  }

  function _updateInputState(disabled) {
    const sb = document.getElementById('sendBtn');
    const tb = document.getElementById('stopBtn');
    const inp = document.getElementById('chatInput');
    if (sb) { sb.classList.toggle('hidden', disabled); sb.disabled = disabled; }
    if (tb) { tb.classList.toggle('hidden', !disabled); tb.disabled = !disabled; }
    if (inp) inp.disabled = disabled;
  }

  // ===== 辅助 =====

  function _scrollToBottom() {
    requestAnimationFrame(() => {
      const c = document.getElementById('messageContainer');
      if (c) c.scrollTop = c.scrollHeight;
    });
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function _escAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function _showToast(msg, type) {
    if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type || 'info');
  }

  function _loadFromStorage() {
    try {
      const d = localStorage.getItem('lubina_conversations');
      if (d) {
        conversations = JSON.parse(d);
        conversations.forEach(c => c.messages.forEach(m => m.streaming = false));
        if (conversations.length > 0) activeConversationId = conversations[0].id;
      }
    } catch (_) { conversations = []; }
  }

  function _saveToStorage() {
    try {
      const cleaned = conversations.map(function (c) {
        return {
          id: c.id, title: c.title, model: c.model, providerId: c.providerId, mode: c.mode, createdAt: c.createdAt,
          messages: c.messages.map(function (m) {
            return { role: m.role, type: m.type, content: m.content, timestamp: m.timestamp, action: m.action, options: m.options, streaming: false };
          })
        };
      });
      localStorage.setItem('lubina_conversations', JSON.stringify(cleaned));
    } catch (_) { }
  }

  // ===== 公开 API =====

  return {
    mount, destroy,
    sendMessage, stopGenerating,
    setMode, setModel,
    switchTo: _switchConversation,
    deleteConversation,
    newConversation: () => {
      const conv = _createConversation('新对话');
      _renderConversationList();
      _switchConversation(conv.id);
      const inp = document.getElementById('chatInput');
      if (inp) inp.focus();
    },
  };
})();
