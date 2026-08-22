const { ensureSchema, getAudioManifest } = require('../lib/db');

const KNOWN_VENUES = new Set(['catalhoyuk-home']);
const KNOWN_ROLES = new Set(['housekeeper', 'food-provider', 'maker', 'memory-keeper']);

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { venue, role } = req.query;

  if (!venue || !KNOWN_VENUES.has(venue) || !role || !KNOWN_ROLES.has(role)) {
    res.status(400).json({ error: 'valid venue and role are required' });
    return;
  }

  try {
    await ensureSchema();
    const manifest = await getAudioManifest(venue, role);
    res.status(200).json(manifest);
  } catch (err) {
    console.error('audio-manifest failed', err);
    res.status(500).json({ error: 'Failed to load audio manifest' });
  }
};
