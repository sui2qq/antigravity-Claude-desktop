# Antigravity Claude Desktop

为 **Google Antigravity** 桌面端打造的独立轻量级 **Claude Desktop 暖羊皮纸风格** UI 插件。
彻底剔除玻璃拟态、霓虹流光、像素小精灵、3D 键盘与底部彩色遥测条等视觉噪音，仅保留极致纯净的 Claude 桌面端排版体验与实用工具。

## 核心特性

- **暖羊皮纸视觉系统**（零玻璃拟态 / 零高光白线 / 零蓝光阴影）：
  - 浅色：主画布 `#FAF9F5` · 侧边栏 `#F0EEE6` · 卡片/输入框 `#FFFFFF` · 正文 `#1F1E1D` · 次级 `#73726C`
  - 深色：主画布 `#262624` · 侧边栏 `#1F1E1D` · 卡片 `#2F2E2B` · 正文 `#ECEAE3`
  - 唯一强调色：赤陶橙 `#C96442`
- **Claude Desktop 排版复刻**：
  - 侧边栏：37px 舒展顶部操作栏（17px 线性图标 + 14.5px 字号）、12px 克制暖灰分组标签、32px 项目行、33px 清晰会话行与饱满选中胶囊；
  - 对话流：720px 居中阅读栏、15px / 1.66 无衬线正文（`lining-nums`）、`Cascadia Code` 代码块、纯平无框用户消息气泡；
  - 输入框：18px 大圆角纯净白卡，移除底部冗余遥测条，仅保留轻量原生控件；
  - 经典极简首页：温润衬线问候语 + 居中卡片输入框。
- **实用功能精留**：
  - 对话区左缘圆点导航 + 可搜索跳转的提问大纲目录；
  - 设置弹窗左侧「浏览器」下方独立「**用量统计**」栏（活动热力图 / 模型 Token 分布 / 实时配额池）；
  - 设置「外观」页极简 3 开关设置卡片；
  - 宿主界面简体中文汉化（可随时在设置中一键开关）。

## 安装与使用

> 前置要求：Node.js `>= 22`，且 Antigravity 启动快捷方式带有 `--remote-debugging-port=0` 参数。

```powershell
# 一键部署并启动后台守护进程（会自动清理旧版 obsidian-prism 防冲突）
npm run install:plugin

# 查看当前插件与守护进程状态
npm run status

# 本地修改样式后手动立即热注入当前窗口
npm run inject

# 一键干净卸载并还原页面
npm run remove

# 运行自动化测试
npm test
```

## 开源致谢

- 底层本地轨迹统计、配额采集器与 CDP 注入思路衍生自 [RMvdesi/obsidian-prism](https://github.com/RMvdesi/obsidian-prism)（GPL-3.0-only）。
- 宿主简体中文汉化词库与引擎衍生自 [yiheng8023/antigravity-chinese](https://github.com/yiheng8023/antigravity-chinese)（MIT）。
- 详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
