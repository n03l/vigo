//
// Beeps from the Web Audio API, no audio files
//
// Browsers only let a page make sound after a user gesture, so unlock() is called from a click.
// Sound is a nicety: when there is no AudioContext or it fails, nothing plays and nothing breaks.
//

// [Hz, start s, length s] per note
const sounds = Object.freeze({
    count: [[880, 0, 0.12]],
    go: [[1320, 0, 0.4]],
    finish: [[660, 0, 0.18], [880, 0.2, 0.18], [1320, 0.4, 0.45]],
    alarm: [[330, 0, 0.25], [330, 0.35, 0.25]],
});

// () -> {unlock, count, go, finish, alarm}
export function Beeper({volume = 0.3} = {}) {
    let context;

    function unlock() {
        try {
            const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
            if(!Context) return;
            context ??= new Context();
            if(context.state === 'suspended') context.resume().catch(() => {});
        } catch(error) {
            console.warn('vigo: no sound', error);
        }
    }

    function play(notes) {
        if(!context) return;
        try {
            const t0 = context.currentTime;
            for(const [frequency, start, length] of notes) {
                const oscillator = context.createOscillator();
                const gain = context.createGain();
                oscillator.type = 'sine';
                oscillator.frequency.value = frequency;
                // short fade in and out, a hard start or stop clicks
                gain.gain.setValueAtTime(0, t0 + start);
                gain.gain.linearRampToValueAtTime(volume, t0 + start + 0.01);
                gain.gain.setValueAtTime(volume, t0 + start + length - 0.03);
                gain.gain.linearRampToValueAtTime(0, t0 + start + length);
                oscillator.connect(gain).connect(context.destination);
                oscillator.start(t0 + start);
                oscillator.stop(t0 + start + length);
            }
        } catch(error) {
            console.warn('vigo: sound failed', error);
        }
    }

    return Object.freeze({
        unlock,
        count: () => play(sounds.count),
        go: () => play(sounds.go),
        finish: () => play(sounds.finish),
        alarm: () => play(sounds.alarm),
    });
}
