// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function run(cmd, args, { cwd, quiet = false, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32' && !path.isAbsolute(cmd);
    const safeArgs = useShell ? args.map(a => /[\s\\"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a) : args;
    const p = spawn(cmd, safeArgs, { cwd, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], shell: useShell, env: env ? { ...process.env, ...env } : process.env });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; if (!quiet) process.stdout.write(d); });
    p.stderr.on('data', d => { err += d; if (!quiet) process.stderr.write(d); });
    if (input) { p.stdin.write(input); p.stdin.end(); }
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}\n${err.slice(-2000)}`)));
  });
}

export async function has(cmd) { return !!(await findCommand(cmd)); }

export async function findCommand(cmd) {
  const candidates = [cmd];
  if (process.platform === 'win32') {
    const userScripts = path.join(os.homedir(), 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts');
    candidates.push(path.join(userScripts, cmd + '.exe'));
    candidates.push(path.join(userScripts, cmd + '.cmd'));
    candidates.push(path.join('C:', 'Python312', 'Scripts', cmd + '.exe'));
    candidates.push(path.join('C:', 'Python312', 'Scripts', cmd + '.cmd'));
  }
  for (const c of candidates) {
    try {
      await run(c, ['--version'], { quiet: true });
      return c;
    } catch {}
  }
  try {
    await run('python', ['-m', cmd, '--version'], { quiet: true });
    return 'python';
  } catch {}
  return null;
}

export async function probe(file) {
  const { out } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { quiet: true });
  const j = JSON.parse(out); const v = j.streams.find(s => s.codec_type === 'video') || {};
  return { duration: +j.format.duration, width: v.width, height: v.height, fps: v.r_frame_rate ? eval(v.r_frame_rate) : 30 };
}

export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'video';
export const fmtTime = s => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${sec}`; };
export const ensureDir = d => (fs.mkdirSync(d, { recursive: true }), d);
export const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
export const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
export const log = (...a) => console.log('\x1b[36m[clipforge]\x1b[0m', ...a);
