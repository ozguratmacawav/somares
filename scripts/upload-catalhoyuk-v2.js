// Bulk-uploads the revised Çatalhöyük content ("YENİ GÜNCEL SESLER", 85
// files): all 32 shared commands, per-role asymmetric work, retreat, and
// the two-tier filler system
// (5 general + 1 role-specific each). Deletes the old whisper-layer
// content first (this replaces it entirely) but leaves the ambience
// background row untouched. Safe to re-run.
// Usage: node scripts/upload-catalhoyuk-v2.js
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
const { Pool } = require('pg');
const { ensureSchema, insertAudioAsset } = require('../lib/db');

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const ROOT = path.join(__dirname, '..', 'YENİ GÜNCEL SESLER');
const ROLES = ['housekeeper', 'food-provider', 'maker', 'memory-keeper'];
const ROLE_FOLDER_TAG = {
  housekeeper: 'House_Keeper',
  'food-provider': 'Food_Provider',
  maker: 'Maker',
  'memory-keeper': 'Memory_Keeper'
};
const ROLE_NAME_WORDS = {
  housekeeper: 'House Keeper',
  'food-provider': 'Food Provider',
  maker: 'Maker',
  'memory-keeper': 'Memory Keeper'
};

function walk(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__MACOSX' || entry.name.startsWith('._')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else if (entry.name.toLowerCase().endsWith('.mp3')) out.push(full);
  }
  return out;
}

let ALL_FILES = null;
function allFiles() {
  if (!ALL_FILES) {
    ALL_FILES = walk(ROOT).map((f) => ({
      full: f,
      dir: path.basename(path.dirname(f)).normalize('NFC'),
      base: path.basename(f).normalize('NFC')
    }));
  }
  return ALL_FILES;
}

// Finds exactly one file whose parent-folder name contains dirHint and
// whose filename starts with basePrefix. Logs and returns null on 0 or 2+.
function findOne(dirHint, basePrefix, label) {
  const matches = allFiles().filter((f) =>
    f.dir.toLowerCase().indexOf(dirHint.toLowerCase()) !== -1 &&
    f.base.toLowerCase().startsWith(basePrefix.toLowerCase())
  );
  if (matches.length === 0) { console.warn('  MISSING:', label, '(dir~"' + dirHint + '", prefix"' + basePrefix + '")'); return null; }
  if (matches.length > 1) { console.warn('  AMBIGUOUS:', label, '->', matches.map((m) => m.base)); }
  return matches[0].full;
}

async function uploadFile(localPath, blobPath) {
  const data = fs.readFileSync(localPath);
  const blob = await put(blobPath, data, { access: 'public', contentType: 'audio/mpeg', addRandomSuffix: true });
  return blob.url;
}

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error('No "YENİ GÜNCEL SESLER" folder found at', ROOT);
    process.exit(1);
  }

  await ensureSchema();

  console.log('Clearing old whisper-layer content (keeping the ambience background)...');
  await pool.query(`DELETE FROM audio_assets WHERE layer = 'whisper';`);

  let count = 0;

  async function uploadOne(role, key, localPath, blobFolder) {
    if (!localPath) return;
    const url = await uploadFile(localPath, blobFolder + '/' + key + '.mp3');
    await insertAudioAsset({ layer: 'whisper', role, label: key, url });
    count++;
    console.log('  whisper /', role, '/', key);
  }

  // --- intro (kept from the original recording, not part of the re-record) ---
  const INTRO_PATH = path.join(__dirname, '..', 'Somares-Çatalhöyük', 'Komutlar', '1-9 Komutlar', 'baslangicmesajı.mp3');
  await uploadOne('shared', 'intro', fs.existsSync(INTRO_PATH) ? INTRO_PATH : null, 'catalhoyuk2/shared');

  // --- 1-32 shared block ---
  const SHARED_NUMBERS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32];
  for (const n of SHARED_NUMBERS) {
    const prefix = (n < 10 ? '0' + n : String(n)) + '-';
    const f = findOne('1-32 ORTAK', prefix, 'cmd' + n);
    await uploadOne('shared', 'cmd' + n, f, 'catalhoyuk2/shared');
  }

  // --- 33: role reveal, one per role ---
  for (const role of ROLES) {
    const f = findOne('Rol Dag', ROLE_NAME_WORDS[role], 'role33-' + role);
    // findOne matches basename startsWith — role-reveal files are named
    // "33-You have a role <Role>.mp3", so search by the role words anywhere
    // in the basename instead of a strict prefix.
    const alt = f || (function(){
      const matches = allFiles().filter((x) =>
        x.dir.toLowerCase().indexOf('rol dag') !== -1 &&
        x.base.toLowerCase().indexOf(ROLE_NAME_WORDS[role].toLowerCase()) !== -1
      );
      return matches[0] ? matches[0].full : null;
    })();
    await uploadOne(role, 'role33', alt, 'catalhoyuk2/' + role);
  }

  // --- 34-37 (local numbering) asymmetric work, per role, lettered sub-parts ---
  const WORK_MAP = {
    housekeeper: { 34: ['A','B'], 35: ['A','B','C'], 36: ['A','B'], 37: ['A','B','C'] },
    'food-provider': { 34: ['A','B'], 35: ['A','B','C'], 36: ['A','B'], 37: ['A','B'] },
    maker: { 34: ['A','B'], 35: ['A','B'], 36: ['A','B','C','D'], 37: ['A','B'] },
    'memory-keeper': { 34: ['A','B'], 35: ['A'], 36: ['A','B'], 37: ['A','B'] }
  };
  for (const role of ROLES) {
    const tag = ROLE_FOLDER_TAG[role];
    const dirHint = '34-37_' + tag;
    for (const num of Object.keys(WORK_MAP[role])) {
      for (const letter of WORK_MAP[role][num]) {
        const prefix = num + '-' + letter;
        const f = findOne(dirHint, prefix, 'w' + num + letter + '-' + role);
        await uploadOne(role, 'w' + num + letter.toLowerCase(), f, 'catalhoyuk2/' + role);
      }
    }
  }

  // --- 38-40 retreat, shared ---
  const RETREAT = [['38A', '38-A'], ['38B', '38-B'], ['38C', '38-C'], ['r40', '40-']];
  for (const [key, prefix] of RETREAT) {
    const f = findOne('38-40', prefix, key);
    await uploadOne('shared', key, f, 'catalhoyuk2/shared');
  }

  // --- General fillers A-E, shared pool ---
  for (const letter of ['A','B','C','D','E']) {
    const f = findOne('Genel Bos', letter + '_', 'filler' + letter);
    await uploadOne('filler', 'filler' + letter.toLowerCase(), f, 'catalhoyuk2/filler');
  }

  // --- Role-specific filler, one per role ---
  for (const role of ROLES) {
    const tag = ROLE_FOLDER_TAG[role];
    const f = findOne('zel Bos', tag, 'fillerRole-' + role);
    await uploadOne(role, 'fillerRole', f, 'catalhoyuk2/' + role);
  }

  console.log('Done. Uploaded', count, 'files.');
  await pool.end();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
