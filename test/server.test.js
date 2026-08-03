const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

const { createApp } = require('../server');

const baseEnv = {
  NODE_ENV: 'production',
  FRONTEND_ORIGIN: 'https://cc-home.example',
  ADMIN_TOKEN: 'admin-test-token',
  CHAT_ACCESS_TOKEN: 'chat-test-token',
  OMBRE_GATEWAY_BASE_URL: 'https://gateway.invalid/v1',
  OMBRE_GATEWAY_TOKEN: 'gateway-test-token',
  OMBRE_GATEWAY_MODEL: 'test-model',
  OMBRE_GATEWAY_TIMEOUT_MS: '1000',
  CC_HOME_DEFAULT_SESSION_ID: 'cc-home-main',
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

  return {
    calls,
    inserts,
    from(table) {
      calls.push({ method: 'from', table });
      const query = {
        select(columns, selectOptions) {
          calls.push({ method: 'select', table, columns, options: selectOptions });
          return query;
        },
        eq(column, value) {
          calls.push({ method: 'eq', table, column, value });
          return query;
        },
        order(column, orderOptions) {
          calls.push({ method: 'order', table, column, options: orderOptions });
          return query;
        },
        limit(value) {
          calls.push({ method: 'limit', table, value });
          return Promise.resolve({
            data: options.history || [],
            error: options.historyError || options.testDbError || null
          });
        },
        insert(rows) {
          calls.push({ method: 'insert', table });
          inserts.push(rows);
          return Promise.resolve({ error: options.insertError || null });
        }
      };
      return query;
    }
  };
}

