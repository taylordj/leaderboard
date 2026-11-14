// The phone remote: the host runs the board from here. Every tap is sent to the board (the TV) as a
// command, and the board's status brings back the whole scoreboard, which is what this page draws.
//
// Every team fits on one screen, each with its own −1 / +1. Tapping a team opens its sheet: ±5, a
// custom amount and its powerups. A score or powerup tap shows at once, marked as pending, until the
// board confirms it (its status carries the last command it handled from this phone, and whether that
// changed anything). Anything not confirmed within a few seconds is reported, so the host never has
// to wonder whether a tap landed.
import {
  STORAGE, PALETTE, MAX_TEAMS, MAX_POWERUPS, MAX_ADJUST, NAME_MAX, TITLE_MAX,
  CONFIRM_TIMEOUT_MS, PING_AFTER_MS, GONE_AFTER_MS,
} from './config.js';
import {
  $, store, escapeHtml, signed, ordinal, setText, normaliseCode, isValidCode, randomString, restartAnimation, armConfirm,
} from './util.js';
import { rankInfo, cleanText, cleanIcon } from './model.js';
import { openRelay, manageConnection } from './relay.js';

const SESSION = randomString(8, 'abcdefghijklmnopqrstuvwxyz0123456789'); // which phone sent a command
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

const connection = manageConnection(() => relay, { isDisplay: false });
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

// label: what the feedback line calls it. track: shown on the card as pending until confirmed.
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
  renderConnection(status);
  setText($('rmTitle'), board?.title || 'Scoreboard');
  renderHidden(live);
  renderTeams(live);
  renderUndo(status);
  renderTeamSheet(live);
  renderSetup(live);
  renderFeedback(status);
}

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

function renderConnection(status){
  const { kind, text } = connectionState(status);
  $('rmStatus').className = `rm-status ${kind}`;
  setText($('rmStatusText'), text);
}

