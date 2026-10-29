//
// Backup file: settings, uploaded workouts and the ride history in one JSON file
//
// {format: 'vigo-backup', version: 1, exportedAt: ISO date,
//  settings: {...},
//  workouts: [{fileName, text, addedAt, lastUsedAt}],
//  rides:    [{interrupted, workoutName, ftp, maxHr, hrZones, devices, laps, events, samples}]}
//
// Rides are kept packed as in IndexedDB (see packRide). Saved devices are left out: the Bluetooth
// permission belongs to the browser, so they are registered again on a new one.
//
// A backup file comes from anywhere: each workout is parsed again and each ride sanitized like a
// stored one. A bad entry is skipped and counted, a file that isn't a backup at all is refused.
//

import { parseWorkout, limits as workoutLimits } from '../workout/parse.js';
import { sanitizeRide } from '../record/recorder.js';

export const format = 'vigo-backup';
export const version = 1;
export const maxBytes = 200 * 1024 * 1024;
const maxWorkouts = 5000;
const maxRides = 20000;

const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const time = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);

// ({settings, workouts, rides: [{interrupted, ...packed ride}]}, Date) -> Object, ready for JSON
export function makeBackup({settings, workouts, rides}, now = new Date()) {
    return {
        format,
        version,
        exportedAt: now.toISOString(),
        settings,
        workouts: workouts.map((w) => ({fileName: w.fileName, text: w.text, addedAt: w.addedAt, lastUsedAt: w.lastUsedAt})),
        rides,
    };
}

// String -> {settings: Object | undefined, workouts: [{text, fileName, addedAt, lastUsedAt}],
//            rides: [{ride, interrupted}], skipped: Int}
export function readBackup(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch(_) {
        throw new Error('This is not a vigo backup file.');
    }
    if(!isObject(data) || data.format !== format) throw new Error('This is not a vigo backup file.');
    if(data.version !== version) throw new Error('This backup is from a newer version of vigo.');

    let skipped = 0;
    const workouts = [];
    for(const w of Array.isArray(data.workouts) ? data.workouts.slice(0, maxWorkouts) : []) {
        const fileName = typeof w?.fileName === 'string' ? w.fileName.slice(0, 200) : '';
        if(typeof w?.text !== 'string' || w.text.length > workoutLimits.maxBytes) {
            skipped += 1;
            continue;
        }
        try {
            parseWorkout(w.text, {fileName});
        } catch(_) {
            skipped += 1;
            continue;
        }
        workouts.push({text: w.text, fileName, addedAt: time(w.addedAt), lastUsedAt: time(w.lastUsedAt)});
    }

    const rides = [];
    for(const r of Array.isArray(data.rides) ? data.rides.slice(0, maxRides) : []) {
        const ride = isObject(r) ? sanitizeRide(r) : undefined;
        if(!ride) {
            skipped += 1;
            continue;
        }
        rides.push({ride, interrupted: r.interrupted === true});
    }

    return {settings: isObject(data.settings) ? data.settings : undefined, workouts, rides, skipped};
}

// Date -> String
export function backupFileName(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `vigo-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
}
