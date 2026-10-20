//
// Workout library: built-ins plus uploads kept in IndexedDB
//

import { parseWorkout } from '../workout/parse.js';
import { toWatts, maxWatts, maxTargetFor } from '../workout/target.js';

// String -> Promise<String>, the same text always gets the same id
export async function workoutId(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `u-${hex.slice(0, 16)}`;
}

// a stored record -> library entry, or undefined when the record is damaged
export function fromRecord(record) {
    if(typeof record?.id !== 'string' || !/^u-[0-9a-f]{16}$/.test(record.id)) return undefined;
    if(typeof record.text !== 'string') return undefined;
    try {
        const fileName = typeof record.fileName === 'string' ? record.fileName : '';
        const workout = parseWorkout(record.text, {fileName});
        return {
            id: record.id,
            name: workout.name,
            fileName,
            text: record.text,
            workout,
            builtin: false,
            addedAt: Number.isFinite(record.addedAt) ? record.addedAt : 0,
            lastUsedAt: Number.isFinite(record.lastUsedAt) ? record.lastUsedAt : 0,
        };
    } catch(_) {
        return undefined;
    }
}

// ([Entry], [Entry]) -> [Entry], uploads by last use first, then the built-ins
export function mergeLibrary(builtins, uploads) {
    const seen = new Set();
    const sorted = [...uploads].sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.addedAt - a.addedAt);
    return [...sorted, ...builtins].filter((entry) => {
        if(seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
    });
}

// (Workout, Number) -> {duration, avgWatts, intensity, scaling, peakWatts, peakCapped}
export function describe(workout, ftp) {
    // what the trainer will actually be asked for, after the cap
    const watts = (value) => Math.min(toWatts(workout, value, ftp), maxTargetFor(ftp));
    const work = workout.segments.reduce((sum, s) =>
        sum + (watts(s.from) + watts(s.to)) / 2 * s.duration, 0);
    const avgWatts = Math.round(work / workout.duration);
    const scaling = workout.unit === 'pct' ? '% of FTP'
        : workout.fileFtp ? `watts scaled from FTP ${workout.fileFtp}`
        : 'fixed watts, FTP not used';
    const peak = maxWatts(workout, ftp);
    return {
        duration: workout.duration,
        avgWatts,
        intensity: avgWatts / ftp,
        scaling,
        peakWatts: Math.round(Math.min(peak, maxTargetFor(ftp))),
        peakCapped: peak > maxTargetFor(ftp),
    };
}
