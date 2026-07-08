const { ensureSchema, listAudioAssets } = require('../../lib/db');

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
    await ensureSchema();
    const assets = await listAudioAssets();
    res.status(200).json({ assets });
  } catch (err) {
    console.error('audio-assets failed', err);
    res.status(500).json({ error: 'Failed to load audio assets' });
  }
};
