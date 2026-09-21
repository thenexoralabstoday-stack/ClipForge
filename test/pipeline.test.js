import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAss, wordsForClip } from '../src/captions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32';
    const safeArgs = useShell ? args.map(a => /[\s\\"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a) : args;
    const p = spawn(cmd, safeArgs, { stdio: 'pipe', shell: useShell });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; if (!opts.quiet) process.stdout.write(d); });
    p.stderr.on('data', d => { err += d; if (!opts.quiet) process.stderr.write(d); });
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} failed: ${err.slice(-500)}`)));
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { stdio: 'pipe' });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err));
      const j = JSON.parse(out);
      const v = j.streams.find(s => s.codec_type === 'video') || {};
      const a = j.streams.find(s => s.codec_type === 'audio') || {};
      resolve({
        duration: +j.format.duration, size: +j.format.size,
        width: +v.width, height: +v.height, vcodec: v.codec_name, acodec: a.codec_name,
      });
    });
  });
}

async function main() {
  if (!fs.existsSync(FIXTURES)) fs.mkdirSync(FIXTURES, { recursive: true });
  const sample = path.join(FIXTURES, 'sample.mp4');
  console.log('creating synthetic video...');
  await run('ffmpeg', [
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '20', '-pix_fmt', 'yuv420p', '-y', sample,
  ]);
  console.log('writing fake transcript and clips...');
  const words = [];
  for (let i = 0; i < 40; i++) {
    words.push({ start: i * 0.5, end: i * 0.5 + 0.4, word: `word${i}` });
  }
  const transcript = { language: 'en', segments: [{ start: 0, end: 20, text: 'word0 word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24 word25 word26 word27 word28 word29 word30 word31 word32 word33 word34 word35 word36 word37 word38 word39', words }] };
  fs.writeFileSync(path.join(FIXTURES, 'transcript.json'), JSON.stringify(transcript, null, 2));
  fs.writeFileSync(path.join(FIXTURES, 'clips.json'), JSON.stringify({
    clips: [{ start: 2, end: 10, title: 'Test Clip', hook: 'Hook line', caption: 'Caption here', hashtags: ['test'], reason: 'test', score: 80, platform: 'all', words }],
    summary: 'test',
  }, null, 2));

  console.log('running captions...');
  const clip = { start: 2, end: 10, title: 'Test Clip', words };
  const ass = buildAss(words, transcript.segments, 'karaoke', 'Test Clip');
  const assPath = path.join(FIXTURES, 'test.ass');
  fs.writeFileSync(assPath, ass);
  const dialogueLines = (ass.match(/Dialogue:/g) || []).length;
  if (dialogueLines < 8) throw new Error(`Expected >=8 Dialogue lines, got ${dialogueLines}`);

  console.log('running render...');
  const outFile = path.join(FIXTURES, 'out.mp4');
  await run('ffmpeg', [
    '-ss', '1.7', '-to', '10.3', '-i', sample,
    '-filter_complex', 'scale=-2:1920,crop=1080:1920',
    '-map', '0:a?', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart',
    '-y', outFile,
  ]);
  const info = await probe(outFile);
  console.log('probe:', info);
  if (info.width !== 1080) throw new Error(`width ${info.width} !== 1080`);
  if (info.height !== 1920) throw new Error(`height ${info.height} !== 1920`);
  if (Math.abs(info.duration - 8.6) > 0.5) throw new Error(`duration ${info.duration} not ~8.6s`);
  if (info.vcodec !== 'h264') throw new Error(`vcodec ${info.vcodec} !== h264`);
  if (info.acodec !== 'aac') throw new Error(`acodec ${info.acodec} !== aac`);
  if (info.size < 100 * 1024) throw new Error(`size ${info.size} < 100kB`);

  console.log('testing CLI arg parser (dry-run)...');
  const cliPath = path.join(ROOT, 'src', 'cli.js');
  const p = spawn(process.execPath, [cliPath, '--help'], { shell: process.platform === 'win32' && !path.isAbsolute(process.execPath) });
  let helpOut = '';
  let helpErr = '';
  p.stdout.on('data', d => helpOut += d);
  p.stderr.on('data', d => helpErr += d);
  await new Promise(r => p.on('close', r));
  if (!helpOut.includes('ClipForge') && !helpErr.includes('ClipForge')) throw new Error('CLI help not working');

  console.log('testing --dry-run with heuristic picker...');
  const dryDir = path.join(FIXTURES, 'dryrun-workdir');
  if (!fs.existsSync(dryDir)) fs.mkdirSync(dryDir, { recursive: true });
  const dryWd = path.join(dryDir, 'source');
  if (!fs.existsSync(dryWd)) fs.mkdirSync(dryWd, { recursive: true });
  fs.copyFileSync(sample, path.join(dryWd, 'source.mp4'));
  fs.writeFileSync(path.join(dryWd, 'transcript.json'), JSON.stringify({ language: 'en', segments: [{ start: 0, end: 20, text: 'Hello world this is a test.', words: [{ start: 0, end: 0.5, word: 'Hello' }, { start: 0.5, end: 1, word: 'world' }] }] }, null, 2));
  fs.writeFileSync(path.join(dryWd, 'clips.json'), JSON.stringify({ clips: [{ start: 0, end: 5, title: 'Dry Run', hook: 'Hook', caption: 'Cap', hashtags: ['a'], reason: 'test', score: 50, platform: 'all' }], summary: 'resumed' }, null, 2));
  const p2 = spawn(process.execPath, [cliPath, 'run', path.join(dryWd, 'source.mp4'), '--clips', '1', '--dry-run', '--resume', '--pick', 'heuristic', '--out', dryDir], { shell: process.platform === 'win32' && !path.isAbsolute(process.execPath) });
  let dryOut = '', dryErr = '';
  p2.stdout.on('data', d => dryOut += d);
  p2.stderr.on('data', d => dryErr += d);
  await new Promise(r => p2.on('close', r));
  if (p2.exitCode !== 0) throw new Error(`dry-run exited ${p2.exitCode}: ${dryErr}`);

  console.log('all tests passed');
}

main().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
