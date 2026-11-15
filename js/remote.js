// The phone remote (the Quiz Admin Panel): the host runs the board from here. Every tap is sent to the
// board (the TV) as a command, and the board's status brings back the whole scoreboard, which is what
// this page draws.
//
// Every team fits on one screen, each with its own − / + for the points per tap. Tapping a team's name
// opens its sheet: more amounts, a custom amount and its powerups. A score or powerup tap shows at once,
// marked as pending, until the board confirms it (its status carries the last command it handled from
// this phone, and whether that changed anything). Anything not confirmed within a few seconds is
// reported, so the host never has to wonder whether a tap landed.
import {
  STORAGE, PALETTE, MAX_TEAMS, MAX_POWERUPS, MAX_ADJUST, NAME_MAX, TITLE_MAX,
  CONFIRM_TIMEOUT_MS, PING_AFTER_MS, GONE_AFTER_MS, DEFAULT_STEP, SHEET_AMOUNTS,
} from './config.js';
import {
  $, store, escapeHtml, signed, ordinal, setText, normaliseCode, isValidCode, randomId, restartAnimation, armConfirm,
} from './util.js';
import { rankInfo, nextReveal, isRevealing, lockedByReveal, cleanText, cleanIcon } from './model.js';
import { openRelay, manageConnection } from './relay.js';

const SESSION = randomId(); // which phone sent a command
let seq = 0;              // numbers this phone's commands, so the board can confirm them
let relay = null;
let code = '';
let connectingSince = 0;
let hadRelay = false;     // to say hello when the first relay connects
let pingedAt = 0;         // when this phone last asked a quiet board whether it is still there
let board = null;         // the last board reported (kept on screen, greyed out, if the board drops out)
let pending = [];         // score and powerup taps not confirmed yet: { seq, at, label, team, amount | powerup, used }
let lastSent = null;      // { seq, label, at, ackedAt }: the latest tap, for the feedback line
let note = null;          // { text, kind, until }: a message that takes over the feedback line for a moment
let sheetTeam = null;     // the team whose sheet is open
let swatchesFor = null;   // the team whose colour swatches are open in Setup

// A number of points typed in (the custom amount, or the points per tap): a whole number from 1 to
// MAX_ADJUST, or 0 if it is not one. Phone number pads often have no minus key, so a sign is ignored.
const points = (value) => {
  const n = Math.abs(Math.round(Number(value)));
  return n >= 1 && n <= MAX_ADJUST ? n : 0;
};
// Points per tap on each team's − / + buttons: a setting of this phone, changed in Setup.
let step = points(store.get(STORAGE.step)) || DEFAULT_STEP;

// After the phone wakes, it connects again exactly as it did the first time.
const connection = manageConnection({ isLinked: () => !!relay, reconnect: () => { if(relay) connect(code); } });
const findTeam = (id) => board?.teams.find((t) => t.id === id);
const findPowerup = (id) => board?.powerups.find((p) => p.id === id);

// ================================================================ connecting

function connect(newCode){
  if(newCode !== code){ board = null; pending = []; lastSent = null; }
  code = newCode;
  store.set(STORAGE.remoteCode, code);
  history.replaceState(null, '', `remote.html?code=${code}`);
  $('rmPair').hidden = true;
  $('rmPad').hidden = false;
  relay?.stop(false);
  connectingSince = Date.now();
  hadRelay = false;
  relay = openRelay({ role: 'remote', code, onChange: onRelayChange });
  relay.start();
  send('hello');          // reaches a board in this same browser at once; the relays get theirs when they connect
  render();
  connection.requestWake();
}

function onRelayChange(){
  const connected = !!relay && relay.connectedCount() > 0;
  if(connected && !hadRelay) send('hello');   // closes the pairing dialog on the TV
  hadRelay = connected;
  render();
}

function showPairing(prefill){
  $('rmPad').hidden = true;
  closeSetup();
  closeTeam();
  $('rmPair').hidden = false;
  $('rmCodeInput').value = prefill;
  relay?.stop(false);
  relay = null;
  connection.releaseWake();
  render();
}

function submitCode(){
  const c = normaliseCode($('rmCodeInput').value);
  if(isValidCode(c)) connect(c); else $('rmCodeInput').focus();
}

// ================================================================ sending and confirming

