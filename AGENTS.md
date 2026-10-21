# vigo: notes for coding agents

vigo is a PWA for indoor cycling ERG workouts on an Elite Rampa or any FTMS trainer, over Web Bluetooth.
`src/` is published as is to GitHub Pages: no build step, no npm dependencies, plain ES modules. The README is
the user documentation; keep it in step with user-visible changes.

## Layout

- `src/app.js`: the app: state, views, device handling, ride control. `src/index.html`, `src/app.css`.
- `src/ble/`: `device.js` (`Connection` with reconnects, and the trainer/HR/CSC setups), `rampa.js` and `ftms.js`
  (trainer control), `cps.js`, `cscs.js`, `hrs.js` (measurement parsers), `revs.js` (rates from revolution
  counters), `uuids.js`.
- `src/workout/`: `parse.js` reads .erg/.mrc
  ([format](https://support.trainerroad.com/hc/trainerroad-support/articles/201944204-creating-a-workout-from-an-erg-or-mrc-file)),
  `target.js` gives the target power at a time, `player.js` is the workout clock, `builtin.js` the built-ins,
  `cues.js` the interval countdowns and [COURSE TEXT] messages, `hrzones.js` the heart rate zones.
- `src/record/`: the per-second `recorder.js` with autosave, and the `fit.js` FIT encoder.
- `src/store/`: IndexedDB (`db.js`), the workout library, saved devices.
- `src/ui/`: `dom.js` (`$`, `el`), the SVG `chart.js`, the hash `router.js`.
- `test/`: node unit tests and `fixtures/` (including a hostile workout name).
- `tools/`: `serve.py` dev server, `ui_test.py` end to end test, `fake_ble.js` fake Web Bluetooth,
  `screenshots.py` for the README images, `ftms_emulator.py` (a fake FTMS trainer on a Linux box with BlueZ,
  usage in its docstring).

## Run and test

- `npm test` runs the unit tests (`node --test`). CI runs them before every deploy of `main`.
- `~/.venv/bin/python tools/ui_test.py --out <dir>`: headless Chromium, end to end, on `tools/fake_ble.js`. It
  fails on any console error. Look at the screenshots it writes, desktop and phone.
- `python3 tools/serve.py` serves `src/` on 127.0.0.1:8090 (`--prefix /vigo/` mimics Pages). It only binds to
  loopback unless told otherwise, and checks the Host header.
- `~/.venv/bin/python tools/screenshots.py` regenerates `docs/screenshots/`.
- `python3 tools/ftms_emulator.py --self-test` checks the emulator's protocol logic without Bluetooth.

## Rules that bite

- **Service worker:** a new or renamed file under `src/` goes into the `shell` list in `src/sw.js`, and
  `cacheName` gets bumped, or the installed app breaks offline.
- **Bluetooth behaviour:** headless Chrome has no Web Bluetooth, so `tools/fake_ble.js` is the only browser
  test. New device behaviour goes into the fake too, with a pass in `ui_test.py`. Pure encode/parse code goes in
  its own module with unit tests (see `rampa.js`, `ftms.js`).
- **CSP:** `index.html` allows only `'self'`. No CDN, no inline scripts or styles, no `eval` (Playwright's
  `wait_for_function` with a string fails too, so `ui_test.py` polls with `page.evaluate`). The app also refuses to
  run inside a frame.
- **Untrusted input:** BLE packets, .erg/.mrc files, localStorage/IndexedDB, device names. Parse with length
  and range checks (a bad packet is skipped, never thrown into the app). Render with `el()`/`textContent`,
  never `innerHTML`. Add a hostile fixture when a new value reaches the page.
- **Trainer choice:** the setup tries the Elite service first and FTMS second, so a Rampa stays on its own
  protocol even if a firmware update adds FTMS.

## UI conventions

- Dark theme only, no light variant or toggle.
- Four tabs: Ride, Workouts, History, Settings. New configuration goes in a Settings card, not a new page.
- It has to work at phone width (390 px) with no horizontal scroll, and in landscape on a phone.

## Code style

- Every file starts with a comment block saying what it is and anything non-obvious (formats, protocols).
- Signature comments above functions: `// (Workout, Number) -> Int`, `// DataView -> {power, cadence?}`.
- 4-space indent, `if(x)` and `for(...)` with no space, single quotes, semicolons.
- Factories, not classes: `Connection(...)` and `LatestWriter(...)` return `Object.freeze({...})` with getters.
- Comments say why, not what. Match the density of the surrounding code.
- Python tools: stdlib plus Playwright, run with `~/.venv/bin/python` (the emulator alone needs `bless`).

## Git

- Pushing to `main` deploys to Pages, so work on a branch.
- Commit subjects start with `vigo: `, and the body is a short list of user-visible changes.

## Bluetooth cheat sheet

The source of truth is the comments and tests in `src/ble/rampa.js` and `src/ble/ftms.js`.

**Elite Rampa**, service `347b0001-7635-408b-8918-8ff3949ce592`, power and cadence on Cycling Power (0x1818):

| Characteristic | Use | Bytes |
|---|---|---|
| `347b0010-…` brake, write | ERG target | `00 <u16 LE watts>` |
| | brake level (0 = released) | `01 <u8 0..200>` |
| `347b0011-…` out of range, notify | "Pedal faster" | `01` can't hold the target, `00` OK |

**FTMS**, service 0x1826:

| Characteristic | Use | Bytes |
|---|---|---|
| 0x2AD9 control point, write + indicate | request control | `00` |
| | set target power | `05 <s16 LE watts>` |
| | start / resume | `07` |
| | pause | `08 02` (stop is `08 01`) |
| | answer (indication) | `80 <op> <result>`: 01 ok, 02 not supported, 03 invalid parameter, 04 failed, 05 not permitted |
| 0x2AD8 supported power range, read | clamp targets | `<s16 min> <s16 max> <u16 step>` |
| 0x2AD2 indoor bike data, notify | used when there is no Cycling Power | flags u16; bit 0 clear = speed u16 0.01 km/h; bit 2 cadence u16 0.5 rpm; bit 6 power s16 |

vigo sends request control on connect, then start before the first target and after each pause. It waits up to
3 s for each answer; a refusal or timeout fails the setup, and `Connection` retries.
