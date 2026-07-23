const { Bot, InlineKeyboard } = require('grammy');
const fs = require('fs');
const path = require('path');

// ========== 配置区（在服务器上用 sed 修改，不要提交真实值）==========
const MASTER_TOKEN = 'PASTE_YOUR_MASTER_BOT_TOKEN_HERE';
const ADMIN_ID = 'PASTE_YOUR_TELEGRAM_USER_ID_HERE';
const API_ROOT = 'https://bot.143259.xyz';
// ===================================================================

const DB_FILE = path.join(__dirname, 'bots.json');

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const WAKEUP_INTERVAL_MS = 60 * 1000;
const POLL_TIMEOUT = 60;

// ---------------- 数据存储 ----------------
const Store = {
  load() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { return { bots: [], kv: {}, banlist: [], botSettings: {} }; }
  },
  save(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  },
  addBot(bot) {
    const data = this.load();
    if (!data.bots) data.bots = [];
    data.bots = data.bots.filter(function (b) { return b.bot_id !== bot.bot_id; });
    data.bots.push(bot);
    this.save(data);
  },
  removeBot(botId) {
    const data = this.load();
    if (!data.bots) data.bots = [];
    data.bots = data.bots.filter(function (b) { return b.bot_id !== botId; });
    if (data.kv) delete data.kv[botId];
    if (data.botSettings) delete data.botSettings[botId];
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
  // ---- 全局封禁列表 ----
  getBanlist() {
    const data = this.load();
    return data.banlist || [];
  },
  addToBanlist(userId) {
    const data = this.load();
    if (!data.banlist) data.banlist = [];
    if (!data.banlist.includes(userId)) {
      data.banlist.push(userId);
      this.save(data);
    }
  },
  removeFromBanlist(userId) {
    const data = this.load();
    if (!data.banlist) data.banlist = [];
    data.banlist = data.banlist.filter(function (id) { return id !== userId; });
    this.save(data);
  },
  // ---- 每个 Bot 的独立设置 ----
  getBotSettings(botId) {
    const data = this.load();
    if (!data.botSettings) data.botSettings = {};
    if (!data.botSettings[botId]) {
      data.botSettings[botId] = {
        useGlobalBan: true,     // 联合封禁，默认开
        useCaptcha: false,       // 人机验证，默认关
        verifiedUsers: []        // 已通过人机验证的用户
      };
    }
    return data.botSettings[botId];
  },
  setBotSettings(botId, settings) {
    const data = this.load();
    if (!data.botSettings) data.botSettings = {};
    data.botSettings[botId] = settings;
    this.save(data);
  }
};

// ---------------- Bot 实例管理器 ----------------
class BotManager {
  constructor() {
    this.instances = new Map();
    this.sleeping = new Set();
    this.idleCheckTimer = null;
    this.wakeupTimer = null;
  }

  async createBot(token, ownerId) {
    const testBot = new Bot(token, { client: { apiRoot: API_ROOT } });
    const me = await testBot.api.getMe();
    const botId = me.id.toString();
    const username = me.username;

    if (this.instances.has(botId)) throw new Error('Bot @' + username + ' 已在运行中');
    if (this.sleeping.has(botId)) this.sleeping.delete(botId);

    const bot = new Bot(token, { client: { apiRoot: API_ROOT } });
    this.registerHandlers(bot, botId, ownerId);

    const self = this;
    const instance = { bot: bot, username: username, token: token, ownerId: ownerId, lastActivity: Date.now(), idleTimer: null };

    bot.start({
      timeout: POLL_TIMEOUT,
      onStart: function () { console.log('[@' + username + '] long polling started'); }
    });

    this.instances.set(botId, instance);
    this.resetIdleTimer(botId);

    Store.addBot({ bot_id: botId, username: username, token: token, owner_id: ownerId, created_at: new Date().toISOString(), status: 'running' });
    this.startDaemonTasks();

    return { botId: botId, username: username };
  }

