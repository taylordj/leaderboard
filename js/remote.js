// The phone remote: the host runs the board from here. Every tap is sent to the board (the TV) as a
// command, and the board's status brings back the whole scoreboard, which is what this page draws.
//
// A score or powerup tap shows at once, marked as pending, until the board confirms it (its status
// carries the last command it handled from this phone, and whether that changed anything). Anything
// not confirmed within a few seconds is reported, so the host never has to wonder whether a tap landed.
import {
  STORAGE, QUICK_AMOUNTS, PALETTE, MAX_TEAMS, MAX_POWERUPS, MAX_ADJUST, NAME_MAX, TITLE_MAX,
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
let amountTeam = null;    // the team the custom-amount sheet is for

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
  closeAmount();
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

// What a card shows: the board's score plus this phone's taps that are still on their way.
const pendingDelta = (teamId) => pending.reduce((sum, p) => sum + (p.team === teamId && p.amount ? p.amount : 0), 0);
function shownUsed(team, powerupId){
  const p = pending.findLast((x) => x.team === team.id && x.powerup === powerupId);
  return p ? { used: p.used, pending: true } : { used: !!team.used[powerupId], pending: false };
}

// ================================================================ drawing

function render(){
  const status = currentStatus();
  if(status) board = status.board;
  settle(status);
  const live = !!status;
  renderConnection(status);
  setText($('rmTitle'), board?.title || 'Remote');
  renderHidden(live);
  renderTeams(live);
  renderUndo(status);
  if(!$('rmAmountSheet').hidden) renderAmount();
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
  for(const el of [$('rmLast'), $('rmSetupLast')]){
    setText(el, text);
    el.className = `rm-last ${kind}`.trim();
  }
}

// ---------------------------------------------------------------- team cards

function teamCardHtml(team){
  const name = escapeHtml(team.name);
  const quick = QUICK_AMOUNTS.map((n) => `<button type="button" class="tm-btn ${n < 0 ? 'minus' : 'plus'}" data-amount="${n}"`
    + ` aria-label="${signed(n)} for ${name}">${signed(n)}</button>`).join('');
  const powerups = board.powerups.length
    ? `<div class="tm-powerups">${board.powerups.map((p) => `<button type="button" class="pu" data-powerup="${p.id}">`
      + `<span class="pu-ic" aria-hidden="true">${escapeHtml(p.icon)}</span><span class="pu-name">${escapeHtml(p.name)}</span></button>`).join('')}</div>`
    : '';
  return `<div class="tm" data-team="${team.id}" style="--team:${team.color}">`
    + '<div class="tm-head"><span class="tm-rank"></span>'
    + `<span class="tm-name">${name}</span>`
    + '<span class="tm-score"><span class="tm-pending"></span><span class="tm-num"></span></span></div>'
    + `<div class="tm-adjust">${quick}<button type="button" class="tm-btn custom" data-custom aria-label="Custom amount for ${name}">±</button></div>`
    + powerups
    + '</div>';
}

// Cards are rebuilt only when a team or powerup is added, removed, renamed or recoloured. Rebuilding
// on every score would swallow a tap that lands just as an update arrives.
function renderTeams(live){
  const wrap = $('rmTeams');
  wrap.disabled = !live;
  if(!board?.teams.length){
    const text = board ? 'No teams yet. Add them in ⚙ Setup.' : 'Waiting for the board…';
    if(wrap.dataset.key !== text){ wrap.innerHTML = `<div class="rm-empty">${escapeHtml(text)}</div>`; wrap.dataset.key = text; }
    return;
  }
  const key = JSON.stringify([board.teams.map((t) => [t.id, t.name, t.color]), board.powerups.map((p) => [p.id, p.icon, p.name])]);
  if(wrap.dataset.key !== key){
    wrap.innerHTML = board.teams.map(teamCardHtml).join('');
    wrap.dataset.key = key;
  }

  const shown = board.teams.map((t) => ({ ...t, score: t.score + pendingDelta(t.id) }));
  const info = rankInfo(shown);
  for(const team of shown){
    const card = wrap.querySelector(`[data-team="${team.id}"]`);
    if(!card) continue;
    const rank = info.rankOf[team.id];
    const tied = shown.filter((t) => t.score === team.score).length > 1;
    const rankEl = card.querySelector('.tm-rank');
    setText(rankEl, info.allLevel ? '–' : `${tied ? '=' : ''}${ordinal(rank)}`);
    rankEl.classList.toggle('first', !info.allLevel && rank === 1);
    setText(card.querySelector('.tm-num'), String(team.score));
    const delta = pendingDelta(team.id);
    setText(card.querySelector('.tm-pending'), delta ? `${signed(delta)}…` : '');
    for(const btn of card.querySelectorAll('.pu')){
      const powerup = findPowerup(btn.dataset.powerup);
      if(!powerup) continue;
      const s = shownUsed(team, powerup.id);
      btn.classList.toggle('used', s.used);
      btn.classList.toggle('pending', s.pending);
      btn.setAttribute('aria-pressed', String(s.used));
      btn.setAttribute('aria-label', `${powerup.name} for ${team.name}: ${s.used ? 'used. Tap to give it back' : 'available. Tap when used'}`);
    }
  }
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

// ---------------------------------------------------------------- undo

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

// ---------------------------------------------------------------- hidden scores and the reveal

// While the board hides its scores, a bar above the cards says so, with the Reveal button (tap twice).
function renderHidden(live){
  const hidden = !!board?.scoresHidden;
  $('rmHidden').hidden = !hidden;
  $('rmReveal').disabled = !live;
  if(!hidden) revealConfirm.disarm();
}

// Setup's button hides the scores, or, once hidden, shows them again straight away without a reveal.
function toggleHidden(){
  if(!board) return;
  if(board.scoresHidden) send('show-scores', undefined, { label: 'Scores shown' });
  else send('hide-scores', undefined, { label: 'Scores hidden' });
}

// ---------------------------------------------------------------- custom amount

// Phone number pads often have no minus key, so the box takes how many points, and the two
// buttons say which way.
function amountValue(){
  const n = Math.abs(Math.round(Number($('rmAmount').value)));
  return n >= 1 && n <= MAX_ADJUST ? n : 0;
}
function openAmount(team){
  amountTeam = team.id;
  $('rmAmount').value = '';
  $('rmAmountSheet').hidden = false;
  renderAmount();
  $('rmAmount').focus();
}
function closeAmount(){
  $('rmAmountSheet').hidden = true;
  amountTeam = null;
}
function renderAmount(){
  const team = findTeam(amountTeam);
  if(!team){ closeAmount(); return; }                 // the team was removed meanwhile
  setText($('rmAmountFor'), `${team.name} · ${team.score + pendingDelta(team.id)} points`);
  const n = amountValue();
  setText($('rmAmountAdd'), n ? `+ Add ${n}` : '+ Add');
  setText($('rmAmountTake'), n ? `− Take away ${n}` : '− Take away');
  $('rmAmountAdd').disabled = $('rmAmountTake').disabled = !(n && currentStatus());
}
function applyAmount(sign){
  const team = findTeam(amountTeam);
  const n = amountValue();
  if(!team || !n) return;
  adjust(team, sign * n);
  closeAmount();
}

// ---------------------------------------------------------------- setup

function openSetup(){
  $('rmSetupSheet').hidden = false;
  render();
}
function closeSetup(){
  $('rmSetupSheet').hidden = true;
  resetConfirm.disarm();
}

const teamItemHtml = (t) => `<div class="rm-item" data-id="${t.id}">`
  + '<button type="button" class="rm-dot-btn" data-color></button>'
  + `<input type="text" maxlength="${NAME_MAX}" data-field="name" autocomplete="off" enterkeyhint="done" aria-label="Team name">`
  + '<button type="button" class="rm-remove" data-remove>✕</button></div>';

const powerupItemHtml = (p) => `<div class="rm-item" data-id="${p.id}">`
  + '<input type="text" class="rm-icon-input" maxlength="16" data-field="icon" autocomplete="off" aria-label="Powerup icon">'
  + `<input type="text" maxlength="${NAME_MAX}" data-field="name" autocomplete="off" enterkeyhint="done" aria-label="Powerup name">`
  + '<button type="button" class="rm-remove" data-remove>✕</button></div>';

// A box shows the board's value, except while the host is typing in it or their change is on its way.
function patchInput(input, value){
  if(document.activeElement === input || isHeld(input)) return;
  if(input.value !== value) input.value = value;
}
function patchTeamItem(el, team){
  const dot = el.querySelector('[data-color]');
  if(!isHeld(dot)){ dot.style.background = team.color; dot.dataset.color = team.color; }
  dot.setAttribute('aria-label', `Change the colour of ${team.name}`);
  el.querySelector('[data-remove]').setAttribute('aria-label', `Remove ${team.name}`);
  patchInput(el.querySelector('[data-field="name"]'), team.name);
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
  setText($('rmHideScores'), board.scoresHidden ? 'Show scores now (no reveal)' : '🙈 Hide scores on the board');
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

// The next colour round the palette that no other team has (or simply the next, if all are taken).
function nextColor(team, current){
  const taken = new Set(board.teams.filter((t) => t.id !== team.id).map((t) => t.color));
  const start = PALETTE.indexOf(current);
  const around = PALETTE.map((_, i) => PALETTE[(start + 1 + i) % PALETTE.length]);
  return around.find((c) => c !== current && !taken.has(c)) ?? around[0];
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

// team cards: one listener for every button on every card
$('rmTeams').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  const team = findTeam(btn?.closest('.tm')?.dataset.team);
  if(!team || btn.matches(':disabled')) return;
  if(btn.dataset.amount) adjust(team, Number(btn.dataset.amount), btn);
  else if(btn.hasAttribute('data-custom')) openAmount(team);
  else if(btn.dataset.powerup) togglePowerup(team, btn.dataset.powerup);
});
$('rmUndo').addEventListener('click', undo);
const revealConfirm = armConfirm($('rmReveal'), 'Tap again', () => send('reveal-scores', undefined, { label: 'Scores revealed' }));

// custom amount
$('rmAmount').addEventListener('input', renderAmount);
$('rmAmount').addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); $('rmAmount').blur(); } });
$('rmAmountAdd').addEventListener('click', () => applyAmount(1));
$('rmAmountTake').addEventListener('click', () => applyAmount(-1));
$('rmAmountCancel').addEventListener('click', closeAmount);
$('rmAmountSheet').addEventListener('click', (e) => { if(e.target.id === 'rmAmountSheet') closeAmount(); });

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
  const dot = e.target.closest('[data-color]');
  const team = dot && findTeam(dot.closest('.rm-item').dataset.id);
  if(!team) return;
  const color = nextColor(team, dot.dataset.color || team.color);
  if(send('set-team-color', { team: team.id, color }, { label: `New colour for ${team.name}` })){
    dot.style.background = color;               // shown at once
    dot.dataset.color = color;
    hold(dot);
  }
});
$('rmHideScores').addEventListener('click', toggleHidden);
$('rmAddTeamBtn').addEventListener('click', addTeam);
$('rmAddPowerupBtn').addEventListener('click', addPowerup);
const resetConfirm = armConfirm($('rmReset'), 'Tap again to reset', () => send('reset-round', undefined, { label: 'Reset round' }));
$('rmChange').addEventListener('click', () => showPairing(code));

// start: the code in the address, or the room this phone joined last time
const params = new URLSearchParams(location.search);
let startCode = normaliseCode(params.get('code'));
if(!isValidCode(startCode)) startCode = normaliseCode(store.get(STORAGE.remoteCode));
if(isValidCode(startCode)) connect(startCode); else showPairing('');
// timeouts, "No connection" after 8 s, and checking the board is still there, all need a clock
setInterval(() => { checkBoardIsThere(); render(); }, 1000);