// label: what the feedback line calls it. track: shown on the team as pending until confirmed.
// -> true if it went out on at least one link
function send(action, arg, { label, track } = {}){
  const command = { from: SESSION, seq: ++seq, action };
  if(arg !== undefined) command.arg = arg;
  const count = relay ? relay.send(command) : 0;
  if(!label) return count > 0;
  if(count === 0){
    showNote('Not connected, so that was not sent', 'bad');
    navigator.vibrate?.([40, 40, 40]);
    render();
    return false;
  }
  navigator.vibrate?.(12);
  const now = Date.now();
  lastSent = { seq: command.seq, label, at: now, ackedAt: 0 };
  if(track) pending.push({ seq: command.seq, at: now, label, ...track });
  note = null;
  render();
  return true;
}

const showNote = (text, kind = '') => { note = { text, kind, until: Date.now() + 4500 }; };

// The board's latest status, or null if it is offline or has stopped answering.
function currentStatus(){
  const status = relay?.latestStatus() ?? null;
  if(!status) return null;
  return Date.now() - relay.lastHeard() > PING_AFTER_MS + GONE_AFTER_MS ? null : status;
}
// Gone quiet? Ask. A board that is still open always answers a hello at once, even from a
// background tab whose own timers are slowed down.
function checkBoardIsThere(){
  if(!relay?.latestStatus()) return;
  const now = Date.now();
  if(now - relay.lastHeard() > PING_AFTER_MS && now - pingedAt > PING_AFTER_MS){
    pingedAt = now;
    send('hello');
  }
}
const ackedSeq = () => currentStatus()?.acks[SESSION]?.seq ?? 0;

// A box or dot the host just changed keeps showing their change until the board confirms it,
// rather than flicking back to the old value for a moment.
const hold = (el) => { el._hold = { seq, at: Date.now() }; };
const isHeld = (el) => !!el._hold && el._hold.seq > ackedSeq() && Date.now() - el._hold.at < CONFIRM_TIMEOUT_MS;

// Clear what the board has confirmed, and report what it did not do, or has not confirmed in time.
function settle(status){
  const ack = status?.acks[SESSION];
  const acked = ack?.seq ?? 0;
  const now = Date.now();
  if(lastSent && !lastSent.ackedAt && lastSent.seq <= acked){
    lastSent.ackedAt = now;
    if(ack.seq === lastSent.seq && !ack.ok){
      showNote(`No change on the board: ${lastSent.label}`, 'bad');
      lastSent = null;
    }
  }
  const isLate = (p) => p.seq > acked && now - p.at > CONFIRM_TIMEOUT_MS;
  const late = pending.filter(isLate);
  pending = pending.filter((p) => p.seq > acked && !isLate(p));
  if(lastSent && !lastSent.ackedAt && isLate(lastSent)){ late.push(lastSent); lastSent = null; }
  if(late.length) showNote(`Not confirmed by the board: ${late.at(-1).label}. Check the TV.`, 'bad');
}

// What the phone shows: the board's score plus this phone's taps that are still on their way.
const pendingDelta = (teamId) => pending.reduce((sum, p) => sum + (p.team === teamId && p.amount ? p.amount : 0), 0);
function shownUsed(team, powerupId){
  const p = pending.findLast((x) => x.team === team.id && x.powerup === powerupId);
  return p ? { used: p.used, pending: true } : { used: !!team.used[powerupId], pending: false };
}

function adjust(team, amount, btn){
  if(btn) restartAnimation(btn, 'sent');
  send('adjust-score', { team: team.id, amount }, { label: `${signed(amount)} ${team.name}`, track: { team: team.id, amount } });
}

function togglePowerup(team, powerupId){
  const powerup = findPowerup(powerupId);
  if(!powerup) return;
  const used = !shownUsed(team, powerupId).used;
  send('set-powerup', { team: team.id, powerup: powerupId, used }, {
    label: `${powerup.name} ${used ? 'used' : 'given back'}: ${team.name}`,
    track: { team: team.id, powerup: powerupId, used },
  });
}

// ================================================================ drawing

function render(){
  const status = currentStatus();
  if(status) board = status.board;
  settle(status);
  const live = !!status;
  const state = connectionState(status);
  $('rmStatus').className = `rm-status ${state.kind}`;
  setText($('rmStatusText'), state.text);
  fitTitle(state.text);
  renderReveal(live);
  renderTeams(live);
  renderUndo(status);
  renderTeamSheet(live);
  renderSetup(live);
  renderFeedback(state.hint);
}

