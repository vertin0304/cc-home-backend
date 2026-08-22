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
const securityMigrationPath = path.join(
  __dirname,
  '..',
  'migrations',
  '20260815_secure_public_tables.sql'
);
const chatRequestsMigrationPath = path.join(
  __dirname,
  '..',
  'migrations',
  '20260815_add_chat_requests.sql'
);
const chatPreferencesMigrationPath = path.join(
  __dirname,
  '..',
  'migrations',
  '20260823_add_chat_preferences.sql'
);

const baseEnv = {
  NODE_ENV: 'production',
  FRONTEND_ORIGIN: 'https://cc-home.example',
  ADMIN_TOKEN: 'admin-test-token',
  CHAT_ACCESS_TOKEN: 'chat-test-token',
  CHAT_ALLOWED_USER_ID: '11111111-1111-4111-8111-111111111111',
  OMBRE_GATEWAY_BASE_URL: 'https://gateway.invalid/v1',
  OMBRE_GATEWAY_TOKEN: 'gateway-test-token',
  OMBRE_GATEWAY_MODEL: 'cc-home-default',
  CC_HOME_ALLOWED_MODEL_ALIASES: 'cc-home-default,cc-home-claude-sonnet,cc-home-claude-opus',
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

function assertSuccessfulChatResponse(result, reply) {
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, reply);
  assert.match(result.body.request_id, /^[0-9a-f-]{36}$/i);
  assert.equal(result.headers['x-request-id'], result.body.request_id);
  assert.equal(result.body.diagnostics.schema_version, 1);
  assert.equal(result.body.diagnostics.status, 'success');
  assert.equal(result.body.diagnostics.total_duration_ms >= 0, true);
}

function diagnosticFixture(overrides = {}) {
  return {
    schema_version: 1,
    status: 'success',
    total_duration_ms: 42,
    stages: Object.fromEntries([
      'authentication',
      'main_session',
      'history',
      'gateway',
      'message_save'
    ].map(name => [name, { status: 'success', duration_ms: 1 }])),
    gateway: {
      round: 7,
      recent_context_injected: true,
      recalled_count: 2,
      diffused_count: 1,
      injected_count: 3,
      error_stage: null,
      error_code: null
    },
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      cached_tokens: 50,
      prompt_cache_hit_tokens: null,
      prompt_cache_miss_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null
    },
    ...overrides
  };
}

function compareQueryValues(left, right) {
  const leftValue = String(left);
  const rightValue = String(right);
  if (/^-?\d+$/.test(leftValue) && /^-?\d+$/.test(rightValue)) {
    const leftBigInt = BigInt(leftValue);
    const rightBigInt = BigInt(rightValue);
    return leftBigInt < rightBigInt ? -1 : leftBigInt > rightBigInt ? 1 : 0;
  }
  return leftValue.localeCompare(rightValue);
}

