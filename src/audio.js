// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import fs from 'node:fs';
import path from 'node:path';
import { run, log } from './util.js';

const AUDIO_DIR = path.resolve('./assets/audio');
const MEME_SOUNDS = {
  'vine-boom': 'https://www.soundjay.com/misc/sounds/vine-boom.mp3',
  'bruh': 'https://www.soundjay.com/misc/sounds/bruh.mp3',
  'sad-violin': 'https://www.soundjay.com/misc/sounds/sad-violin.mp3',
  'air-horn': 'https://www.soundjay.com/misc/sounds/air-horn.mp3',
  'drumroll': 'https://www.soundjay.com/misc/sounds/drumroll.mp3',
  'record-scratch': 'https://www.soundjay.com/misc/sounds/record-scratch.mp3',
  'laugh-track': 'https://www.soundjay.com/misc/sounds/laugh-track.mp3',
  'sad-trombone': 'https://www.soundjay.com/misc/sounds/sad-trombone.mp3',
};

export async function listAvailableSounds() {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  return Object.keys(MEME_SOUNDS);
}

export async function addMemeSoundToClip(clipPath, soundName, options = {}) {
  const { volume = 0.3, fadeIn = 0.1, fadeOut = 0.1 } = options;
  
  if (!MEME_SOUNDS[soundName]) {
    throw new Error(`Unknown sound: ${soundName}. Available: ${Object.keys(MEME_SOUNDS).join(', ')}`);
  }

  const soundUrl = MEME_SOUNDS[soundName];
  const soundPath = path.join(AUDIO_DIR, `${soundName}.mp3`);
  
  if (!fs.existsSync(soundPath)) {
    log(`Downloading meme sound: ${soundName}`);
    await run('curl', ['-L', '-o', soundPath, soundUrl], { quiet: true }).catch(() => {});
  }

  if (!fs.existsSync(soundPath)) {
    throw new Error(`Failed to download sound: ${soundName}`);
  }

  const outputPath = clipPath.replace('.mp4', `_${soundName}.mp4`);
  const filterComplex = `[0:a]volume=1[orig];[1:a]volume=${volume},afade=t=in:st=0:d=${fadeIn},afade=t=out:st=3:d=${fadeOut}[sfx];[orig][sfx]amix=inputs=2:duration=shortest[aout]`;
  
  await run('ffmpeg', [
    '-i', clipPath,
    '-i', soundPath,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-shortest',
    outputPath,
  ], { quiet: true });

  return outputPath;
}

export async function addMemeSoundAtTime(clipPath, soundName, timeSeconds, options = {}) {
  const { volume = 0.3 } = options;
  
  if (!MEME_SOUNDS[soundName]) {
    throw new Error(`Unknown sound: ${soundName}. Available: ${Object.keys(MEME_SOUNDS).join(', ')}`);
  }

  const soundUrl = MEME_SOUNDS[soundName];
  const soundPath = path.join(AUDIO_DIR, `${soundName}.mp3`);
  
  if (!fs.existsSync(soundPath)) {
    log(`Downloading meme sound: ${soundName}`);
    await run('curl', ['-L', '-o', soundPath, soundUrl], { quiet: true }).catch(() => {});
  }

  if (!fs.existsSync(soundPath)) {
    throw new Error(`Failed to download sound: ${soundName}`);
  }

  const outputPath = clipPath.replace('.mp4', `_meme_${soundName}.mp4`);
  const delayMs = Math.floor(timeSeconds * 1000);
  
  const filterComplex = `[0:a]volume=1[orig];[1:a]volume=${volume},adelay=${delayMs}|${delayMs}[sfx];[orig][sfx]amix=inputs=2:duration=shortest[aout]`;
  
  await run('ffmpeg', [
    '-i', clipPath,
    '-i', soundPath,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-shortest',
    outputPath,
  ], { quiet: true });

  return outputPath;
}

export async function addMultipleMemeSounds(clipPath, soundTimings, options = {}) {
  const { volume = 0.3 } = options;
  
  if (!soundTimings || soundTimings.length === 0) {
    return clipPath;
  }

  const downloadedSounds = [];
  for (const timing of soundTimings) {
    const soundName = timing.sound;
    if (!MEME_SOUNDS[soundName]) continue;
    
    const soundPath = path.join(AUDIO_DIR, `${soundName}.mp3`);
    if (!fs.existsSync(soundPath)) {
      await run('curl', ['-L', '-o', soundPath, MEME_SOUNDS[soundName]], { quiet: true }).catch(() => {});
    }
    if (fs.existsSync(soundPath)) {
      downloadedSounds.push({ path: soundPath, time: timing.time, volume });
    }
  }

  if (downloadedSounds.length === 0) return clipPath;

  let currentInput = clipPath;
  
  for (let i = 0; i < downloadedSounds.length; i++) {
    const sound = downloadedSounds[i];
    const outputPath = clipPath.replace('.mp4', `_meme_${i}.mp4`);
    const delayMs = Math.floor(sound.time * 1000);
    
    const filterComplex = `[0:a]volume=1[orig];[1:a]volume=${sound.volume},adelay=${delayMs}|${delayMs}[sfx];[orig][sfx]amix=inputs=2:duration=shortest[aout]`;
    
    await run('ffmpeg', [
      '-i', currentInput,
      '-i', sound.path,
      '-filter_complex', filterComplex,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-shortest',
      outputPath,
    ], { quiet: true });
    
    currentInput = outputPath;
  }

  return currentInput;
}
