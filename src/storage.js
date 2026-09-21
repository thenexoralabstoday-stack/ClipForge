// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import fs from 'node:fs';
import path from 'node:path';
import { run } from './util.js';

const STORAGE_DIR = path.resolve('./storage');
const OUTPUT_DIR = path.resolve('./output');

export function ensureStorageDirs() {
  [STORAGE_DIR, OUTPUT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

export function getStoragePath(projectId, filename) {
  return path.join(STORAGE_DIR, projectId, filename);
}

export function getOutputPath(projectId, filename) {
  return path.join(OUTPUT_DIR, projectId, filename);
}

export function saveFile(projectId, filename, buffer) {
  ensureStorageDirs();
  const dir = path.join(STORAGE_DIR, projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export function readFile(projectId, filename) {
  const filePath = getStoragePath(projectId, filename);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filename}`);
  return fs.readFileSync(filePath);
}

export function fileExists(projectId, filename) {
  return fs.existsSync(getStoragePath(projectId, filename));
}

export function deleteFile(projectId, filename) {
  const filePath = getStoragePath(projectId, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function getProjectDir(projectId) {
  return path.join(STORAGE_DIR, projectId);
}

export function listProjectFiles(projectId) {
  const dir = getProjectDir(projectId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(f => ({
    name: f,
    path: path.join(dir, f),
    size: fs.statSync(path.join(dir, f)).size
  }));
}

export async function downloadFromUrl(url, destPath) {
  ensureStorageDirs();
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
  } catch (e) {
    throw new Error(`Download failed: ${e.message}`);
  }
  
  return destPath;
}

export function getFileMetadata(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  
  return {
    size: stat.size,
    extension: ext,
    isVideo: ['.mp4', '.mkv', '.webm', '.mov', '.avi'].includes(ext),
    isImage: ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext),
    isAudio: ['.mp3', '.wav', '.m4a', '.aac'].includes(ext),
  };
}
