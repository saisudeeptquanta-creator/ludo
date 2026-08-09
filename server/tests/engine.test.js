import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/game-engine/engine.js';
import { legalMoves, occupancy, hasWon, preferredAutoMove } from '../src/game-engine/rules.js';
import * as B from '../src/game-engine/board.js';
import { GAME_CONFIG } from '../src/config/index.js';

// --------------------------------------------------------------- helpers ---

function makeState(playerCount = 2, config = {}) {
  const players = GAME_CONFIG.SEATING[playerCount].map((color, seat) => ({
    userId: 100 + seat,
    seat,
    color,
  }));
  return E.createInitialState({ players, config, now: 0 });
}

/** Directly position a token for a scenario under test. */
function place(state, seat, tokenIndex, progress) {
  const t = state.tokens.find((x) => x.seat === seat && x.tokenIndex === tokenIndex);
  t.progress = progress;
  t.state =
    progress < 0 ? 'HOME' : progress >= B.FINISH_PROGRESS ? 'FINISHED' : 'ACTIVE';
  return state;
}

const seatTokens = (s, seat) => s.tokens.filter((t) => t.seat === seat);

// ------------------------------------------------------------------ setup --

test('initial state seats players and parks every token in the yard', () => {
  const s = makeState(4);
  assert.equal(s.players.length, 4);
  assert.equal(s.tokens.length, 16);
  assert.ok(s.tokens.every((t) => t.progress === -1 && t.state === 'HOME'));
  assert.equal(s.currentSeat, 0);
  assert.equal(s.status, 'active');
  assert.equal(s.diceRolled, false);
  assert.deepEqual(
    s.players.map((p) => p.color),
    ['RED', 'GREEN', 'YELLOW', 'BLUE'],
  );
});

test('2-player games seat opposite colours', () => {
  const s = makeState(2);
  assert.deepEqual(s.players.map((p) => p.color), ['RED', 'YELLOW']);
});

// ------------------------------------------------------------------ roll ---

test('a player who is not on turn cannot roll', () => {
  const s = makeState(2);
  const r = E.rollDice(s, { seat: 1, value: 6 });
  assert.equal(r.error, 'NOT_YOUR_TURN');
  assert.equal(r.state, s, 'state must be untouched on rejection');
});

test('a player cannot roll twice in one turn', () => {
  const s = makeState(2);
  const first = E.rollDice(s, { seat: 0, value: 6 });
  const second = E.rollDice(first.state, { seat: 0, value: 6 });
  assert.equal(second.error, 'ALREADY_ROLLED');
});

test('rolling advances stateVersion and records the dice', () => {
  let s = makeState(2);
  s = place(s, 0, 0, 5); // a playable token, so the roll is not auto-passed
  const r = E.rollDice(s, { seat: 0, value: 4 });
  assert.equal(r.state.diceValue, 4);
  assert.equal(r.state.diceRolled, true);
  assert.equal(r.state.stateVersion, s.stateVersion + 1);
  assert.ok(r.events.some((e) => e.type === 'DICE_ROLLED' && e.value === 4));
});

test('crypto dice only ever produces 1..6 and covers every face', () => {
  const seen = new Set();
  for (let i = 0; i < 4000; i += 1) {
    const v = E.rollDiceValue();
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 6, `bad dice value ${v}`);
    seen.add(v);
  }
  assert.equal(seen.size, 6);
});

// ------------------------------------------------------------- releasing ---

test('a token leaves the yard only on a 6', () => {
  const s = makeState(2);
  assert.equal(legalMoves(s, 0, 3).length, 0);
  assert.equal(legalMoves(s, 0, 5).length, 0);
  assert.equal(legalMoves(s, 0, 6).length, 4, 'all four tokens may be released');
});

test('rolling a non-6 with everything in the yard passes the turn', () => {
  const s = makeState(2);
  const r = E.rollDice(s, { seat: 0, value: 3 });
  assert.ok(r.events.some((e) => e.type === 'NO_LEGAL_MOVE'));
  assert.equal(r.state.currentSeat, 1, 'turn moves to the next player');
  assert.equal(r.state.diceRolled, false, 'next player starts un-rolled');
});

