const { del } = require('@vercel/blob');
const { ensureSchema, listAudioAssets, deleteAudioAsset } = require('../../lib/db');

module.exports = async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const assets = await listAudioAssets();
      res.status(200).json({ assets });
      return;
    }

    if (req.method === 'POST') {
      const { action, id } = req.body || {};
      if (action === 'delete') {
        if (!id) {
          res.status(400).json({ error: 'id is required' });
          return;
        }
        const removed = await deleteAudioAsset(id);
        if (removed && removed.url) {
          try { await del(removed.url); } catch (e) { console.warn('blob delete failed (continuing):', e.message); }
        }
        res.status(200).json({ ok: true });
        return;
      }
      res.status(400).json({ error: 'Unknown action' });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('audio-assets endpoint failed', err);
    res.status(500).json({ error: 'Request failed' });
  }
};
