require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { execFile } = require('child_process');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysystems/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');

const DOWNLOAD_DIR = path.join(__dirname, '../downloads');
const DATA_DIR = path.join(__dirname, '../data');
const STATE_FILE = path.join(DATA_DIR, 'bot-state.json');
const SPAM_TRACKER = new Map();
const BANNED_USERS = new Map();
const COMMAND_PREFIX = '!';
const botState = {
  connection: 'offline',
  groups: [],
  logs: [],
  socket: null,
};

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

async function ensureStorage() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.promises.access(STATE_FILE);
  } catch {
    await fs.promises.writeFile(STATE_FILE, JSON.stringify({ logs: [] }, null, 2));
  }
}

async function loadPersistedState() {
  await ensureStorage();
  try {
    const raw = await fs.promises.readFile(STATE_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    if (Array.isArray(data.logs)) {
      botState.logs = data.logs;
    }
  } catch (error) {
    console.error('Failed to load persisted state:', error.message);
  }
}

async function savePersistedState() {
  await ensureStorage();
  await fs.promises.writeFile(
    STATE_FILE,
    JSON.stringify({ logs: botState.logs.slice(-50) }, null, 2),
    'utf8'
  );
}

function addLog(message) {
  botState.logs.push({
    time: new Date().toISOString(),
    message,
  });

  if (botState.logs.length > 50) {
    botState.logs = botState.logs.slice(-50);
  }

  savePersistedState().catch(() => {});
}

function buildStatus() {
  return {
    connection: botState.connection,
    groups: botState.groups,
    bannedUsers: Array.from(BANNED_USERS.entries()).map(([id, expiresAt]) => ({
      id,
      expiresAt: new Date(expiresAt).toISOString(),
    })),
    spamTracker: Array.from(SPAM_TRACKER.entries()).map(([id, times]) => ({
      id,
      recentCount: times.length,
    })),
    logs: botState.logs.slice(-20),
  };
}

function startDashboard() {
  const app = express();
  const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || 3000);

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'change-this-secret-key',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax' },
    })
  );

  app.use((req, res, next) => {
    const publicRoutes = ['/login', '/api/login', '/health', '/'];
    if (publicRoutes.includes(req.path) || req.path.startsWith('/assets')) {
      return next();
    }

    if (req.session && req.session.authenticated) {
      return next();
    }

    return res.redirect('/login');
  });

  app.get('/login', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/login.html'));
  });

  app.post('/api/login', (req, res) => {
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      req.session.authenticated = true;
      req.session.username = username;
      return res.json({ ok: true, redirect: '/' });
    }

    return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  });

  app.get('/api/status', (_req, res) => {
    res.json(buildStatus());
  });

  app.get('/api/members/:groupId', async (req, res) => {
    try {
      const { groupId } = req.params;
      if (!botState.socket) {
        return res.status(503).json({ error: 'Bot is not connected.' });
      }

      const metadata = await botState.socket.groupMetadata(groupId);
      return res.json({ groupId, members: metadata.participants || [] });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Unable to fetch members.' });
    }
  });

  app.post('/api/send', async (req, res) => {
    try {
      const { groupId, text } = req.body || {};
      if (!groupId || !text) {
        return res.status(400).json({ error: 'groupId and text are required.' });
      }

      if (!botState.socket) {
        return res.status(503).json({ error: 'WhatsApp bot is not connected yet.' });
      }

      await botState.socket.sendMessage(groupId, { text });
      addLog(`Dashboard sent message to ${groupId}`);
      return res.json({ ok: true, message: 'Message sent.' });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to send message.' });
    }
  });

  app.post('/api/ban', async (req, res) => {
    try {
      const { groupId, userId } = req.body || {};
      if (!groupId || !userId) {
        return res.status(400).json({ error: 'groupId and userId are required.' });
      }

      if (!botState.socket) {
        return res.status(503).json({ error: 'WhatsApp bot is not connected yet.' });
      }

      await botState.socket.groupParticipantsUpdate(groupId, [userId], 'remove');
      BANNED_USERS.set(userId, Date.now() + 60 * 60 * 1000);
      addLog(`Dashboard banned ${userId} in ${groupId}`);
      return res.json({ ok: true, message: `User ${userId} banned.` });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to ban user.' });
    }
  });

  app.post('/api/unban', async (req, res) => {
    try {
      const { userId } = req.body || {};
      if (!userId) {
        return res.status(400).json({ error: 'userId is required.' });
      }

      BANNED_USERS.delete(userId);
      addLog(`Dashboard unbanned ${userId}`);
      return res.json({ ok: true, message: `User ${userId} unbanned.` });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to unban user.' });
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, status: botState.connection });
  });

  app.get('/', (req, res) => {
    if (req.session && req.session.authenticated) {
      return res.sendFile(path.join(__dirname, '../public/index.html'));
    }
    return res.redirect('/login');
  });

  app.use(express.static(path.join(__dirname, '../public')));

  app.listen(port, () => {
    console.log(`Admin dashboard running at http://localhost:${port}`);
    addLog(`Dashboard started on port ${port}`);
  });
}

