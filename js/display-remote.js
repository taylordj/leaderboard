// The TV's side of the phone remote: the pairing dialog (QR code, room code, link), running commands
// from phones, and telling them what the board looks like.
//
// The remote is always on. The dialog opens by itself until a phone has connected to this room code,
// and closes by itself when a new phone connects (not when one that is already connected checks in,
// so it never snatches the QR code away from someone about to scan it).
import { STORAGE, MAX_ACKS } from './config.js';
import { $, store, newRoomCode, normaliseCode, isValidCode, armConfirm } from './util.js';
import { openRelay, manageConnection } from './relay.js';

// perform(action, arg): runs a change on the board, -> true if it changed (display.js)
// getStatus(): what the phones should be told right now (display.js)
// -> { start, stop, publishStatus }. Only the copy of the board that has the remote is started (one-board.js).
export function initDisplayRemote({ perform, getStatus }){
  let code = '';
  let relay = null;
  // phone session -> { seq, ok }: the last command handled from it, and whether it changed the board
  const acks = new Map();
  let lastPublished = '';
  const connection = manageConnection({
    isLinked: () => !!relay,
    reconnect: () => relay?.start(),
    onLeave: () => relay?.stop(true),
  });

  const remoteUrl = () => new URL(`remote.html?code=${code}`, location.href).toString();
  const isPaired = () => store.get(STORAGE.paired) === code;

  function onCommand(cmd){
    const isNewPhone = !acks.has(cmd.from);
    const ok = cmd.action === 'hello' ? true : perform(cmd.action, cmd.arg);
    acks.delete(cmd.from);                 // newest last, so the oldest phone is the one dropped
    acks.set(cmd.from, { seq: cmd.seq, ok });
    if(acks.size > MAX_ACKS) acks.delete(acks.keys().next().value);
    if(cmd.action === 'hello' && isNewPhone) phoneConnected();
    publishStatus();                       // always, so the ack goes out even if nothing changed
  }

  function phoneConnected(){
    store.set(STORAGE.paired, code);
    if(!$('remoteModal').hidden){ closeDialog(); toast('📱 Remote connected'); }
    renderUi();
  }

  // Send the phones the current status, but only when something in it has changed.
  function publishStatus(){
    if(!relay) return;
    const status = { ...getStatus(), acks: Object.fromEntries(acks) };
    const text = JSON.stringify(status);
    if(text === lastPublished) return;
    lastPublished = text;
    relay.publishStatus(status);
  }

  function connect(){
    relay?.stop(true);
    lastPublished = '';
    relay = openRelay({ role: 'display', code, onCommand, onChange: renderUi });
    relay.start();
    publishStatus();
    connection.requestWake();
  }

  // The chip in the corner and the dialog's status line.
  function renderUi(){
    const connected = relay ? relay.connectedCount() : 0;
    const kind = relay?.failed ? 'bad' : connected ? 'ok' : 'warn';
    $('rcDot').className = `rc-dot ${kind}`;
    $('rcChipText').textContent = $('rcCode').textContent = code;
    $('rcChip').classList.toggle('attention', kind !== 'ok');
    $('rcChip').title = { ok: 'Remote ready', bad: 'Remote unavailable', warn: 'Remote connecting…' }[kind];
    const status = $('rcStatus');
    status.className = `rc-status ${kind === 'warn' ? '' : kind}`.trim();
    status.textContent = kind === 'bad' ? 'Could not load the connection library. Reload the page, or use the remote on this device.'
      : kind === 'ok' ? (isPaired() ? 'Ready ✓' : 'Ready. Waiting for your phone…')
      : 'Connecting…';
  }

  function renderQr(){
    const box = $('rcQr');
    if(typeof window.qrcode !== 'function'){ box.innerHTML = '<div class="rc-qr-note">QR code unavailable.<br>Use the link below.</div>'; return; }
    const qr = window.qrcode(0, 'M');
    qr.addData(remoteUrl());
    qr.make();
    const n = qr.getModuleCount(), quiet = 3, size = n + quiet * 2;
    let path = '';
    for(let r = 0; r < n; r++){
      for(let c = 0; c < n; c++) if(qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img"`
      + ` aria-label="QR code that opens the remote on a phone"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#0A0E1A"/></svg>`;
  }

  function toast(text){
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toastRoot').append(el);
    setTimeout(() => el.remove(), 2800);
  }

  // A new code disconnects every phone, so it takes two taps.
  const newCodeConfirm = armConfirm($('rcNew'), 'Tap again', () => {
    code = newRoomCode();
    store.set(STORAGE.displayCode, code);
    acks.clear();
    connect();
    openDialog();          // redraws the QR code and link
  });

  function openDialog(){
    renderQr();
    $('rcLink').textContent = remoteUrl().replace(/^https?:\/\//, '');
    $('rcHere').href = remoteUrl();
    renderUi();
    $('remoteModal').hidden = false;
  }
  function closeDialog(){
    $('remoteModal').hidden = true;
    newCodeConfirm.disarm();
  }

  $('rcChip').addEventListener('click', openDialog);
  $('rcClose').addEventListener('click', closeDialog);
  $('remoteModal').addEventListener('click', (e) => { if(e.target.id === 'remoteModal') closeDialog(); });
  document.addEventListener('keydown', (e) => { if(e.key === 'Escape' && !$('remoteModal').hidden) closeDialog(); });
  $('rcCopy').addEventListener('click', () => {
    const btn = $('rcCopy');
    const done = (ok) => {
      btn.textContent = ok ? 'Copied ✓' : 'Press and hold the link to copy';
      setTimeout(() => { btn.textContent = 'Copy link'; }, 1800);
    };
    if(navigator.clipboard?.writeText) navigator.clipboard.writeText(remoteUrl()).then(() => done(true), () => done(false));
    else done(false);
  });
  // The remote on this computer gets a small window of its own: a new tab would hide the board.
  // (If the browser blocks the window, the link opens a tab as usual.)
  $('rcHere').addEventListener('click', (e) => {
    if(window.open(remoteUrl(), 'scoreboard-remote', 'popup,width=420,height=860')) e.preventDefault();
  });

  // Take the remote: read the room code (another copy of the board may have changed it), connect, and
  // show the pairing dialog if no phone has used this code yet.
  function start(){
    code = normaliseCode(store.get(STORAGE.displayCode));
    if(!isValidCode(code)){ code = newRoomCode(); store.set(STORAGE.displayCode, code); }
    acks.clear();
    $('rcChip').hidden = false;
    connect();
    if(!isPaired()) openDialog();
  }

  // Let go of it, quietly: another copy of the board is taking over, so the phones are not told it has gone.
  function stop(){
    closeDialog();
    $('rcChip').hidden = true;
    relay?.stop(false);
    relay = null;
    connection.releaseWake();
  }

  return { start, stop, publishStatus };
}
