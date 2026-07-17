/* ============================================================
   chat.js v7 — 对话级状态 + 错误恢复 + 消息队列 + 右键菜单 + 分支

   模式切换：ask / plan / auto（当前均透传用户消息到 AI）
   模型切换：从已启用的供应商中选择模型
   发送后锁定模式+模型，需新建对话才能更改
   流式回复统一用 info 气泡包裹渲染
   AI 消息使用 {info, action, warning, success, error, options} 类型
   连续 AI 消息不重复头像

   v7 新特性：
   - 输入框内容页面级持久化（切换页面再回来保留）
   - 对话切换去重（已激活对话不重复切换）
   - 对话右键菜单：打开/置顶/删除/创建分支
   - 新建对话去重（已有空对话时不重复创建）
   ============================================================ */

const Chat = (() => {
  let conversations = [];
  let activeConversationId = null;
  let lastRole = null;
  let _savedInput = '';  // 页面级输入框持久化

  // 当前对话的模式和模型（UI 选择状态，发送时同步到 conv）
  let chatMode = 'ask';
  let chatModelProviderId = null;   // provider_id
  let chatModelName = null;         // 具体的 model_name

  function mount() {
    _loadFromStorage();
    // 首次启动（无任何对话）才自动创建；已有对话则恢复上次活跃的
    if (conversations.length === 0) {
      _createConversation('新对话');
      activeConversationId = conversations[0].id;
    } else if (!activeConversationId) {
      // 上次活跃对话丢失（如旧数据）→ 找空对话或第一个
      const empty = conversations.find(c => !(c.messages || []).some(m => m.role === 'user'));
      activeConversationId = empty ? empty.id : conversations[0].id;
    }
    _renderConversationList();
    _switchConversation(activeConversationId);
    _loadModelSelector();
    _updateToolbarState();
    _restoreInput();
  }

  function destroy() {
    // 保存输入框内容
    const inp = document.getElementById('chatInput');
    if (inp) _savedInput = inp.value;
    // Abort 所有正在生成的对话
    conversations.forEach(c => {
      if (c.abortController) { c.abortController.abort(); c.abortController = null; }
      c.isGenerating = false;
      c._queue = [];
    });
    _saveToStorage();
    lastRole = null;
  }

  // ===== 输入框持久化 =====

  function _restoreInput() {
    setTimeout(() => {
      const inp = document.getElementById('chatInput');
      if (inp && _savedInput) {
        inp.value = _savedInput;
        inp.style.height = 'auto';
        inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
      }
    }, 80);
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
    const conv = _getActiveConversation();
    if (conv && conv.locked) return;
    chatMode = mode;
    document.querySelectorAll('.chat-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  function setModel(value) {
    const conv = _getActiveConversation();
    if (conv && conv.locked) return;
    if (!value) return;
    const [pid, mname] = value.split('::');
    if (pid && mname) {
      chatModelProviderId = pid;
      chatModelName = mname;
    }
  }

  function _lock() {
    const conv = _getActiveConversation();
    if (conv) conv.locked = true;
    _updateToolbarState();
  }

  function _unlock() {
    const conv = _getActiveConversation();
    if (conv) conv.locked = false;
    _updateToolbarState();
  }

  function _updateToolbarState() {
    const conv = _getActiveConversation();
    const locked = conv ? conv.locked : false;
    const modeBtns = document.querySelectorAll('.chat-mode-btn');
    const select = document.getElementById('chatModelSelect');
    modeBtns.forEach(b => { b.disabled = locked; b.style.opacity = locked ? '0.5' : ''; b.style.pointerEvents = locked ? 'none' : ''; });
    if (select) { select.disabled = locked; select.style.opacity = locked ? '0.5' : ''; select.style.pointerEvents = locked ? 'none' : ''; }
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
      pinned: false,
      // v7：每个对话自身的状态
      isGenerating: false,
      locked: false,
      abortController: null,
      _queue: [],        // 排队消息（不持久化）
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
      // Abort 正在生成的目标对话
      if (conv.abortController) { conv.abortController.abort(); conv.abortController = null; }
      conversations = conversations.filter(c => c.id !== id);
      if (activeConversationId === id) activeConversationId = conversations[0]?.id || null;
      _saveToStorage(); _renderConversationList();
      if (activeConversationId) _switchConversation(activeConversationId);
      else { const nc = _createConversation('新对话'); _renderConversationList(); _switchConversation(nc.id); }
    });
  }

  /** 分支标题：原标题(n)，已经是(n)结尾则 n+1 */
  function _branchTitle(title) {
    title = (title || '新对话').replace(/\s*\(分支\)$/, '').trim();
    const m = title.match(/\((\d+)\)\s*$/);
    if (m) {
      const n = parseInt(m[1], 10) + 1;
      return title.replace(/\((\d+)\)\s*$/, `(${n})`);
    }
    return title + '(1)';
  }

  /** 创建分支：完全复制对话内容，新 ID，供用户向不同方向发展 */
  function branchConversation(id) {
    const src = conversations.find(c => c.id === id);
    if (!src) return;
    const conv = {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: _branchTitle(src.title || '新对话'),
      messages: src.messages.map(m => ({
        role: m.role, type: m.type, content: m.content, timestamp: m.timestamp,
        action: m.action, options: m.options, streaming: false,
        tool: m.tool, toolDetail: m.toolDetail, toolHuman: m.toolHuman,
        toolResult: m.toolResult, toolResultHuman: m.toolResultHuman,
      })),
      model: src.model, providerId: src.providerId, mode: src.mode,
      createdAt: new Date().toISOString(),
      pinned: false,
      isGenerating: false,
      locked: (src.messages || []).some(m => m.role === 'user'),
      abortController: null,
      _queue: [],
    };
    conversations.unshift(conv);
    _saveToStorage();
    _renderConversationList();
    _switchConversation(conv.id);
  }

  /** 置顶/取消置顶 */
  function togglePinConversation(id) {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    conv.pinned = !conv.pinned;
    _saveToStorage();
    _renderConversationList();
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
    // 已在当前对话且消息区有内容 → 不重复渲染
    if (id === activeConversationId) {
      const container = document.getElementById('messageContainer');
      if (container && container.children.length > 0) return;
    }
    activeConversationId = id; lastRole = null;
    const conv = _getActiveConversation();
    if (!conv) return;
    // 恢复该对话的模式和模型
    if (conv.mode) chatMode = conv.mode;
    if (conv.providerId) chatModelProviderId = conv.providerId;
    if (conv.model) chatModelName = conv.model;
    // 如果该对话有用户消息，锁定
    const hasUserMsg = (conv.messages || []).some(m => m.role === 'user');
    if (hasUserMsg) { conv.locked = true; } else { conv.locked = false; }
    _updateToolbarState();
    // 恢复该对话的输入状态
    _updateInputState(conv.isGenerating);
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

  // ===== 发送消息（v7：两路 —— 排队 / 正常发送）=====

  async function sendMessage(content) {
    if (!content?.trim()) return;
    const conv = _getActiveConversation();
    if (!conv) return;

    // 如果没有设置模型，提示用户
    if (!chatModelProviderId || !chatModelName) {
      _showToast('请先在输入框右下角选择模型', 'warning');
      return;
    }

    // Plan / Auto 模式：必须有工作区
    if (chatMode === 'plan' || chatMode === 'agent') {
      const wsRoot = window.__lubia_workspace_root;
      if (!wsRoot) {
        _showWorkspaceRequiredModal();
        return;
      }
    }

    // 所有检查通过，清空输入框
    const inp = document.getElementById('chatInput');
    if (inp) { inp.value = ''; inp.style.height = 'auto'; }
    _savedInput = '';  // 已发送，清除持久化内容

    // 锁定模式和模型（到当前对话）
    conv.mode = chatMode;
    conv.providerId = chatModelProviderId;
    conv.model = chatModelName;
    conv.locked = true;
    _updateToolbarState();

    // ── 路径 A：对话正在生成 → 消息入队 ──
    if (conv.isGenerating) {
      conv._queue.push({ content: content.trim(), timestamp: Date.now() });
      _appendQueuedMessage(content.trim());
      _saveToStorage();
      return;
    }

    // ── 路径 B：正常发送 ──
    // 添加用户消息
    conv.messages.push({ role: 'user', type: 'user', content: content.trim(), timestamp: Date.now() });
    if (conv.messages.filter(m => m.role === 'user').length === 1) {
      conv.title = content.trim().slice(0, 20) + (content.trim().length > 20 ? '…' : '');
    }
    _renderMessages(conv.messages); _renderConversationList(); _scrollToBottom();
    conv.isGenerating = true;
    _updateInputState(true);

    // 创建流式 AI 消息占位（info 类型气泡）
    const aiMsg = { role: 'assistant', type: 'info', content: '', timestamp: Date.now(), streaming: true, thinking: true, startTime: Date.now() };
    conv.messages.push(aiMsg);

    // 构建消息历史（只发 role + content，不含 streaming 中的消息）
    const apiMessages = conv.messages
      .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.streaming && m.content))
      .map(m => ({ role: m.role, content: m.content }));

    // 先渲染一次（用户气泡 + 空的 AI 占位气泡）
    _renderMessages(conv.messages);
    _scrollToBottom();

    _doStreamSend(conv, apiMessages, aiMsg);
  }

  // ===== 核心流式发送逻辑（从 sendMessage 抽取，供 sendMessage 和 _flushQueue 复用）=====

  /** 工具操作的人类可读标签 */
  function _toolLabel(tool, args, isResult) {
    const labels = {
      knowledge_grep: {
        detail: `检索知识库：「${args?.query || ''}」`,
        human: '正在翻阅你的知识库，查找相关信息……',
        done: '知识库检索完成',
      },
      knowledge_rag: {
        detail: `语义搜索知识库：「${args?.query || ''}」`,
        human: '正在用语义理解搜索知识库，匹配含义相近的内容……',
        done: '知识库语义搜索完成',
      },
      web_search: {
        detail: `联网搜索：「${args?.query || ''}」`,
        human: '正在网上搜索，稍等一下……',
        done: '联网搜索完成',
      },
      web_fetch: {
        detail: `读取网页：${args?.url || ''}`,
        human: '正在根据网址查询内容……',
        done: '网页内容读取完成',
      },
      list_files: {
        detail: `读取文件树：${args?.path || '根目录'}`,
        human: '正在查看你的工作区文件夹……',
        done: '文件树读取完成',
      },
      knowledge_import: {
        detail: `记住信息：${args?.content ? args.content.slice(0, 40) + '…' : ''}`,
        human: '发现了一条你不知道的信息，正在后台拆解归档……',
        done: '信息已归档，以后聊天时 Lubia 会记得',
      },
    };
    const l = labels[tool] || {
      detail: `${tool}：${JSON.stringify(args || {})}`,
      human: `正在使用 ${tool}……`,
      done: `${tool} 完成`
    };
    return { detail: l.detail, human: isResult ? l.done : l.human };
  }

  /** 格式化思考时间 */
  function _fmtThinking(seconds) {
    const s = parseFloat(seconds);
    if (!s || s <= 0) return '';
    if (s >= 60) {
      const m = Math.floor(s / 60);
      const sec = Math.round(s % 60);
      return sec > 0 ? `${m} 分 ${sec} 秒` : `${m} 分钟`;
    }
    return `${s.toFixed(1)} 秒`;
  }

  async function _doStreamSend(conv, apiMessages, aiMsg) {
    let throttleTimer = null;
    // 同工具连续调用时静默，不弹气泡
    // 工具分组：同组工具连续调用算重复（knowledge_grep + knowledge_rag 都是 "kb" 组）
    const _TOOL_GROUPS = { knowledge_grep: 'kb', knowledge_rag: 'kb' };
    let _lastReadGroup = '';
    let _silentMode = false;

    try {
      conv.abortController = await _chatStream({
        messages: apiMessages,
        providerId: conv.providerId,
        model: conv.model,
        mode: conv.mode,
        onDelta: (delta) => {
          _silentMode = false;
          if (aiMsg.thinking) {
            aiMsg.thinking = false;
            aiMsg.thinkingTime = _fmtThinking((Date.now() - aiMsg.startTime) / 1000);
            _renderMessages(conv.messages);
          }
          if (!conv.messages.includes(aiMsg)) {
            conv.messages.push(aiMsg);
          }
          aiMsg.content += delta;

          if (!throttleTimer) {
            throttleTimer = setTimeout(() => {
              throttleTimer = null;
              _updateLastBubble(aiMsg);
              _scrollToBottom();
            }, 60);
          }
        },
        onToolStart: (event) => {
          if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
          // 同组工具连续调用 → 静默，不弹气泡
          const group = _TOOL_GROUPS[event.tool] || event.tool;
          if (group === _lastReadGroup) {
            _silentMode = true;
            return;
          }
          _silentMode = false;
          _lastReadGroup = group;

          // 移除 AI 占位，插调用气泡
          const idx = conv.messages.indexOf(aiMsg);
          if (idx >= 0) conv.messages.splice(idx, 1);
          const { detail, human } = _toolLabel(event.tool, event.args, false);
          conv.messages.push({
            role: 'assistant', type: 'tool_call',
            tool: event.tool, toolDetail: detail,
            toolHuman: human,
            content: '', streaming: false,
            timestamp: Date.now(),
          });
          _renderMessages(conv.messages);
          _scrollToBottom();
        },
        onToolResult: (event) => {
          if (_silentMode) return;  // 静默模式不弹成功气泡
          const { human } = _toolLabel(event.tool, event.args, true);
          conv.messages.push({
            role: 'assistant', type: 'tool_result',
            tool: event.tool, toolResultHuman: human,
            content: '', streaming: false,
            timestamp: Date.now(),
          });
          // 重建 AI 占位
          if (!conv.messages.includes(aiMsg) && !aiMsg.content) {
            aiMsg.content = '';
            aiMsg.thinking = true;
            aiMsg.thinkingTime = undefined;
            aiMsg.streaming = true;
            aiMsg.startTime = Date.now();
            aiMsg.type = 'info';
            conv.messages.push(aiMsg);
            _renderMessages(conv.messages);
            _scrollToBottom();
          }
        },
        onToolError: (event) => {
          _silentMode = false;
          conv.messages.push({
            role: 'assistant', type: 'tool_error_msg',
            tool: event.tool || 'system',
            toolDetail: event.error || '工具执行出错',
            content: '', streaming: false, timestamp: Date.now(),
          });
          _renderMessages(conv.messages);
          _scrollToBottom();
        },
        onMaxRounds: (max) => {
          aiMsg.maxRoundsReached = max;
        },
        onDone: () => {
          if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
          aiMsg.thinking = false;
          aiMsg.streaming = false;
          if (!aiMsg.content) {
            const hasToolCall = conv.messages.some(m => m.type === 'tool_call' || m.type === 'tool_result');
            if (hasToolCall) {
              aiMsg.content = '（AI 未能生成回复，请重试或换一种方式提问）';
              aiMsg.type = 'error';
            } else {
              const idx = conv.messages.indexOf(aiMsg);
              if (idx >= 0) conv.messages.splice(idx, 1);
            }
          }
          if (aiMsg.content) {
            _updateLastBubble(aiMsg);
          }
          _scrollToBottom();
          conv.isGenerating = false;
          conv.abortController = null;
          _updateInputState(false);
          _saveToStorage();
          _notifyIfAway();
          _flushQueue(conv);
        },
        onError: (err) => {
          if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
          aiMsg.thinking = false;
          aiMsg.type = 'error';
          aiMsg.content = aiMsg.content || `错误：${err.message || '请求失败'}`;
          if (!aiMsg.content.startsWith('错误')) aiMsg.content = `错误：${aiMsg.content}`;
          aiMsg.streaming = false;
          conv.isGenerating = false;
          conv.abortController = null;
          _updateInputState(false);
          _renderMessages(conv.messages);
          _saveToStorage();
          _flushQueue(conv);
        },
      });
    } catch (err) {
      if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
      aiMsg.thinking = false;
      aiMsg.type = 'error';
      aiMsg.content = `错误：${err.message || '请求失败'}`;
      aiMsg.streaming = false;
      conv.isGenerating = false;
      conv.abortController = null;
      _updateInputState(false);
      _renderMessages(conv.messages);
      _saveToStorage();
      _flushQueue(conv);
    }
  }

  // ===== 消息队列 =====

  /** 在 UI 末尾追加排队气泡（仅视觉，不加入 conv.messages） */
  function _appendQueuedMessage(content) {
    const container = document.getElementById('messageContainer');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'message-row user queued';
    row.innerHTML = `<div class="msg-avatar user">你</div>
      <div class="msg-bubble user-bubble">${_esc(content)}
        <div class="queue-indicator">排队中…</div>
      </div>`;
    container.appendChild(row);
    _scrollToBottom();
  }

  /** 消费排队消息：加入对话 → 统一发送 */
  function _flushQueue(conv) {
    if (!conv._queue || conv._queue.length === 0) return;

    const queued = conv._queue.splice(0);

    // 将排队消息正式加入对话
    queued.forEach(q => {
      conv.messages.push({ role: 'user', type: 'user', content: q.content, timestamp: q.timestamp });
    });

    // 重建整个消息列表（排队气泡 → 正式气泡）
    _renderMessages(conv.messages);
    _scrollToBottom();

    // 构建完整上下文（含所有排队用户消息）
    const aiMsg = { role: 'assistant', type: 'info', content: '', timestamp: Date.now(), streaming: true, thinking: true, startTime: Date.now() };
    conv.messages.push(aiMsg);

    const apiMessages = conv.messages
      .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.streaming && m.content))
      .map(m => ({ role: m.role, content: m.content }));

    conv.isGenerating = true;
    _updateInputState(true);

    _doStreamSend(conv, apiMessages, aiMsg);
  }

  // ===== 停止生成 =====

  function stopGenerating() {
    const conv = _getActiveConversation();
    if (!conv) return;
    if (conv.abortController) {
      conv.abortController.abort();
      conv.abortController = null;
    }
    conv.isGenerating = false;
    conv._queue = [];   // 清空排队消息
    const last = conv.messages[conv.messages.length - 1];
    if (last?.streaming) {
      last.streaming = false;
      last.thinking = false;
      if (!last.content) last.content = '（已停止）';
    }
    _updateInputState(false);
    _renderMessages((conv && conv.messages) || []);
    _saveToStorage();
  }

  // ===== 流式 API 调用（Re-Act 模式，支持工具事件）=====

  async function _chatStream(options) {
    const { messages, providerId, model, mode, onDelta, onDone, onError, onToolStart, onToolResult, onToolError, onMaxRounds } = options;
    const controller = new AbortController();

    try {
      const response = await fetch(`${API_BASE}/api/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, provider_id: providerId, model, mode, stream: true, sandbox_root: window.__lubia_workspace_root || null }),
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

            // ── Re-Act 事件分发（必须在 error 检查之前）──
            if (json.type === 'tool_start') {
              if (onToolStart) onToolStart(json);
            } else if (json.type === 'tool_result') {
              if (onToolResult) onToolResult(json);
            } else if (json.type === 'tool_error') {
              if (onToolError) onToolError(json);
            } else if (json.type === 'delta') {
              const delta = json.content;
              if (delta) onDelta(delta);
            } else if (json.type === 'max_rounds') {
              if (onMaxRounds) onMaxRounds(json.max);
            } else if (json.type === 'thinking') {
              // thinking 状态，前端 placeholder 已处理
            } else if (json.type === 'done') {
              onDone(); return controller;
            } else if (json.error) {
              // 非 Re-Act 事件的错误消息
              onError(new Error(json.message || 'API 返回错误'));
              return controller;
            } else {
              // ── 兼容旧 OpenAI 格式 ──
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) onDelta(delta);
            }
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
      tool_call: { label: '', cls: 'ai-tool-call' },
      tool_result: { label: '', cls: 'ai-tool-result' },
      tool_error_msg: { label: '', cls: 'ai-tool-call' },
    };
    const tl = typeLabels[type] || typeLabels.info;
    let extra = '';

    // 思考中……占位（无内容时呼吸动画）
    if (msg.thinking && !msg.content) {
      extra += `<div class="thinking-state">思考中……</div>`;
    }

    // 思考耗时
    if (msg.thinkingTime && !msg.thinking && msg.content) {
      extra += `<div class="thinking-time">已思考 ${msg.thinkingTime}</div>`;
    }

    // 达到循环上限提醒
    if (msg.maxRoundsReached && !msg.thinking && msg.content) {
      extra += `<div class="thinking-time max-rounds-hint">已达本轮操作上限，可在设置中调高最大循环轮数</div>`;
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

    // 流式光标
    if (msg.streaming && !msg.thinking) {
      mdContent += '<span class="typing-cursor"></span>';
    }

    if (type === 'warning') extra += `<div class="confirm-actions"><button class="confirm-btn confirm-btn-allow" onclick="Chat.confirmAction(true)">确认执行</button><button class="confirm-btn confirm-btn-deny" onclick="Chat.confirmAction(false)">取消</button></div>`;
    if (type === 'options' && msg.options) {
      const btns = msg.options.map(o => `<button class="option-btn" onclick="Chat.selectOption('${_escAttr(o.value)}')">${_esc(o.label)}</button>`).join('');
      extra += `<div class="option-buttons">${btns}</div>`;
    }

    // 工具调用气泡：小字详情 + 白话说明
    if (type === 'tool_call') {
      return `<div class="msg-bubble ai-bubble ai-tool-call">
        <div class="tool-call-detail">${_esc(msg.toolDetail || '')}</div>
        <div class="tool-call-human">${_esc(msg.toolHuman || '')}</div>
      </div>`;
    }
    // 工具结果气泡：白话说明完成了什么
    if (type === 'tool_result') {
      return `<div class="msg-bubble ai-bubble ai-tool-result">
        <div class="tool-result-human">${_esc(msg.toolResultHuman || msg.toolHuman || '')}</div>
      </div>`;
    }
    // 工具错误气泡
    if (type === 'tool_error_msg') {
      return `<div class="msg-bubble ai-bubble ai-tool-call" style="border-color:var(--color-error);">
        <div class="tool-call-detail" style="color:var(--color-error);">${_esc(msg.toolDetail || '工具出错')}</div>
      </div>`;
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
      // 有新增的元信息（思考耗时 / 上限提示）→ 全量重建
      const hasNewMeta = (msg.thinkingTime && !lastRow.querySelector('.thinking-time'))
                      || (msg.maxRoundsReached && !lastRow.querySelector('.max-rounds-hint'));
      if (hasNewMeta) {
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

  // ===== 对话列表渲染（v7：置顶排序 + 右键菜单 + 上下文事件委托）=====

  /** 排序：置顶优先，然后按创建时间倒序 */
  function _sortedConversations() {
    return [...conversations].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  }

  function _renderConversationList() {
    const list = document.getElementById('conversationList');
    if (!list) return;
    const sorted = _sortedConversations();
    list.innerHTML = sorted.map(conv => `
      <div class="conv-item ${conv.id === activeConversationId ? 'active' : ''} ${conv.pinned ? 'pinned' : ''}"
           data-conv-id="${conv.id}"
           onclick="Chat.switchTo('${conv.id}')"
           oncontextmenu="Chat._onConvContextMenu(event, '${conv.id}')">
        <svg class="conv-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        ${conv.pinned ? '<svg class="conv-pin-icon" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>' : ''}
        <span class="conv-item-title">${_esc(conv.title)}</span>
        <button class="conv-item-delete" onclick="event.stopPropagation();Chat.deleteConversation('${conv.id}')" title="删除"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    `).join('');
  }

  /** 对话右键菜单 */
  function _onConvContextMenu(e, convId) {
    e.preventDefault();
    e.stopPropagation();
    const conv = conversations.find(c => c.id === convId);
    if (!conv) return;
    const isActive = convId === activeConversationId;

    const items = [];
    if (!isActive) items.push({ label: '打开', action: () => _switchConversation(convId) });
    items.push({ label: '重命名', action: () => _renameConversation(convId) });
    items.push({ label: conv.pinned ? '取消置顶' : '置顶', action: () => togglePinConversation(convId) });
    items.push({ label: '创建分支', action: () => branchConversation(convId) });
    items.push({ label: '删除', danger: true, action: () => deleteConversation(convId) });

    App.showContextMenu(e.clientX, e.clientY, items);
  }

  /** 重命名对话 */
  function _renameConversation(id) {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-dialog" style="max-width:360px;">
        <h3>重命名对话</h3>
        <input class="input" id="_renameInput" value="${_escAttr(conv.title || '')}" placeholder="输入新名称" style="width:100%;box-sizing:border-box;margin:8px 0;">
        <div class="modal-actions">
          <button class="btn btn-ghost" id="_renameCancel">取消</button>
          <button class="btn btn-primary" id="_renameConfirm">确认</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#_renameCancel').onclick = close;
    overlay.querySelector('#_renameConfirm').onclick = () => {
      const inp = document.getElementById('_renameInput');
      const name = (inp?.value || '').trim();
      if (name) {
        conv.title = name;
        _saveToStorage();
        _renderConversationList();
      }
      close();
    };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
      if (e.key === 'Enter') {
        const inp = document.getElementById('_renameInput');
        if (inp && document.activeElement === inp) {
          overlay.querySelector('#_renameConfirm').click();
        }
      }
    });
    setTimeout(() => {
      const inp = document.getElementById('_renameInput');
      if (inp) { inp.focus(); inp.select(); }
    }, 80);
  }

  function _welcomeHTML() {
    return `<div class="welcome-screen">
      <img class="welcome-logo" src="/Lubia.svg" alt="Lubia" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" style="width:64px;height:64px;border-radius:18px;object-fit:contain;background:var(--primary-gradient);padding:10px;box-shadow:0 6px 24px var(--primary-glow);animation:floatLogo 3s ease-in-out infinite;">
      <div class="welcome-logo" style="display:none;">AI</div>
      <h2>Lubia</h2>
      <p>你的桌面学习伙伴</p>
    </div>`;
  }

  function _updateInputState(disabled) {
    const tb = document.getElementById('stopBtn');
    const inp = document.getElementById('chatInput');
    // 停止按钮：生成时显示，空闲时隐藏
    if (tb) { tb.classList.toggle('hidden', !disabled); tb.disabled = !disabled; }
    // 发送按钮和输入框始终可用（生成时也能补充消息或排队发送）
    if (inp) inp.disabled = false;
    const sb = document.getElementById('sendBtn');
    if (sb) { sb.classList.remove('hidden'); sb.disabled = false; }
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
      const d = localStorage.getItem('lubia_conversations');
      if (d) {
        conversations = JSON.parse(d);
        conversations.forEach(c => {
          c.messages.forEach(m => { m.streaming = false; });
          // v6：为旧数据补充缺失字段
          if (c.isGenerating === undefined) c.isGenerating = false;
          if (c.locked === undefined) c.locked = (c.messages || []).some(m => m.role === 'user');
          if (c.pinned === undefined) c.pinned = false;
          c.abortController = null;
          c._queue = [];
          // v6：错误恢复 —— 空内容的 assistant 消息标为 error
          c.messages.forEach(m => {
            // 工具调用气泡无文本内容是正常的，不标为 error
            if (m.role === 'assistant' && !m.content?.trim() && m.type !== 'tool_call' && m.type !== 'tool_result') {
              m.type = 'error';
              m.content = '消息发送失败，未获取到 AI 回复。请检查网络连接后重试。';
            }
          });
        });
        // 只在当前会话还没选中对话时才恢复（保留页面切换间的状态）
        if (!activeConversationId && conversations.length > 0) activeConversationId = conversations[0].id;
      }
    } catch (_) { conversations = []; }
  }

  function _saveToStorage() {
    try {
      const cleaned = conversations.map(function (c) {
        return {
          id: c.id, title: c.title, model: c.model, providerId: c.providerId,
          mode: c.mode, createdAt: c.createdAt, pinned: c.pinned,
          messages: c.messages.map(function (m) {
            return {
              role: m.role, type: m.type, content: m.content, timestamp: m.timestamp,
              action: m.action, options: m.options, streaming: false,
              tool: m.tool, toolDetail: m.toolDetail, toolHuman: m.toolHuman, toolResult: m.toolResult, toolResultHuman: m.toolResultHuman,
            };
          })
        };
      });
      localStorage.setItem('lubia_conversations', JSON.stringify(cleaned));
    } catch (_) { }
  }

  // ===== 公开 API =====

  return {
    mount, destroy,
    sendMessage, stopGenerating,
    setMode, setModel,
    get isGenerating() {
      const conv = _getActiveConversation();
      return conv ? conv.isGenerating : false;
    },
    switchTo: _switchConversation,
    deleteConversation,
    branchConversation,
    togglePinConversation,
    _onConvContextMenu,  // 供 oncontextmenu 调用
    newConversation: () => {
      // 如果已有空对话（没发过消息），直接切过去，不重复创建
      const empty = conversations.find(c => !(c.messages || []).some(m => m.role === 'user'));
      if (empty) {
        _switchConversation(empty.id);
        const inp = document.getElementById('chatInput');
        if (inp) inp.focus();
        return;
      }
      const conv = _createConversation('新对话');
      _renderConversationList();
      _switchConversation(conv.id);
      const inp = document.getElementById('chatInput');
      if (inp) inp.focus();
    },
  };
})();
