#!/usr/bin/env node
'use strict';

/**
 * 一键干净卸载并还原页面 (scripts/remove.cjs)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TARGET_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-claude-desktop');
const cdp = require(path.join(ROOT_DIR, 'src', 'cdp-core.js'));

(async () => {
  // 停止后台守护进程
  const pidFile = path.join(TARGET_DIR, '.daemon.pid');
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (pid > 0) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
  }

  // 还原当前打开的 Antigravity 窗口 DOM 与样式
  const port = cdp.readPort();
  if (port) {
    const pages = await cdp.listPages(port).catch(() => []);
    const rmExpr = cdp.buildRemoveExpression();
    for (const page of pages) {
      const sess = await cdp.CdpSession.connect(page.webSocketDebuggerUrl, 4000).catch(() => null);
      if (!sess) continue;
      try {
        await sess.evaluate(rmExpr, false, 5000).catch(() => {});
        console.log(`[ok] Restored page: ${page.title}`);
      } finally {
        sess.close();
      }
    }
  }

  // 删除插件目录
  if (fs.existsSync(TARGET_DIR)) {
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
    console.log(`[ok] Removed plugin directory: ${TARGET_DIR}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
