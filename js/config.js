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

// ---- the reveal (scores hidden, then shown from last place to first, one tap of Next at a time) ----
export const REVEAL_FADE_MS = 650;       // the "?" rows fade out before the first place appears
export const REVEAL_FINALE_MS = 1400;    // the winner's moment, before the bars, gaps and glow come in

// ---- the phone ----
export const DEFAULT_STEP = 1;           // points per tap on each team's − / + buttons (changed in Setup)
export const SHEET_AMOUNTS = [1, 2, 5, 10];   // the team sheet's buttons, as + and − (plus the points per tap)
export const UNDO_DEPTH = 20;            // how many changes the TV remembers for Undo

// ---- the link between the phone and the big screen ----
// relay.js, display-remote.js and remote-link.js use these.
// Free public MQTT relays. All are used at once; any one being up is enough.
export const RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081',
];
export const APP_ID = 'lb';              // names this app's topics, connections and windows
export const PROTOCOL_VERSION = 2;       // bump this when messages change shape (the topics change with it)
export const TOPIC_ROOT = `${APP_ID}/${PROTOCOL_VERSION}/`;
export const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
export const ROOM_CODE_LENGTH = 6;
export const HEARTBEAT_MS = 8000;        // the big screen re-announces itself this often
export const MAX_ACKS = 8;               // the big screen confirms the latest command from this many phones
// A tap the big screen has not confirmed is sent again every RESEND_MS, at most RESEND_TRIES times, and
// reported if it is still not confirmed after CONFIRM_TIMEOUT_MS.
export const RESEND_MS = 1000;
export const RESEND_TRIES = 3;
export const CONFIRM_TIMEOUT_MS = 6000;
// The phone checks the big screen is still there: after PING_AFTER_MS without hearing from it, the phone
// asks (a 'hello', which the big screen always answers), and if no answer comes within GONE_AFTER_MS it
// treats the big screen as gone. This catches a page that closed without saying goodbye.
export const PING_AFTER_MS = 10000;
export const GONE_AFTER_MS = 4000;
export const NO_CONNECTION_MS = 8000;    // the phone's "Connecting…" turns into "No connection" after this

// ---- saved on the device (localStorage) ----
// displayCode, paired and remoteCode belong to the link (display-remote.js and remote-link.js).
export const STORAGE = {
  board: 'lb_board',                     // TV: the teams, scores and powerups
  displayCode: 'lb_display_code',        // TV: its room code
  paired: 'lb_paired_code',              // TV: the room code a phone last connected to
  remoteCode: 'lb_remote_code',          // phone: the room it last joined
  step: 'lb_remote_step',                // phone: points per tap
};
