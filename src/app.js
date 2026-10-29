//
// vigo, ERG workouts on an Elite Rampa or an FTMS trainer
//

import { Connection, pickers, trainerSetup, heartRateSetup, speedCadenceSetup, isSupported } from './ble/device.js';
import { RevCounter } from './ble/revs.js';
import { parseWorkout, limits as workoutLimits } from './workout/parse.js';
import { targetAt, segmentIndexAt, toWatts, maxWatts, maxTargetFor } from './workout/target.js';
import { Player } from './workout/player.js';
import { PedalWatch } from './workout/autopause.js';
import { cueTimes, cueAt, nextCue, countdown, textAt } from './workout/cues.js';
import { defaultHrZones, validHrZones, hrZone, maxHrBounds } from './workout/hrzones.js';
import { builtins } from './workout/builtin.js';
import { Recorder, loadSavedRide, clearSavedRide, packRide, sanitizeRide } from './record/recorder.js';
import { encodeActivity, summarize } from './record/fit.js';
import { openStore } from './store/db.js';
import { kinds as deviceKinds, loadDeviceConfig, saveDeviceConfig, rememberDevice, unregisterDevice, pickerFor } from './store/devices.js';
import { workoutId, fromRecord, mergeLibrary, describe } from './store/library.js';
import { makeBackup, readBackup, backupFileName, maxBytes as maxBackupBytes } from './store/backup.js';
import { WorkoutChart, drawProfile } from './ui/chart.js';
import { Beeper } from './ui/sound.js';
import { Router } from './ui/router.js';
import { $, el, formatDuration } from './ui/dom.js';

// settings

const settingsKey = 'vigo.settings';
const legacyWorkoutKey = 'vigo.workout';
const selectedKey = 'vigo.selected';
const bounds = {ftp: [50, 600], wheel: [1000, 3000], bias: [-50, 50], maxHr: maxHrBounds};
const inBounds = ([min, max], x) => Number.isInteger(x) && x >= min && x <= max;
const autoPauseDelays = [0, 5, 10]; // seconds without pedaling, 0 is off

// tyre size -> wheel circumference in mm (ETRTO tables, as used by bike computers)
const wheelSizes = [
    ['700×23c', 2096],
    ['700×25c', 2105],
    ['700×28c', 2136],
    ['700×30c', 2146],
    ['700×32c', 2155],
    ['700×35c', 2168],
    ['700×38c', 2180],
    ['700×40c', 2200],
    ['650b×47 (27.5×1.85)', 2090],
    ['26×2.1', 2068],
    ['27.5×2.1', 2148],
    ['29×2.1', 2288],
];

function readStorage(key) {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch(_) { return null; }
}

function writeStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch(error) { console.warn('vigo: storage', error); }
}

// stored or restored settings -> settings, a missing or bad value takes its default
function sanitizeSettings(saved) {
    if(typeof saved !== 'object' || saved === null) saved = {};
    const maxHr = inBounds(bounds.maxHr, saved.maxHr) ? saved.maxHr : 190;
    return {
        ftp: inBounds(bounds.ftp, saved.ftp) ? saved.ftp : 200,
        wheel: inBounds(bounds.wheel, saved.wheel) ? saved.wheel : 2105,
        sound: typeof saved.sound === 'boolean' ? saved.sound : true,
        autoPause: autoPauseDelays.includes(saved.autoPause) ? saved.autoPause : 0,
        autoStart: typeof saved.autoStart === 'boolean' ? saved.autoStart : false,
        maxHr,
        hrZones: validHrZones(saved.hrZones, maxHr) ? [...saved.hrZones] : defaultHrZones(maxHr),
    };
}

const loadSettings = () => sanitizeSettings(readStorage(settingsKey));

// state

const settings = loadSettings();
let workout;
let bias = 0;
let player;
let lastTarget;
let lastSampleT = 0;
let outOfRange = false;
let autoPaused = false;        // by a trainer drop, resumes when it reconnects
let pausedForPedaling = false; // by auto-pause, resumes when the rider pedals
let waitingToStart = false;    // Start pressed with auto-start on, the ride begins with the first pedal strokes
let pedalWatch = PedalWatch({delay: 0});
let wakeLock;
let finishedRide;
let store;
let library = [...builtins];
let selectedId;
let router;
let cues = [];     // interval cue times of the ride, seconds

const recorder = Recorder();
const beeper = Beeper();
const sound = (name) => { if(settings.sound) beeper[name](); };
const chart = WorkoutChart($('chart'), $('chart-legend'));

// live sensor data

const live = {
    power: [],                  // [ms, watts] for the last few seconds
    heartRate: undefined,
    heartRateAt: -Infinity,
    trainerCadence: undefined,  // rpm, from FTMS trainers without Cycling Power
    trainerCadenceAt: -Infinity,
    cscCrankSeen: false,
    cscWheelSeen: false,
    cpsWheelSeen: false,
    cpsCadence: RevCounter({maxRate: 250 / 60}),
    cscCadence: RevCounter({maxRate: 250 / 60}),
    cscWheel: RevCounter({revsMax: 2 ** 32, maxRate: 35}),
    cpsWheel: RevCounter({revsMax: 2 ** 32, timeResolution: 2048, maxRate: 35}),
};

const now = () => performance.now();

function averagePower(windowMs) {
    const t = now();
    live.power = live.power.filter(([at]) => t - at <= 3000);
    const recent = live.power.filter(([at]) => t - at <= windowMs);
    if(recent.length === 0) return undefined;
    return recent.reduce((sum, [, w]) => sum + w, 0) / recent.length;
}

// below this the rider isn't pedaling: power is the one reading every trainer has, cadence needs a sensor
const pedalingWatts = 5;
const pedaling = () => (averagePower(3000) ?? 0) >= pedalingWatts;

function heartRate() {
    return now() - live.heartRateAt <= 5000 ? live.heartRate : undefined;
}

function cadence() {
    const t = now();
    if(connections.csc.status === 'connected' && live.cscCrankSeen) return live.cscCadence.value(t) * 60;
    if(connections.trainer.status !== 'connected') return undefined;
    if(t - live.trainerCadenceAt <= 5000) return live.trainerCadence;
    return live.cpsCadence.value(t) * 60;
}

// m/s
function speed() {
    const t = now();
    const circumference = settings.wheel / 1000;
    if(connections.csc.status === 'connected' && live.cscWheelSeen) return live.cscWheel.value(t) * circumference;
    if(connections.trainer.status === 'connected' && live.cpsWheelSeen) return live.cpsWheel.value(t) * circumference;
    return undefined;
}

