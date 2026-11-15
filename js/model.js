// All the scoreboard rules. Pure data: no page, no storage, no network, so it can be tested in Node.
//
// A board looks like this:
//   {
//     title:        string,
//     powerups:     [ { id, name, icon } ],
//     teams:        [ { id, name, color, score, used: { [powerupId]: true } } ],
//     scoresHidden: boolean    -- the TV shows the teams but not the scores
//     revealed:     [teamId]   -- while hidden: the teams the host has revealed so far (see nextReveal)
//   }
// Every team has one of each powerup. A powerup is either available or used; there are no counts.
//
// Boards are never changed in place: apply() returns a new one. The TV keeps the old ones for Undo.
import {
  DEFAULT_TITLE, DEFAULT_TEAMS, DEFAULT_POWERUPS, DEFAULT_ICON, PALETTE,
  MAX_TEAMS, MAX_POWERUPS, NAME_MAX, TITLE_MAX, ICON_MAX, MAX_ADJUST, MAX_SCORE,
} from './config.js';
import { clamp, randomId, ordinal, signed } from './util.js';

// ---------------------------------------------------------------- cleaning input

// Collapse spaces, trim, and cut to `max` characters (counting an emoji as one, never splitting it).
export function cleanText(value, max){
  if(typeof value !== 'string') return '';
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}
export function cleanIcon(value){
  if(typeof value !== 'string') return '';
  return Array.from(value.replace(/\s+/g, '')).slice(0, ICON_MAX).join('');
}
const isId = (id) => typeof id === 'string' && /^[a-z0-9]{1,16}$/i.test(id);
const clampScore = (n) => clamp(n, -MAX_SCORE, MAX_SCORE);

// The first colour in the palette that no team is using yet.
function freeColor(teams){
  return PALETTE.find((c) => !teams.some((t) => t.color === c)) ?? PALETTE[teams.length % PALETTE.length];
}

// ---------------------------------------------------------------- boards

export function defaultBoard(){
  const powerups = DEFAULT_POWERUPS.map((p) => ({ id: randomId(), name: p.name, icon: p.icon }));
  const teams = DEFAULT_TEAMS.map((name, i) => ({
    id: randomId(), name, color: PALETTE[i % PALETTE.length], score: 0, used: {},
  }));
  return { title: DEFAULT_TITLE, powerups, teams, scoresHidden: false, revealed: [] };
}

// Anything (from storage, or from the network) -> a board that is safe to use, or null if it is not
// a board at all. Bad teams and powerups are dropped, and every limit is applied.
export function sanitizeBoard(raw){
  if(!raw || typeof raw !== 'object' || !Array.isArray(raw.teams) || !Array.isArray(raw.powerups)) return null;

  const powerups = [];
  for(const p of raw.powerups){
    if(powerups.length >= MAX_POWERUPS) break;
    if(!p || !isId(p.id) || powerups.some((x) => x.id === p.id)) continue;
    const name = cleanText(p.name, NAME_MAX);
    if(!name) continue;
    powerups.push({ id: p.id, name, icon: cleanIcon(p.icon) || DEFAULT_ICON });
  }

  const teams = [];
  for(const t of raw.teams){
    if(teams.length >= MAX_TEAMS) break;
    if(!t || !isId(t.id) || teams.some((x) => x.id === t.id)) continue;
    const name = cleanText(t.name, NAME_MAX);
    if(!name) continue;
    const score = Number.isInteger(t.score) ? clampScore(t.score) : 0;
    const used = {};
    if(t.used && typeof t.used === 'object'){
      for(const p of powerups) if(t.used[p.id] === true) used[p.id] = true;
    }
    teams.push({ id: t.id, name, color: PALETTE.includes(t.color) ? t.color : freeColor(teams), score, used });
  }

  const title = typeof raw.title === 'string' ? cleanText(raw.title, TITLE_MAX) : DEFAULT_TITLE;
  const scoresHidden = raw.scoresHidden === true;
  const revealed = scoresHidden && Array.isArray(raw.revealed)
    ? teams.filter((t) => raw.revealed.includes(t.id)).map((t) => t.id)
    : [];
  return { title, powerups, teams, scoresHidden, revealed };
}

// ---------------------------------------------------------------- standings

// Teams from highest score to lowest. Teams on the same score keep their setup order.
export const ranked = (board) => board.teams.slice().sort((a, b) => b.score - a.score);

