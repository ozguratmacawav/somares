const { ensureSchema, resetSession, requestResync } = require('../../lib/db');

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

  const { venue, action } = req.body || {};

  try {
    await ensureSchema();

    if (action === 'reset') {
      if (!venue) {
        res.status(400).json({ error: 'venue is required' });
        return;
      }
      await resetSession(venue);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'forceResync') {
      const { participantCode } = req.body || {};
      if (!participantCode) {
        res.status(400).json({ error: 'participantCode is required' });
        return;
      }
      const at = await requestResync(participantCode);
      res.status(200).json({ ok: true, forceResyncAt: at });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('experience endpoint failed', err);
    res.status(500).json({ error: 'Request failed' });
  }
};
