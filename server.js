require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || '';
const API_VERSION = process.env.META_API_VERSION || 'v26.0';
const PRICE_KEYWORD = 'قیمت';

const DM_TEXT = `کانفیگ های اختصاصی و سرعت بالا

50 گیگ یک ماهه 200 هزار تومان(کاربر نامحدود)
100 گیگ یکماهه 350 هزار تومان(کاربر نامحدود)
نامحدود یکماههvip 400 هزار تومان(تک کاربر)
نامحدود یک ماهه ۱۵۰ هزارتومن‌(تک کاربر)
نامحدود‌هفت روزه۸۰ هزارتومن(تک‌ کاربر)
گیگی هم به فروش میرسه گیگی 5 تومان
حداقل خرید 10 گیگ ⚡️

لوکیشن ها
آلمان 🇩🇪
ترکیه 🇹🇷
آمریکا 🇺🇲
سنگاپور 🇸🇬

چند لوکیشن با چند پروتکل مختلف ✔️
آیپی ثابت هم موجوده ✔️
V2ray,V2box,Npv,Hiddify,Happ...`;

// Put up to 10 test links/configs in TEST_1 ... TEST_10.
// Example: TEST_1=vless://...  TEST_2=vless://...
const TESTS = Array.from({ length: 10 }, (_, i) => process.env[`TEST_${i + 1}`] || '').map(v => v.trim()).filter(Boolean);
const PUBLIC_REPLY = process.env.PUBLIC_REPLY || '';

// In-memory test allocation for the first version. A user can receive only one test.
// The pool resets when the server restarts. Before production, move this state to a database.
const testClaimedUsers = new Set();
let nextTestIndex = 0;
const processedComments = new Map();

function verifySignature(req, res, buf) {
  if (!APP_SECRET) return;
  const signature = req.get('x-hub-signature-256');
  if (!signature || !signature.startsWith('sha256=')) throw new Error('Missing X-Hub-Signature-256');
  const expected = crypto.createHmac('sha256', APP_SECRET).update(buf).digest('hex');
  const received = signature.slice(7);
  if (received.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
    throw new Error('Invalid X-Hub-Signature-256');
  }
}

app.use(express.json({ verify: verifySignature, limit: '1mb' }));
app.get('/', (_req, res) => res.json({ ok: true, service: 'Instagram Auto Reply' }));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  setImmediate(() => processWebhook(req.body).catch(err => console.error('[webhook]', err)));
});

function normalize(text) {
  return String(text || '').trim().toLocaleLowerCase('fa-IR');
}

function isExactKeyword(text, keyword) {
  return normalize(text) === normalize(keyword);
}

async function graphPost(path, body) {
  if (!ACCESS_TOKEN) throw new Error('IG_ACCESS_TOKEN is not configured');
  const response = await fetch(`https://graph.instagram.com/${API_VERSION}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Meta API ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function sendPrivateReply(commentId, message) {
  return graphPost(`/${encodeURIComponent(commentId)}/private_replies`, { message });
}

async function sendPublicReply(commentId) {
  if (!PUBLIC_REPLY) return;
  return graphPost(`/${encodeURIComponent(commentId)}/replies`, { message: PUBLIC_REPLY });
}

function getTestForUser(userId) {
  if (!userId) return null;
  if (testClaimedUsers.has(String(userId))) return { alreadyClaimed: true };
  if (nextTestIndex >= TESTS.length) return { empty: true };

  const test = TESTS[nextTestIndex];
  nextTestIndex += 1;
  testClaimedUsers.add(String(userId));
  return { test };
}

async function processWebhook(payload) {
  if (!payload || payload.object !== 'instagram') return;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'comments') continue;

      const value = change.value || {};
      const commentId = value.id || value.comment_id;
      const text = value.text || '';
      const userId = value.from?.id || value.from?.username || value.username;
      if (!commentId) continue;

      try {
        const id = String(commentId);
        if (processedComments.has(id)) continue;
        processedComments.set(id, Date.now());

        // Only the exact word «قیمت» gets the price list.
        if (isExactKeyword(text, PRICE_KEYWORD)) {
          await sendPrivateReply(commentId, DM_TEXT);
          console.log(`[automation] price sent for comment ${commentId}`);
          continue;
        }

        // Only the exact word «تست» consumes one test from the 10-test pool.
        if (isExactKeyword(text, 'تست')) {
          const result = getTestForUser(userId);
          if (result?.test) {
            await sendPrivateReply(commentId, `🎁 تست شما:\n\n${result.test}`);
            console.log(`[automation] test #${nextTestIndex} sent to ${userId}`);
          } else if (result?.alreadyClaimed) {
            await sendPrivateReply(commentId, 'شما قبلاً تست خود را دریافت کرده‌اید ❤️');
          } else {
            await sendPrivateReply(commentId, 'متأسفانه تست‌ها فعلاً تمام شده‌اند. به‌زودی دوباره شارژ می‌شوند ❤️');
          }
        }
      } catch (error) {
        console.error(`[automation] failed for comment ${commentId}:`, error.message);
      }
    }
  }
}

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, timestamp] of processedComments) {
    if (timestamp < cutoff) processedComments.delete(id);
  }
}, 60 * 60 * 1000).unref();

app.use((err, _req, res, _next) => {
  console.error('[server]', err.message);
  if (!res.headersSent) res.status(400).json({ ok: false, error: err.message });
});

app.listen(PORT, () => console.log(`Instagram Auto Reply listening on port ${PORT}`));