function createFakeSupabase(options = {}) {
  const calls = [];
  const inserts = [];
  const sessions = new Map(
    (options.existingSessions || []).map(session => [String(session.id), { ...session }])
  );
  const messages = (options.history || []).map(message => ({ ...message }));
  const chatRequests = new Map(
    (options.chatRequests || []).map(item => [String(item.request_id), { ...item }])
  );
  const chatPreferences = new Map(
    (options.chatPreferences || []).map(item => [String(item.user_id), { ...item }])
  );

  return {
    calls,
    inserts,
    sessions,
    messages,
    chatRequests,
    chatPreferences,
    from(table) {
      calls.push({ method: 'from', table });
      const queryState = {
        filters: [],
        limit: null,
        order: null,
        select: null,
        inFilters: []
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

        if (table === 'chat_preferences') {
          if (options.preferenceQueryError) {
            return Promise.resolve({ data: null, error: options.preferenceQueryError });
          }
          let rows = [...chatPreferences.values()].filter(row =>
            queryState.filters.every(filter => String(row[filter.column]) === String(filter.value))
          );
          if (single) {
            return Promise.resolve({ data: rows[0] || null, error: null });
          }
          return Promise.resolve({ data: rows, error: null });
        }

        let rows = table === 'chat_requests'
          ? [...chatRequests.values()]
          : [...messages];
        for (const filter of queryState.filters) {
          if (rows.some(row => Object.hasOwn(row, filter.column))) {
            rows = rows.filter(row => String(row[filter.column]) === String(filter.value));
          }
        }
        for (const filter of queryState.inFilters) {
          rows = rows.filter(row => filter.values.some(
            value => String(row[filter.column]) === String(value)
          ));
        }
        if (queryState.order && rows.every(row => row[queryState.order.column])) {
          const direction = queryState.order.options?.ascending ? 1 : -1;
          rows.sort((left, right) => direction * compareQueryValues(
            left[queryState.order.column],
            right[queryState.order.column]
          ));
        }
        if (queryState.limit !== null) rows = rows.slice(0, queryState.limit);
        return Promise.resolve({
          data: rows,
          error: table === 'chat_requests'
            ? options.diagnosticQueryError || null
            : options.historyError || options.testDbError || null
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
        in(column, values) {
          calls.push({ method: 'in', table, column, values });
          queryState.inFilters.push({ column, values });
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
          if (table === 'chat_requests') {
            if (typeof options.onDiagnosticInsert === 'function') {
              const result = options.onDiagnosticInsert(rows, chatRequests);
              if (result) return Promise.resolve(result);
            }
            if (options.diagnosticInsertError) {
              return Promise.resolve({ error: options.diagnosticInsertError });
            }
            chatRequests.set(String(rows.request_id), { ...rows });
            return Promise.resolve({ error: null });
          }
          if (Array.isArray(rows) && !options.insertError) {
            messages.push(...rows.map(row => ({ ...row })));
          }
          return Promise.resolve({ error: options.insertError || null });
        },
        upsert(rows, upsertOptions) {
          calls.push({ method: 'upsert', table, rows, options: upsertOptions });
          if (table !== 'chat_preferences') {
            return Promise.resolve({ error: new Error('unexpected upsert') });
          }
          if (options.preferenceUpsertError) {
            return Promise.resolve({ error: options.preferenceUpsertError });
          }
          chatPreferences.set(String(rows.user_id), { ...rows });
          return Promise.resolve({ error: null });
        }
      };
      return query;
    }
  };
}

async function startTestServer(options) {
  let requestSequence = 0;
  const app = createApp({
    ...options,
    randomUUID: options.randomUUID || (() => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    requestIdFactory: options.requestIdFactory || (() => {
      requestSequence += 1;
      return `bbbbbbbb-bbbb-4bbb-8bbb-${requestSequence.toString(16).padStart(12, '0')}`;
    }),
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

test('公开表安全 migration 启用 RLS 并只保留 service_role 数据权限', () => {
  const sql = fs.readFileSync(securityMigrationPath, 'utf8');
  const tables = ['sessions', 'messages', 'memories', 'settings'];

  for (const table of tables) {
    assert.match(sql, new RegExp(
      `alter table if exists public\\.${table} enable row level security`,
      'i'
    ));
    assert.match(sql, new RegExp(
      `revoke all privileges on table public\\.${table} from public, anon, authenticated`,
      'i'
    ));
    assert.match(sql, new RegExp(
      `grant select, insert, update, delete on table public\\.${table} to service_role`,
      'i'
    ));
  }

  assert.doesNotMatch(sql, /create\s+policy/i);
  assert.doesNotMatch(sql, /^\s*(insert\s+into|update|delete\s+from|truncate)\s+/im);
  assert.doesNotMatch(sql, /^\s*drop\s+(table|index|constraint)\s+/im);
});

test('聊天诊断 migration 安全创建服务端表并保留旧消息', () => {
  const sql = fs.readFileSync(chatRequestsMigrationPath, 'utf8');

  assert.match(sql, /add column request_id uuid null/i);
  assert.match(sql, /create table public\.chat_requests/i);
  assert.match(sql, /request_id uuid primary key/i);
  assert.match(sql, /session_id bigint null references public\.sessions\(id\)/i);
  assert.match(sql, /diagnostics jsonb not null/i);
  assert.match(sql, /alter table public\.chat_requests enable row level security/i);
  assert.match(
    sql,
    /revoke all privileges on table public\.chat_requests from public, anon, authenticated/i
  );
  assert.match(
    sql,
    /grant select, insert, update, delete on table public\.chat_requests to service_role/i
  );
  assert.doesNotMatch(sql, /create\s+policy/i);
  assert.doesNotMatch(sql, /^\s*(update|delete\s+from|truncate)\s+/im);
});

test('模型偏好 migration 只新增账号级安全表且不改写现有数据', () => {
  const sql = fs.readFileSync(chatPreferencesMigrationPath, 'utf8');

  assert.match(sql, /create table public\.chat_preferences/i);
  assert.match(sql, /user_id uuid primary key references auth\.users\(id\) on delete cascade/i);
  assert.match(sql, /model_alias text not null/i);
  assert.match(sql, /chat_preferences_model_alias_check/i);
  assert.match(sql, /\^cc-home-/i);
  assert.match(sql, /alter table public\.chat_preferences enable row level security/i);
  assert.match(
    sql,
    /revoke all privileges on table public\.chat_preferences from public, anon, authenticated/i
  );
  assert.match(
    sql,
    /grant select, insert, update, delete on table public\.chat_preferences to service_role/i
  );
  assert.doesNotMatch(sql, /create\s+policy/i);
  assert.doesNotMatch(sql, /^\s*(update|delete\s+from|truncate|insert\s+into)\s+/im);
});

test('账号模型接口只暴露允许且可用的公开别名，并跨请求保存选择', async () => {
  const supabase = createFakeSupabase();
  let gatewayCalls = 0;
  const server = await startTestServer({
    env: baseEnv,
    supabaseClient: supabase,
    gatewayFetch: async (url, options) => {
      gatewayCalls += 1;
      assert.equal(url, 'https://gateway.invalid/v1/models');
      assert.equal(options.method, 'GET');
      return response(200, {
        data: [
          { id: 'cc-home-default', provider_url: '不应返回' },
          { id: 'cc-home-claude-sonnet', upstream_model: '不应返回' },
          { id: 'not-allowed', api_key: '不应返回' }
        ]
      });
    }
  });

  try {
    const before = await request(server, '/chat/models');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, {
      models: [
        { id: 'cc-home-default', label: '默认模型' },
        { id: 'cc-home-claude-sonnet', label: 'Claude Sonnet' }
      ],
      selected_model: 'cc-home-default',
      default_model: 'cc-home-default'
    });
    assert.doesNotMatch(JSON.stringify(before.body), /provider_url|upstream_model|api_key|not-allowed/);

    const saved = await request(server, '/chat/preferences/model', {
      method: 'PUT',
      body: { model: 'cc-home-claude-sonnet' }
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { selected_model: 'cc-home-claude-sonnet' });
    const upsert = supabase.calls.find(call => call.method === 'upsert');
    assert.equal(upsert.options.onConflict, 'user_id');
    assert.equal(upsert.rows.user_id, baseEnv.CHAT_ALLOWED_USER_ID);
    assert.equal(upsert.rows.model_alias, 'cc-home-claude-sonnet');

    const after = await request(server, '/chat/models');
    assert.equal(after.body.selected_model, 'cc-home-claude-sonnet');
    assert.equal(gatewayCalls, 3);
  } finally {
    await closeServer(server);
  }
});

test('模型偏好接口拒绝任意配置、不可用别名和内部烟测凭证', async () => {
  const supabase = createFakeSupabase();
  const server = await startTestServer({
    env: baseEnv,
    supabaseClient: supabase,
    gatewayFetch: async () => response(200, {
      data: [{ id: 'cc-home-default' }, { id: 'cc-home-claude-sonnet' }]
    })
  });

  try {
    const unsafe = await request(server, '/chat/preferences/model', {
      method: 'PUT',
      body: { model: 'cc-home-claude-sonnet', api_key: 'browser-secret', base_url: 'https://evil.invalid' }
    });
    assert.equal(unsafe.status, 400);

    const unavailable = await request(server, '/chat/preferences/model', {
      method: 'PUT',
      body: { model: 'cc-home-claude-opus' }
    });
    assert.equal(unavailable.status, 400);
    assert.equal(supabase.calls.some(call => call.method === 'upsert'), false);

    const internal = await request(server, '/chat/models', {
      headers: { 'X-CC-Home-Internal-Token': baseEnv.CHAT_ACCESS_TOKEN }
    });
    assert.equal(internal.status, 403);
  } finally {
    await closeServer(server);
  }
});

test('模型偏好接口以安全响应处理 Gateway、配置和数据库失败', async t => {
  await t.test('Gateway 列表失败不泄露上游内容', async () => {
    const supabase = createFakeSupabase();
    const originalError = console.error;
    console.error = () => {};
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async () => response(500, { secret: 'gateway detail' })
    });
    try {
      const result = await request(server, '/chat/models');
      assert.equal(result.status, 502);
      assert.deepEqual(result.body, { error: '模型列表暂时不可用' });
      assert.doesNotMatch(JSON.stringify(result.body), /gateway detail|secret/);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });

  await t.test('偏好读取和保存失败均不泄露数据库详情', async () => {
    const originalError = console.error;
    console.error = () => {};
    const readServer = await startTestServer({
      env: baseEnv,
      supabaseClient: createFakeSupabase({ preferenceQueryError: new Error('private db detail') }),
      gatewayFetch: async () => response(200, { data: [{ id: 'cc-home-default' }] })
    });
    try {
      const result = await request(readServer, '/chat/models');
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: '模型偏好暂时不可用' });
      assert.doesNotMatch(JSON.stringify(result.body), /private db detail/);
    } finally {
      await closeServer(readServer);
    }

    const writeServer = await startTestServer({
      env: baseEnv,
      supabaseClient: createFakeSupabase({ preferenceUpsertError: new Error('private write detail') }),
      gatewayFetch: async () => response(200, {
        data: [{ id: 'cc-home-default' }, { id: 'cc-home-claude-sonnet' }]
      })
    });
    try {
      const result = await request(writeServer, '/chat/preferences/model', {
        method: 'PUT',
        body: { model: 'cc-home-claude-sonnet' }
      });
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: '模型偏好暂时不可用' });
      assert.doesNotMatch(JSON.stringify(result.body), /private write detail/);
    } finally {
      console.error = originalError;
      await closeServer(writeServer);
    }
  });

  await t.test('真实上游模型名不能作为公开默认值', async () => {
    const supabase = createFakeSupabase();
    const originalError = console.error;
    console.error = () => {};
    const server = await startTestServer({
      env: { ...baseEnv, OMBRE_GATEWAY_MODEL: 'anthropic/real-model' },
      supabaseClient: supabase,
      gatewayFetch: async () => response(200, { data: [] })
    });
    try {
      const result = await request(server, '/chat/models');
      assert.equal(result.status, 503);
      assert.equal(supabase.calls.length, 0);
    } finally {
      console.error = originalError;
      await closeServer(server);
    }
  });
});

test('/chat 从账号偏好选择公开模型，异常或失效偏好安全回退默认值', async t => {
  for (const scenario of [
    { name: '有效偏好', preference: 'cc-home-claude-sonnet', expected: 'cc-home-claude-sonnet' },
    { name: '已移除偏好', preference: 'cc-home-removed', expected: 'cc-home-default' },
    { name: '偏好读取失败', preferenceError: new Error('database detail'), expected: 'cc-home-default' }
  ]) {
    await t.test(scenario.name, async () => {
      const supabase = createFakeSupabase({
        chatPreferences: scenario.preference
          ? [{ user_id: baseEnv.CHAT_ALLOWED_USER_ID, model_alias: scenario.preference }]
          : [],
        preferenceQueryError: scenario.preferenceError
      });
      let sentModel;
      const originalError = console.error;
      console.error = () => {};
      const server = await startTestServer({
        env: baseEnv,
        supabaseClient: supabase,
        gatewayFetch: async (url, options) => {
          sentModel = JSON.parse(options.body).model;
          return response(200, { choices: [{ message: { content: 'ok' } }] });
        }
      });
      try {
        const result = await request(server, '/chat', {
          method: 'POST',
          body: { message: '测试选择' }
        });
        assertSuccessfulChatResponse(result, 'ok');
        assert.equal(sentModel, scenario.expected);
      } finally {
        console.error = originalError;
        await closeServer(server);
      }
    });
  }
});

test('/chat 不接受客户端模型、URL 或密钥字段且不会调用 Gateway', async () => {
  const supabase = createFakeSupabase();
  let gatewayCalls = 0;
  const server = await startTestServer({
    env: baseEnv,
    supabaseClient: supabase,
    gatewayFetch: async () => {
      gatewayCalls += 1;
      return response(200, { choices: [{ message: { content: '不应到达' } }] });
    }
  });

  try {
    for (const extra of [
      { model: 'cc-home-claude-sonnet' },
      { base_url: 'https://evil.invalid' },
      { api_key: 'browser-secret' }
    ]) {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '测试', ...extra }
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.error_code, 'unsupported_chat_fields');
    }
    assert.equal(gatewayCalls, 0);
  } finally {
    await closeServer(server);
  }
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
    assert.match(result.body.request_id, /^[0-9a-f-]{36}$/i);
    assert.equal(result.headers['x-request-id'], result.body.request_id);
    assert.equal(result.body.error_stage, 'authentication');
    assert.equal(result.body.error_code, 'authentication_failed');
    assert.equal(Object.hasOwn(result.body, 'diagnostics'), false);
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
    assertSuccessfulChatResponse(result, '鉴权通过');
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

  await t.test('同时间消息按 id 正序返回并过滤非法角色', async () => {
    const supabase = createFakeSupabase({
      existingSessions: [mainSession],
      // 故意打乱输入；mock 必须按查询指定的 id DESC 排序，再由接口恢复正序。
      history: [
        {
          id: '102',
          role: 'ai',
          content: '第一轮回答',
          created_at: '2026-08-09T01:00:00.000Z',
          session_id: supabaseSessionId,
          visible: true
        },
        {
          id: '105',
          role: 'system',
          content: '不应返回',
          created_at: '2026-08-09T03:00:00.000Z',
          internal_secret: '不应泄露',
          session_id: supabaseSessionId,
          visible: true
        },
        {
          id: '104',
          role: 'ai',
          content: '第二轮回答',
          created_at: '2026-08-09T02:00:00.000Z',
          session_id: supabaseSessionId,
          visible: true
        },
        {
          id: '101',
          role: 'user',
          content: '第一轮问题',
          created_at: '2026-08-09T01:00:00.000Z',
          session_id: supabaseSessionId,
          visible: true
        },
        {
          id: '103',
          role: 'user',
          content: '第二轮问题',
          created_at: '2026-08-09T02:00:00.000Z',
          session_id: supabaseSessionId,
          visible: true
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
            content: '第一轮问题',
            createdAt: '2026-08-09T01:00:00.000Z'
          },
          {
            role: 'assistant',
            content: '第一轮回答',
            createdAt: '2026-08-09T01:00:00.000Z'
          },
          {
            role: 'user',
            content: '第二轮问题',
            createdAt: '2026-08-09T02:00:00.000Z'
          },
          {
            role: 'assistant',
            content: '第二轮回答',
            createdAt: '2026-08-09T02:00:00.000Z'
          }
        ]
      });
      assert.equal(JSON.stringify(result.body).includes('internal_secret'), false);
      assert.equal(JSON.stringify(result.body).includes(supabaseSessionId), false);

      const selectCall = supabase.calls.find(
        call => call.method === 'select' && call.table === 'messages'
      );
      assert.equal(selectCall.columns, 'role, content, created_at, request_id');
      const sessionQuery = supabase.calls.find(
        call => call.method === 'eq' && call.column === 'session_id'
      );
      assert.equal(sessionQuery.value, supabaseSessionId);
      const visibleQuery = supabase.calls.find(
        call => call.method === 'eq' && call.column === 'visible'
      );
      assert.equal(visibleQuery.value, true);
      const orderCall = supabase.calls.find(call => call.method === 'order');
      assert.equal(orderCall.column, 'id');
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

test('Gateway 历史在相同 created_at 下按 id 保持多轮正序', async () => {
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
    // 两轮 user/assistant 的 created_at 各自完全相同，并故意打乱输入。
    history: [
      {
        id: '204',
        role: 'ai',
        content: '第二轮回答',
        created_at: '2026-08-09T02:00:00.000Z'
      },
      {
        id: '201',
        role: 'user',
        content: '第一轮问题',
        created_at: '2026-08-09T01:00:00.000Z'
      },
      {
        id: '205',
        role: 'system',
        content: '不应传给 Gateway',
        created_at: '2026-08-09T03:00:00.000Z'
      },
      {
        id: '203',
        role: 'user',
        content: '第二轮问题',
        created_at: '2026-08-09T02:00:00.000Z'
      },
      {
        id: '202',
        role: 'ai',
        content: '第一轮回答',
        created_at: '2026-08-09T01:00:00.000Z'
      }
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

    assertSuccessfulChatResponse(first, '模拟回复');
    assertSuccessfulChatResponse(second, '模拟回复');
    assert.equal(gatewayCalls.length, 2);
    assert.equal(gatewayCalls[0].url, 'https://gateway.invalid/v1/chat/completions');
    assert.equal(gatewayCalls[0].options.headers.Authorization, 'Bearer gateway-test-token');
    assert.equal(gatewayCalls[0].options.headers['X-Ombre-Session-Id'], conversationId);
    assert.equal(gatewayCalls[1].options.headers['X-Ombre-Session-Id'], conversationId);
    assert.equal(gatewayCalls[0].payload.stream, false);
    assert.equal(gatewayCalls[0].payload.model, 'cc-home-default');
    assert.equal(gatewayCalls[0].payload.request_id, first.body.request_id);
    assert.equal(gatewayCalls[1].payload.request_id, second.body.request_id);
    assert.deepEqual(gatewayCalls[0].payload.messages, [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮问题' },
      { role: 'assistant', content: '第二轮回答' },
      { role: 'user', content: '第一轮' }
    ]);

    const orderCalls = supabase.calls.filter(call => call.method === 'order');
    assert.equal(orderCalls.every(call => call.column === 'id'), true);
    assert.equal(orderCalls.every(
      call => JSON.stringify(call.options) === JSON.stringify({ ascending: false })
    ), true);
    const limitCalls = supabase.calls.filter(call => call.method === 'limit');
    assert.equal(limitCalls.every(call => call.value === 20), true);
    const sessionQueries = supabase.calls.filter(
      call => call.method === 'eq' && call.column === 'session_id'
    );
    assert.deepEqual(sessionQueries.map(call => call.value), [
      supabaseSessionId,
      supabaseSessionId
    ]);
    const messageInserts = supabase.inserts.filter(rows => Array.isArray(rows));
    assert.equal(messageInserts.length, 2);
    assert.deepEqual(messageInserts[0], [
      { session_id: supabaseSessionId, role: 'user', content: '第一轮' },
      {
        session_id: supabaseSessionId,
        role: 'ai',
        content: '模拟回复',
        request_id: first.body.request_id
      }
    ]);
    assert.equal(supabase.calls.some(call => call.table === 'settings'), false);
    assert.equal(gatewayCalls.some(call => call.url.includes('/mcp')), false);
  } finally {
    await closeServer(server);
  }
});

test('Gateway 只读取 id 最大的最近 20 条历史', async () => {
  const conversationId = '550e8400-e29b-41d4-a716-446655440020';
  const supabaseSessionId = toSupabaseSessionId(conversationId);
  const history = Array.from({ length: 25 }, (_, index) => ({
    id: String(index + 1),
    role: index % 2 === 0 ? 'user' : 'ai',
    content: `历史消息 ${index + 1}`,
    created_at: '2026-08-09T01:00:00.000Z'
  })).reverse();
  const supabase = createFakeSupabase({
    existingSessions: [{
      id: supabaseSessionId,
      name: '主聊天',
      user_id: baseEnv.CHAT_ALLOWED_USER_ID,
      session_kind: 'main',
      conversation_id: conversationId
    }],
    history
  });
  let gatewayPayload;
  const server = await startTestServer({
    env: baseEnv,
    supabaseClient: supabase,
    gatewayFetch: async (url, options) => {
      gatewayPayload = JSON.parse(options.body);
      return response(200, {
        choices: [{ message: { role: 'assistant', content: '模拟回复' } }]
      });
    }
  });

  try {
    const result = await request(server, '/chat', {
      method: 'POST',
      body: { message: '当前消息' }
    });

    assert.equal(result.status, 200);
    assert.equal(gatewayPayload.messages.length, 21);
    assert.deepEqual(
      gatewayPayload.messages.slice(0, 20).map(message => message.content),
      Array.from({ length: 20 }, (_, index) => `历史消息 ${index + 6}`)
    );
    assert.deepEqual(gatewayPayload.messages[20], {
      role: 'user',
      content: '当前消息'
    });

    const orderCall = supabase.calls.find(call => call.method === 'order');
    assert.equal(orderCall.column, 'id');
    assert.deepEqual(orderCall.options, { ascending: false });
    const limitCall = supabase.calls.find(call => call.method === 'limit');
    assert.equal(limitCall.value, 20);
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
        {
          session_id: supabaseSessionId,
          role: 'ai',
          content: '已回复',
          request_id: result.body.request_id
        }
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
      assert.equal(supabase.inserts.filter(rows => Array.isArray(rows)).length, 1);
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
    assertSuccessfulChatResponse(result, '仍然回复');
    assert.equal(errors.some(args => args[0] === '加载历史消息失败'), true);
    assert.equal(errors.some(args => args[0] === '保存消息失败'), true);
    assert.equal(JSON.stringify(errors).includes('继续聊天'), false);
    assert.equal(JSON.stringify(errors).includes('chat-test-token'), false);
  } finally {
    console.error = originalError;
    await closeServer(server);
  }
});

test('/chat 诊断只保存 Gateway 实际 usage 并记录各阶段', async t => {
  const conversationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const sessionId = toSupabaseSessionId(conversationId);
  const existingSession = {
    id: sessionId,
    name: '主聊天',
    user_id: baseEnv.CHAT_ALLOWED_USER_ID,
    session_kind: 'main',
    conversation_id: conversationId
  };

  await t.test('保存白名单 usage、request_id、状态和耗时', async () => {
    const requestId = '22222222-2222-4222-8222-222222222222';
    const supabase = createFakeSupabase({ existingSessions: [existingSession] });
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      requestIdFactory: () => requestId,
      gatewayFetch: async (url, options) => {
        const payload = JSON.parse(options.body);
        return response(200, {
          request_id: payload.request_id,
          choices: [{ message: { content: '带诊断的回复' } }],
          diagnostics: {
            gateway_round: 12,
            recent_context_injected: true,
            memory: {
              recalled_count: 2,
              diffused_count: 1,
              injected_count: 3,
              memory_text: '不应保存'
            },
            usage: {
              input_tokens: 321,
              output_tokens: 45,
              total_tokens: 366,
              cached_tokens: 123,
              prompt_cache_hit_tokens: 124,
              prompt_cache_miss_tokens: 197,
              cache_read_input_tokens: 120,
              cache_creation_input_tokens: 3,
              upstream_secret: '不应保存'
            },
            prompt: '不应保存'
          },
          usage: { prompt_tokens: 999999 }
        });
      }
    });

    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        headers: { Authorization: 'Bearer sensitive-user-jwt' },
        body: { message: '不应进入诊断的消息正文' }
      });

      assertSuccessfulChatResponse(result, '带诊断的回复');
      assert.equal(result.body.request_id, requestId);
      assert.deepEqual(result.body.diagnostics.usage, {
        input_tokens: 321,
        output_tokens: 45,
        total_tokens: 366,
        cached_tokens: 123,
        prompt_cache_hit_tokens: 124,
        prompt_cache_miss_tokens: 197,
        cache_read_input_tokens: 120,
        cache_creation_input_tokens: 3
      });
      assert.deepEqual(result.body.diagnostics.gateway, {
        round: 12,
        recent_context_injected: true,
        recalled_count: 2,
        diffused_count: 1,
        injected_count: 3,
        error_stage: null,
        error_code: null
      });
      for (const stage of Object.values(result.body.diagnostics.stages)) {
        assert.equal(stage.status, 'success');
        assert.equal(typeof stage.duration_ms, 'number');
        assert.equal(stage.duration_ms >= 0, true);
      }

      const stored = supabase.chatRequests.get(requestId);
      assert.equal(stored.session_id, sessionId);
      assert.equal(stored.status, 'success');
      assert.equal(stored.error_stage, null);
      assert.deepEqual(stored.diagnostics, result.body.diagnostics);
      const serialized = JSON.stringify(stored);
      assert.equal(serialized.includes('sensitive-user-jwt'), false);
      assert.equal(serialized.includes('不应进入诊断的消息正文'), false);
      assert.equal(serialized.includes('不应保存'), false);

      const savedMessages = supabase.inserts.find(rows => Array.isArray(rows));
      assert.equal(savedMessages[0].request_id, undefined);
      assert.equal(savedMessages[1].request_id, requestId);
      assert.equal(supabase.calls.filter(
        call => call.method === 'insert' && call.table === 'chat_requests'
      ).length, 1);
      assert.equal(supabase.calls.filter(
        call => call.method === 'insert' && call.table === 'messages'
      ).length, 1);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('缺失和无效 usage 保持 null，不根据已有字段补算', async () => {
    const supabase = createFakeSupabase({ existingSessions: [existingSession] });
    const server = await startTestServer({
      env: baseEnv,
      supabaseClient: supabase,
      gatewayFetch: async (url, options) => {
        const payload = JSON.parse(options.body);
        return response(200, {
          request_id: payload.request_id,
          choices: [{ message: { content: '部分 usage' } }],
          diagnostics: {
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: '15',
              cached_tokens: '4',
              cache_read_input_tokens: -1
            }
          }
        });
      }
    });

    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: 'usage 不补算' }
      });
      assert.equal(result.body.diagnostics.usage.input_tokens, 10);
      assert.equal(result.body.diagnostics.usage.output_tokens, 5);
      assert.equal(result.body.diagnostics.usage.total_tokens, null);
      assert.equal(result.body.diagnostics.usage.cached_tokens, null);
      assert.equal(result.body.diagnostics.usage.cache_read_input_tokens, null);
      assert.equal(result.body.diagnostics.usage.cache_creation_input_tokens, null);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('Gateway request_id 缺失或不匹配时诊断保持 null 且回复成功', async t2 => {
    for (const mode of ['missing', 'mismatch']) {
      await t2.test(mode, async () => {
        const supabase = createFakeSupabase({ existingSessions: [existingSession] });
        let gatewayCalls = 0;
        let sentRequestId;
        const server = await startTestServer({
          env: baseEnv,
          supabaseClient: supabase,
          gatewayFetch: async (url, options) => {
            gatewayCalls += 1;
            const payload = JSON.parse(options.body);
            sentRequestId = payload.request_id;
            return response(200, {
              ...(mode === 'mismatch'
                ? { request_id: '99999999-9999-4999-8999-999999999999' }
                : {}),
              choices: [{ message: { content: `${mode} 仍然回复` } }],
              diagnostics: {
                gateway_round: 999,
                recent_context_injected: true,
                memory: {
                  recalled_count: 9,
                  diffused_count: 9,
                  injected_count: 9
                },
                usage: {
                  input_tokens: 999,
                  output_tokens: 999,
                  total_tokens: 1998,
                  cached_tokens: 999
                }
              }
            });
          }
        });

        try {
          const result = await request(server, '/chat', {
            method: 'POST',
            body: { message: `${mode} request id` }
          });
          assertSuccessfulChatResponse(result, `${mode} 仍然回复`);
          assert.equal(sentRequestId, result.body.request_id);
          assert.equal(gatewayCalls, 1);
          assert.deepEqual(result.body.diagnostics.gateway, {
            round: null,
            recent_context_injected: null,
            recalled_count: null,
            diffused_count: null,
            injected_count: null,
            error_stage: null,
            error_code: null
          });
          assert.deepEqual(result.body.diagnostics.usage, {
            input_tokens: null,
            output_tokens: null,
            total_tokens: null,
            cached_tokens: null,
            prompt_cache_hit_tokens: null,
            prompt_cache_miss_tokens: null,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null
          });
          assert.equal(supabase.calls.filter(
            call => call.method === 'insert' && call.table === 'chat_requests'
          ).length, 1);
          assert.equal(supabase.calls.filter(
            call => call.method === 'insert' && call.table === 'messages'
          ).length, 1);
        } finally {
          await closeServer(server);
        }
      });
    }
  });
});

