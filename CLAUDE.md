# Quiz Scoreboard: notes for whoever changes the code

A static live scoreboard. The **board** (`index.html`) goes on the TV, and the **Quiz Admin Panel**
(`remote.html`) runs on the host's phone. They talk through public MQTT relays, plus a BroadcastChannel when
both are open in the same browser. There is no build step, no npm and no framework: plain ES modules served by
GitHub Pages. The design follows the sister project `beat-the-clock`.

## Files

| File | What it is |
|---|---|
| `index.html`, `css/display.css`, `js/display.js` | The board: rendering, `perform()`, Undo, hidden scores and the reveal, fitting the screen. |
| `js/display-remote.js` | The board's side of the remote: pairing dialog and QR, running commands, publishing status. |
| `js/one-board.js` | Only one copy of the board in a browser has the remote; the others pause. |
| `remote.html`, `css/remote.css`, `js/remote.js` | The phone: team rows, the team sheet, Setup, pending and confirmed taps. |
| `js/model.js` | **All scoreboard rules.** Pure data: board shape, `sanitizeBoard`, standings, `apply()`. |
| `js/relay.js` | The link: several relays plus BroadcastChannel, message checks, reconnecting, wake lock. |
| `js/config.js` | Every tunable number and name: defaults, palette, limits, timings, relays, `ACTIONS`, `STORAGE`. |
| `js/util.js`, `css/base.css` | Shared helpers, colour tokens, buttons and inputs, the reduced-motion rule. |
| `vendor/` | MQTT.js 5.15.2 and qrcode-generator 1.4.4. Do not edit. |
| `tests/model.test.js` | Checks for model.js, the relay message checks and small helpers. |

## Rules to keep

- **Rules live only in `model.js`**, which never touches the page, storage or network, so it can be tested in Node.
  `apply()` returns a new board and never changes one in place, so Undo is just a stack of old boards.
- **The board owns the state** and saves it to localStorage after every change. Every change goes through
  `perform(action, arg)` in display.js. Phones only send commands and draw what the board's status says.
- **Anything from the relays is untrusted.** relay.js checks every message (`parseCommand`, and `parseStatus`
  runs the board through `sanitizeBoard`), and each rule in model.js checks its arguments again.
  - Text that goes into `innerHTML` is passed through `escapeHtml`.
  - Team colours come from `PALETTE` only.
- **Every tap is accounted for, truthfully.**
  - Score and powerup taps show at once as pending, and clear when the status's `acks[SESSION].seq` reaches
    them.
  - A tap the board has not confirmed after `CONFIRM_TIMEOUT_MS` is reported.
  - `ok: false` in an ack means the board changed nothing, and the phone says so instead of ✓.
- **Undo names what it undoes, and Next names what it reveals.** The phone sends the label it showed the host,
  and the board refuses if its latest change (for Undo) or its next reveal (`nextReveal`, for Next) is a
  different one. Next is also greyed out until the board confirms the last one, so a double tap reveals one
  place.
- **The board draws rows once per team, then only patches or moves them.** Recreating a row would replay its
  entrance and break the reorder glide (FLIP), the score roll-up and the powerup flares.
- **The board is laid out at a fixed size and scaled to fit** (`fitStage`).
  - The stage is 1100px wide (2040px in two columns) and at least 720px tall. That minimum stops a few teams
    being blown up to fill the screen.
  - If you change the sizes of the title, card or rows, update the numbers in `chooseColumns`.
  - There are no viewport units inside `#stage`.
  - FLIP distances are divided by `fitScale`.
- **While scores are hidden, nothing on the board may give the standings away.**
  - Rows keep setup order and show "?", with no bars, gaps, glow or flash.
  - The reveal is part of the board: `revealed` lists the teams revealed so far, and each tap of Next is one
    `reveal-next`, last place first, with tied teams together. Undo, a reload and every phone therefore agree on it.
  - The TV draws the reveal from the board, not on a timer (`viewOf`: hidden, reveal, finale, scores). Part-way
    through, rows are in their final order and the places still to come are identical empty slots (`.veiled`).
    Bars, gaps and the leader's glow come only after the winner's moment.
  - A row glides to a new place only when every team is in view before and after (`IN_VIEW`), because a hidden
    team seen moving would give its place away. Before the first place, the rows empty where they are.
  - Once the first place is revealed, the standings are locked until the reveal ends (`lockedByReveal`: scores,
    adding or removing teams, Reset Round). The phone greys those controls out and marks each team already
    revealed with a ✓, but always shows every score. Undo back to the start, or Show now, unlocks them.
  - The reveal has two short moments (`REVEAL_FADE_MS`, `REVEAL_FINALE_MS`). During one, `render()` publishes
    but draws nothing, and when it ends it draws the board as it is by then.
