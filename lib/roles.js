// The Çatalhöyük experience: four interlocking roles, one group of 4 per
// session. Heritage material lives in the roles themselves, not the venue.
const GROUP_SIZE = 4;

const DEFAULT_ROLE_DECK = ['housekeeper', 'food-provider', 'maker', 'memory-keeper'];

const VENUE_ROLE_DECKS = {
  'catalhoyuk-home': DEFAULT_ROLE_DECK
};

function roleDeckForVenue(venue) {
  return VENUE_ROLE_DECKS[venue] || DEFAULT_ROLE_DECK;
}

// Deterministic seeded shuffle: the same session code always produces the
// same role order, so we don't need to persist the shuffled deck anywhere
// — it's re-derivable from the session code alone.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffledDeckFor(venue, sessionCode) {
  const deck = roleDeckForVenue(venue).slice();
  const rand = mulberry32(hashSeed(venue + ':' + sessionCode));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// positionInGroup is 0-based (this participant is the Nth to join this session)
function assignRole(venue, sessionCode, positionInGroup) {
  const deck = shuffledDeckFor(venue, sessionCode);
  return { role: deck[positionInGroup] };
}

module.exports = { GROUP_SIZE, assignRole, roleDeckForVenue };
