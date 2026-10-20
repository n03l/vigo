# vigo: notes for coding agents

vigo is a PWA for indoor cycling ERG workouts on an Elite Rampa or any FTMS trainer, over Web Bluetooth.
`src/` is published as is on Vercel (`vercel.json`): no build step, no npm dependencies, plain ES modules. The README is
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
- `src/store/`: IndexedDB (`db.js`, with the one-writer claim), the workout library, saved devices, the backup file
  (`backup.js`), Google Drive sync: `sync.js` decides what to sync, `drive.js` signs in and calls the Drive API.
- `src/ui/`: `dom.js` (`$`, `el`), the SVG `chart.js`, the hash `router.js`.
- `test/`: node unit tests and `fixtures/` (including a hostile workout name).
- `tools/`: `serve.py` dev server, `stamp.js` writes `version.json` and `config.json` at deploy, `ui_test.py` end to end test, `fake_ble.js` fake Web Bluetooth,
  `screenshots.py` for the README images, `ftms_emulator.py` (a fake FTMS trainer on a Linux box with BlueZ,
  usage in its docstring).

## Run and test

- `npm test` runs the unit tests (`node --test`). CI runs them before every deploy of `main`.
- `~/.venv/bin/python tools/ui_test.py --out <dir>`: headless Chromium, end to end, on `tools/fake_ble.js`. It
  fails on any console error. Look at the screenshots it writes, desktop and phone.
- `python3 tools/serve.py` serves `src/` on 127.0.0.1:8090 (`--prefix /vigo/` serves it under a subpath, to catch root-absolute URLs). It only binds to
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

## Google Drive sync

Runs entirely in the browser: Google Identity Services for a token, the Drive REST API for one file
(`vigo data.json`, marked `appProperties {vigo: 'data'}`), scope `drive.file` only. The file is a backup file
(`makeBackup`), so the rider can restore it by hand.

- Setup: a Google Cloud project with the Drive API, an OAuth consent screen (External, Testing, the rider as a
  test user, scope `drive.file`) and a Web application client id whose JavaScript origins are the deployed URLs
  and `http://localhost:8090`. The id is public, not a secret. It reaches the app in `src/config.json`, written
  by `tools/stamp.js` (Vercel's build command) from `GOOGLE_CLIENT_ID`: a Vercel environment variable, or the
  environment of `serve.py` locally. Empty means the Drive card says sync isn't set up.
- `decide` and `afterDownload` in `sync.js` choose between create, push, pull and asking. Data is compared by
  `dataHash` of `syncData`, the canonical form (rides sanitized and packed, sorted, one per start time; one
  workout per text), so a trip through Drive or a reload isn't a change. Keep both read paths (`localData`,
  `remoteData` in `app.js`) going through it.
- Rules the table alone gets wrong, all tested in `test/sync.test.js` and the Drive pass of `ui_test.py`: a
  device that never synced may take Drive's copy only when it has no uploads and no rides; local data is read
  again after the download and a change meanwhile makes it a conflict; settling a conflict re-checks Drive's
  version first; the sync state records the account (`permissionId`) and a token for another one is refused
  before any file is touched; one sync or settle at a time (`syncRun`); a merge over the backup limits is
  refused. Drive's copy is never taken during a ride.
- Tokens stay in memory, the sign-in window opens only from a tap (Connect, Sync now, Save ride), disconnect
  revokes the token and deletes the sync state.
- One writer: `openStore` claims the data for the tab; every IndexedDB write but `putRide` checks the claim in
  the same transaction, and `saveSettings` checks it before writing localStorage. The older tab stops saving
  and syncing and shows a banner. `putRide` is exempt so a ride recorded in an older tab is never lost.
- The CSP in `index.html` allows Google's sign-in script and style, `www.googleapis.com` and the sign-in frame,
  nothing else. `ui_test.py` stubs all of them with Playwright routes and a fake per-account Drive; real
  Google behaviour (popups, status codes, the account chooser) needs one real sync after deploying.

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

- Pushing to `main` deploys on Vercel, so work on a branch. GitHub Actions only runs the unit tests.
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