test('releasing lands the token on its own entry square', () => {
  let s = makeState(2);
  s = E.rollDice(s, { seat: 0, value: 6 }).state;
  const r = E.applyMove(s, { seat: 0, tokenIndex: 0 });
  const token = r.state.tokens.find((t) => t.seat === 0 && t.tokenIndex === 0);
  assert.equal(token.progress, 0);
  assert.equal(B.ringIndexFor('RED', token.progress), B.START_INDEX.RED);
  assert.equal(token.state, 'SAFE', 'entry squares are safe squares');
});

// -------------------------------------------------------------- ownership --

test('a player cannot move another player’s token', () => {
  let s = makeState(2);
  s = E.rollDice(s, { seat: 0, value: 6 }).state;
  // seat 1 tries to act during seat 0's turn
  const r = E.applyMove(s, { seat: 1, tokenIndex: 0 });
  assert.equal(r.error, 'NOT_YOUR_TURN');
});

test('moving before rolling is rejected', () => {
  const s = makeState(2);
  const r = E.applyMove(s, { seat: 0, tokenIndex: 0 });
  assert.equal(r.error, 'NOT_ROLLED');
});

test('a token index that has no legal move is rejected', () => {
  let s = makeState(2);
  s = place(s, 0, 0, 10);
  s = E.rollDice(s, { seat: 0, value: 3 }).state;
  // token 1 is still in the yard and cannot move on a 3
  const r = E.applyMove(s, { seat: 0, tokenIndex: 1 });
  assert.equal(r.error, 'ILLEGAL_MOVE');
});

// --------------------------------------------------------------- capture ---

test('landing on an opponent sends it back to the yard', () => {
  let s = makeState(2);
  // RED at ring 10 (progress 10); YELLOW occupies the same ring square.
  s = place(s, 0, 0, 7);
  const yellowProgress = (10 - B.START_INDEX.YELLOW + 52) % 52; // ring 10 for YELLOW
  s = place(s, 1, 0, yellowProgress);
  assert.equal(B.ringIndexFor('YELLOW', yellowProgress), 10);

  s = E.rollDice(s, { seat: 0, value: 3 }).state;
  const r = E.applyMove(s, { seat: 0, tokenIndex: 0 });

  const victim = r.state.tokens.find((t) => t.seat === 1 && t.tokenIndex === 0);
  assert.equal(victim.progress, -1, 'captured token returns to the yard');
  assert.ok(r.events.some((e) => e.type === 'TOKEN_CAPTURED' && e.seat === 1));
  assert.equal(r.state.players[0].captures, 1);
  assert.equal(r.state.players[1].timesCaptured, 1);
});

test('a token standing on a safe square cannot be captured', () => {
  let s = makeState(2);
  // ring 8 is a starred safe square
  s = place(s, 0, 0, 5);
  const yellowOnStar = (8 - B.START_INDEX.YELLOW + 52) % 52;
  s = place(s, 1, 0, yellowOnStar);
  assert.ok(B.isSafeRingIndex(8));

  s = E.rollDice(s, { seat: 0, value: 3 }).state;
  const r = E.applyMove(s, { seat: 0, tokenIndex: 0 });

  const survivor = r.state.tokens.find((t) => t.seat === 1 && t.tokenIndex === 0);
  assert.equal(survivor.progress, yellowOnStar, 'safe token stays put');
  assert.ok(!r.events.some((e) => e.type === 'TOKEN_CAPTURED'));
});

test('captures are impossible inside a home column', () => {
  const s = makeState(2);
  // RED progress 53 and YELLOW progress 53 are different physical squares.
  assert.notEqual(B.cellKey('RED', 53), B.cellKey('YELLOW', 53));
});

test('landing on your own token is allowed when stacking is enabled', () => {
  let s = makeState(2, { STACKING_ENABLED: true });
  s = place(s, 0, 0, 5);
  s = place(s, 0, 1, 8);
  const moves = legalMoves(s, 0, 3);
  assert.ok(moves.some((m) => m.tokenIndex === 0 && m.to === 8));
});

test('landing on your own token is refused when stacking is disabled', () => {
  let s = makeState(2, { STACKING_ENABLED: false });
  s = place(s, 0, 0, 5);
  s = place(s, 0, 1, 8);
  const moves = legalMoves(s, 0, 3);
  assert.ok(!moves.some((m) => m.tokenIndex === 0 && m.to === 8));
});

// ------------------------------------------------------------ extra turns --

