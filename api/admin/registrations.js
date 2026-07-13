const { Pool } = require('pg');
const { ensureSchema, deleteRegistration, updateRegistrationRole } = require('../../lib/db');

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

module.exports = async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const result = await pool.query(`
        SELECT participant_code, first_name, last_name, venue, role,
               group_index, position_in_group, created_at, last_seen_at
        FROM registrations
        ORDER BY created_at DESC
        LIMIT 500;
      `);
      const now = Date.now();
      const registrations = result.rows.map((r) => ({
        ...r,
        active: (now - new Date(r.last_seen_at).getTime()) < 12000
      }));
      res.status(200).json({ registrations });
      return;
    }

    if (req.method === 'POST') {
      const { action, participantCode, role } = req.body || {};

      if (action === 'updateRole') {
        if (!participantCode || !role || !String(role).trim()) {
          res.status(400).json({ error: 'participantCode and role are required' });
          return;
        }
        await updateRegistrationRole(participantCode, String(role).trim());
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'delete') {
        if (!participantCode) {
          res.status(400).json({ error: 'participantCode is required' });
          return;
        }
        await deleteRegistration(participantCode);
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: 'Unknown action' });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('registrations endpoint failed', err);
    res.status(500).json({ error: 'Request failed' });
  }
};