function onPower(data) {
    const t = now();
    if(Number.isFinite(data.power)) live.power.push([t, Math.max(0, data.power)]);
    if(data.crankRevs !== undefined) live.cpsCadence.update(data.crankRevs, data.crankTime, t);
    if(data.wheelRevs !== undefined) {
        live.cpsWheelSeen = true;
        live.cpsWheel.update(data.wheelRevs, data.wheelTime, t);
    }
}

function onTrainerCadence(rpm) {
    if(!Number.isFinite(rpm) || rpm < 0 || rpm > 250) return;
    live.trainerCadence = rpm;
    live.trainerCadenceAt = now();
}

function onSpeedCadence(data) {
    const t = now();
    if(data.crankRevs !== undefined) {
        live.cscCrankSeen = true;
        live.cscCadence.update(data.crankRevs, data.crankTime, t);
    }
    if(data.wheelRevs !== undefined) {
        live.cscWheelSeen = true;
        live.cscWheel.update(data.wheelRevs, data.wheelTime, t);
    }
}

function onHeartRate({heartRate}) {
    if(heartRate > 0 && heartRate < 255) {
        live.heartRate = heartRate;
        live.heartRateAt = now();
    }
}

function onOutOfRange(value) {
    outOfRange = value;
    render();
}

// devices

const connections = {
    trainer: Connection({
        picker: pickers.trainer,
        setup: trainerSetup({onPower, onCadence: onTrainerCadence, onOutOfRange}),
        onStatus: (status) => onDeviceStatus('trainer', status),
    }),
    hr: Connection({
        picker: pickers.heartRate,
        setup: heartRateSetup({onHeartRate}),
        onStatus: (status) => onDeviceStatus('hr', status),
    }),
    csc: Connection({
        picker: pickers.speedCadence,
        setup: speedCadenceSetup({onSpeedCadence}),
        onStatus: (status) => onDeviceStatus('csc', status),
    }),
};

const deviceButtons = {trainer: $('dev-trainer'), hr: $('dev-hr'), csc: $('dev-csc')};
const statusText = {connecting: 'connecting…', searching: 'searching…', reconnecting: 'reconnecting…'};
const devicePickers = {trainer: pickers.trainer, hr: pickers.heartRate, csc: pickers.speedCadence};
const deviceLabels = {trainer: 'Trainer', hr: 'Heart rate', csc: 'Speed/cadence'};

// -> [{kind, name}], the sensors on this ride, for the FIT file
function connectedDevices() {
    return Object.entries(connections)
        .filter(([, connection]) => connection.status === 'connected')
        .map(([kind, connection]) => ({kind, name: connection.name}));
}

let deviceConfig = loadDeviceConfig();
let offeringSaved = false;
// getDevices() exists but didn't return the saved devices: the experimental flag is on without
// the new permissions backend, so Chrome forgets the devices whenever the page is reloaded
let chromeForgot = false;
// getDevices() lists devices allowed earlier, so they connect without a picker (behind a Chrome flag)
const canAutoConnect = () => typeof navigator.bluetooth?.getDevices === 'function';

function onDeviceStatus(kind, status) {
    const button = deviceButtons[kind];
    const connection = connections[kind];
    button.dataset.status = status;
    button.querySelector('.device-name').textContent = statusText[status] ?? (status === 'connected' ? connection.name : '');
    const label = button.dataset.label;
    button.title = `${label}: ${status}${connection.name ? ` (${connection.name})` : ''}`;

    renderDevices();
    if(offeringSaved) offerSavedDevices();

    if(kind === 'csc' && status !== 'connected') {
        live.cscCadence.reset();
        live.cscWheel.reset();
    }

    if(kind === 'trainer') {
        if(status === 'connected') {
            live.cpsCadence.reset();
            live.cpsWheel.reset();
            live.trainerCadenceAt = -Infinity;
            removeBanner('trainer-lost');
            removeBanner('no-trainer');
            if(player?.state === 'running') sendTarget(lastTarget, true);
            if(autoPaused && player?.state === 'paused') {
                autoPaused = false;
                player.start();
            }
        } else if(status === 'reconnecting') {
            outOfRange = false;
            if(player?.state === 'running') {
                autoPaused = true;
                player.pause();
                banner('trainer-lost', 'warn', 'Trainer disconnected. The workout is paused and resumes when it reconnects.');
                sound('alarm');
            }
        } else if(status === 'disconnected') {
            outOfRange = false;
            autoPaused = false;
            removeBanner('trainer-lost');
        }
    }
    render();
}

function connectError(kind, error) {
    // the user closed the picker
    if(error?.name === 'NotFoundError' && /cancel/i.test(error.message)) return;
    console.warn('vigo: connect failed', error);
    banner(`ble-${kind}`, 'error', `Could not connect the ${deviceLabels[kind].toLowerCase()}: ${error?.message ?? error}`);
}

function saveDevice(kind, device) {
    deviceConfig = rememberDevice(deviceConfig, kind, device);
    saveDeviceConfig(deviceConfig);
    renderDevices();
}

async function allowedDevice(kind) {
    const saved = deviceConfig.devices[kind];
    if(!saved || !canAutoConnect()) return undefined;
    try {
        return (await navigator.bluetooth.getDevices()).find((d) => d.id === saved.id);
    } catch(error) {
        console.warn('vigo: getDevices failed', error);
        return undefined;
    }
}

// pick any device of this kind and save it
async function registerDevice(kind) {
    try {
        const device = await connections[kind].connect();
        removeBanner(`ble-${kind}`);
        saveDevice(kind, device);
    } catch(error) {
        connectError(kind, error);
    }
}

// connect the saved device: no picker when the browser still has it, else a picker showing only that name
async function connectSaved(kind) {
    const connection = connections[kind];
    const saved = deviceConfig.devices[kind];
    if(!saved) return registerDevice(kind);
    if(connection.device?.id === saved.id) return connection.adopt(connection.device);

    const allowed = await allowedDevice(kind);
    if(allowed) return connection.adopt(allowed);
    try {
        const device = await connection.connect({picker: pickerFor(devicePickers[kind], saved.name)});
        removeBanner(`ble-${kind}`);
        saveDevice(kind, device); // the id can change when the permission was lost
    } catch(error) {
        connectError(kind, error);
    }
}

async function unregisterKind(kind) {
    const saved = deviceConfig.devices[kind];
    if(!saved) return;
    if(!confirm(`Unregister ${saved.name}? vigo will stop connecting to it.`)) return;
    const connection = connections[kind];
    if(!connection.device) {
        // not used in this session, still revoke the browser's permission
        const allowed = await allowedDevice(kind);
        try { await allowed?.forget?.(); } catch(error) { console.warn('vigo: forget failed', error); }
    }
    await connection.unregister();
    deviceConfig = unregisterDevice(deviceConfig, kind);
    saveDeviceConfig(deviceConfig);
    renderDevices();
    if(offeringSaved) offerSavedDevices();
}

