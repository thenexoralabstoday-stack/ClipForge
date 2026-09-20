// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import Stripe from 'stripe';
import { runPipeline } from './src/pipeline.js';
import { getYouTubeAuthUrl, exchangeYouTubeCode, getTikTokAuthUrl, exchangeTikTokCode, getInstagramAuthUrl, exchangeInstagramCode } from './src/uploads.js';
import { getMemeSounds, analyzeMemeSoundMoments, generateMemeSoundPlan } from './src/meme-ai.js';
import { addMultipleMemeSounds, addMemeSoundToClip } from './src/audio.js';
import { ClipAnalysisService } from './src/ai.js';
import { saveFile, getProjectDir, ensureStorageDirs, fileExists, getStoragePath, downloadFromUrl } from './src/storage.js';
import { generateId, now } from './src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5173;
const JWT_SECRET = process.env.JWT_SECRET || 'clipforge-secret-change-in-production';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

const USERS_FILE = path.resolve('./data/users.json');
const JOBS = new Map();

const PLANS = {
  free: { minutes: 60, watermark: true, price: 0 },
  starter: { minutes: 150, watermark: false, price: 19 },
  pro: { minutes: 500, watermark: false, price: 49 },
  admin: { minutes: Infinity, watermark: false, price: 0 },
};

function ensureDataDir() {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readUsers() {
  ensureDataDir();
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function writeUsers(users) {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getUser(id) {
  const users = readUsers();
  return users[id] || null;
}

function updateUser(id, data) {
  const users = readUsers();
  users[id] = { ...users[id], ...data };
  writeUsers(users);
  return users[id];
}

function legacyHash(pw) {
  let hash = 0;
  for (let i = 0; i < pw.length; i++) {
    const char = pw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return String(hash);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt:')) {
    const [, salt, hex] = stored.split(':');
    const a = crypto.scryptSync(pw, salt, 64), b = Buffer.from(hex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return legacyHash(pw) === stored;
}

function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Admin';
  if (!email || !password) return;
  const users = readUsers();
  const existing = users[email];
  users[email] = {
    id: email,
    name: existing?.name || name,
    email,
    password: existing?.password || hashPassword(password),
    plan: 'admin',
    minutesUsed: existing?.minutesUsed || 0,
    clipsCreated: existing?.clipsCreated || 0,
    createdAt: existing?.createdAt || Date.now(),
  };
  writeUsers(users);
}

bootstrapAdmin();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'application/json' }));
app.use('/output', express.static(path.resolve('./output')));
app.use('/storage', express.static(path.resolve('./storage')));
app.use('/app', express.static(path.join(__dirname, 'app'), { maxAge: '1h' }));
app.use('/landing', express.static(path.join(__dirname, 'landing')));

// Only the page files are served from the repo root. Everything else (server.js, src/, data/, .env) stays private.
const PAGES = ['index', 'home', 'projects', 'project', 'editor', 'publish', 'billing', 'settings', 'meme-sounds', 'connections', 'privacy', 'terms'];
const page = name => (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, name + '.html'));
app.get('/', page('index'));
for (const name of PAGES) app.get(`/${name}.html`, page(name));
app.get('/settings', page('settings'));
app.get('/home', page('home'));
app.get('/privacy', page('privacy'));
app.get('/terms', page('terms'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/admin/setup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  const users = readUsers();
  if (users[email]) return res.status(400).json({ error: 'User already exists' });
  const id = email;
  users[id] = { id, name, email, password: hashPassword(password), plan: 'admin', minutesUsed: 0, clipsCreated: 0, createdAt: Date.now() };
  writeUsers(users);
  res.json({ ok: true, user: { id, name, email, plan: 'admin' } });
});

app.post('/api/contact', (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) return res.status(400).json({ error: 'All fields are required' });
  const entry = { name, email, message, receivedAt: new Date().toISOString() };
  try {
    const logPath = path.resolve('./data/contact.json');
    const arr = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
    arr.push(entry);
    fs.writeFileSync(logPath, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error('contact log failed', e);
  }
  res.json({ ok: true });
});

