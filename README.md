# ZCode Token Speed

给 ZCode 的「使用统计」补上 **平均 Token 速度** 和 **每日速度曲线**，并提供两种形态：

- **原生 UI 补丁**：在 设置 → 使用统计 里直接出现第 6 项和每日曲线。通过外部启动器 + 后台 watcher，在 ZCode 版本更新后自动重新注入。
- **ZCode 插件**：`/token-speed` 命令 + `get_token_speed` MCP 工具，在对话里查看综合速度、TTFT、中位速度和按模型拆分。

> 非官方项目，与 Z.ai / ZCode 官方无隶属关系。原生 UI 补丁会修改本地 ZCode 安装文件，请阅读「还原」并自行承担风险。

## 为什么做这个

ZCode 自带的使用统计有累计 Token、峰值、连续天数、活跃度等，但缺少一个判断模型快慢的指标：**模型每秒能输出多少 Token**。

没有这个数字时，只能靠体感判断“这个模型是不是变慢了”“哪家供应商更快”。这个项目把本地 agent 数据库里的 `model_usage` 时长和输出 Token 聚合起来，给出：

- 综合平均速度（按输出 Token ÷ 解码时长加权）
- 单请求平均 / 中位速度
- 平均首 Token 延迟（TTFT）
- 按模型拆分
- 每日速度变化曲线

## 改版历程：为什么是现在这个形态

1. **直接改源码**
   本地源码版本可能落后于安装版；当前安装版是打包后的 `app.asar`，从旧源码重新构建会回退功能，不适合作为日常使用方案。

2. **先做成插件**
   ZCode 插件系统支持 skill / command / hook / MCP，但插件 UI 的 `ui.surfaces` 目前只接受 `availability: "session"`，无法往「设置 → 使用统计」页面注入一栏。插件只能在对话里提供 `/token-speed`。

3. **直接补 `app.asar`**
   能实现原生 UI，但 ZCode 每次更新都会替换 `app.asar` 和 `zcode.cjs`，补丁会消失。

4. **外部启动器 + 后台 watcher（当前方案）**
   补丁代码完全放在 `~/.zcode/token-speed-live`，不进入仓库、不进入安装包：
   - 启动器在 ZCode 启动前检测版本并重打补丁；
   - 登录后的 watcher 每 5 分钟检查一次，更新后自动重打；
   - 补丁器带备份、状态哈希、版本一致性检查，失败时安全退出并记录 `patch.log`。

5. **修复 3.18.2 的整页 ZodError**
   早期补丁只把 `avgOutputTokensPerSecond` 加进了校验 schema，却忘了让 CLI 的 snapshot builder 真正输出它。Local Host 校验时字段缺失，直接抛 `ZodError`，导致「使用统计」所有数据都变成 `--`。
   修复方式是双保险：
   - builder 补上真实字段；
   - 所有新增字段改为 **optional**，即使某个进程版本不齐、字段暂时缺失，也只显示 `--`，不会再拖垮整页。

6. **提升图表可读性**
   - 最初缺失日期会断线、留下孤立点；现在改为**连续折线**，跨过无数据日期；
   - 鼠标移到任意日期列，显示 `MM-DD · xx.x tokens/秒`，同时出现虚线定位；
   - 无数据日期显示 `MM-DD · 无数据`；
   - 右侧最后一个日期标签不再被裁切。

## 功能

### 原生 UI

- 使用统计汇总条第 6 项：**平均 Token 速度**
- App Usage 下方：**每日 Token 速度** 连续折线
- 悬停提示：日期 + 速度；无数据日期有明确提示
- 7 天 / 30 天范围切换同步刷新

### 插件

- `/token-speed [today|7d|30d|all] [模型关键词]`
- `get_token_speed` MCP 工具
- 输出综合速度、单请求平均/中位速度、平均 TTFT、样本量、按模型拆分

## 数据口径

数据源：本地 agent SQLite 数据库，默认 `~/.zcode/cli/db/db.sqlite`。

- 只统计 `model_usage` 中 `status = 'completed'`、且 `duration_ms` 与 `time_to_first_token_ms` 都齐全的请求；
- 解码时长 = `duration_ms - time_to_first_token_ms`；
- 速度 = 输出 tokens ÷ 解码秒数；
- 综合速度按总量加权；
- 数据库默认只保留最近 30 天；
- 部分供应商会把 reasoning tokens 计入输出 tokens，速度会偏高。

## 安装

### A. ZCode 插件（不动 ZCode 文件）