// on startup: adopt the saved devices the browser still allows, offer one-tap buttons for the rest
async function autoConnect() {
    if(!isSupported() || !deviceConfig.autoConnect) return;
    const saved = deviceKinds.filter((kind) => deviceConfig.devices[kind]);
    if(saved.length === 0) return;
    if(canAutoConnect()) {
        let allowed = [];
        try { allowed = await navigator.bluetooth.getDevices(); } catch(error) { console.warn('vigo: getDevices failed', error); }
        for(const kind of saved) {
            const device = allowed.find((d) => d.id === deviceConfig.devices[kind].id);
            if(device) connections[kind].adopt(device);
            else chromeForgot = true;
        }
        renderDevices();
    }
    offeringSaved = true;
    offerSavedDevices();
}

// one button per saved device that isn't connecting, a picker needs a tap of its own
function offerSavedDevices() {
    const missing = deviceKinds.filter((kind) => deviceConfig.devices[kind] && connections[kind].status === 'disconnected');
    if(missing.length === 0 || riding()) {
        offeringSaved = missing.length > 0 && riding();
        removeBanner('saved-devices');
        return;
    }
    banner('saved-devices', 'info', 'Your saved devices need a tap to connect.',
        missing.map((kind) => [`Connect ${deviceConfig.devices[kind].name}`, () => connectSaved(kind)]));
}

function renderDevices() {
    const auto = canAutoConnect();
    $('device-mode').replaceChildren(...(auto && chromeForgot
        ? [
            el('span', {}, 'Chrome forgot your devices since vigo was last opened, so each one needs a tap. To let Chrome remember them, also enable '),
            el('code', {}, 'chrome://flags/#enable-web-bluetooth-new-permissions-backend'),
            el('span', {}, ', then restart Chrome.'),
        ]
        : auto
        ? [el('span', {}, 'Automatic: saved devices connect when vigo opens and keep being searched for until they are on.')]
        : [
            el('span', {}, 'One tap per device. For fully automatic connection enable '),
            el('code', {}, 'chrome://flags/#enable-experimental-web-platform-features'),
            el('span', {}, ' and '),
            el('code', {}, 'chrome://flags/#enable-web-bluetooth-new-permissions-backend'),
            el('span', {}, ', then restart Chrome.'),
        ]));
    $('auto-connect').checked = deviceConfig.autoConnect;

    const list = $('device-list');
    if(list.children.length === 0) {
        list.append(...deviceKinds.map((kind) => {
            const button = (action, label, extra = {}) => {
                const b = el('button', {type: 'button', 'data-action': action, ...extra}, label);
                b.addEventListener('click', () => onDeviceAction(kind, action));
                return b;
            };
            return el('li', {class: 'device-row', 'data-kind': kind}, [
                el('div', {class: 'row-text'}, [
                    el('span', {class: 'row-title'}, [el('span', {class: 'dot', 'aria-hidden': 'true'}), el('span', {}, deviceLabels[kind])]),
                    el('span', {class: 'row-meta', 'data-role': 'saved'}),
                    el('span', {class: 'row-meta', 'data-role': 'status'}),
                ]),
                el('div', {class: 'row-actions'}, [
                    button('connect', 'Connect'),
                    button('register', 'Register'),
                    button('unregister', 'Unregister', {class: 'danger'}),
                ]),
            ]);
        }));
    }

    for(const row of list.children) {
        const kind = row.dataset.kind;
        const connection = connections[kind];
        const saved = deviceConfig.devices[kind];
        const status = connection.status;
        row.dataset.status = status;
        row.querySelector('[data-role="saved"]').textContent = saved ? saved.name : 'Not registered';
        const state = status === 'disconnected' ? 'not connected'
            : status === 'connected' ? `connected${connection.name && connection.name !== saved?.name ? ` to ${connection.name}` : ''}`
                + (connection.link?.protocol ? ` · ${connection.link.protocol}` : '')
            : statusText[status];
        // why the last try failed, so a device that won't connect can be diagnosed
        const why = status !== 'connected' && connection.lastError ? ` · last try: ${connection.lastError}` : '';
        row.querySelector('[data-role="status"]').textContent = state + why;
        const connect = row.querySelector('[data-action="connect"]');
        connect.textContent = status === 'disconnected' ? 'Connect'
            : status === 'searching' || status === 'reconnecting' ? 'Stop' : 'Disconnect';
        connect.hidden = !saved && status === 'disconnected';
        connect.setAttribute('aria-label', `${connect.textContent} ${deviceLabels[kind].toLowerCase()}`);
        const register = row.querySelector('[data-action="register"]');
        register.textContent = saved ? 'Replace' : 'Register';
        register.setAttribute('aria-label', `${register.textContent} ${deviceLabels[kind].toLowerCase()}`);
        const unregister = row.querySelector('[data-action="unregister"]');
        unregister.hidden = !saved;
        unregister.setAttribute('aria-label', `Unregister ${deviceLabels[kind].toLowerCase()}`);
        for(const b of row.querySelectorAll('button')) b.disabled = !isSupported();
    }
}

function onDeviceAction(kind, action) {
    if(action === 'register') return registerDevice(kind);
    if(action === 'unregister') return unregisterKind(kind);
    if(connections[kind].status === 'disconnected') return connectSaved(kind);
    connections[kind].disconnect();
}

// the header buttons show the status and lead to the device setup
function onDeviceClick() {
    if(riding()) return;
    router.go('settings');
    $('devices-card').scrollIntoView({block: 'start'});
}

// trainer control

function sendTarget(watts, force = false) {
    if(watts === undefined) return;
    if(watts === lastTarget && !force) return;
    lastTarget = watts;
    if(player?.state === 'running') connections.trainer.link?.setTarget(watts);
}

function releaseTrainer() {
    connections.trainer.link?.release();
}

function currentTarget(t) {
    return workout ? targetAt(workout, {ftp: settings.ftp, t, bias}) : undefined;
}

// workout library

const riding = () => player?.state === 'running' || player?.state === 'paused';

// (String, {navigate: Bool}) -> Void, navigate goes back to the ride screen
function selectWorkout(id, {navigate = false} = {}) {
    if(player && player.state !== 'finished') return;
    // a finished ride stays on screen until another workout is picked
    if(player) {
        player = undefined;
        chart.clearTraces();
        chart.progress(0);
        document.body.dataset.state = 'idle';
    }
    const entry = library.find((e) => e.id === id);
    workout = entry?.workout;
    selectedId = entry?.id;
    lastTarget = undefined;
    writeStorage(selectedKey, selectedId ?? null);
    drawWorkout();
    renderLibrary();
    if(navigate && entry) router?.go('ride');
}

const squash = (text) => text.toLowerCase().replace(/[\s_]+/g, ' ').trim();

