// The big screen's side of the phone remote: the pairing dialog (QR code, room code, address), the chip
// that shows how the link is, running commands from phones, and telling them what is going on.
//
// The dialog opens by itself while no phone has connected to this room code, and closes by itself when a
// new phone connects (not when one that is already connected checks in, so it never snatches the QR code
// away from someone about to scan it).
import { APP_ID, STORAGE, MAX_ACKS } from './config.js';
import { $, store, newRoomCode, normaliseCode, isValidCode, armConfirm } from './util.js';
import { openRelay, manageConnection } from './relay.js';

// perform(action, arg): runs a command from a phone. -> true if it did something (display.js)
// getStatus(): what the phones should be told right now (display.js)
// -> { start, stop }
//
// A command's ack goes out in the status straight after it is handled, together with the change it made,
// so a phone never sees a change without knowing it was its own tap (it would count the tap twice for a
// moment).
export function initDisplayRemote({ perform, getStatus }){
  let code = '';
  let relay = null;        // null while the remote is off
  // phone -> { seq, ok }: the last command handled from it, and whether it did anything
  const acks = new Map();
  // the phones that have said hello since the remote started, so that only a new one closes the dialog
  const phones = new Set();
  let lastPublished = '';
  const connection = manageConnection({
    isLinked: () => !!relay,
    reconnect: () => relay?.start(),
    onLeave: () => relay?.stop(true),
  });

  // The QR code and Copy link carry the full link, code included. The dialog shows the address instead, short
  // enough to type on a phone with no camera: it opens the remote, which asks for the code.
  const remoteUrl = () => new URL(`remote.html?code=${code}`, location.href).toString();
  const remoteAddress = () => `${location.host}${location.pathname.replace(/[^/]*$/, '')}remote.html`;
  const isPaired = () => store.get(STORAGE.paired) === code;

  function onCommand(cmd){
    if(cmd.action === 'hello'){
      // A phone saying it is there: when it connects, and when it has not heard from the big screen for a
      // while. It is answered with the status but not confirmed: a confirmation covers every command before
      // it, so confirming a hello could pass off one of that phone's commands that was lost as handled.
      if(!phones.has(cmd.from)){
        phones.add(cmd.from);
        if(phones.size > MAX_ACKS) phones.delete(phones.values().next().value);
        phoneConnected();
      }
      publishStatus(true);
      return;
    }
    const ok = !!perform(cmd.action, cmd.arg);
    acks.delete(cmd.from);                 // newest last, so the oldest phone is the one dropped
    acks.set(cmd.from, { seq: cmd.seq, ok });
    if(acks.size > MAX_ACKS) acks.delete(acks.keys().next().value);
    publishStatus();                       // the ack has changed, so this always goes out
  }

  function phoneConnected(){
    store.set(STORAGE.paired, code);
    if(!$('remoteModal').hidden){ closeDialog(); toast('📱 Remote connected'); }
    renderUi();
  }

  // Tell the phones what is going on, if anything in it has changed (or anyway, to answer a hello).
  // So it is fine to call this as often as the page likes.
  function publishStatus(force = false){
    if(!relay) return;
    const status = { ...getStatus(), acks: Object.fromEntries(acks) };
    const text = JSON.stringify(status);
    if(text === lastPublished && !force) return;
    lastPublished = text;
    relay.publishStatus(status);
  }

  // (Re)connect with the current code. A relay already open says goodbye on its old code first.
  function connect(){
    relay?.stop(true);
    lastPublished = '';
    relay = openRelay({ role: 'display', code, onCommand, onChange: renderUi });
    relay.start();         // draws the chip and the dialog (onChange)
    publishStatus();
    connection.requestWake();
  }

  // The chip and the dialog's status line.
  function renderUi(){
    const connected = relay ? relay.connectedCount() : 0;
    const kind = relay?.failed ? 'bad' : connected ? 'ok' : 'warn';
    $('rcDot').className = `dot ${kind}`;
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
    if(typeof window.qrcode !== 'function'){ box.innerHTML = '<div class="rc-qr-note">QR code unavailable.<br>Use the address below.</div>'; return; }
    const qr = window.qrcode(0, 'M');
    qr.addData(remoteUrl());
    qr.make();
    const n = qr.getModuleCount(), quiet = 3, size = n + quiet * 2;
    let path = '';
    for(let r = 0; r < n; r++){
      for(let c = 0; c < n; c++) if(qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
    // the dark squares take the page's own dark colour from base.css (black without it)
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img"`
      + ` aria-label="QR code that opens the remote on a phone"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}"/></svg>`;
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
    phones.clear();
    connect();
    openDialog();          // redraws the QR code and the address
  });

  function openDialog(){
    if(!relay) return;     // the remote is off: start() turns it on
    renderQr();
    $('rcLink').textContent = remoteAddress();
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
      btn.textContent = ok ? 'Copied ✓' : 'Could not copy';
      setTimeout(() => { btn.textContent = 'Copy link'; }, 1800);
    };
    if(navigator.clipboard?.writeText) navigator.clipboard.writeText(remoteUrl()).then(() => done(true), () => done(false));
    else done(false);
  });
  // The remote on this computer gets a small window of its own, beside the big screen rather than over it.
  // (If the browser blocks the window, the link opens a tab as usual.)
  $('rcHere').addEventListener('click', (e) => {
    if(window.open(remoteUrl(), `${APP_ID}-remote`, 'popup,width=420,height=860')) e.preventDefault();
  });

  // Turn the remote on: read the room code (another copy of the big screen may have changed it), connect,
  // and show the pairing dialog if no phone has used this code yet.
  function start(){
    if(relay) return;
    code = normaliseCode(store.get(STORAGE.displayCode));
    if(!isValidCode(code)){ code = newRoomCode(); store.set(STORAGE.displayCode, code); }
    acks.clear();
    phones.clear();
    $('rcChip').hidden = false;
    connect();
    if(!isPaired()) openDialog();
  }

  // Turn it off, when another copy of the board is taking the remote over (one-board.js). The phones are not
  // told the board has gone, because the other copy carries on in its place.
  function stop(){
    closeDialog();
    $('rcChip').hidden = true;
    relay?.stop(false);
    relay = null;
    connection.releaseWake();
  }

  return { start, stop };
}
