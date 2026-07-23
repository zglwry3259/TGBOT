const { Bot } = require('grammy');
const fs = require('fs');
const path = require('path');

// ========== 配置区（在服务器上用 sed 修改，不要提交真实值）==========
const MASTER_TOKEN = 'PASTE_YOUR_MASTER_BOT_TOKEN_HERE';
const ADMIN_ID = 'PASTE_YOUR_TELEGRAM_USER_ID_HERE';
const API_ROOT = 'https://bot.143259.xyz';
// ===================================================================

const DB_FILE = path.join(__dirname, 'bots.json');

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
    this.instances = new Map();
  }

  async createBot(token, ownerId) {
    const testBot = new Bot(token, { client: { apiRoot: API_ROOT } });
    const me = await testBot.api.getMe();
    const botId = me.id.toString();
    const username = me.username;

    if (this.instances.has(botId)) {
      throw new Error('Bot @' + username + ' 已在运行中');
    }

    const bot = new Bot(token, { client: { apiRoot: API_ROOT } });
    this.registerHandlers(bot, botId, ownerId);

    bot.start({
      timeout: 50,
      onStart: function () {
        console.log('[@' + username + '] long polling started');
      }
    });

    this.instances.set(botId, {
      bot: bot,
      username: username,
      token: token,
      ownerId: ownerId
    });

    Store.addBot({
      bot_id: botId,
      username: username,
      token: token,
      owner_id: ownerId,
      created_at: new Date().toISOString(),
      status: 'running'
    });

    return { botId: botId, username: username };
  }

  registerHandlers(bot, botId, ownerId) {
    // 每个 Bot 独立的键值存储（话题群设置、用户-话题映射）
    const kv = new Map(Object.entries(Store.getKV(botId)));

    function persistKV() {
      const obj = {};
      kv.forEach(function (value, key) { obj[key] = value; });
      Store.setKV(botId, obj);
    }

    function isAdmin(ctx) {
      return ctx.from && ctx.from.id.toString() === ownerId;
    }

    bot.command('start', async function (ctx) {
      if (ctx.chat.type !== 'private') return;
      if (isAdmin(ctx)) {
        await ctx.reply(
          '✅ 双向私聊机器人已启动\n\n' +
          '管理命令：\n' +
          '/setchat <群ID> - 设置话题群\n' +
          '/topicgroup - 查看当前话题群\n' +
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
        await ctx.reply('⚠️ 用法：/setchat -100xxxxxxxxx\n群 ID 必须以 -100 开头，且群已开启话题功能。');
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

      // 情况一：管理员在话题群中发言 → 转发给对应用户
      if (isAdmin(ctx) && ctx.chat.type === 'supergroup' && msg.message_thread_id) {
        const topicId = msg.message_thread_id.toString();
        const userChatId = kv.get('topic:' + topicId);
        if (userChatId) {
          await forwardMessage(bot, userChatId, msg);
        }
        return;
      }

      // 情况二：普通用户私聊 → 转发到话题群
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

  async deleteBot(botId) {
    const ins = this.instances.get(botId);
    if (ins) {
      try { await ins.bot.stop(); } catch (e) { }
      this.instances.delete(botId);
    }
    Store.removeBot(botId);
  }

  getStats() {
    return {
      total: this.instances.size,
      instances: Array.from(this.instances.entries()).map(function (entry) {
        return {
          botId: entry[0],
          username: entry[1].username,
          ownerId: entry[1].ownerId
        };
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

  // 重启后自动恢复所有已创建的 Bot
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
        '🤖 TGBOT Master 管理面板\n\n' +
        '开放功能（所有人可用）：\n' +
        '/create <BotToken> - 一键创建你自己的双向私聊机器人\n\n' +
        '管理员功能：\n' +
        '/list - 查看所有 Bot\n' +
        '/delete <botId> - 删除 Bot\n' +
        '/stats - 查看服务器状态'
      );
    } else {
      await ctx.reply(
        '👋 欢迎使用机器人托管平台！\n\n' +
        '发送 /create 加上你的 Bot Token，即可一键创建属于你自己的双向私聊机器人。\n\n' +
        '例如：\n/create 123456:ABCdef...\n\n' +
        'Token 可以在 @BotFather 处免费申请。'
      );
    }
  });

  // 所有用户都可以创建自己的 Bot，创建者自动成为该 Bot 的管理员
  masterBot.command('create', async function (ctx) {
    const token = ctx.match ? ctx.match.trim() : '';
    if (!token || token.indexOf(':') === -1) {
      await ctx.reply('⚠️ 用法：/create <BotToken>\n例如：/create 123456:ABCdef...');
      return;
    }
    await ctx.reply('🔄 正在验证 Token 并创建机器人，请稍候...');
    try {
      const result = await manager.createBot(token, ctx.from.id.toString());
      await ctx.reply(
        '🎉 机器人创建成功！\n\n' +
        '🤖 @' + result.username + '（ID: ' + result.botId + '）\n\n' +
        '接下来请完成配置：\n' +
        '1. 创建一个超级群组，并在群设置中开启「话题」功能\n' +
        '2. 将 @' + result.username + ' 拉入群组并设为管理员\n' +
        '3. 私聊 @' + result.username + ' 发送：/setchat 群ID\n' +
        '   （群 ID 以 -100 开头）\n\n' +
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
    let msg = '📋 已创建的 Bot（共 ' + bots.length + ' 个）：\n\n';
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      msg += '🤖 @' + b.username + '\n';
      msg += '  ID: ' + b.bot_id + '\n';
      msg += '  创建者: ' + b.owner_id + '\n';
      msg += '  创建时间: ' + b.created_at + '\n\n';
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

  masterBot.command('stats', async function (ctx) {
    if (!isMasterAdmin(ctx)) return;
    const stats = manager.getStats();
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    await ctx.reply(
      '📊 服务器状态\n\n' +
      '🤖 运行中 Bot: ' + stats.total + ' 个\n' +
      '💾 内存占用: ' + (mem.rss / 1024 / 1024).toFixed(1) + ' MB\n' +
      '🖥 CPU 用户时间: ' + (cpu.user / 1000000).toFixed(2) + ' s\n' +
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
