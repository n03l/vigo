//
// Target power at a point in a workout
//

// (Workout, Number) -> Int, index of the segment running at t seconds, -1 when done
export function segmentIndexAt(workout, t) {
    const segments = workout.segments;
    if(t < 0) return 0;
    // binary search, workouts can have thousands of points
    let lo = 0;
    let hi = segments.length - 1;
    while(lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = segments[mid];
        if(t < s.start) hi = mid - 1;
        else if(t >= s.start + s.duration) lo = mid + 1;
        else return mid;
    }
    return -1;
}

// (Workout, Number, Number) -> Number, a file value in watts for this FTP
export function toWatts(workout, value, ftp) {
    if(workout.unit === 'pct') return value / 100 * ftp;
    if(workout.fileFtp) return value * ftp / workout.fileFtp;
    return value;
}

// Workout files come from anywhere: a typo or a bad file must not make the trainer
// slam on the brake, so no target goes above twice the FTP or 1500 W
export const absoluteMaxWatts = 1500;
export const maxTargetFor = (ftp) => Math.min(absoluteMaxWatts, 2 * ftp);

// (Workout, {ftp, t, bias}) -> Int | undefined
//
// bias is the intensity adjustment in percent, +5 rides everything 5% harder
export function targetAt(workout, {ftp, t, bias = 0}) {
    const index = segmentIndexAt(workout, t);
    if(index < 0) return undefined;
    const s = workout.segments[index];
    const progress = Math.min(Math.max((t - s.start) / s.duration, 0), 1);
    const value = s.from + (s.to - s.from) * progress;
    const watts = Math.max(0, Math.round(toWatts(workout, value, ftp) * (1 + bias / 100)));
    return Math.min(watts, maxTargetFor(ftp));
}

// Workout -> Number, the highest value in watts, used to scale the chart
export function maxWatts(workout, ftp) {
    let max = 0;
    for(const s of workout.segments) {
        max = Math.max(max, toWatts(workout, s.from, ftp), toWatts(workout, s.to, ftp));
    }
    return max;
}

// Number -> Int 1..6, power zone from a fraction of FTP
export function zone(fraction) {
    if(fraction < 0.55) return 1;
    if(fraction < 0.75) return 2;
    if(fraction < 0.90) return 3;
    if(fraction < 1.05) return 4;
    if(fraction < 1.20) return 5;
    return 6;
}
