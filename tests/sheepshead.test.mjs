import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeck,
  cardCode,
  cardFromCode,
  chooseCall,
  deal,
  handPoints,
  isTrump,
  legalPlays,
  leasterWinner,
  makerResult,
  points,
  seatPayout,
  shouldPick,
  trickWinner
} from '../sheepshead.js';

const c = cardFromCode;

test('the deck holds 120 points and diamonds are trump', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 32);
  assert.equal(handPoints(deck), 120);
  assert.equal(isTrump(c('AD')), true);
  assert.equal(isTrump(c('AC')), false);
  assert.equal(isTrump(c('JC')), true);
});

test('tens beat kings, and a jack beats a diamond ace', () => {
  const fail = trickWinner([
    { seat: 0, card: c('KC') },
    { seat: 1, card: c('10C') },
    { seat: 2, card: c('7C') }
  ]);
  assert.equal(fail.seat, 1);

  const trump = trickWinner([
    { seat: 0, card: c('AD') },
    { seat: 1, card: c('JD') },
    { seat: 2, card: c('7H') }
  ]);
  assert.equal(trump.seat, 1);

  const queen = trickWinner([
    { seat: 0, card: c('JC') },
    { seat: 1, card: c('QC') }
  ]);
  assert.equal(queen.seat, 1);
});

test('a fail lead must be followed with that fail suit', () => {
  const hand = [c('AC'), c('JC'), c('7H')];
  const legal = legalPlays(hand, c('9C')).map(cardCode);
  assert.deepEqual(legal, ['AC']);
});

test('sixty-one makes it and a missed schneider costs more', () => {
  assert.equal(makerResult(61, 3), 2);
  assert.equal(makerResult(90, 4), 3);
  assert.equal(makerResult(120, 6), 4);
  assert.equal(makerResult(60, 3), -2);
  assert.equal(makerResult(30, 2), -3);
  assert.equal(makerResult(20, 0), -4);
  assert.equal(points(c('AC')), 11);
});

test('a partner game pays each loser to each winner', () => {
  assert.equal(seatPayout(0, [0, 2], 2, 5), 30);
  assert.equal(seatPayout(1, [0, 2], 2, 5), -20);
  assert.equal(seatPayout(0, [0], 2, 5), 40);
});

test('a rich late hand picks and a called ace is one you do not hold', () => {
  const rich = [c('QC'), c('QS'), c('AD'), c('10D'), c('7C'), c('8S')];
  assert.equal(shouldPick(rich, 4, 3), true);
  const called = chooseCall([c('AC'), c('7S'), c('8H'), c('9C'), c('KD'), c('7D')]);
  assert.equal(called.alone, false);
  assert.notEqual(called.ace, 'c');
});

test('a deal is six cards and two in the blind', () => {
  const dealt = deal(0, () => 0.25);
  assert.equal(dealt.blind.length, 2);
  assert.ok(dealt.hands.every((hand) => hand.length === 6));
  const codes = new Set(dealt.hands.flat().concat(dealt.blind).map((card) => `${card.rank}${card.suit}`));
  assert.equal(codes.size, 32);
});

test('leaster goes to the fewest points among players who took a trick', () => {
  const trick = (codes) => codes.map(c);
  const taken = [
    trick(['7C', '8C', '9C', '7S', '8S']),
    [],
    trick(['AS', '10S', 'KS', '9S', '8H']),
    [],
    []
  ];
  assert.equal(leasterWinner(taken), 0);
});
