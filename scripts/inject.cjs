#!/usr/bin/env node
'use strict';

/**
 * 手动单次热注入脚本 (scripts/inject.cjs)
 * 适用于本地改完样式后立即刷入当前已打开的 Antigravity 窗口。
 */

const path = require('node:path');
const ROOT_DIR = path.resolve(__dirname, '..');
const cdp = require(path.join(ROOT_DIR, 'src', 'cdp-core.js'));

(async () => {
  const port = cdp.readPort();
  if (!port) {
    console.error('[!] 未找到 Antigravity DevToolsActivePort，请确认已携带 --remote-debugging-port=0 启动。');
    process.exit(1);
  }
  const pages = await cdp.listPages(port);
  const cfg = cdp.readConfig(ROOT_DIR);
  const mainExpr = cdp.buildInjectExpression(cfg, ROOT_DIR);
  const telemetryExpr = cdp.buildTelemetryUiExpression(cfg, ROOT_DIR);
  const i18nExpr = cdp.buildHostI18nExpression(cfg, ROOT_DIR);

  console.log(`[+] CDP 端口 ${port}，发现 ${pages.length} 个窗口`);
  for (const page of pages) {
    const sess = await cdp.CdpSession.connect(page.webSocketDebuggerUrl, 5000);
    try {
      const r1 = await sess.evaluate(mainExpr, false, 6000);
      if (telemetryExpr) await sess.evaluate(telemetryExpr, false, 6000).catch(() => {});
      if (i18nExpr) await sess.evaluate(i18nExpr, false, 6000).catch(() => {});
      console.log(`[ok] ${page.title} -> ${JSON.stringify(r1)}`);
    } finally {
      sess.close();
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
