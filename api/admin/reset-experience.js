const { ensureSchema, resetExperience } = require('../../lib/db');

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

  const { venue } = req.body || {};
  if (!venue) {
    res.status(400).json({ error: 'venue is required' });
    return;
  }

  try {
    await ensureSchema();
    await resetExperience(venue);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('reset-experience failed', err);
    res.status(500).json({ error: 'Failed to reset' });
  }
};