startDashboard();

async function ensureDownloadDir() {
  await fs.promises.mkdir(DOWNLOAD_DIR, { recursive: true });
}

function parseCommand(text) {
  if (!text || !text.startsWith(COMMAND_PREFIX)) return null;
  const [command, ...args] = text.slice(1).trim().split(/\s+/);
  return { command: command.toLowerCase(), args, raw: text };
}

function getSenderKey(msg) {
  const sender = msg.key.participant || msg.key.remoteJid;
  return sender || msg.key.remoteJid;
}

function isGroupMessage(msg) {
  return !!(msg.key && msg.key.remoteJid && msg.key.remoteJid.includes('@g.us'));
}

function isBanned(sender) {
  const expiry = BANNED_USERS.get(sender);
  if (!expiry) return false;

  if (Date.now() > expiry) {
    BANNED_USERS.delete(sender);
    return false;
  }

  return true;
}

function registerSpam(sender, messageText) {
  const now = Date.now();
  const bucket = SPAM_TRACKER.get(sender) || [];
  const recent = bucket.filter((ts) => now - ts <= 60_000);
  recent.push(now);
  SPAM_TRACKER.set(sender, recent);

  const linkSpam = /https?:\/\//i.test(messageText) && recent.length >= 3;
  const floodSpam = recent.length >= 12;

  return linkSpam || floodSpam;
}

async function getGroupAdminIds(sock, groupJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    return new Set(metadata.participants.filter((p) => p.admin).map((p) => p.id));
  } catch (error) {
    return new Set();
  }
}

async function isGroupAdmin(sock, groupJid, sender) {
  const admins = await getGroupAdminIds(sock, groupJid);
  return admins.has(sender);
}

async function downloadVideo(url, label) {
  await ensureDownloadDir();

  const outputPattern = path.join(DOWNLOAD_DIR, `${label}-${Date.now()}.%(ext)s`);

  return new Promise((resolve, reject) => {
    execFile(
      'yt-dlp',
      [
        '--no-warnings',
        '--no-playlist',
        '--restrict-filenames',
        '-f',
        'bestvideo+bestaudio/best',
        '--merge-output-format',
        'mp4',
        '-o',
        outputPattern,
        url,
      ],
      { maxBuffer: 512 * 1024 * 1024 },
      async (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message || 'Download failed'));
          return;
        }

        try {
          const files = await fs.promises.readdir(DOWNLOAD_DIR);
          const validFiles = files
            .filter((file) => file.startsWith(label))
            .map((file) => ({ file, time: fs.statSync(path.join(DOWNLOAD_DIR, file)).mtimeMs }))
            .sort((a, b) => b.time - a.time);

          if (!validFiles.length) {
            reject(new Error('Downloaded file not found'));
            return;
          }

          resolve(path.join(DOWNLOAD_DIR, validFiles[0].file));
        } catch (innerError) {
          reject(innerError);
        }
      }
    );
  });
}

async function sendDownloadedVideo(sock, chatId, filePath, sourceLabel) {
  const fileBuffer = await fs.promises.readFile(filePath);
  const fileName = path.basename(filePath);

  await sock.sendMessage(chatId, {
    video: fileBuffer,
    mimetype: 'video/mp4',
    fileName,
    caption: `Downloaded from ${sourceLabel}`,
  });
}