// The pill in the header, and (as `hint`) why the controls are greyed out.
function connectionState(status){
  if(!relay) return { kind: 'warn', text: 'Enter a room code', hint: '' };
  if(status) return { kind: 'ok', text: 'Board connected', hint: '' };
  if(relay.failed && !relay.connectedCount()){
    return { kind: 'bad', text: 'Could not load the connection', hint: 'Could not load the connection library. Reload this page.' };
  }
  if(!relay.connectedCount()){
    return Date.now() - connectingSince > 8000
      ? { kind: 'bad', text: 'No connection', hint: 'No connection. Check this phone’s internet.' }
      : { kind: 'warn', text: 'Connecting…', hint: 'Connecting…' };
  }
  return { kind: 'warn', text: 'Waiting for the board…', hint: 'Waiting for the board. Is it open on the TV?' };
}

// The header says "Quiz Admin Panel", or "Quiz Admin" when the status beside it leaves too little room
// (a small phone, with a long status). It is measured, so it suits any screen and font.
let titleFor = '';
function fitTitle(statusText){
  const key = `${statusText}|${innerWidth}`;
  if(key === titleFor) return;
  titleFor = key;
  const title = $('rmTitle');
  title.textContent = 'Quiz Admin Panel';
  if(title.scrollWidth > title.clientWidth) title.textContent = 'Quiz Admin';
}

// The feedback line: a fresh message, then why controls are greyed out, then the latest tap.
function renderFeedback(hint){
  const now = Date.now();
  let text = '', kind = '';
  if(note && now < note.until){ text = note.text; kind = note.kind; }
  else if(hint){ text = hint; kind = 'hint'; }
  else if(lastSent && !lastSent.ackedAt){ text = `Sending… ${lastSent.label}`; kind = 'sending'; }
  else if(lastSent && now - lastSent.ackedAt < 3500){ text = `✓ ${lastSent.label}`; }
  for(const el of document.querySelectorAll('.rm-last')){
    setText(el, text);
    el.className = `rm-last ${kind}`.trim();
  }
}

// ---------------------------------------------------------------- the teams

function teamRowHtml(team){
  const name = escapeHtml(team.name);
  const icons = board.powerups.map((p) => `<span class="tm-pu" data-powerup="${p.id}">${escapeHtml(p.icon)}</span>`).join('');
  return `<div class="tm" data-team="${team.id}" style="--team:${team.color}">`
    + `<button type="button" class="tm-open" data-open aria-label="${name}: more points, a custom amount and powerups">`
    + `<span class="tm-name"><span class="tm-name-text">${name}</span><span class="tm-more" aria-hidden="true">›</span></span><span class="tm-num"></span>`
    + `<span class="tm-meta"><span class="tm-rank"></span><span class="tm-pus" aria-hidden="true">${icons}</span></span></button>`
    + `<button type="button" class="tm-btn minus" data-amount="${-step}" aria-label="${signed(-step)} for ${name}">${signed(-step)}</button>`
    + `<button type="button" class="tm-btn plus" data-amount="${step}" aria-label="${signed(step)} for ${name}">${signed(step)}</button>`
    + '</div>';
}

