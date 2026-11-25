// Only one copy of the board in this browser takes commands from the remote.
//
// Every copy of the board opened in the same browser shares the saved board and the room code, so two
// copies (an extra tab, or a window opened to cast to the TV) would both answer the phone, and their
// Undo histories would drift apart. So the copy with the remote holds a lock (the Web Locks API):
//   - the copy that already has it keeps it, so an accidental extra tab cannot take the TV over;
//   - a newer copy waits in line for it, and after a moment pauses and says so;
//   - "Use this window instead" takes the lock from the other copy, which pauses and waits in line;
//   - the browser lets go of the lock when the copy holding it closes, reloads or crashes, so the next
//     copy in line takes over by itself.
import { TOPIC_ROOT } from './config.js';

const LOCK = `${TOPIC_ROOT}board`;
// How long a new copy waits for the lock before it says another copy has it. A reload gets it straight
// back once the old page has let go, so this keeps the paused screen from flashing up then.
const PAUSE_AFTER_MS = 500;

// onActive(): this copy now has the remote. onPaused(): another copy has it.
// -> { claim() }, which takes the remote over.
export function oneBoard({ onActive, onPaused }){
  let state = '';          // '' while waiting for the lock at first, then 'active' or 'paused'
  let line = null;         // this copy's place in line for the lock, so claim() can leave it
  const become = (next) => {
    if(state === next) return;
    state = next;
    if(next === 'active') onActive(); else onPaused();
  };

  // no locks in this browser: this copy is on its own
  if(!navigator.locks?.request){ become('active'); return { claim(){} }; }

  // Holding the lock: it is kept until the page closes, because the promise never settles.
  const hold = () => { become('active'); return new Promise(() => {}); };
  // The lock was taken by another copy (AbortError): pause, and wait in line to get it back.
  // Any other error means locks are not allowed here, so this copy is on its own.
  function lost(err){
    if(err?.name !== 'AbortError'){ become('active'); return; }
    become('paused');
    waitInLine();
  }
  function waitInLine(){
    const mine = line = new AbortController();
    navigator.locks.request(LOCK, { signal: mine.signal }, hold)
      .catch((err) => { if(!mine.signal.aborted) lost(err); });     // aborted: claim() took it instead
  }

  waitInLine();
  setTimeout(() => { if(!state) become('paused'); }, PAUSE_AFTER_MS);

  return {
    claim(){
      if(state === 'active') return;
      line?.abort();
      navigator.locks.request(LOCK, { steal: true }, hold).catch(lost);
    },
  };
}
