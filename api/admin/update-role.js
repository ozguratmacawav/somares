const { ensureSchema, updateRegistrationRole } = require('../../lib/db');

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

  const { participantCode, role } = req.body || {};
  if (!participantCode || !role || !String(role).trim()) {
    res.status(400).json({ error: 'participantCode and role are required' });
    return;
  }

  try {
    await ensureSchema();
    await updateRegistrationRole(participantCode, String(role).trim());
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('update-role failed', err);
    res.status(500).json({ error: 'Update failed' });
  }
};