// Workout -> String, empty when it only repeats the name
function descriptionOf(workout) {
    return squash(workout.description) === squash(workout.name) ? '' : workout.description;
}

function drawWorkout() {
    if(!workout) {
        $('workout-name').textContent = '';
        $('workout-description').textContent = '';
        $('workout-meta').textContent = '';
        $('chart-empty').hidden = false;
        $('btn-start').disabled = true;
        return;
    }
    chart.draw(workout, {ftp: settings.ftp, bias});
    $('chart-empty').hidden = true;
    $('workout-name').textContent = workout.name;
    $('workout-description').textContent = descriptionOf(workout);
    const d = describe(workout, settings.ftp);
    const peak = d.peakWatts > hardFraction * settings.ftp
        ? ` · peaks at ${d.peakWatts} W${d.peakCapped ? ' (capped)' : ''}` : '';
    $('workout-meta').textContent =
        `${formatDuration(d.duration)} · ${workout.segments.length} intervals · avg ${d.avgWatts} W · ${d.scaling}${peak}`;
    $('btn-start').disabled = false;
}

async function refreshLibrary() {
    let records = [];
    try {
        records = await store.getAll('workouts');
    } catch(error) {
        console.warn('vigo: could not read workouts', error);
    }
    library = mergeLibrary(builtins, records.map(fromRecord).filter(Boolean));
    renderLibrary();
}

// rows are kept and updated in place: replacing a button between mousedown and mouseup
// (an FTP change fires on blur, right as a row is tapped) would swallow the click
const libraryRows = new Map(); // id -> {li, select, meta, text}

function libraryRow(entry) {
    const meta = el('span', {class: 'row-meta'});
    const select = el('button', {type: 'button', class: 'workout-row'}, [
        el('span', {class: 'profile-slot'}),
        el('span', {class: 'row-text'}, [
            el('span', {class: 'row-title'}, entry.name),
            el('span', {class: 'row-description'}, descriptionOf(entry.workout)),
            meta,
        ]),
    ]);
    select.addEventListener('click', () => selectWorkout(entry.id, {navigate: true}));

    const children = [select];
    if(!entry.builtin) {
        const remove = el('button', {type: 'button', class: 'icon-button', 'aria-label': `Delete ${entry.name}`}, '×');
        remove.addEventListener('click', () => deleteWorkout(entry));
        children.push(remove);
    }
    return {li: el('li', {}, children), select, meta, text: entry.text, ftp: undefined};
}

function renderLibrary() {
    const items = library.map((entry) => {
        let row = libraryRows.get(entry.id);
        if(!row || row.text !== entry.text) {
            row = libraryRow(entry);
            libraryRows.set(entry.id, row);
        }
        row.select.setAttribute('aria-pressed', entry.id === selectedId ? 'true' : 'false');
        if(row.ftp !== settings.ftp) {
            row.ftp = settings.ftp;
            const d = describe(entry.workout, settings.ftp);
            row.meta.textContent = `${formatDuration(d.duration)} · avg ${d.avgWatts} W`;
            row.select.querySelector('.profile-slot').replaceChildren(drawProfile(entry.workout, settings.ftp));
        }
        return row.li;
    });
    for(const id of [...libraryRows.keys()]) {
        if(!library.some((e) => e.id === id)) libraryRows.delete(id);
    }
    const list = $('workout-list');
    const same = list.children.length === items.length && items.every((li, i) => list.children[i] === li);
    if(!same) list.replaceChildren(...items);
}

// (String, String) -> Promise, add an upload to the library, or refresh it if it's there already
async function addWorkout(text, fileName) {
    const id = await storeWorkout(text, fileName);
    await refreshLibrary();
    selectWorkout(id);
}

// (String, String, {addedAt?, lastUsedAt?}) -> Promise<String>, the id; an upload is used now
async function storeWorkout(text, fileName, {addedAt, lastUsedAt} = {}) {
    const workout = parseWorkout(text, {fileName});
    const id = await workoutId(text);
    const existing = await store.get('workouts', id).catch(() => undefined);
    const now = Date.now();
    await store.put('workouts', {
        id,
        name: workout.name,
        fileName: String(fileName).slice(0, 200),
        text,
        addedAt: Number.isFinite(existing?.addedAt) ? existing.addedAt : addedAt ?? now,
        lastUsedAt: Math.max(lastUsedAt ?? now, Number.isFinite(existing?.lastUsedAt) ? existing.lastUsedAt : 0),
    });
    return id;
}

async function deleteWorkout(entry) {
    if(!confirm(`Delete the workout "${entry.name}"?`)) return;
    try {
        await store.delete('workouts', entry.id);
    } catch(error) {
        $('setup-error').textContent = `Could not delete: ${error.message}`;
        return;
    }
    await refreshLibrary();
    if(selectedId === entry.id) selectWorkout(library[0]?.id);
}

async function touchWorkout(id) {
    if(!id?.startsWith('u-')) return;
    try {
        const record = await store.get('workouts', id);
        if(record) await store.put('workouts', {...record, lastUsedAt: Date.now()});
    } catch(error) {
        console.warn('vigo: could not update the workout', error);
    }
}

async function onFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if(!file) return;
    $('setup-error').textContent = '';
    try {
        if(file.size > workoutLimits.maxBytes) throw new Error('The file is larger than 1 MB.');
        await addWorkout(await file.text(), file.name);
    } catch(error) {
        $('setup-error').textContent = `Could not load ${file.name}: ${error.message}`;
    }
}

function onSettingsInput(key, input) {
    const value = Number(input.value);
    if(!inBounds(bounds[key], value)) {
        const messages = {
            ftp: 'FTP must be a whole number between 50 and 600.',
            wheel: 'Pick a tyre size from the list.',
            maxHr: `Max heart rate must be a whole number between ${bounds.maxHr[0]} and ${bounds.maxHr[1]}.`,
        };
        $(key === 'maxHr' ? 'hr-error' : 'settings-error').textContent = messages[key];
        return;
    }
    $(key === 'maxHr' ? 'hr-error' : 'settings-error').textContent = '';
    if(settings[key] === value) return;
    settings[key] = value;
    // the zones follow max HR, edits to single zones start again from the standard split
    if(key === 'maxHr') {
        settings.hrZones = defaultHrZones(value);
        renderHrZones();
    }
    writeStorage(settingsKey, settings);
    if(key === 'ftp') {
        drawWorkout();
        renderLibrary();
    }
}

// (Int) -> Void, zone i's lower bound edited in Settings
function onHrZoneInput(i) {
    const next = [...settings.hrZones];
    next[i] = Number($(`hr-z${i + 1}`).value);
    if(!validHrZones(next, settings.maxHr)) {
        $('hr-error').textContent = `Zones must go up, each a whole number between 40 and your max heart rate (${settings.maxHr}).`;
        return;
    }
    $('hr-error').textContent = '';
    settings.hrZones = next;
    writeStorage(settingsKey, settings);
}

