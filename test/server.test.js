const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');

const { createApp, toSupabaseSessionId } = require('../server');

const migrationPath = path.join(
  __dirname,
  '..',
  'migrations',
  '20260809_add_owned_main_sessions.sql'
);

const baseEnv = {
  NODE_ENV: 'production',
  FRONTEND_ORIGIN: 'https://cc-home.example',
  ADMIN_TOKEN: 'admin-test-token',
  CHAT_ACCESS_TOKEN: 'chat-test-token',
  CHAT_ALLOWED_USER_ID: '11111111-1111-4111-8111-111111111111',
  OMBRE_GATEWAY_BASE_URL: 'https://gateway.invalid/v1',
  OMBRE_GATEWAY_TOKEN: 'gateway-test-token',
  OMBRE_GATEWAY_MODEL: 'test-model',
  OMBRE_GATEWAY_TIMEOUT_MS: '1000',
  CC_HOME_SMOKE_SESSION_ID: 'cc-home-smoke',
  CHAT_RATE_LIMIT_MAX: '100',
  CHAT_MAX_MESSAGE_LENGTH: '4000'
};

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

function createFakeSupabase(options = {}) {
  const calls = [];
  const inserts = [];
  const sessions = new Map(
    (options.existingSessions || []).map(session => [String(session.id), { ...session }])
  );

  return {
    calls,
    inserts,
    sessions,
    from(table) {
      calls.push({ method: 'from', table });
      const queryState = {
        filters: [],
        limit: null,
        order: null,
        select: null
      };

      function execute(single = false) {
        if (table === 'sessions') {
          if (options.sessionQueryError) {
            return Promise.resolve({ data: null, error: options.sessionQueryError });
          }
          let rows = [...sessions.values()].filter(row =>
            queryState.filters.every(filter => String(row[filter.column]) === String(filter.value))
          );
          if (queryState.limit !== null) rows = rows.slice(0, queryState.limit);
          if (single) {
            if (rows.length > 1) {
              return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
            }
            return Promise.resolve({ data: rows[0] || null, error: null });
          }
          return Promise.resolve({ data: rows, error: null });
        }

        let rows = [...(options.history || [])];
        for (const filter of queryState.filters) {
          if (rows.some(row => Object.hasOwn(row, filter.column))) {
            rows = rows.filter(row => String(row[filter.column]) === String(filter.value));
          }
        }
        if (queryState.order && rows.every(row => row[queryState.order.column])) {
          const direction = queryState.order.options?.ascending ? 1 : -1;
          rows.sort((left, right) =>
            direction * String(left[queryState.order.column]).localeCompare(
              String(right[queryState.order.column])
            )
          );
        }
        if (queryState.limit !== null) rows = rows.slice(0, queryState.limit);
        return Promise.resolve({
          data: rows,
          error: options.historyError || options.testDbError || null
        });
      }

      const query = {
        select(columns, selectOptions) {
          calls.push({ method: 'select', table, columns, options: selectOptions });
          queryState.select = { columns, options: selectOptions };
          return query;
        },
        eq(column, value) {
          calls.push({ method: 'eq', table, column, value });
          queryState.filters.push({ column, value });
          return query;
        },
        order(column, orderOptions) {
          calls.push({ method: 'order', table, column, options: orderOptions });
          queryState.order = { column, options: orderOptions };
          return query;
        },
        limit(value) {
          calls.push({ method: 'limit', table, value });
          queryState.limit = value;
          return query;
        },
        maybeSingle() {
          calls.push({ method: 'maybeSingle', table });
          return execute(true);
        },
        then(resolve, reject) {
          return execute(false).then(resolve, reject);
        },
        insert(rows) {
          calls.push({ method: 'insert', table, rows });
          inserts.push(rows);
          if (table === 'sessions') {
            if (typeof options.onSessionInsert === 'function') {
              const result = options.onSessionInsert(rows, sessions);
              if (result) return Promise.resolve(result);
            }
            if (options.sessionInsertError) {
              return Promise.resolve({ error: options.sessionInsertError });
            }

            const key = String(rows.id);
            const duplicate = sessions.has(key) || [...sessions.values()].some(session =>
              session.conversation_id === rows.conversation_id
              || (
                session.user_id === rows.user_id
                && session.session_kind === 'main'
                && rows.session_kind === 'main'
              )
            );
            if (duplicate) return Promise.resolve({ error: { code: '23505' } });
            sessions.set(key, { ...rows });
            return Promise.resolve({ error: null });
          }
          return Promise.resolve({ error: options.insertError || null });
        }
      };
      return query;
    }
  };
}

