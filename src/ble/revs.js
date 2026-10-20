//
// Revolutions over time, for cadence and wheel speed
//
// Sensors send a cumulative revolution count and the time of the last event,
// both roll over. Sensors repeat the same event between pedal strokes,
// so the rate is held until no new event arrives for `timeout` ms, then it's 0.
//

export function RevCounter({timeResolution = 1024, revsMax = 2 ** 16, timeout = 3000, maxRate = Infinity} = {}) {
    const timeMax = 2 ** 16;
    let revs;
    let time;
    let lastEventAt = -Infinity;
    let rate = 0; // revolutions per second

    // (Int, Int, Number) -> Number, revolutions per second
    function update(nextRevs, nextTime, now) {
        if(revs === undefined) {
            revs = nextRevs;
            time = nextTime;
            lastEventAt = now;
            return value(now);
        }

        const dRevs = (nextRevs - revs + revsMax) % revsMax;
        const dTime = ((nextTime - time + timeMax) % timeMax) / timeResolution;

        if(dTime > 0) {
            const nextRate = dRevs / dTime;
            // a reset sensor or a garbled packet gives absurd rates, skip them
            if(nextRate <= maxRate) rate = nextRate;
            revs = nextRevs;
            time = nextTime;
            lastEventAt = now;
        } else if(dRevs !== 0) {
            // count moved without time, resync
            revs = nextRevs;
        }
        return value(now);
    }

    // Number -> Number
    function value(now) {
        return now - lastEventAt > timeout ? 0 : rate;
    }

    function reset() {
        revs = undefined;
        time = undefined;
        lastEventAt = -Infinity;
        rate = 0;
    }

    return Object.freeze({update, value, reset});
}
