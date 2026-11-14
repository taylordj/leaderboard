// Checks for the parts of the app that have no screen: the scoreboard rules, the clean-up of
// anything stored or received, and the checks on messages from the relays.
// Open tests/model.test.html in a browser (through a web server), or run `node tests/model.test.js`
// from the project folder.
import * as model from '../js/model.js';
import { parseCommand, parseStatus } from '../js/relay.js';
import { ordinal, signed } from '../js/util.js';
import { ACTIONS, MAX_TEAMS, MAX_POWERUPS, NAME_MAX, MAX_ADJUST, MAX_SCORE, PALETTE, DEFAULT_ICON } from '../js/config.js';

const results = [];
function test(name, fn){
  try { fn(); results.push({ name, ok: true }); }
  catch(err){ results.push({ name, ok: false, error: err.message }); }
}
function eq(actual, expected, what = 'value'){
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if(a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}
const ok = (condition, what) => { if(!condition) throw new Error(what); };

// A small board with known ids: teams a, b, c and powerups j (Joker) and g (Gamble).
function board(scores = [0, 0, 0]){
  return {
    title: 'Test Quiz',
    powerups: [{ id: 'j', name: 'Joker', icon: '🃏' }, { id: 'g', name: 'Gamble', icon: '🎰' }],
    teams: scores.map((score, i) => ({ id: 'abc'[i], name: `Team ${'ABC'[i]}`, color: PALETTE[i], score, used: {} })),
  };
}
// apply() and expect it to work
function must(b, action, arg){
  const r = model.apply(b, action, arg);
  ok(r, `${action} was refused`);
  return r;
}
const team = (b, id) => b.teams.find((t) => t.id === id);

// ---------------------------------------------------------------- the default board
test('the default board has four teams and the four powerups', () => {
  const b = model.defaultBoard();
  eq(b.teams.map((t) => t.name), ['Team Alpha', 'Team Beta', 'Team Gamma', 'Team Delta'], 'teams');
  eq(b.powerups.map((p) => p.name), ['Joker', 'Triple Threat', 'Gamble', '-5 Bomb'], 'powerups');
  ok(b.teams.every((t) => t.score === 0 && Object.keys(t.used).length === 0), 'all on 0 with every powerup');
  eq(model.sanitizeBoard(b), b, 'it survives its own clean-up unchanged');
});

// ---------------------------------------------------------------- standings
test('ranked puts the highest score first and keeps setup order on a tie', () => {
  eq(model.ranked(board([3, 9, 3])).map((t) => t.id), ['b', 'a', 'c'], 'order');
});

test('tied teams share a rank and the next rank is skipped', () => {
  const b = board([10, 10, 4]);
  const info = model.rankInfo(model.ranked(b));
  eq(info.rankOf, { a: 1, b: 1, c: 3 }, 'ranks');
  eq(info.distinct, [10, 4], 'distinct scores');
  eq(info.tiedAtTop, 2, 'tied at the top');
  eq(info.allLevel, false, 'not all level');
});

test('everyone level means nobody is leading', () => {
  const info = model.rankInfo(board([0, 0, 0]).teams);
  eq(info.allLevel, true, 'all level');
  eq(info.rankOf, { a: 1, b: 1, c: 1 }, 'ranks');
});

test('gaps: the leader is ahead of the next score', () => {
  const b = board([12, 9, 2]);
  const info = model.rankInfo(b.teams);
  eq(model.gaps(team(b, 'a'), info), { leader: true, ahead: 3 }, 'leader');
});

// the parts of gaps() the board shows: points, who, and their place
const gapSummary = (g) => g.leader ? g : {
  toFirst: g.toFirst, first: g.first.teams.map((t) => t.name),
  toNext: g.toNext, next: g.next && { names: g.next.teams.map((t) => t.name), rank: g.next.rank },
};

test('gaps: second place only shows the gap to 1st', () => {
  const b = board([12, 9, 2]);
  const info = model.rankInfo(b.teams);
  eq(gapSummary(model.gaps(team(b, 'b'), info)), { toFirst: 3, first: ['Team A'], toNext: null, next: null }, 'second');
  eq(gapSummary(model.gaps(team(b, 'c'), info)), { toFirst: 10, first: ['Team A'], toNext: 7, next: { names: ['Team B'], rank: 2 } }, 'third');
});

test('gaps name everyone on the score just above, and their shared place', () => {
  const b = board([12, 12, 5]);
  const info = model.rankInfo(model.ranked(b));
  eq(gapSummary(model.gaps(team(b, 'c'), info)).first, ['Team A', 'Team B'], 'joint leaders');
  const four = { ...board(), teams: [...board([20, 9, 9]).teams, { id: 'd', name: 'Team D', color: PALETTE[3], score: 4, used: {} }] };
  const g = gapSummary(model.gaps(four.teams[3], model.rankInfo(model.ranked(four))));
  eq(g.next, { names: ['Team B', 'Team C'], rank: 2 }, 'tied for 2nd just above');
  eq(g.toNext, 5, 'gap to them');
});

test('gaps never show +0 against a team on the same score', () => {
  const b = board([12, 5, 5]);
  const info = model.rankInfo(b.teams);
  eq(gapSummary(model.gaps(team(b, 'c'), info)), { toFirst: 7, first: ['Team A'], toNext: null, next: null }, 'tied second');
  const level = board([4, 4, 4]);
  eq(model.gaps(team(level, 'a'), model.rankInfo(level.teams)), { leader: true, ahead: null }, 'all level');
});

test('negative scores rank below zero', () => {
  eq(model.ranked(board([-3, 0, 2])).map((t) => t.id), ['c', 'b', 'a'], 'order');
});

// ---------------------------------------------------------------- scores
test('adjust-score adds and takes away, with a label for Undo', () => {
  const b = board();
  const r = must(b, 'adjust-score', { team: 'b', amount: 5 });
  eq(team(r.board, 'b').score, 5, 'score');
  eq(r.label, '+5 Team B', 'label');
  eq(team(b, 'b').score, 0, 'the old board is untouched');
  eq(must(r.board, 'adjust-score', { team: 'b', amount: -7 }).label, '−7 Team B', 'minus label');
});

test('adjust-score refuses bad amounts and unknown teams', () => {
  const b = board();
  eq(model.apply(b, 'adjust-score', { team: 'b', amount: 0 }), null, 'zero');
  eq(model.apply(b, 'adjust-score', { team: 'b', amount: 1.5 }), null, 'not whole');
  eq(model.apply(b, 'adjust-score', { team: 'b', amount: '5' }), null, 'text');
  eq(model.apply(b, 'adjust-score', { team: 'b', amount: MAX_ADJUST + 1 }), null, 'too big');
  eq(model.apply(b, 'adjust-score', { team: 'zz', amount: 1 }), null, 'unknown team');
  eq(model.apply(b, 'adjust-score'), null, 'no argument');
  ok(model.apply(b, 'adjust-score', { team: 'b', amount: -MAX_ADJUST }), 'the limit itself is fine');
});

test('scores stay within the limit', () => {
  const b = board([MAX_SCORE - 2, 0, 0]);
  eq(team(must(b, 'adjust-score', { team: 'a', amount: 5 }).board, 'a').score, MAX_SCORE, 'capped');
  eq(model.apply(board([MAX_SCORE, 0, 0]), 'adjust-score', { team: 'a', amount: 1 }), null, 'no change at the cap');
});

// ---------------------------------------------------------------- powerups
test('set-powerup marks a powerup used and gives it back', () => {
  const used = must(board(), 'set-powerup', { team: 'a', powerup: 'j', used: true });
  eq(team(used.board, 'a').used, { j: true }, 'used');
  eq(used.label, 'Joker used: Team A', 'label');
  const back = must(used.board, 'set-powerup', { team: 'a', powerup: 'j', used: false });
  eq(team(back.board, 'a').used, {}, 'given back');
  eq(back.label, 'Joker given back: Team A', 'label');
});

test('set-powerup that changes nothing is not an Undo step', () => {
  eq(model.apply(board(), 'set-powerup', { team: 'a', powerup: 'j', used: false }), null, 'already available');
  eq(model.apply(board(), 'set-powerup', { team: 'a', powerup: 'j', used: 'yes' }), null, 'used must be true or false');
  eq(model.apply(board(), 'set-powerup', { team: 'a', powerup: 'nope', used: true }), null, 'unknown powerup');
});

test('add-powerup gives it to every team; remove-powerup takes it from every team', () => {
  const added = must(board(), 'add-powerup', { name: '  Double   Up ', icon: '' });
  const p = added.board.powerups[2];
  eq([p.name, p.icon], ['Double Up', DEFAULT_ICON], 'cleaned name, default icon');
  ok(added.board.teams.every((t) => !t.used[p.id]), 'available to every team');
  let b = must(added.board, 'set-powerup', { team: 'a', powerup: 'j', used: true }).board;
  b = must(b, 'remove-powerup', { powerup: 'j' }).board;
  eq(b.powerups.map((x) => x.name), ['Gamble', 'Double Up'], 'removed');
  eq(team(b, 'a').used, {}, 'gone from the team too');
});

test('edit-powerup changes the name or icon, never to blank', () => {
  const b = must(board(), 'edit-powerup', { powerup: 'j', name: 'Wildcard', icon: '🌟' }).board;
  eq(b.powerups[0], { id: 'j', name: 'Wildcard', icon: '🌟' }, 'edited');
  eq(model.apply(board(), 'edit-powerup', { powerup: 'j', name: '   ' }), null, 'blank name');
  eq(model.apply(board(), 'edit-powerup', { powerup: 'j', icon: '' }), null, 'blank icon');
  eq(model.apply(board(), 'edit-powerup', { powerup: 'j' }), null, 'nothing to change');
});

test('powerups stop at the limit', () => {
  let b = board();
  for(let i = 0; i < MAX_POWERUPS; i++){
    const r = model.apply(b, 'add-powerup', { name: `P${i}` });
    if(r) b = r.board;
  }
  eq(b.powerups.length, MAX_POWERUPS, 'count');
});

// ---------------------------------------------------------------- teams
test('add-team cleans the name and picks a colour nobody has', () => {
  const r = must(board(), 'add-team', { name: '  The   Quizzards  ' });
  const t = r.board.teams[3];
  eq([t.name, t.score, t.used], ['The Quizzards', 0, {}], 'new team');
  eq(t.color, PALETTE[3], 'next free colour');
  eq(r.label, 'Added The Quizzards', 'label');
  eq(model.apply(board(), 'add-team', { name: '   ' }), null, 'blank name');
  eq(Array.from(must(board(), 'add-team', { name: 'x'.repeat(50) }).board.teams[3].name).length, NAME_MAX, 'name cut to the limit');
});

test('teams stop at the limit', () => {
  let b = board();
  for(let i = 0; i < MAX_TEAMS + 3; i++){
    const r = model.apply(b, 'add-team', { name: `T${i}` });
    if(r) b = r.board;
  }
  eq(b.teams.length, MAX_TEAMS, 'count');
});

test('rename-team, set-team-color and remove-team', () => {
  let b = must(board(), 'rename-team', { team: 'a', name: 'Brainiacs' }).board;
  eq(team(b, 'a').name, 'Brainiacs', 'renamed');
  eq(model.apply(b, 'rename-team', { team: 'a', name: '' }), null, 'blank name');
  b = must(b, 'set-team-color', { team: 'a', color: PALETTE[5] }).board;
  eq(team(b, 'a').color, PALETTE[5], 'colour');
  eq(model.apply(b, 'set-team-color', { team: 'a', color: 'red' }), null, 'colour must be from the palette');
  const r = must(b, 'remove-team', { team: 'a' });
  eq(r.board.teams.map((t) => t.id), ['b', 'c'], 'removed');
  eq(r.label, 'Removed Brainiacs', 'label');
});

test('names keep emoji whole', () => {
  const name = '🎄'.repeat(NAME_MAX + 5);
  const t = must(board(), 'add-team', { name }).board.teams[3];
  eq(Array.from(t.name).length, NAME_MAX, 'cut by characters');
  ok(!/[\uD800-\uDBFF]$/.test(t.name), 'no half emoji at the end');
});

// ---------------------------------------------------------------- the round
test('reset-round zeroes every score and gives every powerup back, keeping the teams', () => {
  let b = must(board([4, 7, 1]), 'set-powerup', { team: 'b', powerup: 'g', used: true }).board;
  const r = must(b, 'reset-round');
  ok(r.board.teams.every((t) => t.score === 0 && Object.keys(t.used).length === 0), 'reset');
  eq(r.board.teams.map((t) => t.name), ['Team A', 'Team B', 'Team C'], 'teams kept');
  eq(r.board.powerups.length, 2, 'powerups kept');
  eq(model.apply(board(), 'reset-round'), null, 'nothing to reset');
});

test('scores can be hidden, then shown or revealed', () => {
  eq(model.defaultBoard().scoresHidden, false, 'shown on a new board');
  const hidden = must(board([3, 1, 2]), 'hide-scores');
  eq([hidden.board.scoresHidden, hidden.label], [true, 'Scores hidden'], 'hidden');
  eq(model.apply(hidden.board, 'hide-scores'), null, 'hiding twice changes nothing');
  const shown = must(hidden.board, 'reveal-scores');
  eq([shown.board.scoresHidden, shown.label], [false, 'Scores revealed'], 'revealed');
  eq(must(hidden.board, 'show-scores').label, 'Scores shown', 'shown without a reveal');
  eq(model.apply(board(), 'reveal-scores'), null, 'nothing to reveal');
  eq(must(hidden.board, 'adjust-score', { team: 'a', amount: 2 }).board.scoresHidden, true, 'scoring keeps them hidden');
  eq(must(hidden.board, 'reset-round').board.scoresHidden, true, 'so does a reset');
});

test('sanitizeBoard keeps scoresHidden only when it is really true', () => {
  eq(model.sanitizeBoard({ ...board(), scoresHidden: true }).scoresHidden, true, 'true');
  eq(model.sanitizeBoard({ ...board(), scoresHidden: 'yes' }).scoresHidden, false, 'not a boolean');
  eq(model.sanitizeBoard(board()).scoresHidden, false, 'missing (a board saved by an older version)');
});

test('set-title allows a blank title', () => {
  eq(must(board(), 'set-title', { title: '  Pub   Quiz ' }).board.title, 'Pub Quiz', 'cleaned');
  eq(must(board(), 'set-title', { title: '' }).board.title, '', 'blank');
  eq(model.apply(board(), 'set-title', {}), null, 'missing');
});

test('apply refuses unknown actions, including ones the TV handles itself', () => {
  eq(model.apply(board(), 'format-disk', {}), null, 'unknown');
  eq(model.apply(board(), 'undo'), null, 'undo is not a board rule');
  eq(model.apply(board(), 'toString'), null, 'not a rule');
});

test('every action is either a board rule or handled by the TV', () => {
  const handledByTv = ['hello', 'undo'];
  eq([...model.RULE_NAMES].sort(), ACTIONS.filter((a) => !handledByTv.includes(a)).sort(), 'rules');
});

// ---------------------------------------------------------------- clean-up of stored or received boards
test('sanitizeBoard drops broken teams and powerups', () => {
  const raw = {
    title: 42,
    powerups: [{ id: 'j', name: 'Joker', icon: '🃏' }, { id: 'j', name: 'Again' }, { id: 'bad id!', name: 'X' }, { id: 'k', name: '' }, null],
    teams: [
      { id: 'a', name: 'A', color: 'purple', score: 3.5, used: { j: true, ghost: true } },
      { id: 'a', name: 'Duplicate' },
      { id: 'b', name: '   ' },
      'nonsense',
      { id: 'c', name: 'C', color: PALETTE[2], score: 9, used: { j: 'yes' } },
    ],
  };
  const b = model.sanitizeBoard(raw);
  eq(b.title, "Dan's Christmas Quiz 2026", 'title falls back to the default');
  eq(b.powerups.map((p) => p.id), ['j'], 'powerups');
  eq(b.teams.map((t) => t.id), ['a', 'c'], 'teams');
  eq(team(b, 'a').score, 0, 'non-whole score -> 0');
  eq(team(b, 'a').used, { j: true }, 'unknown powerups dropped from used');
  ok(PALETTE.includes(team(b, 'a').color), 'colour from the palette');
  eq(team(b, 'c').used, {}, 'used must be true');
});

test('sanitizeBoard refuses things that are not boards', () => {
  eq(model.sanitizeBoard(null), null, 'null');
  eq(model.sanitizeBoard('board'), null, 'text');
  eq(model.sanitizeBoard({ teams: [] }), null, 'no powerups list');
});

test('sanitizeBoard applies the limits', () => {
  const raw = board();
  raw.teams = Array.from({ length: MAX_TEAMS + 5 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, score: MAX_SCORE * 3 }));
  const b = model.sanitizeBoard(raw);
  eq(b.teams.length, MAX_TEAMS, 'team count');
  eq(b.teams[0].score, MAX_SCORE, 'score capped');
});

