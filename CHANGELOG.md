# Changelog

## 0.2.0

- 原生 UI 补丁改为**外部启动器 + watcher**：ZCode 更新后自动重新注入，不再需要手动重打。
- 修复 3.18.2 的整页 `ZodError`：
  - CLI snapshot builder 真正输出 `avgOutputTokensPerSecond`；
  - `avgOutputTokensPerSecond` / `dailySpeed` 改为 optional，字段缺失时只显示 `--`，不再拖垮整页。
- 每日速度图改为连续折线（跨过无数据日期）。
- 增加 hover 数值提示、虚线日期定位；无数据日期显示「无数据」。
- 修复最右侧日期标签被裁切。
- 补丁器增加备份、状态哈希、版本一致性检查和失败回滚。

## 0.1.0

- 首个版本：在「使用统计」汇总条增加平均 Token 速度，增加每日速度图。
- 提供 `token-speed` 插件：`/token-speed` 命令 + `get_token_speed` MCP 工具。