async function startTestServer(options) {
  const app = createApp({
    ...options,
    randomUUID: options.randomUUID || (() => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    supabaseAuth: options.supabaseAuth || {
      async getUser() {
        return {
          data: { user: { id: (options.env || baseEnv).CHAT_ALLOWED_USER_ID } },
          error: null
        };
      }
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function request(server, path, options = {}) {
  const address = server.address();
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = { ...(options.headers || {}) };
  if (
    path.startsWith('/chat')
    && options.chatAccess !== false
    && !headers.Authorization
    && !headers['X-CC-Home-Internal-Token']
  ) {
    headers.Authorization = 'Bearer valid-user-jwt';
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method: options.method || 'GET',
      headers
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function closeServer(server) {
  server.close();
  await once(server, 'close');
}

test('字符串 session 确定性映射为 Supabase bigint 兼容 ID', () => {
  const firstUuid = '550e8400-e29b-41d4-a716-446655440000';
  const secondUuid = '550e8400-e29b-41d4-a716-446655440001';
  const firstMapped = toSupabaseSessionId(firstUuid);
  const repeatedMapped = toSupabaseSessionId(firstUuid);
  const secondMapped = toSupabaseSessionId(secondUuid);

  assert.equal(firstMapped, repeatedMapped);
  assert.notEqual(firstMapped, secondMapped);
  assert.match(firstMapped, /^\d+$/);
  assert.equal(BigInt(firstMapped) > 0n, true);
  assert.equal(BigInt(firstMapped) <= 9_223_372_036_854_775_807n, true);
  assert.equal(toSupabaseSessionId('1723456789012'), '1723456789012');
  assert.equal(toSupabaseSessionId(1723456789012), '1723456789012');
  assert.equal(toSupabaseSessionId('000123'), '123');
});

test('所有权 migration 只新增 nullable 元数据且不改写 legacy 行', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /add column user_id uuid null/i);
  assert.match(sql, /add column session_kind text null/i);
  assert.match(sql, /add column conversation_id uuid null/i);
  assert.match(sql, /foreign key \(user_id\) references auth\.users\(id\)/i);
  assert.match(sql, /sessions_owned_main_shape_check/i);
  assert.match(sql, /sessions_one_main_per_user_idx/i);
  assert.match(sql, /sessions_conversation_id_key/i);
  assert.doesNotMatch(sql, /^\s*update\s+/im);
  assert.doesNotMatch(sql, /^\s*delete\s+from\s+/im);
  assert.doesNotMatch(sql, /^\s*insert\s+into\s+/im);
});

test('/chat 区分 Supabase 用户 JWT 与内部烟测凭证', async t => {
  async function runChat({
    headers,
    chatAccess = false,
    env = baseEnv,
    getUser = async () => ({ data: { user: null }, error: new Error('invalid token') })
  } = {}) {
    const supabase = createFakeSupabase();
    let gatewayCalls = 0;
    const gatewaySessionIds = [];
    const verifiedTokens = [];
    const server = await startTestServer({
      env,
      supabaseClient: supabase,
      supabaseAuth: {
        async getUser(token) {
          verifiedTokens.push(token);
          return getUser(token);
        }
      },
      gatewayFetch: async (url, requestOptions) => {
        gatewayCalls += 1;
        gatewaySessionIds.push(requestOptions.headers['X-Ombre-Session-Id']);
        return response(200, { choices: [{ message: { content: '鉴权通过' } }] });
      }
    });

    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        headers,
        chatAccess,
        body: { message: '测试聊天鉴权' }
      });
      return { result, gatewayCalls, gatewaySessionIds, supabase, verifiedTokens };
    } finally {
      await closeServer(server);
    }
  }

  await t.test('缺失登录凭证返回 401', async () => {
    const { result, gatewayCalls, supabase } = await runChat();
    assert.equal(result.status, 401);
    assert.equal(gatewayCalls, 0);
    assert.equal(supabase.calls.length, 0);
    assert.equal(JSON.stringify(result.body).includes('chat-test-token'), false);
  });

  await t.test('内部烟测 header 在未配置 CHAT_ACCESS_TOKEN 时返回 503', async () => {
    const env = { ...baseEnv };
    delete env.CHAT_ACCESS_TOKEN;
    const originalError = console.error;
    console.error = () => {};
    try {
      const { result, gatewayCalls, supabase } = await runChat({
        env,
        headers: { 'X-CC-Home-Internal-Token': 'chat-test-token' }
      });
      assert.equal(result.status, 503);
      assert.equal(gatewayCalls, 0);
      assert.equal(supabase.calls.length, 0);
    } finally {
      console.error = originalError;
    }
  });

  await t.test('无效和过期 JWT 均返回 401', async () => {
    for (const token of ['invalid-user-jwt', 'expired-user-jwt']) {
      const { result, gatewayCalls, supabase, verifiedTokens } = await runChat({
        headers: { Authorization: `Bearer ${token}` },
        getUser: async () => ({ data: { user: null }, error: new Error('invalid') })
      });
      assert.equal(result.status, 401);
      assert.equal(gatewayCalls, 0);
      assert.equal(supabase.calls.length, 0);
      assert.deepEqual(verifiedTokens, [token]);
      assert.equal(JSON.stringify(result.body).includes(token), false);
    }
  });

  await t.test('鉴权失败不记录 JWT 或内部凭证', async () => {
    const jwt = 'sensitive-invalid-user-jwt';
    const internalToken = 'sensitive-invalid-internal-token';
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      const jwtResult = await runChat({
        headers: { Authorization: `Bearer ${jwt}` },
        getUser: async () => {
          throw new Error(`expired ${jwt}`);
        }
      });
      const internalResult = await runChat({
        headers: { 'X-CC-Home-Internal-Token': internalToken }
      });

      assert.equal(jwtResult.result.status, 401);
      assert.equal(internalResult.result.status, 401);
      assert.equal(JSON.stringify(errors).includes(jwt), false);
      assert.equal(JSON.stringify(errors).includes(internalToken), false);
    } finally {
      console.error = originalError;
    }
  });

  await t.test('有效 JWT 但用户 UUID 不匹配时返回 403', async () => {
    const { result, gatewayCalls, supabase } = await runChat({
      headers: { Authorization: 'Bearer valid-other-user-jwt' },
      getUser: async () => ({
        data: { user: { id: '22222222-2222-4222-8222-222222222222' } },
        error: null
      })
    });
    assert.equal(result.status, 403);
    assert.equal(gatewayCalls, 0);
    assert.equal(supabase.calls.length, 0);
  });

  await t.test('有效 JWT 且用户 UUID 匹配时允许聊天', async () => {
    const { result, gatewayCalls, supabase, verifiedTokens } = await runChat({
      headers: { Authorization: 'Bearer valid-user-jwt' },
      getUser: async () => ({
        data: { user: { id: baseEnv.CHAT_ALLOWED_USER_ID } },
        error: null
      })
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { reply: '鉴权通过' });
    assert.equal(gatewayCalls, 1);
    assert.equal(supabase.inserts.some(rows => Array.isArray(rows)), true);
    assert.deepEqual(verifiedTokens, ['valid-user-jwt']);
  });

  await t.test('用户 JWT 路径缺少 CHAT_ALLOWED_USER_ID 时返回 503', async () => {
    const env = { ...baseEnv };
    delete env.CHAT_ALLOWED_USER_ID;
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      const { result, gatewayCalls, verifiedTokens } = await runChat({
        env,
        headers: { Authorization: 'Bearer valid-user-jwt' },
        getUser: async () => ({
          data: { user: { id: baseEnv.CHAT_ALLOWED_USER_ID } },
          error: null
        })
      });
      assert.equal(result.status, 503);
      assert.equal(gatewayCalls, 0);
      assert.deepEqual(verifiedTokens, []);
      assert.deepEqual(errors, [['聊天接口不可用：未配置 CHAT_ALLOWED_USER_ID']]);
    } finally {
      console.error = originalError;
    }
  });

  await t.test('CHAT_ACCESS_TOKEN 只接受独立内部 header', async () => {
    const internal = await runChat({
      headers: { 'X-CC-Home-Internal-Token': 'chat-test-token' }
    });
    assert.equal(internal.result.status, 200);
    assert.equal(internal.gatewayCalls, 1);
    assert.deepEqual(internal.gatewaySessionIds, ['cc-home-smoke']);
    assert.deepEqual(internal.verifiedTokens, []);
    assert.equal(internal.supabase.calls.length, 0);

    const bearer = await runChat({
      headers: { Authorization: 'Bearer chat-test-token' }
    });
    assert.equal(bearer.result.status, 401);
    assert.equal(bearer.gatewayCalls, 0);
    assert.deepEqual(bearer.verifiedTokens, ['chat-test-token']);
  });

  await t.test('内部烟测 session 必须位于独立命名空间', async () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      const smoke = await runChat({
        env: {
          ...baseEnv,
          CC_HOME_SMOKE_SESSION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        },
        headers: { 'X-CC-Home-Internal-Token': 'chat-test-token' }
      });
      assert.equal(smoke.result.status, 503);
      assert.equal(smoke.gatewayCalls, 0);
      assert.equal(smoke.supabase.calls.length, 0);
      assert.deepEqual(errors, [['解析主聊天失败']]);
    } finally {
      console.error = originalError;
    }
  });
});

