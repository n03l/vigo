//
// Ride recorder
//
// One sample per second of riding, autosaved so a reload or a crash doesn't lose the ride.
// The saved copy is read back from storage, so it's validated like any other input.
//

const storageKey = 'vigo.ride';
const saveEvery = 10; // samples
const maxSamples = 24 * 3600;

const maxLaps = 2000;
const deviceKinds = ['trainer', 'hr', 'csc'];

const finiteOrNull = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const cleanName = (x, max) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max) : '');

// Any -> [Int] | null, five heart rate zone bounds going up
function zonesOrNull(zones) {
    if(!Array.isArray(zones) || zones.length !== 5) return null;
    const ok = zones.every((z, i) => Number.isInteger(z) && z > 0 && z < 256 && (i === 0 || z > zones[i - 1]));
    return ok ? [...zones] : null;
}

// Any -> [{kind, name}]
function cleanDevices(devices) {
    if(!Array.isArray(devices)) return [];
    return devices
        .filter((d) => deviceKinds.includes(d?.kind))
        .slice(0, deviceKinds.length)
        .map((d) => ({kind: d.kind, name: cleanName(d.name, 40)}));
}

function emptyRide() {
    return {samples: [], events: [], laps: [], workoutName: '', ftp: null, maxHr: null, hrZones: null, devices: []};
}

// Ride {samples, events, laps: [t] (interval starts), workoutName, ftp, maxHr, hrZones, devices: [{kind, name}]}
export function Recorder({storage = globalThis.localStorage} = {}) {
    let ride = emptyRide();
    let distance = 0;
    let unsaved = 0;

    function start({t, workoutName = '', ftp = null, maxHr = null, hrZones = null, devices = []}) {
        ride = {
            ...emptyRide(),
            events: [{t, type: 'start'}],
            workoutName: String(workoutName),
            ftp: finiteOrNull(ftp),
            maxHr: finiteOrNull(maxHr),
            hrZones: zonesOrNull(hrZones),
            devices: cleanDevices(devices),
        };
        distance = 0;
        save();
    }

    // Number -> Void, a new interval starts at t
    function lap(t) {
        if(ride.laps.length >= maxLaps || ride.laps.at(-1) >= t) return;
        ride.laps.push(t);
    }

    function event(t, type) {
        const last = ride.events[ride.events.length - 1];
        if(last?.type === type) return;
        ride.events.push({t, type});
        save();
    }

    const pause = (t) => event(t, 'stop');
    const resume = (t) => event(t, 'start');

    // {t, power, heartRate, cadence, speed} -> Void, speed in m/s, distance is integrated here
    function sample({t, power, heartRate, cadence, speed}) {
        if(ride.samples.length >= maxSamples) return;
        if(Number.isFinite(speed)) distance += speed;
        ride.samples.push({
            t,
            power: finiteOrNull(power),
            heartRate: finiteOrNull(heartRate),
            cadence: finiteOrNull(cadence),
            speed: finiteOrNull(speed),
            distance: finiteOrNull(distance),
        });
        unsaved += 1;
        if(unsaved >= saveEvery) save();
    }

    function save() {
        unsaved = 0;
        try {
            storage?.setItem(storageKey, JSON.stringify({version: 1, ...packRide(ride)}));
        } catch(error) {
            console.warn('vigo: could not autosave the ride', error);
        }
    }

    function clear() {
        ride = emptyRide();
        distance = 0;
        try { storage?.removeItem(storageKey); } catch(_) { /* storage blocked */ }
    }

    return Object.freeze({
        start, pause, resume, lap, sample, save, clear,
        get ride() { return ride; },
    });
}

// Ride -> compact form for storage, samples as rows
export function packRide(ride) {
    return {
        workoutName: ride.workoutName,
        ftp: ride.ftp ?? null,
        maxHr: ride.maxHr ?? null,
        hrZones: ride.hrZones ?? null,
        devices: ride.devices ?? [],
        laps: ride.laps ?? [],
        events: ride.events,
        samples: ride.samples.map((s) => [s.t, s.power, s.heartRate, s.cadence, s.speed, s.distance]),
    };
}

// packed ride from storage -> Ride | undefined, drops anything malformed
export function sanitizeRide(data) {
    if(!Array.isArray(data?.samples) || !Array.isArray(data.events)) return undefined;

    const samples = [];
    for(const row of data.samples.slice(0, maxSamples)) {
        if(!Array.isArray(row) || !Number.isFinite(row[0])) continue;
        const [t, power, heartRate, cadence, speed, distance] = row.map(finiteOrNull);
        samples.push({t, power, heartRate, cadence, speed, distance});
    }
    if(samples.length === 0) return undefined;

    const events = data.events
        .filter((e) => Number.isFinite(e?.t) && (e.type === 'start' || e.type === 'stop'))
        .map((e) => ({t: e.t, type: e.type}));
    const workoutName = typeof data.workoutName === 'string' ? data.workoutName.slice(0, 120) : '';
    // laps, zones and devices came later: rides saved without them still load
    const laps = [];
    for(const t of Array.isArray(data.laps) ? data.laps.slice(0, maxLaps) : []) {
        if(Number.isFinite(t) && !(laps.at(-1) >= t)) laps.push(t);
    }
    return {
        samples, events, laps, workoutName,
        ftp: finiteOrNull(data.ftp),
        maxHr: finiteOrNull(data.maxHr),
        hrZones: zonesOrNull(data.hrZones),
        devices: cleanDevices(data.devices),
    };
}

// Storage -> Ride | undefined, a ride left over from a previous session
export function loadSavedRide(storage = globalThis.localStorage) {
    let raw;
    try { raw = storage?.getItem(storageKey); } catch(_) { return undefined; }
    if(!raw) return undefined;

    try {
        const data = JSON.parse(raw);
        if(data?.version !== 1) return undefined;
        return sanitizeRide(data);
    } catch(_) {
        return undefined;
    }
}

export function clearSavedRide(storage = globalThis.localStorage) {
    try { storage?.removeItem(storageKey); } catch(_) { /* storage blocked */ }
}
