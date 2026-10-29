//
// Auto-pause: tells when the rider has stopped pedaling for a while, and when they pedal again
//
// Fed from the render loop with whether the rider is pedaling now. Each change is reported once:
// 'stopped' after `delay` seconds without pedaling, then 'pedaling' on the first pedaling after it.
// A delay of 0 turns it off.
//

// {delay: Number} -> {update, reset}
export function PedalWatch({delay}) {
    let idleSince;      // seconds, when pedaling last stopped
    let stopped = false;

    // (Number, Bool) -> 'stopped' | 'pedaling' | undefined, t in seconds
    function update(t, pedaling) {
        if(!(delay > 0)) return undefined;
        if(pedaling) {
            idleSince = undefined;
            if(!stopped) return undefined;
            stopped = false;
            return 'pedaling';
        }
        if(stopped) return undefined;
        idleSince ??= t;
        if(t - idleSince < delay) return undefined;
        stopped = true;
        return 'stopped';
    }

    function reset() {
        idleSince = undefined;
        stopped = false;
    }

    return Object.freeze({update, reset});
}