// Equal scores are a genuine tie:
//   rankOf[id]  competition ranking: two teams tied for 1st are both 1st, and the next team is 3rd.
//   groups      each score once, highest first, with the teams on it (in the order given):
//               [{ score, teams }]. Gaps are measured between groups, so a tie never shows "+0".
//   allLevel    every team is on the same score (e.g. before the first point), so nobody is leading.
export function rankInfo(teams){
  const scores = [...new Set(teams.map((t) => t.score))].sort((a, b) => b - a);
  const rankOf = {};
  for(const t of teams) rankOf[t.id] = teams.filter((x) => x.score > t.score).length + 1;
  const groups = scores.map((score) => ({ score, teams: teams.filter((t) => t.score === score) }));
  return { rankOf, groups, allLevel: groups.length <= 1 };
}

// How far a team is from the others.
//   Leader:     { leader: true, ahead }   (ahead: points clear of the next score, or null if none)
//   Everyone:   { leader: false, toFirst, first, toNext, next }
//               first is the leaders' group; next is the group just above, with toNext the gap to it.
//               next and toNext are null when the group just above is the leaders.
export function gaps(team, info){
  const { groups } = info;
  const pos = groups.findIndex((g) => g.score === team.score);
  if(pos === 0) return { leader: true, ahead: groups.length > 1 ? team.score - groups[1].score : null };
  const next = pos > 1 ? groups[pos - 1] : null;
  return { leader: false, toFirst: groups[0].score - team.score, first: groups[0], toNext: next ? next.score - team.score : null, next };
}

// While the scores are hidden: what the next tap of Next reveals, which is the lowest score not revealed
// yet. Teams on the same score are revealed together. -> null if nothing is left to reveal, or
//   { teams, place, who, label, left, last }
//   place  "4th", "=2nd", or "the winner" ("the winners" for a tie)
//   who    "Team Delta", "Team Beta & Team Gamma", or "Team Beta & 2 more"
//   label  "Revealed 4th: Team Delta", which is the label for Undo, and what the phone sends to name
//          the reveal it means
//   left   how many taps of Next are left, this one included
//   last   this tap is the last one: it shows the scores
export function nextReveal(board){
  if(!board.scoresHidden) return null;
  const waiting = board.teams.filter((t) => !board.revealed.includes(t.id));
  if(!waiting.length) return null;
  const scores = [...new Set(waiting.map((t) => t.score))].sort((a, b) => a - b);
  const teams = waiting.filter((t) => t.score === scores[0]);
  const rank = board.teams.filter((t) => t.score > scores[0]).length + 1;
  const tied = teams.length > 1;
  const place = rank === 1 ? `the winner${tied ? 's' : ''}` : `${tied ? '=' : ''}${ordinal(rank)}`;
  const who = !tied ? teams[0].name
    : teams.length === 2 ? `${teams[0].name} & ${teams[1].name}`
    : `${teams[0].name} & ${teams.length - 1} more`;
  return { teams, place, who, label: `Revealed ${place}: ${who}`, left: scores.length, last: scores.length === 1 };
}

// Once the first place is revealed, nothing may change the standings until the reveal ends, or the order
// on the TV would no longer be the true one. Undo (back to before the reveal) or Show now unlocks them.
const REVEAL_LOCKS = new Set(['adjust-score', 'add-team', 'remove-team', 'reset-round']);
export const isRevealing = (board) => board.revealed.length > 0;
export const lockedByReveal = (board, action) => isRevealing(board) && REVEAL_LOCKS.has(action);

// ---------------------------------------------------------------- changes

const findTeam = (board, id) => board.teams.find((t) => t.id === id);
const findPowerup = (board, id) => board.powerups.find((p) => p.id === id);

