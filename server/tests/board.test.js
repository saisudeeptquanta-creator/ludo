import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../src/game-engine/board.js';

test('ring has exactly 52 unique squares', () => {
  assert.equal(B.RING.length, 52);
  const unique = new Set(B.RING.map(([r, c]) => `${r},${c}`));
  assert.equal(unique.size, 52, 'ring contains a duplicated coordinate');
});

test('ring is contiguous, rounding the centre block at exactly four corners', () => {
  // The centre block's corner squares are not track squares, so the standard
  // 52-cell path turns diagonally at those four points and nowhere else.
  const diagonals = [];
  for (let i = 0; i < B.RING.length; i += 1) {
    const [r1, c1] = B.RING[i];
    const [r2, c2] = B.RING[(i + 1) % B.RING.length];
    const dist = Math.abs(r1 - r2) + Math.abs(c1 - c2);
    if (dist === 2) {
      assert.ok(
        Math.abs(r1 - r2) === 1 && Math.abs(c1 - c2) === 1,
        `step ${i} -> ${i + 1} jumps more than one square`,
      );
      diagonals.push(i);
    } else {
      assert.equal(dist, 1, `step ${i} -> ${i + 1} is not adjacent`);
    }
  }
  assert.deepEqual(diagonals, [...B.DIAGONAL_RING_STEPS]);
});

test('the cross accounts for exactly 81 squares with no overlap', () => {
  const seen = new Map();
  const claim = (cell, role) => {
    const key = `${cell[0]},${cell[1]}`;
    assert.ok(!seen.has(key), `[${key}] claimed by both ${seen.get(key)} and ${role}`);
    seen.set(key, role);
  };
  for (const cell of B.RING) claim(cell, 'ring');
  for (const color of B.COLORS) for (const cell of B.HOME_COLUMN[color]) claim(cell, `home:${color}`);
  claim(B.CENTER_CELL, 'centre');
  for (const cell of B.CENTER_CORNERS) claim(cell, 'centre-corner');

  assert.equal(seen.size, 52 + 4 * 6 + 1 + 4);
  assert.equal(seen.size, 81, 'the cross must be fully tiled');

  // Every claimed square must actually lie on the cross.
  for (const key of seen.keys()) {
    const [r, c] = key.split(',').map(Number);
    const onCross = (c >= 6 && c <= 8) || (r >= 6 && r <= 8);
    assert.ok(onCross, `[${key}] is not part of the cross`);
  }
});

test('every ring square is inside the 15x15 grid', () => {
  for (const [r, c] of B.RING) {
    assert.ok(r >= 0 && r < 15 && c >= 0 && c < 15, `[${r},${c}] out of bounds`);
  }
});

test('colour entry squares are 13 apart and match the classic layout', () => {
  assert.deepEqual(B.START_INDEX, { RED: 0, GREEN: 13, YELLOW: 26, BLUE: 39 });
  assert.deepEqual(B.RING[0], [13, 6]);
  assert.deepEqual(B.RING[13], [6, 1]);
  assert.deepEqual(B.RING[26], [1, 8]);
  assert.deepEqual(B.RING[39], [8, 13]);
});

test('the four starred safe squares sit 8 steps past each entry', () => {
  assert.deepEqual(B.RING[8], [8, 2]);
  assert.deepEqual(B.RING[21], [2, 6]);
  assert.deepEqual(B.RING[34], [6, 12]);
  assert.deepEqual(B.RING[47], [12, 8]);
  assert.equal(B.SAFE_RING_INDICES.size, 8);
});

test('progress model: home is the last home-column square', () => {
  assert.equal(B.LAST_RING_PROGRESS, 50);
  // The END of the home column IS home — there is no further step onto the
  // centre. 51 ring squares + 6 home-column squares = 57 positions, the last
  // of which is the finish.
  assert.equal(B.FINISH_PROGRESS, 56);
  assert.equal(B.LAST_RING_PROGRESS + B.HOME_COLUMN_LENGTH, B.FINISH_PROGRESS);
  assert.equal(B.LAST_RING_PROGRESS + 1 + B.HOME_COLUMN_LENGTH, 57);

  // A finished token rests on its own column's last square, never the centre.
  for (const color of B.COLORS) {
    const at = B.coordFor(color, B.FINISH_PROGRESS);
    const last = B.HOME_COLUMN[color][B.HOME_COLUMN_LENGTH - 1];
    assert.deepEqual(at, last, `${color} finishes on its last home square`);
    assert.notDeepEqual(at, B.CENTER_CELL, `${color} does not finish on the centre`);
  }

  // The square before home is still in the column and needs exactly one step.
  assert.ok(B.isInHomeColumn(B.FINISH_PROGRESS - 1));
  assert.ok(B.isFinished(B.FINISH_PROGRESS));
});

