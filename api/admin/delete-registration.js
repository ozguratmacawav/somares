const { ensureSchema, deleteRegistration } = require('../../lib/db');

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

  const { participantCode } = req.body || {};
  if (!participantCode) {
    res.status(400).json({ error: 'participantCode is required' });
    return;
  }

  try {
    await ensureSchema();
    await deleteRegistration(participantCode);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('delete-registration failed', err);
    res.status(500).json({ error: 'Delete failed' });
  }
};