test('GET /chat/history 复用鉴权、session 映射并安全返回正序历史', async t => {
  const conversationId = '550e8400-e29b-41d4-a716-446655440123';
  const supabaseSessionId = toSupabaseSessionId(conversationId);
  const mainSession = {
    // 模拟 PostgREST/JSON 把 bigint 解析成不安全 Number；应用必须从 UUID 重算。
    id: Number(supabaseSessionId),
    name: '主聊天',
    user_id: baseEnv.CHAT_ALLOWED_USER_ID,
    session_kind: 'main',
    conversation_id: conversationId
  };

  await t.test('拒绝缺失凭证和客户端指定的 sessionId', async () => {
    const supabase = createFakeSupabase();
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async () => response(200, {})
    });

    try {
      const unauthenticated = await request(
        server,
        '/chat/history',
        { chatAccess: false }
      );
      const invalidSession = await request(
        server,
        '/chat/history?sessionId=550e8400-e29b-41d4-a716-446655440999'
      );

      assert.equal(unauthenticated.status, 401);
      assert.equal(invalidSession.status, 400);
      assert.equal(supabase.calls.length, 0);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('内部烟测凭证不能读取用户历史且不访问 Supabase', async () => {
    const supabase = createFakeSupabase();
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async () => response(200, {})
    });

    try {
      const result = await request(server, '/chat/history', {
        chatAccess: false,
        headers: { 'X-CC-Home-Internal-Token': 'chat-test-token' }
      });
      assert.equal(result.status, 403);
      assert.equal(supabase.calls.length, 0);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('新账号首次读取历史时创建空 main session', async () => {
    const supabase = createFakeSupabase();
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async () => response(200, {})
    });

    try {
      const result = await request(server, '/chat/history');
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { messages: [] });
      assert.equal(supabase.sessions.size, 1);
      const main = [...supabase.sessions.values()][0];
      assert.equal(main.user_id, baseEnv.CHAT_ALLOWED_USER_ID);
      assert.equal(main.session_kind, 'main');
      assert.equal(main.id, toSupabaseSessionId(main.conversation_id));
    } finally {
      await closeServer(server);
    }
  });

  await t.test('使用确定性 bigint 映射、过滤角色并按时间正序返回', async () => {
    const supabase = createFakeSupabase({
      existingSessions: [mainSession],
      // 模拟数据库按 created_at DESC 返回。
      history: [
        {
          role: 'system',
          content: '不应返回',
          created_at: '2026-08-09T03:00:00.000Z',
          internal_secret: '不应泄露'
        },
        {
          role: 'ai',
          content: '较新的回复',
          created_at: '2026-08-09T02:00:00.000Z',
          session_id: supabaseSessionId
        },
        {
          role: 'user',
          content: '较早的消息',
          created_at: '2026-08-09T01:00:00.000Z',
          session_id: supabaseSessionId
        }
      ]
    });
    const verifiedTokens = [];
    const server = await startTestServer({
      env: { ...baseEnv, CHAT_HISTORY_MAX_MESSAGES: '9999' },
      supabaseClient: supabase,
      supabaseAuth: {
        async getUser(token) {
          verifiedTokens.push(token);
          return {
            data: { user: { id: baseEnv.CHAT_ALLOWED_USER_ID } },
            error: null
          };
        }
      },
      gatewayFetch: async () => response(200, {})
    });

    try {
      const result = await request(server, '/chat/history', {
        chatAccess: false,
        headers: { Authorization: 'Bearer valid-history-user-jwt' }
      });

      assert.equal(result.status, 200);
      assert.deepEqual(verifiedTokens, ['valid-history-user-jwt']);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.deepEqual(result.body, {
        messages: [
          {
            role: 'user',
            content: '较早的消息',
            createdAt: '2026-08-09T01:00:00.000Z'
          },
          {
            role: 'assistant',
            content: '较新的回复',
            createdAt: '2026-08-09T02:00:00.000Z'
          }
        ]
      });
      assert.equal(JSON.stringify(result.body).includes('internal_secret'), false);
      assert.equal(JSON.stringify(result.body).includes(supabaseSessionId), false);

      const selectCall = supabase.calls.find(
        call => call.method === 'select' && call.table === 'messages'
      );
      assert.equal(selectCall.columns, 'role, content, created_at');
      const sessionQuery = supabase.calls.find(
        call => call.method === 'eq' && call.column === 'session_id'
      );
      assert.equal(sessionQuery.value, supabaseSessionId);
      const visibleQuery = supabase.calls.find(
        call => call.method === 'eq' && call.column === 'visible'
      );
      assert.equal(visibleQuery.value, true);
      const orderCall = supabase.calls.find(call => call.method === 'order');
      assert.deepEqual(orderCall.options, { ascending: false });
      const limitCall = supabase.calls.find(call => call.method === 'limit');
      assert.equal(limitCall.value, 200);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('Supabase 查询失败时返回安全错误且不记录错误详情', async () => {
    const sensitiveError = 'database-secret chat-test-token';
    const supabase = createFakeSupabase({
      existingSessions: [mainSession],
      historyError: new Error(sensitiveError)
    });
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async () => response(200, {})
    });

    try {
      const result = await request(server, '/chat/history');
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: '聊天记录暂时不可用' });
      assert.deepEqual(errors, [['加载聊天历史失败']]);
      assert.equal(JSON.stringify(errors).includes(sensitiveError), false);
      assert.equal(JSON.stringify(result.body).includes(sensitiveError), false);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });
});