// Rows are rebuilt only when a team or powerup is added, removed, renamed or recoloured. Rebuilding
// on every score would swallow a tap that lands just as an update arrives.
function renderTeams(live){
  $('rmTeams').disabled = !live;
  const grid = $('rmTeamGrid');
  if(!board?.teams.length){
    const text = board ? 'No teams yet. Add them in ⚙ Setup.' : 'Waiting for the board…';
    if(grid.dataset.key !== text){ grid.innerHTML = `<div class="rm-empty">${escapeHtml(text)}</div>`; grid.dataset.key = text; }
    grid.className = 'rm-team-grid';
    return;
  }
  const key = JSON.stringify([step, board.teams.map((t) => [t.id, t.name, t.color]), board.powerups.map((p) => [p.id, p.icon])]);
  if(grid.dataset.key !== key){
    grid.innerHTML = board.teams.map(teamRowHtml).join('');
    grid.dataset.key = key;
  }
  layoutTeams();

  // During the reveal the scores are locked, and a ✓ marks each team already revealed on the TV. The
  // host still sees every score.
  const revealing = isRevealing(board);
  $('rmBoardHint').hidden = revealing;
  $('rmLockHint').hidden = !revealing;
  for(const btn of grid.querySelectorAll('.tm-btn')) btn.disabled = revealing;

  // places are worked out from the scores as shown, taps on their way included
  const shown = board.teams.map((t) => ({ ...t, score: t.score + pendingDelta(t.id) }));
  const info = rankInfo(shown);
  const onScore = new Map(info.groups.map((g) => [g.score, g.teams.length]));
  for(const team of shown){
    const row = grid.querySelector(`[data-team="${team.id}"]`);
    if(!row) continue;
    row.classList.toggle('shown', board.revealed.includes(team.id));
    const rank = info.rankOf[team.id];
    const rankEl = row.querySelector('.tm-rank');
    setText(rankEl, info.allLevel ? '–' : `${onScore.get(team.score) > 1 ? '=' : ''}${ordinal(rank)}`);
    rankEl.classList.toggle('first', !info.allLevel && rank === 1);
    const num = row.querySelector('.tm-num');
    setText(num, String(team.score));
    num.classList.toggle('pending', team.score !== findTeam(team.id).score);
    for(const icon of row.querySelectorAll('.tm-pu')) icon.classList.toggle('used', shownUsed(team, icon.dataset.powerup).used);
  }
}

// Every team fits on the screen: the rows share the card's height.
//   One column while each row can be at least 44px tall: roomy when there is plenty of room, else one line each.
//   Then two columns: tiles with the buttons under the name, or, when even those would be too short to
//   tap, mini tiles with the buttons beside it.
// Only a tiny screen with a great many teams has to scroll.
const LANDSCAPE = matchMedia('(orientation: landscape) and (max-height: 500px)');
const MAX_ROW = { roomy: 150, line: 72, tile: 84, mini: 56 };
function layoutTeams(){
  const grid = $('rmTeamGrid');
  const n = board.teams.length;
  const GAP = 6;
  let cols = 1, height = 56, layout = 'line';
  if(!LANDSCAPE.matches){              // sideways, the page scrolls instead (see remote.css)
    const space = $('rmTeams').clientHeight;
    const per = (rows) => (space - GAP * (rows - 1)) / rows;
    cols = per(n) >= 44 ? 1 : 2;
    height = per(Math.ceil(n / cols));
    layout = cols === 1 ? (height >= 76 ? 'roomy' : 'line') : (height >= 56 ? 'tile' : 'mini');
    height = Math.max(36, Math.min(height, MAX_ROW[layout]));
  }
  grid.className = `rm-team-grid ${layout}`;
  grid.style.setProperty('--cols', String(cols));
  grid.style.setProperty('--row-h', `${Math.floor(height)}px`);
}

// ---------------------------------------------------------------- one team's sheet

function openTeam(team){
  sheetTeam = team.id;
  $('rmAmount').value = '';
  $('rmTeamSheet').hidden = false;
  render();
}
function closeTeam(){
  $('rmTeamSheet').hidden = true;
  sheetTeam = null;
}

