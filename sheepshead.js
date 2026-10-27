// Wisconsin five-handed sheepshead.
// Queens and jacks are trump, then diamonds. Fail suits rank ace, ten, king, nine, eight, seven.
// The picking team needs 61 of the 120 points. Each loser pays each winner.

const FAIL_SUITS = ['c', 's', 'h'];
const SUITS = ['c', 's', 'h', 'd'];
const RANKS = ['7', '8', '9', '10', 'K', 'A', 'J', 'Q'];
const TRUMP_ORDER = ['QC', 'QS', 'QH', 'QD', 'JC', 'JS', 'JH', 'JD', 'AD', '10D', 'KD', '9D', '8D', '7D'];
const FAIL_POWER = { A: 6, '10': 5, K: 4, '9': 3, '8': 2, '7': 1 };
const POINT_VALUE = { A: 11, '10': 10, K: 4, Q: 3, J: 2 };

export function cardCode(card) {
  return `${card.rank}${card.suit.toUpperCase()}`;
}

export function cardFromCode(code) {
  const suit = code.slice(-1).toLowerCase();
  const rank = code.slice(0, -1);
  return { rank, suit };
}

export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ rank, suit });
  }
  return deck;
}

export function shuffle(deck, rng = Math.random) {
  const cards = deck.slice();
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = cards[i];
    cards[i] = cards[j];
    cards[j] = swap;
  }
  return cards;
}

export function isTrump(card) {
  return card.rank === 'Q' || card.rank === 'J' || card.suit === 'd';
}

export function suitKey(card) {
  return isTrump(card) ? 'trump' : card.suit;
}

export function points(card) {
  return POINT_VALUE[card.rank] || 0;
}

export function power(card) {
  if (isTrump(card)) return 100 + (TRUMP_ORDER.length - TRUMP_ORDER.indexOf(cardCode(card)));
  return FAIL_POWER[card.rank] || 0;
}

export function handPoints(cards) {
  return cards.reduce((sum, card) => sum + points(card), 0);
}

export function deal(dealer, rng = Math.random) {
  const deck = shuffle(buildDeck(), rng);
  const hands = [[], [], [], [], []];
  let index = 0;
  const start = (dealer + 1) % 5;
  const give = (rounds) => {
    for (let n = 0; n < rounds; n += 1) {
      for (let s = 0; s < 5; s += 1) {
        hands[(start + s) % 5].push(deck[index]);
        index += 1;
      }
    }
  };
  give(3);
  const blind = [deck[index], deck[index + 1]];
  index += 2;
  give(3);
  return { hands, blind };
}

export function legalPlays(hand, led) {
  if (!led) return hand.slice();
  const key = suitKey(led);
  const matching = hand.filter((card) => suitKey(card) === key);
  return matching.length ? matching : hand.slice();
}

export function trickWinner(trick) {
  const led = suitKey(trick[0].card);
  let win = 0;
  for (let i = 1; i < trick.length; i += 1) {
    const card = trick[i].card;
    const winning = trick[win].card;
    if (isTrump(card)) {
      if (!isTrump(winning) || power(card) > power(winning)) win = i;
      continue;
    }
    if (isTrump(winning)) continue;
    const follows = suitKey(card) === led;
    const winnerFollows = suitKey(winning) === led;
    if (follows && (!winnerFollows || power(card) > power(winning))) win = i;
  }
  return trick[win];
}

export function shouldPick(hand, seat, dealer) {
  const trump = hand.filter(isTrump);
  const queens = trump.filter((card) => card.rank === 'Q').length;
  const codes = trump.map(cardCode);
  let strength = trump.length * 2 + queens * 2;
  if (codes.includes('QC')) strength += 3;
  if (codes.includes('QS')) strength += 2;
  let spoken = 0;
  for (let step = 1; step <= 5; step += 1) {
    if ((dealer + step) % 5 === seat) break;
    spoken += 1;
  }
  return strength >= 12 - spoken;
}

export function chooseBury(hand) {
  const buryScore = (card) => {
    if (isTrump(card)) return 100 + power(card);
    if (card.rank === 'A') return 80;
    if (card.rank === '10') return 50;
    return power(card);
  };
  return hand.slice().sort((a, b) => buryScore(a) - buryScore(b)).slice(0, 2);
}

export function failAcesHeld(hand) {
  return FAIL_SUITS.filter((suit) => hand.some((card) => card.rank === 'A' && card.suit === suit));
}

