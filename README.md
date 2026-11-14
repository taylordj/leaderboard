# Dan's Quiz Scoreboard

A live scoreboard for a quiz night. The board goes on the TV, and you run it from your phone.

It is a static website (no server, no build step), published with GitHub Pages.

## Running a quiz

1. **On the TV** (a laptop plugged into the TV, or a browser tab cast to it), open the site's address, for
   example `https://<you>.github.io/<repo>/`.
2. The first time, a **Connect your phone** box shows a QR code. **Scan it with your phone's camera.** The box
   closes by itself as soon as the phone is connected. To see it again later, tap **📡** in the top corner.
3. On the phone, open **⚙ Setup** to set the title, the teams and the powerups.
4. During the quiz:
   - Tap **−5 −1 +1 +5** on a team's card. For any other amount, tap **±**, type the number, then
     **+ Add** or **− Take away**.
   - When a team plays a powerup, tap its icon on their card. Tap it again to give it back.
5. If you make a mistake, tap **↶ Undo**. The button says exactly what it will undo, for example *Undo: +5 Team Alpha*.

### What the phone tells you

- **The pill at the top:** *Board connected* (all good), *Connecting…*, *Waiting for the board…* (is the board
  open on the TV?) or *No connection* (check the phone's internet).
- **Every tap is confirmed.** The new score shows at once with a small *+5…* beside it until the board
  confirms it. The line above the buttons then says *✓ +5 Team Alpha*. If the board does not confirm within a
  few seconds, or the tap changed nothing (for example another phone had already marked that powerup), that
  line turns red and says so.
- **Undo is exact.** It only undoes the change named on the button. If something else reached the board first,
  nothing is undone, and the button updates to show the new latest change.
- **The cards never move.** They stay in the order you set up, so buttons are always where your thumb expects
  them. The small badge on each card (*1st*, *2nd*, *=3rd*…) shows the standings.
- **Everything greys out** while the board cannot be reached, so you never tap into nothing.

### ⚙ Setup

- **Title on the board.**
- **Teams:** add, rename, remove (tap ✕ twice), and tap the colour dot to change a team's colour.
- **Powerups:** every team gets one of each. Change an icon or name by typing over it, or remove one (tap ✕ twice).
- **Hide scores on the board**, for the final round. See below.
- **Reset round** (tap twice): every score goes back to 0 and every powerup is given back. The teams and
  powerups stay, and Undo can bring the scores back.
- **Change code** connects the phone to a different board.

Anything you change, including a removed team, can be undone.

### The final round: hide the scores, then reveal them

1. Before the final round, open **⚙ Setup** and tap **🙈 Hide scores on the board**.
   - The TV keeps showing the teams and their powerups, but every score becomes **?**.
   - It also stops showing places, bars and gaps, and the teams stay in your setup order, so nothing gives
     the standings away.
2. Score the final round as usual. Your phone still shows the real scores, with a gold *Scores hidden* bar on top.
3. When you're ready, tap **Reveal ▶** on that bar, then tap again.
   - The TV fills in the standings from last place up, each score counting up, with longer pauses for the podium.
   - The winner comes last, with a gold flare and confetti.

Changed your mind? **Undo** hides the scores again. **⚙ Setup → Show scores now** brings them straight back
without the reveal.

### On the TV

- Teams are ranked with 👑🥈🥉. Each one shows its gap to 1st and to the team just above it.
- Scores count up and flash green (points won) or red (points lost), and teams glide to their new places.
- A used powerup flares and is struck through in red. Given back, it flares green.
- The board always fits the screen, whatever its shape. With many teams on a wide screen it uses two columns.
- **📡 chip** in the top corner: green means phones can connect, amber means connecting, red means a problem.
  Tap it for the QR code.
- **The board is saved on the TV's computer.** Reload the page or restart the computer and the scores are all
  still there, as long as it is the same browser on the same computer.
- **Open it only once.** If the board is open twice in the same browser (an extra tab, say), the copy opened
  later shows *Open in another window* and ignores the remote, so the two can never disagree.
  - To use the later copy instead (for example, a window you've just moved to the TV), tap **Use this window
    instead** on it.
  - If you close the copy that has the remote, the other one takes over by itself.

### No phone, or no internet

On the TV's computer, tap **📡**, then **Open the remote on this device**. The remote opens in a small window
of its own, so the board stays on show. It talks to the board directly inside the browser, so it keeps
working even if the internet drops once the pages have loaded.

### More than one host

Any phone with the room code can run the board, and they all stay in step. **New code** in the 📡 box (tap
twice) gives the board a fresh code and disconnects every phone.

## Publishing

Put everything in this folder in a GitHub repository, then turn on **Settings → Pages → Deploy from a branch**
(branch `main`, folder `/ (root)`):

```
index.html  remote.html  css/  js/  vendor/  tests/  README.md  CLAUDE.md
```

## Trying it on your computer

The pages use JavaScript modules, which browsers will not load from a file on disk, so start a small web
server in this folder:

```
python -m http.server 8000
```

Then open <http://localhost:8000/> for the board and <http://localhost:8000/remote.html> for the remote.
A phone on the same Wi-Fi can use `http://<your computer's IP>:8000/remote.html`.
<http://localhost:8000/tests/model.test.html> runs the automatic checks (every line should be blue), or run
`node tests/model.test.js`.

## How the phone talks to the board

Through free public MQTT relays, three at once, so if one is down the others carry on. Pages in the same
browser also talk directly. The relays keep only the latest scoreboard for your room, so a phone that joins
later sees it at once. The six-letter room code is the only thing linking the two devices, so keep it to
yourselves. **New code** makes a fresh one.

## Third-party code

- `vendor/mqtt.min.js`: [MQTT.js](https://github.com/mqttjs/MQTT.js) 5.15.2, MIT licence.
- `vendor/qrcode.js`: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 by
  Kazuhiko Arase, MIT licence.
- Fonts: Teko, Inter and JetBrains Mono from Google Fonts.