function renderHrZones() {
    $('max-hr').value = settings.maxHr;
    settings.hrZones.forEach((bpm, i) => { $(`hr-z${i + 1}`).value = bpm; });
}

function renderWheelSizes() {
    const options = wheelSizes.map(([label, mm]) => el('option', {value: mm}, label));
    // a value saved before the list existed, or by hand, is kept rather than silently changed
    if(!wheelSizes.some(([, mm]) => mm === settings.wheel)) {
        options.push(el('option', {value: settings.wheel}, `Custom (${settings.wheel} mm)`));
    }
    $('wheel').replaceChildren(...options);
    $('wheel').value = String(settings.wheel);
}

function setBias(next) {
    bias = Math.min(Math.max(next, bounds.bias[0]), bounds.bias[1]);
    $('bias').textContent = `${100 + bias}%`;
    if(workout) {
        chart.draw(workout, {ftp: settings.ftp, bias});
        if(player && player.state !== 'finished') {
            chart.progress(player.elapsed);
            sendTarget(currentTarget(player.elapsed));
        }
    }
}

// ride

const nowSeconds = () => Math.floor(Date.now() / 1000);

// above this share of FTP a workout is checked with the rider before it starts
const hardFraction = 1.5;

// (Workout) -> Bool, a very hard or odd file is confirmed before the trainer gets it
function confirmHardWorkout(workout) {
    const ftp = settings.ftp;
    const peak = Math.min(maxTargetFor(ftp), Math.round(maxWatts(workout, ftp) * (1 + bias / 100)));
    if(peak <= hardFraction * ftp) return true;
    return confirm(`${workout.name} goes up to ${peak} W, ${Math.round(peak / ftp * 100)}% of your FTP. Start it?`);
}

function begin() {
    if(!workout) return;
    if(!confirmHardWorkout(workout)) return;
    finishedRide = undefined;
    lastTarget = undefined;
    lastSampleT = 0;
    autoPaused = false;
    pausedForPedaling = false;
    chart.clearTraces();
    chart.progress(0);
    if(settings.autoStart && !pedaling()) {
        waitingToStart = true;
        document.body.dataset.state = 'waiting';
        keepAwake();
        return render();
    }
    startRide();
}

function startRide() {
    waitingToStart = false;
    pedalWatch = PedalWatch({delay: settings.autoPause});
    recorder.start({
        t: nowSeconds(), workoutName: workout.name, ftp: settings.ftp,
        maxHr: settings.maxHr, hrZones: settings.hrZones, devices: connectedDevices(),
    });
    touchWorkout(selectedId);
    cues = cueTimes(workout, settings.ftp);
    player = Player({workout, onTick, onState});
    player.start();
}

function cancelWaiting() {
    waitingToStart = false;
    document.body.dataset.state = player?.state ?? 'idle';
    releaseWakeLock();
    render();
}

// called from the render loop: auto-start and auto-pause
function checkPedaling() {
    const ready = connections.trainer.status === 'connected';
    if(waitingToStart) {
        if(ready && pedaling()) startRide();
        return;
    }
    if(player?.state === 'running') {
        if(pedalWatch.update(now() / 1000, pedaling()) !== 'stopped') return;
        pausedForPedaling = true;
        player.pause();
    } else if(pausedForPedaling && player?.state === 'paused' && !autoPaused && ready) {
        if(pedalWatch.update(now() / 1000, pedaling()) !== 'pedaling') return;
        pausedForPedaling = false;
        player.start();
    }
}

function onTick(second) {
    sendTarget(currentTarget(second));
    const cue = cueAt(cues, second);
    if(cue) sound(cue);

    const power = averagePower(1000);
    const t = Math.max(lastSampleT + 1, nowSeconds());
    lastSampleT = t;
    // a new interval is a new lap in the FIT file
    if(cue === 'go') recorder.lap(t);
    const hr = heartRate();
    const rpm = cadence() === undefined ? undefined : Math.round(cadence());
    recorder.sample({
        t,
        power: power === undefined ? undefined : Math.round(power),
        heartRate: hr,
        cadence: rpm,
        speed: speed(),
    });
    chart.addSample(second, {power, heartRate: hr, cadence: rpm});
}

function onState(state) {
    document.body.dataset.state = state;
    if(state === 'running') {
        if(router?.current !== 'ride') router?.go('ride');
        recorder.resume(nowSeconds());
        pedalWatch.reset(); // a Resume while still is given the full delay
        sendTarget(currentTarget(player.elapsed) ?? lastTarget, true);
        keepAwake();
    } else if(state === 'paused') {
        recorder.pause(nowSeconds());
        releaseTrainer();
    } else if(state === 'finished') {
        releaseTrainer();
        recorder.save();
        releaseWakeLock();
        autoPaused = false;
        pausedForPedaling = false;
        removeBanner('trainer-lost');
        finishedRide = recorder.ride;
        // the end of the workout, not End
        if(!discardOnFinish && workout && player.elapsed >= workout.duration) sound('finish');
        if(discardOnFinish) {
            discardOnFinish = false;
            finishedRide = undefined;
            recorder.clear();
        } else if(finishedRide.samples.length > 0) {
            showSummary(finishedRide, 'done');
            finishRide(finishedRide);
        }
    }
    render();
}

// starting or resuming without the trainer would ride with no ERG control
function trainerReady() {
    const status = connections.trainer.status;
    if(status === 'connected') return true;
    const saved = deviceConfig.devices.trainer;
    const actions = [['Settings', () => router.go('settings')]];
    let message;
    if(status === 'reconnecting' || status === 'connecting') {
        message = 'The trainer is reconnecting. Wait for it to connect, then press Start.';
    } else if(status === 'searching') {
        message = `Looking for ${saved?.name ?? 'the trainer'}. Turn it on and pedal, it connects by itself.`;
    } else if(saved) {
        message = `${saved.name} is not connected. Connect it, then press Start.`;
        actions.unshift([`Connect ${saved.name}`, () => connectSaved('trainer')]);
    } else {
        message = 'No trainer is registered. Register it in Settings, then press Start.';
    }
    banner('no-trainer', 'error', message, actions);
    return false;
}

function onStartClick() {
    beeper.unlock(); // a click is the only place audio can be allowed
    if(waitingToStart) return cancelWaiting();
    if(player?.state !== 'running' && !trainerReady()) return;
    removeBanner('no-trainer');
    if(!player || player.state === 'finished') return begin();
    // a pause from the button stays until Resume
    autoPaused = false;
    pausedForPedaling = false;
    if(player.state === 'running') return player.pause();
    if(player.state === 'paused') return player.start();
}