test('rolling a 6 grants another roll to the same player', () => {
  let s = makeState(2);
  s = E.rollDice(s, { seat: 0, value: 6 }).state;
  const r = E.applyMove(s, { seat: 0, tokenIndex: 0 });
  assert.equal(r.state.currentSeat, 0, 'same player keeps the turn');
  assert.equal(r.state.diceRolled, false, 'and must roll again');
  assert.ok(r.events.some((e) => e.type === 'EXTRA_TURN' && e.reason === 'six'));
});

test('a capture grants another roll', () => {
  let s = makeState(2);
  s = place(s, 0, 0, 7);
  s = place(s, 1, 0, (10 - B.START_INDEX.YELLOW + 52) % 52);
  s = E.rollDice(s, { seat: 0, value: 3 }).state;
  const r = E.applyMove(s, { seat: 0, tokenIndex: 0 });
  assert.equal(r.state.currentSeat, 0);
  assert.ok(r.events.some((e) => e.type === 'EXTRA_TURN' && e.reason === 'capture'));
});

test('an ordinary move passes the turn to the next player', () => {
  let s = makeState(2);
  s = place(s, 0, 0, 5);
  s = E.rollDice(s, { seat: 0, value: 3 }).state;
  const r = E.applyMove(s, { seat: 0, tokenIndex: 0 });
  assert.equal(r.state.currentSeat, 1);
  assert.ok(r.events.some((e) => e.type === 'TURN_STARTED' && e.seat === 1));
});

test('three consecutive sixes forfeits the turn and voids the roll', () => {
  let s = makeState(2);
  s = place(s, 0, 0, 5);

  s = E.rollDice(s, { seat: 0, value: 6 }).state;
  s = E.applyMove(s, { seat: 0, tokenIndex: 0 }).state;
  assert.equal(s.currentSeat, 0);

  s = E.rollDice(s, { seat: 0, value: 6 }).state;
  s = E.applyMove(s, { seat: 0, tokenIndex: 0 }).state;
  assert.equal(s.currentSeat, 0);

  const third = E.rollDice(s, { seat: 0, value: 6 });
  assert.ok(third.events.some((e) => e.type === 'TURN_FORFEITED' && e.reason === 'three_sixes'));
  assert.equal(third.state.currentSeat, 1, 'turn passes on the third six');
  assert.deepEqual(third.moves, [], 'the third six may not be played');
});

test('consecutive-six counter resets after a non-six', () => {
  let s = makeState(2);
  s = place(s, 0, 0, 5);
  s = E.rollDice(s, { seat: 0, value: 6 }).state;
  assert.equal(s.consecutiveSixes, 1);
  s = E.applyMove(s, { seat: 0, tokenIndex: 0 }).state;
  s = E.rollDice(s, { seat: 0, value: 2 }).state;
  assert.equal(s.consecutiveSixes, 0);
});

// ------------------------------------------------------------- home + win --

test('landing on the centre needs an exact roll', () => {
  // EXACT_FINISH_REQUIRED is on: a token two from home is only playable with a
  // 2. A larger roll cannot move it at all, which is the classic rule and what
  // players expect at the end of the home column.
  let s = makeState(2);
  s = place(s, 0, 0, B.FINISH_PROGRESS - 2); // needs exactly 2 to finish

  // Only this token's own moves matter here: a 6 also releases a yard token,
  // which is a separate (and still legal) move.
  const forToken0 = (dice) => legalMoves(s, 0, dice).filter((m) => m.tokenIndex === 0);
  assert.equal(forToken0(3).length, 0, 'an overshoot is not playable');
  assert.equal(forToken0(6).length, 0, 'a big overshoot is not playable');

  const exact = forToken0(2);
  assert.equal(exact.length, 1);
  assert.ok(exact[0].finishes, 'an exact roll finishes');
  assert.equal(exact[0].path.length, 2, 'the walk must equal the dice value');

  // Short of the centre still moves normally.
  const short = forToken0(1);
  assert.equal(short.length, 1);
  assert.equal(short[0].to, B.FINISH_PROGRESS - 1);
});