// ---------------------------------------------------------------- relay messages
test('parseCommand only accepts well-formed commands', () => {
  const good = { v: 1, from: 'abc', seq: 3, action: 'adjust-score', arg: { team: 'a', amount: 1 } };
  eq(parseCommand(JSON.stringify(good)), { from: 'abc', seq: 3, action: 'adjust-score', arg: { team: 'a', amount: 1 } }, 'good');
  eq(parseCommand(JSON.stringify({ ...good, v: 2 })), null, 'other version');
  eq(parseCommand(JSON.stringify({ ...good, action: 'format-disk' })), null, 'unknown action');
  eq(parseCommand(JSON.stringify({ ...good, seq: '3' })), null, 'seq not a number');
  eq(parseCommand(JSON.stringify({ ...good, from: 'x'.repeat(17) })), null, 'sender id too long');
  eq(parseCommand('not json'), null, 'not JSON');
  eq(parseCommand('x'.repeat(5000)), null, 'too long');
});

test('parseStatus cleans what the TV reports', () => {
  const s = parseStatus(JSON.stringify({
    v: 1, online: true, at: 5, board: board([1, 2, 3]), undo: 'U'.repeat(500),
    acks: { abc: { seq: 4, ok: true }, def: { seq: 7, ok: false }, old: 3, bad: { seq: 'x' }, ['y'.repeat(20)]: { seq: 2 } },
  }));
  eq(s.board.teams.map((t) => t.score), [1, 2, 3], 'board');
  eq(s.undo.length, 200, 'undo label cut');
  eq(s.acks, { abc: { seq: 4, ok: true }, def: { seq: 7, ok: false } }, 'acks');
  eq(parseStatus(JSON.stringify({ v: 1, online: false })), null, 'offline');
  eq(parseStatus(JSON.stringify({ v: 1, online: true, board: 'nope' })), null, 'no board');
  eq(parseStatus(JSON.stringify({ v: 1, online: true, board: board(), undo: '' })).undo, null, 'nothing to undo');
});

