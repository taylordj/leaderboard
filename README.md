# Dan's Quiz Scoreboard

A live scoreboard for a quiz night, run from your phone. The board goes on the TV and ranks the teams as their
scores change, showing the gaps between them and which powerups each team has left.

## Running a quiz

1. On the TV (a laptop plugged into it, or a browser tab cast to it), open the site. The first time, it shows a
   QR code.
2. Scan the QR code with your phone. The phone is now the remote. (Or open `remote.html` on the phone and type
   the code shown on the TV. Tap **📡** in the corner of the TV to see the code again.)
3. On the phone, open **⚙ Setup** to set the title, the teams and the powerups. Tap a team's colour dot to pick
   its colour.
4. During the quiz, tap **+1** or **−1** on a team. Tap the team itself for ±5, any other amount, and its
   powerups.
5. Made a mistake? **↶ Undo** says exactly what it will undo.

The phone confirms every tap (*✓ +1 Team Alpha*), and says so in red if the board did not get it. Everything
greys out while the board can't be reached. The teams stay in the order you set them up, so the buttons never
move under your thumb; the badge on each one shows its place.

## The final round

In **⚙ Setup**, tap **🙈 Hide scores on the board**. The TV keeps showing the teams, but not their scores,
places or gaps; your phone still shows them. When you're ready, tap **Reveal ▶** twice, on the phone's main
screen or in Setup. The board then fills in from last place up to the winner, with confetti.

**Undo** hides the scores again. **Show now** in Setup brings them back without the reveal.

## Publishing

Upload everything in this folder to the GitHub Pages repository. To try it on your computer first, run
`python -m http.server 8000` in this folder and open <http://localhost:8000/>. The automatic checks are at
<http://localhost:8000/tests/model.test.html>, or run `node tests/model.test.js`.

## Good to know

The board is saved on the TV's computer, so reloading or restarting loses nothing, as long as it is the same
browser on the same computer. If the board is open twice in that browser, the copy opened later pauses and
says so; **Use this window instead** moves the remote to it.

No phone, or no internet? On the TV's computer, tap **📡** and then **Open the remote on this device**. It works
inside the browser, even without the internet once the pages have loaded.

Several phones can run the board at once. The phone and the TV talk through free public relays. The six-letter
room code is the only thing that links them, so keep it to yourselves; **New code** in the 📡 dialog makes a
fresh one.

Uses [MQTT.js](https://github.com/mqttjs/MQTT.js) and
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (both MIT licence), and fonts from Google Fonts.