test('in the home column only a roll that fits is offered', () => {
  // Four steps from the centre: 1..4 are playable, 5 and 6 are not. This is
  // the rule as the player states it — you may move only as many steps as
  // remain, never more.
  let s = makeState(2);
  const remaining = 4;
  s = place(s, 0, 0, B.FINISH_PROGRESS - remaining);
  // Park the rest so a 6 cannot release anything and confuse the count.
  s = place(s, 0, 1, B.FINISH_PROGRESS);
  s = place(s, 0, 2, B.FINISH_PROGRESS);
  s = place(s, 0, 3, B.FINISH_PROGRESS);

  for (let dice = 1; dice <= 6; dice += 1) {
    const moves = legalMoves(s, 0, dice).filter((m) => m.tokenIndex === 0);
    if (dice <= remaining) {
      assert.equal(moves.length, 1, `${dice} must be playable with ${remaining} left`);
      assert.equal(moves[0].to, B.FINISH_PROGRESS - remaining + dice);
      assert.equal(moves[0].finishes, dice === remaining);
    } else {
      assert.equal(moves.length, 0, `${dice} must NOT be playable with ${remaining} left`);
    }
  }
});

test('a token stuck in the home column does not block another token', () => {
  // The stuck token must not consume the turn: a different token that CAN
  // move has to still be offered.
  let s = makeState(2);
  s = place(s, 0, 0, B.FINISH_PROGRESS - 1); // needs exactly 1
  s = place(s, 0, 1, 10); // free to move anywhere

  const moves = legalMoves(s, 0, 5);
  assert.ok(!moves.some((m) => m.tokenIndex === 0), 'the stuck token is not offered');
  assert.ok(moves.some((m) => m.tokenIndex === 1), 'the other token is still playable');
});

test('the home column can never be captured', () => {
  // Two seats whose columns overlap in progress terms. Whatever an opponent
  // rolls, no move may report a capture against a token in its home column.
  let s = makeState(2);
  s = place(s, 1, 0, B.LAST_RING_PROGRESS + 1); // just inside seat 1's column
  s = place(s, 1, 1, B.LAST_RING_PROGRESS + 3);

  for (let from = 0; from <= B.LAST_RING_PROGRESS; from += 1) {
    s = place(s, 0, 0, from);
    for (let dice = 1; dice <= 6; dice += 1) {
      for (const m of legalMoves(s, 0, dice)) {
        assert.equal(m.captures.length, 0, `capture reached a home column from ${from} with ${dice}`);
      }
    }
  }
});

test('a token that cannot finish exactly forfeits the turn rather than hanging', () => {
  // The danger of requiring an exact roll is a player with no legal move at
  // all. The engine must pass the turn on, not stall.
  let s = makeState(2);
  // Three tokens already home, the fourth one short of the centre. A 5 can
  // neither finish it exactly nor release anything, so seat 0 has no move.
  s = place(s, 0, 0, B.FINISH_PROGRESS - 1);
  s = place(s, 0, 1, B.FINISH_PROGRESS);
  s = place(s, 0, 2, B.FINISH_PROGRESS);
  s = place(s, 0, 3, B.FINISH_PROGRESS);

  assert.equal(legalMoves(s, 0, 5).length, 0, 'no move is available');

  const rolled = E.rollDice(s, { seat: 0, value: 5 });
  assert.notEqual(rolled.state.currentSeat, 0, 'the turn must advance');
});

test('an exact roll finishes a token on the centre', () => {
  let s = makeState(2);
  s = place(s, 0, 0, B.FINISH_PROGRESS - 3);
  s = E.rollDice(s, { seat: 0, value: 3 }).state;
  const r = E.applyMove(s, { seat: 0, tokenIndex: 0 });
  const t = r.state.tokens.find((x) => x.seat === 0 && x.tokenIndex === 0);
  assert.equal(t.progress, B.FINISH_PROGRESS);
  assert.equal(t.state, 'FINISHED');
  assert.equal(r.state.players[0].tokensFinished, 1);
  assert.ok(r.events.some((e) => e.type === 'EXTRA_TURN' && e.reason === 'token_finished'));
});

test('a finished token has no further moves', () => {
  let s = makeState(2);
  s = place(s, 0, 0, B.FINISH_PROGRESS);
  const moves = legalMoves(s, 0, 6);
  assert.ok(!moves.some((m) => m.tokenIndex === 0));
});

