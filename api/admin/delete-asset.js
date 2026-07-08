const { del } = require('@vercel/blob');
const { ensureSchema, deleteAudioAsset } = require('../../lib/db');

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

  const { id } = req.body || {};
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }

  try {
    await ensureSchema();
    const removed = await deleteAudioAsset(id);
    if (removed && removed.url) {
      try { await del(removed.url); } catch (e) { console.warn('blob delete failed (continuing):', e.message); }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('delete-asset failed', err);
    res.status(500).json({ error: 'Delete failed' });
  }
};
