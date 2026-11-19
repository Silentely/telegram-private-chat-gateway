# 部署指南

**官方推荐且文档唯一支持的发布方式：** 本地打包生成 `dist/worker.single.js`，在 Cloudflare Dashboard **手动粘贴** 到 Worker 并 Deploy；Bindings、变量、Cron 全部在 Dashboard 配置。

不依赖 `wrangler deploy`、不依赖 Git 连接 Cloudflare 自动部署，避免空 `wrangler.toml` 覆盖线上绑定与变量。

---

## 前置条件

- Cloudflare 账号
- Node.js 20 或更高版本（`^20` / `^22` / `>=24`，用于 `pnpm install`、测试与打包）
- npm
- Telegram Bot Token
- 已开启 Topics 的 Telegram 超级群组
- 机器人在超级群组中具有发送消息、管理 Topics 和删除消息所需权限

---

## 1. 获取项目

```bash
git clone https://github.com/Silentely/telegram-private-chat-gateway.git
cd telegram-private-chat-gateway
pnpm install
```

`pnpm install` 会安装依赖，并通过 `prepare` 将 Git hooks 指向 `.githooks`（提交时自动重建 `dist/`）。

仓库已包含可部署产物：

```text
dist/worker.single.js
```

源码是模块化的（`worker.js` + `src/`），**不能**只复制源码里的 `worker.js`。控制台部署时务必使用 **`dist/worker.single.js`**。

---

## 2. 在 Cloudflare 创建资源

