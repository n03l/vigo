//
// Cycling Power Measurement 0x2A63
//
// flags uint16, instantaneous power sint16, then optional fields in this order:
// pedal power balance uint8 (bit 0), accumulated torque uint16 (bit 2),
// wheel revolutions uint32 + last wheel event time uint16 1/2048 s (bit 4),
// crank revolutions uint16 + last crank event time uint16 1/1024 s (bit 5).
// Fields after the crank data are not needed.
//

// DataView -> {power, wheelRevs?, wheelTime?, crankRevs?, crankTime?}
export function parseCyclingPower(view) {
    if(view.byteLength < 4) throw new RangeError('cycling power measurement too short');

    const flags = view.getUint16(0, true);
    const data = {power: view.getInt16(2, true)};
    let i = 4;

    if(flags & 0x01) i += 1;
    if(flags & 0x04) i += 2;
    if(flags & 0x10) {
        if(i + 6 > view.byteLength) return data;
        data.wheelRevs = view.getUint32(i, true);
        data.wheelTime = view.getUint16(i + 4, true);
        i += 6;
    }
    if(flags & 0x20) {
        if(i + 4 > view.byteLength) return data;
        data.crankRevs = view.getUint16(i, true);
        data.crankTime = view.getUint16(i + 2, true);
        i += 4;
    }
    return data;
}
