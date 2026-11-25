// The TV: shows the board, and runs every change a phone asks for.
//
// The TV is the only place the board lives. It is saved to this browser after every change, so a
// reload or a crash loses nothing. Phones send commands (display-remote.js), which come in through
// perform(), and get the whole board back in the TV's status. If the board is open twice in this
// browser, only one copy has the remote (one-board.js).
//
// Rendering rule: rows are created once per team and then only patched or moved. Recreating them
// would replay the entrance animation and lose the reorder glide, the score roll-up and the
// powerup flares.
import { STORAGE, UNDO_DEPTH, PALETTE, REVEAL_FADE_MS, REVEAL_FINALE_MS } from './config.js';
import { $, store, clamp, escapeHtml, setText, restartAnimation, confetti, fitStage } from './util.js';
import * as rules from './rules.js';
import { initDisplayRemote } from './display-remote.js';
import { oneBoard } from './one-board.js';

let board = rules.sanitizeBoard(store.getJSON(STORAGE.board)) ?? rules.defaultBoard();
const undoStack = [];    // [{ board, label }], newest last: the board as it was before each change
let finale = false;      // the reveal has just ended: the winner's moment is drawn before the standings

// ================================================================ the one way in

// Every change, from whichever phone, goes through here. -> true if the board changed.
// Undo names the change it means to undo, so it never undoes a different one that got in first.
function perform(action, arg){
  if(action === 'undo'){
    const last = undoStack.at(-1);
    if(!last || (typeof arg?.label === 'string' && arg.label !== last.label)) return false;
    undoStack.pop();
    board = last.board;
  } else {
    const result = rules.apply(board, action, arg);
    if(!result) return false;
    undoStack.push({ board, label: result.label });
    if(undoStack.length > UNDO_DEPTH) undoStack.shift();
    board = result.board;
  }
  store.setJSON(STORAGE.board, board);
  // The Next that ends the reveal starts the winner's moment. Other changes before it is drawn (a powerup,
  // say) leave it be; only going back to hidden scores calls it off.
  if(action === 'reveal-next' && !board.scoresHidden) finale = true;
  else if(board.scoresHidden) finale = false;
  render();
  return true;
}

// What the phones are told: the whole board, and what Undo would undo.
const statusForPhone = () => ({ board, undo: undoStack.at(-1)?.label ?? null });

const remote = initDisplayRemote({ perform, getStatus: statusForPhone });

// ================================================================ drawing

const boardEl = $('board');
const MEDALS = { 1: '👑', 2: '🥈', 3: '🥉' };

// How the board is drawn, which follows from the board itself:
//   'hidden'   the scores are hidden: setup order, and "?" for every place and score
//   'reveal'   part-way through the reveal: the final order, with the places still to come as empty slots
//   'finale'   the reveal has just ended: every place and score, but no bars, gaps or glow for a moment
//   'scores'   the standings
// `drawn` is the one on screen, or 'emptied' while the "?" rows empty before the first place of a reveal.
// Because the reveal is drawn from the board, Undo, a reload or a second phone all leave the TV showing
// exactly the places revealed so far.
let drawn = null;
let moment = 0;          // while a moment of the reveal plays, changes are saved and sent but drawn when it ends
const viewOf = (b) => (b.scoresHidden ? (b.revealed.length ? 'reveal' : 'hidden') : finale ? 'finale' : 'scores');

function render(){
  if(moment) return;
  const view = viewOf(board);
  document.title = board.title || "Dan's Quiz Leaderboard";
  setText($('title'), board.title);
  $('tagline').hidden = view === 'scores';    // stays through the winner's moment, so the board does not resize then
  setText($('hiddenChip'), view === 'hidden' ? '🙈 Scores hidden until the reveal' : '🥁 Revealing the scores');
  setText($('boardLabel'), view === 'hidden' ? 'Teams' : 'Standings');

  if(drawn === 'hidden' && (view === 'reveal' || view === 'finale')){
    // The first place of a reveal: the rows empty first, so no team is seen moving to its place.
    boardEl.classList.add('revealing');
    for(const row of boardEl.children) row.classList.add('veiled');
    drawn = 'emptied';
    playMoment(REVEAL_FADE_MS);
    return;
  }
  renderBoard(view);
  drawn = view;
  if(view === 'finale'){ finale = false; playMoment(REVEAL_FINALE_MS); }
}

// Nothing more is drawn until the moment ends, and then the board as it is by then.
function playMoment(ms){
  moment = setTimeout(() => { moment = 0; render(); }, ms);
}

