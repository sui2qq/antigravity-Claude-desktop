#!/usr/bin/env node
'use strict';

/**
 * Antigravity Claude Desktop — 一键安装与迁移脚本 (scripts/install.cjs)
 *
 * 职责：
 * 1. 自动停用并清理旧的 obsidian-prism 插件目录与守护进程（避免双插件样式冲突）；
 * 2. 将本插件同步部署至 ~/.gemini/config/plugins/antigravity-claude-desktop（保留已有 config.json）；
 * 3. 后台脱离终端拉起守护进程并立即完成当前 Antigravity 窗口热注入与自检。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins');
const TARGET_DIR = path.join(PLUGINS_DIR, 'antigravity-claude-desktop');
const LEGACY_PRISM_DIR = path.join(PLUGINS_DIR, 'obsidian-prism');

const cdp = require(path.join(ROOT_DIR, 'src', 'cdp-core.js'));

const SYNC_ENTRIES = [
  'plugin.json',
  'package.json',
  'config.example.json',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'assets',
  'src',
  'sidecars',
  'vendor',
  'scripts',
];

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopDaemonInDir(dir) {
  const pidPath = path.join(dir, '.daemon.pid');
  if (!fs.existsSync(pidPath)) return null;
  let stopped = null;
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    if (pid && isPidAlive(pid)) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
      stopped = pid;
    }
  } catch {}
  try { fs.unlinkSync(pidPath); } catch {}
  return stopped;
}

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dst, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function startDetachedDaemon(targetDir) {
  const script = path.join(targetDir, 'sidecars', 'daemon', 'main.mjs');
  if (process.platform === 'win32') {
    const nodeExe = process.execPath;
    const psCmd = `Start-Process -FilePath '${nodeExe.replace(/'/g, "''")}' -ArgumentList @('${script.replace(/'/g, "''")}','--root','${targetDir.replace(/'/g, "''")}') -WorkingDirectory '${path.dirname(script).replace(/'/g, "''")}' -WindowStyle Hidden`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { stdio: 'ignore' });
  } else {
    const child = spawn(process.execPath, [script, '--root', targetDir], {
      cwd: path.dirname(script),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }
}

async function waitForDaemonPid(targetDir, timeoutMs = 4000) {
  const pidPath = path.join(targetDir, '.daemon.pid');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
      if (pid && isPidAlive(pid)) return pid;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function printStatus() {
  const pidPath = path.join(TARGET_DIR, '.daemon.pid');
  let pid = null;
  try {
    const p = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    if (p && isPidAlive(p)) pid = p;
  } catch {}
  const port = cdp.readPort();
  const pages = port ? await cdp.listPages(port).catch(() => []) : [];
  console.log(JSON.stringify({
    ok: true,
    pluginDir: TARGET_DIR,
    installed: fs.existsSync(path.join(TARGET_DIR, 'plugin.json')),
    legacyPrismPresent: fs.existsSync(LEGACY_PRISM_DIR),
    daemonAlive: Boolean(pid),
    daemonPid: pid,
    cdpPort: port,
    eligiblePages: pages.map((p) => p.title),
  }, null, 2));
}

function stopNodeProcsMatching(pattern) {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${pattern.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out
      .split(/\r?\n/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function syncGeminiPluginRegistry() {
  const cfgPath = path.join(os.homedir(), '.gemini', 'config', 'config.json');
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!data.plugins || typeof data.plugins !== 'object') data.plugins = {};
    delete data.plugins['obsidian-prism'];
    data.plugins['antigravity-claude-desktop'] = { enabled: true };
    if (data.sidecars && typeof data.sidecars === 'object') {
      delete data.sidecars['obsidian-prism/daemon'];
    }
    fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function runInstall() {
  // 1. 更新宿主插件注册表，停用并移除旧版 obsidian-prism 插件与残留进程（防双插件冲突）
  const registrySynced = syncGeminiPluginRegistry();
  const stoppedLegacy = stopDaemonInDir(LEGACY_PRISM_DIR);
  const killedLegacyProcs = stopNodeProcsMatching('plugins\\obsidian-prism');
  let removedLegacy = false;
  if (fs.existsSync(LEGACY_PRISM_DIR)) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      fs.rmSync(LEGACY_PRISM_DIR, { recursive: true, force: true });
      removedLegacy = true;
    } catch {}
  }

  // 2. 停止本插件已有旧守护进程并干净同步文件
  const stoppedPrev = stopDaemonInDir(TARGET_DIR);
  stopNodeProcsMatching('plugins\\antigravity-claude-desktop');
  await new Promise((r) => setTimeout(r, 250));
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  const existingCfgPath = path.join(TARGET_DIR, 'config.json');
  const preservedConfig = fs.existsSync(existingCfgPath);

  for (const dirName of ['src', 'sidecars', 'vendor', 'scripts']) {
    const dstSub = path.join(TARGET_DIR, dirName);
    if (fs.existsSync(dstSub)) fs.rmSync(dstSub, { recursive: true, force: true });
  }
  for (const rel of SYNC_ENTRIES) {
    const src = path.join(ROOT_DIR, rel);
    if (!fs.existsSync(src)) continue;
    copyRecursive(src, path.join(TARGET_DIR, rel));
  }
  if (!preservedConfig) {
    const srcCfg = fs.existsSync(path.join(ROOT_DIR, 'config.json'))
      ? path.join(ROOT_DIR, 'config.json')
      : path.join(ROOT_DIR, 'config.example.json');
    fs.copyFileSync(srcCfg, existingCfgPath);
  }

  // 3. 拉起新守护进程并等待就绪
  startDetachedDaemon(TARGET_DIR);
  const pid = await waitForDaemonPid(TARGET_DIR, 4500);
  await new Promise((r) => setTimeout(r, 900));

  const port = cdp.readPort();
  const pages = port ? await cdp.listPages(port).catch(() => []) : [];
  console.log(JSON.stringify({
    ok: true,
    plugin: cdp.PLUGIN_ID,
    version: cdp.PLUGIN_VERSION,
    targetDir: TARGET_DIR,
    registrySynced,
    preservedConfig,
    stoppedLegacyPrismPid: stoppedLegacy,
    killedLegacyProcs,
    removedLegacyPrismDir: removedLegacy,
    stoppedPrevPid: stoppedPrev,
    daemonPid: pid,
    cdpPort: port,
    attachedPages: pages.length,
  }, null, 2));
}

const arg = process.argv[2] || '--install';
(arg === '--status' ? printStatus() : runInstall()).catch((err) => {
  console.error(err);
  process.exit(1);
});
