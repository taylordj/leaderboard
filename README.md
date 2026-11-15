# Dan's Quiz Scoreboard

A live scoreboard for a quiz night: the board goes on the TV, and you run it from your phone.

## Running a quiz

1. Open the site on the TV. It shows a QR code.
2. Scan the code with your phone.
3. On the phone, tap **⚙ Setup** to add your teams, powerups and title.
4. Tap **+** or **−** on a team to score. Tap a team's name for other amounts and its powerups.
5. **↶ Undo** takes back the last change.

For a big finish, tap **Hide scores** in Setup before the last round. When you're ready, tap **Next ▶** once
for each place: the TV reveals them from last place up to the winner, at your pace. **↶ Undo** hides the last
one again. While you reveal, scores are locked and your phone ticks ✓ each team the room has seen.

## Good to know

- Scores are saved on the TV's computer, so reloading the page loses nothing.
- Tap **📡** on the TV to see the QR code again, or to run the remote on the TV's computer.
- Anyone with the room code can change the scores. **New code** in the 📡 box makes a fresh one.

## Publishing

Upload this folder to the GitHub Pages repository. To try it first, run `python -m http.server 8000` here
and open <http://localhost:8000/>.

Uses [MQTT.js](https://github.com/mqttjs/MQTT.js) and
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (both MIT licence), and Google Fonts.
