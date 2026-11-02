const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

/* ---------- Redis (Vercel Upstash integration sets KV_REST_API_*) ---------- */
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = RURL && RTOK ? new Redis({ url: RURL, token: RTOK }) : null;

const APPTS = 'sc:appts';
const slotKey = (d, t) => `sc:slot:${d}|${t}`;
const blkKey = d => `sc:blk:${d}`;

/* ---------- clinic hours (minutes from midnight, must match index.html) ---------- */
const HRS = { 0: [510, 840], 1: [510, 1200], 2: [510, 780], 3: [510, 1200], 4: [510, 1200], 5: [510, 1200], 6: [510, 1200] };
const pad = n => String(n).padStart(2, '0');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

// India time (UTC+5:30), independent of server timezone
function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  };
}
function validSlot(date, time) {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return false;
  const dt = new Date(date + 'T00:00:00Z');
  if (isNaN(dt)) return false;
  const [a, b] = HRS[dt.getUTCDay()];
  const [h, m] = time.split(':').map(Number);
  const mins = h * 60 + m;
  return mins >= a && mins < b && (mins - a) % 30 === 0;
}
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/* ---------- auth ---------- */
const sign = s => crypto.createHmac('sha256', process.env.AUTH_SECRET || '').update(s).digest('base64url');
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function makeToken() {
  const p = String(Date.now() + 12 * 3600 * 1000);
  return p + '.' + sign(p);
}
function isStaff(req) {
  if (!process.env.AUTH_SECRET) return false;
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [p, s] = t.split('.');
  if (!p || !s) return false;
  return safeEq(s, sign(p)) && Number(p) > Date.now();
}

/* ---------- misc ---------- */
const ip = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
async function within(key, max, sec) {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, sec);
  return n <= max;
}
const STATUSES = ['Pending', 'Confirmed', 'Completed', 'Cancelled', 'No-show'];
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const newRef = () => 'SC' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
const body = req => (req.body && typeof req.body === 'object' ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })());

async function release(a) {
  if (a && a.date && a.time) await redis.del(slotKey(a.date, a.time));
}