function renderTeamSheet(live){
  if($('rmTeamSheet').hidden) return;
  const team = findTeam(sheetTeam);
  if(!team){ closeTeam(); return; }                  // the team was removed meanwhile
  $('rmTeamFields').disabled = !live;
  $('rmTeamHead').style.setProperty('--team', team.color);
  setText($('rmTeamName'), team.name);
  const delta = pendingDelta(team.id);
  setText($('rmTeamScore'), String(team.score + delta));
  $('rmTeamScore').classList.toggle('pending', delta !== 0);

  // + on the top row and − under it: 1, 2, 5 and 10, and the points per tap if it is something else
  const quick = $('rmTeamQuick');
  const amounts = [...new Set([...SHEET_AMOUNTS, step])].sort((a, b) => a - b);
  if(quick.dataset.key !== amounts.join()){
    const button = (n) => `<button type="button" class="tm-btn ${n < 0 ? 'minus' : 'plus'}${Math.abs(n) === step ? ' step' : ''}" data-amount="${n}">${signed(n)}</button>`;
    quick.innerHTML = amounts.map(button).join('') + amounts.map((n) => button(-n)).join('');
    quick.style.setProperty('--n', String(amounts.length));
    quick.dataset.key = amounts.join();
  }

  // the custom amount: the box takes how many points, and the two buttons say which way
  const locked = lockedByReveal(board, 'adjust-score');
  for(const btn of quick.children) btn.disabled = locked;
  $('rmAmount').disabled = locked;
  $('rmTeamLocked').hidden = !locked;
  const n = points($('rmAmount').value);
  setText($('rmAmountAdd'), n ? `+ Add ${n}` : '+ Add');
  setText($('rmAmountTake'), n ? `− Take away ${n}` : '− Take away');
  $('rmAmountAdd').disabled = $('rmAmountTake').disabled = !n || locked;

  const list = $('rmTeamPowerups');
  const key = board.powerups.map((p) => `${p.id}:${p.icon}:${p.name}`).join('|');
  if(list.dataset.key !== key){
    list.innerHTML = board.powerups.length
      ? board.powerups.map((p) => `<button type="button" class="pu" data-powerup="${p.id}">`
        + `<span class="pu-ic" aria-hidden="true">${escapeHtml(p.icon)}</span><span class="pu-name">${escapeHtml(p.name)}</span></button>`).join('')
      : '<p class="rm-hint">No powerups. Add them in ⚙ Setup.</p>';
    list.dataset.key = key;
  }
  for(const btn of list.querySelectorAll('.pu')){
    const powerup = findPowerup(btn.dataset.powerup);
    const s = shownUsed(team, powerup.id);
    btn.classList.toggle('used', s.used);
    btn.classList.toggle('pending', s.pending);
    btn.setAttribute('aria-pressed', String(s.used));
    btn.setAttribute('aria-label', `${powerup.name}: ${s.used ? 'used. Tap to give it back' : 'available. Tap when used'}`);
  }
}

function applyAmount(sign){
  const team = findTeam(sheetTeam);
  const n = points($('rmAmount').value);
  if(!team || !n) return;
  adjust(team, sign * n);
  $('rmAmount').value = '';
  $('rmAmount').blur();
  render();
}

// ---------------------------------------------------------------- undo, hidden scores and the reveal

function renderUndo(status){
  const undo = status?.undo ?? null;
  $('rmUndo').disabled = !undo;
  setText($('rmUndoText'), undo ? `Undo: ${undo}` : status ? 'Nothing to undo' : 'Undo');
}

// Undo says which change it means. If another change got to the board first, the board does nothing
// and the feedback line says so, rather than undoing something the host did not see on the button.
function undo(){
  const label = currentStatus()?.undo;
  if(!label) return;
  restartAnimation($('rmUndo'), 'sent');
  send('undo', { label }, { label: `Undo: ${label}` });
}

// While the board hides its scores, a bar above the teams says so, and what the next tap of Next
// reveals (Setup shows the same). Each tap reveals one place. Next stays greyed out until the board
// confirms the last one, so a double tap never reveals two places.
const revealHold = {};      // for hold() and isHeld(): the latest Next, until the board confirms it
function renderReveal(live){
  const hidden = !!board?.scoresHidden;
  $('rmHidden').hidden = !hidden;
  if(!hidden){ showConfirm.disarm(); return; }
  const next = nextReveal(board);
  setText($('rmHiddenState'), board.revealed.length ? `🥁 Revealing: ${next?.left ?? 0} to go` : '🙈 Scores hidden on the board');
  const html = next ? `Next: <b>${escapeHtml(next.place)}</b> · ${escapeHtml(next.who)}` : 'Nothing left to reveal';
  for(const el of document.querySelectorAll('.rm-next-text')){
    if(el.dataset.key !== html){ el.innerHTML = html; el.dataset.key = html; }
  }
  $('rmNext').disabled = $('rmNextSetup').disabled = !live || isHeld(revealHold);
}

// Next names the reveal the host can see, and the board does nothing if its next reveal is a
// different one (another phone got in first, or a score changed).
function revealNext(){
  if(!board?.scoresHidden) return;
  const label = nextReveal(board)?.label ?? 'Scores shown';
  if(send('reveal-next', { label }, { label })) hold(revealHold);
  render();
}

// ---------------------------------------------------------------- setup

function openSetup(){
  $('rmSetupSheet').hidden = false;
  render();
}
function closeSetup(){
  $('rmSetupSheet').hidden = true;
  swatchesFor = null;
  for(const confirm of [resetConfirm, showConfirm]) confirm.disarm();
}