test('getting all four tokens home wins the game', () => {
  let s = makeState(2);
  for (let i = 0; i < 3; i += 1) s = place(s, 0, i, B.FINISH_PROGRESS);
  s = place(s, 0, 3, B.FINISH_PROGRESS - 1);

  s = E.rollDice(s, { seat: 0, value: 1 }).state;
  const r = E.applyMove(s, { seat: 0, tokenIndex: 3 });

  assert.ok(hasWon(r.state, 0));
  assert.equal(r.state.status, 'finished');
  assert.equal(r.state.winnerSeat, 0);
  assert.ok(r.events.some((e) => e.type === 'PLAYER_FINISHED' && e.rank === 1));
  assert.ok(r.events.some((e) => e.type === 'GAME_FINISHED' && e.winnerSeat === 0));
  assert.equal(r.state.rankings[0].rank, 1);
  assert.equal(r.state.rankings[1].rank, 2, 'the runner-up is ranked too');
});

test('a 4-player game continues after first place and ranks everyone', () => {
  let s = makeState(4);
  for (let i = 0; i < 3; i += 1) s = place(s, 0, i, B.FINISH_PROGRESS);
  s = place(s, 0, 3, B.FINISH_PROGRESS - 1);

  s = E.rollDice(s, { seat: 0, value: 1 }).state;
  const r = E.applyMove(s, { seat: 0, tokenIndex: 3 });

  assert.equal(r.state.status, 'active', 'game continues for the other three');
  assert.equal(r.state.players[0].status, 'finished');
  assert.equal(r.state.players[0].finishedRank, 1);
  assert.notEqual(r.state.currentSeat, 0, 'a finished player never gets another turn');
});

// -------------------------------------------------------------- timeouts ---

test('turn timeout rolls and auto-plays the best move', () => {
  let s = makeState(2);
  s = place(s, 0, 0, 7);
  s = place(s, 1, 0, (10 - B.START_INDEX.YELLOW + 52) % 52); // capturable at ring 10

  const r = E.handleTimeout(s, { seat: 0, value: 3 });
  assert.ok(r.events.some((e) => e.type === 'DICE_ROLLED'));
  assert.ok(r.events.some((e) => e.type === 'TOKEN_MOVED' && e.auto === true));
  assert.ok(r.events.some((e) => e.type === 'TOKEN_CAPTURED'), 'auto-play prefers a capture');
});

test('auto-play prefers finishing, then capturing, then releasing', () => {
  const moves = [
    { tokenIndex: 3, to: 10, finishes: false, captures: [], releases: false },
    { tokenIndex: 2, to: 0, finishes: false, captures: [], releases: true },
    { tokenIndex: 1, to: 20, finishes: false, captures: [{}], releases: false },
    { tokenIndex: 0, to: 57, finishes: true, captures: [], releases: false },
  ];
  assert.equal(preferredAutoMove(moves).tokenIndex, 0);
  assert.equal(preferredAutoMove(moves.slice(0, 3)).tokenIndex, 1);
  assert.equal(preferredAutoMove(moves.slice(0, 2)).tokenIndex, 2);
  assert.equal(preferredAutoMove([]), null);
});

test('timing out with nothing playable simply passes the turn', () => {
  const s = makeState(2);
  const r = E.handleTimeout(s, { seat: 0, value: 2 });
  assert.equal(r.state.currentSeat, 1);
});

test('repeated timeouts drop the player and the game continues', () => {
  let s = makeState(3);
  s = place(s, 0, 0, 5);
  for (let i = 0; i < GAME_CONFIG.MAX_CONSECUTIVE_TIMEOUTS; i += 1) {
    const r = E.handleTimeout(s, { seat: 0, value: 2 });
    s = r.state;
    if (s.currentSeat !== 0 && s.players[0].status === 'playing') {
      // walk the turn back around to seat 0
      s = { ...s, currentSeat: 0, diceRolled: false, diceValue: null };
    }
  }
  assert.notEqual(s.players[0].status, 'playing', 'seat 0 was dropped');
  assert.equal(s.status, 'active', 'the remaining two players continue');
});

// --------------------------------------------------------- connectivity ---

test('a disconnect never resets the board', () => {
  let s = makeState(2);
  s = place(s, 0, 0, 20);
  s = place(s, 1, 0, 15);
  const before = s.tokens.map((t) => t.progress);

  const r = E.setConnected(s, { seat: 1, connected: false });
  assert.deepEqual(r.state.tokens.map((t) => t.progress), before);
  assert.equal(r.state.players[1].connected, false);
  assert.equal(r.state.status, 'active');
  assert.ok(r.events.some((e) => e.type === 'PLAYER_DISCONNECTED'));
});

