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
  let _pinned = false; // 是否已把用户消息固定在顶部

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
    // 拦截聊天区所有链接 → 走默认浏览器打开，防止 WebView 页面跳走
    _installLinkInterceptor();
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
      const wasActive = activeConversationId === id;
      conversations = conversations.filter(c => c.id !== id);
      if (wasActive) {
        activeConversationId = conversations[0]?.id || null;
        // 清空消息容器，防止 _switchConversation 的 early-return 跳过渲染
        const container = document.getElementById('messageContainer');
        if (container) container.innerHTML = '';
      }
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
    _pinned = false;
    _renderMessages(conv.messages);
    _renderConversationList();
    const mc = document.getElementById('messageContainer');
    if (mc) { mc.style.paddingBottom = ''; mc.scrollTop = mc.scrollHeight; }
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
      _debugLog('[chat] 消息入队 | 队列长度=' + (conv._queue.length + 1) + ' | 内容=' + content.trim().slice(0, 40));
      conv._queue.push({ content: content.trim(), timestamp: Date.now() });
      _appendQueuedMessage(content.trim());
      _saveToStorage();
      // 注入后端 ReAct 循环（如果有 session_id）
      if (conv.sessionId) {
        _injectMessage(conv.sessionId, content.trim());
      }
      return;
    }

    _debugLog('[chat] 消息发送 | 模式=' + chatMode + ' | 模型=' + chatModelName);
    // ── 路径 B：正常发送 ──
    // 生成会话 ID（用于排队消息注入）
    if (!conv.sessionId) {
      conv.sessionId = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }
    // 添加用户消息
    conv.messages.push({ role: 'user', type: 'user', content: content.trim(), timestamp: Date.now() });
    const isFirstUserMsg = conv.messages.filter(m => m.role === 'user').length === 1;
    if (isFirstUserMsg) {
      conv.title = content.trim().slice(0, 20) + (content.trim().length > 20 ? '…' : '');
    }
    conv.isGenerating = true;
    _pinned = true;  // 标记需要 pin
    _updateInputState(true);

    // 创建流式 AI 消息占位（info 类型气泡）
    const aiMsg = { role: 'assistant', type: 'info', content: '', timestamp: Date.now(), streaming: true, thinking: true, startTime: Date.now() };
    conv.messages.push(aiMsg);

    // 构建消息历史（只发 role + content，不含 streaming 中的消息）
    const apiMessages = conv.messages
      .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.streaming && m.content))
      .map(m => ({ role: m.role, content: m.content }));

    // 欢迎页 logo 飞入动效（首条消息）
    if (isFirstUserMsg && document.querySelector('.welcome-screen .welcome-logo')) {
      const welcomeEl = document.querySelector('.welcome-screen .welcome-logo');
      const startRect = welcomeEl.getBoundingClientRect();
      // 克隆浮层，它就是飞过去当头像的
      const flyEl = welcomeEl.cloneNode(true);
      flyEl.style.position = 'fixed';
      flyEl.style.left = startRect.left + 'px';
      flyEl.style.top = startRect.top + 'px';
      flyEl.style.width = startRect.width + 'px';
      flyEl.style.height = startRect.height + 'px';
      flyEl.style.zIndex = '1000';
      flyEl.style.margin = '0';
      flyEl.style.animation = 'none';
      flyEl.style.transition = 'all 1.2s cubic-bezier(0.22, 0.61, 0.36, 1)';
      flyEl.style.pointerEvents = 'none';
      flyEl.style.padding = '10px'; // 与 welcome-logo 一致
      flyEl.style.borderRadius = '18px';
      flyEl.style.background = 'var(--primary-gradient)';
      flyEl.style.boxShadow = '0 6px 24px var(--primary-glow)';
      document.body.appendChild(flyEl);
      welcomeEl.style.opacity = '0';

      // 2. 渲染消息（_renderMessages 自动 pin 用户消息到顶部）
      _renderMessages(conv.messages);
      _renderConversationList();

      // 找到目标头像并隐藏，等飞入结束再显示
      const targetAvatar = document.querySelector('.message-row.assistant .msg-avatar.ai');
      if (targetAvatar) targetAvatar.style.opacity = '0';

      // 3. 测量目标位置飞入
      requestAnimationFrame(() => {
        let targetLeft, targetTop;
        if (targetAvatar) {
          const r = targetAvatar.getBoundingClientRect();
          targetLeft = r.left;
          targetTop = r.top - 1; // 微调：avatar 在行内可能有 1px 偏移
        } else {
          const cr = document.getElementById('messageContainer').getBoundingClientRect();
          targetLeft = cr.left + 22;
          targetTop = cr.top + 18;
        }
        flyEl.style.left = targetLeft + 'px';
        flyEl.style.top = targetTop + 'px';
        flyEl.style.width = '28px';
        flyEl.style.height = '28px';
        flyEl.style.padding = '3px';
        flyEl.style.borderRadius = '8px';
        flyEl.style.boxShadow = 'none';

        const finish = () => {
          flyEl.remove();
          if (targetAvatar) targetAvatar.style.opacity = '';
        };
        flyEl.addEventListener('transitionend', finish, { once: true });
        setTimeout(finish, 1400);
      });
    } else {
      _renderMessages(conv.messages);
      _renderConversationList();
    }

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
      read_file: {
        detail: `读取文件：${args?.path || ''}`,
        human: '正在读取工作区文件……',
        done: '文件读取完成',
      },
      grep: {
        detail: `代码搜索：「${args?.query || ''}」`,
        human: '正在工作区里搜索代码……',
        done: '代码搜索完成',
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
    return `${parseFloat(s).toFixed(1)} 秒`;
  }

  async function _doStreamSend(conv, apiMessages, aiMsg) {
    let throttleTimer = null;
    // 同工具连续调用时静默，不弹气泡
    // 工具分组：同组工具连续调用算重复（与后端 BubblePolicy 对齐）
    const _TOOL_GROUPS = {
      knowledge_grep: 'kb', knowledge_rag: 'kb',
      list_files: 'workspace', read_file: 'workspace', grep: 'workspace',
      web_search: 'web', web_fetch: 'web',
    };
    let _lastReadGroup = '';
    let _silentMode = false;

    try {
      conv.abortController = await _chatStream({
        messages: apiMessages,
        providerId: conv.providerId,
        model: conv.model,
        mode: conv.mode,
        sessionId: conv.sessionId || '',
        onDelta: (delta) => {
          _silentMode = false;
          if (aiMsg.thinking) {
            aiMsg.thinking = false;
            aiMsg.thinkingTime = _fmtThinking((Date.now() - aiMsg.startTime) / 1000);
            _debugLog('[chat] 首次响应 | 思考耗时=' + aiMsg.thinkingTime);
          }
          if (!conv.messages.includes(aiMsg)) {
            conv.messages.push(aiMsg);
          }
          aiMsg.content += delta;

          if (!throttleTimer) {
            throttleTimer = setTimeout(() => {
              throttleTimer = null;
              _updateLastBubble(aiMsg);
              // 最终回复首次渲染到 DOM → 立刻折叠工作气泡 + 头像换位
              if (!aiMsg._folded) {
                aiMsg._folded = true;
                const mc = document.getElementById('messageContainer');
                if (mc) _collapseClosedSections(mc, true);
              }
            }, 60);
          }
        },
        onToolStart: (event) => {
          if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
          // 同组工具连续调用 → 静默，不弹气泡
          const group = _TOOL_GROUPS[event.tool] || event.tool;
          if (group === _lastReadGroup) {
            _debugLog('[chat] 工具静默 | ' + event.tool + ' (组=' + group + ' 连续重复)');
            _silentMode = true;
            return;
          }
          _silentMode = false;
          _lastReadGroup = group;
          _debugLog('[chat] 工具调用气泡 | ' + event.tool + ' | 参数=' + JSON.stringify(event.args || {}).slice(0, 100));

          // 移除 AI 占位，插调用气泡
          const idx = conv.messages.indexOf(aiMsg);
          if (idx >= 0) conv.messages.splice(idx, 1);
          const { detail, human } = _toolLabel(event.tool, event.args, false);
          const btype = event.bubble_type || 'tool';
          conv.messages.push({
            role: 'assistant', type: 'tool_call',
            tool: event.tool, toolDetail: detail,
            toolHuman: human, bubbleType: btype,
            content: '', streaming: false,
            timestamp: Date.now(),
          });
          _renderMessages(conv.messages);
        },
        onToolResult: (event) => {
          if (_silentMode) {
            _debugLog('[chat] 工具结果静默 | ' + event.tool + ' (静默模式)');
            return;  // 静默模式不弹成功气泡
          }
          _debugLog('[chat] 工具结果气泡 | ' + event.tool + ' | 结果=' + (event.result || '').slice(0, 60));
          const { human } = _toolLabel(event.tool, event.args, true);
          const btype = event.bubble_type || 'tool';
          conv.messages.push({
            role: 'assistant', type: 'tool_result',
            tool: event.tool, toolResultHuman: human,
            bubbleType: btype,
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
          }
        },
        onToolError: (event) => {
          // 错误不弹独立气泡——错误内容已通过 system 消息反馈给 LLM
          // LLM 会在后续回复中自然地告诉用户发生了什么
          console.debug('[chat] 工具错误(静默→交LLM处理) | ' + event.tool + ' | ' + (event.error || '').slice(0, 80));
        },
        onMaxRounds: (max) => {
          aiMsg.maxRoundsReached = max;
        },
        onUserInjected: (event) => {
          // 将 DOM 中最后 N 个排队气泡转为正常用户气泡
          const container = document.getElementById('messageContainer');
          if (!container) return;
          const queuedRows = container.querySelectorAll('.message-row.user.queued');
          const injectedCount = event.messages?.length || 0;
          let i = 0;
          // 排队消息注入后，折叠上一段工具气泡
          _collapseClosedSections(container, false);

          queuedRows.forEach(row => {
            if (i < injectedCount) {
              row.classList.remove('queued');
              const indicator = row.querySelector('.queue-indicator');
              if (indicator) indicator.remove();
              i++;
            }
          });
        },
        onDone: () => {
          _debugLog('[chat] ReAct完成 | 内容长=' + aiMsg.content.length + '字符 | 队列=' + (conv._queue?.length || 0) + '条');
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
          _pinned = false;
          conv.isGenerating = false;
          conv.abortController = null;
          _updateInputState(false);
          _saveToStorage();
          _notifyIfAway();
          _flushQueue(conv);
          // 刷新用量小组件
          if (typeof App !== 'undefined' && App._refreshUsageWidget) App._refreshUsageWidget();
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
      // 给常见网络错误更友好的中文提示
      const errMsg = err.message || '';
      if (errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError')) {
        aiMsg.content = '网络连接失败，请检查网络后重试。';
      } else if (errMsg.includes('timeout') || errMsg.includes('Timeout')) {
        aiMsg.content = '请求超时，AI 服务器响应过慢，请稍后重试。';
      } else {
        aiMsg.content = `错误：${errMsg || '请求失败'}`;
      }
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

  /** 将排队消息注入后端 ReAct 循环 */
  async function _injectMessage(sessionId, content) {
    try {
      await fetch(`${API_BASE}/api/chat/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          messages: [{ content, timestamp: Date.now() }],
        }),
      });
      console.debug('[chat] 注入后端 | session=' + sessionId.slice(0, 8) + '… | 内容=' + content.slice(0, 30));
    } catch (e) {
      console.debug('[chat] 注入失败（后端可能不可用）: ' + e.message);
    }
  }

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
    container.scrollTop = container.scrollHeight;
  }

  /** 消费排队消息：将 DOM 中的排队气泡转为正式气泡 → 继续发送 */
  function _flushQueue(conv) {
    if (!conv._queue || conv._queue.length === 0) return;

    _debugLog('[chat] 刷新队列 | 排队消息=' + conv._queue.length + '条');
    const queued = conv._queue.splice(0);

    // 将排队消息正式加入对话
    queued.forEach(q => {
      conv.messages.push({ role: 'user', type: 'user', content: q.content, timestamp: q.timestamp });
    });

    // 转换 DOM 中的排队气泡为正式气泡（不重建整个视图，避免闪烁）
    const container = document.getElementById('messageContainer');
    if (container) {
      const queuedRows = container.querySelectorAll('.message-row.user.queued');
      queuedRows.forEach(row => {
        row.classList.remove('queued');
        const indicator = row.querySelector('.queue-indicator');
        if (indicator) indicator.remove();
      });
    }

    // 构建完整上下文（含所有排队用户消息）
    const aiMsg = { role: 'assistant', type: 'info', content: '', timestamp: Date.now(), streaming: true, thinking: true, startTime: Date.now() };
    conv.messages.push(aiMsg);

    const apiMessages = conv.messages
      .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.streaming && m.content))
      .map(m => ({ role: m.role, content: m.content }));

    conv.isGenerating = true;
    _pinned = true;
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
      if (!last.content) { last.content = '（已停止生成）'; last.type = 'warning'; }
    }
    _updateInputState(false);
    _pinned = false;
    _renderMessages((conv && conv.messages) || []);
    const mc = document.getElementById('messageContainer');
    if (mc) { _collapseClosedSections(mc, true); }
    _saveToStorage();
  }

  // ===== 流式 API 调用（Re-Act 模式，支持工具事件）=====

  async function _chatStream(options) {
    const { messages, providerId, model, mode, onDelta, onDone, onError, onToolStart, onToolResult, onToolError, onMaxRounds, onUserInjected } = options;
    const controller = new AbortController();

    try {
      const response = await fetch(`${API_BASE}/api/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, provider_id: providerId, model, mode, stream: true, sandbox_root: window.__lubia_workspace_root || null, session_id: options.sessionId || '' }),
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
          if (data === '[DONE]') { console.debug('[chat] SSE [DONE]'); onDone(); return controller; }
          try {
            const json = JSON.parse(data);
            const evtType = json.type || (json.choices ? 'openai' : 'unknown');
            if (evtType !== 'delta') {
              console.debug('[chat] SSE事件 | type=' + evtType + (json.tool ? ' | tool=' + json.tool : '') + (json.error ? ' | error=' + json.error : ''));
            }

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
            } else if (json.type === 'user_injected') {
              // 排队消息已被后端注入 ReAct 循环 → 去掉排队标记
              console.debug('[chat] 消息已注入 | 条数=' + (json.messages?.length || 0));
              if (onUserInjected) onUserInjected(json);
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

      const showAvatar = prevRole !== msg.role;
      const avatarCls = showAvatar ? (isUser ? 'user' : 'ai') : 'ghost';
      const avatarHTML = isUser
        ? `<div class="msg-avatar ${avatarCls}">你</div>`
        : `<img class="msg-avatar ${avatarCls}" src="/Lubia.svg" alt="Lubia" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div class=\\'msg-avatar ai-fallback\\'>AI</div>')">`;

      if (isUser) {
        row.innerHTML = `${avatarHTML}<div class="msg-bubble user-bubble">${_esc(msg.content).replace(/\n/g, '<br>')}</div>`;
      } else {
        row.innerHTML = `${avatarHTML}<div class="msg-body">${_renderAIBubble(msg)}</div>`;
      }
      container.appendChild(row);
      prevRole = msg.role;
    });
    lastRole = messages[messages.length - 1]?.role || null;
    const allDone = !messages.some(m => m.streaming);
    _collapseClosedSections(container, allDone);

    if (_pinned) {
      const userRows = container.querySelectorAll('.message-row.user');
      const lastUser = userRows[userRows.length - 1];
      if (lastUser) {
        // 精确算 padding-bottom：滚动条到底时用户消息正好离顶 18px
        container.style.paddingBottom = '';
        void container.offsetHeight;
        // 目标：scrollTop = offsetTop - 18，且 scrollTop + clientHeight = scrollHeight（滚动条刚好到底）
        // → paddingBottom = (offsetTop - 18) + clientHeight - (scrollHeight - 18) = offsetTop + clientHeight - scrollHeight
        const pad = lastUser.offsetTop + container.clientHeight - container.scrollHeight;
        container.style.paddingBottom = Math.max(18, pad) + 'px';
        // 滚到用户消息离顶 18px，然后滚动条强制到底
        lastUser.scrollIntoView({ block: 'start', behavior: 'instant' });
        container.scrollTop = Math.max(0, container.scrollTop - 18);
        container.scrollTop = container.scrollHeight - container.clientHeight;
        _debugLog('[chat] pin | pad=' + pad + ' | scrollTop=' + container.scrollTop);
      }
    }
  }

  /**
   * 折叠已完成的工具气泡段。
   * 「完成」= 后面跟着 user 消息或 final 回复了。
   * 当前正在进行中的段（最后一个 anchor 之后）不折叠。
   * @param {boolean} allDone - true 表示最后一段也完成了（final 来了）
   */
  function _collapseClosedSections(container, allDone) {
    // 先清理旧折叠包装，还原裸 row
    container.querySelectorAll('.tool-fold-wrapper').forEach(w => {
      const content = w.querySelector('.tool-fold-content');
      if (content) { while (content.firstChild) w.before(content.firstChild); }
      w.remove();
    });

    const rows = [...container.querySelectorAll('.message-row')];
    // anchor = user 消息 或 有实质内容的 AI 回复（info/success/error/warning 气泡含 markdown）
    const anchors = [];
    rows.forEach((row, i) => {
      if (row.classList.contains('user')) { anchors.push(i); return; }
      const body = row.querySelector('.msg-body');
      if (!body) return;
      if (body.querySelector('.markdown-body') || body.querySelector('.ai-info,.ai-success,.ai-error,.ai-warning')) {
        anchors.push(i);
      }
    });

    // 对每一段 [anchors[i]+1, anchors[i+1]-1]，如果全是 tool 气泡就折叠。
    // 最后一段（i+1 == anchors.length-1）只有 allDone=true 时才折叠。
    for (let a = 0; a < anchors.length - 1; a++) {
      const start = anchors[a] + 1;
      const end = anchors[a + 1] - 1;
      const isLast = (a + 1 === anchors.length - 1);
      if (isLast && !allDone) continue;  // 正在进行的段不折叠
      if (start > end) continue;
      const between = rows.slice(start, end + 1);
      if (between.length === 0) continue;

      const wrapper = document.createElement('div');
      wrapper.className = 'tool-fold-wrapper';
      wrapper.innerHTML = `<div class="tool-fold-toggle" onclick="this.parentElement.classList.toggle('expanded')">
        <span class="fold-label-collapsed">已折叠 ${between.length} 条工作气泡</span>
        <span class="fold-label-expanded">收起 ${between.length} 条工作气泡</span>
        <span class="tool-fold-arrow">▶</span>
      </div>`;
      const content = document.createElement('div');
      content.className = 'tool-fold-content';
      wrapper.appendChild(content);
      between[0].before(wrapper);
      // 被折叠行的头像隐藏
      between.forEach(r => {
        const av = r.querySelector('.msg-avatar');
        if (av) av.classList.add('ghost');
        content.appendChild(r);
      });
      // 强制 anchor 行（最终回复）显示头像
      const anchorRow = rows[anchors[a + 1]];
      if (anchorRow && anchorRow.classList.contains('assistant')) {
        const anchorAv = anchorRow.querySelector('.msg-avatar');
        if (anchorAv) {
          anchorAv.classList.remove('ghost');
          anchorAv.classList.add('ai');
        }
      }
    }
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

    // 工具调用气泡：小字详情 + 白话说明，根据 bubble_type 选择样式
    if (type === 'tool_call') {
      const bCls = _bubbleClass(msg.bubbleType, 'call');
      return `<div class="msg-bubble ai-bubble ${bCls}">
        <div class="tool-call-detail">${_esc(msg.toolDetail || '')}</div>
        <div class="tool-call-human">${_esc(msg.toolHuman || '')}</div>
      </div>`;
    }
    // 工具结果气泡：白话说明完成了什么
    if (type === 'tool_result') {
      const bCls = _bubbleClass(msg.bubbleType, 'result');
      return `<div class="msg-bubble ai-bubble ${bCls}">
        <div class="tool-result-human">${_esc(msg.toolResultHuman || msg.toolHuman || '')}</div>
      </div>`;
    }
    // 工具错误气泡（使用独立 class，视觉上区分错误 vs 普通工具调用）
    if (type === 'tool_error_msg') {
      return `<div class="msg-bubble ai-bubble ai-tool-error">
        <div class="tool-error-detail">${_esc(msg.toolDetail || '工具出错')}</div>
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
      <p>你的桌面工作伙伴</p>
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

  /** 移除空白 spacer */
  /** 根据 bubble_type 返回对应的 CSS class */
  function _bubbleClass(bubbleType, phase) {
    // phase: 'call' = 调用中气泡, 'result' = 结果气泡
    const map = {
      read:   phase === 'call' ? 'ai-bubble-read-call' : 'ai-bubble-read-done',
      exec:   phase === 'call' ? 'ai-bubble-exec-call' : 'ai-bubble-exec-done',
      edit:   phase === 'call' ? 'ai-bubble-edit-call' : 'ai-bubble-edit-done',
      done:   'ai-bubble-done',
      option: 'ai-bubble-option',
    };
    if (bubbleType && map[bubbleType]) return map[bubbleType];
    // 兜底：旧版通用工具气泡
    return phase === 'call' ? 'ai-tool-call' : 'ai-tool-result';
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function _escAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  let _linkInterceptorInstalled = false;
  function _installLinkInterceptor() {
    if (_linkInterceptorInstalled) return;
    _linkInterceptorInstalled = true;
    document.addEventListener('click', function (e) {
      const a = e.target.closest('.markdown-body a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#')) return;  // 锚点放行
      e.preventDefault();
      e.stopPropagation();
      // 走默认浏览器打开，不会把 WebView 跳走
      if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
        Bridge.openExternal(href);
      } else {
        window.open(href, '_blank');
      }
    }, true);  // 捕获阶段，确保在 WebView 默认行为之前拦截
  }

  function _showToast(msg, type) {
    if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type || 'info');
  }

  function _loadFromStorage() {
    try {
      const d = localStorage.getItem('lubia_conversations');
      if (d) {
        const parsed = JSON.parse(d);
        // v8+ 版本化格式：{ _version: N, conversations: [...] }
        // v7 及以前：直接是数组
        const rawConversations = Array.isArray(parsed) ? parsed : (parsed.conversations || []);
        conversations = rawConversations;
        conversations.forEach(c => {
          c.messages.forEach(m => { m.streaming = false; });
          // v6：为旧数据补充缺失字段
          if (c.isGenerating === undefined) c.isGenerating = false;
          if (c.locked === undefined) c.locked = (c.messages || []).some(m => m.role === 'user');
          if (c.pinned === undefined) c.pinned = false;
          c.abortController = null;
          c._queue = [];
          // v8: 恢复 sessionId
          if (c.sessionId === undefined) c.sessionId = null;
          // v6：错误恢复 —— 空内容的 assistant 消息标为 error
          c.messages.forEach((m, i) => {
            // 工具调用气泡无文本内容是正常的，不标为 error
            if (m.role === 'assistant' && !m.content?.trim() && m.type !== 'tool_call' && m.type !== 'tool_result' && m.type !== 'tool_error_msg') {
              // 检查此消息之前是否有成功的工具调用（说明 AI 确实执行了操作，只是回复文本丢失）
              const hasPriorToolOps = c.messages.slice(0, i).some(
                prior => prior.type === 'tool_call' || prior.type === 'tool_result'
              );
              if (hasPriorToolOps) {
                // AI 完成了工具操作但回复文本未能保存（可能在流式传输中刷新了页面）
                m.type = 'warning';
                m.content = '（AI 已完成工具操作，但回复文本未能保存。可能是流式传输期间刷新了页面，请重试。）';
              } else {
                m.type = 'error';
                m.content = '消息发送失败，未获取到 AI 回复。请检查网络连接后重试。';
              }
            }
          });
        });
        // 清理超过 30 天的旧对话
        _cleanupOldConversations();
        // 只在当前会话还没选中对话时才恢复（保留页面切换间的状态）
        if (!activeConversationId && conversations.length > 0) activeConversationId = conversations[0].id;
      }
    } catch (_) { conversations = []; }
  }

  /** 清理超过 30 天的旧对话（至少保留一条） */
  function _cleanupOldConversations() {
    const now = Date.now();
    const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
    const before = conversations.length;
    conversations = conversations.filter(c => {
      const age = now - new Date(c.createdAt).getTime();
      return age < ONE_MONTH;
    });
    if (conversations.length === 0) {
      _createConversation('新对话');
      activeConversationId = conversations[0].id;
    }
    if (conversations.length < before) {
      _debugLog('[chat] 清理过期对话 | 删除 ' + (before - conversations.length) + ' 条 | 剩余 ' + conversations.length + ' 条');
    }
  }

  function _saveToStorage() {
    try {
      let cleaned = conversations.map(function (c) {
        return {
          id: c.id, title: c.title, model: c.model, providerId: c.providerId,
          mode: c.mode, createdAt: c.createdAt, pinned: c.pinned,
          sessionId: c.sessionId || null,
          messages: c.messages.map(function (m) {
            return {
              role: m.role, type: m.type, content: m.content, timestamp: m.timestamp,
              action: m.action, options: m.options, streaming: false,
              tool: m.tool, toolDetail: m.toolDetail, toolHuman: m.toolHuman, toolResult: m.toolResult, toolResultHuman: m.toolResultHuman,
            };
          })
        };
      });

      // 大小保护：超过 4MB 时删除最旧的非置顶对话
      let json = JSON.stringify({ _version: 1, conversations: cleaned });
      const MAX_SIZE = 4 * 1024 * 1024;
      if (json.length > MAX_SIZE) {
        console.warn('[chat] localStorage 数据过大(' + (json.length / 1024 / 1024).toFixed(1) + 'MB)，清理旧对话');
        while (json.length > MAX_SIZE && cleaned.length > 1) {
          // 找最旧的非置顶对话删除
          let oldestIdx = -1, oldestTime = Infinity;
          for (let i = 0; i < cleaned.length; i++) {
            if (!cleaned[i].pinned) {
              const t = new Date(cleaned[i].createdAt).getTime();
              if (t < oldestTime) { oldestTime = t; oldestIdx = i; }
            }
          }
          if (oldestIdx >= 0) {
            cleaned.splice(oldestIdx, 1);
          } else {
            break; // 只剩置顶对话，无法清理
          }
          json = JSON.stringify({ _version: 1, conversations: cleaned });
        }
        console.debug('[chat] 清理完成 | 大小=' + (json.length / 1024 / 1024).toFixed(1) + 'MB | 剩余=' + cleaned.length + '条');
      }

      localStorage.setItem('lubia_conversations', json);
    } catch (e) {
      console.error('[chat] localStorage 写入失败: ' + (e.message || ''));
    }
  }

  /** 同时输出到浏览器控制台和后端 prompt.md（fire-and-forget） */
  function _debugLog(msg) {
    console.debug(msg);
    try {
      fetch(`${API_BASE}/api/chat/debug-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      }).catch(() => {});
    } catch (_) {}
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
