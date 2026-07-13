const { ensureSchema, getAudioManifest, latestTriggerId } = require('../lib/db');

const KNOWN_VENUES = new Set([
  'yildiz-museum', 'catalhoyuk', 'ciurlionis', 'fondazione-ago'
]);

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { venue, role } = req.query;

  // Roles are free text (default decks, or hand-typed custom ones from the
  // admin/conductor role editor) — only the venue is a fixed set.
  if (!venue || !KNOWN_VENUES.has(venue) || !role) {
    res.status(400).json({ error: 'valid venue and role are required' });
    return;
  }

  try {
    await ensureSchema();
    const manifest = await getAudioManifest(venue, role);
    // Baseline so a freshly-joined participant only reacts to triggers fired
    // after they arrived, not the venue's entire trigger history.
    manifest.sinceId = await latestTriggerId(venue);
    res.status(200).json(manifest);
  } catch (err) {
    console.error('audio-manifest failed', err);
    res.status(500).json({ error: 'Failed to load audio manifest' });
  }
};
