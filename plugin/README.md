# token-speed

在 ZCode 里查询本地模型的平均 Token 输出速度（tokens/秒）。

插件本身不渲染设置页 UI；它提供：

- `/token-speed [today|7d|30d|all] [模型关键词]` 命令
- `get_token_speed` MCP 工具（也可直接用自然语言提问，例如“我的模型吐字速度怎么样”）

## 数据口径

- 数据源：本地 agent SQLite 数据库（默认 `~/.zcode/cli/db/db.sqlite`）。
- 只统计 `model_usage` 中状态为 `completed`、且 `duration_ms` 与 `time_to_first_token_ms` 都齐全的请求。
- 解码时长 = `duration_ms - time_to_first_token_ms`。
- 综合速度 = 输出 tokens 总量 ÷ 解码时长总量（吞吐加权）；同时给出单请求平均速度与中位速度。
- 数据库默认只保留最近 30 天数据。

## 配置

默认数据库路径可通过以下方式覆盖：

1. 工具参数 `dbPath`；
2. 环境变量 `ZCODE_USAGE_DB`。

## 运行要求

- 系统 `node` 在 PATH 中（需要 Node 22+，用于内置 `node:sqlite`）。
- 安装插件后在 **设置 → 插件** 中确认已启用；MCP 工具名形如
  `mcp__plugin_token-speed_token-speed__get_token_speed`。
