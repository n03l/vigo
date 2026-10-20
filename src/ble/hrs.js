//
// Heart Rate Measurement 0x2A37
//
// flags uint8, bit 0 set means the heart rate is uint16 instead of uint8.
//

// DataView -> {heartRate: Int}
export function parseHeartRate(view) {
    const flags = view.getUint8(0);
    if(flags & 0x01) {
        if(view.byteLength < 3) throw new RangeError('heart rate measurement too short');
        return {heartRate: view.getUint16(1, true)};
    }
    if(view.byteLength < 2) throw new RangeError('heart rate measurement too short');
    return {heartRate: view.getUint8(1)};
}
