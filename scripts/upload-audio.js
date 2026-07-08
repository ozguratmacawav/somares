// One-time/rerunnable bulk uploader: walks the local "Audio Files" folder,
// pushes every file to Vercel Blob, and records it in audio_assets.
// Usage: node scripts/upload-audio.js
'use strict';

const fs = require('fs');
const path = require('path');

// Load .env.local manually (no dotenv dependency needed for this one-off script).
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  });
}

const { put } = require('@vercel/blob');
const { ensureSchema, insertAudioAsset } = require('../lib/db');

const ROOT = path.join(__dirname, '..', 'Audio Files');

const KNOWN_ROLES = new Set([
  'merchant', 'traveler', 'translator', 'innkeeper', 'guard',
  'storyteller', 'pilgrim', 'caravan-guide', 'spice-trader', 'messenger'
]);

const KNOWN_VENUES = ['yildiz-museum', 'catalhoyuk', 'ciurlionis', 'fondazione-ago'];

function slugify(name) {
  return name
    .replace(/^\d+[-_]/, '')          // strip leading "01-" etc.
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function detectVenue(filename) {
  const norm = filename.toLowerCase().replace(/_/g, '-');
  return KNOWN_VENUES.find((v) => norm.startsWith(v)) || null;
}

async function uploadFile(localPath, blobPath) {
  const data = fs.readFileSync(localPath);
  const blob = await put(blobPath, data, {
    access: 'public',
    contentType: 'audio/mpeg',
    addRandomSuffix: true
  });
  return blob.url;
}

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error('No "Audio Files" folder found at', ROOT);
    process.exit(1);
  }

  await ensureSchema();

  let count = 0;

  // Layer 1 — Whispers, one subfolder per role
  const whispersDir = path.join(ROOT, 'Layer_1_Whispers');
  if (fs.existsSync(whispersDir)) {
    for (const roleFolder of fs.readdirSync(whispersDir)) {
      const roleDir = path.join(whispersDir, roleFolder);
      if (!fs.statSync(roleDir).isDirectory()) continue;
      const role = slugify(roleFolder);
      if (!KNOWN_ROLES.has(role)) {
        console.warn('Skipping unrecognized role folder:', roleFolder);
        continue;
      }
      for (const file of fs.readdirSync(roleDir)) {
        if (!file.toLowerCase().endsWith('.mp3')) continue;
        const localPath = path.join(roleDir, file);
        const url = await uploadFile(localPath, `whispers/${role}/${file}`);
        await insertAudioAsset({ layer: 'whisper', role, label: file, url });
        count++;
        console.log('  whisper:', role, '/', file);
      }
    }
  }

  // Layer 2 — Moods, flat folder, shared across venues/roles
  const moodsDir = path.join(ROOT, 'Layer_2_Moods');
  if (fs.existsSync(moodsDir)) {
    for (const file of fs.readdirSync(moodsDir)) {
      if (!file.toLowerCase().endsWith('.mp3')) continue;
      const moodKey = slugify(path.basename(file, path.extname(file)));
      const localPath = path.join(moodsDir, file);
      const url = await uploadFile(localPath, `moods/${file}`);
      await insertAudioAsset({ layer: 'mood', moodKey, label: file, url });
      count++;
      console.log('  mood:', moodKey, '/', file);
    }
  }

  // Layer 3 — Ambiences, flat folder, one or more files per venue
  const ambDir = path.join(ROOT, 'Layer_3_Ambiences');
  if (fs.existsSync(ambDir)) {
    for (const file of fs.readdirSync(ambDir)) {
      if (!file.toLowerCase().endsWith('.mp3')) continue;
      const venue = detectVenue(file);
      if (!venue) {
        console.warn('Skipping ambience file with unrecognized venue:', file);
        continue;
      }
      const localPath = path.join(ambDir, file);
      const url = await uploadFile(localPath, `ambiences/${venue}/${file}`);
      await insertAudioAsset({ layer: 'ambience', venue, label: file, url });
      count++;
      console.log('  ambience:', venue, '/', file);
    }
  }

  console.log(`\nDone. Uploaded ${count} files.`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
