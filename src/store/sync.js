//
// Syncing the backup file with Google Drive: what changed, and what to do about it
//
// The Drive file is a backup file (store/backup.js), so it can also be restored by hand. The device keeps
// what it last synced: {fileId, version, hash, syncedAt, account}. Drive's version is a counter that grows
// with every change to the file; the hash is dataHash of the data as synced. Comparing both with now tells
// who changed since:
//
//   local      remote     action
//   unchanged  unchanged  none
//   changed    unchanged  push
//   unchanged  changed    pull
//   changed    changed    conflict, the rider chooses
//
// Data here is {settings, workouts: [{fileName, text, addedAt, lastUsedAt}], rides: [{interrupted, ...packed}]}
// in canonical form (syncData), so the same data hashes the same wherever it was read from.
//

import { packRide, sanitizeRide } from '../record/recorder.js';
import { maxWorkouts, maxRides } from './backup.js';

export const driveId = /^[\w-]{1,200}$/;
const driveVersion = /^\d{1,20}$/;

// (String, SyncState, {id, version} | null, Boolean) -> 'create' | 'push' | 'pull' | 'conflict' | 'none'
// localEmpty: nothing worth keeping here. A device that never synced may simply take Drive's copy; after a
// sync, empty data means the rider deleted everything, which must not be undone without asking.
export function decide(localHash, state, remote, localEmpty = false) {
    if(!remote) return 'create';
    const localChanged = localHash !== state.hash;
    if(remote.id === state.fileId && remote.version === state.version) return localChanged ? 'push' : 'none';
    if(localEmpty && state.hash === undefined) return 'pull';
    return localChanged ? 'conflict' : 'pull';
}

// (Action, {local, localNow, remote, synced?, canTake}) -> 'record' | 'push' | 'take' | 'conflict'
// Settles a pull or a conflict once Drive's copy is downloaded. Drive's version also moves when nobody
// edited the file, so its content is compared with what was last synced before calling it changed.
// local: hash here when the sync started, localNow: after the download (a change meanwhile must not be
// overwritten), remote: hash of Drive's copy, canTake: no ride in progress.
export function afterDownload(action, {local, localNow, remote, synced, canTake}) {
    if(remote === local) return 'record';
    if(synced !== undefined && remote === synced) return 'push';
    if(action === 'pull' && canTake && localNow === local) return 'take';
    return 'conflict';
}

// Data -> Boolean, a fresh install: no uploaded workouts and no rides
export const isBlank = (data) => data.workouts.length === 0 && data.rides.length === 0;

// String -> String, 53-bit hash (cyrb53), detects changes, not tampering; needs no secure context
export function hashText(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for(let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Any -> String, the hash of the data whatever order its fields were set in
export function dataHash(data) {
    return hashText(JSON.stringify(data, (_key, value) => {
        if(typeof value !== 'object' || value === null || Array.isArray(value)) return value;
        return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
    }));
}

const time = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);

// ({settings, workouts, rides}) -> Data in canonical form: rides sanitized and packed, the same workout
// text or ride start only once (as IndexedDB keys them), both in a fixed order. The first copy of a ride
// wins; a workout keeps its first addedAt and its latest use, as storeWorkout does.
export function syncData({settings, workouts, rides}) {
    const byText = new Map();
    for(const w of workouts) {
        if(typeof w?.text !== 'string') continue;
        const seen = byText.get(w.text);
        const lastUsedAt = time(w.lastUsedAt);
        if(seen) {
            seen.lastUsedAt = Math.max(seen.lastUsedAt, lastUsedAt);
            continue;
        }
        const fileName = typeof w.fileName === 'string' ? w.fileName.slice(0, 200) : '';
        byText.set(w.text, {fileName, text: w.text, addedAt: time(w.addedAt), lastUsedAt});
    }
    const byStart = new Map();
    for(const r of rides) {
        const ride = sanitizeRide(r);
        if(!ride || byStart.has(ride.samples[0].t)) continue;
        byStart.set(ride.samples[0].t, {interrupted: r.interrupted === true, ...packRide(ride)});
    }
    return {
        settings,
        workouts: [...byText.values()].sort((a, b) => a.addedAt - b.addedAt || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)),
        rides: [...byStart.values()].sort((a, b) => a.samples[0][0] - b.samples[0][0]),
    };
}

// (Data, Data) -> Data, this device's data plus whatever Drive has that isn't here, nothing is deleted;
// this device's settings win. Throws when the result is too large to save and load again.
export function mergeBoth(local, remote) {
    const merged = syncData({
        settings: local.settings,
        workouts: [...local.workouts, ...remote.workouts],
        rides: [...local.rides, ...remote.rides],
    });
    if(merged.workouts.length > maxWorkouts || merged.rides.length > maxRides) {
        throw new Error(`Together that is more than ${maxWorkouts} workouts or ${maxRides} rides. Use one copy instead.`);
    }
    return merged;
}

// Any -> SyncState | null, the sync state stored on the device; anything unexpected means not connected
export function parseSyncState(raw) {
    if(typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const field = (key, ok) => {
        const v = Object.hasOwn(raw, key) ? raw[key] : undefined;
        return typeof v === 'string' && ok(v) ? v : undefined;
    };
    const state = {};
    const fileId = field('fileId', (v) => driveId.test(v));
    const version = field('version', (v) => driveVersion.test(v));
    const hash = field('hash', (v) => /^[0-9a-z]{1,20}$/.test(v));
    const syncedAt = field('syncedAt', (v) => v.length <= 40 && !Number.isNaN(Date.parse(v)));
    const account = field('account', (v) => driveId.test(v));
    if(fileId) state.fileId = fileId;
    if(version) state.version = version;
    if(hash) state.hash = hash;
    if(syncedAt) state.syncedAt = syncedAt;
    if(account) state.account = account;
    return state;
}

// Any -> {id, version}, a file description from the Drive API; throws on anything unexpected
export function parseRemoteFile(raw) {
    const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    const id = Object.hasOwn(o, 'id') ? o.id : undefined;
    const version = Object.hasOwn(o, 'version') ? o.version : undefined;
    if(typeof id !== 'string' || !driveId.test(id) || typeof version !== 'string' || !driveVersion.test(version)) {
        throw new Error('Drive sent an unexpected file description.');
    }
    return {id, version};
}
