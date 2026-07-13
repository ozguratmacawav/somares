// Bulk-uploads the "YTU Museum test" pilot content (Score 01).
// Whispers all go under a single shared role "score" (SESA scripted-score
// pilots target people by participant code, not by role). Machine/ambience
// sounds go in as "mood" clips so the Conductor can swap them per phase.
// Safe to re-run — skips files that are already uploaded (same layer+label).
// Usage: node scripts/upload-ytu-score.js
'use strict';

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  });
}

const { put } = require('@vercel/blob');
const { ensureSchema, insertAudioAsset, listAudioAssets } = require('../lib/db');

const ROOT = path.join(__dirname, '..', 'Audio Files', 'YTU Museum test');

function slugify(name) {
  return name.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
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
    console.error('No "Audio Files/YTU Museum test" folder found.');
    process.exit(1);
  }

  await ensureSchema();
  const existing = await listAudioAssets();
  const already = new Set(existing.map((a) => a.layer + '::' + a.label));

  let count = 0, skipped = 0;

  // Whispers — flat folder, shared "score" role
  const whispersDir = path.join(ROOT, 'YTU_Museum_Whispers');
  if (fs.existsSync(whispersDir)) {
    for (const file of fs.readdirSync(whispersDir)) {
      if (!file.toLowerCase().endsWith('.mp3')) continue;
      if (already.has('whisper::' + file)) { skipped++; continue; }
      const url = await uploadFile(path.join(whispersDir, file), 'whispers/score/' + file);
      await insertAudioAsset({ layer: 'whisper', role: 'score', label: file, url });
      count++;
      console.log('  whisper: score /', file);
    }
  }

  // Machine/hiss sounds — mood layer, one mood_key per file
  const machinesDir = path.join(ROOT, 'YTU_Museum_Machines');
  if (fs.existsSync(machinesDir)) {
    for (const file of fs.readdirSync(machinesDir)) {
      if (!file.toLowerCase().endsWith('.mp3')) continue;
      if (already.has('mood::' + file)) { skipped++; continue; }
      const moodKey = slugify(path.basename(file, path.extname(file)));
      const url = await uploadFile(path.join(machinesDir, file), 'moods/' + file);
      await insertAudioAsset({ layer: 'mood', moodKey, label: file, url });
      count++;
      console.log('  mood:', moodKey, '/', file);
    }
  }

  // Ambience beds (low hum, etc.) — also mood layer, so the Conductor can
  // swap them at phase boundaries the same way as the machine sounds.
  const ambDir = path.join(ROOT, 'Ambiences_YTU_Museum');
  if (fs.existsSync(ambDir)) {
    for (const file of fs.readdirSync(ambDir)) {
      if (!file.toLowerCase().endsWith('.mp3')) continue;
      if (already.has('mood::' + file)) { skipped++; continue; }
      const moodKey = slugify(path.basename(file, path.extname(file)));
      const url = await uploadFile(path.join(ambDir, file), 'moods/' + file);
      await insertAudioAsset({ layer: 'mood', moodKey, label: file, url });
      count++;
      console.log('  mood:', moodKey, '/', file);
    }
  }

  console.log('\nDone. Uploaded ' + count + ', skipped ' + skipped + ' already-present.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
