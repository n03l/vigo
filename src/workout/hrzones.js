//
// Heart rate zones
//
// Five zones on % of max heart rate, the Garmin and Polar default: Z1 from 50%, Z2 60%, Z3 70%,
// Z4 80%, Z5 90%. The bounds are kept in bpm, so they can be edited one by one.
//

export const zonePercents = Object.freeze([50, 60, 70, 80, 90]);
export const maxHrBounds = Object.freeze([100, 230]);

// Int -> [Int], the lower bound of each zone in bpm
export function defaultHrZones(maxHr) {
    return zonePercents.map((pct) => Math.round(maxHr * pct / 100));
}

// (Any, Int) -> Bool, five integers going up, from 40 bpm to max HR
export function validHrZones(bounds, maxHr) {
    if(!Array.isArray(bounds) || bounds.length !== zonePercents.length) return false;
    return bounds.every((b, i) => Number.isInteger(b) && b >= 40 && b <= maxHr && (i === 0 || b > bounds[i - 1]));
}

// (Number, [Int]) -> Int, 1..5, 0 below Z1 or when there is no heart rate
export function hrZone(bpm, bounds) {
    if(!Number.isFinite(bpm)) return 0;
    let zone = 0;
    for(let i = 0; i < bounds.length; i++) {
        if(bpm >= bounds[i]) zone = i + 1;
    }
    return zone;
}