/* ---------- handler ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query.action || '');

  try {
    if (action === 'ping') {
      return res.status(200).json({ ok: !!redis && !!process.env.STAFF_PASSWORD && !!process.env.AUTH_SECRET });
    }
    if (!redis) return res.status(503).json({ error: 'Database not configured.' });

    /* ---- public: taken slots ---- */
    if (action === 'taken' && req.method === 'GET') {
      const { d1, d2 } = req.query;
      if (!DATE_RE.test(d1 || '') || !DATE_RE.test(d2 || '') || d2 < d1) return res.status(400).json({ error: 'Bad dates.' });
      const dates = [];
      for (let d = d1, i = 0; d <= d2 && i < 31; d = addDays(d, 1), i++) dates.push(d);
      const all = (await redis.hgetall(APPTS)) || {};
      const out = {};
      Object.values(all).forEach(a => {
        if (a && a.date >= d1 && a.date <= d2 && !['Cancelled', 'No-show'].includes(a.status)) (out[a.date] = out[a.date] || []).push(a.time);
      });
      const p = redis.pipeline();
      dates.forEach(d => p.smembers(blkKey(d)));
      const bl = await p.exec();
      dates.forEach((d, i) => { if (bl[i] && bl[i].length) out[d] = [...(out[d] || []), ...bl[i]]; });
      return res.status(200).json(out);
    }

    /* ---- public: book (staff token allows walk-ins) ---- */
    if (action === 'book' && req.method === 'POST') {
      const b = body(req);
      const staff = isStaff(req);
      if (!staff && !(await within('sc:rl:book:' + ip(req), 10, 3600))) return res.status(429).json({ error: 'Too many bookings. Please call us.' });

      const name = clean(b.name, 80), phone = clean(b.phone, 10), date = clean(b.date, 10), time = clean(b.time, 5);
      if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name.' });
      if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
      if (!validSlot(date, time)) return res.status(400).json({ error: 'Invalid date or time.' });
      const now = istNow();
      if (date < now.date || (date === now.date && time <= now.time)) return res.status(400).json({ error: 'That time has passed. Please pick another.' });
      if (date > addDays(now.date, 60)) return res.status(400).json({ error: 'Too far ahead. Please pick an earlier date.' });

      const blocked = await redis.smembers(blkKey(date));
      if (blocked.includes('*') || blocked.includes(time)) return res.status(409).json({ error: 'That slot was just taken. Please pick another time.' });

      const ref = /^SC[A-Z0-9]{6}$/.test(b.ref || '') ? b.ref : newRef();
      const got = await redis.set(slotKey(date, time), ref, { nx: true });
      if (!got) return res.status(409).json({ error: 'That slot was just taken. Please pick another time.' });

      const appt = {
        id: ref, ref, date, time, name, phone,
        reason: clean(b.reason, 60) || 'Check-up',
        status: staff && ['Pending', 'Confirmed'].includes(b.status) ? b.status : 'Pending',
        source: staff ? 'Walk-in' : 'Online',
        createdAt: Date.now()
      };
      const added = await redis.hsetnx(APPTS, ref, appt);
      if (!added) { await redis.del(slotKey(date, time)); return res.status(409).json({ error: 'Please try again.' }); }
      return res.status(200).json({ ok: true, ref });
    }

    /* ---- public: lookup / cancel with code + phone ---- */
    if ((action === 'lookup' || action === 'cancel') && req.method === 'POST') {
      if (!(await within('sc:rl:lk:' + ip(req), 30, 900))) return res.status(429).json({ error: 'Too many attempts.' });
      const b = body(req);
      const ref = clean(b.ref, 12).toUpperCase(), phone = clean(b.phone, 10);
      const a = ref ? await redis.hget(APPTS, ref) : null;
      if (!a || a.phone !== phone) return res.status(404).json({ error: 'Not found.' });
      if (action === 'lookup') return res.status(200).json({ appt: { date: a.date, time: a.time, name: a.name, reason: a.reason, status: a.status } });
      if (['Pending', 'Confirmed'].includes(a.status)) {
        a.status = 'Cancelled';
        await redis.hset(APPTS, { [ref]: a });
        await release(a);
      }
      return res.status(200).json({ ok: true });
    }

    /* ---- staff login ---- */
    if (action === 'login' && req.method === 'POST') {
      if (!(await within('sc:rl:login:' + ip(req), 8, 900))) return res.status(429).json({ error: 'Too many attempts.' });
      const pw = String(body(req).password || '');
      if (!process.env.STAFF_PASSWORD || !process.env.AUTH_SECRET || !safeEq(pw, process.env.STAFF_PASSWORD)) return res.status(401).json({ error: 'Wrong password.' });
      return res.status(200).json({ token: makeToken() });
    }

    /* ---- everything below needs a staff token ---- */
    if (!isStaff(req)) return res.status(401).json({ error: 'Login required.' });

    if (action === 'me') return res.status(200).json({ ok: true });

    if (action === 'list' && req.method === 'GET') {
      const all = (await redis.hgetall(APPTS)) || {};
      return res.status(200).json({ items: Object.values(all) });
    }

    if (action === 'status' && req.method === 'POST') {
      const { id, status } = body(req);
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status.' });
      const a = await redis.hget(APPTS, String(id || ''));
      if (!a) return res.status(404).json({ error: 'Not found.' });
      a.status = status;
      await redis.hset(APPTS, { [a.id]: a });
      if (['Cancelled', 'No-show'].includes(status)) await release(a);
      return res.status(200).json({ ok: true });
    }

    if (action === 'blocks' && req.method === 'GET') {
      const d = String(req.query.d || '');
      if (!DATE_RE.test(d)) return res.status(400).json({ error: 'Bad date.' });
      return res.status(200).json({ times: await redis.smembers(blkKey(d)) });
    }

    if (action === 'block' && req.method === 'POST') {
      const { date, time, on } = body(req);
      if (!DATE_RE.test(date || '') || !(time === '*' || TIME_RE.test(time || ''))) return res.status(400).json({ error: 'Bad input.' });
      if (on) await redis.sadd(blkKey(date), time); else await redis.srem(blkKey(date), time);
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown action.' });
  } catch (e) {
    console.error('api error', action, e);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
};
  
