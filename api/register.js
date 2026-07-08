const { ensureSchema, nextVenueCount, insertRegistration } = require('../lib/db');
const { assignRole } = require('../lib/roles');

const ALLOWED_VENUES = new Set([
  'yildiz-museum',
  'catalhoyuk',
  'ciurlionis',
  'fondazione-ago'
]);

function generateParticipantCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { firstName, lastName, venue } = req.body || {};

  if (!firstName || !String(firstName).trim() ||
      !lastName || !String(lastName).trim() ||
      !venue || !ALLOWED_VENUES.has(venue)) {
    res.status(400).json({ error: 'firstName, lastName and a valid venue are required' });
    return;
  }

  try {
    await ensureSchema();

    const count = await nextVenueCount(venue);          // 1-indexed
    const { role, groupIndex, positionInGroup } = assignRole(venue, count - 1);
    const participantCode = generateParticipantCode();

    await insertRegistration({
      participantCode,
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      venue,
      role,
      groupIndex,
      positionInGroup
    });

    // Role is returned to the client for future stream routing, but the UI
    // deliberately never displays it — the role stays hidden from the participant.
    res.status(200).json({ participantCode, role, venue });
  } catch (err) {
    console.error('registration failed', err);
    res.status(500).json({ error: 'Registration failed, please try again.' });
  }
};