// Views in which every team can be seen. Rows glide to a new place only from one of these to another:
// a hidden team seen moving would give its place away.
const IN_VIEW = new Set(['hidden', 'finale', 'scores']);

function renderBoard(view){
  // While the scores are hidden the rows keep their setup order, which gives nothing away.
  const teams = view === 'hidden' ? board.teams : rules.ranked(board);
  const info = rules.rankInfo(teams);
  const maxScore = Math.max(1, ...teams.map((t) => t.score));
  // which powerups there are, so the badges are rebuilt (without flares) when one is added, removed or edited
  const powerKey = board.powerups.map((p) => `${p.id}:${p.icon}:${p.name}`).join('|');

  $('emptyNote').hidden = teams.length > 0;
  boardEl.classList.toggle('many-powerups', board.powerups.length > 5);
  boardEl.classList.toggle('scores-hidden', view === 'hidden');
  boardEl.classList.toggle('revealing', view === 'reveal' || view === 'finale');

  // where every row is now (before any is removed), so the ones that move can glide to their new place
  const firstPaint = boardEl.children.length === 0;
  const before = new Map();
  for(const row of boardEl.children){
    const r = row.getBoundingClientRect();
    before.set(row.dataset.team, { row, x: r.left, y: r.top });
  }
  for(const [id, { row }] of before){
    if(!teams.some((t) => t.id === id)) row.remove();
  }

  let crowned = false;
  teams.forEach((team, i) => {
    let row = before.get(team.id)?.row;
    if(!row){
      row = createRow(team);
      if(firstPaint) row.style.animationDelay = `${i * 0.05}s`;
    }
    placeRow(row, i);
    const revealed = patchRow(row, team, info, maxScore, powerKey, view);
    // the winner's moment: a gold pulse, and confetti
    if(revealed && view === 'finale' && !info.allLevel && info.rankOf[team.id] === 1){
      playOnce(row, 'fx-crowned', 1800, []);
      crowned = true;
    }
  });
  if(crowned) celebrate();

  // A switch between one and two columns moves every row: that is not a change in the standings.
  if(!applyColumns() && IN_VIEW.has(drawn) && IN_VIEW.has(view)) playReorder(before);
}

function placeRow(row, i){
  if(boardEl.children[i] !== row) boardEl.insertBefore(row, boardEl.children[i] ?? null);
}

function createRow(team){
  const row = document.createElement('div');
  row.className = 'row entering';
  row.dataset.team = team.id;
  row.innerHTML = '<div class="rank"></div>'
    + '<div class="row-main"><div class="row-name"></div><div class="bar-track"><div class="bar-fill"></div></div></div>'
    + '<div class="badges"></div>'
    + '<div class="gap-wrap"></div>'
    + `<div class="score">${board.scoresHidden ? '?' : team.score}</div>`;
  row._score = team.score;            // the score the row is showing (or hiding), for the roll-up
  setTimeout(() => { row.classList.remove('entering'); row.style.animationDelay = ''; }, 1600);
  return row;
}

// -> true if the row has just been revealed
function patchRow(row, team, info, maxScore, powerKey, view){
  setText(row.querySelector('.row-name'), team.name);
  const fill = row.querySelector('.bar-fill');
  fill.style.backgroundColor = team.color;
  syncBadges(row.querySelector('.badges'), team, powerKey);
  const scoreEl = row.querySelector('.score');
  const veiled = view === 'reveal' && !board.revealed.includes(team.id);
  const revealed = row.classList.contains('veiled') && !veiled;
  row.classList.toggle('veiled', veiled);

  // Hidden, or not revealed yet: no rank, bar, gaps, score or flash, so nothing on the row gives the
  // standings away.
  if(view === 'hidden' || veiled){
    row.classList.remove('is-leader');
    setRank(row, '?');
    fill.style.width = '0%';
    setGaps(row, '');
    stopCount(scoreEl);
    setText(scoreEl, '?');
    row._score = team.score;
    return false;
  }

  // Part-way through the reveal, and in the winner's moment, the places and scores show, but the bars,
  // the gaps and the leader's glow wait for the end, because they would give the order away.
  const standings = view === 'scores';
  row.classList.toggle('is-leader', standings && !info.allLevel && info.rankOf[team.id] === 1);
  setRank(row, placeText(team, info));
  fill.style.width = standings ? `${barPct(team.score, maxScore)}%` : '0%';
  setGaps(row, standings ? gapChipsHtml(team, info) : '');

  const prev = row._score;
  row._score = team.score;
  if(revealed){
    animateNumber(scoreEl, 0, team.score);        // a revealed score counts up from 0
  } else if(prev !== team.score){
    // points won: a confident pulse and a green wash. Points lost: a rattle and a red wash.
    animateNumber(scoreEl, prev, team.score);
    restartAnimation(scoreEl, 'pop');
    playOnce(row, team.score > prev ? 'fx-gain' : 'fx-loss', 1000, ['fx-gain', 'fx-loss']);
  } else if(scoreEl.textContent === '?'){
    scoreEl.textContent = String(team.score);     // shown straight away (Show now), or after a reload
  }
  return revealed;
}