全部在 [Cloudflare Dashboard](https://dash.cloudflare.com) 操作，无需把资源 ID 写进公开仓库。

### 2.1 创建 Worker

1. **Workers & Pages** → **Create** → **Create Worker**
2. 名称可设为 `telegram-private-chat-gateway`
3. 先用占位代码创建即可，下一步会粘贴正式脚本

### 2.2 创建 KV Namespace

1. **Workers & Pages** → **KV** → **Create a namespace**
2. 名称随意，例如 `telegram-topic-map`
3. 稍后绑定变量名必须为 **`TOPIC_MAP`**

用途：验证状态、速率限制、待处理消息、管理员缓存、Topic 健康缓存、媒体组、动态屏蔽词等。

### 2.3 创建 D1 Database

1. **Workers & Pages** → **D1** → **Create database**
2. 名称建议：`telegram-private-chat-gateway`
3. 稍后绑定变量名必须为 **`TG_BOT_DB`**

用途：用户与 Topic、信任/封禁、消息映射、规则、角色、审计、Update 幂等、Topic 创建锁等。  
表结构在**首次业务请求**或 **Cron** 时自动创建，一般无需手写 SQL。

---

## 3. 打包（可选：提交时会自动构建）

手动打包：

```bash
pnpm run build:single
```

生成或更新：

```text
dist/worker.single.js
```

提交相关源码时，`.githooks/pre-commit` 会自动执行 `pnpm run build:single` 并将 `dist/worker.single.js` 加入暂存区，保证仓库中的 dist 与源码一致。

---

## 4. 将 dist 粘贴到 Worker

1. 打开目标 Worker → **Edit code**
2. 删除编辑器中的全部内容
3. 粘贴 **`dist/worker.single.js` 全文**
4. 点击 **Deploy**
5. 记录 Worker URL，例如：

```text
https://telegram-private-chat-gateway.<YOUR_SUBDOMAIN>.workers.dev
```

之后每次更新业务代码：本地 `pnpm run build:single`（或 git commit 自动构建）→ 再粘贴 dist → Deploy。  
**Bindings / Variables / Cron 一般会保留，无需每次重填。**

---

## 5. 配置 Bindings（必做一次）

Worker → **Settings** → **Bindings** → **Add**

| Variable name | 类型 | 说明 |
|---------------|------|------|
| `TOPIC_MAP` | **KV Namespace** | 选中步骤 2.2 创建的 KV |
| `TG_BOT_DB` | **D1 Database** | 选中步骤 2.3 创建的 D1 |

注意：

- 名称必须**完全一致**（区分大小写，无前导空格）
- **`TG_BOT_DB` 必须是 D1 Binding**，不要做成 Text/Secret 变量（Webhook 路径会返回 `D1 'TG_BOT_DB' is a string variable, not a D1 Database binding`；Cron 路径可能显示原始 `db.prepare is not a function`）
- **`TOPIC_MAP` 必须是 KV Binding**，不要做成普通变量

保存后按提示 **Deploy**（如有）。

---

## 6. 配置 Variables and Secrets（必做一次）

Worker → **Settings** → **Variables and Secrets**

变量名不要有前导/尾随空格（错误示例：` SUPERGROUP_ID`）。

### 6.1 必需 Secret

| 名称 | 类型 | 说明 |
|------|------|------|
| `BOT_TOKEN` | Secret | BotFather 提供的 Token |
| `WEBHOOK_SECRET` | Secret | 至少 **32 字节** 高熵随机串；须与 setWebhook 的 `secret_token` 完全一致 |

生成示例：

```bash
openssl rand -hex 32
```

### 6.2 必需 / 强烈建议 Text

| 名称 | 必需 | 示例 | 说明 |
|------|------|------|------|
| `SUPERGROUP_ID` | 是 | `-1001234567890` | 必须以 `-100` 开头 |
| `OWNER_IDS` | 强烈建议 | `123456789` | 恢复 Owner，多个用逗号分隔 |

### 6.3 可选

| 名称 | 类型 | 说明 |
|------|------|------|
| `ADMIN_IDS` | Text | 群命令权限快速白名单 |
| `SPAM_KEYWORDS` | Text | 垃圾关键词，逗号/分号/换行分隔（与 `/addword` 屏蔽词是两套机制） |
| `API_BASE` | Text | 仅允许 `https://api.telegram.org` 或 `https://api.telegram.dev` |
| `TURNSTILE_SITE_KEY` | Text | Turnstile 站点 Key |
| `TURNSTILE_SECRET_KEY` | Secret | Turnstile 密钥 |
| `VERIFICATION_PAGE_URL` | Text | Worker 根 URL，如 `https://xxx.workers.dev`（**不要**带 `/verify`） |

Turnstile：上述三项**同时存在**时启用；缺任一则使用本地题库。

完整说明见 [配置参考](configuration.md)。

---

## 7. 配置 Cron（强烈建议）

Worker → **Settings** → **Triggers** → **Cron Triggers** → Add：

```text
0 3 * * *
```

每天 UTC 03:00 清理过期幂等记录、消息映射和管理员审计。  
不删除用户、规则、管理员或 Topic 主记录。

---

## 8. 设置 Telegram Webhook

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<WEBHOOK_SECRET>&allowed_updates=%5B%22message%22,%22edited_message%22,%22callback_query%22%5D
```

替换：

- `<BOT_TOKEN>`：Bot Token  
- `<WORKER_URL>`：完整 HTTPS Worker URL  
- `<WEBHOOK_SECRET>`：与 Dashboard 中 Secret **完全相同**

检查：

```text
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

期望：`url` 正确；`pending_update_count` 在处理完后趋于 0。  
`last_error_message` 可能残留历史错误；以新请求是否 200 与 `pending_update_count` 为准。

---

## 9. 发布前检查（本地）

```bash
pnpm test
pnpm run build:single
node --check dist/worker.single.js
```

可选：

```bash
pnpm run test:coverage
```

---

## 10. 发布后验证

1. `GET /health` 返回 `OK`  
2. `GET /health/env` 中关键项 `presence` 为 `true`，且 `keys` 无前导空格键名  
3. `GET /health/d1` 返回 `"ok": true` 与 `schemaVersion`  
4. 不带正确 Secret 的 Webhook POST 返回 401  
5. 新用户私聊收到验证流程  
6. 验证通过后创建独立 Forum Topic  
7. 管理员在 Topic 中回复到达用户  
8. 恢复 Owner 私聊 `/start` 可看到后台连接检查入口  
9. 日志中不出现消息正文、Bot Token 或验证挑战标识  
10. Cron 执行后无绑定或 SQL 错误  

生产建议先用测试 Bot、测试群完成上述步骤。

---

## 11. 日常更新流程

```bash
# 修改 worker.js / src/** 后
git add -A
git commit -m "说明变更"
# pre-commit 自动: pnpm run build:single && git add dist/worker.single.js
git push   # 仅备份代码；不会自动更新 Cloudflare
```

然后：

1. 打开 Cloudflare Worker → **Edit code**  
2. 粘贴最新 `dist/worker.single.js`  
3. **Deploy**  

---

## 12. 故障速查

| 现象 | 处理 |
|------|------|
| `SUPERGROUP_ID not set` 但 Dashboard 有配置 | 检查变量名是否有前导空格；`GET /health/env` 看 `keys` |
| `D1 'TG_BOT_DB' is a string variable, not a D1 Database binding` | `TG_BOT_DB` 必须是 **D1 Binding**，不能是 Text 变量 |
| Webhook 500 + pending > 0 | 看 Worker Logs 或 curl POST 响应正文中的 `Error: ...` |
| `/listwords` 没有 `SPAM_KEYWORDS` | 屏蔽词与 spam 词库是两套；`SPAM_KEYWORDS` 走环境变量 |
| 粘贴后 import 报错 | 粘贴的是源码 `worker.js` 而非 `dist/worker.single.js` |

诊断接口（不含密钥值）：

- `GET /health`  
- `GET /health/env`  
- `GET /health/d1`  
