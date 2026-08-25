const {
  ensureSchema, getSession, startSessionByCode, resetSessionByCode,
  reportProgress, touchLastSeen, listOpenSessions, GROUP_SIZE
} = require('../lib/db');

const KNOWN_VENUES = new Set(['catalhoyuk-home']);

module.exports = async (req, res) => {
  const isGet = req.method === 'GET';
  const params = isGet ? req.query : (req.body || {});
  const { venue, sessionCode } = params;

  try {
    await ensureSchema();

    if (isGet) {
      // No session picked yet — this is the "which open groups can I join"
      // list for the registration screen.
      if (!sessionCode) {
        if (!venue || !KNOWN_VENUES.has(venue)) {
          res.status(400).json({ error: 'a valid venue is required' });
          return;
        }
        const sessions = await listOpenSessions(venue);
        res.status(200).json({ sessions, groupSize: GROUP_SIZE });
        return;
      }

      // A specific session's state — used by the waiting room and by the
      // in-experience heartbeat poll.
      const code = String(sessionCode).trim().toUpperCase();
      const { code: participantCode } = req.query;
      const forceResyncAt = participantCode ? await touchLastSeen(participantCode) : null;
      const session = await getSession(code);
      if (!session) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      res.status(200).json({
        sessionCode: code,
        startedAt: session.startedAt,
        fillerSchedule: session.fillerSchedule,
        forceResyncAt,
        joined: session.memberCount,
        groupSize: GROUP_SIZE
      });
      return;
    }

    if (req.method === 'POST') {
      const { action, code: participantCode, clip } = req.body || {};
      if (!sessionCode) {
        res.status(400).json({ error: 'sessionCode is required' });
        return;
      }
      const code = String(sessionCode).trim().toUpperCase();

      // Any registered participant can start their group's shared clock —
      // there's no live conductor in this experience, so whoever's ready taps it.
      if (action === 'start') {
        const state = await startSessionByCode(code, 4);
        if (!state) { res.status(404).json({ error: 'not-found' }); return; }
        res.status(200).json({ ok: true, startedAt: state.startedAt, fillerSchedule: state.fillerSchedule });
        return;
      }

      // Lightweight heartbeat the client sends every ~10-15s — doubles as
      // presence and as the observer panel's live schedule-position feed.
      if (action === 'report') {
        if (!participantCode) {
          res.status(400).json({ error: 'code is required' });
          return;
        }
        await reportProgress(participantCode, clip || null);
        res.status(200).json({ ok: true });
        return;
      }

      // Deliberately unauthenticated, same trust model as 'start': there's
      // no live conductor gating this experience. Scoped to exactly one
      // session_code, so abandoning a stuck group can never affect any
      // other group's in-progress experience.
      if (action === 'reset') {
        await resetSessionByCode(code);
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: 'Unknown action' });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('venue-state failed', err);
    res.status(500).json({ error: 'Request failed' });
  }
};