test('every Undo label survives the trip to the phone unchanged', () => {
  // The phone sends the label back to say what it means to undo, so the status must never cut one.
  const long = 'W'.repeat(NAME_MAX);
  let b = must(board(), 'rename-team', { team: 'a', name: long }).board;
  b = must(b, 'edit-powerup', { powerup: 'j', name: long }).board;
  const labels = [
    must(b, 'adjust-score', { team: 'a', amount: -MAX_ADJUST }).label,
    must(b, 'set-powerup', { team: 'a', powerup: 'j', used: true }).label,
    must(b, 'rename-team', { team: 'a', name: 'X'.repeat(NAME_MAX) }).label,
    must(b, 'edit-powerup', { powerup: 'j', name: 'Y'.repeat(NAME_MAX) }).label,
    must(b, 'add-team', { name: 'Z'.repeat(NAME_MAX) }).label,
  ];
  for(const label of labels){
    eq(parseStatus(JSON.stringify({ v: 1, online: true, board: b, undo: label })).undo, label, 'label');
  }
});

// ---------------------------------------------------------------- small helpers
test('ordinal and signed', () => {
  eq([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st'], 'ordinal');
  eq([5, -5, 0].map(signed), ['+5', '−5', '0'], 'signed');
});

// ---------------------------------------------------------------- report
const failed = results.filter((r) => !r.ok);
if(typeof document !== 'undefined'){
  const list = document.getElementById('results');
  for(const r of results){
    const li = document.createElement('li');
    li.className = r.ok ? 'pass' : 'fail';
    li.textContent = `${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`;
    list.append(li);
  }
  const summary = document.getElementById('summary');
  summary.textContent = `${results.length - failed.length} / ${results.length} passed`;
  summary.className = failed.length ? 'fail' : 'pass';
} else {
  for(const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
  console.log(`\n${results.length - failed.length} / ${results.length} passed`);
  if(failed.length) process.exitCode = 1;
}
