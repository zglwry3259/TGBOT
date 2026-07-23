const { Bot, InlineKeyboard } = require('grammy');
const fs = require('fs');
const path = require('path');

// ========== 配置区（下载后在服务器上修改，勿提交真实值）==========
const MASTER_TOKEN = 'PASTE_YOUR_MASTER_BOT_TOKEN_HERE';
const ADMIN_ID = 'PASTE_YOUR_TELEGRAM_USER_ID_HERE';
const API_ROOT = 'https://bot.143259.xyz';
// ==============================================================

const DB_FILE = path.join(__dirname, 'bots.json');

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const WAKEUP_INTERVAL_MS = 60 * 1000;
const POLL_TIMEOUT = 60;
const BROADCAST_RATE_LIMIT = 30;

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
    data.banlist = data.banlist.filter(function (id) { return id !== userId; });
    this.save(data);
  },
  getBotSettings(botId) {
    const data = this.load();
    if (!data.botSettings) data.botSettings = {};
    if (!data.botSettings[botId]) {
      data.botSettings[botId] = {
        useGlobalBan: true,
        useCaptcha: false,
        verifiedUsers: []
      };
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
      if (key.indexOf('user:') === 0) {
        users.push(key.replace('user:', ''));
      }
    }
    return users;
  }
};

// ---------------- 面板 ----------------
function buildPanelText(settings) {
  const banLine = settings.useGlobalBan ? '✅ 已开启' : '❌ 已关闭';
  const captchaLine = settings.useCaptcha ? '✅ 已开启' : '❌ 已关闭';
  return `⚙️ Bot 设置面板

🛡 联合封禁：${banLine}
🤖 人机验证：${captchaLine}

点击下方按钮切换开关`;
}