test('稳定传递 session，读取最近历史并把 ai 转为 assistant', async () => {
  const conversationId = '550e8400-e29b-41d4-a716-446655440000';
  const supabaseSessionId = toSupabaseSessionId(conversationId);
  const supabase = createFakeSupabase({
    existingSessions: [{
      id: supabaseSessionId,
      name: '主聊天',
      user_id: baseEnv.CHAT_ALLOWED_USER_ID,
      session_kind: 'main',
      conversation_id: conversationId
    }],
    // 模拟数据库按 created_at DESC 返回。
    history: [
      { role: 'system', content: '不应传给 Gateway' },
      { role: 'ai', content: '较新的 AI 回复' },
      { role: 'user', content: '较早的用户消息' }
    ]
  });
  const gatewayCalls = [];
  const gatewayFetch = async (url, options) => {
    gatewayCalls.push({ url, options, payload: JSON.parse(options.body) });
    return response(200, {
      choices: [{ message: { role: 'assistant', content: '模拟回复' } }]
    });
  };
  const server = await startTestServer({ env: baseEnv, supabaseClient: supabase, gatewayFetch });

  try {
    const first = await request(server, '/chat', {
      method: 'POST',
      body: { message: '第一轮' }
    });
    const second = await request(server, '/chat', {
      method: 'POST',
      body: { message: '第二轮' }
    });

    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { reply: '模拟回复' });
    assert.equal(second.status, 200);
    assert.equal(gatewayCalls.length, 2);
    assert.equal(gatewayCalls[0].url, 'https://gateway.invalid/v1/chat/completions');
    assert.equal(gatewayCalls[0].options.headers.Authorization, 'Bearer gateway-test-token');
    assert.equal(gatewayCalls[0].options.headers['X-Ombre-Session-Id'], conversationId);
    assert.equal(gatewayCalls[1].options.headers['X-Ombre-Session-Id'], conversationId);
    assert.equal(gatewayCalls[0].payload.stream, false);
    assert.equal(gatewayCalls[0].payload.model, 'test-model');
    assert.deepEqual(gatewayCalls[0].payload.messages, [
      { role: 'user', content: '较早的用户消息' },
      { role: 'assistant', content: '较新的 AI 回复' },
      { role: 'user', content: '第一轮' }
    ]);

    const orderCall = supabase.calls.find(call => call.method === 'order');
    assert.deepEqual(orderCall.options, { ascending: false });
    const sessionQueries = supabase.calls.filter(
      call => call.method === 'eq' && call.column === 'session_id'
    );
    assert.deepEqual(sessionQueries.map(call => call.value), [
      supabaseSessionId,
      supabaseSessionId
    ]);
    assert.equal(supabase.inserts.length, 2);
    assert.deepEqual(supabase.inserts[0], [
      { session_id: supabaseSessionId, role: 'user', content: '第一轮' },
      { session_id: supabaseSessionId, role: 'ai', content: '模拟回复' }
    ]);
    assert.equal(supabase.calls.some(call => call.table === 'settings'), false);
    assert.equal(gatewayCalls.some(call => call.url.includes('/mcp')), false);
  } finally {
    await closeServer(server);
  }
});

