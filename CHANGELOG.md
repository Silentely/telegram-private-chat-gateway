# Changelog

本文件记录 Telegram Private Chat Gateway 的正式版本变化。

## [Unreleased]

### 管理体验

- 新增 `/panel` 用户快捷按钮面板；`/info` 附带操作按钮与备注/静音/最近消息。
- `/sysinfo` 分页：概览 / 存储 / 错误 / 今日统计，带刷新按钮。
- 新增 `/stats` `/whoami` `/find` `/note` `/mute` `/unmute`；Owner 可用 `/synccommands` 同步 Bot 菜单。
- 非管理员误发指令有提示；私聊 `/help` 对普通用户可见。
- 封禁/静音会通知用户；话题标题缺资料时自动补全与修复。

### 文档与发布

- 部署文档仅保留 **dist 单文件手动粘贴到 Cloudflare Worker** 路径，移除 Wrangler/Git 自动部署作为推荐方式。
- 配置、运维、安全、开发文档统一为 Dashboard 配置 Bindings 与 Variables。
- 新增提交钩子：变更源码时 pre-commit 自动 `npm run build:single` 并 stage `dist/worker.single.js`。
- `/listwords` 增加展示环境变量 `SPAM_KEYWORDS` 一节，避免与动态屏蔽词混淆。

## [1.0.0] - 2026-07-11

### 核心能力

- 将 Telegram Bot 私聊接入独立 Forum Topic，并支持管理员双向回复。
- 提供 Turnstile 和本地题库人机验证流程。
- 提供关键词、链接、重复消息和 D1 动态规则内容策略。
- 提供 Owner、Operator 和 Rules Manager 角色权限。
- 提供用户资料卡以及信任、封禁、关闭和静音操作。

### 安全

- 使用至少 32 字节的 Telegram Webhook Secret Token 验证请求。
- 限制公开 POST 请求体为 1 MiB，并校验 JSON Content-Type。
- 对 Telegram API Base URL、Callback 数据、规则类型和动作使用白名单。
- 对验证页面参数执行 HTML 转义，并配置 CSP 和脚本 nonce。
- 对日志中的凭据、消息正文、caption 和验证挑战标识进行递归脱敏。

### 数据与可靠性

- 使用 Cloudflare D1 保存用户、Topic、消息映射、规则、管理员和审计等长期状态。
- 使用 Cloudflare KV 保存验证、速率限制、管理员缓存和 Topic 健康等短期状态。
- 使用 D1 Update 声明实现 Telegram Update 幂等处理。
- 使用实例内合并与 D1 Topic Lock 防止并发重复创建 Topic。
- 使用原子部分更新避免并发资料同步覆盖用户状态。
- 使用 Cron 按 7、30、90 天保留期清理幂等记录、消息映射和管理员审计。

### 开发与运维

- 提供单元测试、集成测试、覆盖率检查和 Mock KV/D1/Telegram 环境。
- 提供结构化日志、Cloudflare Observability 示例和发布检查清单。
- 提供从零部署、配置、架构、安全、运维和开发文档。
- 提供 `npm run sync-docs` 自动生成函数、CONFIG 和 KV 键名索引。
- 提供 `npm run build:single` 生成可粘贴的 `dist/worker.single.js`。
