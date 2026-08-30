// Vercel Serverless Handler
// 所有请求经由 vercel.json rewrite 到 /api/index，这里统一复用 server.js 导出的 handleRequest
const { handleRequest } = require('../server.js');

module.exports = async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('vercel handler error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: false, message: err.message || 'Server Error' }));
    }
  }
};
