const { ensureSchema, nextVenueCount, insertRegistration } = require('../lib/db');
const { assignRole } = require('../lib/roles');

const VENUE = 'catalhoyuk-home';

function generateParticipantCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { firstName, lastName } = req.body || {};

  if (!firstName || !String(firstName).trim() || !lastName || !String(lastName).trim()) {
    res.status(400).json({ error: 'firstName and lastName are required' });
    return;
  }

  try {
    await ensureSchema();

    const count = await nextVenueCount(VENUE);          // 1-indexed
    const { role, groupIndex, positionInGroup } = assignRole(VENUE, count - 1);
    const participantCode = generateParticipantCode();

    await insertRegistration({
      participantCode,
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      venue: VENUE,
      role,
      groupIndex,
      positionInGroup
    });

    // Role is returned to the client for manifest routing, but the UI
    // deliberately never displays it — it stays secret until command 10.
    res.status(200).json({ participantCode, role, venue: VENUE });
  } catch (err) {
    console.error('registration failed', err);
    res.status(500).json({ error: 'Registration failed, please try again.' });
  }
};