// 👑, 🥈 or 🥉 for the podium, the number below it, and "–" before the first point, when everyone is
// level and nobody gets a crown.
function placeText(team, info){
  const rank = info.rankOf[team.id];
  return info.allLevel ? '–' : MEDALS[rank] ?? String(rank);
}
function setRank(row, text){
  const el = row.querySelector('.rank');
  el.classList.toggle('medal', Object.values(MEDALS).includes(text));
  setText(el, text);
}
function setGaps(row, html){
  const el = row.querySelector('.gap-wrap');
  if(el.innerHTML !== html) el.innerHTML = html;
}

function barPct(score, maxScore){
  return clamp((Math.max(score, 0) / maxScore) * 100, score > 0 ? 3 : 0, 100);
}

// The leader: how far clear ("+4 ahead"). Everyone else: who they are chasing and by how much, as
// "12 behind Team Beta" for the leader, then "3 behind Team Delta" for the team just above when that
// is not the leader anyway. Nothing at all while everyone is level.
function gapChipsHtml(team, info){
  if(info.allLevel) return '';
  const g = rules.gaps(team, info);
  if(g.leader) return g.ahead !== null ? `<span class="gap-chip lead">+${g.ahead} ahead</span>` : '';
  return behindChip(g.toFirst, g.first, '') + (g.next ? behindChip(g.toNext, g.next, ' sub') : '');
}
// Several teams on that score: the first is named, with how many more ("Team Beta +1").
function behindChip(points, group, cls){
  const who = group.teams[0].name + (group.teams.length > 1 ? ` +${group.teams.length - 1}` : '');
  return `<span class="gap-chip behind${cls}"><b>${points}</b>&nbsp;behind&nbsp;<span class="gap-who">${escapeHtml(who)}</span></span>`;
}

// A team's powerup strip. Does nothing unless something changed, and then only the badges that
// flipped get the used/given-back flare.
function syncBadges(wrap, team, powerKey){
  const sig = board.powerups.map((p) => (team.used[p.id] ? '0' : '1')).join('');
  if(wrap.dataset.key !== powerKey){
    wrap.innerHTML = board.powerups.map((p) => `<span class="badge${team.used[p.id] ? ' used' : ''}" title="${escapeHtml(p.name)}">`
      + `<span class="ic">${escapeHtml(p.icon)}</span></span>`).join('');
    wrap.dataset.key = powerKey;
    wrap.dataset.sig = sig;
    return;
  }
  const prev = wrap.dataset.sig;
  if(prev === sig) return;
  wrap.dataset.sig = sig;
  [...wrap.children].forEach((badge, i) => {
    if(prev[i] === sig[i]) return;
    const used = sig[i] === '0';
    badge.classList.toggle('used', used);
    playOnce(badge, used ? 'fx-used' : 'fx-restored', 900, ['fx-used', 'fx-restored']);
  });
}

// Play an animation that a class starts, from the beginning, then take the class off again.
// `rivals` are the classes it takes over from (a gain cuts short a loss that is still playing).
function playOnce(el, cls, ms, rivals){
  el.classList.remove(...rivals);
  restartAnimation(el, cls);
  clearTimeout(el._fxTimer);
  el._fxTimer = setTimeout(() => el.classList.remove(cls), ms);
}

