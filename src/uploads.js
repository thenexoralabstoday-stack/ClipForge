// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import fs from 'node:fs';
import path from 'node:path';
import { run } from './util.js';

// ─── YouTube OAuth Upload ───────────────────────────────────────────────────

export async function uploadToYouTube(clipPath, title, description, tags, opts = {}) {
  const token = opts.token || process.env.YOUTUBE_TOKEN;
  if (!token) {
    throw new Error('YouTube OAuth access token required. Set YOUTUBE_TOKEN or pass token option.');
  }

  const metadata = {
    snippet: {
      title: title || 'Untitled Clip',
      description: description || '',
      tags: tags || [],
      categoryId: '22',
    },
    status: {
      privacyStatus: opts.privacy || 'private',
      selfDeclaredMadeForKids: false,
    },
  };

  const metaFile = clipPath + '.meta.json';
  fs.writeFileSync(metaFile, JSON.stringify(metadata));

  try {
    const result = await run('curl', [
      '-X', 'POST',
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Content-Type: application/json',
      '-d', '@' + metaFile,
    ], { quiet: true });

    const match = result.out.match(/"id":\s*"([^"]+)"/);
    return match ? match[1] : null;
  } finally {
    if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
  }
}

export async function refreshYouTubeToken(refreshToken) {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('YouTube OAuth client credentials required. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.');
  }

  const result = await run('curl', [
    '-X', 'POST',
    'https://oauth2.googleapis.com/token',
    '-H', 'Content-Type: application/x-www-form-urlencoded',
    '-d', `grant_type=refresh_token&refresh_token=${refreshToken}&client_id=${clientId}&client_secret=${clientSecret}`,
  ], { quiet: true });

  const match = result.out.match(/"access_token":\s*"([^"]+)"/);
  if (!match) throw new Error('Failed to refresh YouTube token');
  return match[1];
}

export function getYouTubeAuthUrl(state = 'clipforge') {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  if (!clientId) {
    throw new Error('YouTube OAuth client ID required. Set YOUTUBE_CLIENT_ID.');
  }
  const redirectUri = encodeURIComponent(process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:5173/auth/youtube/callback');
  const scope = encodeURIComponent('https://www.googleapis.com/auth/youtube.upload');
  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}&access_type=offline&prompt=consent`;
}

export async function exchangeYouTubeCode(code) {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:5173/auth/youtube/callback';
  
  if (!clientId || !clientSecret) {
    throw new Error('YouTube OAuth client credentials required.');
  }

  const result = await run('curl', [
    '-X', 'POST',
    'https://oauth2.googleapis.com/token',
    '-H', 'Content-Type: application/x-www-form-urlencoded',
    '-d', `grant_type=authorization_code&code=${code}&redirect_uri=${redirectUri}&client_id=${clientId}&client_secret=${clientSecret}`,
  ], { quiet: true });

  const match = result.out.match(/"access_token":\s*"([^"]+)"[^}]*"refresh_token":\s*"([^"]+)"/);
  if (!match) throw new Error('Failed to exchange YouTube code');
  return { accessToken: match[1], refreshToken: match[2] };
}

// ─── TikTok Content Posting API ──────────────────────────────────────────────

export async function uploadToTikTok(clipPath, title, description, opts = {}) {
  const accessToken = opts.accessToken || process.env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('TikTok access token required. Set TIKTOK_ACCESS_TOKEN or pass accessToken option.');
  }

  // Step 1: Initialize upload
  const initResult = await run('curl', [
    '-X', 'POST',
    'https://open.tiktokapis.com/v2/post/video/init/',
    '-H', `Authorization: Bearer ${accessToken}`,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({
      post_info: {
        title: title || 'Untitled Clip',
        description: description || '',
        privacy_level: opts.privacy || 'SELF_ONLY',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: fs.statSync(clipPath).size,
        chunk_size: 10000000,
      },
    }),
  ], { quiet: true });

  const initData = JSON.parse(initResult.out);
  if (initData.error?.code !== 'ok') {
    throw new Error(`TikTok init failed: ${initData.error?.message || initResult.out}`);
  }

  const publishId = initData.data.publish_id;
  const uploadUrl = initData.data.upload_url;

  // Step 2: Upload video chunk by chunk
  const chunkSize = 10000000;
  const fileSize = fs.statSync(clipPath).size;
  const fileBuffer = fs.readFileSync(clipPath);
  
  for (let offset = 0; offset < fileSize; offset += chunkSize) {
    const chunk = fileBuffer.slice(offset, offset + chunkSize);
    const chunkNumber = Math.floor(offset / chunkSize) + 1;
    const totalChunks = Math.ceil(fileSize / chunkSize);
    
    await run('curl', [
      '-X', 'PUT',
      uploadUrl,
      '-H', 'Content-Type: ' + (chunkNumber === totalChunks ? 'video/mp4' : 'application/octet-stream'),
      '-H', 'Content-Range', `bytes ${offset}-${Math.min(offset + chunkSize - 1, fileSize - 1)}/${fileSize}`,
      '--data-binary', '@-' ,
    ], { quiet: true, input: chunk });
  }

  // Step 3: Check publish status
  const statusResult = await run('curl', [
    '-X', 'GET',
    `https://open.tiktokapis.com/v2/post/video/status/?publish_id=${publishId}`,
    '-H', `Authorization: Bearer ${accessToken}`,
  ], { quiet: true });

  const statusData = JSON.parse(statusResult.out);
  if (statusData.data?.status === 'PUBLISH_COMPLETE') {
    return statusData.data.item_id;
  }

  return publishId;
}

