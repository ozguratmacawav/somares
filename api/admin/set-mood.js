const { ensureSchema, setVenueMood } = require('../../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { venue, moodKey } = req.body || {};
  if (!venue || !moodKey) {
    res.status(400).json({ error: 'venue and moodKey are required' });
    return;
  }

  try {
    await ensureSchema();
    await setVenueMood(venue, moodKey);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('set-mood failed', err);
    res.status(500).json({ error: 'Failed to set mood' });
  }
};
