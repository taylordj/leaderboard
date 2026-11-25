// Small helpers shared by both pages and by the rules. Nothing here runs on import, and nothing touches the
// page unless it is called, so a rules module can import it and still run without a page.
import { ROOM_CODE_CHARS, ROOM_CODE_LENGTH } from './config.js';

export const $ = (id) => document.getElementById(id);
export const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// 1 -> "1st", 22 -> "22nd"
export function ordinal(n){
  const lastTwo = n % 100;
  if(lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

// "+5" / "−5" (a real minus sign, which reads better on a big screen)
export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

// ---- text ----
// Text from a phone, a relay or storage, made fit to show on one line: invisible and bidirectional
// formatting characters are dropped (they could hide text, or run it backwards), control characters and
// runs of spaces become one space, and it is trimmed and cut to `max` code points (never splitting a
// surrogate pair) without leaving a space at the end.
const HIDDEN = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069]/g;
export function cleanText(value, max = Infinity){
  if(typeof value !== 'string') return '';
  const line = value.replace(HIDDEN, '').replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
  return Array.from(line).slice(0, max).join('').trim();
}
export function escapeHtml(value){
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---- saved settings (localStorage can be unavailable or full, so nothing here throws) ----
export const store = {
  get(key){ try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value){ try { localStorage.setItem(key, value); return true; } catch { return false; } },
  remove(key){ try { localStorage.removeItem(key); } catch { /* nothing to do */ } },
  getJSON(key){ try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  setJSON(key, value){ return store.set(key, JSON.stringify(value)); },
};

// ---- ids and room codes ----
function randomString(length, chars){
  const values = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}
// A random id of lower-case letters and digits (phones, connections, and anything else that needs one), and
// the check that something could be one (an id that came from a relay or from storage).
export const randomId = (length = 8) => randomString(length, 'abcdefghijklmnopqrstuvwxyz0123456789');
export const isId = (id) => typeof id === 'string' && /^[a-z0-9]{1,16}$/i.test(id);
export const newRoomCode = () => randomString(ROOM_CODE_LENGTH, ROOM_CODE_CHARS);
export const normaliseCode = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
export const isValidCode = (code) => /^[A-Z0-9]{4,12}$/.test(code ?? '');

// ---- the page ----
export function setText(el, text){
  if(el.textContent !== text) el.textContent = text;
}
// Replay a CSS animation that is triggered by a class.
export function restartAnimation(el, className){
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

// Tap-twice buttons for anything that throws something away: the first tap changes the label,
// a second tap within 3 seconds confirms.
export function armConfirm(btn, armedLabel, onConfirm){
  const idleLabel = btn.textContent;
  let timer = null;
  const reset = () => { timer = null; btn.textContent = idleLabel; btn.classList.remove('armed'); };
  const disarm = () => { if(timer){ clearTimeout(timer); reset(); } };
  btn.addEventListener('click', () => {
    if(timer){ disarm(); onConfirm(); return; }
    btn.textContent = armedLabel;
    btn.classList.add('armed');
    timer = setTimeout(reset, 3000);
  });
  return { disarm };
}

// Confetti over the whole screen, for a winner: two waves of pieces in `colours` and, given `emoji`, a few
// of those popping up among them. `layer` is a .confetti-layer (base.css). Each piece removes itself once
// it has fallen, so one burst never cuts another short. Nothing at all for anyone who asks their device
// for less motion.
export function confetti(layer, colours, emoji = []){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  function add(className, styles, text = ''){
    const piece = document.createElement('i');
    piece.className = className;
    piece.textContent = text;
    for(const [prop, value] of Object.entries(styles)) piece.style.setProperty(prop, value);
    piece.addEventListener('animationend', () => piece.remove());
    layer.append(piece);
  }
  const wave = () => {
    for(let i = 0; i < 120; i++){
      const size = rand(6, 14);
      add('confetti', {
        left: `${rand(0, 100)}%`, width: `${size}px`, height: `${size * 1.4}px`, background: pick(colours),
        '--drift': `${rand(-80, 80)}px`, 'animation-duration': `${rand(2.4, 4.8)}s`, 'animation-delay': `${rand(0, 1.5)}s`,
      });
    }
  };
  wave();
  setTimeout(wave, 650);
  for(let i = 0; emoji.length && i < 12; i++){
    add('confetti-emoji', {
      left: `${rand(5, 95)}%`, top: `${rand(35, 75)}%`, 'font-size': `${rand(22, 42)}px`, 'animation-delay': `${rand(0, 1.4)}s`,
    }, pick(emoji));
  }
}

// The big screen is laid out at a fixed size (`stage`, inside `app`) and scaled to fit the screen, inside a
// margin that keeps clear of TV overscan and rounded tablet corners, so it is always all in view with no
// scrollbars. base.css centres the stage in `app`, so it scales about its middle. It is fitted now, and
// again whenever the screen or the stage changes size (including when the fonts arrive), so call it once
// the stage has been drawn.
// -> { scale() }: the scale right now, for anything measured on screen.
export function fitStage(app, stage, minMargin = 24){
  let scale = 1;
  let queued = false;
  function fit(){
    queued = false;
    const w = stage.offsetWidth, h = stage.offsetHeight;
    if(!w || !h) return;
    const margin = Math.max(minMargin, Math.round(Math.min(app.clientWidth, app.clientHeight) * 0.045));
    scale = clamp(Math.min((app.clientWidth - 2 * margin) / w, (app.clientHeight - 2 * margin) / h), 0.15, 2.6);
    stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }
  const resized = new ResizeObserver(() => {
    if(queued) return;
    queued = true;
    requestAnimationFrame(fit);
  });
  resized.observe(app);
  resized.observe(stage);
  fit();
  return { scale: () => scale };
}
