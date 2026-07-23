const { Bot } = require('grammy');
const fs = require('fs');
const path = require('path');

// ========== 配置区（在服务器上用 sed 修改，不要提交真实值）==========
const MASTER_TOKEN = 'PASTE_YOUR_MASTER_BOT_TOKEN_HERE';
const ADMIN_ID = 'PASTE_YOUR_TELEGRAM_USER_ID_HERE';
const API_ROOT = 'https://bot.143259.xyz';
// ===================================================================

const DB_FILE = path.join(__dirname, 'bots.json');

// 休眠配置
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;   // 闲置 10 分钟后休眠
const WAKEUP_INTERVAL_MS = 60 * 1000;     // 每 60 秒探测一次休眠中的 Bot
const POLL_TIMEOUT = 60;                   // 长轮询挂起时间（秒）

// ---------------- 数据存储（JSON 文件） ----------------
const Store = {
  load() {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      return { bots: [], kv: {} };
    }
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
  }
};

// ---------------- Bot 实例管理器 ----------------
class BotManager {
  constructor() {
    this.instances = new Map();   // botId -> { bot, username, token, ownerId, lastActivity, idleTimer }
    this.sleeping = new Set();    // 已休眠的 botId
    this.wakeupTimer = null;
    this.idleCheckTimer = null;
  }

  async createBot(token, ownerId) {
    const testBot = new Bot(token, { client: { apiRoot: API_ROOT } });
    const me = await testBot.api.getMe();
    const botId = me.id.toString();
    const username = me.username;

    if (this.instances.has(botId)) {
      throw new Error('Bot @' + username + ' 已在运行中');
    }
    if (this.sleeping.has(botId)) {
      this.sleeping.delete(botId);
    }

    const bot = new Bot(token, { client: { apiRoot: API_ROOT } });
    this.registerHandlers(bot, botId, ownerId);

    const self = this;
    const instance = {
      bot: bot,
      username: username,
      token: token,
      ownerId: ownerId,
      lastActivity: Date.now(),
      idleTimer: null
    };

    bot.start({
      timeout: POLL_TIMEOUT,
      onStart: function () {
        console.log('[@' + username + '] long polling started');
      }
    });

    this.instances.set(botId, instance);
    this.resetIdleTimer(botId);

    Store.addBot({
      bot_id: botId,
      username: username,
      token: token,
      owner_id: ownerId,
      created_at: new Date().toISOString(),
      status: 'running'
    });

    // 启动守护任务（如果还没启动）
    this.startDaemonTasks();

    return { botId: botId, username: username };
  }