  registerHandlers(bot, botId, ownerId) {
    const kv = new Map(Object.entries(Store.getKV(botId)));
    const settings = Store.getBotSettings(botId); // 引用，改动直接生效

    function persistKV() {
      const obj = {};
      kv.forEach(function (value, key) { obj[key] = value; });
      Store.setKV(botId, obj);
    }

    function persistSettings() {
      Store.setBotSettings(botId, settings);
    }

    function isAdmin(ctx) {
      return ctx.from && ctx.from.id.toString() === ownerId;
    }

    const self = this;

    // 中间件：刷新活动时间
    bot.use(async function (ctx, next) {
      const inst = self.instances.get(botId);
      if (inst) { inst.lastActivity = Date.now(); self.resetIdleTimer(botId); }
      await next();
    });

    // ---- /panel 命令：打开设置面板 ----
    bot.command('panel', async function (ctx) {
      if (!isAdmin(ctx)) return;
      if (ctx.chat.type !== 'private') return;
      await sendPanel(ctx, settings);
    });

    // ---- 面板按钮回调 ----
    bot.on('callback_query:data', async function (ctx) {
      const data = ctx.callbackQuery.data;
      if (!isAdmin(ctx)) return;

      if (data === 'toggle_ban') {
        settings.useGlobalBan = !settings.useGlobalBan;
        persistSettings();
        await ctx.answerCallbackQuery({ text: '联合封禁已' + (settings.useGlobalBan ? '开启' : '关闭') });
        await sendPanel(ctx, settings, true);
      } else if (data === 'toggle_captcha') {
        settings.useCaptcha = !settings.useCaptcha;
        persistSettings();
        await ctx.answerCallbackQuery({ text: '人机验证已' + (settings.useCaptcha ? '开启' : '关闭') });
        await sendPanel(ctx, settings, true);
      }
    });

    bot.command('start', async function (ctx) {
      if (ctx.chat.type !== 'private') return;
      if (isAdmin(ctx)) {
        await ctx.reply('✅ 双向私聊机器人已启动

管理命令：
/setchat <群ID> - 设置话题群
/topicgroup - 查看话题群
/cleartopicgroup - 清除话题群
/panel - 打开设置面板（联合封禁 / 人机验证）');
      } else {
        const tg = kv.get('topic_group');
        if (tg) {
          await ctx.reply('👋 欢迎！直接发送消息即可联系管理员。');
        } else {
          await ctx.reply('👋 欢迎！机器人尚未配置完毕，请联系管理员。');
        }
      }
    });

    bot.command('setchat', async function (ctx) {
      if (!isAdmin(ctx)) return;
      const groupId = ctx.match ? ctx.match.trim() : '';
      if (!groupId || groupId.indexOf('-100') !== 0) {
        await ctx.reply('⚠️ 用法：/setchat -100xxxxxxxxx');
        return;
      }
      kv.set('topic_group', groupId);
      persistKV();
      await ctx.reply('✅ 话题群已设置为：' + groupId);
    });

    bot.command('topicgroup', async function (ctx) {
      if (!isAdmin(ctx)) return;
      const g = kv.get('topic_group');
      await ctx.reply(g ? '📋 当前话题群 ID：' + g : '⚠️ 尚未设置话题群');
    });

    bot.command('cleartopicgroup', async function (ctx) {
      if (!isAdmin(ctx)) return;
      kv.delete('topic_group');
      persistKV();
      await ctx.reply('✅ 话题群设置已清除');
    });

    // ---- 消息处理 ----
    bot.on('message', async function (ctx) {
      const msg = ctx.message;
      if (!ctx.from) return;
      const fromId = ctx.from.id.toString();
      if (msg.text && msg.text.indexOf('/') === 0) return;

      // 检查全局封禁
      if (settings.useGlobalBan && Store.getBanlist().includes(fromId)) {
        console.log('[' + botId + '] 已拦截封禁用户 ' + fromId);
        return; // 静默丢弃
      }

      // 管理员在话题群回复 → 转发给用户
      if (isAdmin(ctx) && ctx.chat.type === 'supergroup' && msg.message_thread_id) {
        const topicId = msg.message_thread_id.toString();
        const userChatId = kv.get('topic:' + topicId);
        if (userChatId) await forwardMessage(bot, userChatId, msg);
        return;
      }

      // 普通用户私聊 → 人机验证 → 转发到话题群
      if (ctx.chat.type === 'private' && !isAdmin(ctx)) {
        const topicGroup = kv.get('topic_group');
        if (!topicGroup) return;

        // ---- 人机验证 ----
        if (settings.useCaptcha) {
          if (!settings.verifiedUsers.includes(fromId)) {
            // 未验证，发验证按钮
            const keyboard = new InlineKeyboard().text('✅ 我不是机器人', 'captcha_verify');
            await ctx.reply('请完成人机验证后才能发送消息：', { reply_markup: keyboard });
            return;
          }
        }

        let topicId = kv.get('user:' + fromId);
        if (!topicId) {
          const senderName = ((ctx.from.first_name || '') + ' ' + (ctx.from.last_name || '')).trim();
          const topicTitle = fromId + ' (' + senderName + ')';
          try {
            const result = await bot.api.createForumTopic(parseInt(topicGroup, 10), topicTitle);
            topicId = result.message_thread_id.toString();
            kv.set('user:' + fromId, topicId);
            kv.set('topic:' + topicId, fromId);
            persistKV();
          } catch (e) {
            console.error('[' + botId + '] 创建话题失败: ' + (e.message || e));
            return;
          }
        }
        await forwardToTopic(bot, topicGroup, topicId, msg);
      }
    });

    // ---- 人机验证按钮回调 ----
    bot.on('callback_query:data', async function (ctx) {
      const data = ctx.callbackQuery.data;
      if (data !== 'captcha_verify') return;

      const fromId = ctx.from.id.toString();
      if (!settings.verifiedUsers.includes(fromId)) {
        settings.verifiedUsers.push(fromId);
        persistSettings();
      }
      await ctx.answerCallbackQuery({ text: '✅ 验证通过！' });
      try {
        await ctx.editMessageText('✅ 人机验证通过，现在可以正常发送消息了。');
      } catch (e) { }
    });

    bot.catch(function (err) {
      console.error('[' + botId + '] 运行错误: ' + (err.message || err));
    });
  }

  // ---------- 休眠与唤醒 ----------
  resetIdleTimer(botId) {
    const inst = this.instances.get(botId);
    if (!inst) return;
    if (inst.idleTimer) clearTimeout(inst.idleTimer);
    const self = this;
    inst.idleTimer = setTimeout(function () { self.sleepBot(botId); }, IDLE_TIMEOUT_MS);
  }

  async sleepBot(botId) {
    const inst = this.instances.get(botId);
    if (!inst) return;
    console.log('[@' + inst.username + '] 闲置超时，进入休眠');
    try { await inst.bot.stop(); } catch (e) { }
    this.instances.delete(botId);
    this.sleeping.add(botId);
  }

  async wakeBot(botId) {
    const inst = this.instances.get(botId);
    if (inst) return;
    const data = Store.listBots().find(function (b) { return b.bot_id === botId; });
    if (!data) return;
    console.log('[@' + data.username + '] 检测到新消息，自动唤醒');
    try {
      await this.createBot(data.token, data.owner_id);
      this.sleeping.delete(botId);
    } catch (e) {
      console.error('[@' + data.username + '] 唤醒失败: ' + e.message);
    }
  }

  startDaemonTasks() {
    const self = this;
    if (!this.idleCheckTimer) {
      this.idleCheckTimer = setInterval(function () {
        const now = Date.now();
        self.instances.forEach(function (inst, botId) {
          if (now - inst.lastActivity > IDLE_TIMEOUT_MS) self.sleepBot(botId);
        });
      }, 60 * 1000);
    }
    if (!this.wakeupTimer) {
      this.wakeupTimer = setInterval(async function () {
        if (self.sleeping.size === 0) return;
        for (const botId of self.sleeping) {
          const data = Store.listBots().find(function (b) { return b.bot_id === botId; });
          if (!data) { self.sleeping.delete(botId); continue; }
          try {
            const testBot = new Bot(data.token, { client: { apiRoot: API_ROOT } });
            const updates = await testBot.api.getUpdates({ timeout: 0, limit: 1 });
            if (updates && updates.length > 0) await self.wakeBot(botId);
          } catch (e) {
            console.error('[@' + data.username + '] 探测失败: ' + e.message);
          }
        }
      }, WAKEUP_INTERVAL_MS);
    }
  }

  async deleteBot(botId) {
    const inst = this.instances.get(botId);
    if (inst) {
      if (inst.idleTimer) clearTimeout(inst.idleTimer);
      try { await inst.bot.stop(); } catch (e) { }
      this.instances.delete(botId);
    }
    this.sleeping.delete(botId);
    Store.removeBot(botId);
  }

  getStats() {
    return {
      running: this.instances.size,
      sleeping: this.sleeping.size,
      runningList: Array.from(this.instances.entries()).map(function (e) {
        return { botId: e[0], username: e[1].username, lastActivity: e[1].lastActivity };
      }),
      sleepingList: Array.from(this.sleeping).map(function (botId) {
        const d = Store.listBots().find(function (b) { return b.bot_id === botId; });
        return { botId: botId, username: d ? d.username : 'unknown' };
      })
    };
  }
}

// ---------------- 面板发送 ----------------
async function sendPanel(ctx, settings, isEdit) {
  const banStatus = settings.useGlobalBan ? '✅' : '❌';
  const captchaStatus = settings.useCaptcha ? '✅' : '❌';

  const keyboard = new InlineKeyboard()
    .text('🛡 联合封禁：' + banStatus, 'toggle_ban').row()
    .text('🤖 人机验证：' + captchaStatus, 'toggle_captcha');

  const text = '⚙️ Bot 设置面板

' +
    '🛡 联合封禁：' + (settings.useGlobalBan ? '✅ 已开启' : '❌ 已关闭') + '
' +
    '🤖 人机验证：' + (settings.useCaptcha ? '✅ 已开启' : '❌ 已关闭') + '

' +
    '点击下方按钮切换开关';

  if (isEdit) {
    try { await ctx.editMessageText(text, { reply_markup: keyboard }); } catch (e) { }
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

// ---------------- 消息转发辅助函数 ----------------
async function forwardMessage(bot, targetChatId, msg) {
  if (msg.photo) {
    const p = msg.photo[msg.photo.length - 1];
    await bot.api.sendPhoto(targetChatId, p.file_id, { caption: msg.caption });
  } else if (msg.document) {
    await bot.api.sendDocument(targetChatId, msg.document.file_id, { caption: msg.caption });
  } else if (msg.video) {
    await bot.api.sendVideo(targetChatId, msg.video.file_id, { caption: msg.caption });
  } else if (msg.audio) {
    await bot.api.sendAudio(targetChatId, msg.audio.file_id, { caption: msg.caption });
  } else if (msg.voice) {
    await bot.api.sendVoice(targetChatId, msg.voice.file_id);
  } else if (msg.sticker) {
    await bot.api.sendSticker(targetChatId, msg.sticker.file_id);
  } else if (msg.text) {
    await bot.api.sendMessage(targetChatId, msg.text);
  }
}

async function forwardToTopic(bot, groupId, topicId, msg) {
  const gid = parseInt(groupId, 10);
  const tid = parseInt(topicId, 10);
  if (msg.photo) {
    const p = msg.photo[msg.photo.length - 1];
    await bot.api.sendPhoto(gid, p.file_id, { message_thread_id: tid, caption: msg.caption });
  } else if (msg.document) {
    await bot.api.sendDocument(gid, msg.document.file_id, { message_thread_id: tid, caption: msg.caption });
  } else if (msg.video) {
    await bot.api.sendVideo(gid, msg.video.file_id, { message_thread_id: tid, caption: msg.caption });
  } else if (msg.audio) {
    await bot.api.sendAudio(gid, msg.audio.file_id, { message_thread_id: tid, caption: msg.caption });
  } else if (msg.voice) {
    await bot.api.sendVoice(gid, msg.voice.file_id, { message_thread_id: tid });
  } else if (msg.sticker) {
    await bot.api.sendSticker(gid, msg.sticker.file_id, { message_thread_id: tid });
  } else if (msg.text) {
    await bot.api.sendMessage(gid, msg.text, { message_thread_id: tid });
  }
}

// ---------------- 主机器人 ----------------
async function main() {
  const manager = new BotManager();

  const existing = Store.listBots();
  console.log('正在恢复 ' + existing.length + ' 个已有 Bot...');
  for (let i = 0; i < existing.length; i++) {
    const r = existing[i];
    try {
      await manager.createBot(r.token, r.owner_id);
      console.log('  ✅ @' + r.username + ' 已恢复');
    } catch (e) {
      console.error('  ❌ @' + r.username + ' 恢复失败: ' + e.message);
    }
  }

  const masterBot = new Bot(MASTER_TOKEN, { client: { apiRoot: API_ROOT } });

  function isMasterAdmin(ctx) {
    return ctx.from && ctx.from.id.toString() === ADMIN_ID;
  }

  masterBot.command('start', async function (ctx) {
    if (isMasterAdmin(ctx)) {
      await ctx.reply('🤖 TGBOT Master 管理面板

开放功能（所有人可用）：
/create <BotToken> - 一键创建你自己的双向私聊机器人

管理员功能：
/list - 查看所有 Bot
/delete <botId> - 删除 Bot
/sleep <botId> - 手动休眠 Bot
/wake <botId> - 手动唤醒 Bot
/ban <用户ID> - 联合封禁用户
/unban <用户ID> - 解除封禁
/banlist - 查看封禁列表
/stats - 查看服务器状态');
    } else {
      await ctx.reply('👋 欢迎使用机器人托管平台！

发送 /create 加上你的 Bot Token，即可一键创建属于你自己的双向私聊机器人。

例如：
/create 123456:ABCdef...

Token 可以在 @BotFather 处免费申请。');
    }
  });

  masterBot.command('create', async function (ctx) {
    const token = ctx.match ? ctx.match.trim() : '';
    if (!token || token.indexOf(':') === -1) {
      await ctx.reply('⚠️ 用法：/create <BotToken>
例如：/create 123456:ABCdef...');
      return;
    }

    const myBots = Store.listBots().filter(function (b) { return b.owner_id === ctx.from.id.toString(); });
    if (myBots.length >= 3) {
      await ctx.reply('⚠️ 每人最多创建 3 个机器人，你已达上限。');
      return;
    }
    if (Store.listBots().length >= 50) {
      await ctx.reply('⚠️ 平台已达容量上限，请稍后再试或联系管理员。');
      return;
    }

    await ctx.reply('🔄 正在验证 Token 并创建机器人，请稍候...');
    try {
      const result = await manager.createBot(token, ctx.from.id.toString());
      await ctx.reply('🎉 机器人创建成功！

🤖 @' + result.username + '（ID: ' + result.botId + '）

接下来请完成配置：
1. 创建一个超级群组，并在群设置中开启「话题」功能
2. 将 @' + result.username + ' 拉入群组并设为管理员
3. 私聊 @' + result.username + ' 发送：/setchat 群ID
   （群 ID 以 -100 开头）
4. 私聊 @' + result.username + ' 发送 /panel 可设置联合封禁和人机验证

完成后，任何人私聊你的机器人，消息都会出现在群组对应的话题里。');
    } catch (error) {
      await ctx.reply('❌ 创建失败：' + error.message);
    }
  });

  masterBot.command('list', async function (ctx) {
    if (!isMasterAdmin(ctx)) return;
    const bots = Store.listBots();
    if (bots.length === 0) {
      await ctx.reply('📭 尚未创建任何 Bot');
      return;
    }
    let msg = '📋 已创建的 Bot（共 ' + bots.length + ' 个）：

';
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      msg += '🤖 @' + b.username + '
  ID: ' + b.bot_id + '
  创建者: ' + b.owner_id + '
  创建时间: ' + b.created_at + '

';
    }
    await ctx.reply(msg);
  });

  masterBot.command('delete', async function (ctx) {
    if (!isMasterAdmin(ctx)) return;
    const botId = ctx.match ? ctx.match.trim() : '';
    if (!botId) {
      await ctx.reply('⚠️ 用法：/delete <botId>');
      return;
    }
    try {
      await manager.deleteBot(botId);
      await ctx.reply('✅ Bot ' + botId + ' 已停止并删除');
    } catch (error) {
      await ctx.reply('❌ 删除失败: ' + error.message);
    }
  });

  masterBot.command('sleep', async function (ctx) {
    if (!isMasterAdmin(ctx)) return;
    const botId = ctx.match ? ctx.match.trim() : '';
    if (!botId) {
      await ctx.reply('⚠️ 用法：/sleep <botId>');
      return;
    }
    await manager.sleepBot(botId);
    await ctx.reply('💤 Bot ' + botId + ' 已休眠，下次有消息时自动唤醒');
  });

  masterBot.command('wake', async function (ctx) {
    if (!isMasterAdmin(ctx)) return;
    const botId = ctx.match ? ctx.match.trim() : '';
    if (!botId) {
      await ctx.reply('⚠️ 用法：/wake <botId>');
      return;
    }
    await manager.wakeBot(botId);
    await ctx.reply('⏰ Bot ' + botId + ' 已唤醒');
  });

  // ---- 联合封禁管理 ----
  masterBot.command('ban', async function (ctx) {
    if (!isMasterAdmin(ctx)) return;
    const userId = ctx.match ? ctx.match.trim() : '';
    if (!userId) {
      await ctx.reply('⚠️ 用法：/ban <用户ID>');
      return;
    }
    Store.addToBanlist(userId);
    await ctx.reply('🚫 用户 ' + userId + ' 已加入联合封禁列表
所有开启了联合封禁的 Bot 将不再接收此用户的消息。');
  });

  masterBot.command('unban', async function (ctx) {
    if (!isMasterAdmin(ctx)) return;
    const userId = ctx.match ? ctx.match.trim() : '';
    if (!userId) {
      await ctx.reply('⚠️ 用法：/unban <用户ID>');
      return;
    }
    Store.removeFromBanlist(userId);
    await ctx.reply('✅ 用户 ' + userId + ' 已从联合封禁列表移除');
  });

  masterBot.command('banlist', async function (ctx) {
    if (!isMasterAdmin(ctx)) return;
    const banlist = Store.getBanlist();
    if (banlist.length === 0) {
      await ctx.reply('📭 封禁列表为空');
      return;
    }
    let msg = '🚫 联合封禁列表（共 ' + banlist.length + ' 人）：

';
    for (let i = 0; i < banlist.length; i++) {
      msg += '• ' + banlist[i] + '
';
    }
    await ctx.reply(msg);
  });

  masterBot.command('stats', async function (ctx) {
    if (!isMasterAdmin(ctx)) return;
    const stats = manager.getStats();
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    await ctx.reply('📊 服务器状态

🟢 运行中 Bot: ' + stats.running + ' 个
💤 休眠中 Bot: ' + stats.sleeping + ' 个
🚫 联合封禁: ' + Store.getBanlist().length + ' 人
💾 内存占用: ' + (mem.rss / 1024 / 1024).toFixed(1) + ' MB
🖥 CPU 用户时间: ' + (cpu.user / 1000000).toFixed(2) + ' s
🖥 CPU 系统时间: ' + (cpu.system / 1000000).toFixed(2) + ' s');
  });

  masterBot.catch(function (err) {
    console.error('[master] 运行错误: ' + (err.message || err));
  });

  masterBot.start();
  console.log('✅ TGBOT Master 已启动');
}

main().catch(function (e) {
  console.error('启动失败:', e);
  process.exit(1);
});
