const express = require('express');
const path = require('path');
const { Bot } = require('grammy');
const Store = require('./store');

module.exports = function (options) {
  const manager = options.manager;
  const port = options.port || 20000;
  const password = options.password;
  const apiRoot = options.apiRoot;

  const app = express();
  app.use(express.json());

  const tokens = new Set();

  function auth(req, res, next) {
    const t = req.headers['x-token'];
    if (t && tokens.has(t)) return next();
    res.status(401).json({ error: 'unauthorized' });
  }

  app.post('/api/login', (req, res) => {
    if (req.body && req.body.password === password) {
      const t = Math.random().toString(36).slice(2) + Date.now().toString(36);
      tokens.add(t);
      res.json({ token: t });
    } else {
      res.status(401).json({ error: '密码错误' });
    }
  });

  app.get('/api/stats', auth, (req, res) => {
    const mem = process.memoryUsage();
    res.json({
      running: manager.instances.size,
      sleeping: manager.sleeping.size,
      total: Store.listBots().length,
      banned: Store.getBanlist().length,
      memoryMB: (mem.rss / 1024 / 1024).toFixed(1)
    });
  });

  app.get('/api/bots', auth, (req, res) => {
    const bots = Store.listBots().map(b => ({
      bot_id: b.bot_id,
      username: b.username,
      owner_id: b.owner_id,
      created_at: b.created_at,
      running: manager.instances.has(b.bot_id),
      userCount: Store.getUsersForBot(b.bot_id).length
    }));
    res.json(bots);
  });

  app.get('/api/bots/:botId/users', auth, (req, res) => {
    res.json(Store.getConversations(req.params.botId));
  });

  app.get('/api/bots/:botId/users/:userId/messages', auth, (req, res) => {
    res.json(Store.getMessages(req.params.botId, req.params.userId));
  });

  app.post('/api/bots/:botId/users/:userId/send', auth, async (req, res) => {
    const text = req.body && req.body.text;
    if (!text) return res.status(400).json({ error: '消息不能为空' });
    const botData = Store.listBots().find(b => b.bot_id === req.params.botId);
    if (!botData) return res.status(404).json({ error: 'Bot 不存在' });
    try {
      const inst = manager.instances.get(botData.bot_id);
      if (inst) {
        await inst.bot.api.sendMessage(req.params.userId, text);
      } else {
        const tmpBot = new Bot(botData.token, { client: { apiRoot: apiRoot } });
        await tmpBot.api.sendMessage(req.params.userId, text);
      }
      Store.addMessage(botData.bot_id, req.params.userId, {
        from: 'admin', name: '', text: text, time: Date.now()
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/banlist', auth, (req, res) => {
    res.json(Store.getBanlist());
  });

  app.post('/api/ban', auth, (req, res) => {
    const userId = req.body && req.body.userId;
    if (!userId) return res.status(400).json({ error: '缺少 userId' });
    Store.addToBanlist(userId);
    res.json({ ok: true });
  });

  app.post('/api/unban', auth, (req, res) => {
    const userId = req.body && req.body.userId;
    if (!userId) return res.status(400).json({ error: '缺少 userId' });
    Store.removeFromBanlist(userId);
    res.json({ ok: true });
  });

  app.post('/api/broadcast', auth, async (req, res) => {
    const message = req.body && req.body.message;
    if (!message) return res.status(400).json({ error: '消息不能为空' });
    const bots = Store.listBots();
    let totalSuccess = 0, totalFailed = 0, totalSkipped = 0;
    const banlist = Store.getBanlist();
    for (const botData of bots) {
      const users = Store.getUsersForBot(botData.bot_id);
      const settings = Store.getBotSettings(botData.bot_id);
      const filtered = users.filter(uid => {
        if (settings.useGlobalBan && banlist.indexOf(uid) !== -1) { totalSkipped++; return false; }
        return true;
      });
      if (filtered.length === 0) continue;
      try {
        const result = await manager.broadcastToUsers(botData.token, filtered, message);
        totalSuccess += result.success;
        totalFailed += result.failed;
      } catch (e) {
        totalFailed += filtered.length;
      }
    }
    res.json({ success: totalSuccess, failed: totalFailed, skipped: totalSkipped });
  });

  // 托管 public 目录下的静态文件（index.html）
  app.use(express.static(path.join(__dirname, 'public')));

  app.listen(port, () => {
    console.log(`🌐 Web 管理后台已启动: http://0.0.0.0:${port}`);
  });
};
