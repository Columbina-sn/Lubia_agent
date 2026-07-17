/* ============================================================
   settings.js v2 — 左右分栏设置页

   左侧导航：偏好选项 / 供应商 / 快捷键 / 用量统计 / 关于
   右侧内容：动态渲染对应 section
   供应商 section 内部也是左右分栏（列表 + 详情）
   数据通过后端 API 持久化到 SQLite
   ============================================================ */

const Settings = (() => {
  let currentSection = 'preferences';
  let providers = [];
  let selectedProviderId = null;
  let vendorDefaults = [];

  function mount() {
    currentSection = 'preferences';
    selectedProviderId = null;
    _highlightNav(currentSection);
    _renderSection(currentSection);
    // 预加载供应商和厂商数据
    _fetchProviders();
    _fetchVendors();
  }

  function destroy() {
    // 离开设置页时检查供应商是否有未保存修改
    if (_isProviderDirty()) {
      // 快照表单值（离开设置页后 DOM 会被销毁，不能再读 input）
      const snapshot = {
        id: selectedProviderId,
        apiKey: document.getElementById('providerApiKey')?.value || '',
        baseUrl: document.getElementById('providerBaseUrl')?.value?.trim() || '',
        apiPath: document.getElementById('providerApiPath')?.value?.trim() || '',
      };
      return new Promise((resolve, reject) => {
        _showUnsavedModal(
          () => { _saveSnapshot(snapshot); resolve(); },
          () => { resolve(); },
          () => { reject(new Error('cancelled')); }
        );
      });
    }
  }

  async function _saveSnapshot(snapshot) {
    if (!snapshot.baseUrl) return;
    try {
      await api.put(`/api/providers/${snapshot.id}`, {
        api_key: snapshot.apiKey, base_url: snapshot.baseUrl, api_path: snapshot.apiPath
      });
    } catch (_) { /* 静默失败，页面已离开 */ }
  }

  // ── 未保存弹窗 ──

  function _showUnsavedModal(onSave, onDiscard, onCancel) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-dialog" style="max-width:400px;">
        <h3>未保存的修改</h3>
        <p>供应商信息已修改但未保存。要保存修改吗？</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="unsavedDiscard">不保存</button>
          <button class="btn btn-ghost" id="unsavedCancel">取消</button>
          <button class="btn btn-primary" id="unsavedSave">保存</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = () => overlay.remove();

    overlay.querySelector('#unsavedSave').onclick = () => {
      cleanup();
      if (onSave) onSave();
    };
    overlay.querySelector('#unsavedDiscard').onclick = () => {
      cleanup();
      if (onDiscard) onDiscard();
    };
    overlay.querySelector('#unsavedCancel').onclick = () => {
      cleanup();
      if (onCancel) onCancel();
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); if (onCancel) onCancel(); }
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', esc); if (onCancel) onCancel(); }
    });
  }

  // ===== 数据获取 =====

  async function _fetchProviders() {
    try {
      const data = await api.get('/api/providers');
      providers = data || [];
    } catch (_) {
      providers = [];
    }
    // 如果当前在供应商 section，刷新列表
    if (currentSection === 'providers') {
      _renderProviderList();
      if (selectedProviderId) {
        _renderProviderDetail(selectedProviderId);
      }
    }
  }

  async function _fetchVendors() {
    try {
      const data = await api.get('/api/vendors');
      vendorDefaults = data || [];
    } catch (_) {
      vendorDefaults = [];
    }
  }

  // ===== 导航切换 =====

  function switchSection(section) {
    // 已经在当前 section，不做任何操作
    if (section === currentSection) return;
    // 从供应商 section 切走时，检查是否有未保存的修改
    if (currentSection === 'providers' && _isProviderDirty()) {
      _showUnsavedModal(
        () => { saveProviderDetail(selectedProviderId); _doSwitchSection(section); },
        () => { _doSwitchSection(section); }
      );
      return;
    }
    _doSwitchSection(section);
  }

  function _doSwitchSection(section) {
    currentSection = section;
    selectedProviderId = null;
    _highlightNav(section);
    _renderSection(section);
  }

  function _highlightNav(section) {
    document.querySelectorAll('.settings-nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.section === section);
    });
  }

  // ===== 渲染 section 内容 =====

  function _renderSection(section) {
    const content = document.getElementById('settingsContent');
    if (!content) return;

    switch (section) {
      case 'preferences': _renderPreferences(content); break;
      case 'providers': _renderProviders(content); break;
      case 'defaultModels': _renderDefaultModels(content); break;
      case 'shortcuts': _renderShortcuts(content); break;
      case 'usage': _renderUsage(content); break;
      case 'about': _renderAbout(content); break;
    }
  }

  // ── 偏好选项 ──

  function _renderPreferences(container) {
    const theme = localStorage.getItem('lubia_theme') || 'auto';
    const maxTurns = localStorage.getItem('lubia_max_turns') || '15';
    const maxLoopRounds = localStorage.getItem('lubia_max_loop_rounds') || '8';
    const maxLoopRoundsPlan = localStorage.getItem('lubia_max_loop_rounds_plan') || '15';
    const fontSize = localStorage.getItem('lubia_font_size') || '1.0';

    container.innerHTML = `
      <div class="settings-section-header">
        <h3>偏好选项</h3>
        <p class="section-desc">调整应用外观和对话行为（修改即时生效）</p>
      </div>
      <div class="settings-card">
        <div class="form-group">
          <label>主题</label>
          <select class="input" id="settingTheme" onchange="Settings.onThemeChange(this.value)">
            <option value="light" ${theme === 'light' ? 'selected' : ''}>浅色模式 · 浅梦微光</option>
            <option value="dark" ${theme === 'dark' ? 'selected' : ''}>深色模式 · 深空月夜</option>
            <option value="auto" ${theme === 'auto' ? 'selected' : ''}>跟随系统</option>
          </select>
        </div>
      </div>
      <div class="settings-card" style="margin-top:14px;">
        <div class="form-group">
          <label>字体大小</label>
          <p class="section-desc" style="margin:0 0 8px 0;">全局缩放所有文字和界面元素</p>
          <div class="font-size-slider">
            <span style="font-size:0.75rem;color:var(--text-tip);">0.8x</span>
            <input type="range" id="settingFontSize" min="0.8" max="1.5" step="0.05" value="${fontSize}"
                   oninput="Settings.onFontSizeInput(this.value)">
            <span style="font-size:0.75rem;color:var(--text-tip);">1.5x</span>
            <span class="font-size-value" id="fontSizeValue">${fontSize}x</span>
          </div>
        </div>
      </div>
      <div class="settings-card" style="margin-top:14px;">
        <div class="form-group" style="display:flex;align-items:center;justify-content:space-between;gap:16px;">
          <div>
            <label style="margin:0;">最大对话轮数</label>
            <p style="margin:2px 0 0 0;font-size:0.72rem;color:var(--text-tip);">对话越长，AI 记住的上下文越多</p>
          </div>
          <input type="number" class="input" id="settingMaxTurns" value="${maxTurns}" min="10" max="30" style="width:80px;"
                 onchange="Settings.onMaxTurnsChange(this.value)">
        </div>
      </div>
      <div class="settings-card" style="margin-top:14px;">
        <div class="form-group" style="display:flex;align-items:center;justify-content:space-between;gap:16px;">
          <div>
            <label style="margin:0;">Ask 模式循环上限</label>
            <p style="margin:2px 0 0 0;font-size:0.72rem;color:var(--text-tip);">简单问答的搜索步数上限</p>
          </div>
          <input type="number" class="input" id="settingMaxLoopRounds" value="${maxLoopRounds}" min="5" max="20" style="width:80px;"
                 onchange="Settings.onMaxLoopRoundsChange(this.value)">
        </div>
      </div>
      <div class="settings-card" style="margin-top:14px;">
        <div class="form-group" style="display:flex;align-items:center;justify-content:space-between;gap:16px;">
          <div>
            <label style="margin:0;">Plan / Auto 模式循环上限</label>
            <p style="margin:2px 0 0 0;font-size:0.72rem;color:var(--text-tip);">复杂任务的搜索步数上限（需工作区）</p>
          </div>
          <input type="number" class="input" id="settingMaxLoopRoundsPlan" value="${maxLoopRoundsPlan}" min="12" max="25" style="width:80px;"
                 onchange="Settings.onMaxLoopRoundsPlanChange(this.value)">
        </div>
      </div>
      <div class="form-actions" style="margin-top:20px;">
        <button class="btn btn-ghost" onclick="Settings.restoreDefaults()">恢复默认</button>
      </div>`;
  }

  // ── 偏好选项即时生效 ──

  function onThemeChange(value) {
    localStorage.setItem('lubia_theme', value);
    if (typeof App !== 'undefined') App.applyTheme(value);
  }

  function onFontSizeInput(value) {
    document.getElementById('fontSizeValue').textContent = value + 'x';
    if (typeof App !== 'undefined') App.applyFontSize(parseFloat(value));
    localStorage.setItem('lubia_font_size', value);
  }

  function onMaxTurnsChange(value) {
    const v = Math.max(10, Math.min(30, parseInt(value) || 15));
    localStorage.setItem('lubia_max_turns', v);
    configAPI.set('max_turns', String(v)).catch(() => {});
  }

  function onMaxLoopRoundsChange(value) {
    const v = Math.max(5, Math.min(20, parseInt(value) || 8));
    localStorage.setItem('lubia_max_loop_rounds', v);
    configAPI.set('max_loop_rounds', String(v)).catch(() => {});
  }

  function onMaxLoopRoundsPlanChange(value) {
    const v = Math.max(12, Math.min(25, parseInt(value) || 15));
    localStorage.setItem('lubia_max_loop_rounds_plan', v);
    configAPI.set('max_loop_rounds_plan', String(v)).catch(() => {});
  }

  function restoreDefaults() {
    localStorage.setItem('lubia_theme', 'auto');
    localStorage.setItem('lubia_font_size', '1.0');
    localStorage.setItem('lubia_max_turns', '15');
    localStorage.setItem('lubia_max_loop_rounds', '8');
    localStorage.setItem('lubia_max_loop_rounds_plan', '15');
    configAPI.set('max_turns', '15').catch(() => {});
    configAPI.set('max_loop_rounds', '8').catch(() => {});
    configAPI.set('max_loop_rounds_plan', '15').catch(() => {});
    if (typeof App !== 'undefined') {
      App.applyTheme('auto');
      App.applyFontSize(1.0);
    }
    _renderSection('preferences');
    _showToast('已恢复默认设置', 'info');
  }

  // ── 默认模型 ──

  function _renderDefaultModels(container) {
    container.innerHTML = `
      <div class="settings-section-header">
        <h3>默认模型</h3>
        <p class="section-desc">为各项功能设置默认使用的 AI 模型</p>
      </div>
      <div class="settings-card" id="defaultModelsCard">
        <div class="form-group">
          <label>知识库存储文件模型</label>
          <p class="section-desc" style="margin:0 0 8px 0;">上传文件到知识库时，用哪个模型提取结构化信息（留空则不使用 AI 提取）</p>
          <select class="input" id="settingKbModel" onchange="Settings.onKbModelChange(this.value)">
            <option value="">不使用 AI 提取</option>
          </select>
        </div>
      </div>`;
    _loadKbModelSelector();
  }

  async function _loadKbModelSelector() {
    const select = document.getElementById('settingKbModel');
    if (!select) return;

    try {
      const provs = await api.get('/api/providers');
      const enabledProviders = (provs || []).filter(p => p.is_enabled);
      const options = [];

      for (const p of enabledProviders) {
        const enabledModels = (p.models || []).filter(m => m.is_enabled);
        for (const m of enabledModels) {
          const value = `${p.id}::${m.model_name}`;
          options.push({ value, label: `${p.name} · ${m.display_name || m.model_name}` });
        }
      }

      // 保留"不使用 AI 提取"选项
      select.innerHTML = '<option value="">不使用 AI 提取</option>' +
        options.map(o => `<option value="${o.value}">${_esc(o.label)}</option>`).join('');

      // 恢复已保存的选择
      try {
        const savedModel = await configAPI.get('kb_model');
        const savedProvider = await configAPI.get('kb_provider');
        // configAPI.get 返回的是 {key, value} 对象，需取 .value
        const modelVal = savedModel?.value || '';
        const provVal = savedProvider?.value || '';
        if (modelVal && provVal) {
          const val = `${provVal}::${modelVal}`;
          if (select.querySelector(`option[value="${val}"]`)) {
            select.value = val;
          }
        }
      } catch (_) { /* 配置可能还未创建 */ }
    } catch (_) {
      select.innerHTML = '<option value="">加载失败</option>';
    }
  }

  async function onKbModelChange(value) {
    if (!value) {
      await configAPI.set('kb_model', '');
      await configAPI.set('kb_provider', '');
    } else {
      const [pid, mname] = value.split('::');
      if (pid && mname) {
        await configAPI.set('kb_provider', pid);
        await configAPI.set('kb_model', mname);
      }
    }
    _showToast('已保存', 'success');
  }

  // ── 供应商（左右分栏）──

  function _renderProviders(container) {
    container.innerHTML = `
      <div class="settings-section-header">
        <h3>供应商</h3>
        <p class="section-desc">管理 AI 供应商和模型</p>
      </div>
      <div class="provider-layout" id="providerLayout">
        <div class="provider-list-panel" id="providerListPanel">
          <div class="provider-list" id="providerList"></div>
          <div class="provider-list-actions">
            <button class="btn btn-secondary btn-sm" onclick="Settings.showAddProvider()" style="width:100%;">+ 添加供应商</button>
          </div>
        </div>
        <div class="provider-detail-panel" id="providerDetailPanel">
          ${selectedProviderId ? '' : '<div class="provider-empty-hint">选择左侧供应商查看详情<br>或点击下方按钮添加新供应商</div>'}
        </div>
      </div>`;
    _renderProviderList();
    if (selectedProviderId) _renderProviderDetail(selectedProviderId);
  }

  function _renderProviderList() {
    const list = document.getElementById('providerList');
    if (!list) return;

    if (providers.length === 0) {
      list.innerHTML = '<div class="provider-list-empty">暂无供应商</div>';
    } else {
      list.innerHTML = providers.map(p => `
        <div class="provider-item ${p.id === selectedProviderId ? 'active' : ''}"
             onclick="Settings.selectProvider('${p.id}')">
          <div class="provider-item-info">
            <div class="provider-item-name">${_esc(p.name)}</div>
            <div class="provider-item-type">${_esc(p.provider_type)}</div>
          </div>
          <span class="provider-status-dot ${p.is_enabled ? 'enabled' : 'disabled'}"></span>
        </div>
      `).join('');
    }
  }

  function selectProvider(id) {
    // 切换到不同供应商时，检查是否有未保存的修改
    if (_isProviderDirty() && id !== selectedProviderId) {
      _showUnsavedModal(
        () => { saveProviderDetail(selectedProviderId); _doSelectProvider(id); },
        () => { _doSelectProvider(id); }
      );
      return;
    }
    _doSelectProvider(id);
  }

  function _doSelectProvider(id) {
    selectedProviderId = id;
    _renderProviderList();
    if (id) _renderProviderDetail(id);
    else {
      const panel = document.getElementById('providerDetailPanel');
      if (panel) panel.innerHTML = '<div class="provider-empty-hint">选择左侧供应商查看详情<br>或点击下方按钮添加新供应商</div>';
    }
  }

  function _renderProviderDetail(id) {
    const panel = document.getElementById('providerDetailPanel');
    if (!panel) return;
    const p = providers.find(x => x.id === id);
    if (!p) {
      panel.innerHTML = '<div class="provider-empty-hint">供应商不存在</div>';
      return;
    }

    const modelsHtml = (p.models || []).map(m => `
      <div class="model-item">
        <div class="model-item-info">
          <span class="model-name">${_esc(m.model_name)}</span>
          ${m.display_name && m.display_name !== m.model_name ? `<span class="model-display-name">${_esc(m.display_name)}</span>` : ''}
        </div>
        <div class="model-item-actions">
          <label class="toggle-switch" title="启用/停用">
            <input type="checkbox" ${m.is_enabled ? 'checked' : ''} onchange="Settings.toggleModel('${p.id}','${m.id}',this.checked)">
            <span class="toggle-slider"></span>
          </label>
          <button class="btn btn-ghost btn-sm" onclick="Settings.deleteModel('${p.id}','${m.id}')" title="删除模型">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
    `).join('');

    panel.innerHTML = `
      <div class="provider-detail-card">
        <div class="provider-detail-header">
          <div>
            <h4>${_esc(p.name)}</h4>
            <span class="tag tag-primary">${_esc(p.provider_type)}</span>
          </div>
          <div class="provider-detail-header-actions">
            <button class="btn btn-ghost btn-sm" onclick="Settings.toggleProvider('${p.id}')">
              ${p.is_enabled ? '停用' : '启用'}
            </button>
            <button class="btn btn-ghost btn-sm" style="color:var(--accent);" onclick="Settings.confirmDeleteProvider('${p.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              删除
            </button>
          </div>
        </div>

        <div class="form-group">
          <label>API Key</label>
          <div class="input-row">
            <input type="password" class="input" id="providerApiKey" value="${_escAttr(p.api_key || '')}" placeholder="sk-..." autocomplete="off">
            <button class="btn btn-ghost btn-sm" onclick="Settings.toggleVisible('providerApiKey')">显示</button>
          </div>
        </div>
        <div class="form-group">
          <label>Base URL</label>
          <input type="text" class="input" id="providerBaseUrl" value="${_escAttr(p.base_url)}" placeholder="https://api.example.com">
        </div>
        <div class="form-group">
          <label>API Path</label>
          <input type="text" class="input" id="providerApiPath" value="${_escAttr(p.api_path || '/v1/chat/completions')}" placeholder="/v1/chat/completions">
        </div>

        <button class="btn btn-primary btn-sm" onclick="Settings.saveProviderDetail('${p.id}')" style="margin-bottom:20px;">保存修改</button>

        <div class="provider-models-section">
          <div class="provider-models-header">
            <h5>模型</h5>
            <button class="btn btn-ghost btn-sm" onclick="Settings.showAddModel('${p.id}')">+ 添加</button>
          </div>
          <div class="model-list" id="modelList">
            ${modelsHtml || '<div class="model-list-empty">暂无模型</div>'}
          </div>
        </div>
      </div>`;
  }

  // ── 供应商操作 ──

  function showAddProvider() {
    const panel = document.getElementById('providerDetailPanel');
    if (!panel) return;

    const vendorOptions = vendorDefaults.map(v =>
      `<option value="${v.key}">${v.name}</option>`
    ).join('');

    panel.innerHTML = `
      <div class="provider-detail-card">
        <h4>添加供应商</h4>
        <div class="form-group">
          <label>选择厂商</label>
          <select class="input" id="newProviderVendor" onchange="Settings.onVendorChange()">
            <option value="custom">自定义</option>
            ${vendorOptions}
          </select>
        </div>
        <div class="form-group">
          <label>名称</label>
          <input type="text" class="input" id="newProviderName" placeholder="例如：DeepSeek">
        </div>
        <div class="form-group">
          <label>Base URL</label>
          <input type="text" class="input" id="newProviderBaseUrl" placeholder="https://api.example.com">
        </div>
        <div class="form-group">
          <label>API Path</label>
          <input type="text" class="input" id="newProviderApiPath" value="/v1/chat/completions">
        </div>
        <div class="form-group">
          <label>API Key（可留空稍后填写）</label>
          <input type="password" class="input" id="newProviderApiKey" placeholder="sk-...">
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" onclick="Settings.addProvider()">添加</button>
          <button class="btn btn-ghost" onclick="Settings.selectProvider(null)">取消</button>
        </div>
      </div>`;
  }

  function onVendorChange() {
    const vendorKey = document.getElementById('newProviderVendor')?.value;
    const v = vendorDefaults.find(x => x.key === vendorKey);
    if (!v) return;
    const nameEl = document.getElementById('newProviderName');
    const urlEl = document.getElementById('newProviderBaseUrl');
    const pathEl = document.getElementById('newProviderApiPath');
    if (nameEl && !nameEl.value) nameEl.value = v.name;
    if (urlEl) urlEl.value = v.base_url;
    if (pathEl) pathEl.value = v.api_path;
  }

  async function addProvider() {
    const vendorKey = document.getElementById('newProviderVendor')?.value || 'custom';
    const name = document.getElementById('newProviderName')?.value?.trim();
    const baseUrl = document.getElementById('newProviderBaseUrl')?.value?.trim();
    const apiPath = document.getElementById('newProviderApiPath')?.value?.trim() || '/v1/chat/completions';
    const apiKey = document.getElementById('newProviderApiKey')?.value?.trim() || '';

    if (!name || !baseUrl) {
      _showToast('请填写名称和 Base URL', 'error');
      return;
    }

    try {
      const result = await api.post('/api/providers', {
        name, provider_type: vendorKey, api_key: apiKey, base_url: baseUrl, api_path: apiPath, is_enabled: true
      });
      // 如果是已知厂商，自动添加默认模型
      if (vendorKey !== 'custom') {
        const v = vendorDefaults.find(x => x.key === vendorKey);
        if (v) {
          for (const modelName of v.default_models) {
            await api.post(`/api/providers/${result.id}/models`, { model_name: modelName, display_name: modelName });
          }
        }
      }
      await _fetchProviders();
      selectedProviderId = result.id;
      _renderProviderList();
      _renderProviderDetail(result.id);
      _showToast('供应商已添加', 'success');
    } catch (err) {
      _showToast('添加失败: ' + (err.message || '未知错误'), 'error');
    }
  }

  async function saveProviderDetail(id) {
    const apiKey = document.getElementById('providerApiKey')?.value || '';
    const baseUrl = document.getElementById('providerBaseUrl')?.value?.trim();
    const apiPath = document.getElementById('providerApiPath')?.value?.trim();

    if (!baseUrl) {
      _showToast('请填写 Base URL', 'error');
      return;
    }

    try {
      await api.put(`/api/providers/${id}`, {
        api_key: apiKey, base_url: baseUrl, api_path: apiPath
      });
      await _fetchProviders();
      _renderProviderDetail(id);
      _showSaveToast();
    } catch (err) {
      _showToast('保存失败: ' + (err.message || '未知错误'), 'error');
    }
  }

  async function toggleProvider(id) {
    try {
      await api.put(`/api/providers/${id}/toggle`);
      await _fetchProviders();
      _renderProviderList();
      _renderProviderDetail(id);
    } catch (err) {
      _showToast('操作失败: ' + (err.message || ''), 'error');
    }
  }

  function confirmDeleteProvider(id) {
    const p = providers.find(x => x.id === id);
    if (!p) return;
    _showConfirmModal(
      '删除供应商',
      `确定要删除供应商「${p.name}」吗？<br>关联的模型也会一并删除。`,
      () => _deleteProvider(id)
    );
  }

  function _showConfirmModal(title, msg, onOk, confirmText = '确认删除', accent = true) {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    const btnClass = accent ? 'btn btn-accent' : 'btn btn-primary';
    ov.innerHTML = `<div class="modal-dialog" style="max-width:400px;"><h3>${title}</h3><p>${msg}</p><div class="modal-actions"><button class="btn btn-ghost" id="_scCancel">取消</button><button class="${btnClass}" id="_scOk">${confirmText}</button></div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('#_scCancel').onclick = () => ov.remove();
    ov.querySelector('#_scOk').onclick = () => { ov.remove(); onOk(); };
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  }

  async function _deleteProvider(id) {
    try {
      await api.del(`/api/providers/${id}`);
      await _fetchProviders();
      selectedProviderId = null;
      _renderProviderList();
      document.getElementById('providerDetailPanel').innerHTML = '<div class="provider-empty-hint">选择左侧供应商查看详情</div>';
      _showToast('已删除', 'info');
    } catch (err) {
      _showToast('删除失败: ' + (err.message || ''), 'error');
    }
  }

  // ── 供应商脏检查 ──

  function _isProviderDirty() {
    if (!selectedProviderId) return false;
    const p = providers.find(x => x.id === selectedProviderId);
    if (!p) return false;

    const apiKeyEl = document.getElementById('providerApiKey');
    const baseUrlEl = document.getElementById('providerBaseUrl');
    const apiPathEl = document.getElementById('providerApiPath');
    // 如果表单字段不存在（未渲染详情），则无脏数据
    if (!apiKeyEl || !baseUrlEl || !apiPathEl) return false;

    const apiKey = apiKeyEl.value;
    const baseUrl = baseUrlEl.value.trim();
    const apiPath = apiPathEl.value.trim();

    return apiKey !== (p.api_key || '') ||
           baseUrl !== (p.base_url || '') ||
           apiPath !== (p.api_path || '/v1/chat/completions');
  }

  // ── 模型操作 ──

  function showAddModel(providerId) {
    const modelList = document.getElementById('modelList');
    if (!modelList) return;
    const addRow = document.createElement('div');
    addRow.className = 'model-item model-item-add';
    addRow.innerHTML = `
      <input type="text" class="input" id="newModelName" placeholder="模型名称，如 gpt-4o" style="flex:1;">
      <button class="btn btn-primary btn-sm" onclick="Settings.addModel('${providerId}')">确认</button>
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.model-item').remove()">取消</button>
    `;
    modelList.insertBefore(addRow, modelList.firstChild);
    setTimeout(() => document.getElementById('newModelName')?.focus(), 50);
  }

  async function addModel(providerId) {
    const nameEl = document.getElementById('newModelName');
    const modelName = nameEl?.value?.trim();
    if (!modelName) { _showToast('请输入模型名称', 'error'); return; }

    try {
      await api.post(`/api/providers/${providerId}/models`, { model_name: modelName });
      await _fetchProviders();
      _renderProviderDetail(providerId);
    } catch (err) {
      _showToast('添加失败: ' + (err.message || ''), 'error');
    }
  }

  async function toggleModel(providerId, modelId, enabled) {
    try {
      await api.put(`/api/providers/${providerId}/models/${modelId}`, { is_enabled: enabled });
      // 静默更新本地数据
      const p = providers.find(x => x.id === providerId);
      if (p) {
        const m = (p.models || []).find(x => x.id === modelId);
        if (m) m.is_enabled = enabled;
      }
    } catch (_) { /* ignore */ }
  }

  async function deleteModel(providerId, modelId) {
    try {
      await api.del(`/api/providers/${providerId}/models/${modelId}`);
      await _fetchProviders();
      _renderProviderDetail(providerId);
    } catch (err) {
      _showToast('删除失败: ' + (err.message || ''), 'error');
    }
  }

  // ── 其他 section ──

  function _renderShortcuts(container) {
    container.innerHTML = `
      <div class="settings-section-header"><h3>快捷键</h3></div>
      <div class="settings-card">
        <div class="shortcut-list">
          <div class="shortcut-row"><span>打开/隐藏文件树</span><kbd>Ctrl + B</kbd></div>
          <div class="shortcut-row"><span>聚焦输入框</span><kbd>Ctrl + K</kbd></div>
          <div class="shortcut-row"><span>新建对话</span><kbd>Ctrl + N</kbd></div>
        </div>
      </div>`;
  }

  function _renderUsage(container) {
    container.innerHTML = `
      <div class="settings-section-header"><h3>用量统计</h3><p class="section-desc">API 调用次数和 Token 消耗</p></div>
      <div class="settings-card"><p style="color:var(--text-sub);text-align:center;padding:20px;">用量统计功能开发中…</p></div>`;
  }

  function _renderAbout(container) {
    container.innerHTML = `
      <div class="settings-section-header"><h3>关于</h3></div>
      <div class="settings-card" style="text-align:center;padding:30px;">
        <div style="font-size:1.2rem;font-weight:700;color:var(--text-h1);margin-bottom:6px;">Lubia</div>
        <div style="color:var(--text-sub);">版本 0.2.0</div>
        <div style="color:var(--text-tip);font-size:0.8rem;margin-top:6px;">桌面 AI 学习伙伴</div>
        <div style="color:var(--text-tip);font-size:0.75rem;margin-top:16px;">Tauri 2.0 + Python FastAPI</div>
      </div>
      <div class="settings-card" style="margin-top:14px;text-align:center;padding:16px;font-size:0.75rem;color:var(--text-tip);line-height:1.8;">
        <p>编辑器内核：<a href="#" onclick="event.preventDefault();Settings.openExternal('https://codemirror.net/');" style="color:var(--primary);">CodeMirror 6</a></p>
        <p>&copy; 2018–2024 Marijn Haverbeke and contributors</p>
        <p style="font-size:0.7rem;opacity:0.7;">基于 MIT 许可证使用</p>
      </div>
      <div class="settings-card" style="margin-top:8px;text-align:center;padding:16px;font-size:0.75rem;color:var(--text-tip);line-height:1.8;">
        <p>向量数据库：<a href="#" onclick="event.preventDefault();Settings.openExternal('https://github.com/asg017/sqlite-vec');" style="color:var(--primary);">sqlite-vec</a></p>
        <p>&copy; 2024–2025 Alex Garcia (asg017)</p>
        <p style="font-size:0.7rem;opacity:0.7;">基于 MIT 许可证使用</p>
      </div>
      <div class="settings-card" style="margin-top:8px;text-align:center;padding:16px;font-size:0.75rem;color:var(--text-tip);line-height:1.8;">
        <p>Embedding 模型：<a href="#" onclick="event.preventDefault();Settings.openExternal('https://huggingface.co/BAAI/bge-small-zh-v1.5');" style="color:var(--primary);">bge-small-zh-v1.5</a></p>
        <p>&copy; BAAI (北京智源人工智能研究院)</p>
        <p style="font-size:0.7rem;opacity:0.7;">基于 MIT 许可证使用</p>
      </div>
      <div class="settings-card" style="margin-top:8px;text-align:center;padding:16px;font-size:0.75rem;color:var(--text-tip);line-height:1.8;">
        <p>Embedding 框架：<a href="#" onclick="event.preventDefault();Settings.openExternal('https://www.sbert.net/');" style="color:var(--primary);">Sentence-Transformers</a></p>
        <p>&copy; 2019–2025 Nils Reimers and contributors</p>
        <p style="font-size:0.7rem;opacity:0.7;">基于 Apache 2.0 许可证使用</p>
      </div>`;
  }

  // ===== 辅助 =====

  function openExternal(url, name) {
    name = name || '外部链接';
    _showConfirmModal(
      '打开外部链接',
      `将使用默认浏览器打开 ${name}（${url}），确定继续吗？`,
      () => {
        if (typeof Bridge !== 'undefined' && Bridge.isTauri()) {
          Bridge.openExternal(url);
        } else {
          window.open(url, '_blank');
        }
        _showToast('已在默认浏览器中打开', 'info');
      },
      '打开',
      false
    );
  }

  function openCodeMirrorSite() {
    openExternal('https://codemirror.net/', 'CodeMirror 官网');
  }

  function toggleVisible(inputId) {
    const el = document.getElementById(inputId);
    if (el) el.type = el.type === 'password' ? 'text' : 'password';
  }

  function _showToast(msg, type) {
    if (typeof App !== 'undefined' && App.showToast) {
      App.showToast(msg, type || 'info');
    }
  }

  function _showSaveToast() {
    _showToast('已保存', 'success');
    // 找到页面上最近被点击的保存按钮，给即时反馈
    const btn = document.querySelector('#settingsContent .btn-primary');
    if (btn && btn.textContent.includes('保存')) {
      const orig = btn.textContent;
      btn.textContent = '已保存!';
      btn.style.background = 'linear-gradient(135deg, #3DA55D, #4DB868)';
      btn.style.cursor = 'default';
      btn.style.pointerEvents = 'none';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.background = '';
        btn.style.cursor = '';
        btn.style.pointerEvents = '';
      }, 1500);
    }
  }

  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function _escAttr(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ===== 公开 API =====

  return {
    mount, destroy,
    switchSection, selectProvider,
    showAddProvider, onVendorChange, addProvider,
    saveProviderDetail, toggleProvider, confirmDeleteProvider,
    showAddModel, addModel, toggleModel, deleteModel,
    onThemeChange, onFontSizeInput, onMaxTurnsChange, onMaxLoopRoundsChange, onMaxLoopRoundsPlanChange, restoreDefaults,
    onKbModelChange, _loadKbModelSelector,
    openExternal, openCodeMirrorSite, toggleVisible,
  };
})();