test('按已验证用户幂等解析或创建唯一 main session', async t => {
  const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const supabaseSessionId = toSupabaseSessionId(conversationId);
  const gatewayFetch = async () => response(200, {
    choices: [{ message: { content: '已回复' } }]
  });

  await t.test('新用户先创建 owned main session 再保存 messages', async () => {
    const supabase = createFakeSupabase();
    const server = await startTestServer({ env: baseEnv, supabaseClient: supabase, gatewayFetch });

    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '新会话' }
      });

      assert.equal(result.status, 200);
      const expectedSession = {
        id: supabaseSessionId,
        name: '主聊天',
        user_id: baseEnv.CHAT_ALLOWED_USER_ID,
        session_kind: 'main',
        conversation_id: conversationId
      };
      assert.deepEqual(supabase.inserts[0], expectedSession);
      assert.deepEqual(supabase.inserts[1], [
        { session_id: supabaseSessionId, role: 'user', content: '新会话' },
        { session_id: supabaseSessionId, role: 'ai', content: '已回复' }
      ]);

      const sessionInsertIndex = supabase.calls.findIndex(
        call => call.method === 'insert' && call.table === 'sessions'
      );
      const messageInsertIndex = supabase.calls.findIndex(
        call => call.method === 'insert' && call.table === 'messages'
      );
      assert.equal(sessionInsertIndex < messageInsertIndex, true);
      assert.deepEqual(supabase.sessions.get(supabaseSessionId), expectedSession);
      const ownerQueries = supabase.calls.filter(
        call => call.method === 'eq' && call.column === 'user_id'
      );
      assert.equal(ownerQueries.every(
        call => call.value === baseEnv.CHAT_ALLOWED_USER_ID
      ), true);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('同一用户多轮和多设备调用只创建一个 main session', async () => {
    const supabase = createFakeSupabase();
    const gatewaySessions = [];
    const sharedGatewayFetch = async (url, options) => {
      gatewaySessions.push(options.headers['X-Ombre-Session-Id']);
      return response(200, { choices: [{ message: { content: '已回复' } }] });
    };
    const firstDeviceServer = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: sharedGatewayFetch,
      randomUUID: () => conversationId
    });
    const secondDeviceServer = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: sharedGatewayFetch,
      randomUUID: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    });

    try {
      await request(firstDeviceServer, '/chat', {
        method: 'POST',
        body: { message: '设备一' }
      });
      await request(secondDeviceServer, '/chat', {
        method: 'POST',
        body: { message: '设备二' }
      });

      assert.equal(supabase.sessions.size, 1);
      assert.equal(supabase.calls.filter(
        call => call.method === 'insert' && call.table === 'sessions'
      ).length, 1);
      assert.deepEqual(gatewaySessions, [conversationId, conversationId]);
    } finally {
      await closeServer(firstDeviceServer);
      await closeServer(secondDeviceServer);
    }
  });

  await t.test('已有 owned main session 不覆盖名称和时间字段', async () => {
    const existingSession = {
      id: supabaseSessionId,
      name: '已有会话名称',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
      user_id: baseEnv.CHAT_ALLOWED_USER_ID,
      session_kind: 'main',
      conversation_id: conversationId
    };
    const supabase = createFakeSupabase({ existingSessions: [existingSession] });
    const server = await startTestServer({ env: baseEnv, supabaseClient: supabase, gatewayFetch });

    try {
      await request(server, '/chat', {
        method: 'POST',
        body: { message: '继续会话' }
      });

      assert.deepEqual(supabase.sessions.get(supabaseSessionId), existingSession);
      assert.equal(supabase.inserts.length, 1);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('Gateway 失败时保留空 main session 但不保存消息', async () => {
    const supabase = createFakeSupabase();
    const originalError = console.error;
    console.error = () => {};
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async () => response(502, { error: 'fake upstream error' })
    });

    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '不会保存' }
      });

      assert.equal(result.status, 502);
      assert.equal(supabase.sessions.size, 1);
      assert.equal(supabase.calls.filter(
        call => call.method === 'insert' && call.table === 'messages'
      ).length, 0);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });

  await t.test('main session 创建失败时返回安全错误且不调用 Gateway', async () => {
    const supabase = createFakeSupabase({
      sessionInsertError: new Error('不应写入日志的模拟敏感内容 gateway-test-token')
    });
    let gatewayCalls = 0;
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async () => {
        gatewayCalls += 1;
        return response(200, { choices: [{ message: { content: '不应回复' } }] });
      }
    });

    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '创建会失败' }
      });

      assert.equal(result.status, 503);
      assert.equal(gatewayCalls, 0);
      assert.equal(supabase.sessions.size, 0);
      assert.deepEqual(errors, [['解析主聊天失败']]);
      assert.equal(JSON.stringify(errors).includes('gateway-test-token'), false);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });

  await t.test('并发创建唯一冲突后读取胜出的同一 main session', async () => {
    const winnerConversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const winnerDatabaseId = toSupabaseSessionId(winnerConversationId);
    const winner = {
      id: winnerDatabaseId,
      name: '主聊天',
      user_id: baseEnv.CHAT_ALLOWED_USER_ID,
      session_kind: 'main',
      conversation_id: winnerConversationId
    };
    const supabase = createFakeSupabase({
      onSessionInsert(rows, sessions) {
        sessions.set(winnerDatabaseId, winner);
        return { error: { code: '23505' } };
      }
    });
    let gatewaySessionId;
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async (url, options) => {
        gatewaySessionId = options.headers['X-Ombre-Session-Id'];
        return response(200, { choices: [{ message: { content: '并发后回复' } }] });
      }
    });

    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '并发创建' }
      });
      assert.equal(result.status, 200);
      assert.equal(supabase.sessions.size, 1);
      assert.equal(gatewaySessionId, winnerConversationId);
      const savedMessages = supabase.inserts.find(rows => Array.isArray(rows));
      assert.equal(savedMessages[0].session_id, winnerDatabaseId);
    } finally {
      await closeServer(server);
    }
  });
});

