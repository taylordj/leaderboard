// What the phone and the TV say to each other in the Leaderboard. relay.js carries it, and checks the parts
// that belong to the link itself (the version, who sent a command, the confirmations); this file has the rest.
//   commands  phone -> TV:  one of ACTIONS ('undo' is display.js's, the rest are rules in rules.js)
//   status    TV -> phone:  { board, undo }: the whole board, and what Undo would undo
import { ACTIONS, sanitizeBoard } from './rules.js';

export { ACTIONS };

// The Leaderboard's part of a status from the TV, cleaned. -> null if it has no board.
export function readStatus(o){
  const board = sanitizeBoard(o.board);
  if(!board) return null;
  return {
    board,
    // longer than any label rules.js makes, because the phone sends it back to name what to undo
    undo: typeof o.undo === 'string' && o.undo ? o.undo.slice(0, 200) : null,
  };
}
