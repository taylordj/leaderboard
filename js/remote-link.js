// The phone's side of the link to the big screen: the room code, connecting and reconnecting, sending
// commands, and following the big screen's confirmations. remote.js draws the page and decides what each
// tap sends.
//
// Every command carries a number (seq). The big screen's status confirms, for each phone, the latest
// command it has handled and whether that did anything ({ seq, ok }); every command before it has been
// handled too. Until then a command is waiting: it is sent again every RESEND_MS, at most RESEND_TRIES
// times (with the same number, so the big screen still counts it once), and remote.js is told when it has
// been handled, refused (handled, but it did nothing), or is still not confirmed after CONFIRM_TIMEOUT_MS.
//
// The phone says 'hello' when it connects, which closes the pairing dialog on the big screen. It also
// checks that the big screen is still there: after PING_AFTER_MS without hearing from it, it says hello
// again (which the big screen always answers), and if no answer comes within GONE_AFTER_MS it treats the
// big screen as gone. That catches a page that closed without saying goodbye.
import {
  STORAGE, RESEND_MS, RESEND_TRIES, CONFIRM_TIMEOUT_MS, PING_AFTER_MS, GONE_AFTER_MS, NO_CONNECTION_MS,
} from './config.js';
import { $, store, normaliseCode, isValidCode, randomId } from './util.js';
import { openRelay, manageConnection } from './relay.js';

