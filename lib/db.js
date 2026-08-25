const { Pool } = require('pg');

// Different Postgres marketplace integrations (Neon, Supabase, ...) name their
// connection string env var differently — check the common ones.
const connectionString =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL;

const pool = new Pool({
  connectionString,
  ssl: connectionString && connectionString.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

const GROUP_SIZE = 4;

let schemaReady = null;

// Idempotent — safe to call on every cold start. Cheap no-op once tables exist.
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      // One row per independent group session — this is what "Create Group"
      // creates and "Join Group" joins. Replaces the old single
      // one-session-per-venue design, so separate groups of 4 can run their
      // own experiences at the same time without colliding.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_code TEXT PRIMARY KEY,
          venue TEXT NOT NULL,
          member_count INTEGER NOT NULL DEFAULT 0,
          started_at TIMESTAMPTZ,
          filler_schedule TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS registrations (
          id SERIAL PRIMARY KEY,
          participant_code TEXT NOT NULL,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL,
          venue TEXT NOT NULL,
          session_code TEXT,
          role TEXT NOT NULL,
          position_in_group INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
      await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS session_code TEXT;`);
      // Pre-existing tables (from the old single-session-per-venue design)
      // had group_index NOT NULL — sessions now carry that concept instead.
      await pool.query(`ALTER TABLE registrations ALTER COLUMN group_index DROP NOT NULL;`).catch(() => {});
      // Observer-panel visibility into the pre-scheduled, client-driven
      // playback: the label of the last clip a participant's device
      // confirmed playing, when, and (if an operator ever needs to recover
      // a stuck device) the timestamp of the last "force resync" request.
      await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS current_clip TEXT;`);
      await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS current_clip_at TIMESTAMPTZ;`);
      await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS force_resync_at TIMESTAMPTZ;`);
      // layer: 'whisper' (role = 'shared' | 'filler' | one of the four
      // Çatalhöyük roles) | 'ambience' (the single 20-minute background bed).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS audio_assets (
          id SERIAL PRIMARY KEY,
          layer TEXT NOT NULL,
          venue TEXT,
          role TEXT,
          mood_key TEXT,
          label TEXT NOT NULL,
          url TEXT NOT NULL,
          volume REAL NOT NULL DEFAULT 1.0,
          category TEXT NOT NULL DEFAULT 'state',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS volume REAL NOT NULL DEFAULT 1.0;`);
      await pool.query(`ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'state';`);
    })();
  }
  return schemaReady;
}

// "12.3:0,340.1:2" -> [{ t: 12.3, clip: 0 }, { t: 340.1, clip: 2 }]
function parseFillerSchedule(raw) {
  if (!raw) return [];
  return raw.split(',').map((pair) => {
    const [t, clip] = pair.split(':');
    return { t: Number(t), clip: Number(clip) };
  });
}

// One filler per asymmetric gap (11->12, 12->13, 13->14, 14->retreat),
// landing partway through that specific gap — not right after the cue that
// opened it — so it reads as "keep going, you're still on track" rather
// than an immediate reaction. Boundaries are the average across the four
// roles' cmd12/13/14 timings (they differ by only a few seconds), which is
// close enough for every phone to feel like its own gap's midpoint even
// though the moment itself is identical for all four.
function randomFillerSchedule(fillerCount) {
  const GAP_BOUNDARIES = [450, 618.45, 786.45, 954.13, 1121.4]; // cmd11, ~cmd12, ~cmd13, ~cmd14, retreat
  const MID_LOW = 0.35, MID_HIGH = 0.7; // place within this middle stretch of each gap
  const n = fillerCount > 0 ? fillerCount : 1;
  const picks = [];
  for (let i = 0; i < GAP_BOUNDARIES.length - 1; i++) {
    const start = GAP_BOUNDARIES[i], end = GAP_BOUNDARIES[i + 1];
    const frac = MID_LOW + Math.random() * (MID_HIGH - MID_LOW);
    const t = start + (end - start) * frac;
    picks.push(t.toFixed(1) + ':' + Math.floor(Math.random() * n));
  }
  return picks.join(',');
}

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L — avoids read-aloud ambiguity
function generateSessionCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

// Creates a brand-new, empty session (member_count 0). Retries on the rare
// code collision instead of ever failing the caller.
async function createSession(venue) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateSessionCode();
    const result = await pool.query(
      `INSERT INTO sessions (session_code, venue) VALUES ($1, $2)
       ON CONFLICT (session_code) DO NOTHING
       RETURNING session_code;`,
      [code, venue]
    );
    if (result.rows[0]) return result.rows[0].session_code;
  }
  throw new Error('Could not allocate a session code');
}

async function getSession(sessionCode) {
  const result = await pool.query(
    `SELECT venue, member_count, started_at, filler_schedule FROM sessions WHERE session_code = $1;`,
    [sessionCode]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    venue: row.venue,
    memberCount: row.member_count,
    startedAt: row.started_at,
    fillerSchedule: parseFillerSchedule(row.filler_schedule)
  };
}

// Atomically claims the next open slot in a session — fails (returns null)
// if the session doesn't exist, is already full, or has already started,
// so two people racing to join never both land on the same slot.
async function joinSession(sessionCode) {
  const result = await pool.query(
    `UPDATE sessions SET member_count = member_count + 1, updated_at = now()
     WHERE session_code = $1 AND member_count < $2 AND started_at IS NULL
     RETURNING member_count, venue;`,
    [sessionCode, GROUP_SIZE]
  );
  if (!result.rows[0]) return null;
  return { positionInGroup: result.rows[0].member_count - 1, venue: result.rows[0].venue };
}

// Participant-triggered (no admin key needed) — any registered phone in the
// group can start their session's shared clock once everyone's ready.
async function startSessionByCode(sessionCode, fillerCount) {
  const schedule = randomFillerSchedule(fillerCount);
  const result = await pool.query(
    `UPDATE sessions SET started_at = now(), filler_schedule = $2, updated_at = now()
     WHERE session_code = $1
     RETURNING started_at, filler_schedule;`,
    [sessionCode, schedule]
  );
  if (!result.rows[0]) return null;
  return {
    startedAt: result.rows[0].started_at,
    fillerSchedule: parseFillerSchedule(result.rows[0].filler_schedule)
  };
}

// Abandons this one session — deletes it and its registrations. Scoped to
// a single session_code, so unlike the old venue-wide reset this can never
// affect any other group's in-progress experience.
async function resetSessionByCode(sessionCode) {
  await pool.query(`DELETE FROM registrations WHERE session_code = $1;`, [sessionCode]);
  await pool.query(`DELETE FROM sessions WHERE session_code = $1;`, [sessionCode]);
}

// Sessions a new participant could join right now: not started, not full,
// and recent (older abandoned sessions age out of the list rather than
// accumulating forever — they just stop being offered, the reset-on-block
// flow still cleans them up on contact).
async function listOpenSessions(venue) {
  const result = await pool.query(
    `SELECT session_code, member_count, created_at FROM sessions
     WHERE venue = $1 AND started_at IS NULL AND member_count < $2
       AND created_at > now() - interval '3 hours'
     ORDER BY created_at DESC LIMIT 20;`,
    [venue, GROUP_SIZE]
  );
  return result.rows.map((r) => ({
    sessionCode: r.session_code,
    memberCount: r.member_count,
    createdAt: r.created_at
  }));
}

// Called periodically by the client (not just on clip changes) — doubles as
// the presence heartbeat and the observer panel's "where are they right
// now" signal.
async function reportProgress(participantCode, clipKey) {
  await pool.query(
    `UPDATE registrations SET current_clip = $2, current_clip_at = now(), last_seen_at = now() WHERE participant_code = $1;`,
    [participantCode, clipKey]
  );
}

// Marks a "force resync" request for one participant; their client picks
// this up on its next poll and recomputes its position from elapsed time.
async function requestResync(participantCode) {
  const result = await pool.query(
    `UPDATE registrations SET force_resync_at = now() WHERE participant_code = $1 RETURNING force_resync_at;`,
    [participantCode]
  );
  return result.rows[0] ? result.rows[0].force_resync_at : null;
}

// Returns this participant's force_resync_at, so the client can notice a
// fresh "force resync" request from the observer panel on its next poll.
async function touchLastSeen(participantCode) {
  const result = await pool.query(
    `UPDATE registrations SET last_seen_at = now() WHERE participant_code = $1 RETURNING force_resync_at;`,
    [participantCode]
  );
  return result.rows[0] ? result.rows[0].force_resync_at : null;
}

// Everyone registered in this session, in join order, with everything the
// observer panel needs: presence, role, and live schedule progress.
async function listPresence(sessionCode) {
  const result = await pool.query(
    `SELECT participant_code, first_name, last_name, role, last_seen_at, created_at,
            current_clip, current_clip_at, force_resync_at
     FROM registrations WHERE session_code = $1 ORDER BY created_at ASC LIMIT 200;`,
    [sessionCode]
  );
  return result.rows;
}

async function deleteRegistration(participantCode) {
  await pool.query(`DELETE FROM registrations WHERE participant_code = $1;`, [participantCode]);
}

async function insertAudioAsset(record) {
  const result = await pool.query(
    `INSERT INTO audio_assets (layer, venue, role, mood_key, label, url, volume, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id;`,
    [record.layer, record.venue || null, record.role || null,
     record.moodKey || null, record.label, record.url,
     record.volume != null ? record.volume : 1.0, record.category || 'state']
  );
  return result.rows[0].id;
}

async function listAudioAssets() {
  const result = await pool.query(
    `SELECT id, layer, venue, role, mood_key, label, url, volume, category, created_at
     FROM audio_assets ORDER BY layer, role, label;`
  );
  return result.rows;
}

async function deleteAudioAsset(id) {
  const result = await pool.query(
    `DELETE FROM audio_assets WHERE id = $1 RETURNING url;`,
    [id]
  );
  return result.rows[0];
}

// Everything one participant's player needs: the shared clips (intro,
// 1-9, 15, 17 — identical for everyone), this participant's own role clips
// (10-14), the filler pool, and the single 20-minute background bed.
// Keyed by label so the client's hardcoded schedule can look each clip up
// by name (e.g. manifest.shared['cmd3a'], manifest.own['cmd12']).
async function getAudioManifest(venue, role) {
  const shared = await pool.query(
    `SELECT label, url FROM audio_assets WHERE layer = 'whisper' AND role = 'shared' ORDER BY label;`
  );
  const own = await pool.query(
    `SELECT label, url FROM audio_assets WHERE layer = 'whisper' AND role = $1 ORDER BY label;`,
    [role]
  );
  const filler = await pool.query(
    `SELECT label, url FROM audio_assets WHERE layer = 'whisper' AND role = 'filler' ORDER BY label;`
  );
  const background = await pool.query(
    `SELECT url FROM audio_assets WHERE layer = 'ambience' AND venue = $1 ORDER BY id LIMIT 1;`,
    [venue]
  );
  return {
    shared: Object.fromEntries(shared.rows.map((r) => [r.label, r.url])),
    own: Object.fromEntries(own.rows.map((r) => [r.label, r.url])),
    filler: filler.rows.map((r) => ({ label: r.label, url: r.url })),
    background: background.rows[0] ? background.rows[0].url : null
  };
}

async function insertRegistration(record) {
  await pool.query(
    `INSERT INTO registrations
       (participant_code, first_name, last_name, venue, session_code, role, position_in_group)
     VALUES ($1, $2, $3, $4, $5, $6, $7);`,
    [
      record.participantCode,
      record.firstName,
      record.lastName,
      record.venue,
      record.sessionCode,
      record.role,
      record.positionInGroup
    ]
  );
}

// For the conductor's session picker — every session for the venue, most
// recent first, regardless of state (open, started, or old).
async function listSessions(venue) {
  const result = await pool.query(
    `SELECT session_code, member_count, started_at, created_at
     FROM sessions WHERE venue = $1 ORDER BY created_at DESC LIMIT 50;`,
    [venue]
  );
  return result.rows.map((r) => ({
    sessionCode: r.session_code,
    memberCount: r.member_count,
    startedAt: r.started_at,
    createdAt: r.created_at
  }));
}

module.exports = {
  GROUP_SIZE, ensureSchema, insertRegistration,
  insertAudioAsset, listAudioAssets, deleteAudioAsset, getAudioManifest,
  generateSessionCode, createSession, getSession, joinSession, startSessionByCode,
  resetSessionByCode, listOpenSessions, listSessions,
  reportProgress, requestResync, touchLastSeen, listPresence, deleteRegistration
};
