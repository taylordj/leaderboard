// Only one copy of the board in this browser takes commands from the remote.
//
// Every copy of the board opened in the same browser shares the saved board and the room code, so two
// copies (an extra tab, or a window opened to cast to the TV) would both answer the phone, and their
// Undo histories would drift apart. So the copies talk to each other:
//   - the copy that already has the remote keeps it, so an accidental extra tab cannot take the TV over;
//   - a newer copy pauses and says so, and "Use this window instead" moves the remote to it;
//   - if the copy with the remote closes, a paused one takes over by itself.
//
// Messages on the BroadcastChannel 'danslb/2/boards', each with the sender's `id`:
//   { type:'ask' }          a new copy: is anyone in charge?
//   { type:'active', at }   I have the remote (since `at`). The later claim wins if two copies claim at once.
//   { type:'gone' }         the copy with the remote is closing.
import { TOPIC_ROOT } from './config.js';
import { randomId } from './util.js';

const LISTEN_MS = 400;   // how long a new copy listens for one that is already in charge

// onActive(): this copy now has the remote. onPaused(): another copy has it.
// -> { claim() }, which takes the remote over.
export function oneBoard({ onActive, onPaused }){
  const id = randomId(10);
  let state = '';          // '' while listening, then 'active' or 'paused'
  let claimedAt = 0;
  let activeId = '';       // when paused: the copy that has the remote
  let channel = null;
  try { channel = new BroadcastChannel(`${TOPIC_ROOT}boards`); } catch { /* no channel: this copy is on its own */ }
  const post = (message) => channel?.postMessage({ ...message, id });
  const announce = () => post({ type: 'active', at: claimedAt });

  function become(next){
    if(state === next) return;
    state = next;
    if(next === 'active') onActive(); else onPaused();
  }
  function claim(){
    claimedAt = Date.now();
    announce();
    become('active');
  }

  if(channel) channel.onmessage = ({ data: m }) => {
    if(!m || typeof m !== 'object' || m.id === id) return;
    if(m.type === 'ask'){
      if(state === 'active') announce();
    } else if(m.type === 'active' && typeof m.at === 'number'){
      const theirsIsLater = m.at > claimedAt || (m.at === claimedAt && m.id > id);
      if(state !== 'active' || theirsIsLater){ activeId = m.id; become('paused'); }
      else announce();     // an older claim (from a copy that was asleep, say): remind it who is in charge
    } else if(m.type === 'gone' && state === 'paused' && m.id === activeId){
      claim();
    }
  };

  window.addEventListener('pagehide', () => { if(state === 'active') post({ type: 'gone' }); });
  // back from the browser's back/forward cache: someone else may have taken over meanwhile
  window.addEventListener('pageshow', (e) => { if(e.persisted && state === 'active') post({ type: 'ask' }); });

  post({ type: 'ask' });
  setTimeout(() => { if(!state) claim(); }, channel ? LISTEN_MS : 0);
  return { claim };
}
