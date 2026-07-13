const { put } = require('@vercel/blob');
const { ensureSchema, insertAudioAsset } = require('../../lib/db');

const KNOWN_VENUES = new Set([
  'yildiz-museum', 'catalhoyuk', 'ciurlionis', 'fondazione-ago'
]);
const KNOWN_LAYERS = new Set(['whisper', 'mood', 'ambience']);

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

  const { layer, role, venue, moodKey, label, dataBase64, volume, category } = req.body || {};

  if (!layer || !KNOWN_LAYERS.has(layer) || !label || !dataBase64) {
    res.status(400).json({ error: 'layer, label and dataBase64 are required' });
    return;
  }
  if (layer === 'whisper' && (!role || !String(role).trim())) {
    res.status(400).json({ error: 'a role is required for whisper uploads' });
    return;
  }
  if (layer === 'ambience' && !KNOWN_VENUES.has(venue)) {
    res.status(400).json({ error: 'a valid venue is required for ambience uploads' });
    return;
  }
  if (layer === 'mood' && !moodKey) {
    res.status(400).json({ error: 'a moodKey is required for mood uploads' });
    return;
  }

  try {
    await ensureSchema();

    const buffer = Buffer.from(dataBase64, 'base64');
    // ~4.4MB is roughly the request body ceiling for this function — keep
    // clips well under that (short whispers, moderate-length loops).
    if (buffer.length > 4 * 1024 * 1024) {
      res.status(400).json({ error: 'File too large (max ~4MB). Try a lower bitrate export.' });
      return;
    }

    var pathPrefix = layer === 'whisper' ? 'whispers/' + role
      : layer === 'ambience' ? 'ambiences/' + venue
      : 'moods';

    const blob = await put(pathPrefix + '/' + label, buffer, {
      access: 'public',
      contentType: 'audio/mpeg',
      addRandomSuffix: true
    });

    const id = await insertAudioAsset({
      layer, role: role || null, venue: venue || null, moodKey: moodKey || null,
      label, url: blob.url,
      volume: volume != null && volume !== '' ? Number(volume) : 1.0,
      category: layer === 'mood' && category === 'texture' ? 'texture' : 'state'
    });

    res.status(200).json({ id, url: blob.url });
  } catch (err) {
    console.error('upload-asset failed', err);
    res.status(500).json({ error: 'Upload failed' });
  }
};