  registerHandlers(bot, botId, ownerId) {
    const kv = new Map(Object.entries(Store.getKV(botId)));

    function persistKV() {
      const obj = {};
      kv.forEach(function (value, key) { obj[key] = value; });
      Store.setKV(botId, obj);
    }

    function isAdmin(ctx) {
      return ctx.from && ctx.from.id.toString() === ownerId;
    }

    // 每次收到消息都刷新活动时间（用于休眠判断）
    const self = this;
    bot.use(async function (ctx, next) {
      const inst = self.instances.get(botId);
      if (inst) {
        inst.lastActivity = Date.now();
        self.resetIdleTimer(botId);
      }
      await next();
    });

    bot.command('start', async function (ctx) {
      if (ctx.chat.type !== 'private') return;
      if (isAdmin(ctx)) {
        await ctx.reply(
          '✅ 双向私聊机器人已启动

' +
          '管理命令：
' +
          '/setchat <群ID> - 设置话题群
' +
          '/topicgroup - 查看当前话题群
' +
          '/cleartopicgroup - 清除话题群设置'
        );
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
        await ctx.reply('⚠️ 用法：/setchat -100xxxxxxxxx
群 ID 必须以 -100 开头，且群已开启话题功能。');
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

    bot.on('message', async function (ctx) {
      const msg = ctx.message;
      if (!ctx.from) return;
      const fromId = ctx.from.id.toString();
      if (msg.text && msg.text.indexOf('/') === 0) return;

      if (isAdmin(ctx) && ctx.chat.type === 'supergroup' && msg.message_thread_id) {
        const topicId = msg.message_thread_id.toString();
        const userChatId = kv.get('topic:' + topicId);
        if (userChatId) {
          await forwardMessage(bot, userChatId, msg);
        }
        return;
      }

      if (ctx.chat.type === 'private' && !isAdmin(ctx)) {
        const topicGroup = kv.get('topic_group');
        if (!topicGroup) return;

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

    bot.catch(function (err) {
      console.error('[' + botId + '] 运行错误: ' + (err.message || err));
    });
  }

  // ---------- 休眠与唤醒 ----------
  resetIdleTimer(botId) {
    const inst = this.instances.get(botId);
    if (!inst) return;

    if (inst.idleTimer) {
      clearTimeout(inst.idleTimer);
    }

    const self = this;
    inst.idleTimer = setTimeout(function () {
      self.sleepBot(botId);
    }, IDLE_TIMEOUT_MS);
  }

  async sleepBot(botId) {
    const inst = this.instances.get(botId);
    if (!inst) return;

    console.log('[@' + inst.username + '] 闲置超时，进入休眠');
    try {
      await inst.bot.stop();
    } catch (e) {
      // 忽略停止时的错误
    }
    this.instances.delete(botId);
    this.sleeping.add(botId);
  }

  async wakeBot(botId) {
    const inst = this.instances.get(botId);
    if (inst) return; // 已在运行

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

    // 闲置检测：每 60 秒扫一次
    if (!this.idleCheckTimer) {
      this.idleCheckTimer = setInterval(function () {
        const now = Date.now();
        self.instances.forEach(function (inst, botId) {
          if (now - inst.lastActivity > IDLE_TIMEOUT_MS) {
            self.sleepBot(botId);
          }
        });
      }, 60 * 1000);
    }

    // 唤醒探测：每 60 秒对所有休眠 Bot 探测一次 pending updates
    if (!this.wakeupTimer) {
      this.wakeupTimer = setInterval(async function () {
        if (self.sleeping.size === 0) return;

        for (const botId of self.sleeping) {
          const data = Store.listBots().find(function (b) { return b.bot_id === botId; });
          if (!data) {
            self.sleeping.delete(botId);
            continue;
          }
          try {
            const testBot = new Bot(data.token, { client: { apiRoot: API_ROOT } });
            const updates = await testBot.api.getUpdates({ timeout: 0, limit: 1 });
            if (updates && updates.length > 0) {
              await self.wakeBot(botId);
            }
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

// ---------------- 主机器人（管理面板） ----------------
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
      await ctx.reply(
        '🤖 TGBOT Master 管理面板

' +
        '开放功能（所有人可用）：
' +
        '/create <BotToken> - 一键创建你自己的双向私聊机器人

' +
        '管理员功能：
' +
        '/list - 查看所有 Bot
' +
        '/delete <botId> - 删除 Bot
' +
        '/sleep <botId> - 手动休眠 Bot
' +
        '/wake <botId> - 手动唤醒 Bot
' +
        '/stats - 查看服务器状态'
      );
    } else {
      await ctx.reply(
        '👋 欢迎使用机器人托管平台！

' +
        '发送 /create 加上你的 Bot Token，即可一键创建属于你自己的双向私聊机器人。

' +
        '例如：
/create 123456:ABCdef...

' +
        'Token 可以在 @BotFather 处免费申请。'
      );
    }
  });

  masterBot.command('create', async function (ctx) {
    const token = ctx.match ? ctx.match.trim() : '';
    if (!token || token.indexOf(':') === -1) {
      await ctx.reply('⚠️ 用法：/create <BotToken>
例如：/create 123456:ABCdef...');
      return;
    }

    // 每人最多 3 个
    const myBots = Store.listBots().filter(function (b) {
      return b.owner_id === ctx.from.id.toString();
    });
    if (myBots.length >= 3) {
      await ctx.reply('⚠️ 每人最多创建 3 个机器人，你已达上限。');
      return;
    }

    // 平台总容量上限
    if (Store.listBots().length >= 50) {
      await ctx.reply('⚠️ 平台已达容量上限，请稍后再试或联系管理员。');
      return;
    }

    await ctx.reply('🔄 正在验证 Token 并创建机器人，请稍候...');
    try {
      const result = await manager.createBot(token, ctx.from.id.toString());
      await ctx.reply(
        '🎉 机器人创建成功！

' +
        '🤖 @' + result.username + '（ID: ' + result.botId + '）

' +
        '接下来请完成配置：
' +
        '1. 创建一个超级群组，并在群设置中开启「话题」功能
' +
        '2. 将 @' + result.username + ' 拉入群组并设为管理员
' +
        '3. 私聊 @' + result.username + ' 发送：/setchat 群ID
' +
        '   （群 ID 以 -100 开头）

' +
        '完成后，任何人私聊你的机器人，消息都会出现在群组对应的话题里。'
      );
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
';
      msg += '  ID: ' + b.bot_id + '
';
      msg += '  创建者: ' + b.owner_id + '
';
      msg += '  创建时间: ' + b.created_at + '

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

  masterBot.command('stats', async function (ctx) {
    if (!isMasterAdmin(ctx)) return;
    const stats = manager.getStats();
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    await ctx.reply(
      '📊 服务器状态

' +
      '🟢 运行中 Bot: ' + stats.running + ' 个
' +
      '💤 休眠中 Bot: ' + stats.sleeping + ' 个
' +
      '💾 内存占用: ' + (mem.rss / 1024 / 1024).toFixed(1) + ' MB
' +
      '🖥 CPU 用户时间: ' + (cpu.user / 1000000).toFixed(2) + ' s
' +
      '🖥 CPU 系统时间: ' + (cpu.system / 1000000).toFixed(2) + ' s'
    );
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
