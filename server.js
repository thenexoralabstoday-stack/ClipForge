// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { runPipeline } from './src/pipeline.js';
import { getYouTubeAuthUrl, exchangeYouTubeCode, getTikTokAuthUrl, exchangeTikTokCode, getInstagramAuthUrl, exchangeInstagramCode } from './src/uploads.js';
import { getMemeSounds, analyzeMemeSoundMoments, generateMemeSoundPlan } from './src/meme-ai.js';
import { addMultipleMemeSounds, addMemeSoundToClip } from './src/audio.js';

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

function hashPassword(pw) {
  let hash = 0;
  for (let i = 0; i < pw.length; i++) {
    const char = pw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return String(hash);
}

app.use(cors({ origin: 'https://thenexoralabstoday-stack.github.io', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'application/json' }));
app.use('/output', express.static(path.resolve('./output')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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
  if (!user || user.password !== hashPassword(password)) return res.status(401).json({ error: 'Invalid credentials' });
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
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Social auth
app.get('/api/auth/:platform/url', (req, res) => {
  const platform = req.params.platform;
  try {
    let url;
    if (platform === 'youtube') url = getYouTubeAuthUrl();
    else if (platform === 'tiktok') url = getTikTokAuthUrl();
    else if (platform === 'instagram') url = getInstagramAuthUrl();
    else return res.status(400).json({ error: 'Unsupported platform' });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    users[user.id].social = { ...users[user.id].social, [platform]: result };
    writeUsers(users);

    res.json({ ok: true, platform, connected: true });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
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
    res.status(401).json({ error: 'Invalid token' });
  }
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
    res.status(401).json({ error: 'Invalid token' });
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
      success_url: `${BASE_URL}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?canceled=true`,
      metadata: { userId: user.id, plan },
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
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
      return_url: `${BASE_URL}/dashboard`,
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

    runJob(id, req.body).then(() => {
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
    res.status(401).json({ error: 'Invalid token' });
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

    const { uploadClip } = await import('../uploads.js');
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
