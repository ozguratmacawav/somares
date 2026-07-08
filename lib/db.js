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
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
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
    })();
  }
  return schemaReady;
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
  insertAudioAsset, listAudioAssets, deleteAudioAsset, getAudioManifest
};