function buildPanelKeyboard(settings) {
  const banStatus = settings.useGlobalBan ? '✅' : '❌';
  const captchaStatus = settings.useCaptcha ? '✅' : '❌';
  return new InlineKeyboard()
    .text(`🛡 联合封禁：${banStatus}`, 'toggle_ban').row()
    .text(`🤖 人机验证：${captchaStatus}`, 'toggle_captcha').row()
    .text('📢 广播用法', 'show_broadcast');
}

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

    if (this.instances.has(botId)) throw new Error(`Bot @${username} 已在运行中`);
    this.sleeping.delete(botId);

    const bot = new Bot(token, { client: { apiRoot: API_ROOT } });
    this.registerHandlers(bot, botId, ownerId);

    const instance = {
      bot, username, token, ownerId,
      lastActivity: Date.now(), idleTimer: null
    };

    bot.start({
      timeout: POLL_TIMEOUT,
      onStart: () => console.log(`[@${username}] long polling started`)
    });

    this.instances.set(botId, instance);
    this.resetIdleTimer(botId);

    Store.addBot({
      bot_id: botId, username, token, owner_id: ownerId,
      created_at: new Date().toISOString(), status: 'running'
    });
    this.startDaemonTasks();

    return { botId, username };
  }

  registerHandlers(bot, botId, ownerId) {
    const kv = new Map(Object.entries(Store.getKV(botId)));
    const settings = Store.getBotSettings(botId);
    const self = this;

    function persistKV() {
      const obj = {};
      kv.forEach((value, key) => { obj[key] = value; });
      Store.setKV(botId, obj);
    }

    function persistSettings() {
      Store.setBotSettings(botId, settings);
    }

    function isAdmin(ctx) {
      return ctx.from && ctx.from.id.toString() === ownerId;
    }

    // 活动追踪
    bot.use(async (ctx, next) => {
      const inst = self.instances.get(botId);
      if (inst) {
        inst.lastActivity = Date.now();
        self.resetIdleTimer(botId);
      }
      await next();
    });

    bot.command('start', async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      if (isAdmin(ctx)) {
        await ctx.reply(`✅ 双向私聊机器人已启动

管理命令：
/setchat <群ID> - 设置话题群
/topicgroup - 查看话题群
/cleartopicgroup - 清除话题群
/panel - 打开设置面板
/mybroadcast <消息> - 广播给你的所有用户`);
      } else {
        const tg = kv.get('topic_group');
        await ctx.reply(tg ? '👋 欢迎！直接发送消息即可联系管理员。' : '👋 欢迎！机器人尚未配置完毕，请联系管理员。');
      }
    });

    bot.command('panel', async (ctx) => {
      if (!isAdmin(ctx)) return;
      if (ctx.chat.type !== 'private') return;
      await ctx.reply(buildPanelText(settings), { reply_markup: buildPanelKeyboard(settings) });
    });

    bot.command('setchat', async (ctx) => {
      if (!isAdmin(ctx)) return;
      const groupId = ctx.match ? ctx.match.trim() : '';
      if (!groupId || groupId.indexOf('-100') !== 0) {
        await ctx.reply(`⚠️ 用法：/setchat -100xxxxxxxxx
群 ID 必须以 -100 开头，且群已开启话题功能。`);
        return;
      }
      kv.set('topic_group', groupId);
      persistKV();
      await ctx.reply(`✅ 话题群已设置为：${groupId}`);
    });

    bot.command('topicgroup', async (ctx) => {
      if (!isAdmin(ctx)) return;
      const g = kv.get('topic_group');
      await ctx.reply(g ? `📋 当前话题群 ID：${g}` : '⚠️ 尚未设置话题群');
    });

    bot.command('cleartopicgroup', async (ctx) => {
      if (!isAdmin(ctx)) return;
      kv.delete('topic_group');
      persistKV();
      await ctx.reply('✅ 话题群设置已清除');
    });

    bot.command('mybroadcast', async (ctx) => {
      if (!isAdmin(ctx)) return;
      const message = ctx.match ? ctx.match.trim() : '';
      if (!message) {
        await ctx.reply(`⚠️ 用法：/mybroadcast <消息内容>
例如：/mybroadcast 今晚 8 点系统维护，请知悉。`);
        return;
      }

      const users = [];
      kv.forEach((value, key) => {
        if (key.indexOf('user:') === 0) users.push(key.replace('user:', ''));
      });

      if (users.length === 0) {
        await ctx.reply('📭 还没有用户给你的 Bot 发过消息，无法广播。');
        return;
      }

      await ctx.reply(`🔄 开始广播给 ${users.length} 个用户，请稍候...`);

      let success = 0, failed = 0, skipped = 0;
      const banlist = Store.getBanlist();

      for (let i = 0; i < users.length; i++) {
        const userId = users[i];
        if (settings.useGlobalBan && banlist.indexOf(userId) !== -1) {
          skipped++;
          continue;
        }
        try {
          await bot.api.sendMessage(userId, message);
          success++;
        } catch (e) {
          failed++;
        }
        if (i % BROADCAST_RATE_LIMIT === BROADCAST_RATE_LIMIT - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      await ctx.reply(`✅ 广播完成

📤 成功: ${success}
❌ 失败: ${failed}
⏭ 跳过(已封禁): ${skipped}`);
    });

    // 消息转发
    bot.on('message', async (ctx) => {
      const msg = ctx.message;
      if (!ctx.from) return;
      const fromId = ctx.from.id.toString();
      if (msg.text && msg.text.indexOf('/') === 0) return;

      // 联合封禁
      if (settings.useGlobalBan && Store.getBanlist().indexOf(fromId) !== -1) {
        console.log(`[${botId}] 已拦截封禁用户 ${fromId}`);
        return;
      }

      // 管理员在话题群回复
      if (isAdmin(ctx) && ctx.chat.type === 'supergroup' && msg.message_thread_id) {
        const topicId = msg.message_thread_id.toString();
        const userChatId = kv.get(`topic:${topicId}`);
        if (userChatId) await forwardMessage(bot, userChatId, msg);
        return;
      }

      // 用户私聊
      if (ctx.chat.type === 'private' && !isAdmin(ctx)) {
        const topicGroup = kv.get('topic_group');
        if (!topicGroup) return;

        // 人机验证
        if (settings.useCaptcha && settings.verifiedUsers.indexOf(fromId) === -1) {
          const keyboard = new InlineKeyboard().text('✅ 我不是机器人', 'captcha_verify');
          await ctx.reply('请完成人机验证后才能发送消息：', { reply_markup: keyboard });
          return;
        }

        let topicId = kv.get(`user:${fromId}`);
        if (!topicId) {
          const senderName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
          const topicTitle = `${fromId} (${senderName})`;
          try {
            const result = await bot.api.createForumTopic(parseInt(topicGroup, 10), topicTitle);
            topicId = result.message_thread_id.toString();
            kv.set(`user:${fromId}`, topicId);
            kv.set(`topic:${topicId}`, fromId);
            persistKV();
          } catch (e) {
            console.error(`[${botId}] 创建话题失败: ${e.message || e}`);
            return;
          }
        }
        await forwardToTopic(bot, topicGroup, topicId, msg);
      }
    });

    // 所有按钮回调统一处理
    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;

      // 人机验证按钮
      if (data === 'captcha_verify') {
        const fromId = ctx.from.id.toString();
        if (settings.verifiedUsers.indexOf(fromId) === -1) {
          settings.verifiedUsers.push(fromId);
          persistSettings();
        }
        await ctx.answerCallbackQuery({ text: '✅ 验证通过！' });
        try {
          await ctx.editMessageText('✅ 人机验证通过，现在可以正常发送消息了。');
        } catch (e) { }
        return;
      }

      // 面板按钮（仅创建者）
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: '只有机器人管理员可以操作', show_alert: true });
        return;
      }

      if (data === 'toggle_ban') {
        settings.useGlobalBan = !settings.useGlobalBan;
        persistSettings();
        await ctx.answerCallbackQuery({ text: `联合封禁已${settings.useGlobalBan ? '开启' : '关闭'}` });
        try {
          await ctx.editMessageText(buildPanelText(settings), { reply_markup: buildPanelKeyboard(settings) });
        } catch (e) { }
      } else if (data === 'toggle_captcha') {
        settings.useCaptcha = !settings.useCaptcha;
        persistSettings();
        await ctx.answerCallbackQuery({ text: `人机验证已${settings.useCaptcha ? '开启' : '关闭'}` });
        try {
          await ctx.editMessageText(buildPanelText(settings), { reply_markup: buildPanelKeyboard(settings) });
        } catch (e) { }
      } else if (data === 'show_broadcast') {
        await ctx.answerCallbackQuery({
          text: '发送 /mybroadcast 加消息内容即可广播，例如：/mybroadcast 大家好',
          show_alert: true
        });
      }
    });

    bot.catch((err) => {
      console.error(`[${botId}] 运行错误: ${err.message || err}`);
    });
  }

  // ---------- 休眠与唤醒 ----------
  resetIdleTimer(botId) {
    const inst = this.instances.get(botId);
    if (!inst) return;
    if (inst.idleTimer) clearTimeout(inst.idleTimer);
    inst.idleTimer = setTimeout(() => this.sleepBot(botId), IDLE_TIMEOUT_MS);
  }

  async sleepBot(botId) {
    const inst = this.instances.get(botId);
    if (!inst) return;
    console.log(`[@${inst.username}] 闲置超时，进入休眠`);
    try { await inst.bot.stop(); } catch (e) { }
    this.instances.delete(botId);
    this.sleeping.add(botId);
  }

  async wakeBot(botId) {
    if (this.instances.has(botId)) return;
    const data = Store.listBots().find(b => b.bot_id === botId);
    if (!data) return;
    console.log(`[@${data.username}] 检测到新消息，自动唤醒`);
    try {
      await this.createBot(data.token, data.owner_id);
      this.sleeping.delete(botId);
    } catch (e) {
      console.error(`[@${data.username}] 唤醒失败: ${e.message}`);
    }
  }

  startDaemonTasks() {
    if (!this.idleCheckTimer) {
      this.idleCheckTimer = setInterval(() => {
        const now = Date.now();
        this.instances.forEach((inst, botId) => {
          if (now - inst.lastActivity > IDLE_TIMEOUT_MS) this.sleepBot(botId);
        });
      }, 60 * 1000);
    }
    if (!this.wakeupTimer) {
      this.wakeupTimer = setInterval(async () => {
        if (this.sleeping.size === 0) return;
        for (const botId of this.sleeping) {
          const data = Store.listBots().find(b => b.bot_id === botId);
          if (!data) { this.sleeping.delete(botId); continue; }
          try {
            const testBot = new Bot(data.token, { client: { apiRoot: API_ROOT } });
            const updates = await testBot.api.getUpdates({ timeout: 0, limit: 1 });
            if (updates && updates.length > 0) await this.wakeBot(botId);
          } catch (e) {
            console.error(`[@${data.username}] 探测失败: ${e.message}`);
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

  async broadcastToUsers(botToken, userIds, message) {
    const bot = new Bot(botToken, { client: { apiRoot: API_ROOT } });
    let success = 0, failed = 0;
    for (let i = 0; i < userIds.length; i++) {
      try {
        await bot.api.sendMessage(userIds[i], message);
        success++;
      } catch (e) {
        failed++;
      }
      if (i % BROADCAST_RATE_LIMIT === BROADCAST_RATE_LIMIT - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    return { success, failed };
  }

  getStats() {
    return {
      running: this.instances.size,
      sleeping: this.sleeping.size
    };
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
  console.log(`正在恢复 ${existing.length} 个已有 Bot...`);
  for (const r of existing) {
    try {
      await manager.createBot(r.token, r.owner_id);
      console.log(`  ✅ @${r.username} 已恢复`);
    } catch (e) {
      console.error(`  ❌ @${r.username} 恢复失败: ${e.message}`);
    }
  }

  const masterBot = new Bot(MASTER_TOKEN, { client: { apiRoot: API_ROOT } });

  function isMasterAdmin(ctx) {
    return ctx.from && ctx.from.id.toString() === ADMIN_ID;
  }

  masterBot.command('start', async (ctx) => {
    if (isMasterAdmin(ctx)) {
      await ctx.reply(`🤖 TGBOT Master 管理面板

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
/broadcast <消息> - 平台级广播
/sendto <用户ID> <消息> - 发送给指定用户
/stats - 查看服务器状态`);
    } else {
      await ctx.reply(`👋 欢迎使用机器人托管平台！

发送 /create 加上你的 Bot Token，即可一键创建属于你自己的双向私聊机器人。

例如：
/create 123456:ABCdef...

Token 可以在 @BotFather 处免费申请。`);
    }
  });

  masterBot.command('create', async (ctx) => {
    const token = ctx.match ? ctx.match.trim() : '';
    if (!token || token.indexOf(':') === -1) {
      await ctx.reply(`⚠️ 用法：/create <BotToken>
例如：/create 123456:ABCdef...`);
      return;
    }

    const myBots = Store.listBots().filter(b => b.owner_id === ctx.from.id.toString());
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
      await ctx.reply(`🎉 机器人创建成功！

🤖 @${result.username}（ID: ${result.botId}）

接下来请完成配置：
1. 创建一个超级群组，并在群设置中开启「话题」功能
2. 将 @${result.username} 拉入群组并设为管理员
3. 私聊 @${result.username} 发送：/setchat 群ID
   （群 ID 以 -100 开头）
4. 私聊 @${result.username} 发送 /panel 可设置联合封禁和人机验证
5. 发送 /mybroadcast <消息> 可广播给你的用户

完成后，任何人私聊你的机器人，消息都会出现在群组对应的话题里。`);
    } catch (error) {
      await ctx.reply(`❌ 创建失败：${error.message}`);
    }
  });

  masterBot.command('list', async (ctx) => {
    if (!isMasterAdmin(ctx)) return;
    const bots = Store.listBots();
    if (bots.length === 0) {
      await ctx.reply('📭 尚未创建任何 Bot');
      return;
    }
    let msg = `📋 已创建的 Bot（共 ${bots.length} 个）：

`;
    for (const b of bots) {
      msg += `🤖 @${b.username}
  ID: ${b.bot_id}
  创建者: ${b.owner_id}
  创建时间: ${b.created_at}

`;
    }
    await ctx.reply(msg);
  });

  masterBot.command('delete', async (ctx) => {
    if (!isMasterAdmin(ctx)) return;
    const botId = ctx.match ? ctx.match.trim() : '';
    if (!botId) {
      await ctx.reply('⚠️ 用法：/delete <botId>');
      return;
    }
    try {
      await manager.deleteBot(botId);
      await ctx.reply(`✅ Bot ${botId} 已停止并删除`);
    } catch (error) {
      await ctx.reply(`❌ 删除失败: ${error.message}`);
    }
  });

  masterBot.command('sleep', async (ctx) => {
    if (!isMasterAdmin(ctx)) return;
    const botId = ctx.match ? ctx.match.trim() : '';
    if (!botId) {
      await ctx.reply('⚠️ 用法：/sleep <botId>');
      return;
    }
    await manager.sleepBot(botId);
    await ctx.reply(`💤 Bot ${botId} 已休眠，下次有消息时自动唤醒`);
  });

  masterBot.command('wake', async (ctx) => {
    if (!isMasterAdmin(ctx)) return;
    const botId = ctx.match ? ctx.match.trim() : '';
    if (!botId) {
      await ctx.reply('⚠️ 用法：/wake <botId>');
      return;
    }
    await manager.wakeBot(botId);
    await ctx.reply(`⏰ Bot ${botId} 已唤醒`);
  });

  masterBot.command('ban', async (ctx) => {
    if (!isMasterAdmin(ctx)) return;
    const userId = ctx.match ? ctx.match.trim() : '';
    if (!userId) {
      await ctx.reply('⚠️ 用法：/ban <用户ID>');
      return;
    }
    Store.addToBanlist(userId);
    await ctx.reply(`🚫 用户 ${userId} 已加入联合封禁列表
所有开启了联合封禁的 Bot 将不再接收此用户的消息。`);
  });

  masterBot.command('unban', async (ctx) => {
    if (!isMasterAdmin(ctx)) return;
    const userId = ctx.match ? ctx.match.trim() : '';
    if (!userId) {
      await ctx.reply('⚠️ 用法：/unban <用户ID>');
      return;
    }
    Store.removeFromBanlist(userId);
    await ctx.reply(`✅ 用户 ${userId} 已从联合封禁列表移除`);
  });

  masterBot.command('banlist', async (ctx) => {
    if (!isMasterAdmin(ctx)) return;
    const banlist = Store.getBanlist();
    if (banlist.length === 0) {
      await ctx.reply('📭 封禁列表为空');
      return;
    }
    let msg = `🚫 联合封禁列表（共 ${banlist.length} 人）：

`;
    for (const id of banlist) {
      msg += `• ${id}
`;
    }
    await ctx.reply(msg);
  });

  masterBot.command('broadcast', async (ctx) => {
    if (!isMasterAdmin(ctx)) return;
    const message = ctx.match ? ctx.match.trim() : '';
    if (!message) {
      await ctx.reply(`⚠️ 用法：/broadcast <消息内容>
例如：/broadcast 平台将于今晚 10 点维护。`);
      return;
    }

    const bots = Store.listBots();
    if (bots.length === 0) {
      await ctx.reply('📭 尚未创建任何 Bot，无法广播。');
      return;
    }

    await ctx.reply(`🔄 开始平台级广播，覆盖 ${bots.length} 个 Bot，请稍候...`);

    let totalSuccess = 0, totalFailed = 0, totalSkipped = 0;
    const banlist = Store.getBanlist();

    for (const botData of bots) {
      const users = Store.getUsersForBot(botData.bot_id);
      if (users.length === 0) continue;

      const settings = Store.getBotSettings(botData.bot_id);
      const filteredUsers = users.filter(userId => {
        if (settings.useGlobalBan && banlist.indexOf(userId) !== -1) {
          totalSkipped++;
          return false;
        }
        return true;
      });
      if (filteredUsers.length === 0) continue;

      try {
        const result = await manager.broadcastToUsers(botData.token, filteredUsers, message);
        totalSuccess += result.success;
        totalFailed += result.failed;
      } catch (e) {
        console.error(`[@${botData.username}] 广播失败: ${e.message}`);
        totalFailed += filteredUsers.length;
      }
    }

    await ctx.reply(`✅ 平台级广播完成

📤 成功: ${totalSuccess}
❌ 失败: ${totalFailed}
⏭ 跳过(已封禁): ${totalSkipped}`);
  });

  masterBot.command('sendto', async (ctx) => {
    if (!isMasterAdmin(ctx)) return;
    const args = ctx.match ? ctx.match.trim() : '';
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply(`⚠️ 用法：/sendto <用户ID> <消息>
例如：/sendto 123456789 你好`);
      return;
    }
    const userId = parts[0];
    const message = parts.slice(1).join(' ');

    const bots = Store.listBots();
    let targetBot = null;
    for (const b of bots) {
      const users = Store.getUsersForBot(b.bot_id);
      if (users.indexOf(userId) !== -1) {
        targetBot = b;
        break;
      }
    }

    if (!targetBot) {
      await ctx.reply('❌ 未找到该用户，或该用户从未给任何 Bot 发过消息。');
      return;
    }

    try {
      const result = await manager.broadcastToUsers(targetBot.token, [userId], message);
      if (result.success > 0) {
        await ctx.reply(`✅ 已通过 @${targetBot.username} 发送给用户 ${userId}`);
      } else {
        await ctx.reply('❌ 发送失败，用户可能已屏蔽 Bot。');
      }
    } catch (e) {
      await ctx.reply(`❌ 发送失败: ${e.message}`);
    }
  });

  masterBot.command('stats', async (ctx) => {
    if (!isMasterAdmin(ctx)) return;
    const stats = manager.getStats();
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    await ctx.reply(`📊 服务器状态

🟢 运行中 Bot: ${stats.running} 个
💤 休眠中 Bot: ${stats.sleeping} 个
🚫 联合封禁: ${Store.getBanlist().length} 人
💾 内存占用: ${(mem.rss / 1024 / 1024).toFixed(1)} MB
🖥 CPU 用户时间: ${(cpu.user / 1000000).toFixed(2)} s
🖥 CPU 系统时间: ${(cpu.system / 1000000).toFixed(2)} s`);
  });

  masterBot.catch((err) => {
    console.error(`[master] 运行错误: ${err.message || err}`);
  });

  masterBot.start();
  console.log('✅ TGBOT Master 已启动');
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
