require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// 初始化 Supabase 客户端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 健康检查接口（验证后端是否部署成功）
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'cc-home 后端运行中' });
});

// 测试数据库连接接口
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*');
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 启动服务器
app.listen(port, () => {
  console.log(`✅ 后端服务已启动，端口: ${port}`);
});