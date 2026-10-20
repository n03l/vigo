//
// Bluetooth UUIDs, full 128 bit lowercase strings
//

const base = (short) => `0000${short}-0000-1000-8000-00805f9b34fb`;

export const services = Object.freeze({
    cyclingPower:  base('1818'),
    speedCadence:  base('1816'),
    heartRate:     base('180d'),
    deviceInfo:    base('180a'),
    fitnessMachine: base('1826'),
    // Elite proprietary trainer control (Rampa)
    elite:         '347b0001-7635-408b-8918-8ff3949ce592',
});

export const characteristics = Object.freeze({
    cyclingPowerMeasurement: base('2a63'),
    speedCadenceMeasurement: base('2a5b'),
    heartRateMeasurement:    base('2a37'),
    indoorBikeData:          base('2ad2'),
    supportedPowerRange:     base('2ad8'),
    ftmsControlPoint:        base('2ad9'),
    eliteBrake:              '347b0010-7635-408b-8918-8ff3949ce592',
    eliteOutOfRange:         '347b0011-7635-408b-8918-8ff3949ce592',
});
