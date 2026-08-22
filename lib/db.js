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

let schemaReady = null;

// Idempotent — safe to call on every cold start. Cheap no-op once tables exist.
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_counters (
          venue TEXT PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS registrations (
          id SERIAL PRIMARY KEY,
          participant_code TEXT NOT NULL,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL,
          venue TEXT NOT NULL,
          role TEXT NOT NULL,
          group_index INTEGER NOT NULL,
          position_in_group INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
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
      // One row per venue: the moment (if any) the session started — every
      // registered phone begins its local, pre-scheduled playback only once
      // it sees this, so everyone starts together — and the randomized-but-
      // shared filler-cue schedule generated at that same moment, so every
      // phone plays the same "hold" phrase at the same real-world instant
      // regardless of how far along its own role's content it is.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_state (
          venue TEXT PRIMARY KEY,
          started_at TIMESTAMPTZ,
          filler_schedule TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`ALTER TABLE venue_state ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;`);
      await pool.query(`ALTER TABLE venue_state ADD COLUMN IF NOT EXISTS filler_schedule TEXT NOT NULL DEFAULT '';`);
    })();
  }
  return schemaReady;
}

async function getVenueState(venue) {
  const result = await pool.query(
    `INSERT INTO venue_state (venue) VALUES ($1)
     ON CONFLICT (venue) DO UPDATE SET venue = venue_state.venue
     RETURNING started_at, filler_schedule;`,
    [venue]
  );
  return {
    startedAt: result.rows[0].started_at,
    fillerSchedule: parseFillerSchedule(result.rows[0].filler_schedule)
  };
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

// Participant-triggered (no admin key needed) — any registered phone in the
// group can start the shared clock once everyone's ready.
async function startSession(venue, fillerCount) {
  const schedule = randomFillerSchedule(fillerCount);
  const result = await pool.query(
    `INSERT INTO venue_state (venue, started_at, filler_schedule, updated_at)
     VALUES ($1, now(), $2, now())
     ON CONFLICT (venue) DO UPDATE SET started_at = now(), filler_schedule = $2, updated_at = now()
     RETURNING started_at, filler_schedule;`,
    [venue, schedule]
  );
  return {
    startedAt: result.rows[0].started_at,
    fillerSchedule: parseFillerSchedule(result.rows[0].filler_schedule)
  };
}

async function resetSession(venue) {
  await pool.query(`UPDATE venue_state SET started_at = NULL, filler_schedule = '' WHERE venue = $1;`, [venue]);
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

// Everyone registered at this venue, in join order, with everything the
// observer panel needs: presence, role, and live schedule progress.
async function listPresence(venue) {
  const result = await pool.query(
    `SELECT participant_code, first_name, last_name, role, last_seen_at, created_at,
            current_clip, current_clip_at, force_resync_at
     FROM registrations WHERE venue = $1 ORDER BY created_at ASC LIMIT 200;`,
    [venue]
  );
  return result.rows;
}

// Registrations accumulate across every session this venue ever runs, so
// "how many are here right now" has to mean recently-active, not all-time.
async function countActiveRegistrations(venue) {
  const result = await pool.query(
    `SELECT COUNT(*) c FROM registrations WHERE venue = $1 AND last_seen_at > now() - interval '30 seconds';`,
    [venue]
  );
  return Number(result.rows[0].c);
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

// Atomically increments the per-venue counter and returns the new value.
// This is the participant's 1-indexed registration order for that venue,
// used to derive a race-safe, evenly distributed role assignment.
async function nextVenueCount(venue) {
  const result = await pool.query(
    `INSERT INTO venue_counters (venue, count)
     VALUES ($1, 1)
     ON CONFLICT (venue) DO UPDATE SET count = venue_counters.count + 1
     RETURNING count;`,
    [venue]
  );
  return result.rows[0].count;
}

async function insertRegistration(record) {
  await pool.query(
    `INSERT INTO registrations
       (participant_code, first_name, last_name, venue, role, group_index, position_in_group)
     VALUES ($1, $2, $3, $4, $5, $6, $7);`,
    [
      record.participantCode,
      record.firstName,
      record.lastName,
      record.venue,
      record.role,
      record.groupIndex,
      record.positionInGroup
    ]
  );
}

module.exports = {
  ensureSchema, nextVenueCount, insertRegistration,
  insertAudioAsset, listAudioAssets, deleteAudioAsset, getAudioManifest,
  getVenueState, startSession, resetSession, reportProgress, requestResync,
  touchLastSeen, listPresence, deleteRegistration, countActiveRegistrations
};
