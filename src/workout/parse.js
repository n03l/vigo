//
// ERG / MRC workout files
//
// [COURSE HEADER]
// FTP = 250              (optional, ERG only)
// FILE NAME = Sweet spot (optional)
// MINUTES WATTS          (ERG) or MINUTES PERCENT (MRC)
// [END COURSE HEADER]
// [COURSE DATA]
// 0.00  100              minutes, value: consecutive points with equal values are a step,
// 5.00  100              with different values a ramp, a repeated time is a jump
// [END COURSE DATA]
//
// Files come from the user and the internet, so everything is bounded and validated.
//

export const limits = Object.freeze({
    maxBytes:    1024 * 1024,
    maxPoints:   5000,
    maxSeconds:  12 * 3600,
    maxWatts:    2000,
    maxPercent:  300,
    maxNameLength: 120,
});

export class WorkoutError extends Error {
    constructor(message, line) {
        super(line ? `line ${line}: ${message}` : message);
        this.name = 'WorkoutError';
        this.line = line;
    }
}

// drop control characters and keep the name short
function cleanName(name) {
    return String(name)
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limits.maxNameLength);
}

function parseNumber(text, line) {
    if(!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) {
        throw new WorkoutError(`'${text.slice(0, 20)}' is not a number`, line);
    }
    const value = Number(text);
    if(!Number.isFinite(value)) throw new WorkoutError(`'${text.slice(0, 20)}' is not a number`, line);
    return value;
}

// (String, {fileName: String}) -> Workout
//
// Workout {
//     name: String,
//     unit: 'w' | 'pct',
//     fileFtp: Number | undefined,
//     duration: Number,                 seconds
//     segments: [{start, duration, from, to}], seconds and unit values
// }
export function parseWorkout(text, {fileName = ''} = {}) {
    if(typeof text !== 'string') throw new WorkoutError('the file is not text');
    if(text.length > limits.maxBytes) throw new WorkoutError('the file is larger than 1 MB');

    const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);

    let section = 'none';
    let unit;
    let fileFtp;
    let name = '';
    const points = [];

    for(let i = 0; i < lines.length; i++) {
        const lineNumber = i + 1;
        const line = lines[i].trim();
        if(line === '' || line.startsWith(';')) continue;

        const tag = line.match(/^\[\s*(END\s+)?COURSE\s+(HEADER|DATA|TEXT)\s*\]$/i);
        if(tag) {
            const kind = tag[2].toUpperCase();
            section = tag[1] ? 'none' : kind.toLowerCase();
            continue;
        }

        if(section === 'header') {
            const columns = line.match(/^MINUTES\s+(WATTS|PERCENT)$/i);
            if(columns) {
                unit = columns[1].toUpperCase() === 'WATTS' ? 'w' : 'pct';
                continue;
            }
            const pair = line.match(/^([^=]+)=(.*)$/);
            if(!pair) continue;
            const key = pair[1].trim().toUpperCase();
            const value = pair[2].trim();
            if(key === 'FTP') {
                const ftp = parseNumber(value, lineNumber);
                if(ftp < 50 || ftp > 1000) throw new WorkoutError('FTP must be between 50 and 1000', lineNumber);
                fileFtp = ftp;
            } else if(key === 'FILE NAME' || (key === 'DESCRIPTION' && name === '')) {
                name = cleanName(value);
            }
            continue;
        }

        if(section === 'data') {
            if(unit === undefined) {
                throw new WorkoutError('the header must say MINUTES WATTS or MINUTES PERCENT', lineNumber);
            }
            const fields = line.split(/\s+/);
            if(fields.length < 2) throw new WorkoutError('expected minutes and a value', lineNumber);

            const minutes = parseNumber(fields[0], lineNumber);
            const value = parseNumber(fields[1], lineNumber);
            const seconds = Math.round(minutes * 60 * 1000) / 1000;
            const max = unit === 'w' ? limits.maxWatts : limits.maxPercent;

            if(seconds < 0 || seconds > limits.maxSeconds) {
                throw new WorkoutError('time must be between 0 and 12 hours', lineNumber);
            }
            if(value < 0 || value > max) {
                throw new WorkoutError(`value must be between 0 and ${max}`, lineNumber);
            }
            if(points.length > 0 && seconds < points[points.length - 1].seconds) {
                throw new WorkoutError('time goes backwards', lineNumber);
            }
            if(points.length >= limits.maxPoints) {
                throw new WorkoutError(`more than ${limits.maxPoints} points`, lineNumber);
            }
            points.push({seconds, value});
        }
    }

    if(unit === undefined) throw new WorkoutError('not an ERG or MRC file: no MINUTES WATTS or MINUTES PERCENT');
    if(unit === 'pct') fileFtp = undefined;

    const segments = [];
    for(let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const duration = b.seconds - a.seconds;
        if(duration <= 0) continue;
        segments.push({start: a.seconds, duration, from: a.value, to: b.value});
    }
    if(segments.length === 0) throw new WorkoutError('the workout has no intervals');

    const last = segments[segments.length - 1];
    const fallbackName = cleanName(String(fileName).replace(/\.(erg|mrc)$/i, ''));

    return Object.freeze({
        name: name || fallbackName || 'Workout',
        unit,
        fileFtp,
        duration: last.start + last.duration,
        segments: Object.freeze(segments.map(Object.freeze)),
    });
}
