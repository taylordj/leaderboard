// The link between the TV and the phone, through free public MQTT relays (config.RELAYS).
// Every relay is used at once, so the link works as long as any one of them is up. That means the same
// message can arrive more than once: the TV ignores repeats.
//
// There is one more link alongside the relays: a BroadcastChannel, which joins pages open in the same
// browser. A remote opened in a second tab on the TV's laptop therefore works with no internet at all.
//
// Topics, for a room code such as A7K2QX:
//   danslb/2/A7K2QX/cmd     phone -> TV   { v, from, seq, action, arg? }
//   danslb/2/A7K2QX/status  TV -> phone   { v, online, at, board, undo, acks: { [from]: { seq, ok } } }
// The status message is "retained", so a phone that joins later gets it at once. If the TV disappears,
// the relays publish its last-will message { v, online:false } in its place.
// The room code is the only thing protecting a room, and anything can arrive on a public relay,
// so every message is checked here before it is used.
import { RELAYS, TOPIC_ROOT, PROTOCOL_VERSION, HEARTBEAT_MS, ACTIONS, MAX_ACKS } from './config.js';
import { randomId } from './util.js';
import { sanitizeBoard } from './model.js';

const isSender = (from) => typeof from === 'string' && from.length > 0 && from.length <= 16;

// -> {from, seq, action, arg} or null
export function parseCommand(raw){
  if(typeof raw !== 'string' || raw.length > 4000) return null;
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if(!m || m.v !== PROTOCOL_VERSION || !ACTIONS.includes(m.action)) return null;
  if(!isSender(m.from) || !Number.isInteger(m.seq)) return null;
  return { from: m.from, seq: m.seq, action: m.action, arg: m.arg };
}

// -> a clean status { at, board, undo, acks }, or null if the TV is offline (or it is not one of ours).
// acks: for each phone, the last command the TV handled from it, and whether it changed the board.
export function parseStatus(raw){
  if(typeof raw !== 'string' || raw.length > 60000) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if(!o || o.v !== PROTOCOL_VERSION || o.online !== true) return null;
  const board = sanitizeBoard(o.board);
  if(!board) return null;
  const acks = {};
  for(const [from, ack] of Object.entries(o.acks && typeof o.acks === 'object' ? o.acks : {}).slice(0, MAX_ACKS)){
    if(isSender(from) && Number.isInteger(ack?.seq)) acks[from] = { seq: ack.seq, ok: ack.ok !== false };
  }
  return {
    at: Number.isFinite(o.at) ? o.at : 0,
    board,
    // longer than any label model.js makes, because the phone sends it back to name what to undo
    undo: typeof o.undo === 'string' && o.undo ? o.undo.slice(0, 200) : null,
    acks,
  };
}

const decode = (payload) => (typeof payload === 'string' ? payload : new TextDecoder().decode(payload));