test('聊天诊断保存失败不影响回复或消息保存', async () => {
  const conversationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const sessionId = toSupabaseSessionId(conversationId);
  const sensitiveError = 'database secret gateway-test-token';
  const supabase = createFakeSupabase({
    existingSessions: [{
      id: sessionId,
      name: '主聊天',
      user_id: baseEnv.CHAT_ALLOWED_USER_ID,
      session_kind: 'main',
      conversation_id: conversationId
    }],
    diagnosticInsertError: new Error(sensitiveError)
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  const server = await startTestServer({
    env: baseEnv,
    supabaseClient: supabase,
    gatewayFetch: async () => response(200, {
      choices: [{ message: { content: '回复仍成功' } }]
    })
  });

  try {
    const result = await request(server, '/chat', {
      method: 'POST',
      body: { message: '消息仍保存' }
    });
    assertSuccessfulChatResponse(result, '回复仍成功');
    assert.equal(supabase.inserts.some(rows => Array.isArray(rows)), true);
    assert.equal(supabase.chatRequests.size, 0);
    assert.equal(errors.some(args => args[0] === '保存聊天诊断失败'), true);
    assert.equal(JSON.stringify(errors).includes(sensitiveError), false);
  } finally {
    console.error = originalError;
    await closeServer(server);
  }
});

test('/chat/history 为成功 assistant 附加脱敏诊断并兼容旧消息', async () => {
  const conversationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const sessionId = toSupabaseSessionId(conversationId);
  const requestId = '33333333-3333-4333-8333-333333333333';
  const diagnostics = diagnosticFixture({ secret: '不应返回' });
  diagnostics.stages.gateway.prompt = '不应返回';
  diagnostics.usage.provider_detail = '不应返回';
  const supabase = createFakeSupabase({
    existingSessions: [{
      id: sessionId,
      name: '主聊天',
      user_id: baseEnv.CHAT_ALLOWED_USER_ID,
      session_kind: 'main',
      conversation_id: conversationId
    }],
    history: [
      {
        id: '3',
        session_id: sessionId,
        role: 'ai',
        content: '带详情回复',
        created_at: '2026-08-15T02:00:00.000Z',
        visible: true,
        request_id: requestId
      },
      {
        id: '2',
        session_id: sessionId,
        role: 'ai',
        content: '旧回复',
        created_at: '2026-08-15T01:00:01.000Z',
        visible: true,
        request_id: null
      },
      {
        id: '1',
        session_id: sessionId,
        role: 'user',
        content: '旧问题',
        created_at: '2026-08-15T01:00:00.000Z',
        visible: true,
        request_id: null
      }
    ],
    chatRequests: [{
      request_id: requestId,
      session_id: sessionId,
      status: 'success',
      diagnostics
    }]
  });
  const server = await startTestServer({
    env: baseEnv,
    supabaseClient: supabase,
    gatewayFetch: async () => response(200, {})
  });

  try {
    const result = await request(server, '/chat/history');
    assert.equal(result.status, 200);
    assert.equal(result.body.messages.length, 3);
    assert.equal(Object.hasOwn(result.body.messages[1], 'diagnostics'), false);
    assert.equal(result.body.messages[2].request_id, requestId);
    assert.deepEqual(result.body.messages[2].diagnostics, diagnosticFixture());
    assert.equal(JSON.stringify(result.body).includes('不应返回'), false);

    const diagnosticQuery = supabase.calls.find(
      call => call.method === 'in' && call.table === 'chat_requests'
    );
    assert.deepEqual(diagnosticQuery.values, [requestId]);
    assert.equal(supabase.calls.some(
      call => call.method === 'eq'
        && call.table === 'chat_requests'
        && call.column === 'session_id'
        && call.value === sessionId
    ), true);
  } finally {
    await closeServer(server);
  }
});

test('/chat/history 为旧诊断补充 null Gateway 字段', async () => {
  const conversationId = 'acacacac-acac-4cac-8cac-acacacacacac';
  const sessionId = toSupabaseSessionId(conversationId);
  const requestId = '45454545-4545-4545-8545-454545454545';
  const oldDiagnostics = diagnosticFixture();
  delete oldDiagnostics.gateway;
  const supabase = createFakeSupabase({
    existingSessions: [{
      id: sessionId,
      name: '主聊天',
      user_id: baseEnv.CHAT_ALLOWED_USER_ID,
      session_kind: 'main',
      conversation_id: conversationId
    }],
    history: [{
      id: '1',
      session_id: sessionId,
      role: 'ai',
      content: '旧诊断回复',
      created_at: '2026-08-15T02:30:00.000Z',
      visible: true,
      request_id: requestId
    }],
    chatRequests: [{
      request_id: requestId,
      session_id: sessionId,
      status: 'success',
      diagnostics: oldDiagnostics
    }]
  });
  const server = await startTestServer({
    env: baseEnv,
    supabaseClient: supabase,
    gatewayFetch: async () => response(200, {})
  });

  try {
    const result = await request(server, '/chat/history');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.messages[0].diagnostics, diagnosticFixture({
      gateway: {
        round: null,
        recent_context_injected: null,
        recalled_count: null,
        diffused_count: null,
        injected_count: null,
        error_stage: null,
        error_code: null
      }
    }));
  } finally {
    await closeServer(server);
  }
});

test('/chat/history 诊断查询失败时仍返回消息正文', async () => {
  const conversationId = 'abababab-abab-4bab-8bab-abababababab';
  const sessionId = toSupabaseSessionId(conversationId);
  const requestId = '44444444-4444-4444-8444-444444444444';
  const sensitiveError = 'diagnostic secret gateway-test-token';
  const supabase = createFakeSupabase({
    existingSessions: [{
      id: sessionId,
      name: '主聊天',
      user_id: baseEnv.CHAT_ALLOWED_USER_ID,
      session_kind: 'main',
      conversation_id: conversationId
    }],
    history: [{
      id: '1',
      session_id: sessionId,
      role: 'ai',
      content: '历史回复仍可读',
      created_at: '2026-08-15T03:00:00.000Z',
      visible: true,
      request_id: requestId
    }],
    diagnosticQueryError: new Error(sensitiveError)
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
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      messages: [{
        role: 'assistant',
        content: '历史回复仍可读',
        createdAt: '2026-08-15T03:00:00.000Z'
      }]
    });
    assert.deepEqual(errors, [['加载聊天诊断失败']]);
    assert.equal(JSON.stringify(errors).includes(sensitiveError), false);
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
      gatewayFetch: async (url, options) => {
        const payload = JSON.parse(options.body);
        return response(401, {
          request_id: payload.request_id,
          error_stage: 'upstream',
          error_code: 'upstream_error',
          secret: '不应泄露',
          prompt: '不应泄露'
        });
      }
    });
    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        body: { message: '测试' }
      });
      assert.equal(result.status, 502);
      assert.match(result.body.request_id, /^[0-9a-f-]{36}$/i);
      assert.equal(result.body.error_stage, 'gateway');
      assert.equal(result.body.error_code, 'gateway_unavailable');
      assert.equal(Object.hasOwn(result.body, 'diagnostics'), false);
      assert.equal(JSON.stringify(result.body).includes('不应泄露'), false);
      assert.equal(supabase.inserts.some(rows => Array.isArray(rows)), false);
      const diagnostic = supabase.chatRequests.get(result.body.request_id);
      assert.equal(diagnostic.status, 'error');
      assert.equal(diagnostic.error_stage, 'gateway');
      assert.equal(diagnostic.error_code, 'gateway_unavailable');
      assert.deepEqual(diagnostic.diagnostics.gateway, {
        round: null,
        recent_context_injected: null,
        recalled_count: null,
        diffused_count: null,
        injected_count: null,
        error_stage: 'upstream',
        error_code: 'upstream_error'
      });
      assert.equal(JSON.stringify(diagnostic).includes('不应泄露'), false);
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
