#!/usr/bin/env node
/**
 * Antigravity Claude Desktop — 轻量后台守护进程 (sidecars/daemon/main.mjs)
 *
 * 职责：
 * 1. 自动发现 Antigravity CDP 端口并持久附着所有宿主窗口；
 * 2. 注入纯净 Claude 暖羊皮纸主题、提问大纲目录与精简设置页；
 * 3. 按配置注入宿主简体中文汉化；
 * 4. 懒加载本地用量统计与配额池采集器，仅在打开设置「用量统计」时响应查询。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  buildRendererRpcExpression,
  extractModelLabelMap,
  normalizeRendererUserStatus,
  normalizeRendererQuotaSummary,
  normalizeRendererSummaries,
  normalizeRendererTrajectory,
} from '../../vendor/telemetry/sidecars/panel/renderer-rpc-adapter.mjs';
import { discoverLocalConversations } from '../../vendor/telemetry/sidecars/panel/local-conversations.mjs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, port: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) out.root = path.resolve(argv[++i]);
    else if (argv[i] === '--port' && argv[i + 1]) {
      const p = parseInt(argv[++i], 10);
      if (Number.isInteger(p) && p > 0) out.port = p;
    }
  }
  return out;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class ClaudeDesktopDaemon {
  constructor({ rootDir = DEFAULT_ROOT, overridePort = null } = {}) {
    this.rootDir = rootDir;
    this.overridePort = overridePort;
    this.cdp = require(path.join(rootDir, 'src', 'cdp-core.js'));
    this.usageCore = require(path.join(rootDir, 'src', 'usage-core.js'));
    this.pidFile = path.join(rootDir, '.daemon.pid');
    this.logFile = path.join(rootDir, 'daemon.log');
    this.sessions = new Map();
    this.running = false;
    this.pollTimer = null;
    this.activePort = null;

    // 懒加载遥测 / 用量状态
    this._lazyStore = null;
    this._lazyClient = null;
    this._modelLabels = new Map();
    this._usageCache = new Map();
  }

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      fs.appendFileSync(this.logFile, line, 'utf8');
    } catch {}
  }

  acquirePidLock() {
    try {
      if (fs.existsSync(this.pidFile)) {
        const oldPid = parseInt(fs.readFileSync(this.pidFile, 'utf8').trim(), 10);
        if (oldPid && oldPid !== process.pid && isPidAlive(oldPid)) {
          return false;
        }
      }
      fs.writeFileSync(this.pidFile, String(process.pid), 'utf8');
      return true;
    } catch {
      return true;
    }
  }

  releasePidLock() {
    try {
      if (fs.existsSync(this.pidFile)) {
        const cur = parseInt(fs.readFileSync(this.pidFile, 'utf8').trim(), 10);
        if (cur === process.pid) fs.unlinkSync(this.pidFile);
      }
    } catch {}
  }

  resolveTelemetryDataDir() {
    const dir = path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'antigravity-claude-desktop', 'telemetry');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  }

  // 通过已附着主窗口执行 Renderer LS RPC（读取配额与会话轨迹元数据）
  async _invokeRendererRpc(method, body = {}) {
    const expr = buildRendererRpcExpression(method, body);
    const timeoutMs = method === 'Probe' ? 2600 : 12000;
    let lastErr = null;
    for (const entry of this.sessions.values()) {
      if (!entry || entry.session.closed) continue;
      try {
        const res = await entry.session.evaluate(expr, true, timeoutMs);
        if (!res || res.ok !== true) {
          lastErr = new Error(String(res?.error || 'renderer_ls_unavailable'));
          continue;
        }
        const raw = res.data;
        if (method === 'Probe') return raw;
        if (method === 'GetUserStatus') {
          const norm = normalizeRendererUserStatus(raw);
          const labels = extractModelLabelMap(norm);
          for (const [k, v] of labels.entries()) this._modelLabels.set(k, v);
          return norm;
        }
        if (method === 'RetrieveUserQuotaSummary') return normalizeRendererQuotaSummary(raw);
        if (method === 'GetAllCascadeTrajectories') return normalizeRendererSummaries(raw);
        if (method === 'GetCascadeTrajectory') {
          return normalizeRendererTrajectory(raw, body?.cascadeId, this._modelLabels);
        }
        return raw;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Antigravity 主窗口未连接');
  }

  async ensureMetricsStore() {
    if (this._lazyStore) return this._lazyStore;
    const modUrl = new URL('../../vendor/telemetry/sidecars/panel/store.mjs', import.meta.url);
    const { MetricsStore } = await import(modUrl.href);
    this._lazyStore = new MetricsStore({
      dataDir: this.resolveTelemetryDataDir(),
      rendererRpc: (m, b) => this._invokeRendererRpc(m, b),
      ...(this.activePort ? { cdpPort: this.activePort } : {}),
    });
    return this._lazyStore;
  }

  async ensureLsClient() {
    if (this._lazyClient) return this._lazyClient;
    if (this._lazyStore?.client) {
      this._lazyClient = this._lazyStore.client;
      return this._lazyClient;
    }
    const modUrl = new URL('../../vendor/telemetry/sidecars/panel/client.mjs', import.meta.url);
    const { AntigravityClient } = await import(modUrl.href);
    this._lazyClient = new AntigravityClient({
      rendererRpc: (m, b) => this._invokeRendererRpc(m, b),
      ...(this.activePort ? { cdpPort: this.activePort } : {}),
    });
    return this._lazyClient;
  }

  async fetchBackendSummaries(client) {
    const byId = new Map();
    const list = [];
    // 1. 尝试从 LS / Renderer 获取在线摘要
    try {
      const resp = await client.call('GetAllCascadeTrajectories', {});
      const map = resp?.trajectorySummaries || {};
      for (const [id, raw] of Object.entries(map)) {
        if (!GUID_RE.test(id)) continue;
        const item = { id, ...raw };
        byId.set(id.toLowerCase(), item);
        list.push(item);
      }
    } catch {}
    // 2. 补充本地磁盘会话列表（覆盖历史会话）
    try {
      const local = discoverLocalConversations();
      for (const item of Array.isArray(local) ? local : []) {
        const id = String(item?.id || '').trim();
        if (!GUID_RE.test(id)) continue;
        const key = id.toLowerCase();
        if (!byId.has(key)) {
          byId.set(key, item);
          list.push(item);
        }
      }
    } catch {}
    return { byId, list };
  }

  async handleUsageCall(parsed) {
    const action = parsed?.action || 'fetch-batch';
    const client = await this.ensureLsClient();
    const { byId, list } = await this.fetchBackendSummaries(client);

    if (action === 'list-summaries') {
      const cachedRecords = [];
      for (const s of list) {
        const hit = this._usageCache.get(String(s.id || '').toLowerCase());
        if (hit?.record?.days) {
          cachedRecords.push({ id: s.id, mode: 'full', record: hit.record });
        }
      }
      return { ok: true, scopeKey: 'local', records: cachedRecords, summaries: list };
    }

    const reqItems = Array.isArray(parsed?.items) ? parsed.items.slice(0, 16) : [];
    const records = [];
    for (const item of reqItems) {
      const id = String(item?.id || '').trim();
      if (!GUID_RE.test(id)) continue;
      const low = id.toLowerCase();
      const bSum = byId.get(low) || {};
      const stepCount = Number(item.stepCount || bSum.stepCount || 0) || 0;
      const lastModifiedSec = Number(item.lastModifiedSec || bSum.lastModifiedSec || 0) || 0;
      const hit = this._usageCache.get(low);
      if (hit && hit.stepCount === stepCount && hit.lastModifiedSec === lastModifiedSec && hit.record?.days) {
        records.push({ id, mode: 'full', record: hit.record });
        continue;
      }
      try {
        const gmRes = typeof client._fetchMetadataOnly === 'function'
          ? await client._fetchMetadataOnly(id)
          : await client.call('GetCascadeTrajectoryGeneratorMetadata', {
              cascadeId: id,
              generatorMetadataOffset: 0,
              includeMessages: false,
            });
        const items = gmRes?.generatorMetadata || gmRes?.generatorMetadatas || [];
        const summaryStub = {
          ...bSum,
          stepCount,
          lastModifiedTime: lastModifiedSec > 0 ? { seconds: lastModifiedSec } : bSum.lastModifiedTime,
        };
        const record = this.usageCore.buildUsageRecordFromGeneratorMetadata(id, items, summaryStub);
        if (record) {
          this._usageCache.set(low, { stepCount, lastModifiedSec, record });
          records.push({ id, mode: 'full', record });
        }
      } catch {
        // 单条轨迹不可读时不阻断整批统计
      }
    }
    return {
      ok: true,
      scopeKey: 'local',
      records,
      ...(parsed?.includeSummaries ? { summaries: list } : {}),
    };
  }

  async handleMetricsCall(input) {
    const store = await this.ensureMetricsStore();
    return await store.snapshot({
      conversationId: input?.conversationId && GUID_RE.test(input.conversationId) ? input.conversationId : null,
      force: Boolean(input?.force),
      quotaRefresh: Boolean(input?.quotaRefresh),
      selectLatest: input?.selectLatest === false ? false : true,
    });
  }

  async handleBindingCall(entry, params) {
    const { name, payload, executionContextId } = params || {};
    if (typeof payload !== 'string' || payload.length > 65536) return;
    let parsed;
    try { parsed = JSON.parse(payload); } catch { return; }

    if (name === this.cdp.SETTING_BINDING) {
      if (parsed?.action === 'patch-setting' && typeof parsed.key === 'string') {
        const cur = this.cdp.readConfig(this.rootDir);
        const next = this.cdp.writeConfig({ ...cur, [parsed.key]: parsed.value }, this.rootDir);
        await this.broadcastRefresh(next);
      } else if (parsed?.action === 'request-usage-panel') {
        const expr = this.cdp.buildUsagePanelExpression(this.rootDir);
        if (expr && !entry.session.closed) {
          await entry.session.evaluate(expr, false, 6000).catch(() => {});
          entry.usagePanelMounted = true;
        }
      }
      return;
    }

    if (name === this.cdp.USAGE_BINDING) {
      const reqId = Number.isSafeInteger(parsed?.id) ? parsed.id : null;
      if (reqId === null) return;
      let result;
      try {
        result = await this.handleUsageCall(parsed);
      } catch (err) {
        result = { ok: false, records: [], summaries: [], error: String(err?.message || err) };
      }
      if (!entry.session.closed) {
        const expr = `window.__agPrismUsageResolve?.(${reqId}, ${this.cdp.serializeForEval(result)})`;
        const p = { expression: expr, returnByValue: true };
        if (typeof executionContextId === 'number' && executionContextId > 0) p.contextId = executionContextId;
        await entry.session.send('Runtime.evaluate', p, 4000).catch(() => {});
      }
      return;
    }

    if (name === this.cdp.METRICS_BINDING) {
      const reqId = Number.isSafeInteger(parsed?.id) ? parsed.id : null;
      if (reqId === null) return;
      let result;
      try {
        result = await this.handleMetricsCall(parsed?.input || {});
      } catch (err) {
        result = { connection: 'error', groups: [], error: String(err?.message || err) };
      }
      if (!entry.session.closed) {
        const expr = `window.__agPrismMetricsResolve?.(${reqId}, ${this.cdp.serializeForEval(result)})`;
        const p = { expression: expr, returnByValue: true };
        if (typeof executionContextId === 'number' && executionContextId > 0) p.contextId = executionContextId;
        await entry.session.send('Runtime.evaluate', p, 4000).catch(() => {});
      }
    }
  }

  async injectEntry(entry, cfgOverride = null) {
    if (!entry || entry.session.closed) return;
    const cfg = cfgOverride || this.cdp.readConfig(this.rootDir);
    const mainExpr = this.cdp.buildInjectExpression(cfg, this.rootDir);
    const i18nExpr = this.cdp.buildHostI18nExpression(cfg, this.rootDir);

    if (entry.scriptId) {
      await entry.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId }).catch(() => {});
      entry.scriptId = null;
    }
    const addMain = await entry.session.send('Page.addScriptToEvaluateOnNewDocument', { source: mainExpr }).catch(() => null);
    if (addMain?.identifier) entry.scriptId = addMain.identifier;

    if (entry.i18nScriptId) {
      await entry.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.i18nScriptId }).catch(() => {});
      entry.i18nScriptId = null;
    }
    if (i18nExpr && cfg.hostLocalization === 'on') {
      const addI18n = await entry.session.send('Page.addScriptToEvaluateOnNewDocument', { source: i18nExpr }).catch(() => null);
      if (addI18n?.identifier) entry.i18nScriptId = addI18n.identifier;
    }

    await entry.session.evaluate(mainExpr, false, 6000).catch(() => null);
    if (i18nExpr) {
      await entry.session.evaluate(i18nExpr, false, 6000).catch(() => null);
    }
  }

  async broadcastRefresh(cfg) {
    const tasks = [];
    for (const entry of this.sessions.values()) {
      if (entry && !entry.session.closed) tasks.push(this.injectEntry(entry, cfg));
    }
    await Promise.allSettled(tasks);
  }

  async attachTarget(target) {
    if (this.sessions.has(target.id)) return;
    const session = await this.cdp.CdpSession.connect(target.webSocketDebuggerUrl, 5000);
    const entry = {
      id: target.id,
      title: target.title || '',
      session,
      scriptId: null,
      i18nScriptId: null,
      usagePanelMounted: false,
    };
    this.sessions.set(target.id, entry);

    session.on('close', () => {
      this.sessions.delete(target.id);
    });

    try {
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      session.on('Runtime.bindingCalled', (p) => {
        void this.handleBindingCall(entry, p);
      });
      await session.send('Runtime.addBinding', { name: this.cdp.SETTING_BINDING });
      await session.send('Runtime.addBinding', { name: this.cdp.USAGE_BINDING });
      await session.send('Runtime.addBinding', { name: this.cdp.METRICS_BINDING });
      await this.injectEntry(entry);
      this.log(`[ok] Attached & injected Claude Desktop v${this.cdp.PLUGIN_VERSION}: ${target.title}`);
    } catch (err) {
      this.log(`[warn] Attach failed for ${target.title}: ${err?.message || err}`);
      session.close();
      this.sessions.delete(target.id);
    }
  }

  async pollOnce() {
    const port = this.overridePort || this.cdp.readPort();
    if (!port) return;
    this.activePort = port;
    let pages = [];
    try {
      pages = await this.cdp.listPages(port);
    } catch {
      return;
    }
    const aliveIds = new Set(pages.map((p) => p.id));
    for (const [id, entry] of this.sessions.entries()) {
      if (!aliveIds.has(id) || entry.session.closed) {
        entry.session.close();
        this.sessions.delete(id);
      }
    }
    for (const page of pages) {
      if (!this.sessions.has(page.id)) {
        await this.attachTarget(page).catch(() => {});
      }
    }
  }

  async start() {
    if (!this.acquirePidLock()) {
      process.exit(0);
    }
    this.running = true;
    this.log(`[boot] ClaudeDesktopDaemon started (pid=${process.pid}, root=${this.rootDir})`);
    await this.pollOnce();
    const tick = async () => {
      if (!this.running) return;
      await this.pollOnce();
      const interval = this.cdp.readConfig(this.rootDir).pollIntervalMs || 2500;
      this.pollTimer = setTimeout(tick, interval);
    };
    this.pollTimer = setTimeout(tick, this.cdp.readConfig(this.rootDir).pollIntervalMs || 2500);

    const stop = () => this.stop();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('exit', () => this.releasePidLock());
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const entry of this.sessions.values()) entry.session.close();
    this.sessions.clear();
    this.releasePidLock();
    process.exit(0);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const daemon = new ClaudeDesktopDaemon({ rootDir: args.root, overridePort: args.port });
  daemon.start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { ClaudeDesktopDaemon };
