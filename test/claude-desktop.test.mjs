import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const cdp = require(path.join(ROOT, 'src', 'cdp-core.js'));

test('claude-desktop.css: lightweight, warm-parchment tokens, zero glassmorphism or white hairline', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'claude-desktop.css'), 'utf8');
  const bytes = Buffer.byteLength(css, 'utf8');
  assert.ok(bytes < 48_000, `Expected lightweight CSS (< 48 KB), got ${bytes} B`);
  assert.equal(css.includes('backdrop-filter'), false, 'Must not contain glassmorphism backdrop-filter');
  assert.equal(css.includes(':has('), false, 'Must avoid :has() for scroll/layout performance');
  assert.equal(css.includes('inset 0 1px 0 #FFFFFF'), false, 'Must not contain white top hairline shadow');
  assert.ok(css.includes('#FAF9F5') && css.includes('#F0EEE6'), 'Must include light warm parchment tokens');
  assert.ok(css.includes('#262624') && css.includes('#1F1E1D'), 'Must include dark warm charcoal tokens');
  assert.ok(css.includes('#C96442'), 'Must include terracotta accent');
  assert.ok(css.includes('height: 37px !important'), 'Must include 37px Claude-proportioned top nav items');
  assert.ok(css.includes('#ag-prism-pulse-bar'), 'Must anchor upstream telemetry pulse bar cleanly');
});

test('cdp-core.js: generates syntactically valid inject, telemetry-ui, usage-panel, host-i18n, and remove expressions', () => {
  const cfg = cdp.sanitizeConfig({ enabled: true, hostLocalization: 'on', navOutline: true, telemetryBar: true });
  const mainExpr = cdp.buildInjectExpression(cfg, ROOT);
  const telExpr = cdp.buildTelemetryUiExpression(cfg, ROOT);
  const usageExpr = cdp.buildUsagePanelExpression(ROOT);
  const i18nOnExpr = cdp.buildHostI18nExpression({ ...cfg, hostLocalization: 'on' }, ROOT);
  const i18nOffExpr = cdp.buildHostI18nExpression({ ...cfg, hostLocalization: 'off' }, ROOT);
  const rmExpr = cdp.buildRemoveExpression();

  assert.ok(mainExpr.length > 5000 && mainExpr.length < 95_000, `Unexpected main bundle size: ${mainExpr.length}`);
  assert.ok(telExpr.length > 80_000, 'Telemetry UI bundle should include upstream inline-fallback + vial bridge');
  assert.ok(usageExpr.length > 30_000, 'Usage panel bundle should include usage-core + usage-panel');
  assert.ok(i18nOnExpr.length > 100_000, 'Host i18n ON bundle should include runtime + zh-CN dict');
  assert.ok(i18nOffExpr.includes("status: 'off'"), 'Host i18n OFF should emit lightweight cleanup');

  for (const [label, src] of [
    ['main', mainExpr],
    ['telemetry-ui', telExpr],
    ['usage', usageExpr],
    ['i18n-on', i18nOnExpr],
    ['i18n-off', i18nOffExpr],
    ['remove', rmExpr],
  ]) {
    assert.doesNotThrow(() => new vm.Script(src), `Expression "${label}" must be valid JS`);
  }
});

test('daemon module: exports ClaudeDesktopDaemon cleanly and instantiates without side effects', async () => {
  const mod = await import(new URL('../sidecars/daemon/main.mjs', import.meta.url).href);
  assert.equal(typeof mod.ClaudeDesktopDaemon, 'function');
  const daemon = new mod.ClaudeDesktopDaemon({ rootDir: ROOT });
  assert.equal(daemon.running, false);
  assert.equal(daemon.cdp.PLUGIN_ID, 'antigravity-claude-desktop');
});

test('manifest & plugin files: plugin.json, sidecar.json, and vendor assets exist and parse cleanly', () => {
  const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
  const sidecarJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'sidecars', 'daemon', 'sidecar.json'), 'utf8'));
  assert.equal(pluginJson.name, 'antigravity-claude-desktop');
  assert.equal(sidecarJson.command, 'node');
  assert.deepEqual(sidecarJson.args, ['main.mjs']);
  assert.equal(fs.existsSync(path.join(ROOT, 'assets', 'logo.svg')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'vendor', 'host-i18n', 'host-i18n-runtime.js')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'vendor', 'host-i18n', 'zh-CN.json')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'vendor', 'telemetry', 'sidecars', 'panel', 'store.mjs')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'vendor', 'telemetry', 'compat', 'platform.mjs')), true);
  assert.equal(cdp.isEligibleTarget({ type: 'page', url: 'https://github.com/foo/bar', webSocketDebuggerUrl: 'ws://x', title: 'GitHub' }), false);
  assert.equal(cdp.isEligibleTarget({ type: 'page', url: 'https://127.0.0.1:58004/c/123', webSocketDebuggerUrl: 'ws://x', title: 'Antigravity' }), true);
});