export function chooseCall(hand) {
  const trump = hand.filter(isTrump);
  const blackQueens = hand.filter((card) => card.rank === 'Q' && (card.suit === 'c' || card.suit === 's')).length;
  const missing = FAIL_SUITS.filter((suit) => !failAcesHeld(hand).includes(suit));
  if (!missing.length || (trump.length >= 6 && blackQueens === 2)) return { alone: true, ace: null };
  missing.sort((a, b) => {
    const length = (suit) => hand.filter((card) => suitKey(card) === suit).length;
    return length(a) - length(b);
  });
  return { alone: false, ace: missing[0] };
}

function lowest(cards, score) {
  return cards.slice().sort((a, b) => score(a) - score(b))[0];
}

function wouldWin(card, trick) {
  const trial = trick.concat([{ seat: -1, card }]);
  return trickWinner(trial).seat === -1;
}

function friendWinning(winSeat, seat, ctx) {
  if (winSeat === seat) return true;
  if (ctx.partner == null) return false;
  const makers = [ctx.picker, ctx.partner];
  return makers.includes(seat) && makers.includes(winSeat);
}

export function choosePlay(hand, trick, ctx) {
  const legal = legalPlays(hand, trick[0] && trick[0].card);
  if (!trick.length) {
    const trump = legal.filter(isTrump);
    const onMakers = ctx.seat === ctx.picker || (ctx.partner != null && ctx.seat === ctx.partner);
    if (onMakers && trump.length >= 2) return lowest(trump, (card) => -power(card));
    const aces = legal.filter((card) => card.rank === 'A' && !isTrump(card));
    if (!onMakers && aces.length) return aces[0];
    const fail = legal.filter((card) => !isTrump(card));
    if (fail.length) return lowest(fail, (card) => power(card) + points(card));
    return lowest(legal, power);
  }
  const win = trickWinner(trick);
  const friendly = friendWinning(win.seat, ctx.seat, ctx);
  const beaters = legal.filter((card) => wouldWin(card, trick));
  const trickPoints = trick.reduce((sum, play) => sum + points(play.card), 0);
  if (!friendly && beaters.length && (trickPoints >= 8 || isTrump(trick[0].card) || ctx.seat === ctx.picker)) {
    return lowest(beaters, power);
  }
  if (friendly) {
    const ducks = legal.filter((card) => !wouldWin(card, trick));
    const pool = ducks.length ? ducks : legal;
    return lowest(pool, (card) => -(points(card) * 10 + power(card)));
  }
  const led = suitKey(trick[0].card);
  const canFollow = hand.some((card) => suitKey(card) === led);
  if (!canFollow && trickPoints >= 10) {
    const trumps = legal.filter(isTrump);
    if (trumps.length) return lowest(trumps, power);
  }
  return lowest(legal, (card) => points(card) * 10 + power(card));
}

export function chooseLeasterPlay(hand, trick) {
  const legal = legalPlays(hand, trick[0] && trick[0].card);
  if (!trick.length) return lowest(legal, (card) => points(card) * 10 + power(card));
  const ducks = legal.filter((card) => !wouldWin(card, trick));
  return lowest(ducks.length ? ducks : legal, (card) => points(card) * 10 + power(card));
}

export function makerResult(makerPoints, makerTricks) {
  const makersWin = makerPoints >= 61;
  const loserPoints = makersWin ? 120 - makerPoints : makerPoints;
  const loserTricks = makersWin ? 6 - makerTricks : makerTricks;
  let value = 2;
  if (loserPoints < 31) value += 1;
  if (loserTricks === 0) value += 1;
  return makersWin ? value : -value;
}

export function seatPayout(seat, makers, result, unit) {
  const defenders = [0, 1, 2, 3, 4].filter((other) => !makers.includes(other));
  const makersWin = result > 0;
  const winners = makersWin ? makers : defenders;
  const losers = makersWin ? defenders : makers;
  const magnitude = Math.abs(result) * unit;
  if (winners.includes(seat)) return magnitude * losers.length;
  return -magnitude * winners.length;
}

export function leasterWinner(taken) {
  const contenders = taken
    .map((cards, seat) => ({ seat, points: handPoints(cards), tricks: cards.length / 5 }))
    .filter((row) => row.tricks > 0);
  if (!contenders.length) return null;
  contenders.sort((a, b) => a.points - b.points || a.seat - b.seat);
  if (contenders.length > 1 && contenders[0].points === contenders[1].points) return null;
  return contenders[0].seat;
}

export function sortHand(hand) {
  const suitOrder = { trump: 0, c: 1, s: 2, h: 3 };
  return hand.slice().sort((a, b) => {
    const suit = suitOrder[suitKey(a)] - suitOrder[suitKey(b)];
    if (suit) return suit;
    return power(b) - power(a);
  });
}

export { FAIL_SUITS, TRUMP_ORDER };
