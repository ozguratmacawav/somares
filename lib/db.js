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
    })();
  }
  return schemaReady;
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

module.exports = { ensureSchema, nextVenueCount, insertRegistration };