async function handleDownloadCommand(sock, message, url, kind) {
  const chatId = message.key.remoteJid;
  const sender = getSenderKey(message);

  if (!url) {
    await sock.sendMessage(chatId, { text: `Please provide a valid ${kind} URL.` });
    return;
  }

  await sock.sendMessage(chatId, { text: `Downloading ${kind} media, please wait...` });

  try {
    const label = `${kind}-${Date.now()}`;
    const filePath = await downloadVideo(url, label);
    await sendDownloadedVideo(sock, chatId, filePath, kind.toUpperCase());
    await sock.sendMessage(chatId, { text: `Media sent to ${sender}.` });
  } catch (error) {
    await sock.sendMessage(chatId, {
      text: `The ${kind} download failed: ${error.message}`,
    });
  }
}

async function banUser(sock, groupJid, userId) {
  if (!userId) return false;

  try {
    await sock.groupParticipantsUpdate(groupJid, [userId], 'remove');
    BANNED_USERS.set(userId, Date.now() + 60 * 60 * 1000);
    return true;
  } catch (error) {
    return false;
  }
}

async function handleMessage(sock, message) {
  if (!message.message || message.key.fromMe) return;

  const chatId = message.key.remoteJid;
  const sender = getSenderKey(message);
  const text = message.message.conversation || message.message.extendedTextMessage?.text || '';

  if (!text) return;

  if (isGroupMessage(message) && isBanned(sender)) {
    await sock.sendMessage(chatId, {
      text: 'This user is currently banned by the anti-spam system.',
    });
    return;
  }

  const command = parseCommand(text);
  if (command) {
    const { command: name, args } = command;

    if (name === 'help') {
      await sock.sendMessage(chatId, {
        text: 'Commands:\n!help\n!yt <url>\n!tt <url> or !tiktok <url>\n!ban @user\n!unban @user\n!spamstatus',
      });
      return;
    }

    if (name === 'spamstatus') {
      const total = SPAM_TRACKER.size;
      await sock.sendMessage(chatId, { text: `Spam tracker entries: ${total}` });
      return;
    }

    if (name === 'yt') {
      await handleDownloadCommand(sock, message, args[0], 'youtube');
      return;
    }

    if (name === 'tt' || name === 'tiktok') {
      await handleDownloadCommand(sock, message, args[0], 'tiktok');
      return;
    }

    if (name === 'ban') {
      if (!isGroupMessage(message)) {
        await sock.sendMessage(chatId, { text: 'This command only works in a group.' });
        return;
      }

      const isAdmin = await isGroupAdmin(sock, chatId, sender);
      if (!isAdmin) {
        await sock.sendMessage(chatId, { text: 'Only group admins can ban users.' });
        return;
      }

      const target = message.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0];
      if (!target) {
        await sock.sendMessage(chatId, { text: 'Please mention a user or provide a JID to ban.' });
        return;
      }

      const success = await banUser(sock, chatId, target);
      await sock.sendMessage(chatId, {
        text: success ? `User ${target} has been removed from the group.` : 'Unable to ban the user.',
      });
      return;
    }

    if (name === 'unban') {
      if (!isGroupMessage(message)) {
        await sock.sendMessage(chatId, { text: 'This command only works in a group.' });
        return;
      }

      const isAdmin = await isGroupAdmin(sock, chatId, sender);
      if (!isAdmin) {
        await sock.sendMessage(chatId, { text: 'Only group admins can unban users.' });
        return;
      }

      const target = message.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0];
      if (!target) {
        await sock.sendMessage(chatId, { text: 'Please mention a user or provide a JID to unban.' });
        return;
      }

      BANNED_USERS.delete(target);
      await sock.sendMessage(chatId, { text: `User ${target} has been unbanned.` });
      return;
    }
  }

  if (!isGroupMessage(message)) return;

  if (registerSpam(sender, text)) {
    const mention = `@${sender.split('@')[0]}`;
    await sock.sendMessage(chatId, {
      text: `${mention} detected as spamming. Auto-ban active.`,
      mentions: [sender],
    });

    await banUser(sock, chatId, sender);
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: P({ level: process.env.LOG_LEVEL || 'info' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        startBot();
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp connection is open.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message) return;
    try {
      await handleMessage(sock, message);
    } catch (error) {
      console.error('Message handler error:', error);
    }
  });
}

startBot().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});
