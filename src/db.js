// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve('./data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = null;

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readDb() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: {}, projects: {}, clips: {}, jobs: {}, socialAccounts: {}, publishJobs: {} };
    writeDb(initial);
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    const initial = { users: {}, projects: {}, clips: {}, jobs: {}, socialAccounts: {}, publishJobs: {} };
    writeDb(initial);
    return initial;
  }
}

export function writeDb(data) {
  ensureDataDir();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

export function getDb() {
  if (!db) db = readDb();
  return db;
}

export function persistDb() {
  writeDb(db);
}

export function resetDb() {
  db = null;
}

export function now() {
  return new Date().toISOString();
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
