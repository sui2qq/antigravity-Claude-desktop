<#
.SYNOPSIS
    一键套用 Claude 极简风自定义样式与配置到 Obsidian Prism 插件。
.DESCRIPTION
    将本仓库中的 claude-custom.patch 应用到上游 RMvdesi/obsidian-prism 源码，
    同步 config.json 并执行 npm run install:plugin 完成热部署。
#>
param(
    [string]$PrismRepo = "$env:USERPROFILE\obsidian-prism",
    [string]$PluginDir = "$env:USERPROFILE\.gemini\config\plugins\obsidian-prism"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PatchFile = Join-Path $ScriptDir 'claude-custom.patch'
$ConfigFile = Join-Path $ScriptDir 'config.json'

if (-not (Test-Path "$PrismRepo\.git")) {
    Write-Host "未找到 $PrismRepo，正在克隆上游仓库 RMvdesi/obsidian-prism..."
    git clone https://github.com/RMvdesi/obsidian-prism.git $PrismRepo
}

Write-Host "1. 重置上游源码并应用 Claude 定制补丁..."
git -C $PrismRepo checkout -- .
git -C $PrismRepo apply --whitespace=nowarn $PatchFile

Write-Host "2. 同步定制 config.json..."
New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
Copy-Item -Path $ConfigFile -Destination (Join-Path $PluginDir 'config.json') -Force

Write-Host "3. 部署并热注入到当前 Antigravity 窗口..."
Push-Location $PrismRepo
try {
    npm run install:plugin
} finally {
    Pop-Location
}
if (Test-Path (Join-Path $PluginDir 'inject.js')) {
    Push-Location $PluginDir
    try {
        node inject.js
    } finally {
        Pop-Location
    }
}

Write-Host "`n完成！如当前 Antigravity 未带调试端口启动，请关闭并通过桌面快捷方式重开一次。"