- **Only one copy of the board has the remote.**
  - The copy already in charge keeps it, and a newer one pauses.
  - Handing over reloads the saved board, and stops the old copy's relays with a clean disconnect, so phones are
    never told the board has gone.
- **On the phone, every team fits on one screen.** `layoutTeams` shares the card's height between the rows
  (roomy, line, tile or mini) and runs on every render.
  - Rows keep setup order.
  - Rows are rebuilt only when teams, names, colours or powerups change, because a rebuild during a tap
    swallows it.
  - A text box is never overwritten while it has focus, or while its change is unconfirmed (`hold`/`isHeld`).
- **Points per tap is a setting of the phone** (`STORAGE.step`), not part of the board. It and the custom
  amount are both read with `points()`.
- **Deliberate behaviours:**
  - While every team is on the same score nobody leads: no crown, no gap chips, and the place shows "–".
  - Ties share a place.
  - Gap chips read "12 behind Team Beta", with no place or "leader" wording, and the leader shows only "+4 ahead".
  - Undo history is in memory only (`UNDO_DEPTH`).
  - New code, remove, Reset Round and Show now all take two taps (`armConfirm`). Next takes one tap per place.
  - A phone that hears nothing for `PING_AFTER_MS` sends a quiet `hello`. No answer within `GONE_AFTER_MS` means
    the board has gone.
  - A phone that wakes up reconnects through `connect()`, the same path as the first time, so it says hello
    again. That hello is how a remote in the same browser gets the board's status, since BroadcastChannel
    keeps no last message.
  - The pairing dialog closes itself only for a phone the board has not heard from before.
  - The phone's header says "Quiz Admin Panel", or "Quiz Admin" when the status beside it leaves too little
    room (`fitTitle` measures it). It never shows the quiz title.

## Message protocol (relay.js)

Topics are `danslb/2/<ROOM>/cmd` and `danslb/2/<ROOM>/status`, and the same messages travel on the
BroadcastChannel `danslb/2/<ROOM>`.

- **Command** (phone → board): `{ v:2, from, seq, action, arg? }`. The board ignores a repeated `from:seq`,
  because each command arrives once per relay. `hello` changes nothing; the board just answers it.
- **Status** (board → phone, retained): `{ v:2, online:true, at, board, undo, acks }`.
  - `undo` is the label of what Undo would undo.
  - `acks` gives each recent phone `{ seq, ok }`.
  - The last will is `{ v:2, online:false }`.
- **Arguments:**
  - `adjust-score {team, amount}`, `set-powerup {team, powerup, used}`
  - `add-team {name}`, `rename-team {team, name}`, `set-team-color {team, color}`, `remove-team {team}`
  - `add-powerup {name, icon}`, `edit-powerup {powerup, name?, icon?}`, `remove-powerup {powerup}`
  - `set-title {title}`, `undo {label}`, `reveal-next {label}`
  - The rest take nothing.
- To change a message's shape, bump `PROTOCOL_VERSION` and `TOPIC_ROOT` together, and update
  `parseCommand`/`parseStatus`.

## How to…

**Add a board action:**
1. Add a rule to `RULES` in model.js. It changes the copy it is given and returns a label for Undo, or null.
2. Add the action's name to `ACTIONS` in config.js. A test checks the two lists match.
3. Send it from remote.js with `send(action, arg, { label })`.
4. Add a test.

**Change limits, timings or defaults:** config.js. **Colours:** the tokens at the top of base.css.

**Change the look of the board:** display.css. Keep idle motion slow and faint: the background drift, the
leader's glow and sheen, the title shimmer and the bar glint. That way score changes, reorders and powerup
flares stand out.

## Checking a change

1. Run `node tests/model.test.js` (or open `tests/model.test.html`). Everything must pass.
2. Run `python -m http.server 8000`, open <http://localhost:8000/>, and open the remote from its 📡 dialog in a
   phone-sized window. Check:
   - Scoring from the rows and from the team sheet, powerups, and Undo.
   - Setup edits, colour swatches, and points per tap.
   - Hide scores, then Next for each place: last place first, the winner last with confetti. Undo hides one
     place again, and a reload part-way keeps the places revealed so far.
   - Every team fits on the phone with 2, 8, 12 and 20 teams. The board fits portrait and landscape windows.
   - Reload the board: nothing is lost. Close it: the phone greys out within about 15 s. A second copy of the
     board pauses.
3. Try the remote in a different browser too, so commands go through the relays.
