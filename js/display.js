// The TV: shows the board, and runs every change a phone asks for.
//
// The TV is the only place the board lives. It is saved to this browser after every change, so a
// reload or a crash loses nothing. Phones send commands (display-remote.js) and get the whole board
// back in the TV's status. If the board is open twice in this browser, only one copy has the remote
// (one-board.js).
//
// Rendering rule: rows are created once per team and then only patched or moved. Recreating them
// would replay the entrance animation and lose the reorder glide, the score roll-up and the
// powerup flares.
import {
  STORAGE, UNDO_DEPTH, PALETTE, REVEAL_STEP_MS, REVEAL_QUICK_MS, REVEAL_PODIUM_MS, REVEAL_WINNER_MS,
} from './config.js';
import { $, store, clamp, escapeHtml, ordinal, setText, restartAnimation } from './util.js';
import * as model from './model.js';
import { initDisplayRemote } from './display-remote.js';
import { oneBoard } from './one-board.js';

let board = model.sanitizeBoard(store.getJSON(STORAGE.board)) ?? model.defaultBoard();
const undoStack = [];    // [{ board, label }], newest last: the board as it was before each change
let revealing = false;   // while the reveal plays, changes are saved and sent to phones but drawn afterwards

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
    const result = model.apply(board, action, arg);
    if(!result) return false;
    undoStack.push({ board, label: result.label });
    if(undoStack.length > UNDO_DEPTH) undoStack.shift();
    board = result.board;
  }
  store.setJSON(STORAGE.board, board);
  if(action === 'reveal-scores') playReveal(); else render();
  return true;
}

// What the phones are told: the whole board, and what Undo would undo.
const statusForPhone = () => ({ board, undo: undoStack.at(-1)?.label ?? null });

const remote = initDisplayRemote({ perform, getStatus: statusForPhone });

// ================================================================ drawing

const boardEl = $('board');
const MEDALS = { 1: '👑', 2: '🥈', 3: '🥉' };
const rowOf = (teamId) => [...boardEl.children].find((row) => row.dataset.team === teamId);

function render(){
  remote.publishStatus();
  if(revealing) return;                // drawn when the reveal ends
  document.title = board.title || 'Scoreboard';
  setText($('title'), board.title);
  $('tagline').hidden = !board.scoresHidden;
  setText($('boardLabel'), board.scoresHidden ? 'Teams' : 'Standings');
  renderBoard();
  scheduleFit();
}