// The page (remote.js) gives:
//   onChange()                            something changed (a status arrived, a link opened or dropped, or a
//                                         second passed): draw the page
//   onSettle({ handled, refused, late })  waiting commands the big screen has just dealt with, as send() made
//                                         them; refused is the one that was handled but did nothing (or null)
//   onNewRoom()                           joining a different room: forget what the last one showed
//   onPairing()                           the room code box is about to show: close anything over it
// -> { start, send, status, state, waiting, code }
export function initRemoteLink({ onChange, onSettle = () => {}, onNewRoom = () => {}, onPairing = () => {} }){
  const session = randomId();   // which phone sent a command
  let seq = 0;                  // numbers this phone's commands
  let relay = null;
  let code = '';
  let connectingSince = 0;
  let hadRelay = false;         // to say hello when the first relay connects
  let pingedAt = 0;             // when the big screen was last asked whether it is still there
  // Commands not confirmed yet, oldest first: { ...extra, seq, action, arg, at, sentAt, tries }
  let waiting = [];
  // After the phone wakes, it connects again exactly as it did the first time.
  const connection = manageConnection({ isLinked: () => !!relay, reconnect: () => { if(relay) connect(code); } });

  // ---------------------------------------------------------------- connecting

  function connect(newCode){
    if(newCode !== code){ waiting = []; onNewRoom(); }
    code = newCode;
    store.set(STORAGE.remoteCode, code);
    history.replaceState(null, '', `remote.html?code=${code}`);
    $('rmPair').hidden = true;
    $('rmPad').hidden = false;
    relay?.stop(false);
    connectingSince = Date.now();
    hadRelay = false;
    relay = openRelay({ role: 'remote', code, onChange: linkChanged });
    relay.start();
    hello();                    // reaches a big screen in this same browser at once; the relays get theirs when they connect
    update();
    connection.requestWake();
  }

  // A link opened or dropped, or a status arrived.
  function linkChanged(){
    const connected = !!relay && relay.connectedCount() > 0;
    if(connected && !hadRelay) hello();
    hadRelay = connected;
    update();
  }

  function showPairing(prefill){
    $('rmPad').hidden = true;
    onPairing();
    $('rmPair').hidden = false;
    $('rmCodeInput').value = prefill;
    syncCodeButton();
    relay?.stop(false);
    relay = null;
    connection.releaseWake();
    update();
  }

  function submitCode(){
    const c = normaliseCode($('rmCodeInput').value);
    if(isValidCode(c)) connect(c); else $('rmCodeInput').focus();
  }
  function syncCodeButton(){
    $('rmCodeBtn').disabled = !isValidCode(normaliseCode($('rmCodeInput').value));
  }

  // ---------------------------------------------------------------- sending

  function commandOf(c){
    const command = { from: session, seq: c.seq, action: c.action };
    if(c.arg !== undefined) command.arg = c.arg;
    return command;
  }

  // Send a command. `extra` stays with it while it waits: whatever the page needs to show it (its label,
  // say). -> the waiting command, or null if it could not be sent (no link)
  function send(action, arg, extra = {}){
    const now = Date.now();
    const c = { ...extra, seq: ++seq, action, arg, at: now, sentAt: now, tries: 0 };
    if(!relay || !relay.send(commandOf(c))) return null;
    waiting.push(c);
    return c;
  }

  // A hello does not wait for a confirmation: the big screen answers it with its status, but never confirms
  // it (a confirmation covers every command before it, so confirming a hello could pass off a lost command
  // as handled).
  function hello(){
    relay?.send({ from: session, seq: ++seq, action: 'hello' });
  }

  // ---------------------------------------------------------------- following the big screen

  // The big screen's latest status, or null if it is offline or has stopped answering.
  function status(){
    const s = relay?.latestStatus() ?? null;
    return s && Date.now() - relay.lastHeard() <= PING_AFTER_MS + GONE_AFTER_MS ? s : null;
  }

  // Gone quiet? Ask. A big screen that is still open always answers a hello at once, even from a background
  // tab whose own timers are slowed down.
  function checkStillThere(){
    if(!relay?.latestStatus()) return;
    const now = Date.now();
    if(now - relay.lastHeard() > PING_AFTER_MS && now - pingedAt > PING_AFTER_MS){
      pingedAt = now;
      hello();
    }
  }

  // Take off what the big screen has handled, and tell the page what it handled, what it refused, and what it
  // has not confirmed in time.
  function settle(){
    const ack = status()?.acks[session];
    const acked = ack?.seq ?? 0;
    const now = Date.now();
    const handled = waiting.filter((c) => c.seq <= acked);
    const late = waiting.filter((c) => c.seq > acked && now - c.at > CONFIRM_TIMEOUT_MS);
    if(!handled.length && !late.length) return;
    waiting = waiting.filter((c) => !handled.includes(c) && !late.includes(c));
    const refused = handled.find((c) => c.seq === ack.seq && !ack.ok) ?? null;
    onSettle({ handled, refused, late });
  }

  // Each waiting command goes out again every RESEND_MS, at most RESEND_TRIES times. Without this a tap is
  // lost if the big screen was not listening at that moment, for example in the second after it reloads.
  function resend(){
    if(!relay) return;
    const now = Date.now();
    for(const c of waiting){
      if(c.tries >= RESEND_TRIES || now - c.sentAt < RESEND_MS) continue;
      c.tries++;
      c.sentAt = now;
      relay.send(commandOf(c));
    }
  }

  function update(){
    settle();
    resend();
    onChange();
  }

  // How the link is, for the page's status pill:
  //   'none'        no room code yet (the room code box is showing)
  //   'ok'          the big screen is there (status() has its status)
  //   'failed'      the connection library did not load, and the big screen has not been heard in this browser
  //   'offline'     no relay has connected for NO_CONNECTION_MS
  //   'connecting'  no relay has connected yet
  //   'waiting'     connected, but the big screen has not been heard
  function state(){
    if(!relay) return 'none';
    if(status()) return 'ok';
    if(relay.failed) return 'failed';
    if(!relay.connectedCount()) return Date.now() - connectingSince > NO_CONNECTION_MS ? 'offline' : 'connecting';
    return 'waiting';
  }

  // ---------------------------------------------------------------- wiring

  $('rmCodeBtn').addEventListener('click', submitCode);
  $('rmCodeInput').addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); submitCode(); } });
  $('rmCodeInput').addEventListener('input', syncCodeButton);
  $('rmChange').addEventListener('click', () => showPairing(code));

  // Start with the code in the address, or the room this phone joined last time. Call it once the page is
  // ready to draw.
  function start(){
    const params = new URLSearchParams(location.search);
    let startCode = normaliseCode(params.get('code'));
    if(!isValidCode(startCode)) startCode = normaliseCode(store.get(STORAGE.remoteCode));
    if(isValidCode(startCode)) connect(startCode); else showPairing('');
    // the timeouts, "No connection", sending again and checking the big screen is still there all need a clock
    setInterval(() => { checkStillThere(); update(); }, 1000);
  }

  return { start, send, status, state, waiting: () => waiting, code: () => code };
}
