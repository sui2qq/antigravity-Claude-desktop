'use strict';

/**
 * Antigravity Claude Desktop — 轻量 CDP 连接与脚本注入构建核心 (src/cdp-core.js)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const PLUGIN_ID = 'antigravity-claude-desktop';
const PLUGIN_VERSION = '1.0.0';
const SETTING_BINDING = '__agClaudeSetting';
const USAGE_BINDING = '__agPrismUsageCall';
const METRICS_BINDING = '__agPrismMetricsCall';

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const APP_DATA = IS_MAC
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : IS_WIN
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

const PORT_FILE = path.join(APP_DATA, 'Antigravity', 'DevToolsActivePort');

const DEFAULT_CONFIG = {
  enabled: true,
  hostLocalization: 'on',
  navOutline: true,
  pollIntervalMs: 2500,
};

function sanitizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    hostLocalization: src.hostLocalization === 'off' ? 'off' : 'on',
    navOutline: src.navOutline !== false,
    pollIntervalMs:
      Number.isFinite(Number(src.pollIntervalMs)) && Number(src.pollIntervalMs) >= 1000
        ? Math.min(15000, Math.floor(Number(src.pollIntervalMs)))
        : DEFAULT_CONFIG.pollIntervalMs,
  };
}

function readConfig(rootDir = ROOT_DIR) {
  const cfgPath = path.join(rootDir, 'config.json');
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
    return sanitizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(nextCfg, rootDir = ROOT_DIR) {
  const merged = sanitizeConfig(nextCfg);
  const cfgPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

function readPort(portFile = PORT_FILE) {
  if (process.env.AG_CDP_PORT) {
    const envPort = parseInt(process.env.AG_CDP_PORT, 10);
    if (Number.isInteger(envPort) && envPort > 0) return envPort;
  }
  try {
    const text = fs.readFileSync(portFile, 'utf8');
    const port = parseInt(text.split(/\r?\n/)[0].trim(), 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function isEligibleTarget(target) {
  if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  const url = String(target.url || '').toLowerCase();
  if (!url) return false;
  const title = String(target.title || '').trim();
  if (/^(?:launchpad|untitled)$/i.test(title)) return false;
  if (url.startsWith('vscode-file://') || url.startsWith('app://')) return true;
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(url)) return true;
  return false;
}

async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`CDP HTTP ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) ? list.filter(isEligibleTarget) : [];
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.seq = 1;
    this.closed = false;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      if (msg && Number.isInteger(msg.id)) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
        else entry.resolve(msg.result);
      } else if (msg && msg.method) {
        const set = this.listeners.get(msg.method);
        if (set) {
          for (const fn of set) {
            try { fn(msg.params || {}); } catch {}
          }
        }
      }
    });

    const handleClose = () => {
      if (this.closed) return;
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP session closed'));
      }
      this.pending.clear();
      const set = this.listeners.get('close');
      if (set) {
        for (const fn of set) {
          try { fn(); } catch {}
        }
      }
    };

    ws.addEventListener('close', handleClose);
    ws.addEventListener('error', handleClose);
  }

  static async connect(wsUrl, timeoutMs = 5000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed')); }, { once: true });
    });
    return new CdpSession(ws);
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
  }

  send(method, params = {}, timeoutMs = 6000) {
    if (this.closed) return Promise.reject(new Error('CDP session closed'));
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async evaluate(expression, awaitPromise = false, timeoutMs = 6000) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: Boolean(awaitPromise) },
      timeoutMs
    );
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Eval error');
    }
    return res?.result?.value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(); } catch {}
  }
}

function serializeForEval(val) {
  return JSON.stringify(val).replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));
}

function hashText(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);
}

// 清理旧版 obsidian-prism 注入痕迹（无缝迁移用）
const LEGACY_PRISM_CLEANUP_SNIPPET = `
  try {
    if (window.__agPrism?.destroy) window.__agPrism.destroy();
    if (window.__agClaudeStyle?.destroy) window.__agClaudeStyle.destroy();
    for (const id of ['ag-prism-css', 'ag-claude-style-css', 'ag-prism-settings-v101-css', 'ag-prism-omni-css', 'ag-prism-periodic-picker-css', 'ag-prism-wallpaper-css', 'ag-prism-suggester-css', 'ag-prism-motion-off-css', 'ag-prism-inline-diff-css']) {
      document.getElementById(id)?.remove();
    }
    document.querySelectorAll('#ag-prism-pulse-bar, #ag-cs-settings-sec, .ag-cs-nav-outline-trigger, .ag-cs-nav-outline-popover, .ag-cs-conv-aura-host, .ag-cs-prism-rim-cv, [data-ag-cs-usage-nav="1"]').forEach((n) => n.remove());
    const de = document.documentElement;
    if (de) {
      for (const a of Array.from(de.attributes)) {
        if (a.name.startsWith('data-ag-cs-') || a.name === 'data-ag-prism' || a.name.startsWith('data-ag-prism-')) {
          if (a.name !== 'data-ag-prism-host-i18n') de.removeAttribute(a.name);
        }
      }
    }
  } catch {}
`;

function buildInjectExpression(config = null, rootDir = ROOT_DIR) {
  const cfg = sanitizeConfig(config || readConfig(rootDir));
  const css = fs.readFileSync(path.join(rootDir, 'src', 'claude-desktop.css'), 'utf8');
  const runtimeSrc = fs.readFileSync(path.join(rootDir, 'src', 'claude-runtime.js'), 'utf8');
  const codeHash = hashText(css + '\n' + runtimeSrc);

  return `(() => {
    try {
      if (window.self !== window.top) return { ok: false, status: 'skipped-subframe' };
    } catch { return { ok: false, status: 'skipped-subframe' }; }
    const isHost = Boolean(
      document.body?.classList?.contains('theme-standalone') ||
      document.querySelector('.agy-shell, .agy-home, [data-testid="conversation-view"], [data-testid="sidebar-split"], [data-testid="agent-input-box"]')
    );
    if (!isHost && document.readyState !== 'loading') return { ok: false, status: 'skipped-non-host' };
    ${LEGACY_PRISM_CLEANUP_SNIPPET}
    const targetHash = ${serializeForEval(codeHash)};
    const nextCfg = ${serializeForEval(cfg)};
    const cssText = ${serializeForEval(css)};
    if (window.__agClaudeDesktop && window.__agClaudeDesktop.__codeHash === targetHash) {
      window.__agClaudeDesktop.updateConfig(nextCfg);
      return { ok: true, status: 'reused', codeHash: targetHash };
    }
    ${runtimeSrc};
    if (typeof window.__agClaudeDesktopMount !== 'function') return { ok: false, status: 'mount-missing' };
    const inst = window.__agClaudeDesktopMount(nextCfg, cssText);
    if (inst) inst.__codeHash = targetHash;
    return { ok: true, status: 'mounted', version: ${serializeForEval(PLUGIN_VERSION)}, codeHash: targetHash };
  })()`;
}

function buildUsagePanelExpression(rootDir = ROOT_DIR) {
  const usageCoreSrc = fs.readFileSync(path.join(rootDir, 'src', 'usage-core.js'), 'utf8');
  const usagePanelSrc = fs.readFileSync(path.join(rootDir, 'src', 'usage-panel.js'), 'utf8');
  const codeHash = hashText(usageCoreSrc + '\n' + usagePanelSrc);

  return `(() => {
    try {
      if (window.self !== window.top) return { ok: false, status: 'skipped-subframe' };
    } catch { return { ok: false, status: 'skipped-subframe' }; }
    const isHost = Boolean(
      document.body?.classList?.contains('theme-standalone') ||
      document.querySelector('.agy-shell, .agy-home, [data-testid="conversation-view"], [data-testid="sidebar-split"], [data-testid="agent-input-box"]')
    );
    if (!isHost) return { ok: false, status: 'skipped-non-host' };
    const targetHash = ${serializeForEval(codeHash)};
    if (window.__agPrismHomeStudioPanel?.__codeHash === targetHash && window.__agCsUsageCore) {
      return { ok: true, status: 'reused', codeHash: targetHash };
    }
    ${usageCoreSrc};
    ${usagePanelSrc};
    const mod = window.__agPrismHomeStudioPanel || globalThis.__agPrismHomeStudioPanel;
    if (mod && typeof mod === 'object') {
      mod.__codeHash = targetHash;
      window.__agPrismHomeStudioPanel = mod;
      globalThis.__agPrismHomeStudioPanel = mod;
    }
    return { ok: Boolean(mod && window.__agCsUsageCore), status: 'mounted', codeHash: targetHash };
  })()`;
}

function buildHostI18nExpression(config = null, rootDir = ROOT_DIR) {
  const cfg = sanitizeConfig(config || readConfig(rootDir));
  const i18nDir = path.join(rootDir, 'vendor', 'host-i18n');
  const runtimePath = path.join(i18nDir, 'host-i18n-runtime.js');
  const dictPath = path.join(i18nDir, 'zh-CN.json');
  if (!fs.existsSync(runtimePath) || !fs.existsSync(dictPath)) return '';

  const mode = cfg.hostLocalization === 'on' ? 'on' : 'off';
  if (mode === 'off') {
    return `(() => {
      try {
        window.__agPrismHostI18n?.setMode?.('off');
        window.__agPrismHostI18n?.destroy?.();
        document.documentElement?.removeAttribute?.('data-ag-prism-host-i18n');
      } catch {}
      return { ok: true, status: 'off' };
    })()`;
  }

  const runtimeSrc = fs.readFileSync(runtimePath, 'utf8');
  const dictRaw = fs.readFileSync(dictPath, 'utf8');
  const codeHash = hashText(runtimeSrc + '\n' + dictRaw.length);

  return `(() => {
    try {
      if (window.self !== window.top) return { ok: false, status: 'skipped-subframe' };
    } catch { return { ok: false, status: 'skipped-subframe' }; }
    const isHost = Boolean(
      document.body?.classList?.contains('theme-standalone') ||
      document.querySelector('.agy-shell, .agy-home, [data-testid="conversation-view"], [data-testid="sidebar-split"], [data-testid="agent-input-box"]')
    );
    if (!isHost) return { ok: false, status: 'skipped-non-host' };
    const targetHash = ${serializeForEval(codeHash)};
    const existing = window.__agPrismHostI18n;
    if (existing && existing.__claudeHash === targetHash && existing.getStatus?.()?.mode === 'on') {
      return { ok: true, status: 'reused', codeHash: targetHash };
    }
    try { existing?.destroy?.(); } catch {}
    ${runtimeSrc};
    const factory = window.__agPrismHostI18nFactory || globalThis.__agPrismHostI18nFactory;
    if (!factory || typeof factory.mountHostI18n !== 'function') return { ok: false, status: 'factory-missing' };
    const inst = factory.mountHostI18n({
      root: window,
      doc: document,
      mode: 'on',
      dict: ${dictRaw},
    });
    if (inst && typeof inst === 'object') inst.__claudeHash = targetHash;
    return { ok: true, status: 'mounted', codeHash: targetHash };
  })()`;
}

function buildRemoveExpression() {
  return `(() => {
    ${LEGACY_PRISM_CLEANUP_SNIPPET}
    try { window.__agClaudeDesktop?.destroy?.(); } catch {}
    try { window.__agPrismHostI18n?.destroy?.(); } catch {}
    try { window.__agPrismUsageBridge?.dispose?.(); } catch {}
    try { window.__agPrismMetricsBridge?.dispose?.(); } catch {}
    try { delete window.__agPrismHomeStudioPanel; delete window.__agHomeStudioPanel; delete window.__agCsUsageCore; } catch {}
    return { ok: true, status: 'removed' };
  })()`;
}

module.exports = {
  ROOT_DIR,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SETTING_BINDING,
  USAGE_BINDING,
  METRICS_BINDING,
  PORT_FILE,
  DEFAULT_CONFIG,
  sanitizeConfig,
  readConfig,
  writeConfig,
  readPort,
  isEligibleTarget,
  listPages,
  CdpSession,
  serializeForEval,
  buildInjectExpression,
  buildUsagePanelExpression,
  buildHostI18nExpression,
  buildRemoveExpression,
};