// The feedback line: a fresh message, then why controls are greyed out, then the latest tap.
function renderFeedback(status){
  const now = Date.now();
  let text = '', kind = '';
  if(note && now < note.until){ text = note.text; kind = note.kind; }
  else if(relay && !status){ text = connectionState(status).hint; kind = 'hint'; }
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
    + `<button type="button" class="tm-open" data-open aria-label="${name}: more (±5, custom amount, powerups)">`
    + `<span class="tm-name">${name}</span><span class="tm-num"></span>`
    + `<span class="tm-meta"><span class="tm-rank"></span><span class="tm-pus" aria-hidden="true">${icons}</span></span></button>`
    + `<button type="button" class="tm-btn minus" data-amount="-1" aria-label="−1 for ${name}">−1</button>`
    + `<button type="button" class="tm-btn plus" data-amount="1" aria-label="+1 for ${name}">+1</button>`
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
  const key = JSON.stringify([board.teams.map((t) => [t.id, t.name, t.color]), board.powerups.map((p) => [p.id, p.icon])]);
  if(grid.dataset.key !== key){
    grid.innerHTML = board.teams.map(teamRowHtml).join('');
    grid.dataset.key = key;
  }
  layoutTeams();

  const shown = board.teams.map((t) => ({ ...t, score: t.score + pendingDelta(t.id) }));
  const info = rankInfo(shown);
  for(const team of shown){
    const row = grid.querySelector(`[data-team="${team.id}"]`);
    if(!row) continue;
    const rank = info.rankOf[team.id];
    const tied = shown.filter((t) => t.score === team.score).length > 1;
    const rankEl = row.querySelector('.tm-rank');
    setText(rankEl, info.allLevel ? '–' : `${tied ? '=' : ''}${ordinal(rank)}`);
    rankEl.classList.toggle('first', !info.allLevel && rank === 1);
    const num = row.querySelector('.tm-num');
    setText(num, String(team.score));
    num.classList.toggle('pending', pendingDelta(team.id) !== 0);
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

// Phone number pads often have no minus key, so the box takes how many points, and the two
// buttons say which way.
function amountValue(){
  const n = Math.abs(Math.round(Number($('rmAmount').value)));
  return n >= 1 && n <= MAX_ADJUST ? n : 0;
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

  const quick = $('rmTeamQuick');
  if(!quick.children.length){
    quick.innerHTML = [-5, -1, 1, 5].map((n) => `<button type="button" class="tm-btn ${n < 0 ? 'minus' : 'plus'}" data-amount="${n}">${signed(n)}</button>`).join('');
  }

  const n = amountValue();
  setText($('rmAmountAdd'), n ? `+ Add ${n}` : '+ Add');
  setText($('rmAmountTake'), n ? `− Take away ${n}` : '− Take away');
  $('rmAmountAdd').disabled = $('rmAmountTake').disabled = !n;

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
  const n = amountValue();
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

// While the board hides its scores, a bar above the teams says so, with the Reveal button.
function renderHidden(live){
  const hidden = !!board?.scoresHidden;
  $('rmHidden').hidden = !hidden;
  $('rmReveal').disabled = !live;
  if(!hidden) for(const confirm of revealConfirms) confirm.disarm();
}

const reveal = () => send('reveal-scores', undefined, { label: 'Scores revealed' });

// ---------------------------------------------------------------- setup

function openSetup(){
  $('rmSetupSheet').hidden = false;
  render();
}
function closeSetup(){
  $('rmSetupSheet').hidden = true;
  swatchesFor = null;
  for(const confirm of [resetConfirm, ...revealConfirms]) confirm.disarm();
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
  el.querySelector('[data-remove]').setAttribute('aria-label', `Remove ${team.name}`);
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
  $('rmSetupFields').disabled = !live;
  setText($('rmCodeShow'), code || '------');
  if(!board) return;
  patchInput($('rmTitleInput'), board.title);
  $('rmHideScores').hidden = board.scoresHidden;
  $('rmRevealRow').hidden = !board.scoresHidden;
  renderList($('rmTeamList'), board.teams, teamItemHtml, patchTeamItem, removeTeam);
  renderList($('rmPowerupList'), board.powerups, powerupItemHtml, patchPowerupItem, removePowerup);
  setText($('rmTeamCount'), `${board.teams.length} / ${MAX_TEAMS}`);
  setText($('rmPowerupCount'), `${board.powerups.length} / ${MAX_POWERUPS}`);
  $('rmAddTeamBtn').disabled = !cleanText($('rmAddTeamName').value, NAME_MAX) || board.teams.length >= MAX_TEAMS;
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

// Add (or Enter in its box). The Add buttons grey out at the limits; the board checks them again anyway.
function addTeam(){
  const input = $('rmAddTeamName');
  const name = cleanText(input.value, NAME_MAX);
  if(name && send('add-team', { name }, { label: `Added ${name}` })) input.value = '';
}
function addPowerup(){
  const nameInput = $('rmAddPowerupName');
  const name = cleanText(nameInput.value, NAME_MAX);
  if(name && send('add-powerup', { name, icon: cleanIcon($('rmAddPowerupIcon').value) }, { label: `Added ${name}` })){
    nameInput.value = '';
    $('rmAddPowerupIcon').value = '';
  }
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

// A text box was changed (on leaving it, or on Enter). A blank or unchanged value just goes back.
function fieldChanged(input){
  if(!board) return;
  if(input.id === 'rmTitleInput'){
    const title = cleanText(input.value, TITLE_MAX);
    if(title === board.title){ input.value = title; return; }
    if(send('set-title', { title }, { label: title ? 'Title changed' : 'Title removed' })) hold(input);
    return;
  }
  const id = input.closest('.rm-item')?.dataset.id;
  const team = input.closest('#rmTeamList') && findTeam(id);
  const powerup = input.closest('#rmPowerupList') && findPowerup(id);
  if(team){
    const name = cleanText(input.value, NAME_MAX);
    if(!name || name === team.name){ input.value = team.name; return; }
    if(send('rename-team', { team: id, name }, { label: `Renamed ${team.name} to ${name}` })) hold(input);
  } else if(powerup && input.dataset.field === 'icon'){
    const icon = cleanIcon(input.value);
    if(!icon || icon === powerup.icon){ input.value = powerup.icon; return; }
    if(send('edit-powerup', { powerup: id, icon }, { label: `New icon for ${powerup.name}` })) hold(input);
  } else if(powerup){
    const name = cleanText(input.value, NAME_MAX);
    if(!name || name === powerup.name){ input.value = powerup.name; return; }
    if(send('edit-powerup', { powerup: id, name }, { label: `Renamed ${powerup.name} to ${name}` })) hold(input);
  }
}

// ================================================================ wiring

// pairing
$('rmCodeBtn').addEventListener('click', submitCode);
$('rmCodeInput').addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); submitCode(); } });

// the teams: −1 / +1 on each row, and the row itself opens the team's sheet
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
const fields = $('rmSetupFields');
fields.addEventListener('change', (e) => { if(e.target.tagName === 'INPUT') fieldChanged(e.target); });
fields.addEventListener('keydown', (e) => {
  if(e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  if(e.target.id === 'rmAddTeamName') addTeam();
  else if(e.target.id === 'rmAddPowerupName' || e.target.id === 'rmAddPowerupIcon') addPowerup();
  else e.target.blur();                         // which fires 'change'
});
fields.addEventListener('input', (e) => { if(e.target.id.startsWith('rmAdd')) render(); });
fields.addEventListener('focusout', () => setTimeout(render, 0));   // lists catch up once typing stops
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
// Revealing, or showing the scores straight away, cannot be taken back once the room has seen them,
// so each takes two taps (from the bar on the scoring screen, or from Setup).
const revealConfirms = [
  armConfirm($('rmReveal'), 'Tap again', reveal),
  armConfirm($('rmRevealSetup'), 'Tap again', reveal),
  armConfirm($('rmShowScores'), 'Tap again', () => send('show-scores', undefined, { label: 'Scores shown' })),
];
const resetConfirm = armConfirm($('rmReset'), 'Tap again to reset', () => send('reset-round', undefined, { label: 'Reset round' }));
$('rmChange').addEventListener('click', () => showPairing(code));

// the rows share the screen's height, so they are laid out again when it changes
window.addEventListener('resize', render);
LANDSCAPE.addEventListener?.('change', render);

// start: the code in the address, or the room this phone joined last time
const params = new URLSearchParams(location.search);
let startCode = normaliseCode(params.get('code'));
if(!isValidCode(startCode)) startCode = normaliseCode(store.get(STORAGE.remoteCode));
if(isValidCode(startCode)) connect(startCode); else showPairing('');
// timeouts, "No connection" after 8 s, and checking the board is still there, all need a clock
setInterval(() => { checkBoardIsThere(); render(); }, 1000);