test('reconnecting restores the seat without touching the game', () => {
  let s = makeState(2);
  s = place(s, 0, 0, 20);
  s = E.setConnected(s, { seat: 1, connected: false }).state;
  const r = E.setConnected(s, { seat: 1, connected: true });
  assert.equal(r.state.players[1].connected, true);
  assert.equal(r.state.tokens.find((t) => t.seat === 0 && t.tokenIndex === 0).progress, 20);
  assert.ok(r.events.some((e) => e.type === 'PLAYER_RECONNECTED'));
});

test('a player leaving a 3-player game clears their tokens and play continues', () => {
  let s = makeState(3);
  s = place(s, 1, 0, 20);
  const r = E.removePlayer(s, { seat: 1, reason: 'left' });

  assert.equal(r.state.players[1].status, 'left');
  assert.ok(
    r.state.tokens.filter((t) => t.seat === 1).every((t) => t.progress === -1),
    'abandoned tokens leave the board',
  );
  assert.equal(r.state.status, 'active');
  assert.ok(r.events.some((e) => e.type === 'PLAYER_LEFT'));
});

test('a player leaving a 2-player game ends it and awards the win', () => {
  let s = makeState(2);
  const r = E.removePlayer(s, { seat: 1, reason: 'left' });
  assert.equal(r.state.status, 'finished');
  assert.equal(r.state.winnerSeat, 0);
  assert.ok(r.events.some((e) => e.type === 'GAME_FINISHED'));
});

test('the turn moves on when the player whose turn it is leaves', () => {
  let s = makeState(3);
  assert.equal(s.currentSeat, 0);
  const r = E.removePlayer(s, { seat: 0, reason: 'left' });
  assert.equal(r.state.status, 'active');
  assert.notEqual(r.state.currentSeat, 0);
});

// ----------------------------------------------------------- invariants ---

test('rejected actions never mutate or bump the version', () => {
  const s = makeState(2);
  const before = JSON.stringify(s);
  E.rollDice(s, { seat: 1, value: 6 });
  E.applyMove(s, { seat: 0, tokenIndex: 0 });
  E.applyMove(s, { seat: 3, tokenIndex: 0 });
  assert.equal(JSON.stringify(s), before, 'engine mutated a state it rejected');
});

test('every accepted transition increments stateVersion exactly once', () => {
  let s = makeState(2);
  let v = s.stateVersion;
  s = E.rollDice(s, { seat: 0, value: 6 }).state;
  assert.equal(s.stateVersion, v + 1);
  v = s.stateVersion;
  s = E.applyMove(s, { seat: 0, tokenIndex: 0 }).state;
  assert.equal(s.stateVersion, v + 1);
});

test('two tokens never occupy the same square unless they are stacked allies', () => {
  let s = makeState(4);
  s = place(s, 0, 0, 5);
  s = place(s, 0, 1, 5);
  const occ = occupancy(s);
  const cell = occ.get(B.cellKey('RED', 5));
  assert.equal(cell.length, 2);
  assert.ok(cell.every((t) => t.seat === 0));
});

test('a full random game always terminates with a winner', () => {
  // Fuzz: play many complete games with real dice and assert the machine never
  // deadlocks, never produces an illegal state, and always ends.
  for (let game = 0; game < 25; game += 1) {
    let s = makeState(4);
    let guard = 0;
    while (s.status === 'active') {
      guard += 1;
      assert.ok(guard < 20000, 'game failed to terminate');

      const seat = s.currentSeat;
      const rolled = E.rollDice(s, { seat });
      assert.ok(!rolled.error, `unexpected roll error ${rolled.error}`);
      s = rolled.state;
      if (s.status !== 'active') break;
      if (!s.diceRolled) continue; // turn already passed

      const moves = legalMoves(s, seat, s.diceValue);
      if (moves.length === 0) continue;
      const pick = moves[Math.floor(Math.random() * moves.length)];
      const moved = E.applyMove(s, { seat, tokenIndex: pick.tokenIndex });
      assert.ok(!moved.error, `unexpected move error ${moved.error}`);
      s = moved.state;

      for (const t of s.tokens) {
        assert.ok(
          t.progress >= -1 && t.progress <= B.FINISH_PROGRESS,
          `token escaped the board at progress ${t.progress}`,
        );
      }
    }
    assert.equal(s.status, 'finished');
    assert.notEqual(s.winnerSeat, null);
    assert.equal(s.rankings.length, 4, 'every player is ranked');
    assert.deepEqual(
      s.rankings.map((r) => r.rank),
      [1, 2, 3, 4],
    );
  }
});