test('every colour turns off the ring two squares before its own entry', () => {
  // The turn-off square is the one adjacent to the first home-column square;
  // the entry square sits one further along, past the arm's corner.
  for (const color of B.COLORS) {
    const lastRing = B.ringIndexFor(color, B.LAST_RING_PROGRESS);
    const entry = B.START_INDEX[color];
    assert.equal(
      (lastRing + 2) % 52,
      entry,
      `${color} turn-off square is not two before its entry`,
    );
  }
});

test('a token can never re-enter the ring square it started on', () => {
  // 51 ring squares travelled means the entry square is visited once, at the
  // very start — never lapped.
  for (const color of B.COLORS) {
    const visited = new Set();
    for (let p = 0; p <= B.LAST_RING_PROGRESS; p += 1) visited.add(B.ringIndexFor(color, p));
    assert.equal(visited.size, 51, `${color} laps the ring`);
  }
});

test('home columns are adjacent to the ring square the token leaves from', () => {
  for (const color of B.COLORS) {
    const [lr, lc] = B.RING[B.ringIndexFor(color, B.LAST_RING_PROGRESS)];
    const [hr, hc] = B.HOME_COLUMN[color][0];
    assert.equal(Math.abs(lr - hr) + Math.abs(lc - hc), 1, `${color} home column is detached`);
  }
});

test('home columns lead to the centre', () => {
  for (const color of B.COLORS) {
    const [lr, lc] = B.HOME_COLUMN[color][B.HOME_COLUMN_LENGTH - 1];
    const [cr, cc] = B.CENTER_CELL;
    assert.equal(Math.abs(lr - cr) + Math.abs(lc - cc), 1, `${color} does not reach the centre`);
  }
});

test('cellKey shares ring squares between colours but isolates home columns', () => {
  // RED progress 13 and GREEN progress 0 are both ring square 13.
  assert.equal(B.cellKey('RED', 13), B.cellKey('GREEN', 0));
  assert.equal(B.cellKey('RED', 13), 'R:13');
  // Home columns are private.
  assert.notEqual(B.cellKey('RED', 52), B.cellKey('GREEN', 52));
  assert.equal(B.cellKey('RED', 52), 'H:RED:1');
  // Yards are private.
  assert.notEqual(B.cellKey('RED', -1), B.cellKey('BLUE', -1));
});

test('safety: entry squares, stars, home column, yard and centre are all safe', () => {
  assert.ok(B.isSafeProgress('RED', 0));    // own entry square
  assert.ok(B.isSafeProgress('RED', 8));    // star
  assert.ok(B.isSafeProgress('RED', -1));   // yard
  assert.ok(B.isSafeProgress('RED', 53));   // home column
  assert.ok(B.isSafeProgress('RED', 57));   // centre
  assert.ok(!B.isSafeProgress('RED', 1));   // ordinary square
});

test('a colour standing on another colour’s entry square is safe there', () => {
  // RED progress 13 == ring 13 == GREEN's entry square, which is a safe square.
  assert.ok(B.isSafeProgress('RED', 13));
});

test('pathBetween walks one square at a time and includes the destination', () => {
  assert.deepEqual(B.pathBetween('RED', 3, 8), [4, 5, 6, 7, 8]);
  assert.deepEqual(B.pathBetween('RED', -1, 0), [0], 'release is a single hop');
  assert.deepEqual(B.pathBetween('RED', 55, 57), [56, 57], 'walks through the home column');
});

test('coordFor renders every legal progress value to an in-bounds square', () => {
  for (const color of B.COLORS) {
    for (let p = -1; p <= B.FINISH_PROGRESS; p += 1) {
      const [r, c] = B.coordFor(color, p, 0);
      assert.ok(
        Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < 15 && c >= 0 && c < 15,
        `${color} progress ${p} rendered to [${r},${c}]`,
      );
    }
  }
});

test('yard slots sit inside their own quadrant', () => {
  for (const color of B.COLORS) {
    const [orow, ocol] = B.YARD_ORIGIN[color];
    for (const [r, c] of B.YARD_SLOTS[color]) {
      assert.ok(
        r >= orow && r < orow + 6 && c >= ocol && c < ocol + 6,
        `${color} yard slot [${r},${c}] is outside its quadrant`,
      );
    }
  }
});
