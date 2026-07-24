const express = require('express');
const { Bot } = require('grammy');
const Store = require('./store');

module.exports = function (options) {
  const manager = options.manager;
  const port = options.port || 3000;
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

  app.get('/', (req, res) => {
    res.type('html').send(HTML_PAGE);
  });

  app.listen(port, () => {
    console.log(`🌐 Web 管理后台已启动: http://0.0.0.0:${port}`);
  });
};

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TGBOT 管理后台</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f172a;color:#e2e8f0;height:100vh;overflow:hidden}
.login-wrap{height:100vh;display:flex;align-items:center;justify-content:center}
.login-card{background:#1e293b;padding:40px;border-radius:12px;width:320px;text-align:center}
.login-card h1{font-size:20px;margin-bottom:24px}
.login-card input{width:100%;padding:12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;margin-bottom:16px;font-size:14px}
.login-card button{width:100%;padding:12px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-size:15px;cursor:pointer}
.login-card button:hover{background:#2563eb}
#loginErr{color:#f87171;margin-top:12px;font-size:13px}
.main-wrap{height:100vh;display:flex;flex-direction:column}
header{background:#1e293b;padding:10px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.brand{font-weight:bold;font-size:15px}
.stats{display:flex;gap:14px;font-size:12px;color:#94a3b8;flex:1}
.actions button{padding:6px 12px;border:1px solid #334155;border-radius:6px;background:transparent;color:#e2e8f0;cursor:pointer;font-size:12px;margin-left:6px}
.actions button:hover{background:#334155}
.layout{flex:1;display:flex;overflow:hidden}
.col-bots{width:200px;background:#1e293b;overflow-y:auto;border-right:1px solid #0f172a}
.col-users{width:230px;background:#162032;overflow-y:auto;border-right:1px solid #0f172a}
.col-title{padding:12px;font-size:12px;color:#64748b;border-bottom:1px solid #0f172a}
.item{padding:10px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px}
.item:hover{background:rgba(255,255,255,0.05)}
.item.active{background:#3b82f6;color:#fff}
.item .sub{font-size:11px;color:#94a3b8;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item.active .sub{color:#dbeafe}
.col-chat{flex:1;display:flex;flex-direction:column}
.chat-header{padding:12px 16px;background:#1e293b;font-size:14px;border-bottom:1px solid #0f172a}
.msg-list{flex:1;overflow-y:auto;padding:16px}
.msg{margin-bottom:14px;max-width:70%}
.msg.user{margin-right:auto}
.msg.admin{margin-left:auto;text-align:right}
.msg-meta{font-size:11px;color:#64748b;margin-bottom:4px}
.msg-text{display:inline-block;padding:10px 14px;border-radius:10px;font-size:14px;line-height:1.5;word-break:break-all;text-align:left}
.msg.user .msg-text{background:#1e293b}
.msg.admin .msg-text{background:#3b82f6;color:#fff}
.input-bar{padding:12px 16px;background:#1e293b;display:flex;gap:10px}
.input-bar input{flex:1;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:14px}
.input-bar button{padding:10px 20px;border:none;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer}
.empty{padding:40px;text-align:center;color:#475569;font-size:13px}
.mask{position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10}
.modal{background:#1e293b;border-radius:12px;padding:24px;width:380px;max-height:70vh;overflow-y:auto}
.modal h2{font-size:16px;margin-bottom:16px}
.modal input{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;margin-bottom:10px;font-size:14px}
.modal textarea{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;height:100px;margin-bottom:10px;font-size:14px;font-family:inherit}
.modal button{padding:8px 16px;border:none;border-radius:6px;background:#3b82f6;color:#fff;cursor:pointer;margin-right:8px;font-size:13px}
.modal .close-btn{background:#475569}
.ban-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #0f172a;font-size:13px}
.ban-row button{background:#ef4444;padding:4px 10px;font-size:12px}
</style>
</head>
<body>
<div id="loginView" class="login-wrap">
  <div class="login-card">
    <h1>🤖 TGBOT 管理后台</h1>
    <input id="pwdInput" type="password" placeholder="请输入管理密码" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()">登 录</button>
    <p id="loginErr"></p>
  </div>
</div>

<div id="mainView" class="main-wrap" style="display:none">
  <header>
    <div class="brand">🤖 TGBOT</div>
    <div id="statsBar" class="stats"></div>
    <div class="actions">
      <button onclick="openBanModal()">🚫 封禁管理</button>
      <button onclick="openBroadcastModal()">📢 平台广播</button>
      <button onclick="logout()">退出</button>
    </div>
  </header>
  <div class="layout">
    <aside class="col-bots">
      <div class="col-title">机器人</div>
      <div id="botList"></div>
    </aside>
    <aside class="col-users">
      <div class="col-title">会话</div>
      <div id="userList"></div>
    </aside>
    <main class="col-chat">
      <div id="chatHeader" class="chat-header">请选择会话</div>
      <div id="msgList" class="msg-list"><div class="empty">选择左侧会话开始回复</div></div>
      <div class="input-bar">
        <input id="msgInput" placeholder="输入回复内容，回车发送" onkeydown="if(event.key==='Enter')sendMsg()">
        <button onclick="sendMsg()">发送</button>
      </div>
    </main>
  </div>
</div>

<div id="banModal" class="mask" style="display:none">
  <div class="modal">
    <h2>🚫 联合封禁管理</h2>
    <input id="banInput" placeholder="输入要封禁的用户 ID">
    <button onclick="addBan()">封禁</button>
    <button class="close-btn" onclick="closeModal('banModal')">关闭</button>
    <div id="banListBox" style="margin-top:16px"></div>
  </div>
</div>

<div id="broadcastModal" class="mask" style="display:none">
  <div class="modal">
    <h2>📢 平台级广播</h2>
    <textarea id="broadcastInput" placeholder="输入要广播的内容，将发送给所有 Bot 的所有用户"></textarea>
    <button onclick="doBroadcast()">发送广播</button>
    <button class="close-btn" onclick="closeModal('broadcastModal')">关闭</button>
    <div id="broadcastResult" style="margin-top:12px;font-size:13px;color:#94a3b8"></div>
  </div>
</div>

<script>
var token = localStorage.getItem('tgbot_token') || '';
var currentBot = null;
var currentUser = null;
var refreshTimer = null;

function api(path, method, body) {
  return fetch(path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-token': token },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    if (r.status === 401) { logout(); throw new Error('unauthorized'); }
    return r.json();
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function login() {
  var pwd = document.getElementById('pwdInput').value;
  fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pwd })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.token) {
      token = d.token;
      localStorage.setItem('tgbot_token', token);
      showMain();
    } else {
      document.getElementById('loginErr').textContent = d.error || '登录失败';
    }
  }).catch(function () {
    document.getElementById('loginErr').textContent = '网络错误';
  });
}

function logout() {
  token = '';
  localStorage.removeItem('tgbot_token');
  document.getElementById('mainView').style.display = 'none';
  document.getElementById('loginView').style.display = 'flex';
  if (refreshTimer) clearInterval(refreshTimer);
}

function showMain() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('mainView').style.display = 'flex';
  loadStats();
  loadBots();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(function () {
    loadStats();
    if (currentBot && currentUser) loadMessages(true);
  }, 5000);
}

function loadStats() {
  api('/api/stats').then(function (d) {
    document.getElementById('statsBar').textContent =
      '🟢 运行 ' + d.running + ' · 💤 休眠 ' + d.sleeping + ' · 🤖 共 ' + d.total + ' · 🚫 封禁 ' + d.banned + ' · 💾 ' + d.memoryMB + 'MB';
  }).catch(function () { });
}

function loadBots() {
  api('/api/bots').then(function (list) {
    var html = '';
    if (list.length === 0) html = '<div class="empty">暂无机器人</div>';
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var active = currentBot === b.bot_id ? ' active' : '';
      var status = b.running ? '🟢' : '💤';
      html += '<div class="item' + active + '" onclick="selectBot(\'' + b.bot_id + '\',\'' + b.username + '\')">'
        + status + ' @' + escapeHtml(b.username)
        + '<div class="sub">用户 ' + b.userCount + ' 人</div></div>';
    }
    document.getElementById('botList').innerHTML = html;
  }).catch(function () { });
}

function selectBot(botId, username) {
  currentBot = botId;
  currentUser = null;
  loadBots();
  document.getElementById('chatHeader').textContent = '@' + username + ' — 请选择会话';
  document.getElementById('msgList').innerHTML = '<div class="empty">选择左侧会话开始回复</div>';
  api('/api/bots/' + botId + '/users').then(function (list) {
    var html = '';
    if (list.length === 0) html = '<div class="empty">暂无会话</div>';
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      html += '<div class="item" onclick="selectUser(\'' + u.userId + '\',\'' + escapeHtml(u.name || u.userId) + '\')">'
        + escapeHtml(u.name || u.userId)
        + '<div class="sub">' + escapeHtml(u.lastText || '') + '</div></div>';
    }
    document.getElementById('userList').innerHTML = html;
  }).catch(function () { });
}

function selectUser(userId, name) {
  currentUser = userId;
  document.getElementById('chatHeader').textContent = '会话：' + name + '（' + userId + '）';
  loadMessages(false);
  var items = document.querySelectorAll('.col-users .item');
  for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
  if (event && event.currentTarget) event.currentTarget.classList.add('active');
}

function loadMessages(silent) {
  if (!currentBot || !currentUser) return;
  api('/api/bots/' + currentBot + '/users/' + currentUser + '/messages').then(function (list) {
    var html = '';
    if (list.length === 0) html = '<div class="empty">暂无消息记录</div>';
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var who = m.from === 'admin' ? '管理员' : (m.name || '用户');
      var time = new Date(m.time).toLocaleString('zh-CN');
      html += '<div class="msg ' + m.from + '"><div class="msg-meta">' + escapeHtml(who) + ' · ' + time + '</div>'
        + '<div class="msg-text">' + escapeHtml(m.text) + '</div></div>';
    }
    var box = document.getElementById('msgList');
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = html;
    if (!silent || atBottom) box.scrollTop = box.scrollHeight;
  }).catch(function () { });
}

function sendMsg() {
  var input = document.getElementById('msgInput');
  var text = input.value.trim();
  if (!text || !currentBot || !currentUser) return;
  input.value = '';
  api('/api/bots/' + currentBot + '/users/' + currentUser + '/send', 'POST', { text: text })
    .then(function () { loadMessages(true); })
    .catch(function (e) { alert('发送失败: ' + e.message); });
}

function openBanModal() {
  document.getElementById('banModal').style.display = 'flex';
  loadBanList();
}

function loadBanList() {
  api('/api/banlist').then(function (list) {
    var html = '';
    if (list.length === 0) html = '<div class="empty">封禁列表为空</div>';
    for (var i = 0; i < list.length; i++) {
      html += '<div class="ban-row"><span>' + escapeHtml(list[i]) + '</span>'
        + '<button onclick="removeBan(\'' + list[i] + '\')">解封</button></div>';
    }
    document.getElementById('banListBox').innerHTML = html;
  }).catch(function () { });
}

function addBan() {
  var uid = document.getElementById('banInput').value.trim();
  if (!uid) return;
  api('/api/ban', 'POST', { userId: uid }).then(function () {
    document.getElementById('banInput').value = '';
    loadBanList();
    loadStats();
  }).catch(function () { });
}

function removeBan(uid) {
  api('/api/unban', 'POST', { userId: uid }).then(function () {
    loadBanList();
    loadStats();
  }).catch(function () { });
}

function openBroadcastModal() {
  document.getElementById('broadcastModal').style.display = 'flex';
}

function doBroadcast() {
  var msg = document.getElementById('broadcastInput').value.trim();
  if (!msg) return;
  document.getElementById('broadcastResult').textContent = '正在发送，请稍候...';
  api('/api/broadcast', 'POST', { message: msg }).then(function (d) {
    document.getElementById('broadcastResult').textContent =
      '✅ 完成 — 成功 ' + d.success + '，失败 ' + d.failed + '，跳过(已封禁) ' + d.skipped;
  }).catch(function () {
    document.getElementById('broadcastResult').textContent = '发送失败';
  });
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

if (token) {
  api('/api/stats').then(function () { showMain(); }).catch(function () { });
}
</script>
</body>
</html>`;