function renderBoard(){
  // While the scores are hidden the rows keep their setup order, which gives nothing away.
  const teams = board.scoresHidden ? board.teams : model.ranked(board);
  const info = model.rankInfo(teams);
  const maxScore = Math.max(1, ...teams.map((t) => t.score));
  // which powerups there are, so the badges are rebuilt (without flares) when one is added, removed or edited
  const powerKey = board.powerups.map((p) => `${p.id}:${p.icon}:${p.name}`).join('|');

  $('emptyNote').hidden = teams.length > 0;
  boardEl.classList.toggle('many-powerups', board.powerups.length > 5);
  boardEl.classList.toggle('scores-hidden', board.scoresHidden);

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

  teams.forEach((team, i) => {
    let row = before.get(team.id)?.row;
    if(!row){
      row = createRow(team);
      if(firstPaint) row.style.animationDelay = `${i * 0.05}s`;
    }
    placeRow(row, i);
    patchRow(row, team, info, maxScore, powerKey);
  });

  // a switch between one and two columns moves every row: that is not a change in the standings
  if(!applyColumns()) playReorder(before);
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

function patchRow(row, team, info, maxScore, powerKey){
  setText(row.querySelector('.row-name'), team.name);
  const fill = row.querySelector('.bar-fill');
  fill.style.backgroundColor = team.color;
  syncBadges(row.querySelector('.badges'), team, powerKey);
  const scoreEl = row.querySelector('.score');

  // Hidden: no rank, bar, gaps, score or flash, so nothing on the row gives the standings away.
  if(board.scoresHidden){
    row.classList.remove('is-leader');
    setRank(row, '?');
    fill.style.width = '0%';
    setGaps(row, '');
    stopCount(scoreEl);
    setText(scoreEl, '?');
    row._score = team.score;
    return;
  }

  // before the first point everybody is level, so nobody gets a crown
  const rank = info.rankOf[team.id];
  row.classList.toggle('is-leader', !info.allLevel && rank === 1);
  setRank(row, info.allLevel ? '–' : MEDALS[rank] ?? String(rank));
  fill.style.width = `${barPct(team.score, maxScore)}%`;
  setGaps(row, gapChipsHtml(team, info));

  // points won: a confident pulse and a green wash. Points lost: a rattle and a red wash.
  const prev = row._score;
  if(prev !== team.score){
    animateNumber(scoreEl, prev, team.score);
    restartAnimation(scoreEl, 'pop');
    playOnce(row, team.score > prev ? 'fx-gain' : 'fx-loss', 1000, ['fx-gain', 'fx-loss']);
    row._score = team.score;
  } else if(scoreEl.textContent === '?'){
    scoreEl.textContent = String(team.score);     // shown again without a reveal
  }
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

// Leader: "Leader" (or "Tied 1st") and how far clear. Everyone else: who they are chasing and by how
// much, as "12 behind Team Beta (Leader)", then "3 behind Team Delta (2nd)" for the team just above
// when that is not the leader anyway. Nothing at all while everyone is level.
function gapChipsHtml(team, info){
  if(info.allLevel) return '';
  const g = model.gaps(team, info);
  if(g.leader){
    return `<span class="gap-chip lead">${info.tiedAtTop > 1 ? 'Tied 1st' : 'Leader'}</span>`
      + (g.ahead !== null ? `<span class="gap-chip sub">+${g.ahead} ahead</span>` : '');
  }
  return behindChip(g.toFirst, g.first, info.tiedAtTop > 1 ? 'Leaders' : 'Leader', '')
    + (g.next ? behindChip(g.toNext, g.next, `${g.next.teams.length > 1 ? '=' : ''}${ordinal(g.next.rank)}`, ' sub') : '');
}
// Several teams on the score just above: the first is named, with how many more ("Team Beta +1").
function behindChip(points, group, place, cls){
  const who = group.teams[0].name + (group.teams.length > 1 ? ` +${group.teams.length - 1}` : '');
  return `<span class="gap-chip behind${cls}"><b>${points}</b>&nbsp;behind&nbsp;`
    + `<span class="gap-who">${escapeHtml(who)}</span>&nbsp;(${place})</span>`;
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
  for(const row of boardEl.children){
    const was = before.get(row.dataset.team);
    if(!was) continue;                             // a new row fades in instead
    const now = row.getBoundingClientRect();
    const dx = (was.x - now.left) / fitScale;
    const dy = (was.y - now.top) / fitScale;
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

// ================================================================ the reveal

// The final reveal, after the scores were hidden. The rows fade out, take their final order out of
// sight, then come back from last place up, each score counting up from 0, with longer pauses for
// the podium and confetti for the winner. The bars, the gaps and the leader's glow come last, because
// they would give the order away. Teams on the same score appear together.
async function playReveal(){
  revealing = true;
  remote.publishStatus();
  $('tagline').hidden = true;
  setText($('boardLabel'), 'Standings');
  boardEl.classList.remove('scores-hidden');
  boardEl.classList.add('revealing');
  for(const row of boardEl.children) row.classList.add('veiled');
  await sleep(650);

  const teams = model.ranked(board);
  const info = model.rankInfo(teams);
  teams.forEach((team, i) => {
    const row = rowOf(team.id) ?? createRow(team);
    placeRow(row, i);
    row.classList.add('veiled');
    row.classList.remove('is-leader');
    const rank = info.rankOf[team.id];
    setRank(row, info.allLevel ? '–' : MEDALS[rank] ?? String(rank));
    setText(row.querySelector('.score'), '0');
  });
  applyColumns();
  fitStage();

  const ranks = [...new Set(teams.map((t) => info.rankOf[t.id]))].sort((a, b) => b - a);
  for(const rank of ranks){
    await sleep(rank === 1 ? REVEAL_WINNER_MS : rank <= 3 ? REVEAL_PODIUM_MS : ranks.length > 8 ? REVEAL_QUICK_MS : REVEAL_STEP_MS);
    if(board.scoresHidden) break;      // undone part-way: the scores go back into hiding
    for(const team of teams.filter((t) => info.rankOf[t.id] === rank)){
      const row = rowOf(team.id);
      if(!row) continue;
      row.classList.remove('veiled');
      animateNumber(row.querySelector('.score'), 0, team.score);
      row._score = team.score;
      if(rank === 1 && !info.allLevel) playOnce(row, 'fx-crowned', 1800, []);
    }
    if(rank === 1 && !info.allLevel) confetti();
  }
  if(!board.scoresHidden) await sleep(1400);

  revealing = false;
  boardEl.classList.remove('revealing');
  render();                            // bars, gaps and the leader's glow, and anything that changed meanwhile
  for(const row of boardEl.children) row.classList.remove('veiled');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Confetti over the whole screen for the winner (none for anyone who asks their device for less motion).
function confetti(){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = $('confetti');
  const colours = ['#F5B400', '#FFFFFF', ...PALETTE];
  const wave = () => {
    for(let i = 0; i < 120; i++){
      const piece = document.createElement('i');
      const size = 6 + Math.random() * 8;
      piece.className = 'confetti';
      piece.style.cssText = `left:${Math.random() * 100}%; width:${size}px; height:${size * 1.4}px;`
        + ` background:${colours[i % colours.length]}; --drift:${Math.random() * 160 - 80}px;`
        + ` animation-duration:${2.4 + Math.random() * 2.4}s; animation-delay:${Math.random() * 1.4}s;`;
      layer.append(piece);
    }
  };
  layer.replaceChildren();
  wave();
  setTimeout(wave, 650);
  setTimeout(() => layer.replaceChildren(), 6500);
}

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
  const head = 86 + (board.scoresHidden ? 44 : 0);
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

// The stage is laid out at a fixed size and scaled to fit the screen, whatever its shape.
let fitScale = 1;
function fitStage(){
  const app = $('app'), stage = $('stage');
  const w = stage.offsetWidth, h = stage.offsetHeight;
  if(!w || !h) return;
  const margin = Math.max(24, Math.round(Math.min(app.clientWidth, app.clientHeight) * 0.045));
  fitScale = clamp(Math.min((app.clientWidth - 2 * margin) / w, (app.clientHeight - 2 * margin) / h), 0.15, 2.6);
  stage.style.transform = `translate(-50%, -50%) scale(${fitScale})`;
}
let fitQueued = false;
function scheduleFit(){
  if(fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitStage(); });
}

// ================================================================ only one copy has the remote

// This copy has the remote: at the start, or taking over from another copy of the board. That copy
// may have changed the board meanwhile, so the saved one is used, and Undo starts afresh if it differs.
function takeRemote(){
  const saved = model.sanitizeBoard(store.getJSON(STORAGE.board));
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

window.addEventListener('resize', () => { applyColumns(); scheduleFit(); });
document.fonts?.ready.then(scheduleFit);
render();
fitStage();
const copies = oneBoard({ onActive: takeRemote, onPaused: pause });
$('pausedTake').addEventListener('click', () => copies.claim());