// End opens the summary dialog with the ride so far: save it, discard it or keep riding.
// The ride is paused meanwhile, so the trainer lets go and the clock stops.
let endingWasRunning = false;
let discardOnFinish = false;

function onEndClick() {
    if(!player || player.state === 'finished') return;
    // ended in the first second: nothing to save or lose
    if(recorder.ride.samples.length === 0) return player.finish();
    pausedForPedaling = false;
    endingWasRunning = player.state === 'running';
    if(endingWasRunning) player.pause();
    showSummary(recorder.ride, 'ending');
}

function keepRiding() {
    $('summary').close();
    if(endingWasRunning) onStartClick();
}

function saveRideAndEnd() {
    $('summary').close();
    player.finish(); // the finished state saves it and shows the summary again, as saved
}

function discardRide() {
    discardOnFinish = true;
    $('summary').close();
    player.finish();
}

// summary and export

// (Ride, 'ending' | 'done') -> Void
function showSummary(ride, mode) {
    const s = summarize(ride);
    const ending = mode === 'ending';
    $('summary-title').textContent = ending ? 'End the workout?' : 'Ride done';
    $('ending-actions').hidden = !ending;
    $('done-actions').hidden = ending;
    $('summary').dataset.mode = mode;
    $('summary-name').textContent = ride.workoutName;
    $('summary-error').textContent = '';
    const round = (x, unit) => (Number.isFinite(x) ? `${Math.round(x)} ${unit}` : '--');
    const rows = [
        ['Time', formatDuration(s.totalTimerTime)],
        ['Average power', round(s.avgPower, 'W')],
        ['Max power', round(s.maxPower, 'W')],
        ['Average heart rate', round(s.avgHeartRate, 'bpm')],
        ['Average cadence', round(s.avgCadence, 'rpm')],
        ['Distance', Number.isFinite(s.totalDistance) && s.totalDistance > 0 ? `${(s.totalDistance / 1000).toFixed(2)} km` : '--'],
        ['Energy', round(s.totalCalories, 'kJ')],
    ];
    $('summary-stats').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
    $('summary-saved').textContent = ending ? 'The ride is paused.' : 'Saving to history…';
    if(!$('summary').open) $('summary').showModal();
}

function fileName(ride) {
    const d = new Date(ride.samples[0].t * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `vigo-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.fit`;
}

function download(ride) {
    const bytes = encodeActivity(ride, {timezoneOffset: new Date(ride.samples[0].t * 1000).getTimezoneOffset()});
    const url = URL.createObjectURL(new Blob([bytes], {type: 'application/vnd.ant.fit'}));
    const a = el('a', {href: url, download: fileName(ride)});
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// history

// (Ride, {interrupted}) -> Promise
async function saveRide(ride, {interrupted = false} = {}) {
    const id = `r-${ride.samples[0].t}`;
    const packed = packRide(ride);
    await store.putRide(
        {id, startedAt: ride.samples[0].t, workoutName: ride.workoutName, ftp: ride.ftp ?? null, interrupted,
         summary: summarize(ride)},
        {id, ...packed},
    );
}

async function finishRide(ride) {
    try {
        await saveRide(ride);
        clearSavedRide();
        $('summary-saved').textContent = store.persistent ? 'Saved to history.' : 'Kept in history until you close the page.';
    } catch(error) {
        console.warn('vigo: could not save the ride', error);
        $('summary-saved').textContent = '';
        $('summary-error').textContent = `Could not save to history: ${error.message}. Download the .FIT now.`;
    }
    await refreshHistory();
}

// a ride autosaved before a reload or a crash goes into the history
async function importSavedRide() {
    const ride = loadSavedRide();
    if(!ride) return;
    try {
        await saveRide(ride, {interrupted: true});
        clearSavedRide();
        const when = new Date(ride.samples[0].t * 1000).toLocaleString();
        banner('saved-ride', 'info', `A ride from ${when} was interrupted, ${formatDuration(ride.samples.length)} were saved to the history.`, [
            ['OK', () => removeBanner('saved-ride')],
        ]);
    } catch(error) {
        console.warn('vigo: could not import the interrupted ride', error);
        banner('saved-ride', 'warn', 'A ride was interrupted and could not be saved to the history.', [
            ['Download .FIT', () => {
                try {
                    download(ride);
                } catch(e) {
                    banner('saved-ride-error', 'error', `Export failed: ${e.message}`);
                }
            }],
        ]);
    }
}

async function refreshHistory() {
    let rides = [];
    try {
        rides = await store.getAll('rides');
    } catch(error) {
        console.warn('vigo: could not read the history', error);
    }
    rides = rides
        .filter((r) => typeof r?.id === 'string' && Number.isFinite(r.startedAt))
        .sort((a, b) => b.startedAt - a.startedAt);

    $('history-empty').hidden = rides.length > 0;
    const round = (x, unit) => (Number.isFinite(x) ? `${Math.round(x)} ${unit}` : null);
    $('history-list').replaceChildren(...rides.map((ride) => {
        const s = ride.summary ?? {};
        const name = typeof ride.workoutName === 'string' && ride.workoutName ? ride.workoutName : 'Ride';
        const stats = [
            formatDuration(s.totalTimerTime),
            round(s.avgPower, 'W'),
            round(s.avgHeartRate, 'bpm'),
        ].filter(Boolean).join(' · ');
        const title = el('span', {class: 'row-title'}, name);
        if(ride.interrupted === true) title.append(el('span', {class: 'tag'}, 'stopped early'));

        const get = el('button', {type: 'button', 'aria-label': `Download ${name} as .FIT`}, '.FIT');
        get.addEventListener('click', () => downloadRide(ride.id));
        const remove = el('button', {type: 'button', class: 'icon-button', 'aria-label': `Delete ride ${name}`}, '×');
        remove.addEventListener('click', () => deleteRide(ride.id, name));

        return el('li', {}, [
            el('div', {class: 'history-row row-text'}, [
                title,
                el('span', {class: 'row-meta'}, new Date(ride.startedAt * 1000).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})),
                el('span', {class: 'row-meta'}, stats),
            ]),
            el('div', {class: 'row-actions'}, [get, remove]),
        ]);
    }));
}

async function downloadRide(id) {
    try {
        const ride = sanitizeRide(await store.get('rideData', id));
        if(!ride) throw new Error('the ride data is missing or damaged');
        download(ride);
    } catch(error) {
        banner('history-error', 'error', `Export failed: ${error.message}`);
    }
}

async function deleteRide(id, name) {
    if(!confirm(`Delete the ride "${name}"? This can't be undone.`)) return;
    try {
        await store.deleteRide(id);
    } catch(error) {
        banner('history-error', 'error', `Could not delete: ${error.message}`);
    }
    await refreshHistory();
}