test('客户端不能指定或访问无所有者 legacy session', async () => {
  const legacySession = {
    id: '1723456789012',
    name: '旧测试会话',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    user_id: null,
    session_kind: null,
    conversation_id: null
  };
  const supabase = createFakeSupabase({ existingSessions: [legacySession] });
  let gatewayCalls = 0;
  const server = await startTestServer({
    env: baseEnv,
    supabaseClient: supabase,
    gatewayFetch: async () => {
      gatewayCalls += 1;
      return response(200, { choices: [{ message: { content: '不应回复' } }] });
    }
  });

  try {
    const result = await request(server, '/chat', {
      method: 'POST',
      body: { message: '尝试旧会话', sessionId: legacySession.id }
    });

    assert.equal(result.status, 400);
    assert.equal(gatewayCalls, 0);
    assert.deepEqual(supabase.sessions.get(legacySession.id), legacySession);
    assert.equal(supabase.calls.some(call => call.table === 'messages'), false);

    const normalChat = await request(server, '/chat', {
      method: 'POST',
      body: { message: '创建新的主聊天' }
    });
    assert.equal(normalChat.status, 200);
    assert.equal(gatewayCalls, 1);
    assert.equal(supabase.sessions.size, 2);
    assert.deepEqual(supabase.sessions.get(legacySession.id), legacySession);
    const mainSessions = [...supabase.sessions.values()].filter(
      session => session.session_kind === 'main'
    );
    assert.equal(mainSessions.length, 1);
    assert.equal(mainSessions[0].user_id, baseEnv.CHAT_ALLOWED_USER_ID);
  } finally {
    await closeServer(server);
  }
});