// Auth
app.post('/api/auth/signup', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const users = readUsers();
  if (users[email]) return res.status(400).json({ error: 'Email already exists' });
  const id = email;
  users[id] = { id, name, email, password: hashPassword(password), plan: 'free', minutesUsed: 0, clipsCreated: 0, createdAt: Date.now() };
  writeUsers(users);
  const token = jwt.sign({ id, email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, name, email, plan: 'free' } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const users = readUsers();
  const user = users[email];
  if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  if (!String(user.password).startsWith('scrypt:')) updateUser(user.id, { password: hashPassword(password) });
  const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, name: user.name, email: user.email, plan: user.plan, minutesUsed: user.minutesUsed, clipsCreated: user.clipsCreated });
  } catch (e) {
    fail(res, e);
  }
});

// Social auth
function fail(res, e) {
  if (e && (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError')) {
    return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
  }
  console.error(e);
  res.status(500).json({ error: e?.message || 'Something went wrong' });
}

function userFromToken(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  try { return getUser(jwt.verify(token, JWT_SECRET).id); } catch { return null; }
}

app.get('/api/auth/:platform/url', (req, res) => {
  const platform = req.params.platform;
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  try {
    // The provider echoes `state` back to the callback, which is how we know whose account this is.
    const state = jwt.sign({ id: user.id, platform }, JWT_SECRET, { expiresIn: '15m' });
    let url;
    if (platform === 'youtube') url = getYouTubeAuthUrl(state);
    else if (platform === 'tiktok') url = getTikTokAuthUrl(state);
    else if (platform === 'instagram') url = getInstagramAuthUrl(state);
    else return res.status(400).json({ error: 'Unsupported platform' });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/auth/:platform/callback', async (req, res) => {
  const platform = req.params.platform;
  const back = q => res.redirect(`/settings.html?${q}#connections`);
  const { code, state, error, error_description } = req.query;
  if (error || !code) return back('error=' + encodeURIComponent(error_description || error || 'The provider returned no code'));
  try {
    const decoded = jwt.verify(String(state), JWT_SECRET);
    if (decoded.platform !== platform) throw new Error('State mismatch');
    let result;
    if (platform === 'youtube') result = await exchangeYouTubeCode(String(code));
    else if (platform === 'tiktok') result = await exchangeTikTokCode(String(code));
    else if (platform === 'instagram') result = await exchangeInstagramCode(String(code));
    else return back('error=Unsupported+platform');
    const users = readUsers();
    if (!users[decoded.id]) return back('error=User+not+found');
    users[decoded.id].social = { ...(users[decoded.id].social || {}), [platform]: { ...result, connectedAt: Date.now() } };
    writeUsers(users);
    back('connected=' + platform);
  } catch (e) {
    back('error=' + encodeURIComponent(e.message));
  }
});

app.post('/api/auth/:platform/exchange', async (req, res) => {
  const platform = req.params.platform;
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let result;
    if (platform === 'youtube') result = await exchangeYouTubeCode(req.body.code);
    else if (platform === 'tiktok') result = await exchangeTikTokCode(req.body.code);
    else if (platform === 'instagram') result = await exchangeInstagramCode(req.body.code);
    else return res.status(400).json({ error: 'Unsupported platform' });

    const users = readUsers();
    users[user.id].social = { ...users[user.id].social, [platform]: { ...result, connectedAt: Date.now() } };
    writeUsers(users);

    res.json({ ok: true, platform, connected: true });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/auth/social', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ social: user.social || {} });
  } catch (e) {
    fail(res, e);
  }
});

// Profile & settings
const DEFAULT_SETTINGS = { clips: 5, min: 20, max: 60, style: 'karaoke', reframe: 'center', provider: 'anthropic' };
const SETTINGS_ENUM = { style: ['karaoke', 'classic', 'bold-pop', 'none'], reframe: ['center', 'left', 'right', 'blur'], provider: ['anthropic', 'groq'] };
function cleanSettings(input, base) {
  const s = { ...base };
  const num = (k, lo, hi) => { const v = Number(input[k]); if (Number.isFinite(v)) s[k] = Math.min(hi, Math.max(lo, Math.round(v))); };
  num('clips', 1, 20); num('min', 5, 300); num('max', 10, 600);
  for (const k of Object.keys(SETTINGS_ENUM)) if (SETTINGS_ENUM[k].includes(input[k])) s[k] = input[k];
  if (s.min >= s.max) s.max = s.min + 10;
  return s;
}

app.get('/api/me/settings', (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ settings: { ...DEFAULT_SETTINGS, ...(user.settings || {}) } });
});