const teamItemHtml = (t) => `<div class="rm-item" data-id="${t.id}"><div class="rm-item-row">`
  + '<button type="button" class="rm-dot-btn" data-color aria-expanded="false"></button>'
  + `<input type="text" maxlength="${NAME_MAX}" data-field="name" autocomplete="off" enterkeyhint="done" aria-label="Team name">`
  + '<button type="button" class="rm-remove" data-remove>✕</button></div>'
  + `<div class="rm-swatches" hidden>${PALETTE.map((c, i) => `<button type="button" class="rm-swatch" data-swatch="${c}" style="--swatch:${c}" aria-label="Colour ${i + 1}"></button>`).join('')}</div>`
  + '</div>';

const powerupItemHtml = (p) => `<div class="rm-item" data-id="${p.id}"><div class="rm-item-row">`
  + '<input type="text" class="rm-icon-input" maxlength="16" data-field="icon" autocomplete="off" aria-label="Powerup icon">'
  + `<input type="text" maxlength="${NAME_MAX}" data-field="name" autocomplete="off" enterkeyhint="done" aria-label="Powerup name">`
  + '<button type="button" class="rm-remove" data-remove>✕</button></div></div>';

// A box shows the board's value, except while the host is typing in it or their change is on its way.
function patchInput(input, value){
  if(document.activeElement === input || isHeld(input)) return;
  if(input.value !== value) input.value = value;
}
function patchTeamItem(el, team){
  const dot = el.querySelector('[data-color]');
  if(!isHeld(dot)){ dot.style.background = team.color; dot.dataset.color = team.color; }
  dot.setAttribute('aria-label', `Pick a colour for ${team.name}`);
  const remove = el.querySelector('[data-remove]');
  remove.setAttribute('aria-label', `Remove ${team.name}`);
  remove.disabled = lockedByReveal(board, 'remove-team');
  patchInput(el.querySelector('[data-field="name"]'), team.name);

  const open = swatchesFor === team.id;
  dot.setAttribute('aria-expanded', String(open));
  const swatches = el.querySelector('.rm-swatches');
  swatches.hidden = !open;
  if(open){
    const taken = new Set(board.teams.filter((t) => t.id !== team.id).map((t) => t.color));
    for(const s of swatches.children){
      s.classList.toggle('current', s.dataset.swatch === dot.dataset.color);
      s.classList.toggle('taken', taken.has(s.dataset.swatch));
    }
  }
}
function patchPowerupItem(el, powerup){
  el.querySelector('[data-remove]').setAttribute('aria-label', `Remove ${powerup.name}`);
  patchInput(el.querySelector('[data-field="icon"]'), powerup.icon);
  patchInput(el.querySelector('[data-field="name"]'), powerup.name);
}

// A list is rebuilt only when items are added or removed, and never while one of its boxes has focus
// (the host is typing in it). It catches up as soon as the box loses focus.
function renderList(list, items, itemHtml, patch, onRemove){
  const key = items.map((x) => x.id).join(',');
  if(list.dataset.key !== key){
    if(list.contains(document.activeElement)) return;
    list.innerHTML = items.length ? items.map(itemHtml).join('') : '<p class="rm-hint">None yet.</p>';
    list.dataset.key = key;
    for(const btn of list.querySelectorAll('[data-remove]')){
      armConfirm(btn, 'Remove?', () => onRemove(btn.closest('.rm-item').dataset.id));
    }
  }
  for(const item of items){
    const el = list.querySelector(`[data-id="${item.id}"]`);
    if(el) patch(el, item);
  }
}

