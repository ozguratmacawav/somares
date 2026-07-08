const { ensureSchema, getVenueState, getTriggersSince } = require('../lib/db');

const KNOWN_VENUES = new Set([
  'yildiz-museum', 'catalhoyuk', 'ciurlionis', 'fondazione-ago'
]);

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { venue, role } = req.query;
  const since = parseInt(req.query.since, 10) || 0;

  if (!venue || !KNOWN_VENUES.has(venue) || !role) {
    res.status(400).json({ error: 'valid venue and role are required' });
    return;
  }

  try {
    await ensureSchema();
    const mood = await getVenueState(venue);
    const triggers = await getTriggersSince(venue, role, since);
    res.status(200).json({
      mood,
      triggers: triggers.map((t) => ({ id: t.id, url: t.asset_url }))
    });
  } catch (err) {
    console.error('venue-state failed', err);
    res.status(500).json({ error: 'Failed to load venue state' });
  }
};