test('idling does not end the game prematurely', () => {
  // Regression: MAX_CONSECUTIVE_TIMEOUTS was 3, so a distracted opponent in a
  // 2-player game was dropped after ~75s and the other player was shown
  // "You Win!" with zero tokens home.
  let s = makeState(2);
  for (let i = 0; i < 12; i += 1) {
    const r = E.handleTimeout(s, { seat: s.currentSeat, value: 2 });
    s = r.state;
    if (s.status !== 'active') break;
  }
  assert.equal(s.status, 'active', 'repeated timeouts must not end the game');
});

test('a game that ends because opponents left is flagged, not called a win', () => {
  const s = makeState(2);
  const r = E.removePlayer(s, { seat: 1, reason: 'left' });

  assert.equal(r.state.status, 'finished');
  assert.equal(r.state.endReason, 'opponents_left', 'must be distinguishable from a real win');

  const winnerHome = r.state.tokens.filter(
    (t) => t.seat === r.state.winnerSeat && t.state === 'FINISHED',
  ).length;
  assert.equal(winnerHome, 0, 'nobody actually got a token home');
});

test('a genuine win is not flagged as abandoned', () => {
  let s = makeState(2);
  for (let i = 0; i < 3; i += 1) s = place(s, 0, i, B.FINISH_PROGRESS);
  s = place(s, 0, 3, B.FINISH_PROGRESS - 1);

  s = E.rollDice(s, { seat: 0, value: 1 }).state;
  const r = E.applyMove(s, { seat: 0, tokenIndex: 3 });

  assert.equal(r.state.status, 'finished');
  assert.notEqual(r.state.endReason, 'opponents_left');
  assert.equal(
    r.state.tokens.filter((t) => t.seat === 0 && t.state === 'FINISHED').length,
    4,
    'a real win has all four tokens home',
  );
});

test('a move always advances exactly the dice value, including across safe squares', () => {
  // Regression: tokens appeared to stop a square short when passing a safe
  // square. Sweeps every start position and dice value on the ring.
  for (let from = 0; from <= 44; from += 1) {
    for (let dice = 1; dice <= 6; dice += 1) {
      let s = makeState(2);
      s = place(s, 0, 0, from);
      const move = legalMoves(s, 0, dice).find((m) => m.tokenIndex === 0);
      if (!move) continue;
      assert.equal(move.to, from + dice, `from ${from} with a ${dice} landed on ${move.to}`);
      assert.equal(move.path.length, dice, `from ${from} with a ${dice} walked ${move.path.length}`);
      assert.equal(move.path[move.path.length - 1], from + dice, 'path must end on the destination');
    }
  }
});

test('a release is a single hop even though it costs a six', () => {
  // Regression: the animator walked `dice` squares instead of following `path`,
  // so releasing on a 6 animated as six steps and every later move looked
  // desynced from the die.
  const s = makeState(2);
  const move = legalMoves(s, 0, 6).find((m) => m.releases);

  assert.ok(move, 'a 6 must offer a release');
  assert.equal(move.from, -1, 'a release starts in the yard');
  assert.equal(move.to, 0, 'and lands on the entry square');
  assert.deepEqual(move.path, [0], 'the walk is one hop, not six');
  assert.equal(move.path.length, 1);
});

test('path length equals the dice for every move except a release', () => {
  // The invariant the renderer relies on: follow `path`, never `dice`.
  for (let from = -1; from <= 50; from += 1) {
    for (let dice = 1; dice <= 6; dice += 1) {
      let s = makeState(2);
      s = place(s, 0, 0, from);
      const move = legalMoves(s, 0, dice).find((m) => m.tokenIndex === 0);
      if (!move) continue;

      if (move.releases) {
        assert.equal(move.path.length, 1, `release from ${from} on a ${dice} must be one hop`);
      } else {
        assert.equal(
          move.path.length,
          dice,
          `move from ${from} on a ${dice} walked ${move.path.length} squares`,
        );
      }
      assert.equal(move.path[move.path.length - 1], move.to, 'path must end on the destination');
    }
  }
});
