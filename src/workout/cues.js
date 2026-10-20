//
// Interval cues: when to count down and beep, and which text message to show
//
// A cue is a segment start where the power jumps, by at least 5% of FTP. Ramps and point by point
// files are many segments that continue each other, a beep at every one of them would be noise.
// The end of the workout is a cue too, so the last seconds are counted down before the finish chime.
// The player's last tick is the second before the end, so the end never gets a 'go'.
//

import { toWatts } from './target.js';

export const countdown = 5;    // seconds of countdown before a cue
const minJump = 0.05;          // of FTP

// (Workout, Number) -> [Number], sorted start times in seconds and the end, none at 0
export function cueTimes(workout, ftp) {
    const times = [];
    const segments = workout.segments;
    for(let i = 1; i < segments.length; i++) {
        const before = toWatts(workout, segments[i - 1].to, ftp);
        const after = toWatts(workout, segments[i].from, ftp);
        if(segments[i].start > 0 && Math.abs(after - before) >= minJump * ftp - 1e-9) times.push(segments[i].start);
    }
    if(workout.duration > 0 && times.at(-1) !== workout.duration) times.push(workout.duration);
    return times;
}

// ([Number], Number) -> Int, index of the first cue after t, times.length when there is none
function firstAfter(times, t) {
    let lo = 0;
    let hi = times.length;
    while(lo < hi) {
        const mid = (lo + hi) >> 1;
        if(times[mid] > t) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

// ([Number], Number) -> Number | undefined, the next cue after t seconds
export function nextCue(times, t) {
    return times[firstAfter(times, t)];
}

// ([Number], Int) -> 'count' | 'go' | undefined, the sound for this whole second of riding
//
// 'go' when a cue falls in (second - 1, second], 'count' in the 5 seconds before one
export function cueAt(times, second) {
    const i = firstAfter(times, second - 1);
    const next = times[i];
    if(next === undefined) return undefined;
    if(next <= second) return 'go';
    return next - second <= countdown ? 'count' : undefined;
}

// ([{start, duration, text}], Number) -> String | undefined, the text message on screen at t
//
// the latest one to start wins when they overlap
export function textAt(texts, t) {
    let shown;
    for(const text of texts) {
        if(text.start > t) break;
        if(t < text.start + text.duration) shown = text.text;
    }
    return shown;
}
