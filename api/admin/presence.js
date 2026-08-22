const { ensureSchema, listPresence } = require('../../lib/db');

const ACTIVE_WINDOW_MS = 25000; // ~2.5x the client's 10s in-experience report interval

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

  const { venue } = req.query;
  if (!venue) {
    res.status(400).json({ error: 'venue is required' });
    return;
  }

  try {
    await ensureSchema();
    const rows = await listPresence(venue);
    const now = Date.now();
    const people = rows.map((r) => ({
      participantCode: r.participant_code,
      firstName: r.first_name,
      lastName: r.last_name,
      role: r.role,
      active: (now - new Date(r.last_seen_at).getTime()) < ACTIVE_WINDOW_MS,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
      currentClip: r.current_clip,
      currentClipAt: r.current_clip_at,
      forceResyncAt: r.force_resync_at
    }));
    res.status(200).json({ people });
  } catch (err) {
    console.error('presence failed', err);
    res.status(500).json({ error: 'Failed to load presence' });
  }
};
