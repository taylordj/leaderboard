# Quiz Scoreboard: notes for whoever changes the code

A static live scoreboard. There is a **board** page (`index.html`, on the TV, landscape or portrait, any
size) and a **phone remote** (`remote.html`, portrait) that the host runs everything from. They talk
through public MQTT relays, plus a BroadcastChannel when both are open in the same browser.
There is no build step, no npm and no framework: plain ES modules served by GitHub Pages. README.md
explains how it is used. The design follows the sister project `beat-the-clock`.

## Files

| File | What it is |
|---|---|
| `index.html` | Board markup: the stage, the 📡 chip and the pairing dialog. |
| `remote.html` | Phone remote markup: pairing card, team cards, Undo/Setup bar, custom-amount and Setup sheets. |
| `css/base.css` | Shared colour tokens, fonts, buttons and inputs, plus the one reduced-motion rule. |
| `css/display.css` | Board layout and every board animation. |
| `css/remote.css` | Phone layout. The landscape fallback comes last on purpose, so it wins. |
| `js/config.js` | Every tunable number and name: defaults, palette, limits, timings, relays, `ACTIONS`, `STORAGE` keys. |
| `js/util.js` | Small shared helpers: `store`, ids and room codes, `escapeHtml`, `setText`, `signed`, `ordinal`, `restartAnimation`, `armConfirm`. |
| `js/model.js` | **All scoreboard rules.** Pure data, no page: board shape, `sanitizeBoard`, standings (`ranked`, `rankInfo`, `gaps`), and `apply()` for every action. |
| `js/display.js` | Board entry point: load and save, `perform()`, the undo stack, rendering rows (roll-up, flashes, reorder glide), hidden scores and the reveal (`playReveal`, confetti), one or two columns, `fitStage`. |
| `js/display-remote.js` | The board's side of the remote (`start`/`stop`): pairing dialog and QR, running commands, publishing status, per-phone acks, the toast. |
| `js/one-board.js` | Makes sure only one copy of the board in a browser has the remote; the others pause. |
| `js/remote.js` | Phone entry point: connecting, sending, pending/confirmed taps, team cards, custom amount, Setup, checking the board is still there. |
| `js/relay.js` | The link over several relays plus BroadcastChannel, message checks (`parseCommand`, `parseStatus`), reconnecting and wake lock. |
| `vendor/` | Pinned third-party code: `mqtt.min.js` (MQTT.js 5.15.2) and `qrcode.js` (qrcode-generator 1.4.4). Do not edit. |
| `tests/model.test.js` | Checks for model.js, the relay message checks and small helpers. |

## Rules to keep

- **Board rules live only in `model.js`.** It must not touch the page, storage or network, so it stays
  testable in Node. Boards are never changed in place: `apply()` returns a new one, which is what makes Undo
  a simple stack of old boards.
- **The board owns the state.** The board saves it to localStorage after every change. Phones only send
  commands and draw whatever the board's status says. Every change goes through `perform(action, arg)` in
  display.js, and nothing else may change `board`.
- **Only one copy of the board has the remote** (one-board.js). Copies opened in the same browser share the
  saved board and room code, so they agree over a BroadcastChannel which one listens:
  - The copy already in charge keeps it. A newer copy pauses behind a full-screen notice.
  - "Use this window instead" moves the remote across, and closing the active copy hands it to a paused one.
  - Taking over reloads the saved board, and starts Undo afresh if the board changed meanwhile.
  - Handing over stops the old copy's relays quietly (`relay.stop(false)`, a clean disconnect), so phones are
    never told the board has gone.
- **While scores are hidden, nothing on the board may give the standings away.**
  - Rows keep setup order and show "?" for rank and score, with no bars, gaps, leader glow or gain/loss flash.
  - Powerups still show.
  - Only `reveal-scores` plays the reveal (`show-scores` and Undo just redraw). During the reveal, `render()`
    saves and publishes but draws nothing, and catches up when the reveal ends.
- **Board rendering: rows are made once per team, then only patched or moved.** Recreating a row replays
  its entrance and breaks the reorder glide (FLIP in `playReorder`), the score roll-up and the powerup
  flares. Powerup badges are only touched when their used/available pattern changes (`syncBadges`).
- **The board is laid out at a fixed size and scaled to fit** (`fitStage`): 1280px wide, or 2600px in two
  columns (`chooseColumns`). Do not use viewport-based sizes inside `#stage`. FLIP distances are measured on
  screen, so they are divided by `fitScale`.
- **Phone rendering:**
  - Team cards are only rebuilt when a team or powerup is added, removed, renamed or recoloured. A rebuild
    during a tap swallows the tap.
  - Cards keep setup order. They never re-sort by score.
  - Never overwrite a text box that has focus, or one whose change is not confirmed yet (`hold`/`isHeld`).
  - Lists in Setup are not rebuilt while one of their boxes has focus; they catch up on `focusout`.
- **Every tap is accounted for, truthfully.** Score and powerup taps go in `pending` and show at once. They
  clear when the status's `acks[SESSION].seq` reaches their `seq`, and they are reported after
  `CONFIRM_TIMEOUT_MS`. An ack with `ok: false` means the board handled the command but nothing changed
  (refused, or already so), and the phone says "No change on the board" instead of ✓.
