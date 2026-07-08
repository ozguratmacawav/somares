const { ensureSchema, insertTrigger } = require('../../lib/db');

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

  const { venue, targetRole, assetUrl } = req.body || {};
  if (!venue || !assetUrl) {
    res.status(400).json({ error: 'venue and assetUrl are required' });
    return;
  }

  try {
    await ensureSchema();
    const id = await insertTrigger(venue, targetRole || null, assetUrl);
    res.status(200).json({ ok: true, id });
  } catch (err) {
    console.error('trigger failed', err);
    res.status(500).json({ error: 'Failed to send trigger' });
  }
};