async function startTestServer(options) {
  const app = createApp(options);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function request(server, path, options = {}) {
  const address = server.address();
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = { ...(options.headers || {}) };
  if (path === '/chat' && options.chatAccess !== false && !headers.Authorization) {
    headers.Authorization = 'Bearer chat-test-token';
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

test('生产环境 /chat 使用独立 CHAT_ACCESS_TOKEN', async t => {
  async function runChat(headers, chatAccess, env = baseEnv) {
    const supabase = createFakeSupabase();
    let gatewayCalls = 0;
    const server = await startTestServer({
      env,
      supabaseClient: supabase,
      gatewayFetch: async () => {
        gatewayCalls += 1;
        return response(200, { choices: [{ message: { content: '鉴权通过' } }] });
      }
    });

    try {
      const result = await request(server, '/chat', {
        method: 'POST',
        headers,
        chatAccess,
        body: { message: '测试聊天鉴权', sessionId: 'auth-session' }
      });
      return { result, gatewayCalls, supabase };
    } finally {
      await closeServer(server);
    }
  }

  await t.test('缺失 token 返回 401', async () => {
    const { result, gatewayCalls, supabase } = await runChat(undefined, false);
    assert.equal(result.status, 401);
    assert.equal(gatewayCalls, 0);
    assert.equal(supabase.calls.length, 0);
    assert.equal(JSON.stringify(result.body).includes('chat-test-token'), false);
  });

  await t.test('服务端未配置 token 返回 503', async () => {
    const env = { ...baseEnv };
    delete env.CHAT_ACCESS_TOKEN;
    const originalError = console.error;
    console.error = () => {};
    try {
      const { result, gatewayCalls, supabase } = await runChat(undefined, false, env);
      assert.equal(result.status, 503);
      assert.equal(gatewayCalls, 0);
      assert.equal(supabase.calls.length, 0);
    } finally {
      console.error = originalError;
    }
  });

  await t.test('错误 token（包括 ADMIN_TOKEN）返回 401', async () => {
    const { result, gatewayCalls, supabase } = await runChat({
      Authorization: 'Bearer admin-test-token'
    });
    assert.equal(result.status, 401);
    assert.equal(gatewayCalls, 0);
    assert.equal(supabase.calls.length, 0);
    assert.equal(JSON.stringify(result.body).includes('admin-test-token'), false);
  });

  await t.test('正确 token 允许聊天', async () => {
    const { result, gatewayCalls, supabase } = await runChat({
      Authorization: 'Bearer chat-test-token'
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { reply: '鉴权通过' });
    assert.equal(gatewayCalls, 1);
    assert.equal(supabase.inserts.length, 1);
  });
});

test('稳定传递 session，读取最近历史并把 ai 转为 assistant', async () => {
  const supabase = createFakeSupabase({
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
      body: { message: '第一轮', sessionId: 'session-123' }
    });
    const second = await request(server, '/chat', {
      method: 'POST',
      body: { message: '第二轮', sessionId: 'session-123' }
    });

    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { reply: '模拟回复' });
    assert.equal(second.status, 200);
    assert.equal(gatewayCalls.length, 2);
    assert.equal(gatewayCalls[0].url, 'https://gateway.invalid/v1/chat/completions');
    assert.equal(gatewayCalls[0].options.headers.Authorization, 'Bearer gateway-test-token');
    assert.equal(gatewayCalls[0].options.headers['X-Ombre-Session-Id'], 'session-123');
    assert.equal(gatewayCalls[1].options.headers['X-Ombre-Session-Id'], 'session-123');
    assert.equal(gatewayCalls[0].payload.stream, false);
    assert.equal(gatewayCalls[0].payload.model, 'test-model');
    assert.deepEqual(gatewayCalls[0].payload.messages, [
      { role: 'user', content: '较早的用户消息' },
      { role: 'assistant', content: '较新的 AI 回复' },
      { role: 'user', content: '第一轮' }
    ]);

    const orderCall = supabase.calls.find(call => call.method === 'order');
    assert.deepEqual(orderCall.options, { ascending: false });
    assert.equal(supabase.inserts.length, 2);
    assert.deepEqual(supabase.inserts[0], [
      { session_id: 'session-123', role: 'user', content: '第一轮' },
      { session_id: 'session-123', role: 'ai', content: '模拟回复' }
    ]);
    assert.equal(supabase.calls.some(call => call.table === 'settings'), false);
    assert.equal(gatewayCalls.some(call => call.url.includes('/mcp')), false);
  } finally {
    await closeServer(server);
  }
});

test('缺少 sessionId 时始终使用稳定后备值', async () => {
  const supabase = createFakeSupabase();
  const sessions = [];
  const gatewayFetch = async (url, options) => {
    sessions.push(options.headers['X-Ombre-Session-Id']);
    return response(200, { choices: [{ message: { content: 'ok' } }] });
  };
  const server = await startTestServer({ env: baseEnv, supabaseClient: supabase, gatewayFetch });

  try {
    await request(server, '/chat', { method: 'POST', body: { message: '一' } });
    await request(server, '/chat', { method: 'POST', body: { message: '二' } });
    assert.deepEqual(sessions, ['cc-home-main', 'cc-home-main']);
    assert.equal(supabase.inserts[0][0].session_id, 'cc-home-main');
    assert.equal(supabase.inserts[1][0].session_id, 'cc-home-main');
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
      body: { message: '继续聊天', sessionId: 'history-error' }
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { reply: '仍然回复' });
    assert.equal(errors.some(args => args[0] === '加载历史消息失败:'), true);
    assert.equal(errors.some(args => args[0] === '保存消息失败:'), true);
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
        body: { message: '测试', sessionId: 'gateway-401' }
      });
      assert.equal(result.status, 502);
      assert.equal(JSON.stringify(result.body).includes('不应泄露'), false);
      assert.equal(supabase.inserts.length, 0);
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
        body: { message: '测试', sessionId: 'bad-response' }
      });
      assert.equal(result.status, 502);
      assert.equal(supabase.inserts.length, 0);
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
        body: { message: '测试超时', sessionId: 'timeout' }
      });
      assert.equal(result.status, 504);
      assert.equal(supabase.inserts.length, 0);
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
        body: { message: '测试配置', sessionId: 'config-error' }
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
        body: { message: '测试模型配置', sessionId: 'model-error' }
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
