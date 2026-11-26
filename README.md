# Antigravity Claude Minimalist Theme Backup

基于开源插件 [RMvdesi/obsidian-prism](https://github.com/RMvdesi/obsidian-prism)（`v1.0.8-beta.2` / `2e27680`，GPL-3.0）的 **Claude 极简暖纸/暖炭风** 自定义样式补丁与配置备份。

## 核心特点

- **配色（浅色 / 深色双适配）**
  - 浅色模式：暖米白主画布 `#FAF9F5`、侧栏 `#F0EEE6`、正文 `#1F1E1D`、次级文字 `#73726C`
  - 深色模式：暖深灰主画布 `#262624`、侧栏 `#1F1E1D`、暖白正文 `#ECEAE3`
  - 唯一强调色：赤陶橙 `#C96442`（发送按钮、光标、选区与链接）
- **字体与版心**
  - UI 与正文统一温润无衬线（`Google Sans Text` + `Segoe UI Variable Text` + 可变字重 `Noto Sans SC`），等高数字 `lining-nums`，行高 `1.66`
  - 代码区使用 `Cascadia Code`（`13.5px` / 行高 `1.6`）
  - 对话区居中限制最大宽度 `720px`，留足呼吸留白
- **极简与流畅度优化**
  - 去除棱镜流光、环境光效、波纹、渐变、厚阴影、推理滑块与像素伙伴装饰
  - 输入框 `18px` 大圆角纯净卡片，聚焦仅边框微深不发光；左下角 `+` 与模型选择按钮透明无框
  - 关闭重复内置汉化（`hostLocalization: "off"`）、3D 机械键盘模型选择器（`periodicModelPicker: "off"`）与自动更新（`autoUpdate: "off"`）
  - 修复 `subtle` 动效模式下「回到底部」悬浮箭头悬停向右偏移的样式问题

## 包含文件

- `claude-custom.patch`：针对上游 `obsidian-prism`（基线提交 `2e2768025a54c534d5337791ebd0667ab5a6e192`）的 `style.css` 补丁
- `config.json`：插件调优配置文件（已关闭 `autoUpdate` 防止覆盖）
- `apply.ps1`：Windows 一键重新应用与热部署脚本

## 一键恢复 / 重新应用

```powershell
powershell -ExecutionPolicy Bypass -File .\apply.ps1
```

## 还原为上游原版样式

```powershell
cd $env:USERPROFILE\obsidian-prism
git checkout -- style.css
npm run install:plugin
```

## 致谢与许可

本备份中的样式补丁衍生自开源项目 [RMvdesi/obsidian-prism](https://github.com/RMvdesi/obsidian-prism)，沿用 **GPL-3.0-only** 许可证。
