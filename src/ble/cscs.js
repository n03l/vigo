//
// Cycling Speed and Cadence Measurement 0x2A5B
//
// flags uint8,
// wheel revolutions uint32 + last wheel event time uint16 1/1024 s (bit 0),
// crank revolutions uint16 + last crank event time uint16 1/1024 s (bit 1).
//

// DataView -> {wheelRevs?, wheelTime?, crankRevs?, crankTime?}
export function parseSpeedCadence(view) {
    if(view.byteLength < 1) throw new RangeError('speed and cadence measurement too short');

    const flags = view.getUint8(0);
    const data = {};
    let i = 1;

    if(flags & 0x01) {
        if(i + 6 > view.byteLength) return data;
        data.wheelRevs = view.getUint32(i, true);
        data.wheelTime = view.getUint16(i + 4, true);
        i += 6;
    }
    if(flags & 0x02) {
        if(i + 4 > view.byteLength) return data;
        data.crankRevs = view.getUint16(i, true);
        data.crankTime = view.getUint16(i + 2, true);
        i += 4;
    }
    return data;
}
