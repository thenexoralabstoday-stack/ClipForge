// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import fs from 'node:fs';
import path from 'node:path';
import { getDb, persistDb, now, generateId } from './db.js';

const QUEUE_FILE = path.resolve('./data/queue.json');
let queue = null;

function readQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeQueue(data) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2));
}

export function getQueue() {
  if (!queue) queue = readQueue();
  return queue;
}

export function enqueueJob(type, payload) {
  const q = getQueue();
  const job = {
    id: generateId(),
    type,
    payload,
    status: 'queued',
    progress: 0,
    createdAt: now(),
    updatedAt: now(),
    attempts: 0,
    maxAttempts: 3,
    error: null,
    result: null
  };
  q.push(job);
  writeQueue(q);
  return job;
}

export function updateJob(id, updates) {
  const q = getQueue();
  const idx = q.findIndex(j => j.id === id);
  if (idx === -1) return null;
  q[idx] = { ...q[idx], ...updates, updatedAt: now() };
  writeQueue(q);
  return q[idx];
}

export function getJob(id) {
  return getQueue().find(j => j.id === id) || null;
}

export function getPendingJobs(type) {
  return getQueue().filter(j => j.status === 'queued' && (!type || j.type === type));
}

export function markJobProcessing(id) {
  return updateJob(id, { status: 'processing', attempts: (getQueue().find(j => j.id === id)?.attempts || 0) + 1 });
}

export function markJobDone(id, result) {
  return updateJob(id, { status: 'done', progress: 100, result, error: null });
}

export function markJobFailed(id, error) {
  const job = getQueue().find(j => j.id === id);
  const attempts = (job?.attempts || 0) + 1;
  const shouldRetry = attempts < (job?.maxAttempts || 3);
  
  if (shouldRetry) {
    return updateJob(id, { status: 'queued', attempts, error: String(error) });
  }
  
  return updateJob(id, { status: 'failed', attempts, error: String(error) });
}

export function clearCompletedJobs() {
  const q = getQueue().filter(j => j.status !== 'done' && j.status !== 'failed');
  writeQueue(q);
  return q;
}