// role 'display': listens for commands (onCommand) and publishes its status.
// role 'remote':  sends commands and keeps the TV's latest status (latestStatus()).
// onChange() runs whenever a connection opens or drops, or a new status arrives.
export function openRelay({ role, code, onCommand = () => {}, onChange = () => {} }){
  const cmdTopic = `${TOPIC_ROOT}${code}/cmd`;
  const statusTopic = `${TOPIC_ROOT}${code}/status`;
  const offline = JSON.stringify({ v: PROTOCOL_VERSION, online: false });
  const isDisplay = role === 'display';
  let links = [];          // one per relay, plus the same-browser link: { client, connected, status, closed, local }
  let heartbeat = null;
  let status = null;       // TV: the status to publish
  const seen = new Set();  // TV: commands already handled ("from:seq")
  const seenOrder = [];

  const statusText = () => JSON.stringify({ v: PROTOCOL_VERSION, online: true, at: Date.now(), ...status });
  const publishToAll = (topic, message, options) => {
    let count = 0;
    for(const link of links){
      if(!link.connected) continue;
      try { link.client.publish(topic, message, options); count++; } catch { /* that relay just dropped */ }
    }
    return count;
  };

  const hearing = () => links.filter((link) => link.connected && link.status);   // phone: links the TV is online on

  function handleMessage(link, topic, payload){
    const raw = decode(payload);
    if(isDisplay && topic === cmdTopic){
      const cmd = parseCommand(raw);
      if(!cmd) return;
      const id = `${cmd.from}:${cmd.seq}`;
      if(seen.has(id)) return;              // the same press, arriving through another relay
      seen.add(id); seenOrder.push(id);
      if(seenOrder.length > 500) seen.delete(seenOrder.shift());
      onCommand(cmd);
    } else if(!isDisplay && topic === statusTopic){
      link.status = parseStatus(raw);
      link.heardAt = Date.now();          // this device's clock, so it can be compared with Date.now()
      onChange();
    }
  }

  function connect(url){
    const options = {
      clientId: `lb${role[0]}${randomId(9)}`,
      clean: true, keepalive: 15, reconnectPeriod: 2500, connectTimeout: 8000, protocolVersion: 4,
    };
    if(isDisplay) options.will = { topic: statusTopic, payload: offline, qos: 1, retain: true };
    const link = { client: null, connected: false, status: null, closed: false, local: false };
    try { link.client = window.mqtt.connect(url, options); } catch { return null; }
    const lost = () => { if(link.closed) return; link.connected = false; link.status = null; onChange(); };
    link.client.on('connect', () => {
      if(link.closed) return; // stopped while it was still connecting
      link.connected = true;
      if(isDisplay){
        link.client.subscribe(cmdTopic, { qos: 0 });
        if(status) link.client.publish(statusTopic, statusText(), { qos: 1, retain: true });
      } else {
        link.client.subscribe(statusTopic, { qos: 1 });
      }
      onChange();
    });
    link.client.on('close', lost);
    link.client.on('offline', lost);
    link.client.on('error', () => { /* mqtt.js keeps retrying by itself */ });
    link.client.on('message', (topic, payload) => { if(!link.closed) handleMessage(link, topic, payload); });
    return link;
  }

  // Pages in the same browser hear each other through a BroadcastChannel. It behaves like one more
  // relay that is always connected, except that nothing is retained: a remote says 'hello' when it
  // opens, and the TV answers with its status.
  function connectLocal(){
    if(typeof BroadcastChannel !== 'function') return null;
    let channel;
    try { channel = new BroadcastChannel(`${TOPIC_ROOT}${code}`); } catch { return null; }
    const link = {
      connected: true, status: null, closed: false, local: true,
      client: {
        publish(topic, message){ channel.postMessage({ topic, message }); },
        end(){ channel.close(); },
      },
    };
    channel.onmessage = (e) => {
      const d = e.data;
      if(!link.closed && d && typeof d.topic === 'string' && typeof d.message === 'string') handleMessage(link, d.topic, d.message);
    };
    return link;
  }

  const relay = {
    failed: false,         // true if the MQTT library is missing (vendor/mqtt.min.js did not load)

    start(){
      relay.stop(false);
      relay.failed = !window.mqtt || typeof window.mqtt.connect !== 'function';
      links = [connectLocal(), ...(relay.failed ? [] : RELAYS.map(connect))].filter(Boolean);
      // re-announce regularly, so a stale "offline" from a relay always corrects itself
      if(isDisplay) heartbeat = setInterval(() => { if(status) publishToAll(statusTopic, statusText(), { qos: 0, retain: true }); }, HEARTBEAT_MS);
      onChange();
    },

    // goodbye: tell phones the TV has gone (the page is closing, or it has a new code). Without it, the
    // connections still end cleanly, so the relays do not announce the TV as gone on its behalf: that
    // matters when it is only reconnecting, or handing the remote to another copy of the board.
    stop(goodbye){
      clearInterval(heartbeat); heartbeat = null;
      const old = links;
      links = [];
      for(const link of old){
        if(goodbye && isDisplay && link.connected){
          try { link.client.publish(statusTopic, offline, { qos: 1, retain: true }); } catch { /* closing anyway */ }
        }
        link.closed = true;
        const force = !link.connected;     // a connection that is not up cannot say goodbye cleanly
        setTimeout(() => { try { link.client.end(force); } catch { /* already closed */ } }, goodbye ? 350 : 0);
      }
    },

    // How many internet relays are connected (the same-browser link is not counted).
    connectedCount: () => links.filter((l) => l.connected && !l.local).length,

    // ---- TV ----
    publishStatus(newStatus){
      status = newStatus;
      publishToAll(statusTopic, statusText(), { qos: 0, retain: true });
    },

    // ---- phone ----
    // -> how many links it went out on (0 = not sent)
    send(command){
      return publishToAll(cmdTopic, JSON.stringify({ v: PROTOCOL_VERSION, ...command }), { qos: 0 });
    },
    // The newest status from any link, or null if the TV is not online.
    latestStatus(){
      return hearing().reduce((newest, link) => (!newest || link.status.at >= newest.at ? link.status : newest), null);
    },
    // When this phone last heard the TV on any link (0 = never).
    lastHeard: () => Math.max(0, ...hearing().map((link) => link.heardAt)),
  };
  return relay;
}

// Keeps a link healthy on phones and tablets: reconnects after the device wakes or comes back online
// (sockets opened before it slept are often dead), and keeps the screen awake while linked.
//   isLinked()   is there a link right now?
//   reconnect()  start the link again from scratch
//   onLeave()    the page is closing (the TV says goodbye to the phones)
export function manageConnection({ isLinked, reconnect, onLeave }){
  let hiddenAt = 0;
  let wakeLock = null;

  async function requestWake(){
    if(!isLinked() || wakeLock || document.hidden || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* not allowed right now; tried again on the next tap */ }
  }
  function releaseWake(){
    if(wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if(document.hidden){ hiddenAt = Date.now(); return; }
    if(hiddenAt && Date.now() - hiddenAt > 4000) reconnect();
    requestWake();
  });
  window.addEventListener('online', reconnect);
  window.addEventListener('pageshow', (e) => { if(e.persisted) reconnect(); });
  if(onLeave) window.addEventListener('pagehide', onLeave);
  document.addEventListener('pointerdown', requestWake, { passive: true });

  return { requestWake, releaseWake };
}