app.patch('/api/me/settings', (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  const settings = cleanSettings(req.body || {}, { ...DEFAULT_SETTINGS, ...(user.settings || {}) });
  updateUser(user.id, { settings });
  res.json({ settings });
});

app.patch('/api/me', (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Name is too short' });
  const u = updateUser(user.id, { name });
  res.json({ user: { id: u.id, name: u.name, email: u.email, plan: u.plan } });
});

app.post('/api/me/password', (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  const { current, next } = req.body || {};
  if (!verifyPassword(String(current || ''), user.password)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (String(next || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  updateUser(user.id, { password: hashPassword(String(next)) });
  res.json({ ok: true });
});

// Usage
app.get('/api/usage', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const plan = PLANS[user.plan] || PLANS.free;
    const limit = user.plan === 'admin' ? Infinity : plan.minutes;
    res.json({ minutesUsed: user.minutesUsed || 0, minutesLimit: limit, clipsCreated: user.clipsCreated || 0, plan: user.plan });
  } catch (e) {
    fail(res, e);
  }
});

// Stripe
app.post('/api/stripe/checkout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const plan = req.body.plan;
    const planData = PLANS[plan];
    if (!planData) return res.status(400).json({ error: 'Invalid plan' });

    const session = stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'ClipForge ' + plan.charAt(0).toUpperCase() + plan.slice(1) },
          unit_amount: planData.price * 100,
        },
        quantity: 1,
      }],
      success_url: `${BASE_URL}/home.html?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/billing.html?canceled=true`,
      metadata: { userId: user.id, plan },
    });

    res.json({ url: session.url });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/stripe/portal', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    if (!customers.data.length) {
      return res.status(404).json({ error: 'No Stripe customer found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: `${BASE_URL}/billing.html`,
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(500).end();
  if (!STRIPE_WEBHOOK_SECRET) return res.status(500).json({ error: 'Webhook secret not configured' });
  
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    const plan = session.metadata?.plan;
    if (userId && plan) {
      updateUser(userId, { plan, minutesUsed: 0 });
    }
  } else if (event.type === 'invoice.payment_succeeded') {
    const subscription = event.data.object;
    const customer = subscription.customer;
    const users = readUsers();
    for (const id in users) {
      const user = users[id];
      const customers = await stripe.customers.list({ email: user.email, limit: 1 });
      if (customers.data.some(c => c.id === customer)) {
        updateUser(id, { plan: user.plan, minutesUsed: 0 });
        break;
      }
    }
  }

  res.json({ received: true });
});

// Jobs
app.post('/api/jobs', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const plan = PLANS[user.plan] || PLANS.free;
    if (user.plan !== 'admin' && (user.minutesUsed || 0) >= plan.minutes) {
      return res.status(402).json({ error: 'Monthly limit reached. Please upgrade.' });
    }

    const id = Date.now().toString(36);
    const job = { id, status: 'queued', progress: [], clips: null, error: null, userId: user.id };
    JOBS.set(id, job);
    res.json({ id });

    runJob(id, { ...DEFAULT_SETTINGS, ...(user.settings || {}), ...req.body }).then(() => {
      const j = JOBS.get(id);
      if (j && j.status === 'done' && j.minutesUsed) {
        const u = getUser(user.id);
        if (u) {
          updateUser(user.id, {
            minutesUsed: (u.minutesUsed || 0) + j.minutesUsed,
            clipsCreated: (u.clipsCreated || 0) + (j.clipsCount || 0),
          });
        }
      }
    }).catch(() => {});
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

app.get('/api/jobs/:id/stream', (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'start', job: job.id });
  const interval = setInterval(() => {
    const j = JOBS.get(req.params.id);
    if (!j) { clearInterval(interval); res.end(); return; }
    if (j.progress.length) {
      const last = j.progress[j.progress.length - 1];
      send({ type: 'log', message: last });
    }
    if (j.status === 'done' || j.status === 'error') {
      send({ type: j.status, clips: j.clips, error: j.error });
      clearInterval(interval);
      res.end();
    }
  }, 500);
});

app.get('/editor/:jobId', (req, res) => {
  res.sendFile(path.join(__dirname, 'editor.html'));
});

app.get('/meme-sounds', (req, res) => {
  res.sendFile(path.join(__dirname, 'meme-sounds.html'));
});

app.get('/projects', (req, res) => {
  res.sendFile(path.join(__dirname, 'projects.html'));
});

