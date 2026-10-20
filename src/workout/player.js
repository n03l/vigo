//
// Workout clock
//
// Elapsed time is measured from performance.now so it doesn't drift with timer jitter,
// onTick is called once for every whole second of riding time.
//

import { segmentIndexAt } from './target.js';

export function Player({workout, onTick, onState, now = () => performance.now(),
                        setInterval = globalThis.setInterval.bind(globalThis),
                        clearInterval = globalThis.clearInterval.bind(globalThis)}) {
    let state = 'idle'; // idle | running | paused | finished
    let elapsedBefore = 0; // ms ridden before the current run
    let runStartedAt = 0;
    let lastSecond = -1;
    let timer;

    function elapsedMs() {
        return state === 'running' ? elapsedBefore + (now() - runStartedAt) : elapsedBefore;
    }

    function setState(next) {
        state = next;
        onState?.(state);
    }

    function check() {
        if(state !== 'running') return;
        const seconds = elapsedMs() / 1000;
        if(seconds >= workout.duration) {
            emit(Math.ceil(workout.duration) - 1);
            finish();
            return;
        }
        emit(Math.floor(seconds));
    }

    function emit(second) {
        while(lastSecond < second) {
            lastSecond += 1;
            onTick?.(lastSecond);
        }
    }

    function start() {
        if(state === 'running' || state === 'finished') return;
        runStartedAt = now();
        setState('running');
        if(!timer) timer = setInterval(check, 200);
        check();
    }

    function pause() {
        if(state !== 'running') return;
        elapsedBefore = elapsedMs();
        setState('paused');
    }

    function finish() {
        if(state === 'finished') return;
        if(state === 'running') elapsedBefore = Math.min(elapsedMs(), workout.duration * 1000);
        clearInterval(timer);
        timer = undefined;
        setState('finished');
    }

    // jump to the start of the next interval
    function skip() {
        if(state !== 'running' && state !== 'paused') return;
        const t = elapsedMs() / 1000;
        const index = segmentIndexAt(workout, t);
        if(index < 0) return;
        const next = workout.segments[index + 1];
        elapsedBefore = (next ? next.start : workout.duration) * 1000;
        runStartedAt = now();
        // seconds skipped are not ridden, don't tick for them
        lastSecond = Math.ceil(elapsedBefore / 1000) - 1;
        if(next) check();
        else finish();
    }

    return Object.freeze({
        start,
        pause,
        skip,
        finish,
        get state() { return state; },
        get elapsed() { return elapsedMs() / 1000; },
    });
}