test('不依赖客户端 sessionId 时同一账号始终使用服务端主聊天', async () => {
  const supabase = createFakeSupabase();
  const sessions = [];
  const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const mainSupabaseSessionId = toSupabaseSessionId(conversationId);
  const gatewayFetch = async (url, options) => {
    sessions.push(options.headers['X-Ombre-Session-Id']);
    return response(200, { choices: [{ message: { content: 'ok' } }] });
  };
  const server = await startTestServer({ env: baseEnv, supabaseClient: supabase, gatewayFetch });

  try {
    await request(server, '/chat', { method: 'POST', body: { message: '一' } });
    await request(server, '/chat', { method: 'POST', body: { message: '二' } });
    assert.deepEqual(sessions, [conversationId, conversationId]);
    const sessionQueries = supabase.calls.filter(
      call => call.method === 'eq' && call.column === 'session_id'
    );
    assert.deepEqual(sessionQueries.map(call => call.value), [
      mainSupabaseSessionId,
      mainSupabaseSessionId
    ]);
    const messageInserts = supabase.inserts.filter(rows => Array.isArray(rows));
    assert.equal(messageInserts[0][0].session_id, mainSupabaseSessionId);
    assert.equal(messageInserts[1][0].session_id, mainSupabaseSessionId);
  } finally {
    await closeServer(server);
  }
});

test('历史读取失败时仍可对话，保存返回 error 时不会吞掉回复', async () => {
  const supabase = createFakeSupabase({
    historyError: new Error('fake history error'),
    insertError: new Error('fake insert error')
  });
  const gatewayFetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.messages, [{ role: 'user', content: '继续聊天' }]);
    return response(200, { choices: [{ message: { content: '仍然回复' } }] });
  };
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  const server = await startTestServer({ env: baseEnv, supabaseClient: supabase, gatewayFetch });

  try {
    const result = await request(server, '/chat', {
      method: 'POST',
      body: { message: '继续聊天' }
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { reply: '仍然回复' });
    assert.equal(errors.some(args => args[0] === '加载历史消息失败'), true);
    assert.equal(errors.some(args => args[0] === '保存消息失败'), true);
    assert.equal(JSON.stringify(errors).includes('继续聊天'), false);
    assert.equal(JSON.stringify(errors).includes('chat-test-token'), false);
  } finally {
    console.error = originalError;
    await closeServer(server);
  }
});

