/**
 * Antigravity Claude Desktop — 轻量前端运行时 (src/claude-runtime.js)
 *
 * 职责：
 * 1. 注入纯净 Claude 暖羊皮纸样式表并实时同步宿主深浅色主题；
 * 2. 在对话左侧原生圆点导航栏旁挂载可搜索的提问大纲悬浮目录；
 * 3. 在设置弹窗「外观」页提供极简 3 开关配置卡片，并在「浏览器」下方单开独立「用量统计」页；
 * 4. 维护与后台守护进程的轻量 RPC 桥（设置持久化、用量统计、配额查询），支持 100% 无损卸载。
 */
(function (root) {
  'use strict';
  const W = root || (typeof window !== 'undefined' ? window : globalThis);
  const D = W?.document;
  if (!W || !D) return;

  const STYLE_ID = 'ag-claude-desktop-css';
  const SETTING_BINDING = '__agClaudeSetting';
  const USAGE_BINDING = '__agPrismUsageCall';
  const METRICS_BINDING = '__agPrismMetricsCall';
  const PLUGIN_VERSION = '1.0.0';

  const isFn = (v) => typeof v === 'function';

  // 创建轻量异步 RPC 桥（供 usage-panel.js 调用守护进程的 usage / metrics 采集器）
  function createRpcBridge(bindingName, timeoutMs, fallbackFactory) {
    let seq = 1;
    const pending = new Map();
    const resolve = (id, payload) => {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      item.resolve(payload);
    };
    const send = (body, customTimeout) => {
      const fn = W[bindingName];
      if (!isFn(fn)) return Promise.resolve(fallbackFactory({ offline: true }));
      const id = seq++;
      return new Promise((res) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          res(fallbackFactory({ timeout: true }));
        }, customTimeout || timeoutMs);
        pending.set(id, { resolve: res, timer });
        try {
          fn(JSON.stringify({ id, ...body }));
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          res(fallbackFactory({ error: String(err?.message || err) }));
        }
      });
    };
    const dispose = () => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.resolve(fallbackFactory({ disposed: true }));
      }
      pending.clear();
    };
    return { send, resolve, dispose };
  }

  function ensureBridges() {
    if (!W.__agPrismUsageBridge?.__claudeReady) {
      try { W.__agPrismUsageBridge?.dispose?.(); } catch {}
      const fu = (x) => ({ ok: false, records: [], summaries: [], ...x });
      const rpc = createRpcBridge(USAGE_BINDING, 18000, fu);
      W.__agPrismUsageBridge = {
        __claudeReady: true,
        isOnline: () => isFn(W[USAGE_BINDING]),
        fetchBatch: (o, ms = 18000) =>
          o && typeof o === 'object' && !Array.isArray(o)
            ? rpc.send({ action: o.action || 'fetch-batch', items: Array.isArray(o.items) ? o.items : [], includeSummaries: Boolean(o.includeSummaries) }, ms)
            : rpc.send({ action: 'fetch-batch', items: Array.isArray(o) ? o : [] }, ms),
        listSummaries: (ms = 12000) => rpc.send({ action: 'list-summaries', items: [], includeSummaries: true }, ms),
        resolve: rpc.resolve,
        dispose: rpc.dispose,
      };
      W.__agPrismUsageResolve = rpc.resolve;
    }

    if (!W.__agPrismMetricsBridge?.__claudeReady) {
      try { W.__agPrismMetricsBridge?.dispose?.(); } catch {}
      const fm = (x) => ({ connection: 'offline', groups: [], ...x });
      const rpc = createRpcBridge(METRICS_BINDING, 12000, fm);
      W.__agPrismMetricsBridge = {
        __claudeReady: true,
        isOnline: () => isFn(W[METRICS_BINDING]),
        getMetrics: (input, ms = 12000) => rpc.send({ input: input || {} }, ms),
        resolve: rpc.resolve,
        dispose: rpc.dispose,
      };
      W.__agPrismMetricsResolve = rpc.resolve;
    }
  }

  function mountClaudeDesktop(initialConfig, cssText) {
    if (W.__agClaudeDesktop?.destroy) {
      try { W.__agClaudeDesktop.destroy(); } catch {}
    }

    let cfg = {
      enabled: true,
      hostLocalization: 'on',
      navOutline: true,
      ...(initialConfig && typeof initialConfig === 'object' ? initialConfig : {}),
    };

    let destroyed = false;
    let mutating = false;
    let syncTimer = 0;
    let usageCtl = null;
    let usageModRef = null;

    // 左侧提问大纲状态
    let outlinePopover = null;
    let outlineList = null;
    let outlineTitle = null;
    let outlineSearch = null;
    let outlineFilter = '';
    let outlineHideTimer = 0;
    let activeNavRail = null;

    const runGuardedMut = (fn) => {
      mutating = true;
      try { return fn(); } finally { mutating = false; }
    };

    const setAttrIfChanged = (el, k, v) => {
      if (!el) return;
      if (v === null || v === undefined) {
        if (el.hasAttribute(k)) el.removeAttribute(k);
      } else if (el.getAttribute(k) !== String(v)) {
        el.setAttribute(k, String(v));
      }
    };

    const isZhUi = () => {
      if (cfg.hostLocalization === 'on') return true;
      const lang = String(D.documentElement?.lang || W.navigator?.language || '').toLowerCase();
      return lang.startsWith('zh');
    };

    const getLang = () => (isZhUi() ? 'zh-CN' : 'en');

    const getUsageUiText = (lang) => {
      const zh = String(lang || '').toLowerCase().startsWith('zh');
      return zh
        ? {
            tabOverview: '总览',
            tabModels: '模型',
            tabQuotas: '配额',
            kpiSessions: '会话数',
            kpiCalls: '消息数',
            kpiTokens: '总 Token',
            kpiDays: '活跃天数',
            kpiCacheHit: '缓存命中率',
            kpiFavModel: '常用模型',
            workspaceAll: '全部项目',
            quotaPoolsTitle: '模型配额池余量',
            refreshBtnTitle: '刷新',
            quotaLoading: '加载配额中…',
            quotaEmptyHint: '正在等待实时配额快照…',
            noModelUsage: '暂无模型用量记录',
            weeklyLabel: '周配额',
            fiveHourLabel: '5小时',
            showLess: '收起',
            showMoreN: (n) => `展开其余 ${n} 项`,
          }
        : {
            tabOverview: 'Overview',
            tabModels: 'Models',
            tabQuotas: 'Quotas',
            kpiSessions: 'Sessions',
            kpiCalls: 'Messages',
            kpiTokens: 'Total tokens',
            kpiDays: 'Active days',
            kpiCacheHit: 'Cache Hit Rate',
            kpiFavModel: 'Favorite model',
            workspaceAll: 'All Projects',
            quotaPoolsTitle: 'Model Quota Pools Remaining',
            refreshBtnTitle: 'Refresh',
            quotaLoading: 'Loading quotas…',
            quotaEmptyHint: 'Waiting for live quota snapshot…',
            noModelUsage: 'No model usage data yet',
            weeklyLabel: 'Weekly',
            fiveHourLabel: '5h',
            showLess: 'Show less',
            showMoreN: (n) => `Show ${n} more`,
          };
    };

    const detectDarkTheme = () => {
      const html = D.documentElement;
      const body = D.body;
      const cls = `${html?.className || ''} ${body?.className || ''}`.toLowerCase();
      if (/\b(theme-light|light-theme|light)\b/.test(cls)) return false;
      if (/\b(theme-dark|dark-theme|dark)\b/.test(cls)) return true;
      const scheme = W.getComputedStyle?.(body || html)?.colorScheme || '';
      if (/dark/i.test(scheme) && !/light/i.test(scheme)) return true;
      if (/light/i.test(scheme) && !/dark/i.test(scheme)) return false;
      const bg = W.getComputedStyle?.(body || html)?.backgroundColor || '';
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
        return lum < 128;
      }
      return Boolean(W.matchMedia?.('(prefers-color-scheme: dark)')?.matches);
    };

    const applyThemeAndStyle = () => {
      const html = D.documentElement;
      if (!html) return;
      runGuardedMut(() => {
        setAttrIfChanged(html, 'data-ag-claude-mounted', '1');
        setAttrIfChanged(html, 'data-ag-claude-version', PLUGIN_VERSION);
        setAttrIfChanged(html, 'data-ag-claude-theme', detectDarkTheme() ? 'dark' : 'light');
        setAttrIfChanged(html, 'data-ag-claude', cfg.enabled ? '1' : null);
        let st = D.getElementById(STYLE_ID);
        if (!st) {
          st = D.createElement('style');
          st.id = STYLE_ID;
          st.setAttribute('data-ag-claude-owned', '1');
          (D.head || html).appendChild(st);
        }
        if (st.textContent !== cssText) st.textContent = cssText;
      });
    };

    const sendSettingAction = (payload) => {
      const fn = W[SETTING_BINDING];
      if (!isFn(fn)) return;
      try { fn(JSON.stringify(payload)); } catch {}
    };

    const saveSetting = (key, value) => {
      cfg = { ...cfg, [key]: value };
      applyThemeAndStyle();
      scheduleSync();
      sendSettingAction({ action: 'patch-setting', key, value });
    };

    // ── 对话区左侧圆点大纲目录 ──────────────────────────────────────────────
    const closeOutline = () => {
      if (outlineHideTimer) { clearTimeout(outlineHideTimer); outlineHideTimer = 0; }
      if (outlinePopover) outlinePopover.hidden = true;
    };

    const scheduleCloseOutline = () => {
      if (outlineHideTimer) clearTimeout(outlineHideTimer);
      outlineHideTimer = setTimeout(() => {
        outlineHideTimer = 0;
        closeOutline();
      }, 220);
    };

    const collectTurnItems = () => {
      const conv = D.querySelector('[data-testid="conversation-view"]');
      if (!conv) return [];
      const steps = Array.from(conv.querySelectorAll('[data-testid="user-input-step"], [data-testid="user-message-bubble"], .agy-user-bubble'));
      // 去重：若选中了外层 user-input-step，跳过内部子气泡
      const unique = [];
      for (const el of steps) {
        if (unique.some((p) => p.contains(el) || el.contains(p))) continue;
        unique.push(el);
      }
      const vp = conv.querySelector('[data-testid="autoscroll-viewport"]');
      const vr = vp?.getBoundingClientRect?.();
      const midY = vr && vr.height > 0 ? vr.top + vr.height * 0.35 : 240;
      let activeIdx = unique.length - 1;
      for (let i = 0; i < unique.length; i++) {
        const r = unique[i].getBoundingClientRect?.();
        if (r && r.top <= midY) activeIdx = i;
      }
      return unique.map((el, i) => ({
        el,
        turnNum: i + 1,
        text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 72) || `#${i + 1}`,
        active: i === activeIdx,
      }));
    };

    const renderOutlineList = () => {
      if (!outlineList || !outlineTitle) return;
      const zh = isZhUi();
      const items = collectTurnItems();
      outlineTitle.textContent = zh ? `提问导航 · ${items.length} 轮` : `Outline · ${items.length} turns`;
      const q = outlineFilter.trim().toLowerCase();
      runGuardedMut(() => {
        outlineList.innerHTML = '';
        let shown = 0;
        for (const it of items) {
          const num = `#${it.turnNum}`;
          if (q && !it.text.toLowerCase().includes(q) && !num.includes(q)) continue;
          const btn = D.createElement('button');
          btn.type = 'button';
          btn.className = 'ag-claude-outline-item';
          if (it.active) btn.setAttribute('data-active', '1');
          const nSpan = D.createElement('span');
          nSpan.className = 'ag-claude-outline-num';
          nSpan.textContent = num;
          const tSpan = D.createElement('span');
          tSpan.className = 'ag-claude-outline-text';
          tSpan.textContent = it.text;
          btn.appendChild(nSpan);
          btn.appendChild(tSpan);
          btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            try { it.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
            closeOutline();
          });
          outlineList.appendChild(btn);
          shown++;
        }
        if (shown === 0) {
          const emp = D.createElement('div');
          emp.className = 'ag-claude-outline-empty';
          emp.textContent = zh ? '无匹配提问' : 'No matching prompts';
          outlineList.appendChild(emp);
        }
      });
    };

    const ensureOutlineUi = () => {
      if (!cfg.navOutline || !cfg.enabled) {
        D.querySelectorAll('.ag-claude-outline-trigger, .ag-claude-outline-popover').forEach((n) => n.remove());
        outlinePopover = outlineList = outlineTitle = outlineSearch = activeNavRail = null;
        return;
      }
      const firstDot = D.querySelector('[data-testid="conversation-navigator-turn"]');
      const navRail = firstDot?.closest('[data-testid="conversation-view"]') ? firstDot.parentElement?.parentElement || firstDot.parentElement : null;
      const hostParent = navRail?.parentElement;
      if (!navRail || !hostParent) return;
      activeNavRail = navRail;

      let trigger = hostParent.querySelector('.ag-claude-outline-trigger');
      if (!trigger) {
        trigger = D.createElement('button');
        trigger.type = 'button';
        trigger.className = 'ag-claude-outline-trigger';
        trigger.setAttribute('data-ag-claude-owned', '1');
        trigger.setAttribute('data-ag-no-i18n', '');
        trigger.setAttribute('aria-label', isZhUi() ? '提问导航' : 'Prompt outline');
        trigger.textContent = '☰';
        const open = () => {
          if (outlineHideTimer) { clearTimeout(outlineHideTimer); outlineHideTimer = 0; }
          ensurePopover(hostParent);
          renderOutlineList();
          if (outlinePopover) outlinePopover.hidden = false;
        };
        trigger.addEventListener('pointerenter', open);
        trigger.addEventListener('pointerleave', scheduleCloseOutline);
        trigger.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (outlinePopover && !outlinePopover.hidden) closeOutline();
          else open();
        });
        runGuardedMut(() => hostParent.appendChild(trigger));
      }
    };

    const ensurePopover = (hostParent) => {
      if (outlinePopover && outlinePopover.parentElement === hostParent) return outlinePopover;
      if (outlinePopover) outlinePopover.remove();
      const pop = D.createElement('div');
      pop.className = 'ag-claude-outline-popover';
      pop.setAttribute('data-ag-claude-owned', '1');
      pop.setAttribute('data-ag-no-i18n', '');
      pop.hidden = true;

      const head = D.createElement('div');
      head.className = 'ag-claude-outline-head';
      const title = D.createElement('span');
      title.className = 'ag-claude-outline-title';
      head.appendChild(title);

      const search = D.createElement('input');
      search.type = 'search';
      search.className = 'ag-claude-outline-search';
      search.placeholder = isZhUi() ? '过滤本会话提问…' : 'Filter prompts…';
      search.addEventListener('input', () => {
        outlineFilter = search.value || '';
        renderOutlineList();
      });
      search.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.stopPropagation(); closeOutline(); }
        else if (ev.key === 'Enter') outlineList?.querySelector('.ag-claude-outline-item')?.click?.();
      });

      const list = D.createElement('div');
      list.className = 'ag-claude-outline-list';

      pop.appendChild(head);
      pop.appendChild(search);
      pop.appendChild(list);
      pop.addEventListener('pointerenter', () => {
        if (outlineHideTimer) { clearTimeout(outlineHideTimer); outlineHideTimer = 0; }
      });
      pop.addEventListener('pointerleave', () => {
        if (D.activeElement !== search) scheduleCloseOutline();
      });

      runGuardedMut(() => hostParent.appendChild(pop));
      outlinePopover = pop;
      outlineTitle = title;
      outlineSearch = search;
      outlineList = list;
      return pop;
    };

    // ── 用量统计控制器（按需挂载至设置弹窗独立栏） ─────────────────────────
    const getUsageController = () => {
      const mod = W.__agPrismHomeStudioPanel || W.__agHomeStudioPanel;
      const usageCore = W.__agCsUsageCore;
      if (!mod || !isFn(mod.createHomeStudioPanelController) || !usageCore) return null;
      if (usageCtl && usageModRef === mod) return usageCtl;
      try { usageCtl?.dispose?.(); } catch {}
      usageModRef = mod;
      usageCtl = mod.createHomeStudioPanelController({
        usageCore,
        storageUsageCacheKey: 'ag-claude:trajRollup.v1',
        isDestroyed: () => destroyed,
        getHomeLayout: () => 'classic',
        getLang,
        uiText: getUsageUiText,
        getDisplayName: () => '',
        ensureHooks: () => ({ store: null }),
        canMountRealCanvas: () => true,
        setAttrIfChanged,
        runGuardedMut,
      });
      return usageCtl;
    };

    // ── 设置弹窗增强（极简外观卡片 + 「浏览器」下方独立「用量统计」栏） ─────
    const locateSettingsDialog = () => {
      for (const dlg of D.querySelectorAll('div[role="dialog"]')) {
        const navBtns = Array.from(dlg.querySelectorAll('button, [role="tab"]'));
        const hasSettingsNav = navBtns.some((b) =>
          /^(?:general|appearance|browser|shortcuts|通用|外观|外觀|浏览器|瀏覽器|快捷键)$/i.test((b.textContent || '').trim())
        );
        if (!hasSettingsNav) continue;
        // 找到包含导航按钮的左列容器
        const anchor = navBtns.find((b) =>
          /^(?:appearance|browser|外观|外觀|浏览器|瀏覽器)$/i.test((b.textContent || '').trim())
        );
        let navCol = anchor?.parentElement || null;
        while (navCol && navCol.parentElement && navCol.parentElement !== dlg) {
          const sib = navCol.nextElementSibling;
          if (sib && sib.getBoundingClientRect().width > 240) break;
          navCol = navCol.parentElement;
        }
        if (navCol) return { dlg, navCol };
      }
      return null;
    };

    const syncSettingsDialog = () => {
      const hit = locateSettingsDialog();
      if (!hit) return;
      const { dlg, navCol } = hit;
      const zh = isZhUi();

      runGuardedMut(() => {
        setAttrIfChanged(dlg, 'data-ag-claude-settings-dlg', '1');
        setAttrIfChanged(navCol, 'data-ag-claude-settings-nav', '1');
      });

      const findRightPane = () => {
        for (let cur = navCol; cur && cur !== dlg; cur = cur.parentElement) {
          const sib = cur.nextElementSibling;
          if (sib && sib !== navCol) return sib;
        }
        return dlg.querySelector('div.p-6')?.parentElement || null;
      };

      const closeUsagePane = () => {
        const pane = dlg.querySelector('#ag-cs-usage-settings-pane');
        if (pane) runGuardedMut(() => pane.remove());
        runGuardedMut(() => {
          dlg.removeAttribute('data-ag-usage-open');
          dlg.querySelectorAll('[data-ag-claude-usage-hidden="1"]').forEach((n) => n.removeAttribute('data-ag-claude-usage-hidden'));
          const nb = navCol.querySelector('[data-ag-claude-usage-nav="1"]');
          if (nb) nb.removeAttribute('data-ag-usage-open');
        });
        try { usageCtl?.unmountExternal?.(); } catch {}
      };

      const openUsagePane = (btn) => {
        const rightPane = findRightPane();
        if (!rightPane) return;
        const usageLabel = zh ? '用量统计' : 'Usage & Quotas';
        const usageDesc = zh
          ? '查看本地会话活动热力图、模型 Token 分布与实时配额池余量。'
          : 'View local session heatmap, model token breakdown, and live quota pools.';
        const loadingText = zh ? '正在加载用量统计…' : 'Loading usage statistics…';

        runGuardedMut(() => {
          dlg.setAttribute('data-ag-usage-open', '1');
          btn.setAttribute('data-ag-usage-open', '1');
          for (const ch of Array.from(rightPane.children)) {
            if (ch.id === 'ag-cs-usage-settings-pane') continue;
            if (ch.tagName === 'BUTTON' && /close|关闭|關閉/i.test(ch.getAttribute('aria-label') || '')) continue;
            ch.setAttribute('data-ag-claude-usage-hidden', '1');
          }
          let pane = rightPane.querySelector('#ag-cs-usage-settings-pane');
          if (!pane) {
            pane = D.createElement('div');
            pane.id = 'ag-cs-usage-settings-pane';
            pane.setAttribute('data-ag-no-i18n', '');
            pane.setAttribute('data-ag-claude-owned', '1');
            const hdr = D.createElement('div');
            hdr.className = 'ag-cs-usage-settings-head';
            const h2 = D.createElement('h2');
            h2.textContent = usageLabel;
            const desc = D.createElement('p');
            desc.textContent = usageDesc;
            hdr.appendChild(h2);
            hdr.appendChild(desc);
            const host = D.createElement('div');
            host.className = 'ag-cs-usage-settings-host';
            const ld = D.createElement('div');
            ld.className = 'ag-cs-usage-settings-loading';
            ld.setAttribute('data-ag-usage-loading', '1');
            ld.textContent = loadingText;
            host.appendChild(ld);
            pane.appendChild(hdr);
            pane.appendChild(host);
            rightPane.appendChild(pane);
          }
        });

        const host = rightPane.querySelector('#ag-cs-usage-settings-pane .ag-cs-usage-settings-host');
        if (!host) return;
        const tryMount = (retries) => {
          if (destroyed || !host.isConnected) return;
          const ctl = getUsageController();
          if (ctl && isFn(ctl.mountInto)) {
            const ld = host.querySelector('[data-ag-usage-loading="1"]');
            if (ld) runGuardedMut(() => ld.remove());
            ctl.mountInto(host);
            return;
          }
          if (retries === 30 || retries % 5 === 0) {
            sendSettingAction({ action: 'request-usage-panel' });
          }
          if (retries > 0) setTimeout(() => tryMount(retries - 1), 150);
        };
        tryMount(30);
      };

      // 绑定左侧栏其他按钮点击自动关闭用量页
      if (!navCol.__agClaudeNavBound) {
        navCol.__agClaudeNavBound = true;
        navCol.addEventListener('click', (ev) => {
          const targetBtn = ev.target?.closest?.('button, [role="tab"], a');
          if (!targetBtn || targetBtn.getAttribute('data-ag-claude-usage-nav') === '1') return;
          if (dlg.querySelector('#ag-cs-usage-settings-pane')) closeUsagePane();
        }, true);
      }

      // 在「浏览器」正下方注入「用量统计」按钮
      const usageLabel = zh ? '用量统计' : 'Usage & Quotas';
      let usageBtn = navCol.querySelector('[data-ag-claude-usage-nav="1"]');
      if (!usageBtn) {
        const btns = Array.from(navCol.querySelectorAll('button, [role="tab"]'));
        const anchor =
          btns.find((b) => /^(?:browser|浏览器|瀏覽器|ブラウザ)$/i.test((b.textContent || '').trim())) ||
          btns.find((b) => /^(?:appearance|外观|外觀)$/i.test((b.textContent || '').trim())) ||
          btns[btns.length - 1];
        if (anchor && anchor.parentElement) {
          usageBtn = D.createElement('button');
          usageBtn.type = 'button';
          usageBtn.className = (anchor.className || '')
            .replace(/\b(?:bg-secondary|bg-card|bg-background|shadow(?:-[a-z0-9-]+)?)\b/g, '')
            .trim();
          usageBtn.setAttribute('data-ag-claude-usage-nav', '1');
          usageBtn.setAttribute('data-ag-claude-owned', '1');
          usageBtn.setAttribute('data-ag-no-i18n', '');
          usageBtn.textContent = usageLabel;
          usageBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openUsagePane(usageBtn);
          });
          runGuardedMut(() => {
            if (anchor.nextSibling) anchor.parentElement.insertBefore(usageBtn, anchor.nextSibling);
            else anchor.parentElement.appendChild(usageBtn);
          });
        }
      } else if (usageBtn.textContent !== usageLabel) {
        runGuardedMut(() => { usageBtn.textContent = usageLabel; });
      }

      // 在「外观」设置页注入极简 Claude Desktop 设置卡片（仅在当前页为外观页时显示，切换他页自动移除）
      const appearanceTitles = ['Appearance', '外观', '外觀', '外観'];
      let appearancePane = null;
      for (const h2 of dlg.querySelectorAll('h2')) {
        if (navCol.contains(h2)) continue;
        if (h2.closest('[data-ag-claude-usage-hidden="1"]')) continue;
        if (appearanceTitles.includes((h2.textContent || '').trim())) {
          appearancePane = h2.closest('div.p-6') || h2.parentElement?.parentElement;
          if (appearancePane) break;
        }
      }
      if (!appearancePane) {
        const stale = dlg.querySelector('#ag-claude-settings-card');
        if (stale) runGuardedMut(() => stale.remove());
        return;
      }

      let card = appearancePane.querySelector('#ag-claude-settings-card');
      const syncSwitchStates = (rootCard) => {
        if (!rootCard) return;
        const setChk = (id, on) => {
          const sw = rootCard.querySelector(`[data-claude-switch="${id}"]`);
          if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
        };
        setChk('enabled', Boolean(cfg.enabled));
        setChk('hostLocalization', cfg.hostLocalization === 'on');
        setChk('navOutline', Boolean(cfg.navOutline));
      };

      if (!card) {
        card = D.createElement('section');
        card.id = 'ag-claude-settings-card';
        card.setAttribute('data-ag-claude-owned', '1');
        card.setAttribute('data-ag-no-i18n', '');

        const head = D.createElement('div');
        head.className = 'ag-claude-set-head';
        const title = D.createElement('span');
        title.className = 'ag-claude-set-title';
        title.textContent = 'Claude Desktop';
        const ver = D.createElement('span');
        ver.className = 'ag-claude-set-ver';
        ver.textContent = `v${PLUGIN_VERSION}`;
        head.appendChild(title);
        head.appendChild(ver);
        card.appendChild(head);

        const addSwitchRow = (key, label, desc, getter, onToggle) => {
          const row = D.createElement('div');
          row.className = 'ag-claude-set-row';
          const left = D.createElement('div');
          const lEl = D.createElement('div');
          lEl.className = 'ag-claude-set-label';
          lEl.textContent = label;
          const dEl = D.createElement('div');
          dEl.className = 'ag-claude-set-desc';
          dEl.textContent = desc;
          left.appendChild(lEl);
          left.appendChild(dEl);
          const sw = D.createElement('button');
          sw.type = 'button';
          sw.className = 'ag-claude-switch';
          sw.setAttribute('role', 'switch');
          sw.setAttribute('data-claude-switch', key);
          sw.setAttribute('aria-checked', getter() ? 'true' : 'false');
          sw.addEventListener('click', () => {
            onToggle(!getter());
            syncSwitchStates(card);
          });
          row.appendChild(left);
          row.appendChild(sw);
          card.appendChild(row);
        };

        addSwitchRow(
          'enabled',
          zh ? '启用 Claude 暖羊皮纸外观' : 'Claude Warm Parchment Theme',
          zh ? '统一暖米白/深炭配色、无衬线正文、极简输入框与侧边栏排版' : 'Warm parchment palette, clean typography, minimalist composer and sidebar',
          () => Boolean(cfg.enabled),
          (next) => saveSetting('enabled', next)
        );
        addSwitchRow(
          'hostLocalization',
          zh ? '界面简体中文汉化' : 'Simplified Chinese UI Localization',
          zh ? '将 Antigravity 宿主界面与工作区文案本地化为简体中文' : 'Localize Antigravity host UI strings into Simplified Chinese',
          () => cfg.hostLocalization === 'on',
          (next) => saveSetting('hostLocalization', next ? 'on' : 'off')
        );
        addSwitchRow(
          'navOutline',
          zh ? '左侧提问大纲目录' : 'Prompt Outline Directory',
          zh ? '在对话区左缘圆点导航旁显示可搜索跳转的提问大纲' : 'Show searchable prompt outline alongside the turn-dot rail',
          () => Boolean(cfg.navOutline),
          (next) => saveSetting('navOutline', next)
        );

        // 快捷打开「用量统计」行
        const statRow = D.createElement('div');
        statRow.className = 'ag-claude-set-row';
        const sLeft = D.createElement('div');
        const sL = D.createElement('div');
        sL.className = 'ag-claude-set-label';
        sL.textContent = zh ? '用量统计与配额池' : 'Usage & Quota Pools';
        const sD = D.createElement('div');
        sD.className = 'ag-claude-set-desc';
        sD.textContent = zh ? '查看活动热力图、模型 Token 分布与实时配额余量' : 'Inspect heatmap, model token usage, and live quota remaining';
        sLeft.appendChild(sL);
        sLeft.appendChild(sD);
        const openBtn = D.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'ag-claude-btn';
        openBtn.textContent = zh ? '查看统计' : 'Open';
        openBtn.addEventListener('click', () => {
          const nb = navCol.querySelector('[data-ag-claude-usage-nav="1"]');
          if (nb) openUsagePane(nb);
        });
        statRow.appendChild(sLeft);
        statRow.appendChild(openBtn);
        card.appendChild(statRow);

        runGuardedMut(() => appearancePane.appendChild(card));
      } else {
        syncSwitchStates(card);
      }
    };

    const syncAll = () => {
      if (destroyed) return;
      ensureBridges();
      applyThemeAndStyle();
      ensureOutlineUi();
      syncSettingsDialog();
    };

    const scheduleSync = () => {
      if (destroyed || syncTimer) return;
      syncTimer = setTimeout(() => {
        syncTimer = 0;
        syncAll();
      }, 60);
    };

    const onDocClick = (ev) => {
      if (!outlinePopover || outlinePopover.hidden) return;
      const t = ev.target;
      if (outlinePopover.contains(t) || t?.closest?.('.ag-claude-outline-trigger')) return;
      closeOutline();
    };

    const obs = new MutationObserver(() => {
      if (mutating || destroyed) return;
      scheduleSync();
    });

    ensureBridges();
    applyThemeAndStyle();
    syncAll();

    obs.observe(D.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    W.addEventListener('click', onDocClick, true);

    const api = {
      version: PLUGIN_VERSION,
      getState: () => ({ cfg: { ...cfg } }),
      updateConfig: (nextCfg) => {
        if (nextCfg && typeof nextCfg === 'object') {
          cfg = { ...cfg, ...nextCfg };
          syncAll();
        }
      },
      sync: syncAll,
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        if (syncTimer) { clearTimeout(syncTimer); syncTimer = 0; }
        closeOutline();
        try { obs.disconnect(); } catch {}
        try { W.removeEventListener('click', onDocClick, true); } catch {}
        try { usageCtl?.dispose?.(); } catch {}
        usageCtl = null;
        try { D.getElementById(STYLE_ID)?.remove(); } catch {}
        try { D.getElementById('ag-prism-studio-v101-css')?.remove(); } catch {}
        try { D.querySelectorAll('[data-ag-claude-owned="1"]').forEach((n) => n.remove()); } catch {}
        try {
          D.querySelectorAll('[data-ag-claude-usage-hidden="1"]').forEach((n) => n.removeAttribute('data-ag-claude-usage-hidden'));
          D.querySelectorAll('[data-ag-usage-open]').forEach((n) => n.removeAttribute('data-ag-usage-open'));
          D.querySelectorAll('[data-ag-claude-settings-dlg]').forEach((n) => n.removeAttribute('data-ag-claude-settings-dlg'));
          D.querySelectorAll('[data-ag-claude-settings-nav]').forEach((n) => n.removeAttribute('data-ag-claude-settings-nav'));
        } catch {}
        const html = D.documentElement;
        if (html) {
          html.removeAttribute('data-ag-claude');
          html.removeAttribute('data-ag-claude-mounted');
          html.removeAttribute('data-ag-claude-version');
          html.removeAttribute('data-ag-claude-theme');
        }
        delete W.__agClaudeDesktop;
      },
    };

    W.__agClaudeDesktop = api;
    return api;
  }

  W.__agClaudeDesktopMount = mountClaudeDesktop;
  if (typeof module === 'object' && module.exports) {
    module.exports = { mountClaudeDesktop, STYLE_ID, PLUGIN_VERSION };
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
