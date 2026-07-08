const { Pool } = require('pg');

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
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const result = await pool.query(`
      SELECT participant_code, first_name, last_name, venue, role,
             group_index, position_in_group, created_at
      FROM registrations
      ORDER BY created_at DESC
      LIMIT 500;
    `);
    res.status(200).json({ registrations: result.rows });
  } catch (err) {
    console.error('admin fetch failed', err);
    res.status(500).json({ error: 'Failed to load registrations' });
  }
};
