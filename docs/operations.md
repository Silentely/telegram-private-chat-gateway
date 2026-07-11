# 运维指南

本文面向 Telegram Private Chat Gateway 的部署维护者，覆盖健康检查、日志、数据保留、备份、故障排查和当前项目版本回退。

## 健康检查

Worker 提供：

```text
GET /
GET /health
```

正常响应：

```text
HTTP 200
OK
```

健康检查不访问 Telegram、KV 或 D1，只表示 Worker 脚本可以响应请求。完整可用性仍需验证 Bindings、Secrets、Telegram Bot 权限和消息流。

## 结构化日志

项目输出 JSON 日志，常见字段包括：

- `timestamp`
- `level`
- `action`
- `userId`
- `threadId`
- `method`
- `category`
- `attempts`

日志会递归脱敏已知凭据、正文、caption 和验证挑战标识。生产排障时优先使用 `action`、ID、错误类别和计数，不要临时加入完整 Telegram Update 或消息正文。

### Cloudflare 实时日志

```bash
npx wrangler tail
```

可以按 Worker 环境、状态和采样配置进一步过滤。高流量环境应评估 `head_sampling_rate` 对可观测性和费用的影响。

## D1 保留期清理

Scheduled 任务执行以下保留策略：

| 数据 | 保留期 |
|------|--------|
| Telegram Update 幂等记录 | 7 天 |
| 双向消息映射 | 30 天 |
| 管理员审计记录 | 90 天 |

建议每天执行：

```toml
[triggers]
crons = ["0 3 * * *"]
```

清理任务不删除用户、Topic、规则和管理员主记录。

如果 Scheduled 任务失败，检查：

- `TG_BOT_DB` 是否绑定
- Worker 是否拥有 D1 访问权限
- D1 migrations 是否成功
- Cloudflare Cron Trigger 是否启用
- 日志中是否存在 `D1 'TG_BOT_DB' not bound` 或 SQL 错误

## 数据备份

### D1

发布重要版本、批量修改规则或管理员前，使用 Cloudflare D1 提供的导出、备份或 Time Travel 能力。具体命令和可用窗口取决于当前 Wrangler 与 Cloudflare 套餐，应以 Cloudflare 官方文档为准。

至少备份：

- users
- rules
- admin_users
- settings

消息映射、幂等记录和审计具有保留期，但在调查事故前也可以临时保留快照。

### KV

KV 保存短期状态和动态屏蔽词。重要部署前记录：

- KV Namespace ID
- `blocked_words_kv`
- 当前 Worker Binding 配置

验证挑战、速率限制和缓存记录通常不需要长期备份。

## 常见故障

### Webhook 返回 401

- 检查 Telegram `secret_token` 与 Cloudflare `WEBHOOK_SECRET` 是否完全一致。
- 确认 Secret 至少 32 字节。
- 重新执行 `setWebhook`，然后查看 `getWebhookInfo`。

### Webhook 返回 400 或 415

- 400：请求体不是合法 JSON。
- 415：Content-Type 不是 `application/json`。
- 不要使用浏览器地址栏直接模拟 Telegram POST 请求。

### Webhook 返回 500

检查：

- `TOPIC_MAP`
- `TG_BOT_DB`
- `BOT_TOKEN`
- `SUPERGROUP_ID`
- `WEBHOOK_SECRET`

`SUPERGROUP_ID` 必须以 `-100` 开头。

### 无法创建 Topic

- 群组必须是启用 Topics 的超级群组。
- 机器人必须是管理员并拥有管理 Topics 权限。
- 检查 D1 用户记录中的 Topic Lock 是否因异常请求暂时占用。
- 检查 Telegram API 错误类别是否为 `topic_missing`、`forbidden` 或 `invalid_request`。

### 管理员回复没有发送给用户

- 检查发送者是否通过 `OWNER_IDS`、`ADMIN_IDS` 或 Telegram 群组管理员检查（`OWNER_IDS` 视为管理权限）。
- 确认消息位于用户专属 Topic。
- 检查 KV 中 `thread:<topicId>` 映射和 D1 用户 Topic ID。
- 检查用户是否封禁 Bot 或 Telegram API 返回 403。

