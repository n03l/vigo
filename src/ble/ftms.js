//
// Fitness Machine Service 0x1826 (FTMS), the standard trainer control most smart trainers have
//
// - 2AD9 control point, write + indicate: <op code> <parameters>, answered by an indication
//     0x80 <op code> <result>
//   0x00 request control, 0x05 <sint16 LE watts> set target power,
//   0x07 start or resume, 0x08 <uint8> stop (1) or pause (2)
// - 2AD2 indoor bike data, notify: flags uint16, then the fields the flags announce
// - 2AD8 supported power range, read: min sint16, max sint16, increment uint16
//

export const opCodes = Object.freeze({
    requestControl: 0x00,
    setTargetPower: 0x05,
    start: 0x07,
    stopOrPause: 0x08,
    response: 0x80,
});

export const results = Object.freeze({
    success: 0x01,
    notSupported: 0x02,
    invalidParameter: 0x03,
    failed: 0x04,
    notPermitted: 0x05,
});

const resultText = {
    [results.notSupported]: 'not supported',
    [results.invalidParameter]: 'invalid parameter',
    [results.failed]: 'operation failed',
    [results.notPermitted]: 'control not permitted',
};

export const defaultPowerRange = Object.freeze({min: 0, max: 4000, step: 1});

const clamp = (min, max, x) => Math.min(Math.max(x, min), max);

export const encodeRequestControl = () => new Uint8Array([opCodes.requestControl]);
export const encodeStart = () => new Uint8Array([opCodes.start]);
export const encodePause = () => new Uint8Array([opCodes.stopOrPause, 0x02]);

// (Number, {min, max}) -> Uint8Array
export function encodeTargetPower(watts, range = defaultPowerRange) {
    const min = Math.max(0, range.min);
    const max = Math.min(0x7fff, range.max);
    const power = Math.round(clamp(min, max, Number.isFinite(watts) ? watts : 0));
    return new Uint8Array([opCodes.setTargetPower, power & 0xff, (power >> 8) & 0xff]);
}

// DataView -> {opCode, result} | undefined when it isn't a response
export function parseControlPointResponse(view) {
    if(view.byteLength < 3 || view.getUint8(0) !== opCodes.response) return undefined;
    return {opCode: view.getUint8(1), result: view.getUint8(2)};
}

// Int -> String
export const describeResult = (result) => resultText[result] ?? `error ${result}`;

// DataView -> {min, max, step} | undefined when the range makes no sense
export function parseSupportedPowerRange(view) {
    if(view.byteLength < 6) return undefined;
    const min = view.getInt16(0, true);
    const max = view.getInt16(2, true);
    const step = view.getUint16(4, true);
    if(max <= 0 || max < min) return undefined;
    return {min, max, step};
}

// Indoor Bike Data fields in flag order: [flag bit, size in bytes, name].
// Bit 0 is "more data": when it is 0 the instantaneous speed is there.
const bikeFields = [
    [1, 2, 'averageSpeed'],
    [2, 2, 'cadence'],
    [3, 2, 'averageCadence'],
    [4, 3, 'distance'],
    [5, 2, 'resistance'],
    [6, 2, 'power'],
    [7, 2, 'averagePower'],
    [8, 5, 'energy'],
    [9, 1, 'heartRate'],
    [10, 1, 'met'],
    [11, 2, 'elapsed'],
    [12, 2, 'remaining'],
];

// DataView -> {speed? km/h, cadence? rpm, power? W}
export function parseIndoorBikeData(view) {
    if(view.byteLength < 2) throw new RangeError('indoor bike data too short');

    const flags = view.getUint16(0, true);
    const data = {};
    let i = 2;

    if(!(flags & 0x01)) {
        if(i + 2 > view.byteLength) return data;
        data.speed = view.getUint16(i, true) / 100;
        i += 2;
    }
    for(const [bit, size, name] of bikeFields) {
        if(!(flags & (1 << bit))) continue;
        if(i + size > view.byteLength) return data;
        if(name === 'cadence') data.cadence = view.getUint16(i, true) / 2;
        if(name === 'power') data.power = view.getInt16(i, true);
        i += size;
    }
    return data;
}