function renderSetup(live){
  if($('rmSetupSheet').hidden) return;
  patchInput($('rmStepInput'), String(step));
  for(const fieldset of document.querySelectorAll('#rmSetup .rm-fields')) fieldset.disabled = !live;
  setText($('rmCodeShow'), code || '------');
  if(!board) return;
  patchInput($('rmTitleInput'), board.title);
  $('rmHideScores').hidden = board.scoresHidden;
  $('rmRevealRow').hidden = !board.scoresHidden;
  const revealing = isRevealing(board);
  setText($('rmHideHint'), revealing
    ? 'Scores, new teams, removing teams and Reset Round are locked until the reveal ends. Undo back to the start, or Show now, to change them.'
    : 'The board shows the teams but not their scores. Next reveals one place at a time, last place first.');
  $('rmHideHint').classList.toggle('locked', revealing);
  $('rmReset').disabled = lockedByReveal(board, 'reset-round');
  $('rmAddTeamName').disabled = lockedByReveal(board, 'add-team');
  renderList($('rmTeamList'), board.teams, teamItemHtml, patchTeamItem, removeTeam);
  renderList($('rmPowerupList'), board.powerups, powerupItemHtml, patchPowerupItem, removePowerup);
  setText($('rmTeamCount'), `${board.teams.length} / ${MAX_TEAMS}`);
  setText($('rmPowerupCount'), `${board.powerups.length} / ${MAX_POWERUPS}`);
  $('rmAddTeamBtn').disabled = !cleanText($('rmAddTeamName').value, NAME_MAX) || board.teams.length >= MAX_TEAMS
    || lockedByReveal(board, 'add-team');
  $('rmAddPowerupBtn').disabled = !cleanText($('rmAddPowerupName').value, NAME_MAX) || board.powerups.length >= MAX_POWERUPS;
}

function removeTeam(id){
  const team = findTeam(id);
  if(team) send('remove-team', { team: id }, { label: `Removed ${team.name}` });
}
function removePowerup(id){
  const powerup = findPowerup(id);
  if(powerup) send('remove-powerup', { powerup: id }, { label: `Removed ${powerup.name}` });
}

// Add (or Enter in its box, which works even while the Add button is greyed out at the limit).
function addTeam(){
  const input = $('rmAddTeamName');
  const name = cleanText(input.value, NAME_MAX);
  if(name && board.teams.length < MAX_TEAMS && !lockedByReveal(board, 'add-team') && send('add-team', { name }, { label: `Added ${name}` })) input.value = '';
}
function addPowerup(){
  const nameInput = $('rmAddPowerupName');
  const name = cleanText(nameInput.value, NAME_MAX);
  if(name && board.powerups.length < MAX_POWERUPS
    && send('add-powerup', { name, icon: cleanIcon($('rmAddPowerupIcon').value) }, { label: `Added ${name}` })){
    nameInput.value = '';
    $('rmAddPowerupIcon').value = '';
  }
}

// Points per tap changed: kept on this phone, and the team rows show the new amount at once.
// Anything that is not a number of points goes back to the old one.
function stepChanged(){
  const input = $('rmStepInput');
  step = points(input.value) || step;
  store.set(STORAGE.step, String(step));
  input.value = String(step);
  render();
}

function pickColor(team, color, dot){
  swatchesFor = null;
  if(color !== (dot.dataset.color || team.color)
    && send('set-team-color', { team: team.id, color }, { label: `New colour for ${team.name}` })){
    dot.style.background = color;                 // shown at once
    dot.dataset.color = color;
    hold(dot);
  }
  render();
}

// A text box was changed (on leaving it, or on Enter). The title may be blank; a blank or unchanged
// name or icon just goes back to what it was. A change is sent, and the box holds it until confirmed.
function fieldChanged(input){
  if(!board) return;
  const commit = (value, current, action, arg, label) => {
    if((!value && input.id !== 'rmTitleInput') || value === current){ input.value = current; return; }
    if(send(action, arg, { label })) hold(input);
  };
  const id = input.closest('.rm-item')?.dataset.id;
  const team = input.closest('#rmTeamList') && findTeam(id);
  const powerup = input.closest('#rmPowerupList') && findPowerup(id);
  if(input.id === 'rmTitleInput'){
    const title = cleanText(input.value, TITLE_MAX);
    commit(title, board.title, 'set-title', { title }, title ? 'Title changed' : 'Title removed');
  } else if(team){
    const name = cleanText(input.value, NAME_MAX);
    commit(name, team.name, 'rename-team', { team: id, name }, `Renamed ${team.name} to ${name}`);
  } else if(powerup && input.dataset.field === 'icon'){
    const icon = cleanIcon(input.value);
    commit(icon, powerup.icon, 'edit-powerup', { powerup: id, icon }, `New icon for ${powerup.name}`);
  } else if(powerup){
    const name = cleanText(input.value, NAME_MAX);
    commit(name, powerup.name, 'edit-powerup', { powerup: id, name }, `Renamed ${powerup.name} to ${name}`);
  }
}

// ================================================================ wiring

// pairing
$('rmCodeBtn').addEventListener('click', submitCode);
$('rmCodeInput').addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); submitCode(); } });

