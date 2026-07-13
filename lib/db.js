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
      // category (mood layer only): 'state' = persistent swappable mood
      // (calm/tense/...); 'texture' = short room-sound clip that the
      // auto-blend background layer fades in and out on its own.
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
      // The conductor's live control: one current mood per venue, and the
      // moment (if any) the operator hit "Start" — every phone's playback
      // begins only once it sees this, so all 5 start together.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_state (
          venue TEXT PRIMARY KEY,
          mood_key TEXT NOT NULL DEFAULT 'calm',
          started_at TIMESTAMPTZ,
          ambience_muted TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`ALTER TABLE venue_state ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;`);
      // Comma-separated ambience track labels currently muted for this venue —
      // e.g. "Dem.mp3" — so the conductor can turn Dem/Low Hum on and off
      // independently for everyone, live, without restarting playback.
      await pool.query(`ALTER TABLE venue_state ADD COLUMN IF NOT EXISTS ambience_muted TEXT NOT NULL DEFAULT '';`);
      // One-off cues the conductor fires on demand (a specific whisper for one
      // role, a sting for everyone, or a texture-layer override). Participants
      // poll for triggers newer than the last one they've already played.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_triggers (
          id SERIAL PRIMARY KEY,
          venue TEXT NOT NULL,
          target_role TEXT,
          target_participant_code TEXT,
          asset_url TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'whisper',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`ALTER TABLE venue_triggers ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whisper';`);
      await pool.query(`ALTER TABLE venue_triggers ADD COLUMN IF NOT EXISTS target_participant_code TEXT;`);
    })();
  }
  return schemaReady;
}

async function getVenueState(venue) {
  const result = await pool.query(
    `INSERT INTO venue_state (venue) VALUES ($1)
     ON CONFLICT (venue) DO UPDATE SET venue = venue_state.venue
     RETURNING mood_key, started_at, ambience_muted;`,
    [venue]
  );
  const muted = result.rows[0].ambience_muted;
  return {
    moodKey: result.rows[0].mood_key,
    startedAt: result.rows[0].started_at,
    ambienceMuted: muted ? muted.split(',') : []
  };
}

async function setVenueMood(venue, moodKey) {
  await pool.query(
    `INSERT INTO venue_state (venue, mood_key, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (venue) DO UPDATE SET mood_key = $2, updated_at = now();`,
    [venue, moodKey]
  );
}

// mutedLabels: array of ambience_assets.label values (e.g. ["Dem.mp3"]) that
// should be silent for everyone at this venue right now — independent
// on/off control per track, without restarting anyone's playback.
async function setAmbienceMute(venue, mutedLabels) {
  await pool.query(
    `INSERT INTO venue_state (venue, ambience_muted, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (venue) DO UPDATE SET ambience_muted = $2, updated_at = now();`,
    [venue, (mutedLabels || []).join(',')]
  );
}

// Every registered phone starts its ambience/texture/whisper playback only
// once it sees this timestamp — that's what keeps 5 separately-registered
// people starting together instead of whenever each of them tapped Begin.
async function startExperience(venue) {
  const result = await pool.query(
    `INSERT INTO venue_state (venue, started_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (venue) DO UPDATE SET started_at = now(), updated_at = now()
     RETURNING started_at;`,
    [venue]
  );
  return result.rows[0].started_at;
}

async function resetExperience(venue) {
  await pool.query(`UPDATE venue_state SET started_at = NULL WHERE venue = $1;`, [venue]);
}

async function insertTrigger(venue, targetRole, assetUrl, targetParticipantCode, channel) {
  const result = await pool.query(
    `INSERT INTO venue_triggers (venue, target_role, target_participant_code, asset_url, channel)
     VALUES ($1, $2, $3, $4, $5) RETURNING id;`,
    [venue, targetRole || null, targetParticipantCode || null, assetUrl, channel || 'whisper']
  );
  return result.rows[0].id;
}

// A trigger reaches this client if it isn't aimed at a different role and
// isn't aimed at a different specific participant — so a conductor can fire
// something at everyone, at one role, or at exactly one person.
async function getTriggersSince(venue, role, participantCode, sinceId) {
  const result = await pool.query(
    `SELECT id, asset_url, channel FROM venue_triggers
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
// A role/position can only be held by one person at a time within a venue —
// assigning it here silently vacates whoever held it before (their role
// becomes '' rather than blocking the reassignment), so a conductor can
// always just re-pick P1 without first having to hunt down the old holder.
async function updateRegistrationRole(participantCode, role) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bumped = await client.query(
      `UPDATE registrations SET role = ''
       WHERE venue = (SELECT venue FROM registrations WHERE participant_code = $1)
         AND role = $2 AND participant_code != $1 AND $2 != ''
       RETURNING participant_code, first_name, last_name;`,
      [participantCode, role]
    );
    await client.query(
      `UPDATE registrations SET role = $2 WHERE participant_code = $1;`,
      [participantCode, role]
    );
    await client.query('COMMIT');
    return bumped.rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
// every mood bed (the player crossfades between them live), their venue's
// constant ambience bed(s), and the venue's texture pool (the auto-blending
// room-sound layer: machine/hiss/army clips that fade in and out on their own).
async function getAudioManifest(venue, role) {
  const whispers = await pool.query(
    `SELECT label, url FROM audio_assets WHERE layer = 'whisper' AND role = $1 ORDER BY label;`,
    [role]
  );
  const moods = await pool.query(
    `SELECT mood_key, url FROM audio_assets WHERE layer = 'mood' ORDER BY mood_key;`
  );
  const ambiences = await pool.query(
    `SELECT label, url, volume FROM audio_assets WHERE layer = 'ambience' AND venue = $1 ORDER BY label;`,
    [venue]
  );
  const textures = await pool.query(
    `SELECT label, url, volume FROM audio_assets WHERE layer = 'mood' AND category = 'texture' ORDER BY label;`
  );
  return {
    whispers: whispers.rows.map((r) => r.url),
    moods: Object.fromEntries(moods.rows.map((r) => [r.mood_key, r.url])),
    ambiences: ambiences.rows.map((r) => ({ url: r.url, volume: r.volume, label: r.label })),
    textures: textures.rows.map((r) => ({ url: r.url, label: r.label, volume: r.volume }))
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
  touchLastSeen, listPresence, deleteRegistration, updateRegistrationRole,
  startExperience, resetExperience, setAmbienceMute
};
