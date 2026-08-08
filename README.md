# CC Home Backend

## 聊天鉴权

浏览器调用 `POST /chat` 和 `GET /chat/history` 时，必须在
`Authorization: Bearer <access-token>` 中发送 Supabase Auth 用户 access token。
服务端通过 `supabase.auth.getUser(token)` 向 Supabase Auth 验证 token 和用户身份，
不会依据未验证的 JWT payload 授权。只有验证所得 `user.id` 与
`CHAT_ALLOWED_USER_ID` 完全一致时才允许访问；授权依据是 Supabase 用户 UUID，
不是邮箱字符串。

`CHAT_ACCESS_TOKEN` 是临时保留的服务端烟雾测试凭证，只能通过
`X-CC-Home-Internal-Token` 发送。它不能用于浏览器登录，也不得进入 Vite 环境变量、
前端源码、构建产物、浏览器存储、响应或日志。`Authorization` header 不接受该内部凭证，
从而避免它与用户 JWT 混淆。

第一版每个允许用户只有一个服务端主聊天。`POST /chat` 只接受 `{ "message": "..." }`，
`GET /chat/history` 不接受 session ID。服务端使用已验证的 `user.id` 查询或创建唯一
`sessions(user_id, session_kind = 'main')`，并把服务端生成的 `conversation_id` 作为
Gateway session。客户端提交 `sessionId` 会被拒绝，也不会收到服务端 conversation ID。

内部烟测使用 `CC_HOME_SMOKE_SESSION_ID`，不读取或保存 Supabase 用户消息；内部凭证不能
访问历史接口，因此烟测数据与用户主聊天完全隔离。

## 聊天历史

`GET /chat/history` 根据已验证用户解析主聊天，并复用 UUID 到 PostgreSQL bigint 的
确定性映射。接口只查询可见消息，限量后按时间正序返回：

```json
{
  "messages": [
    {
      "role": "user",
      "content": "你好",
      "createdAt": "2026-08-09T01:00:00.000Z"
    }
  ]
}
```

响应角色只包含 `user` 和 `assistant`，不会返回数据库 session ID 或其他内部字段。
前端刷新后应通过该接口恢复消息，不应把消息正文保存到 `localStorage`。

## 单用户限制

迁移 `migrations/20260809_add_owned_main_sessions.sql` 为 `sessions` 增加 nullable 的
`user_id`、`session_kind`、`conversation_id`。现有行三列保持 `NULL`，作为不可访问的
legacy 数据；迁移不会更新、删除、合并或回填旧 sessions/messages。只有已验证用户首次
访问时，应用才创建一条新的 owned main session。

将来支持多个聊天或多个授权用户时，仍需审查 messages 所有权和 RLS，不能允许任意
已登录用户凭 session ID 访问会话。

## 本地验证

测试通过依赖注入使用本地 Supabase Auth、数据库和 Gateway mock，不连接真实服务：

```sh
npm test
```