// Each rule changes `b` (already a copy) and returns a short description for Undo,
// or null if the command makes no sense (unknown team, bad amount, limit reached…).
const RULES = {
  'adjust-score'(b, a){
    const team = findTeam(b, a.team);
    if(!team || !Number.isInteger(a.amount) || a.amount === 0 || Math.abs(a.amount) > MAX_ADJUST) return null;
    team.score = clampScore(team.score + a.amount);
    return `${signed(a.amount)} ${team.name}`;
  },

  'set-powerup'(b, a){
    const team = findTeam(b, a.team);
    const powerup = findPowerup(b, a.powerup);
    if(!team || !powerup || typeof a.used !== 'boolean') return null;
    if(a.used) team.used[powerup.id] = true; else delete team.used[powerup.id];
    return `${powerup.name} ${a.used ? 'used' : 'given back'}: ${team.name}`;
  },

  'add-team'(b, a){
    const name = cleanText(a.name, NAME_MAX);
    if(!name || b.teams.length >= MAX_TEAMS) return null;
    b.teams.push({ id: randomId(), name, color: freeColor(b.teams), score: 0, used: {} });
    return `Added ${name}`;
  },

  'rename-team'(b, a){
    const team = findTeam(b, a.team);
    const name = cleanText(a.name, NAME_MAX);
    if(!team || !name) return null;
    const old = team.name;
    team.name = name;
    return `Renamed ${old}`;
  },

  'set-team-color'(b, a){
    const team = findTeam(b, a.team);
    if(!team || !PALETTE.includes(a.color)) return null;
    team.color = a.color;
    return `Colour of ${team.name}`;
  },

  'remove-team'(b, a){
    const team = findTeam(b, a.team);
    if(!team) return null;
    b.teams = b.teams.filter((t) => t !== team);
    return `Removed ${team.name}`;
  },

  'add-powerup'(b, a){
    const name = cleanText(a.name, NAME_MAX);
    if(!name || b.powerups.length >= MAX_POWERUPS) return null;
    b.powerups.push({ id: randomId(), name, icon: cleanIcon(a.icon) || DEFAULT_ICON });
    return `Added ${name}`;     // every team has it at once: "not in used" means available
  },

  'edit-powerup'(b, a){
    const powerup = findPowerup(b, a.powerup);
    if(!powerup || (a.name === undefined && a.icon === undefined)) return null;
    const old = powerup.name;
    if(a.name !== undefined){
      const name = cleanText(a.name, NAME_MAX);
      if(!name) return null;
      powerup.name = name;
    }
    if(a.icon !== undefined){
      const icon = cleanIcon(a.icon);
      if(!icon) return null;
      powerup.icon = icon;
    }
    return `Edited ${old}`;
  },

  'remove-powerup'(b, a){
    const powerup = findPowerup(b, a.powerup);
    if(!powerup) return null;
    b.powerups = b.powerups.filter((p) => p !== powerup);
    for(const t of b.teams) delete t.used[powerup.id];
    return `Removed ${powerup.name}`;
  },

  'set-title'(b, a){
    if(typeof a.title !== 'string') return null;
    b.title = cleanText(a.title, TITLE_MAX);
    return 'Title';
  },

  'reset-round'(b){
    for(const t of b.teams){ t.score = 0; t.used = {}; }      // hidden scores stay hidden
    return 'Reset round';
  },

  // Hiding the scores, then revealing them one place at a time, last place first. Each tap of Next is
  // a change of its own, so Undo takes back one place. The last one shows the scores; 'show-scores'
  // shows them all at once instead.
  'hide-scores'(b){
    if(b.scoresHidden) return null;
    b.scoresHidden = true;
    b.revealed = [];
    return 'Scores hidden';
  },
  'show-scores'(b){
    if(!b.scoresHidden) return null;
    b.scoresHidden = false;
    b.revealed = [];
    return 'Scores shown';
  },
  // The phone names the reveal it showed the host. If the board has moved on since (another phone got
  // in first, or a score changed before the reveal began), it does nothing, rather than reveal a place
  // the host did not expect.
  'reveal-next'(b, a){
    if(!b.scoresHidden) return null;
    const next = nextReveal(b);
    const label = next ? next.label : 'Scores shown';     // no teams to reveal
    if(typeof a.label === 'string' && a.label !== label) return null;
    if(next && !next.last) b.revealed.push(...next.teams.map((t) => t.id));
    else RULES['show-scores'](b);
    return label;
  },
};

export const RULE_NAMES = Object.keys(RULES);

// -> { board, label } with a new board, or null if the command is not allowed or changes nothing.
export function apply(board, action, arg){
  const rule = Object.hasOwn(RULES, action) ? RULES[action] : null;
  if(!rule || lockedByReveal(board, action)) return null;
  const next = structuredClone(board);
  const label = rule(next, arg && typeof arg === 'object' ? arg : {});
  if(label === null || JSON.stringify(next) === JSON.stringify(board)) return null;
  return { board: next, label };
}
