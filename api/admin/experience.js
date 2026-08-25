const { ensureSchema, listSessions, resetSessionByCode, requestResync } = require('../../lib/db');

module.exports = async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    await ensureSchema();

    // The conductor's session picker — every group for this venue, so the
    // operator can pick which one to observe (there's no longer a single
    // implicit "the" session).
    if (req.method === 'GET') {
      const { venue } = req.query;
      if (!venue) {
        res.status(400).json({ error: 'venue is required' });
        return;
      }
      const sessions = await listSessions(venue);
      res.status(200).json({ sessions });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const { action, sessionCode } = req.body || {};

    if (action === 'reset') {
      if (!sessionCode) {
        res.status(400).json({ error: 'sessionCode is required' });
        return;
      }
      await resetSessionByCode(String(sessionCode).trim().toUpperCase());
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
