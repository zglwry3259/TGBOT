const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'bots.json');

const Store = {
  load() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { return { bots: [], kv: {}, banlist: [], botSettings: {}, messages: {} }; }
  },
  save(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data));
  },
  addBot(bot) {
    const data = this.load();
    if (!data.bots) data.bots = [];
    data.bots = data.bots.filter(b => b.bot_id !== bot.bot_id);
    data.bots.push(bot);
    this.save(data);
  },
  removeBot(botId) {
    const data = this.load();
    if (!data.bots) data.bots = [];
    data.bots = data.bots.filter(b => b.bot_id !== botId);
    if (data.kv) delete data.kv[botId];
    if (data.botSettings) delete data.botSettings[botId];
    if (data.messages) delete data.messages[botId];
    this.save(data);
  },
  listBots() {
    const data = this.load();
    return data.bots || [];
  },
  getKV(botId) {
    const data = this.load();
    if (!data.kv) return {};
    return data.kv[botId] || {};
  },
  setKV(botId, kvObj) {
    const data = this.load();
    if (!data.kv) data.kv = {};
    data.kv[botId] = kvObj;
    this.save(data);
  },
  getBanlist() {
    const data = this.load();
    return data.banlist || [];
  },
  addToBanlist(userId) {
    const data = this.load();
    if (!data.banlist) data.banlist = [];
    if (data.banlist.indexOf(userId) === -1) {
      data.banlist.push(userId);
      this.save(data);
    }
  },
  removeFromBanlist(userId) {
    const data = this.load();
    if (!data.banlist) data.banlist = [];
    data.banlist = data.banlist.filter(id => id !== userId);
    this.save(data);
  },
  getBotSettings(botId) {
    const data = this.load();
    if (!data.botSettings) data.botSettings = {};
    if (!data.botSettings[botId]) {
      data.botSettings[botId] = { useGlobalBan: true, useCaptcha: false, verifiedUsers: [] };
    }
    return data.botSettings[botId];
  },
  setBotSettings(botId, settings) {
    const data = this.load();
    if (!data.botSettings) data.botSettings = {};
    data.botSettings[botId] = settings;
    this.save(data);
  },
  getUsersForBot(botId) {
    const kv = this.getKV(botId);
    const users = [];
    for (const key in kv) {
      if (key.indexOf('user:') === 0) users.push(key.replace('user:', ''));
    }
    return users;
  },
  addMessage(botId, userId, entry) {
    const data = this.load();
    if (!data.messages) data.messages = {};
    if (!data.messages[botId]) data.messages[botId] = {};
    if (!data.messages[botId][userId]) data.messages[botId][userId] = [];
    data.messages[botId][userId].push(entry);
    if (data.messages[botId][userId].length > 100) {
      data.messages[botId][userId] = data.messages[botId][userId].slice(-100);
    }
    this.save(data);
  },
  getMessages(botId, userId) {
    const data = this.load();
    if (!data.messages || !data.messages[botId]) return [];
    return data.messages[botId][userId] || [];
  },
  getConversations(botId) {
    const data = this.load();
    const result = [];
    if (!data.messages || !data.messages[botId]) return result;
    const conv = data.messages[botId];
    for (const userId in conv) {
      const msgs = conv[userId];
      if (msgs.length === 0) continue;
      let name = '';
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].name) { name = msgs[i].name; break; }
      }
      const last = msgs[msgs.length - 1];
      result.push({ userId: userId, name: name, lastText: last.text, lastTime: last.time });
    }
    result.sort((a, b) => b.lastTime - a.lastTime);
    return result;
  }
};

module.exports = Store;
