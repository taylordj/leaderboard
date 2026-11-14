// Every number and name you might want to tune, in one place.

// ---- the board ----
export const DEFAULT_TITLE = "Dan's Christmas Quiz 2026";
export const DEFAULT_TEAMS = ['Team Alpha', 'Team Beta', 'Team Gamma', 'Team Delta'];
export const DEFAULT_POWERUPS = [
  { name: 'Joker', icon: '🃏' },
  { name: 'Triple Threat', icon: '🔱' },
  { name: 'Gamble', icon: '🎰' },
  { name: '-5 Bomb', icon: '💣' },
];
export const DEFAULT_ICON = '🎲';        // a new powerup with no icon gets this one
// Team colours: all of them read well on the dark board. New teams take the first one nobody has;
// the phone's Setup offers them all as swatches.
export const PALETTE = [
  '#FF5C7A', '#38C9C0', '#7B8CFF', '#5CC8FF',
  '#B98BFF', '#6FDD8B', '#FF8A5C', '#FFD25C',
  '#E879F9', '#A3E635', '#D6A26B', '#A5B4CF',
];

// ---- limits (everything from the phone is checked against these) ----
export const MAX_TEAMS = 20;
export const MAX_POWERUPS = 8;
export const NAME_MAX = 24;              // characters, for team and powerup names
export const TITLE_MAX = 60;
export const ICON_MAX = 8;               // characters; most emoji are 1 or 2
export const MAX_ADJUST = 1000;          // the most one score change can add or take away
export const MAX_SCORE = 99999;          // scores stay between -MAX_SCORE and MAX_SCORE

// ---- the reveal (scores hidden for the final round, then shown from last place to first) ----
export const REVEAL_STEP_MS = 1300;      // pause before each place below 3rd
export const REVEAL_QUICK_MS = 650;      // the same, when there are more than 8 places to get through
export const REVEAL_PODIUM_MS = 2200;    // pause before 3rd, and before 2nd
export const REVEAL_WINNER_MS = 3200;    // pause before the winner

// ---- the phone ----
export const QUICK_AMOUNTS = [-5, -1, 1, 5];
export const UNDO_DEPTH = 20;            // how many changes the TV remembers for Undo
export const CONFIRM_TIMEOUT_MS = 6000;  // a tap the TV has not confirmed by then is reported

// ---- remote control (phone <-> TV) ----
// Free public MQTT relays. All are used at once; any one being up is enough.
export const RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081',
];
export const PROTOCOL_VERSION = 1;       // bump this and TOPIC_ROOT together when messages change shape
export const TOPIC_ROOT = 'danslb/1/';
export const HEARTBEAT_MS = 8000;        // the TV re-announces itself this often
// The phone checks the board is still there: after this long without hearing from it, the phone asks
// (a 'hello', which the board always answers), and if no answer comes within GONE_AFTER_MS it treats
// the board as gone. This catches a TV page that closed without saying goodbye.
export const PING_AFTER_MS = 10000;
export const GONE_AFTER_MS = 4000;
export const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
export const ROOM_CODE_LENGTH = 6;
export const MAX_ACKS = 8;               // the TV confirms the latest command from this many phones

// Everything the phone can ask the TV to do. model.js has the rules for each one, except
// 'hello' (a phone saying it is there; display-remote.js) and 'undo' (display.js).
export const ACTIONS = [
  'hello', 'undo',
  'adjust-score', 'set-powerup',
  'add-team', 'rename-team', 'set-team-color', 'remove-team',
  'add-powerup', 'edit-powerup', 'remove-powerup',
  'set-title', 'reset-round',
  'hide-scores', 'show-scores', 'reveal-scores',
];

// ---- saved on the device (localStorage) ----
export const STORAGE = {
  board: 'lb_board',                     // TV: the teams, scores and powerups
  displayCode: 'lb_display_code',        // TV: its room code
  paired: 'lb_paired_code',              // TV: the room code a phone last connected to
  remoteCode: 'lb_remote_code',          // phone: the room it last joined
};
