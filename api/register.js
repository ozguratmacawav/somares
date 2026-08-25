const { ensureSchema, createSession, getSession, joinSession, insertRegistration } = require('../lib/db');
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

  const { firstName, lastName, sessionCode } = req.body || {};

  if (!firstName || !String(firstName).trim() || !lastName || !String(lastName).trim()) {
    res.status(400).json({ error: 'firstName and lastName are required' });
    return;
  }

  try {
    await ensureSchema();

    let code = sessionCode ? String(sessionCode).trim().toUpperCase() : null;

    if (code) {
      // Joining an existing group. joinSession is the single atomic check
      // (exists, not full, not started) — figure out which one failed only
      // to give a precise error message back to the client.
      const claim = await joinSession(code);
      if (!claim) {
        const existing = await getSession(code);
        if (!existing) {
          res.status(404).json({ error: 'not-found', message: 'No group found with that code.' });
          return;
        }
        if (existing.startedAt) {
          res.status(409).json({ error: 'already-started', message: 'This group has already started.' });
          return;
        }
        res.status(409).json({ error: 'group-full', message: 'This group is already full (4/4).' });
        return;
      }

      const { role } = assignRole(VENUE, code, claim.positionInGroup);
      const participantCode = generateParticipantCode();

      await insertRegistration({
        participantCode,
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim(),
        venue: VENUE,
        sessionCode: code,
        role,
        positionInGroup: claim.positionInGroup
      });

      res.status(200).json({ participantCode, role, venue: VENUE, sessionCode: code });
      return;
    }

    // No code given — create a brand-new, separate group. Guaranteed to
    // succeed on the first join since it was just created empty.
    code = await createSession(VENUE);
    const claim = await joinSession(code);
    const { role } = assignRole(VENUE, code, claim.positionInGroup);
    const participantCode = generateParticipantCode();

    await insertRegistration({
      participantCode,
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      venue: VENUE,
      sessionCode: code,
      role,
      positionInGroup: claim.positionInGroup
    });

    // Role is returned to the client for manifest routing, but the UI
    // deliberately never displays it — it stays secret until command 33.
    res.status(200).json({ participantCode, role, venue: VENUE, sessionCode: code });
  } catch (err) {
    console.error('registration failed', err);
    res.status(500).json({ error: 'Registration failed, please try again.' });
  }
};
