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
      // layer: 'whisper' (per role) | 'mood' (shared) | 'ambience' (per venue)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS audio_assets (
          id SERIAL PRIMARY KEY,
          layer TEXT NOT NULL,
          venue TEXT,
          role TEXT,
          mood_key TEXT,
          label TEXT NOT NULL,
          url TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // The conductor's live control: one current mood per venue.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_state (
          venue TEXT PRIMARY KEY,
          mood_key TEXT NOT NULL DEFAULT 'calm',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // One-off cues the conductor fires on demand (a specific whisper for one
      // role, or a sting for everyone). Participants poll for triggers newer
      // than the last one they've already played.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_triggers (
          id SERIAL PRIMARY KEY,
          venue TEXT NOT NULL,
          target_role TEXT,
          target_participant_code TEXT,
          asset_url TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`ALTER TABLE venue_triggers ADD COLUMN IF NOT EXISTS target_participant_code TEXT;`);
    })();
  }
  return schemaReady;
}

async function getVenueState(venue) {
  const result = await pool.query(
    `INSERT INTO venue_state (venue) VALUES ($1)
     ON CONFLICT (venue) DO UPDATE SET venue = venue_state.venue
     RETURNING mood_key;`,
    [venue]
  );
  return result.rows[0].mood_key;
}

async function setVenueMood(venue, moodKey) {
  await pool.query(
    `INSERT INTO venue_state (venue, mood_key, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (venue) DO UPDATE SET mood_key = $2, updated_at = now();`,
    [venue, moodKey]
  );
}

async function insertTrigger(venue, targetRole, assetUrl, targetParticipantCode) {
  const result = await pool.query(
    `INSERT INTO venue_triggers (venue, target_role, target_participant_code, asset_url)
     VALUES ($1, $2, $3, $4) RETURNING id;`,
    [venue, targetRole || null, targetParticipantCode || null, assetUrl]
  );
  return result.rows[0].id;
}

// A trigger reaches this client if it isn't aimed at a different role and
// isn't aimed at a different specific participant — so a conductor can fire
// something at everyone, at one role, or at exactly one person.
async function getTriggersSince(venue, role, participantCode, sinceId) {
  const result = await pool.query(
    `SELECT id, asset_url FROM venue_triggers
     WHERE venue = $1 AND id > $2
       AND (target_role IS NULL OR target_role = $3)
       AND (target_participant_code IS NULL OR target_participant_code = $4)
     ORDER BY id ASC;`,
    [venue, sinceId, role, participantCode]
  );
  return result.rows;
}

// Returns the participant's current role so the client can notice when an
// operator has changed it after their session already started.
async function touchLastSeen(participantCode) {
  const result = await pool.query(
    `UPDATE registrations SET last_seen_at = now() WHERE participant_code = $1 RETURNING role;`,
    [participantCode]
  );
  return result.rows[0] ? result.rows[0].role : null;
}

// Everyone registered at a venue, newest first, with enough info for the
// conductor/admin UI to show a live green/grey presence dot per person.
async function listPresence(venue) {
  const result = await pool.query(
    `SELECT participant_code, first_name, last_name, role, last_seen_at, created_at
     FROM registrations WHERE venue = $1 ORDER BY created_at DESC LIMIT 200;`,
    [venue]
  );
  return result.rows;
}

async function deleteRegistration(participantCode) {
  await pool.query(`DELETE FROM registrations WHERE participant_code = $1;`, [participantCode]);
}

// Role is free text — the known 10 are just the default suggestions; an
// operator can hand-type a brand new one for a one-off scenario.
async function updateRegistrationRole(participantCode, role) {
  await pool.query(
    `UPDATE registrations SET role = $2 WHERE participant_code = $1;`,
    [participantCode, role]
  );
}

async function latestTriggerId(venue) {
  const result = await pool.query(
    `SELECT COALESCE(MAX(id), 0) AS id FROM venue_triggers WHERE venue = $1;`,
    [venue]
  );
  return result.rows[0].id;
}

async function insertAudioAsset(record) {
  const result = await pool.query(
    `INSERT INTO audio_assets (layer, venue, role, mood_key, label, url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id;`,
    [record.layer, record.venue || null, record.role || null,
     record.moodKey || null, record.label, record.url]
  );
  return result.rows[0].id;
}

async function listAudioAssets() {
  const result = await pool.query(
    `SELECT id, layer, venue, role, mood_key, label, url, created_at
     FROM audio_assets ORDER BY layer, venue, role, mood_key, label;`
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

// Everything one participant's player needs: their role's whisper pool,
// every mood bed (the player crossfades between them live), and their
// venue's ambience loop(s).
async function getAudioManifest(venue, role) {
  const whispers = await pool.query(
    `SELECT label, url FROM audio_assets WHERE layer = 'whisper' AND role = $1 ORDER BY label;`,
    [role]
  );
  const moods = await pool.query(
    `SELECT mood_key, url FROM audio_assets WHERE layer = 'mood' ORDER BY mood_key;`
  );
  const ambiences = await pool.query(
    `SELECT label, url FROM audio_assets WHERE layer = 'ambience' AND venue = $1 ORDER BY label;`,
    [venue]
  );
  return {
    whispers: whispers.rows.map((r) => r.url),
    moods: Object.fromEntries(moods.rows.map((r) => [r.mood_key, r.url])),
    ambiences: ambiences.rows.map((r) => r.url)
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
  getVenueState, setVenueMood, insertTrigger, getTriggersSince, latestTriggerId,
  touchLastSeen, listPresence, deleteRegistration, updateRegistrationRole
};
