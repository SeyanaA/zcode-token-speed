---
description: 查看本地模型的平均 Token 输出速度（tokens/秒），可按时间范围和模型筛选
argument-hint: "[today|7d|30d|all] [模型名关键词]"
---
请调用 `token-speed` MCP 工具中的 `get_token_speed` 查询本地用量数据库，然后：

1. 用中文给出综合平均 Token 速度（tokens/秒）、平均首 token 延迟和样本量。
2. 原样保留按模型拆分的表格。
3. 最后用一句话说明统计口径（解码时长 = duration_ms − time_to_first_token_ms）。

如果用户传入了参数，按以下规则映射到工具入参：
- 第一个参数是 `today`、`7d`、`30d` 或 `all` 时，作为 `range`。
- 其余参数作为 `model` 关键词过滤。
- 没有参数时使用 `range: "7d"`。

如果工具调用失败，原样报告错误信息，并提示可以用 `dbPath` 指定其它 agent 数据库路径。$ARGUMENTS