// the teams: − / + on each row (the points per tap), and the name opens the team's sheet
$('rmTeams').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  const team = findTeam(btn?.closest('.tm')?.dataset.team);
  if(!team || btn.matches(':disabled')) return;
  if(btn.dataset.amount) adjust(team, Number(btn.dataset.amount), btn);
  else if(btn.hasAttribute('data-open')) openTeam(team);
});
$('rmUndo').addEventListener('click', undo);

// one team's sheet
$('rmTeamFields').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  const team = findTeam(sheetTeam);
  if(!btn || !team || btn.matches(':disabled')) return;
  if(btn.dataset.amount) adjust(team, Number(btn.dataset.amount), btn);
  else if(btn.dataset.powerup) togglePowerup(team, btn.dataset.powerup);
});
$('rmAmount').addEventListener('input', render);
$('rmAmount').addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); $('rmAmount').blur(); } });
$('rmAmountAdd').addEventListener('click', () => applyAmount(1));
$('rmAmountTake').addEventListener('click', () => applyAmount(-1));
$('rmTeamDone').addEventListener('click', closeTeam);
$('rmTeamSheet').addEventListener('click', (e) => { if(e.target.id === 'rmTeamSheet') closeTeam(); });

// setup
$('rmSetupBtn').addEventListener('click', openSetup);
$('rmSetupClose').addEventListener('click', closeSetup);
$('rmSetupDone').addEventListener('click', closeSetup);
$('rmSetupSheet').addEventListener('click', (e) => { if(e.target.id === 'rmSetupSheet') closeSetup(); });
const setup = $('rmSetup');
setup.addEventListener('change', (e) => {
  if(e.target.id === 'rmStepInput') stepChanged();
  else if(e.target.tagName === 'INPUT') fieldChanged(e.target);
});
setup.addEventListener('keydown', (e) => {
  if(e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  if(e.target.id === 'rmAddTeamName') addTeam();
  else if(e.target.id === 'rmAddPowerupName' || e.target.id === 'rmAddPowerupIcon') addPowerup();
  else e.target.blur();                         // which fires 'change'
});
setup.addEventListener('input', (e) => { if(e.target.id.startsWith('rmAdd')) render(); });
setup.addEventListener('focusout', () => setTimeout(render, 0));   // lists catch up once typing stops
$('rmTeamList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-color], [data-swatch]');
  const team = btn && findTeam(btn.closest('.rm-item').dataset.id);
  if(!team) return;
  const dot = btn.closest('.rm-item').querySelector('[data-color]');
  if(btn.dataset.swatch) pickColor(team, btn.dataset.swatch, dot);
  else { swatchesFor = swatchesFor === team.id ? null : team.id; render(); }
});
$('rmAddTeamBtn').addEventListener('click', addTeam);
$('rmAddPowerupBtn').addEventListener('click', addPowerup);
$('rmHideScores').addEventListener('click', () => send('hide-scores', undefined, { label: 'Scores hidden' }));
// the reveal: Next (on the scoring screen, or in Setup) is one tap per place. Showing every score at
// once cannot be taken back once the room has seen them, so it takes two.
$('rmNext').addEventListener('click', revealNext);
$('rmNextSetup').addEventListener('click', revealNext);
const showConfirm = armConfirm($('rmShowScores'), 'Tap again', () => send('show-scores', undefined, { label: 'Scores shown' }));
const resetConfirm = armConfirm($('rmReset'), 'Tap again to reset', () => send('reset-round', undefined, { label: 'Reset round' }));
$('rmChange').addEventListener('click', () => showPairing(code));

// the rows share the screen's height, so they are laid out again when it changes
window.addEventListener('resize', render);
LANDSCAPE.addEventListener?.('change', render);
document.fonts?.ready.then(() => { titleFor = ''; render(); });   // the header is measured again in its own font

// start: the code in the address, or the room this phone joined last time
const params = new URLSearchParams(location.search);
let startCode = normaliseCode(params.get('code'));
if(!isValidCode(startCode)) startCode = normaliseCode(store.get(STORAGE.remoteCode));
if(isValidCode(startCode)) connect(startCode); else showPairing('');
// timeouts, "No connection" after 8 s, and checking the board is still there, all need a clock
setInterval(() => { checkBoardIsThere(); render(); }, 1000);