test('Gateway 非成功响应和无效响应都返回安全错误且不保存消息', async t => {
  await t.test('非成功响应不透传上游正文', async () => {
    const supabase = createFakeSupabase();
    const originalError = console.error;
    console.error = () => {};
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async () => response(401, { secret: '不应泄露' })
    });
    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '测试' }
      });
      assert.equal(result.status, 502);
      assert.equal(JSON.stringify(result.body).includes('不应泄露'), false);
      assert.equal(supabase.inserts.some(rows => Array.isArray(rows)), false);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });

  await t.test('缺少 assistant content 返回 502', async () => {
    const supabase = createFakeSupabase();
    const originalError = console.error;
    console.error = () => {};
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async () => response(200, { choices: [] })
    });
    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '测试' }
      });
      assert.equal(result.status, 502);
      assert.equal(supabase.inserts.some(rows => Array.isArray(rows)), false);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });
});

test('Gateway 超时返回 504，配置缺失返回 503', async t => {
  await t.test('超时会中止模拟请求', async () => {
    const supabase = createFakeSupabase();
    const env = { ...baseEnv, OMBRE_GATEWAY_TIMEOUT_MS: '10' };
    const gatewayFetch = (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
    const originalError = console.error;
    console.error = () => {};
    const server = await startTestServer({ env, supabaseClient: supabase, gatewayFetch });
    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '测试超时' }
      });
      assert.equal(result.status, 504);
      assert.equal(supabase.inserts.some(rows => Array.isArray(rows)), false);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });

  await t.test('缺少 token 时不调用 Gateway', async () => {
    const supabase = createFakeSupabase();
    let called = false;
    const env = { ...baseEnv, OMBRE_GATEWAY_TOKEN: '' };
    const originalError = console.error;
    console.error = () => {};
    const server = await startTestServer({
      env,
      supabaseClient: supabase,
      gatewayFetch: async () => {
        called = true;
        return response(200, {});
      }
    });
    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '测试配置' }
      });
      assert.equal(result.status, 503);
      assert.equal(called, false);
      assert.equal(supabase.calls.length, 0);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });

  await t.test('缺少模型时不读取 Supabase', async () => {
    const supabase = createFakeSupabase();
    let called = false;
    const env = { ...baseEnv, OMBRE_GATEWAY_MODEL: '' };
    const originalError = console.error;
    console.error = () => {};
    const server = await startTestServer({
      env,
      supabaseClient: supabase,
      gatewayFetch: async () => {
        called = true;
        return response(200, {});
      }
    });
    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '测试模型配置' }
      });
      assert.equal(result.status, 503);
      assert.equal(called, false);
      assert.equal(supabase.calls.length, 0);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });
});

test('管理接口不再接收客户端密钥，也不会写 settings', async () => {
  const supabase = createFakeSupabase();
  let gatewayCalls = 0;
  const server = await startTestServer({
    env: baseEnv,
    supabaseClient: supabase,
    gatewayFetch: async () => {
      gatewayCalls += 1;
      return response(200, { data: [] });
    }
  });
  const headers = { Authorization: 'Bearer admin-test-token' };

  try {
    const models = await request(server, '/models', {
      method: 'POST',
      headers,
      body: { base_url: 'https://attacker.invalid/v1', api_key: 'client-secret' }
    });
    const config = await request(server, '/admin/config', {
      method: 'POST',
      headers,
      body: { api_key: 'client-secret' }
    });

    assert.equal(models.status, 400);
    assert.equal(config.status, 410);
    assert.equal(gatewayCalls, 0);
    assert.equal(supabase.calls.some(call => call.table === 'settings'), false);
  } finally {
    await closeServer(server);
  }
});

test('/models 和 /test-gateway 在未配置模型名时仍可使用', async () => {
  const supabase = createFakeSupabase();
  const gatewayCalls = [];
  const env = { ...baseEnv, OMBRE_GATEWAY_MODEL: '' };
  const server = await startTestServer({
    env,
    supabaseClient: supabase,
    gatewayFetch: async (url, options) => {
      gatewayCalls.push({ url, options });
      return response(200, { data: [{ id: 'discoverable-model' }] });
    }
  });
  const headers = { Authorization: 'Bearer admin-test-token' };

  try {
    const models = await request(server, '/models', {
      method: 'POST',
      headers,
      body: {}
    });
    const gatewayTest = await request(server, '/test-gateway', { headers });

    assert.equal(models.status, 200);
    assert.deepEqual(models.body, { success: true, models: ['discoverable-model'] });
    assert.equal(gatewayTest.status, 200);
    assert.deepEqual(gatewayTest.body, { connected: true });
    assert.equal(gatewayCalls.length, 2);
    assert.equal(gatewayCalls.every(call => call.url.endsWith('/models')), true);
    assert.equal(gatewayCalls.every(
      call => call.options.headers.Authorization === 'Bearer gateway-test-token'
    ), true);
  } finally {
    await closeServer(server);
  }
});