// Count from one score to the next through every whole number in between (7, 8, 9, 10), which
// reads as points being awarded rather than a number changing. Big jumps tick faster so a +50 never
// outlasts the moment, and a newer change always takes over from an older one.
function animateNumber(el, from, to){
  const token = stopCount(el);
  // a hidden page gets no animation frames, so the count would stop part-way: just show the result
  if(from === to || document.hidden){ el.textContent = String(to); return; }
  const steps = Math.abs(to - from);
  const dir = Math.sign(to - from);
  const interval = Math.min(55, 1100 / steps);     // ms per point, the whole count within about a second
  let start = null;
  function step(ts){
    if(el._countToken !== token) return;
    start ??= ts;
    const done = Math.min(steps, Math.floor((ts - start) / interval));
    el.textContent = String(from + dir * done);
    if(done < steps) requestAnimationFrame(step);
  }
  el.textContent = String(from);
  requestAnimationFrame(step);
}
// Stops any count running on el. -> the token for a new one.
const stopCount = (el) => (el._countToken = (el._countToken || 0) + 1);

// FLIP: each row that moved is put back where it was, then glides to its new place (in two
// columns that can be sideways too). Positions are measured on screen, so they are divided by
// the stage's scale.
function playReorder(before){
  const moved = [];
  const scale = stageFit.scale();
  for(const row of boardEl.children){
    const was = before.get(row.dataset.team);
    if(!was) continue;                             // a new row fades in instead
    const now = row.getBoundingClientRect();
    const dx = (was.x - now.left) / scale;
    const dy = (was.y - now.top) / scale;
    if(Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    row.style.animation = 'none';                  // its own pulse would fight the glide (the wash still shows)
    row.style.transition = 'none';
    row.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(row);
  }
  if(!moved.length) return;
  void boardEl.offsetHeight;                       // commit the starting positions
  requestAnimationFrame(() => {
    for(const row of moved){
      const token = row._glide = (row._glide || 0) + 1;
      row.style.transition = 'transform .6s cubic-bezier(.2,.7,.3,1)';
      row.style.transform = '';
      setTimeout(() => { if(row._glide === token) row.style.transition = ''; }, 650);
      // after the gain/loss class has gone, so its pulse does not start late
      setTimeout(() => { if(row._glide === token) row.style.animation = ''; }, 1050);
    }
  });
}

// Confetti over the whole screen for the winner: the confetti from util.js, in the board's colours.
const CONFETTI_COLOURS = ['#F5B400', '#FFFFFF', ...PALETTE];
const celebrate = () => confetti($('confettiLayer'), CONFETTI_COLOURS);

// ================================================================ fitting the screen

// One column, unless two would make the board noticeably bigger on this screen (many teams on a
// wide screen). Worked out from the design sizes in display.css (stage 1100 or 2040 wide and at least
// 720 tall; title about 86, plus 44 for the "Scores hidden" line; card edges about 68, and 72 per row),
// so it does not depend on the current layout.
let columns = 1;
function chooseColumns(){
  const n = board.teams.length;
  if(n < 6) return 1;
  const app = $('app');
  const head = 86 + ($('tagline').hidden ? 0 : 44);
  const height = (rows) => Math.max(720, head + 68 + rows * 72);
  const one = Math.min(app.clientWidth / 1100, app.clientHeight / height(n));
  const two = Math.min(app.clientWidth / 2040, app.clientHeight / height(Math.ceil(n / 2)));
  return two > one * 1.1 ? 2 : 1;
}
// -> true if the number of columns changed
function applyColumns(){
  const next = chooseColumns();
  const changed = next !== columns;
  columns = next;
  $('stage').classList.toggle('two-col', columns === 2);
  boardEl.classList.toggle('two-col', columns === 2);
  boardEl.style.setProperty('--rows', String(Math.max(1, Math.ceil(board.teams.length / columns))));
  return changed;
}

// ================================================================ only one copy has the remote

// This copy has the remote: at the start, or taking over from another copy of the board. That copy
// may have changed the board meanwhile, so the saved one is used, and Undo starts afresh if it differs.
function takeRemote(){
  const saved = rules.sanitizeBoard(store.getJSON(STORAGE.board));
  if(saved && JSON.stringify(saved) !== JSON.stringify(board)){
    board = saved;
    undoStack.length = 0;
  }
  $('paused').hidden = true;
  render();
  remote.start();
}
// Another copy has the remote: this one stops listening and says so, until "Use this window instead".
function pause(){
  remote.stop();
  $('paused').hidden = false;
}

// ================================================================ start

window.addEventListener('resize', () => applyColumns());
render();
// The stage is laid out at a fixed size and scaled to fit the screen, whatever its shape (util.js). After the
// first drawing, so the first fit is the right one. (Nothing before it moves rows, which needs the scale.)
const stageFit = fitStage($('app'), $('stage'), 24);
const copies = oneBoard({ onActive: takeRemote, onPaused: pause });
$('pausedTake').addEventListener('click', () => copies.claim());