app.get('/project.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'project.html'));
});

app.get('/api/clips/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  const clipsPath = path.resolve(`./output/${job.id}/clips.json`);
  if (!fs.existsSync(clipsPath)) return res.status(404).json({ error: 'clips not found' });
  const clipsJson = JSON.parse(fs.readFileSync(clipsPath, 'utf8'));
  res.json(clipsJson);
});

app.post('/api/clips/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  const clipsPath = path.resolve(`./output/${job.id}/clips.json`);
  if (!fs.existsSync(clipsPath)) return res.status(404).json({ error: 'clips not found' });
  const clips = req.body.clips;
  if (!Array.isArray(clips)) return res.status(400).json({ error: 'clips must be an array' });
  const clipsJson = JSON.parse(fs.readFileSync(clipsPath, 'utf8'));
  clipsJson.clips = clips;
  fs.writeFileSync(clipsPath, JSON.stringify(clipsJson, null, 2));
  res.json({ ok: true, clips });
});

app.get('/publish/:jobId', (req, res) => {
  res.sendFile(path.join(__dirname, 'publish.html'));
});

app.get('/billing', (req, res) => {
  res.sendFile(path.join(__dirname, 'billing.html'));
});

app.post('/api/publish', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { clipPath, platform, metadata } = req.body;
    if (!clipPath || !platform) return res.status(400).json({ error: 'clipPath and platform required' });

    const social = user.social || {};
    if (!social[platform]) {
      return res.status(400).json({ error: `${platform} not connected. Connect it first.` });
    }

    const fullPath = path.resolve(`.${clipPath}`);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'clip file not found' });

    const { uploadClip } = await import('./src/uploads.js');
    const opts = { ...social[platform], privacy: 'public' };
    const id = await uploadClip(fullPath, platform, metadata, opts);
    res.json({ ok: true, platform, id, message: `Uploaded to ${platform}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Meme sounds
app.get('/api/meme-sounds', (req, res) => {
  res.json({ sounds: getMemeSounds() });
});

app.get('/api/meme-sounds/:jobId/plan', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  const clipsPath = path.resolve(`./output/${job.id}/clips.json`);
  if (!fs.existsSync(clipsPath)) return res.status(404).json({ error: 'clips not found' });
  const clipsJson = JSON.parse(fs.readFileSync(clipsPath, 'utf8'));
  const transcriptPath = path.resolve(`./output/${job.id}/transcript.json`);
  const transcript = fs.existsSync(transcriptPath) ? JSON.parse(fs.readFileSync(transcriptPath, 'utf8')) : null;
  if (!transcript) return res.status(404).json({ error: 'transcript not found' });
  
  const moments = analyzeMemeSoundMoments(transcript);
  const plan = generateMemeSoundPlan(clipsJson.clips, moments);
  res.json({ plan, moments });
});

app.post('/api/meme-sounds/analyze/:jobId', async (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  const transcriptPath = path.resolve(`./output/${job.id}/transcript.json`);
  if (!fs.existsSync(transcriptPath)) return res.status(404).json({ error: 'transcript not found' });
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  
  try {
    const moments = await analyzeMemeSoundMoments(transcript);
    const clipsPath = path.resolve(`./output/${job.id}/clips.json`);
    const clipsJson = JSON.parse(fs.readFileSync(clipsPath, 'utf8'));
    const plan = generateMemeSoundPlan(clipsJson.clips, moments);
    res.json({ moments: plan, rawMoments: moments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/meme-sounds/apply/:jobId/:clipIndex', async (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  const clipIndex = parseInt(req.params.clipIndex);
  const { soundTimings } = req.body;
  
  const clipPath = path.resolve(`./output/${job.id}/clips/clip-${String(clipIndex + 1).padStart(2, '0')}.mp4`);
  if (!fs.existsSync(clipPath)) return res.status(404).json({ error: 'clip not found' });
  
  try {
    const result = await addMultipleMemeSounds(clipPath, soundTimings);
    res.json({ ok: true, message: 'Meme sounds applied', output: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/meme-sounds/apply-all/:jobId', async (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  const { moments } = req.body;
  
  try {
    const clipsPath = path.resolve(`./output/${job.id}/clips.json`);
    const clipsJson = JSON.parse(fs.readFileSync(clipsPath, 'utf8'));
    const results = [];
    
    for (let i = 0; i < clipsJson.clips.length; i++) {
      const clipPath = path.resolve(`./output/${job.id}/clips/clip-${String(i + 1).padStart(2, '0')}.mp4`);
      if (!fs.existsSync(clipPath)) continue;
      
      const clipMoments = moments[i]?.sounds || [];
      if (clipMoments.length > 0) {
        const result = await addMultipleMemeSounds(clipPath, clipMoments);
        results.push({ clip: i + 1, output: result });
      }
    }
    
    res.json({ ok: true, message: `Applied meme sounds to ${results.length} clips`, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Projects
app.get('/api/projects', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const projects = readProjects().filter(p => p.userId === user.id);
    res.json({ projects });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/projects', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const { name, sourceType, sourceUrl, rightsConfirmed } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Project name required' });
    if (!sourceType) return res.status(400).json({ error: 'sourceType required' });
    if (!rightsConfirmed) return res.status(400).json({ error: 'You must confirm rights to process this content' });
    
    const projects = readProjects();
    const project = {
      id: generateId(),
      userId: user.id,
      name,
      sourceType,
      sourceUrl: sourceUrl || null,
      status: 'created',
      progress: 0,
      currentStep: 'created',
      clipsCount: 0,
      rendersCount: 0,
      publishesCount: 0,
      error: null,
      rightsConfirmedAt: now(),
      createdAt: now(),
      updatedAt: now()
    };
    projects.push(project);
    writeProjects(projects);
    
    res.json({ project });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/projects/:id', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const project = readProjects().find(p => p.id === req.params.id && p.userId === user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
    res.json({ project });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/projects/:id/source', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const projects = readProjects();
    const pIdx = projects.findIndex(p => p.id === req.params.id && p.userId === user.id);
    if (pIdx === -1) return res.status(404).json({ error: 'Project not found' });
    
    const { sourceType, sourceUrl, fileName, fileBuffer, rightsConfirmed } = req.body || {};
    if (!rightsConfirmed) return res.status(400).json({ error: 'Rights confirmation required' });
    
    ensureStorageDirs();
    const projectDir = getProjectDir(projects[pIdx].id);
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    
    let sourceFile = null;
    let meta = { title: projects[pIdx].name, duration: 0, resolution: 'unknown', fps: 0, codec: 'unknown', size: 0 };
    
    if (sourceType === 'upload' && fileBuffer) {
      const ext = fileName?.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '.mp4';
      const safeName = `source${ext}`;
      sourceFile = path.join(projectDir, safeName);
      fs.writeFileSync(sourceFile, Buffer.from(fileBuffer));
      meta.size = fileBuffer.length;
    } else if (sourceType === 'url' && sourceUrl) {
      const safeName = 'source.mp4';
      sourceFile = path.join(projectDir, safeName);
      await downloadFromUrl(sourceUrl, sourceFile);
      meta.url = sourceUrl;
      meta.size = fs.statSync(sourceFile).size;
    } else {
      return res.status(400).json({ error: 'sourceType must be upload or url' });
    }
    
    projects[pIdx].sourceType = sourceType;
    projects[pIdx].sourceUrl = sourceUrl || null;
    projects[pIdx].sourceFile = sourceFile;
    projects[pIdx].status = 'uploaded';
    projects[pIdx].currentStep = 'uploaded';
    projects[pIdx].updatedAt = now();
    writeProjects(projects);
    
    res.json({ project: projects[pIdx], meta });
  } catch (e) {
    console.error('source upload failed:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/analyze', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const projects = readProjects();
    const project = projects.find(p => p.id === req.params.id && p.userId === user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.sourceFile) return res.status(400).json({ error: 'No source video uploaded' });
    
    const analysisService = new ClipAnalysisService();
    const result = await analysisService.analyzeVideo({ segments: [] }, { duration: 0, title: project.name });
    
    project.status = 'analyzed';
    project.currentStep = 'analyzed';
    project.analysis = result;
    project.updatedAt = now();
    writeProjects(projects);
    
    res.json({ analysis: result, project });
  } catch (e) {
    console.error('analysis failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Clips
app.get('/api/projects/:id/clips', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const project = readProjects().find(p => p.id === req.params.id && p.userId === user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
    const clips = readClips().filter(c => c.projectId === project.id);
    res.json({ clips });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/projects/:id/clips', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const project = readProjects().find(p => p.id === req.params.id && p.userId === user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
    const { clips } = req.body || {};
    if (!Array.isArray(clips)) return res.status(400).json({ error: 'clips must be an array' });
    
    const allClips = readClips();
    const saved = clips.map(c => ({
      id: generateId(),
      projectId: project.id,
      userId: user.id,
      ...c,
      status: 'created',
      renderStatus: 'pending',
      createdAt: now(),
      updatedAt: now()
    }));
    allClips.push(...saved);
    writeClips(allClips);
    
    const projects = readProjects();
    const pIdx = projects.findIndex(p => p.id === project.id);
    if (pIdx !== -1) {
      projects[pIdx].clipsCount = (projects[pIdx].clipsCount || 0) + saved.length;
      projects[pIdx].status = 'clips_ready';
      projects[pIdx].currentStep = 'clips_ready';
      writeProjects(projects);
    }
    
    res.json({ clips: saved });
  } catch (e) {
    fail(res, e);
  }
});

app.patch('/api/clips/:id', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const clips = readClips();
    const idx = clips.findIndex(c => c.id === req.params.id && c.userId === user.id);
    if (idx === -1) return res.status(404).json({ error: 'Clip not found' });
    
    clips[idx] = { ...clips[idx], ...req.body, updatedAt: now() };
    writeClips(clips);
    
    res.json({ clip: clips[idx] });
  } catch (e) {
    fail(res, e);
  }
});

app.delete('/api/clips/:id', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const clips = readClips();
    const idx = clips.findIndex(c => c.id === req.params.id && c.userId === user.id);
    if (idx === -1) return res.status(404).json({ error: 'Clip not found' });
    
    clips.splice(idx, 1);
    writeClips(clips);
    
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/clips/:id/generate-metadata', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const clips = readClips();
    const clip = clips.find(c => c.id === req.params.id && c.userId === user.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    
    const { CaptionService } = await import('./src/ai.js');
    const service = new CaptionService();
    const metadata = await service.generateMetadata(clip, {});
    
    const idx = clips.findIndex(c => c.id === clip.id);
    clips[idx] = { ...clips[idx], ...metadata, updatedAt: now() };
    writeClips(clips);
    
    res.json({ metadata, clip: clips[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clips/:id/generate-captions', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const clips = readClips();
    const clip = clips.find(c => c.id === req.params.id && c.userId === user.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    
    const { CaptionService } = await import('./src/ai.js');
    const service = new CaptionService();
    const captions = await service.generateCaptions(clip, { segments: [] });
    
    const idx = clips.findIndex(c => c.id === clip.id);
    clips[idx] = { ...clips[idx], captions, updatedAt: now() };
    writeClips(clips);
    
    res.json({ captions, clip: clips[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clips/:id/suggest-audio', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const clips = readClips();
    const clip = clips.find(c => c.id === req.params.id && c.userId === user.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    
    const { AudioSuggestionService } = await import('./src/ai.js');
    const service = new AudioSuggestionService();
    const suggestions = await service.suggestAudio(clip, {});
    
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clips/:id/render', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const clips = readClips();
    const clip = clips.find(c => c.id === req.params.id && c.userId === user.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    
    const projects = readProjects();
    const project = projects.find(p => p.id === clip.projectId);
    if (!project?.sourceFile) return res.status(400).json({ error: 'Source video missing' });
    
    const projectDir = getProjectDir(project.id);
    const clipDir = path.join(projectDir, 'clips');
    if (!fs.existsSync(clipDir)) fs.mkdirSync(clipDir, { recursive: true });
    
    const idx = clips.findIndex(c => c.id === clip.id);
    clips[idx] = { ...clips[idx], renderStatus: 'rendering', updatedAt: now() };
    writeClips(clips);
    
    try {
      const { renderClip } = await import('./src/render.js');
      const outFile = path.join(clipDir, `${clip.id}.mp4`);
      await renderClip({
        source: project.sourceFile,
        clip: { start: clip.start, end: clip.end, words: clip.captions?.words || [] },
        clipDir,
        index: 0,
        total: 1,
        style: clip.captionStyle || 'classic',
        reframe: clip.reframe || 'center'
      });
      
      const outIdx = clips.findIndex(c => c.id === clip.id);
      clips[outIdx] = { ...clips[outIdx], renderStatus: 'done', renderPath: `/storage/${project.id}/${clip.id}.mp4`, updatedAt: now() };
      writeClips(clips);
      
      res.json({ ok: true, clip: clips[outIdx] });
    } catch (e) {
      const outIdx = clips.findIndex(c => c.id === clip.id);
      clips[outIdx] = { ...clips[outIdx], renderStatus: 'failed', error: e.message, updatedAt: now() };
      writeClips(clips);
      res.status(500).json({ error: e.message });
    }
  } catch (e) {
    fail(res, e);
  }
});

// Social accounts
app.get('/api/social/accounts', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ accounts: user.social || {} });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/auth/:platform/disconnect', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const platform = req.params.platform;
    const social = { ...(user.social || {}) };
    delete social[platform];
    updateUser(user.id, { social });
    res.json({ ok: true, accounts: social });
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/clips/:id/publish', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const clips = readClips();
    const clip = clips.find(c => c.id === req.params.id && c.userId === user.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    
    const { platforms, title, description, hashtags } = req.body || {};
    if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({ error: 'platforms array required' });
    }
    
    const social = user.social || {};
    const results = [];
    
    for (const platform of platforms) {
      try {
        if (!social[platform]) {
          results.push({ platform, status: 'skipped', error: 'Not connected' });
          continue;
        }
        
        const clipPath = clip.renderPath || `/output/${clip.projectId}/clips/${clip.id}.mp4`;
        const fullPath = path.resolve(`.${clipPath}`);
        if (!fs.existsSync(fullPath)) {
          results.push({ platform, status: 'skipped', error: 'Rendered video not found' });
          continue;
        }
        
        const { uploadClip } = await import('./src/uploads.js');
        const id = await uploadClip(fullPath, platform, { title, caption: description, hashtags }, { ...social[platform] });
        results.push({ platform, status: 'published', id });
      } catch (e) {
        results.push({ platform, status: 'failed', error: e.message });
      }
    }
    
    res.json({ ok: true, results });
  } catch (e) {
    fail(res, e);
  }
});


const PROJECTS_FILE = path.resolve('./data/projects.json');
const CLIPS_FILE = path.resolve('./data/clips.json');

function readProjects() {
  ensureDataDir();
  if (!fs.existsSync(PROJECTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
}

function writeProjects(data) {
  ensureDataDir();
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
}

function readClips() {
  ensureDataDir();
  if (!fs.existsSync(CLIPS_FILE)) return [];
  return JSON.parse(fs.readFileSync(CLIPS_FILE, 'utf8'));
}

function writeClips(data) {
  ensureDataDir();
  fs.writeFileSync(CLIPS_FILE, JSON.stringify(data, null, 2));
}

async function runJob(id, body) {
  const job = JOBS.get(id);
  try {
    job.status = 'running';
    const result = await runPipeline({
      input: body.input,
      clips: parseInt(body.clips) || 5,
      min: parseInt(body.min) || 20,
      max: parseInt(body.max) || 60,
      style: body.style || 'classic',
      reframe: body.reframe || 'center',
      titleMode: body.title || 'auto',
      model: body.model || process.env.WHISPER_MODEL || 'base',
      out: body.out || './output',
      dryRun: false,
      resume: false,
      pick: body.pick || 'ai',
      provider: body.provider || 'anthropic',
    });
    const clipsJsonPath = path.join(result.workDir, 'clips.json');
    const clipsJson = JSON.parse(fs.readFileSync(clipsJsonPath, 'utf8'));
    const user = getUser(job.userId);
    const plan = PLANS[user?.plan] || PLANS.free;
    const maxDuration = user?.plan === 'admin' ? Infinity : (plan.watermark ? 30 : 60);
    job.clips = clipsJson.clips.map((c, i) => ({
      ...c,
      url: `/output/${path.basename(result.workDir)}/clips/clip-${String(i + 1).padStart(2, '0')}.mp4`,
      watermark: user?.plan === 'admin' ? false : plan.watermark,
    }));
    job.clipsCount = clipsJson.clips.length;
    const totalDuration = clipsJson.clips.reduce((sum, c) => sum + ((c.end || 0) - (c.start || 0)), 0);
    job.minutesUsed = Math.ceil(totalDuration / 60);
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
  }
}

export function startUi() {
  app.listen(PORT, () => {
    console.log(`ClipForge UI running at http://localhost:${PORT}`);
  });
}

if (isMain) {
  startUi();
}