### 管理命令速查（群内）

| 场景 | 命令 / 入口 |
|------|-------------|
| 按钮首页 | `/menu` |
| 系统分页 | `/sysinfo`（概览/存储/错误/今日/活跃） |
| 今日与对比 | `/stats`（**CST 日切**、较昨日、近 7 日 sparkline、热力） |
| 活跃排行 | `/rank`（CST 日切 + 热力 + Top 用户，可点进面板） |
| 查找 | `/find 词` · `/notes 关键词` |
| 用户操作 | 话题内 `/panel` `/info` `/note` `/ban`(确认) `/mute` 等 |
| 同步斜杠菜单 | Owner `/synccommands` |

部署新版本后请粘贴最新 `dist/worker.single.js`；命令列表变更后由 Owner 再跑一次 `/synccommands`。

### Turnstile 页面不可用

- 确认 Site Key、Secret Key 和 `VERIFICATION_PAGE_URL` 三项同时存在。
- `VERIFICATION_PAGE_URL` 必须是 Worker Origin，不包含 `/verify`。
- 检查 CSP 是否允许 Cloudflare Turnstile 官方域名。
- 检查 `/verify-callback` 日志中的 token 验证错误码。

### 管理员资料卡操作被拒绝

- 检查 `OWNER_IDS` 或 D1 `admin_users` 记录。
- 确认管理员记录 enabled。
- 确认角色拥有对应动作权限。
- Callback 会在点击时重新检查权限，旧按钮不会绕过权限变更。

## 当前版本回退

项目版本回退只针对 Telegram Private Chat Gateway 自身的部署版本。

推荐方式：

1. 在 Cloudflare Dashboard 的 Deployments 中选择已验证的部署版本并执行回退；或
2. 在 Git 中检出已验证提交，使用该版本的 `dist/worker.single.js` 重新粘贴到 Worker 并 Deploy。

回退前确认：

- 目标版本所需的 KV 和 D1 Bindings 仍然存在。
- Secrets 和普通变量与目标版本兼容。
- D1 Schema migrations 是向前幂等创建；代码不会自动执行逆向 migrations。
- 如果回退版本不认识新字段，应先在预发布环境验证，不要直接修改生产 D1 Schema。
- 回退后重新检查 Webhook、Topic 创建、管理员回复和 Scheduled 任务。

## 发布检查清单

### 代码与构建

- [ ] `npm run test:unit` 通过
- [ ] `npm run test:integration` 通过
- [ ] `npm test` 通过
- [ ] `npm run test:coverage` 达到项目基线
- [ ] `npm run build:single` 成功，`node --check dist/worker.single.js` 通过
- [ ] `dist/worker.single.js` 已粘贴到 Worker 并 Deploy
- [ ] `git diff --check` 无错误

### Cloudflare

- [ ] Binding `TOPIC_MAP` 为 KV Namespace
- [ ] Binding `TG_BOT_DB` 为 D1 Database（非 Text 变量）
- [ ] Secrets 已配置且没有写入仓库
- [ ] `SUPERGROUP_ID` 和 `OWNER_IDS` 已核对（变量名无前导空格）
- [ ] Cron Trigger 已启用
- [ ] `GET /health`、`/health/env`、`/health/d1` 正常
- [ ] Observability 采样率符合流量和费用要求

### Telegram

- [ ] Bot Token 属于目标 Bot
- [ ] Bot 在目标超级群组中拥有必需权限
- [ ] Webhook URL、Secret Token 和 allowed updates 正确
- [ ] 新用户验证和 Topic 创建通过
- [ ] 管理员回复和资料卡操作通过

### 数据与安全

- [ ] D1 关键表已有备份或恢复点
- [ ] Webhook 401、请求体 413 和非法 JSON 400 已验证
- [ ] 日志中没有消息正文或 Secret
- [ ] 未暴露本地开发服务或 Vitest UI