// backup and restore

async function downloadBackup() {
    $('backup-error').textContent = '';
    $('backup-status').textContent = '';
    try {
        const workouts = (await store.getAll('workouts')).filter((w) => typeof w?.text === 'string');
        const metas = new Map((await store.getAll('rides')).map((r) => [r?.id, r]));
        const rides = (await store.getAll('rideData'))
            .filter((r) => typeof r?.id === 'string')
            .map(({id, ...packed}) => ({interrupted: metas.get(id)?.interrupted === true, ...packed}));
        const json = JSON.stringify(makeBackup({settings, workouts, rides}));
        const url = URL.createObjectURL(new Blob([json], {type: 'application/json'}));
        const a = el('a', {href: url, download: backupFileName()});
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        $('backup-status').textContent = `Saved ${count(workouts.length, 'workout')} and ${count(rides.length, 'ride')}.`;
    } catch(error) {
        $('backup-error').textContent = `Backup failed: ${error.message}`;
    }
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

async function onRestoreFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if(!file) return;
    $('backup-error').textContent = '';
    $('backup-status').textContent = '';
    if(riding() || waitingToStart) {
        $('backup-error').textContent = 'End the ride before restoring a backup.';
        return;
    }
    try {
        if(file.size > maxBackupBytes) throw new Error('The file is too large to be a vigo backup.');
        const backup = readBackup(await file.text());
        const what = [count(backup.workouts.length, 'workout'), count(backup.rides.length, 'ride')];
        const message = `Restore ${what.join(' and ')}${backup.settings ? ' and the settings' : ''} from ${file.name}? `
            + 'They are added to what is here; workouts and rides already here are kept.';
        if(!confirm(message)) return;
        for(const w of backup.workouts) {
            await storeWorkout(w.text, w.fileName, {addedAt: w.addedAt, lastUsedAt: w.lastUsedAt});
        }
        for(const {ride, interrupted} of backup.rides) await saveRide(ride, {interrupted});
        if(backup.settings) restoreSettings(backup.settings);
        await refreshLibrary();
        await refreshHistory();
        const skipped = backup.skipped
            ? ` ${backup.skipped} damaged ${backup.skipped === 1 ? 'entry was' : 'entries were'} skipped.` : '';
        $('backup-status').textContent = `Restored ${what.join(' and ')}.${skipped}`;
    } catch(error) {
        $('backup-error').textContent = `Could not restore ${file.name}: ${error.message}`;
    }
}

function restoreSettings(saved) {
    Object.assign(settings, sanitizeSettings(saved));
    writeStorage(settingsKey, settings);
    showSettings();
    drawWorkout();
}

// banners

function banner(id, kind, text, actions = []) {
    const node = el('div', {class: `banner ${kind}`, 'data-id': id}, [
        el('p', {}, text),
        el('div', {class: 'actions'}, actions.map(([label, onClick]) => {
            const button = el('button', {type: 'button'}, label);
            button.addEventListener('click', onClick);
            return button;
        })),
    ]);
    const old = [...$('banners').children].find((b) => b.dataset.id === id);
    if(old) old.replaceWith(node);
    else $('banners').append(node);
}

function removeBanner(id) {
    [...$('banners').children].find((b) => b.dataset.id === id)?.remove();
}

// screen wake lock

async function keepAwake() {
    if(!navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
    } catch(error) {
        console.warn('vigo: wake lock', error);
    }
}

function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = undefined;
}

// rendering

const text = (id, value) => {
    const node = $(id);
    if(node.textContent !== value) node.textContent = value;
};
const number = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '--');

function render() {
    checkPedaling();
    const state = player?.state ?? 'idle';
    const elapsed = player?.elapsed ?? 0;

    text('v-power', number(averagePower(3000)));
    const hr = heartRate();
    text('v-hr', number(hr));
    const hrZoneNow = String(hrZone(hr, settings.hrZones));
    if($('v-hr').dataset.zone !== hrZoneNow) $('v-hr').dataset.zone = hrZoneNow;
    text('v-cadence', number(cadence()));
    const v = speed();
    text('v-speed', Number.isFinite(v) ? `rpm · ${(v * 3.6).toFixed(1)} km/h` : 'rpm');

    const target = state === 'finished' ? undefined
        : state === 'running' || state === 'paused' ? currentTarget(elapsed) : currentTarget(0);
    text('v-target', number(target));
    $('tile-target').classList.toggle('out-of-range', outOfRange && state === 'running');
    text('v-target-note', outOfRange && state === 'running' ? 'Pedal faster'
        : Number.isFinite(target) ? `W · ${Math.round(target / settings.ftp * 100)}% FTP` : 'W');

    if(workout && state !== 'finished') {
        const index = segmentIndexAt(workout, elapsed);
        const segment = workout.segments[index];
        if(segment) {
            text('v-interval', formatDuration(Math.ceil(segment.start + segment.duration - elapsed)));
            const next = workout.segments[index + 1];
            const scale = 1 + bias / 100;
            const nextWatts = next && Math.round(toWatts(workout, next.from, settings.ftp) * scale);
            // the last seconds before the power jumps, whether or not sound is on
            const cue = state === 'running' ? nextCue(cues, elapsed) : undefined;
            const inCountdown = cue !== undefined && cue - elapsed <= countdown;
            const countdownText = cue >= workout.duration ? `end in ${Math.ceil(cue - elapsed)}`
                : `${number(currentTarget(cue))} W in ${Math.ceil(cue - elapsed)}`;
            text('v-next', inCountdown ? countdownText : next ? `next ${nextWatts} W` : 'last interval');
            $('tile-interval').classList.toggle('countdown', inCountdown);
        }
        text('v-remaining', `${formatDuration(workout.duration - elapsed)} left`);
    } else {
        text('v-interval', '--:--');
        text('v-next', ' ');
        text('v-remaining', ' ');
        $('tile-interval').classList.remove('countdown');
    }
    text('v-elapsed', formatDuration(elapsed));
    const message = waitingToStart ? 'Start pedaling to begin'
        : pausedForPedaling && state === 'paused' ? 'Paused. Pedal to resume'
        : workout && (state === 'running' || state === 'paused') ? textAt(workout.texts, elapsed) : undefined;
    text('cue-text', message ?? '');
    $('cue-text').hidden = message === undefined;
    if(player && state !== 'finished') chart.progress(elapsed);

    const riding = state === 'running' || state === 'paused';
    text('btn-start', waitingToStart ? 'Cancel' : state === 'running' ? 'Pause' : state === 'paused' ? 'Resume' : 'Start');
    $('btn-start').classList.toggle('primary', state !== 'running' && !waitingToStart);
    $('btn-start').disabled = !workout;
    $('btn-skip').disabled = !riding;
    $('btn-end').disabled = !riding;
    $('file').disabled = riding || waitingToStart || !store;
    $('btn-backup').disabled = !store;
    $('restore-file').disabled = riding || waitingToStart || !store;
}