export function getTikTokAuthUrl(state = 'clipforge') {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) {
    throw new Error('TikTok client key required. Set TIKTOK_CLIENT_KEY.');
  }
  const redirectUri = encodeURIComponent(process.env.TIKTOK_REDIRECT_URI || 'http://localhost:5173/auth/tiktok/callback');
  return `https://www.tiktok.com/v2/auth/authorize?client_key=${clientKey}&redirect_uri=${redirectUri}&response_type=code&scope=video.publish,video.upload&state=${state}`;
}

export async function exchangeTikTokCode(code) {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI || 'http://localhost:5173/auth/tiktok/callback';
  
  if (!clientKey || !clientSecret) {
    throw new Error('TikTok OAuth credentials required.');
  }

  const result = await run('curl', [
    '-X', 'POST',
    'https://open.tiktokapis.com/v2/oauth/token/',
    '-H', 'Content-Type: application/x-www-form-urlencoded',
    '-d', `grant_type=authorization_code&code=${code}&redirect_uri=${redirectUri}&client_key=${clientKey}&client_secret=${clientSecret}`,
  ], { quiet: true });

  const data = JSON.parse(result.out);
  if (data.error) throw new Error(`TikTok auth failed: ${data.error_description || data.error}`);
  return { accessToken: data.data.access_token, refreshToken: data.data.refresh_token, expiresIn: data.data.expires_in };
}

// ─── Instagram Graph API ─────────────────────────────────────────────────────

export async function uploadToInstagram(clipPath, caption, opts = {}) {
  const accessToken = opts.accessToken || process.env.INSTAGRAM_ACCESS_TOKEN;
  const userId = opts.userId || process.env.INSTAGRAM_USER_ID;
  
  if (!accessToken || !userId) {
    throw new Error('Instagram access token and user ID required. Set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID.');
  }

  // Step 1: Create media container
  const containerResult = await run('curl', [
    '-X', 'POST',
    `https://graph.facebook.com/v18.0/${userId}/media`,
    '-H', `Authorization: Bearer ${accessToken}`,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({
      media_type: 'REELS',
      video_url: clipPath,
      caption: caption || '',
      share_to_feed: true,
    }),
  ], { quiet: true });

  const containerData = JSON.parse(containerResult.out);
  if (containerData.error) {
    throw new Error(`Instagram container creation failed: ${containerData.error.message}`);
  }

  const creationId = containerData.id;

  // Step 2: Publish media
  const publishResult = await run('curl', [
    '-X', 'POST',
    `https://graph.facebook.com/v18.0/${userId}/media_publish`,
    '-H', `Authorization: Bearer ${accessToken}`,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({
      creation_id: creationId,
      publish: true,
    }),
  ], { quiet: true });

  const publishData = JSON.parse(publishResult.out);
  if (publishData.error) {
    throw new Error(`Instagram publish failed: ${publishData.error.message}`);
  }

  return publishData.id;
}

export function getInstagramAuthUrl(state = 'clipforge') {
  const appId = process.env.INSTAGRAM_APP_ID;
  if (!appId) {
    throw new Error('Instagram App ID required. Set INSTAGRAM_APP_ID.');
  }
  const redirectUri = encodeURIComponent(process.env.INSTAGRAM_REDIRECT_URI || 'http://localhost:5173/auth/instagram/callback');
  return `https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=instagram_basic,instagram_content_publish,pages_read_engagement&state=${state}`;
}

export async function exchangeInstagramCode(code) {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI || 'http://localhost:5173/auth/instagram/callback';
  
  if (!appId || !appSecret) {
    throw new Error('Instagram OAuth credentials required.');
  }

  const result = await run('curl', [
    '-X', 'GET',
    `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=authorization_code&code=${code}&redirect_uri=${redirectUri}&client_id=${appId}&client_secret=${appSecret}`,
  ], { quiet: true });

  const data = JSON.parse(result.out);
  if (data.error) throw new Error(`Instagram auth failed: ${data.error.message}`);
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

// ─── Unified upload helper ───────────────────────────────────────────────────

export async function uploadClip(clipPath, platform, metadata, opts = {}) {
  switch (platform) {
    case 'youtube':
    case 'youtube-shorts':
      return uploadToYouTube(clipPath, metadata.title, metadata.caption, metadata.hashtags, opts);
    case 'tiktok':
      return uploadToTikTok(clipPath, metadata.title || metadata.hook, metadata.caption, opts);
    case 'instagram':
    case 'reels':
      return uploadToInstagram(clipPath, metadata.caption, opts);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