- **Undo names what it undoes.** The phone sends the label it is showing, and `perform('undo')` refuses if
  the latest change is a different one (another tap, or another phone, got there first).
- **Anything from the relays is untrusted.** It is checked in relay.js (`parseCommand`, `parseStatus`, which
  runs the board through `sanitizeBoard`) and again by each rule in model.js. Text that goes into `innerHTML`
  is passed through `escapeHtml`. Team colours must come from `PALETTE`.
- **Behaviours that are deliberate (keep them):**
  - While every team is on the same score nobody is leading: no crown, no gap chips, rank shows "–".
  - Tied teams share a rank (1st, 1st, 3rd), and gap chips never show "+0".
  - The Undo history lives in the board's memory only (`UNDO_DEPTH`), so reloading the board clears it.
  - A command that changes nothing (for example, giving back a powerup that is already available) is not an Undo step.
  - New code, remove and Reset round all take two taps (`armConfirm`).
  - The phone sends a quiet `hello` when it has not heard from the board for `PING_AFTER_MS`. A board that
    is still open always answers, even from a background tab with slowed timers. No answer within
    `GONE_AFTER_MS` means the board has gone.
  - When the page is hidden, `animateNumber` (display.js) jumps straight to the new number, because hidden
    pages get no animation frames.
  - The pairing dialog closes itself only for a phone the board has not heard from before, so a connected
    phone checking in never snatches the QR code away from someone about to scan it.
  - "Open the remote on this device" opens a small window, not a tab, so the board stays on show.

## Message protocol (relay.js)

Topics are `danslb/1/<ROOM>/cmd` and `danslb/1/<ROOM>/status`. The same messages also travel on a
BroadcastChannel named `danslb/1/<ROOM>`, which reaches pages in the same browser.

- **Command** (phone → board): `{ v:1, from, seq, action, arg? }`.
  - `from` is the phone's session id, and `seq` counts up.
  - The board ignores repeats of the same `from:seq`, because each command arrives once per relay.
  - `hello` changes nothing. It closes the pairing dialog and makes the board answer with a status.
- **Status** (board → phone, retained): `{ v:1, online:true, at, board, undo, acks }`.
  - `undo` is the label of what Undo would undo, or null.
  - `acks` maps each phone's session id to `{ seq, ok }` for the latest `MAX_ACKS` phones. `seq` is the last
    command handled from that phone, and `ok` says whether it changed the board.
  - The last-will message is `{ v:1, online:false }`.
- **Arguments:**
  - `adjust-score` takes `{team, amount}`.
  - `set-powerup` takes `{team, powerup, used}`.
  - `add-team` takes `{name}`. `rename-team` takes `{team, name}`.
  - `set-team-color` takes `{team, color}`. `remove-team` takes `{team}`.
  - `add-powerup` takes `{name, icon}`. `edit-powerup` takes `{powerup, name?, icon?}`.
  - `remove-powerup` takes `{powerup}`. `set-title` takes `{title}`.
  - `undo` takes `{label}`: the change it means to undo.
  - `reset-round`, `hide-scores`, `show-scores`, `reveal-scores` and `hello` take nothing.
- **Changing the shape of a message:** bump `PROTOCOL_VERSION` and `TOPIC_ROOT` in config.js together, and
  update `parseCommand`/`parseStatus`.

## How to…

**Add a board action** (something the host can do):
1. Add a rule to `RULES` in model.js. It changes the copy it is given and returns a short label for Undo, or
   returns null if the command makes no sense.
2. Add its name to `ACTIONS` in config.js. That also whitelists it for the relay. The test "every action is
   either a board rule or handled by the TV" checks the two lists match.
3. Add the control to remote.html and send it from remote.js with `send(action, arg, { label })`.
4. Add tests in tests/model.test.js.

**Change limits, timings, defaults or the palette:** edit config.js. For colours, edit the tokens at the top
of base.css.

**Change the look of the board:** edit display.css. Keep idle motion to a minimum (the background drift and the
leader's glow), so that score changes, reorders and powerup flares stand out.

## Checking a change

1. Run `node tests/model.test.js`, or open <http://localhost:8000/tests/model.test.html>. Everything must pass.
2. Start a server in the project folder with `python -m http.server 8000`, because modules do not load from
   `file://`. Open <http://localhost:8000/> (the board) and, from its 📡 dialog, the remote link in a
   phone-sized window. Check:
   - The pairing dialog opens on a first visit and closes itself when the phone connects.
   - −5/−1/+1/+5 and a custom amount: the board rolls up, flashes and reorders. The phone shows *+5…*, then *✓*.
   - Powerups: the flare and strike on the board match the chips on the phone.
   - Undo after a score, a powerup, a removed team and a reset round.
   - Setup edits appear on the board, and a box you are typing in is never overwritten.
   - Reload the board: everything is still there. Close the board: the phone greys out within about 15 s.
   - Hide scores, change a score (no flash, still "?"), reload (still hidden), then Reveal: last place first,
     the winner last with confetti. Undo hides them again.
   - Open the board in a second window: it pauses. "Use this window instead" swaps them. Closing the active
     copy hands the remote back.
   - Resize the board window, including portrait and with 2 and 20 teams: no scrollbars, and every team visible.
3. Open the remote in a different browser too, so the commands have to go through the relays rather than
   the same-browser link.
