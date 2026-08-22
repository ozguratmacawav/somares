const { ensureSchema, getVenueState, startSession, reportProgress, touchLastSeen, countActiveRegistrations } = require('../lib/db');

const GROUP_SIZE = 4;

const KNOWN_VENUES = new Set(['catalhoyuk-home']);

module.exports = async (req, res) => {
  const { venue } = req.method === 'GET' ? req.query : (req.body || {});

  if (!venue || !KNOWN_VENUES.has(venue)) {
    res.status(400).json({ error: 'a valid venue is required' });
    return;
  }

  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const { code } = req.query;
      const forceResyncAt = code ? await touchLastSeen(code) : null;
      const state = await getVenueState(venue);
      const joined = await countActiveRegistrations(venue);
      res.status(200).json({
        startedAt: state.startedAt,
        fillerSchedule: state.fillerSchedule,
        forceResyncAt,
        joined,
        groupSize: GROUP_SIZE
      });
      return;
    }

    if (req.method === 'POST') {
      const { action, code, clip } = req.body || {};

      // Any registered participant can start the shared clock — there's no
      // live conductor in this experience, so whoever's ready taps it.
      if (action === 'start') {
        const state = await startSession(venue, 4);
        res.status(200).json({ ok: true, startedAt: state.startedAt, fillerSchedule: state.fillerSchedule });
        return;
      }

      // Lightweight heartbeat the client sends every ~10-15s — doubles as
      // presence and as the observer panel's live schedule-position feed.
      if (action === 'report') {
        if (!code) {
          res.status(400).json({ error: 'code is required' });
          return;
        }
        await reportProgress(code, clip || null);
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
