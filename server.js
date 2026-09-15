require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || '';
const API_VERSION = process.env.META_API_VERSION || 'v26.0';
const KEYWORD = (process.env.COMMENT_KEYWORD || 'کانفیگ').trim().toLocaleLowerCase('fa-IR');
const DM_TEXT = process.env.DM_TEXT || 'سلام 👋\nپیام شما دریافت شد. به‌زودی اطلاعات برای شما ارسال می‌شود.';
const PUBLIC_REPLY = process.env.PUBLIC_REPLY || '';

function verifySignature(req, res, buf) {
  if (!APP_SECRET) return;
  const signature = req.get('x-hub-signature-256');
  if (!signature || !signature.startsWith('sha256=')) {
    throw new Error('Missing X-Hub-Signature-256');
  }
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
  // Acknowledge Meta immediately; process the event after the response.
  res.sendStatus(200);
  setImmediate(() => processWebhook(req.body).catch(err => console.error('[webhook]', err)));
});

function normalize(text) {
  return String(text || '').trim().toLocaleLowerCase('fa-IR');
}

function keywordMatches(text) {
  if (!KEYWORD) return false;
  return normalize(text).split(/\s+/).includes(KEYWORD) || normalize(text).includes(KEYWORD);
}

async function graphPost(path, body) {
  if (!ACCESS_TOKEN) throw new Error('IG_ACCESS_TOKEN is not configured');
  const url = `https://graph.instagram.com/${API_VERSION}${path}`;
  const response = await fetch(url, {
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

async function sendPrivateReply(commentId) {
  return graphPost(`/${encodeURIComponent(commentId)}/private_replies`, { message: DM_TEXT });
}

async function sendPublicReply(commentId) {
  return graphPost(`/${encodeURIComponent(commentId)}/replies`, { message: PUBLIC_REPLY });
}

async function processWebhook(payload) {
  if (!payload || payload.object !== 'instagram') return;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'comments') continue;
      const value = change.value || {};
      const commentId = value.id || value.comment_id;
      const text = value.text || '';
      if (!commentId || !keywordMatches(text)) continue;

      try {
        // Meta may retry a webhook. The one-private-reply-per-comment rule makes
        // duplicate processing especially important; keep a lightweight memory guard.
        if (processedComments.has(String(commentId))) continue;
        processedComments.add(String(commentId));

        if (PUBLIC_REPLY) await sendPublicReply(commentId);
        await sendPrivateReply(commentId);
        console.log(`[automation] matched keyword for comment ${commentId}`);
      } catch (error) {
        console.error(`[automation] failed for comment ${commentId}:`, error.message);
      }
    }
  }
}

const processedComments = new Map();
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, timestamp] of processedComments) {
    if (timestamp < cutoff) processedComments.delete(id);
  }
}, 60 * 60 * 1000).unref();

// Store timestamps rather than an unbounded Set.
const originalAdd = processedComments.set.bind(processedComments);
processedComments.set = (key) => originalAdd(key, Date.now());

app.use((err, _req, res, _next) => {
  console.error('[server]', err.message);
  if (!res.headersSent) res.status(400).json({ ok: false, error: err.message });
});

app.listen(PORT, () => console.log(`Instagram Auto Reply listening on port ${PORT}`));