// wiring

// GitHub Pages can't send frame-ancestors or X-Frame-Options, so refuse to run inside another
// page's frame: a page on top could trick clicks onto Start, End or Delete (clickjacking)
function framed() {
    try {
        return window.top !== window.self;
    } catch(_) {
        return true;
    }
}

// the settings into their inputs
function showSettings() {
    $('ftp').value = settings.ftp;
    $('sound').checked = settings.sound;
    $('auto-pause').value = String(settings.autoPause);
    $('auto-start').checked = settings.autoStart;
    renderWheelSizes();
    renderHrZones();
}

function refuseFramed() {
    const open = el('a', {href: location.href, target: '_top', rel: 'noopener'}, 'Open vigo');
    document.body.replaceChildren(el('main', {class: 'page'}, [
        el('h1', {}, 'vigo'),
        el('p', {}, 'vigo only works when it is opened directly, not inside another page.'),
        el('p', {}, [open]),
    ]));
}

function init() {
    if(framed()) return refuseFramed();
    document.body.dataset.state = 'idle';
    showSettings();

    if(!isSupported()) {
        banner('no-ble', 'error', 'This browser has no Web Bluetooth. Use Chrome or Edge on a laptop or on Android.');
        Object.values(deviceButtons).forEach((b) => { b.disabled = true; });
    }

    for(const button of Object.values(deviceButtons)) {
        button.addEventListener('click', onDeviceClick);
    }
    $('auto-connect').addEventListener('change', (e) => {
        deviceConfig = {...deviceConfig, autoConnect: e.target.checked};
        saveDeviceConfig(deviceConfig);
    });
    renderDevices();
    $('file').addEventListener('change', onFile);
    $('ftp').addEventListener('change', (e) => onSettingsInput('ftp', e.target));
    $('wheel').addEventListener('change', (e) => onSettingsInput('wheel', e.target));
    $('max-hr').addEventListener('change', (e) => onSettingsInput('maxHr', e.target));
    settings.hrZones.forEach((_, i) => $(`hr-z${i + 1}`).addEventListener('change', () => onHrZoneInput(i)));
    $('sound').addEventListener('change', (e) => {
        settings.sound = e.target.checked;
        writeStorage(settingsKey, settings);
        if(settings.sound) {
            beeper.unlock();
            beeper.count(); // what it sounds like
        }
    });
    $('auto-pause').addEventListener('change', (e) => {
        const delay = Number(e.target.value);
        if(!autoPauseDelays.includes(delay)) return;
        settings.autoPause = delay;
        writeStorage(settingsKey, settings);
    });
    $('auto-start').addEventListener('change', (e) => {
        settings.autoStart = e.target.checked;
        writeStorage(settingsKey, settings);
    });
    $('btn-backup').addEventListener('click', downloadBackup);
    $('restore-file').addEventListener('change', onRestoreFile);
    $('btn-start').addEventListener('click', onStartClick);
    $('btn-skip').addEventListener('click', () => player?.skip());
    $('btn-end').addEventListener('click', onEndClick);
    $('bias-down').addEventListener('click', () => setBias(bias - 5));
    $('bias-up').addEventListener('click', () => setBias(bias + 5));
    $('btn-close').addEventListener('click', () => $('summary').close());
    $('btn-save').addEventListener('click', saveRideAndEnd);
    $('btn-keep').addEventListener('click', keepRiding);
    $('btn-discard').addEventListener('click', discardRide);
    // Esc while ending means not now: keep riding
    $('summary').addEventListener('cancel', (event) => {
        if($('summary').dataset.mode !== 'ending') return;
        event.preventDefault();
        keepRiding();
    });
    $('btn-download').addEventListener('click', () => {
        if(!finishedRide) return;
        try {
            download(finishedRide);
        } catch(error) {
            $('summary-error').textContent = `Export failed: ${error.message}`;
        }
    });

    document.addEventListener('visibilitychange', () => {
        if(document.visibilityState === 'visible' && player?.state === 'running') keepAwake();
        // back from the lock screen or another app: look for the devices again now
        if(document.visibilityState === 'visible') Object.values(connections).forEach((c) => c.nudge());
        if(document.visibilityState === 'hidden' && riding()) recorder.save();
    });
    window.addEventListener('pagehide', () => {
        if(riding()) recorder.save();
    });
    window.addEventListener('beforeunload', (event) => {
        if(riding()) event.preventDefault();
    });

    renderLibrary();
    router = Router({
        canLeaveRide: () => !riding() && !waitingToStart,
        onChange: (view) => {
            if(!store) return;
            if(view === 'history') refreshHistory();
            if(view === 'workouts') renderLibrary();
        },
    });
    render();
    setInterval(render, 250);

    if('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch((error) => console.warn('vigo: service worker', error));
    }

    autoConnect();
    loadData();
    loadVersion();
}

// version.json is written by the deploy workflow, the dev server makes one from git
async function loadVersion() {
    try {
        const response = await fetch('version.json', {cache: 'no-store'});
        if(!response.ok) return;
        const commit = (await response.json())?.commit;
        if(typeof commit !== 'string' || !/^[0-9a-f]{7,40}(-dirty)?$/.test(commit)) return;
        const sha = commit.replace(/-dirty$/, '');
        const link = $('version');
        link.textContent = commit.endsWith('-dirty') ? `${sha.slice(0, 7)}+` : sha.slice(0, 7);
        link.href = `https://github.com/n03l/vigo/commit/${sha}`;
        link.title = `Build ${commit}`;
    } catch(error) {
        console.warn('vigo: no version', error);
    }
}

async function loadData() {
    store = await openStore();
    if(!store.persistent) {
        banner('no-storage', 'warn', "This browser won't let vigo store data: uploaded workouts and rides are lost when you close the page.");
    }
    await migrateLegacyWorkout();
    await refreshLibrary();
    if(!selectedId) {
        const saved = readStorage(selectedKey);
        selectWorkout(library.some((e) => e.id === saved) ? saved : library[0]?.id);
    }
    await importSavedRide();
    await refreshHistory();
    render();
}

// earlier versions kept only the last upload, in localStorage
async function migrateLegacyWorkout() {
    const saved = readStorage(legacyWorkoutKey);
    if(typeof saved?.text !== 'string') return;
    try {
        await addWorkout(saved.text, typeof saved.fileName === 'string' ? saved.fileName : '');
    } catch(error) {
        console.warn('vigo: the old saved workout could not be imported', error);
    }
    try { localStorage.removeItem(legacyWorkoutKey); } catch(_) { /* storage blocked */ }
}

init();
