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
    this._usageSaveTimer = null;
    this._usageCacheFile = path.join(os.homedir(), '.gemini', 'config', 'claude-desktop-usage-cache.json');
    this._legacyUsageCacheFile = path.join(os.homedir(), '.gemini', 'config', 'obsidian-prism-usage-rollup-cache.json');
    this._loadUsageDiskCache();
  }

  _hasRealTokens(record) {
    if (!record || !record.days || typeof record.days !== 'object') return false;
    if (Number(record.calls || 0) > 0) return true;
    for (const d of Object.values(record.days)) {
      if (d && Number(d.total || d.tokens || 0) > 0) return true;
    }
    return false;
  }

  _scheduleSaveUsageDiskCache() {
    if (this._usageSaveTimer) return;
    this._usageSaveTimer = setTimeout(() => {
      this._usageSaveTimer = null;
      this._saveUsageDiskCache();
    }, 2500);
  }

  _ingestTrajectoryToUsageCache(id, rawTrajectory, summaryStub = null) {
    if (!id || !rawTrajectory || !this.usageCore?.analyzeTrajectoryForUsage) return null;
    try {
      const low = String(id).toLowerCase();
      const record = this.usageCore.analyzeTrajectoryForUsage(rawTrajectory, summaryStub || {}, id);
      if (!record || !record.days) return null;
      const prev = this._usageCache.get(low);
      // 若已有真实 Token 缓存而新解析结果为空，保留旧缓存避免退化为 0
      if (prev && this._hasRealTokens(prev.record) && !this._hasRealTokens(record)) {
        return prev.record;
      }
      const stepCount = Number(record.stepCount || summaryStub?.stepCount || prev?.stepCount || 0) || 0;
      const lastModifiedSec = Number(record.lastModifiedSec || prev?.lastModifiedSec || Math.floor(Date.now() / 1000)) || 0;
      this._usageCache.set(low, {
        stepCount,
        lastModifiedSec,
        dbMtimeSec: Number(record.dbMtimeSec || prev?.dbMtimeSec || 0) || 0,
        dbSize: Number(record.dbSize || prev?.dbSize || 0) || 0,
        record,
      });
      this._scheduleSaveUsageDiskCache();
      return record;
    } catch {
      return null;
    }
  }

  _loadUsageDiskCache() {
    for (const file of [this._legacyUsageCacheFile, this._usageCacheFile]) {
      try {
        if (!fs.existsSync(file)) continue;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const local = parsed?.scopes?.local || parsed?.entries || {};
        if (!local || typeof local !== 'object') continue;
        for (const [k, hit] of Object.entries(local)) {
          if (hit?.record?.days) {
            this._usageCache.set(String(k).toLowerCase(), hit);
          }
        }
      } catch {}
    }
  }

  _saveUsageDiskCache() {
    try {
      const entries = {};
      for (const [k, v] of this._usageCache.entries()) {
        if (v?.record?.days) entries[k] = v;
      }
      fs.mkdirSync(path.dirname(this._usageCacheFile), { recursive: true });
      fs.writeFileSync(
        this._usageCacheFile,
        JSON.stringify({ version: 1, scopes: { local: entries } }),
        'utf8'
      );
    } catch {}
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
    const timeoutMs = method === 'Probe' ? 2600 : method === 'GetCascadeTrajectory' ? 25000 : 12000;
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
      onTrajectory: (_scope, id, raw) => {
        const sum = this._lazyStore?.summaries?.find?.((s) => String(s?.id || '').toLowerCase() === String(id || '').toLowerCase());
        this._ingestTrajectoryToUsageCache(id, raw, sum || null);
      },
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

  async fetchBackendSummaries(client, { softTimeoutMs = 3500 } = {}) {
    const byId = new Map();
    const list = [];
    // 1. 尝试从 LS / Renderer 获取在线摘要（带软超时，绝不阻塞磁盘缓存返回）
    try {
      const resp = await Promise.race([
        client.call('GetAllCascadeTrajectories', {}),
        new Promise((resolve) => setTimeout(() => resolve(null), softTimeoutMs)),
      ]);
      const map = resp?.trajectorySummaries || {};
      for (const [id, raw] of Object.entries(map)) {
        if (!GUID_RE.test(id)) continue;
        const item = { id, ...raw };
        byId.set(id.toLowerCase(), item);
        list.push(item);
      }
    } catch {}
    // 2. 补充本地磁盘会话列表（覆盖历史会话、补充 dbMtimeSec/dbSize 加速缓存命中，并作为软超时回退）
    try {
      const localRes = await discoverLocalConversations({ host: 'app' });
      const local = Array.isArray(localRes?.conversations) ? localRes.conversations : [];
      for (const item of local) {
        const id = String(item?.id || '').trim();
        if (!GUID_RE.test(id)) continue;
        const key = id.toLowerCase();
        const dbMtimeSec = item.dbMtimeMs > 0 ? Math.floor(item.dbMtimeMs / 1000) : 0;
        const dbSize = Number(item.dbSize || 0) || 0;
        const mtimeSec = item.mtimeMs > 0 ? Math.floor(item.mtimeMs / 1000) : dbMtimeSec;
        const existing = byId.get(key);
        if (existing) {
          if (dbMtimeSec > 0 && !existing.dbMtimeSec) existing.dbMtimeSec = dbMtimeSec;
          if (dbSize > 0 && !existing.dbSize) existing.dbSize = dbSize;
        } else {
          const stub = {
            id,
            ...(dbMtimeSec > 0 ? { dbMtimeSec } : {}),
            ...(dbSize > 0 ? { dbSize } : {}),
            ...(mtimeSec > 0 ? { lastModifiedSec: mtimeSec } : {}),
          };
          byId.set(key, stub);
          list.push(stub);
        }
      }
    } catch {}
    return { byId, list };
  }

  async handleUsageCall(parsed) {
    const action = parsed?.action || 'fetch-batch';
    const client = await this.ensureLsClient();
    const { byId, list } = await this.fetchBackendSummaries(client, {
      softTimeoutMs: action === 'list-summaries' ? 3000 : 5000,
    });

    if (action === 'list-summaries') {
      const cachedRecords = [];
      const present = new Set();
      for (const s of list) {
        const key = String(s.id || '').toLowerCase();
        present.add(key);
        const hit = this._usageCache.get(key);
        if (hit?.record?.days) {
          cachedRecords.push({ id: s.id, mode: 'full', record: hit.record });
        }
      }
      for (const [key, hit] of this._usageCache.entries()) {
        if (present.has(key)) continue;
        if (hit?.record?.days) {
          cachedRecords.push({ id: hit.record.cascadeId || key, mode: 'full', archived: true, record: hit.record });
        }
      }
      return { ok: true, scopeKey: 'local', records: cachedRecords, summaries: list };
    }

    const reqItems = Array.isArray(parsed?.items) ? parsed.items.slice(0, 8) : [];
    const records = [];
    let dirty = false;
    for (const item of reqItems) {
      const id = String(item?.id || '').trim();
      if (!GUID_RE.test(id)) continue;
      const low = id.toLowerCase();
      const bSum = byId.get(low) || {};
      const stepCount = Number(item.stepCount || bSum.stepCount || 0) || 0;
      const lastModifiedSec = Number(item.lastModifiedSec || bSum.lastModifiedSec || 0) || 0;
      const hit = this._usageCache.get(low);
      const hitHasTok = Boolean(hit && this._hasRealTokens(hit.record));
      const sameSteps = hitHasTok && (stepCount === 0 || Number(hit.stepCount || 0) === stepCount);
      const closeTime = !lastModifiedSec || !hit?.lastModifiedSec || Math.abs(Number(hit.lastModifiedSec) - lastModifiedSec) <= 5;
      if (hitHasTok && sameSteps && closeTime) {
        records.push({ id, mode: 'full', record: hit.record });
        continue;
      }
      try {
        const summaryStub = {
          ...bSum,
          stepCount,
          lastModifiedTime: lastModifiedSec > 0 ? { seconds: lastModifiedSec } : bSum.lastModifiedTime,
        };
        const fullTraj = typeof client.trajectory === 'function'
          ? await client.trajectory(id, { force: Boolean(parsed?.force), summary: summaryStub })
          : await client.call('GetCascadeTrajectory', { cascadeId: id });
        const record = this.usageCore.analyzeTrajectoryForUsage(fullTraj, summaryStub, id);
        if (record && record.days && (this._hasRealTokens(record) || !hitHasTok)) {
          this._usageCache.set(low, {
            stepCount: stepCount || Number(record.stepCount || 0),
            lastModifiedSec: lastModifiedSec || Number(record.lastModifiedSec || 0),
            record,
          });
          dirty = true;
          records.push({ id, mode: 'full', record });
        } else if (hit?.record?.days) {
          records.push({ id, mode: 'full', record: hit.record });
        }
      } catch {
        if (hit?.record?.days) {
          records.push({ id, mode: 'full', record: hit.record });
        }
      }
    }
    if (dirty) this._saveUsageDiskCache();
    return {
      ok: true,
      scopeKey: 'local',
      records,
      ...(parsed?.includeSummaries ? { summaries: list } : {}),
    };
  }

  async handleMetricsCall(input) {
    const store = await this.ensureMetricsStore();
    const cid = input?.conversationId && GUID_RE.test(input.conversationId) ? input.conversationId : null;
    // 支持仅跳过单会话 4.5s 缓存而不强制刷服务端配额接口
    if (cid && input?.sessionForce && !input?.force) {
      const entry = store.sessions?.get?.(cid.toLowerCase());
      if (entry) entry.updatedAt = 0;
    }
    return await store.snapshot({
      conversationId: cid,
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
    process.on('unhandledRejection', (reason) => {
      this.log(`[error] unhandledRejection: ${String(reason?.stack || reason)}`);
    });
    process.on('uncaughtException', (err) => {
      this.log(`[error] uncaughtException: ${String(err?.stack || err)}`);
    });
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