1. 准备一个本地插件市场目录，例如 `plugins/marketplace.json`：

   ```json
   {
     "name": "dev-token-speed",
     "plugins": [
       {
         "name": "token-speed",
         "source": "./token-speed",
         "version": "0.1.0",
         "description": "查询本地模型的平均 Token 输出速度",
         "displayName": "Token Speed",
         "displayName_i18n": { "zh-CN": "Token 速度统计" },
         "description_i18n": { "zh-CN": "查询本地模型的平均 Token 输出速度（tokens/秒）" }
       }
     ]
   }
   ```

   把本仓库的 `plugin/` 目录复制为该市场下的 `token-speed/`。

2. ZCode → **插件市场 → 添加 → 添加插件市场**，粘贴市场目录。
3. 安装 **Token 速度统计**，在 设置 → 插件 确认启用。
4. 新任务里输入 `/token-speed 7d`，或直接问「我最近模型的吐字速度怎么样」。

要求：系统 `node` 在 PATH 中（Node 22+，用于 `node:sqlite`）。

### B. 原生 UI 补丁（Windows）

前置条件：

- Windows
- Node.js 22+ 在 PATH 中
- 当前验证版本：ZCode 3.18.2（其他版本会尝试按语义锚点打补丁，失败会安全退出）
- 建议先完全退出 ZCode

在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\patcher\install.ps1 -AppRoot "D:\Zcode Re"
```

脚本会：

1. 把补丁器复制到 `%USERPROFILE%\.zcode\token-speed-live`；
2. 写入 `config.json`（`appRoot`）；
3. 立即打一次补丁；
4. 创建桌面快捷方式 **ZCode (Token Speed)**；
5. 注册登录 watcher（`HKCU\...\Run\ZCodeTokenSpeedWatch`）并启动。

完成后：

1. **完全退出 ZCode**（包括托盘图标）；
2. 从 **ZCode (Token Speed)** 快捷方式启动；
3. 打开 使用统计，查看第 6 项和每日曲线。

手动安装（不使用 install.ps1）：

1. 把 `patcher/` 复制到 `%USERPROFILE%\.zcode\token-speed-live`；
2. 复制 `config.example.json` 为 `config.json`，把 `appRoot` 改为 ZCode 安装目录；
3. `node patch.mjs`；
4. 为 `launch.vbs` 建快捷方式（目标：`wscript.exe`）；
5. 可选：把 `wscript.exe "...\watch.vbs"` 加入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。

## 更新后为什么还能用

ZCode 自动更新会替换 `app.asar` 和 `zcode.cjs`。本项目有两层保障：

1. **启动前**：从 **ZCode (Token Speed)** 快捷方式启动时，`launch.vbs` → `patch.mjs` 检测版本并重新注入，然后启动 ZCode。
2. **后台**：登录后 `watch.vbs` 每 5 分钟检查一次；发现文件变化且已稳定，就自动重打。若更新器自己重启了 ZCode，当前会话可能还没加载补丁，再启动一次即可。

如果 ZCode 版本变化导致锚点不匹配，补丁器会**不写入任何文件**并记录 `patch.log`，启动器仍会正常启动 ZCode；更新补丁规则即可支持新版本。

## 还原 / 卸载

完全退出 ZCode 后运行：

```text
%USERPROFILE%\.zcode\token-speed-live\restore.cmd
```

它会：

- 写入 `disabled` 标记，停用后台 watcher；
- 删除 `HKCU\...\Run\ZCodeTokenSpeedWatch`；
- 用备份恢复 `app.asar` header 与 `zcode.cjs`；
- 删除 unpacked 覆盖文件；
- 校验当前 `app.asar` 大小与备份版本一致，不一致时中止，避免把旧 header 写到新版本。

桌面快捷方式需要手动删除。插件可在 设置 → 插件 中卸载，互不影响。

## 目录结构

```text
patcher/
  patch.mjs            外部补丁器（自带 asar header 读写，无第三方依赖）
  launch.vbs           启动器：检查 ZCode 未运行 → 打补丁 → 启动
  watch.vbs            登录后台 watcher，每 5 分钟检查更新
  restore.mjs          还原脚本（带版本一致性检查）
  restore.cmd          还原入口
  install.ps1          一键安装（复制文件、写配置、快捷方式、Run 项）
  config.example.json  appRoot 示例
plugin/
  .zcode-plugin/plugin.json
  commands/token-speed.md
  mcp/token-speed-server.mjs
  README.md
```

## 已知限制

- 原生 UI 补丁目前只支持 Windows，且依赖 ZCode 打包 bundle 的内部结构；ZCode 大版本更新后可能需要更新锚点。
- UI 文案目前为中文硬编码（「平均 Token 速度」「每日 Token 速度」）。
- 数据库默认只保留 30 天；更早的日期无法统计。
- 插件与补丁器都只读取本地 SQLite，不发送网络请求；补丁器会修改本地 ZCode 文件。
- 非官方项目，无官方支持；请保留备份并先用 `restore.cmd` 验证回退路径。

## License

MIT，见 [LICENSE](LICENSE)。
