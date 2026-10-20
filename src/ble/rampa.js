//
// Elite Rampa trainer control
//
// The Rampa has no FTMS. Power and cadence come on the standard Cycling Power service,
// control goes through the Elite service 347b0001:
// - 347b0010 brake, write:
//     0x00 <uint16 LE watts>  ERG target power
//     0x01 <uint8 level>      brake level 0..200
// - 347b0011 out of range, notify uint8, 1 when the target can't be reached at this speed
//

export const maxPower = 4000;
export const maxBrakeLevel = 200;

const clamp = (min, max, x) => Math.min(Math.max(x, min), max);

// Number -> Uint8Array
export function encodeTargetPower(watts) {
    const power = Math.round(clamp(0, maxPower, Number.isFinite(watts) ? watts : 0));
    return new Uint8Array([0x00, power & 0xff, (power >> 8) & 0xff]);
}

// Number -> Uint8Array
export function encodeBrakeLevel(level) {
    const value = Math.round(clamp(0, maxBrakeLevel, Number.isFinite(level) ? level : 0));
    return new Uint8Array([0x01, value]);
}

// DataView -> Bool
export function parseOutOfRange(view) {
    return view.byteLength > 0 && view.getUint8(0) === 1;
}

// Serialises writes to one characteristic and keeps only the latest value,
// a second write while one is pending fails with 'GATT operation already in progress'
//
// ((Uint8Array) -> Promise) -> {push(Uint8Array)}
export function LatestWriter(write, {onError = () => {}} = {}) {
    let pending;
    let busy = false;

    async function pump() {
        busy = true;
        while(pending) {
            const value = pending;
            pending = undefined;
            try {
                await write(value);
            } catch(error) {
                onError(error);
            }
        }
        busy = false;
    }

    function push(value) {
        pending = value;
        if(!busy) return pump();
    }

    return Object.freeze({push, get busy() { return busy; }});
}
