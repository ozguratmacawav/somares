// Bulk-uploads the Çatalhöyük home-experience content (45 files) with the
// exact label keys the client's hardcoded schedule expects (cmd1, cmd3a,
// cmd10, filler0, etc). Safe to re-run — skips files already uploaded
// (matched on layer+role+label).
// Usage: node scripts/upload-catalhoyuk.js
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

const ROOT = path.join(__dirname, '..', 'Somares-Çatalhöyük');
const VENUE = 'catalhoyuk-home';
const ROLES = ['housekeeper', 'food-provider', 'maker', 'memory-keeper'];

// role -> folder-name fragment used in the recorded filenames
const ROLE_FILE_TAG = {
  housekeeper: 'House_Keeper',
  'food-provider': 'Food_Provider',
  maker: 'Maker',
  'memory-keeper': 'Memory_Keeper'
};

// Recorded filenames use combining-character (NFD) Unicode for Turkish
// letters while this file is saved as precomposed (NFC) — same text,
// different bytes, so exact path joins silently miss. Instead, walk the
// whole tree once and resolve every expected file by its NFC-normalized
// basename, wherever it actually sits.
function walk(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

let FILES_BY_NAME = null;
function resolveFile(filename) {
  if (!FILES_BY_NAME) {
    FILES_BY_NAME = new Map();
    for (const full of walk(ROOT)) {
      FILES_BY_NAME.set(path.basename(full).normalize('NFC'), full);
    }
  }
  return FILES_BY_NAME.get(filename.normalize('NFC')) || null;
}

// [key, filename] — shared block, role = 'shared'
const SHARED_FILES = [
  ['intro', 'baslangicmesajı.mp3'],
  ['cmd1', '1.komut_standstill.mp3'],
  ['cmd2', '2.komut_openyoureyes.mp3'],
  ['cmd3a', '3.komutun_birincisi.mp3'],
  ['cmd3b', '3.komutun_ikincisi.mp3'],
  ['cmd3c', '3.komutun_ücüncüsü.mp3'],
  ['cmd4', '4.komut_turn_around.mp3'],
  ['cmd5a', '5.komutun_1birincisi.mp3'],
  ['cmd5b', '5.komutun_2ikincisi.mp3'],
  ['cmd5c', '5.komutun_3üçüncüsü.mp3'],
  ['cmd5d', '5.komutun_4dördüncüsü.mp3'],
  ['cmd6a', '6.komutun_birincisi.mp3'],
  ['cmd6b', '6.komutun_ikincisi.mp3'],
  ['cmd7', '7.komut.mp3'],
  ['cmd8a', '8.komutun_1birincisi.mp3'],
  ['cmd8b', '8.komut_2ikincisi.mp3'],
  ['cmd9a', '9.komutun_1birincisi.mp3'],
  ['cmd9b', '9.komutun_2ikincisi.mp3']
];

// retreat, role = 'shared'
const RETREAT_FILES = [
  ['cmd15', '15.Komut_All.mp3'],
  ['cmd17', '17.Komut_All.mp3']
];

// filler, role = 'filler', 0-indexed to match the server's random-index pick
const FILLER_FILES = [
  ['filler0', '1.Boşluk_Doldurma_All.mp3'],
  ['filler1', '2.Boşluk_Doldurma_All.mp3'],
  ['filler2', '3.Boşluk_Doldurma_All.mp3'],
  ['filler3', '4.Boşluk_Doldurma_All.mp3']
];

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
    console.error('No "Somares-Çatalhöyük" folder found at', ROOT);
    process.exit(1);
  }

  await ensureSchema();
  const existing = await listAudioAssets();
  const already = new Set(existing.map((a) => a.layer + '::' + (a.role || '') + '::' + a.label));

  let count = 0, skipped = 0;

  async function uploadOne(layer, role, key, filename, blobFolder) {
    const localPath = resolveFile(filename);
    if (!localPath) {
      console.warn('  MISSING FILE:', filename);
      return;
    }
    if (already.has(layer + '::' + (role || '') + '::' + key)) { skipped++; return; }
    const url = await uploadFile(localPath, blobFolder + '/' + key + '.mp3');
    await insertAudioAsset({ layer, role: role || null, venue: layer === 'ambience' ? VENUE : null, label: key, url });
    count++;
    console.log('  ' + layer + ' / ' + (role || '(none)') + ' / ' + key);
  }

  // Shared block (1-9 + intro)
  for (const [key, file] of SHARED_FILES) {
    await uploadOne('whisper', 'shared', key, file, 'catalhoyuk/shared');
  }

  // Retreat (15, 17) — also role 'shared'
  for (const [key, file] of RETREAT_FILES) {
    await uploadOne('whisper', 'shared', key, file, 'catalhoyuk/shared');
  }

  // Filler pool
  for (const [key, file] of FILLER_FILES) {
    await uploadOne('whisper', 'filler', key, file, 'catalhoyuk/filler');
  }

  // Per-role: command 10 (role reveal) + 11-14 (asymmetric work)
  for (const role of ROLES) {
    const tag = ROLE_FILE_TAG[role];
    await uploadOne('whisper', role, 'cmd10', '10.Komut_' + tag + '.mp3', 'catalhoyuk/' + role);
    for (const n of [11, 12, 13, 14]) {
      await uploadOne('whisper', role, 'cmd' + n, n + '.Komut_' + tag + '.mp3', 'catalhoyuk/' + role);
    }
  }

  // Background bed
  await uploadOne('ambience', null, 'background', 'Somares20min_background.mp3', 'catalhoyuk/ambience');

  console.log('Done. Uploaded', count, ', skipped (already present)', skipped + '.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
