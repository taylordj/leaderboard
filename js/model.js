// All the scoreboard rules. Pure data: no page, no storage, no network, so it can be tested in Node.
//
// A board looks like this:
//   {
//     title:        string,
//     powerups:     [ { id, name, icon } ],
//     teams:        [ { id, name, color, score, used: { [powerupId]: true } } ],
//     scoresHidden: boolean    -- the TV shows the teams but not the scores, until a reveal
//   }
// Every team has one of each powerup. A powerup is either available or used; there are no counts.
//
// Boards are never changed in place: apply() returns a new one. The TV keeps the old ones for Undo.
import {
  DEFAULT_TITLE, DEFAULT_TEAMS, DEFAULT_POWERUPS, DEFAULT_ICON, PALETTE,
  MAX_TEAMS, MAX_POWERUPS, NAME_MAX, TITLE_MAX, ICON_MAX, MAX_ADJUST, MAX_SCORE,
} from './config.js';
import { clamp, newId, signed } from './util.js';

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
  const powerups = DEFAULT_POWERUPS.map((p) => ({ id: newId(), name: p.name, icon: p.icon }));
  const teams = DEFAULT_TEAMS.map((name, i) => ({
    id: newId(), name, color: PALETTE[i % PALETTE.length], score: 0, used: {},
  }));
  return { title: DEFAULT_TITLE, powerups, teams, scoresHidden: false };
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
  return { title, powerups, teams, scoresHidden: raw.scoresHidden === true };
}

// ---------------------------------------------------------------- standings

// Teams from highest score to lowest. Teams on the same score keep their setup order.
export const ranked = (board) => board.teams.slice().sort((a, b) => b.score - a.score);

// Equal scores are a genuine tie:
//   rankOf[id]  competition ranking: two teams tied for 1st are both 1st, and the next team is 3rd.
//   distinct    each score once, highest first, used for the gaps so a tie never shows "+0".
//   groups      the same, with the teams on each score (in the order given) and their place:
//               [{ score, teams, rank }].
//   tiedAtTop   how many teams share the top score.
//   allLevel    every team is on the same score (e.g. before the first point), so nobody is leading.
export function rankInfo(teams){
  const distinct = [...new Set(teams.map((t) => t.score))].sort((a, b) => b - a);
  const rankOf = {};
  for(const t of teams) rankOf[t.id] = teams.filter((x) => x.score > t.score).length + 1;
  const groups = distinct.map((score) => {
    const on = teams.filter((t) => t.score === score);
    return { score, teams: on, rank: rankOf[on[0].id] };
  });
  return {
    rankOf,
    distinct,
    groups,
    tiedAtTop: groups[0]?.teams.length ?? 0,
    allLevel: distinct.length <= 1,
  };
}

// How far a team is from the others.
//   Leader:     { leader: true, ahead }   (ahead: points clear of the next score, or null if none)
//   Everyone:   { leader: false, toFirst, first, toNext, next }
//               first is the leaders' group; next is the group just above, with toNext the gap to it.
//               next and toNext are null when the group just above is the leaders.
export function gaps(team, info){
  const pos = info.distinct.indexOf(team.score);
  if(pos === 0){
    return { leader: true, ahead: info.distinct.length > 1 ? team.score - info.distinct[1] : null };
  }
  const first = info.groups[0];
  const next = pos > 1 ? info.groups[pos - 1] : null;
  return { leader: false, toFirst: first.score - team.score, first, toNext: next ? next.score - team.score : null, next };
}

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
    b.teams.push({ id: newId(), name, color: freeColor(b.teams), score: 0, used: {} });
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
    b.powerups.push({ id: newId(), name, icon: cleanIcon(a.icon) || DEFAULT_ICON });
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
    for(const t of b.teams){ t.score = 0; t.used = {}; }
    return 'Reset round';
  },

  // Hiding scores for the final round. 'reveal-scores' and 'show-scores' change the board the same
  // way; the TV plays the reveal (last place to first) only for 'reveal-scores'.
  'hide-scores'(b){
    if(b.scoresHidden) return null;
    b.scoresHidden = true;
    return 'Scores hidden';
  },
  'show-scores'(b){
    if(!b.scoresHidden) return null;
    b.scoresHidden = false;
    return 'Scores shown';
  },
  'reveal-scores'(b){
    if(!b.scoresHidden) return null;
    b.scoresHidden = false;
    return 'Scores revealed';
  },
};

export const RULE_NAMES = Object.keys(RULES);

// -> { board, label } with a new board, or null if the command is not allowed or changes nothing.
export function apply(board, action, arg){
  const rule = Object.hasOwn(RULES, action) ? RULES[action] : null;
  if(!rule) return null;
  const next = structuredClone(board);
  const label = rule(next, arg && typeof arg === 'object' ? arg : {});
  if(label === null || JSON.stringify(next) === JSON.stringify(board)) return null;
  return { board: next, label };
}
