// Small helpers shared by both pages and the model. Nothing here runs on import, and nothing touches the
// page unless it is called, so model.js and the tests can use it in Node.
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

export function escapeHtml(value){
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function setText(el, text){
  if(el.textContent !== text) el.textContent = text;
}

// ---- saved settings (localStorage can be unavailable or full, so nothing here throws) ----
export const store = {
  get(key){ try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value){ try { localStorage.setItem(key, value); return true; } catch { return false; } },
  getJSON(key){ try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  setJSON(key, value){ return store.set(key, JSON.stringify(value)); },
};

// ---- ids and room codes ----
export function randomString(length, chars){
  const values = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}
export const newId = () => randomString(8, 'abcdefghijklmnopqrstuvwxyz0123456789');
export const newRoomCode = () => randomString(ROOM_CODE_LENGTH, ROOM_CODE_CHARS);
export const normaliseCode = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
export const isValidCode = (code) => /^[A-Z0-9]{4,12}$/.test(code ?? '');

// ---- the page ----

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
