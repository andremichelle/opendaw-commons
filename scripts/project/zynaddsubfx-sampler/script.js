// ZynAddSubFX pad for the Sampler
// PADsynth algorithm by Paul Nasca (public domain)
// https://en.wikibooks.org/wiki/ZynAddSubFX/PADsynth/Algorithm
// https://en.wikibooks.org/wiki/ZynAddSubFX/PADsynth/CPP_Implementation

// instrument
const NAME = "Zyn Pad"
const VOLUME_DB = -9.0
const VOICES = 32
const ATTACK_SECONDS = 0.4
const RELEASE_SECONDS = 2.5
const RANDOM_START = 1.0 // 0 to 1, how far a note starts into its wavetable

// zones
const LOWEST_KEY = 24
const HIGHEST_KEY = 108
const SEMITONES_PER_ZONE = 3
const KEY_FADE = 0 // semitones neighbouring zones blend into each other

// wavetables
const WAVETABLE_SIZE = 1 << 17 // frames, a power of two
const TUNING_HZ = 440.0
const BANDWIDTH_CENTS = 45.0 // width of the fundamental
const BANDWIDTH_SCALE = 1.1 // 1 keeps the harmonics equally wide in cents, more smears the highs
const OVERTONE_STRETCH = 1.0 // 1 is harmonic, more makes it metallic
const MAX_HARMONICS = 96
const HIGHEST_FREQUENCY = 14000.0
const HARMONIC_FALLOFF = 1.1 // amplitude of harmonic n is n ^ -falloff
// formants stay at their frequency on every key, which is why each zone needs its own wavetable
const FORMANTS = [
    {frequency: 520.0, width: 180.0, gain: 3.0},
    {frequency: 1250.0, width: 300.0, gain: 2.0},
    {frequency: 2900.0, width: 500.0, gain: 1.2}
]
const STEREO_OFFSET = 0.5 // the right channel reads the wavetable this far ahead
const PEAK = 0.7
const SEED = 0x2F6E2B1

// demo notes, only written into a new project
const DEMO_BPM = 80
const DEMO_CHORDS = [
    [36, 48, 55, 60, 64, 67],
    [33, 45, 52, 57, 60, 64],
    [41, 53, 57, 60, 65, 72],
    [43, 50, 55, 59, 62, 74]
]

const PROFILE_CUT = Math.sqrt(14.71280603) // beyond it the gaussian is silent
const fft = new FFT(WAVETABLE_SIZE)
const half = WAVETABLE_SIZE >> 1
let seed = SEED
const random = () => {
    seed = (seed * 1664525 + 1013904223) | 0
    return (seed >>> 0) / 4294967296
}
const amplitudeOf = (harmonic, frequency) => FORMANTS.reduce((sum, formant) => {
    const distance = (frequency - formant.frequency) / formant.width
    return sum + formant.gain * Math.exp(-distance * distance)
}, 1.0) / Math.pow(harmonic, HARMONIC_FALLOFF)
const createWavetable = (fundamental) => {
    const spectrum = new Float32Array(half)
    const limit = Math.min(HIGHEST_FREQUENCY, sampleRate / 2)
    for (let harmonic = 1; harmonic <= MAX_HARMONICS; harmonic++) {
        const relative = Math.pow(harmonic, OVERTONE_STRETCH)
        const frequency = fundamental * relative
        if (frequency >= limit) {break}
        const bandwidthHz = (Math.pow(2.0, BANDWIDTH_CENTS / 1200.0) - 1.0) * fundamental * Math.pow(relative, BANDWIDTH_SCALE)
        const width = bandwidthHz / (2.0 * sampleRate)
        const center = frequency / sampleRate
        const amplitude = amplitudeOf(harmonic, frequency)
        const first = Math.max(1, Math.floor((center - width * PROFILE_CUT) * WAVETABLE_SIZE))
        const last = Math.min(half - 1, Math.ceil((center + width * PROFILE_CUT) * WAVETABLE_SIZE))
        for (let bin = first; bin <= last; bin++) {
            const offset = (bin / WAVETABLE_SIZE - center) / width
            spectrum[bin] += amplitude * Math.exp(-offset * offset) / width
        }
    }
    const real = new Float32Array(WAVETABLE_SIZE)
    const imag = new Float32Array(WAVETABLE_SIZE)
    for (let bin = 1; bin < half; bin++) {
        const phase = random() * 2.0 * Math.PI
        real[bin] = real[WAVETABLE_SIZE - bin] = spectrum[bin] * Math.cos(phase)
        imag[bin] = spectrum[bin] * Math.sin(phase)
        imag[WAVETABLE_SIZE - bin] = -imag[bin]
    }
    fft.process(real, imag)
    const max = real.reduce((peak, value) => Math.max(peak, Math.abs(value)), 1e-5)
    const gain = PEAK / max
    const shift = Math.round(STEREO_OFFSET * WAVETABLE_SIZE)
    const audioData = AudioData.create(sampleRate, WAVETABLE_SIZE, 2)
    const [left, right] = audioData.frames
    for (let index = 0; index < WAVETABLE_SIZE; index++) {
        left[index] = real[index] * gain
        right[index] = real[(index + shift) % WAVETABLE_SIZE] * gain
    }
    return audioData
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
const nameOf = (key) => `${NOTE_NAMES[key % 12]}${Math.floor(key / 12) - 1}`
const ranges = []
for (let low = LOWEST_KEY; low <= HIGHEST_KEY; low += SEMITONES_PER_ZONE) {
    const high = Math.min(low + SEMITONES_PER_ZONE - 1, HIGHEST_KEY)
    ranges.push({low, high, root: (low + high) >> 1})
}
ranges[0].low = 0
ranges[ranges.length - 1].high = 127

const isNew = !(await openDAW.hasProject())
const project = isNew ? openDAW.newProject(NAME) : await openDAW.getProject()
const unit = project.addInstrumentUnit("Sampler", {label: NAME, volume: VOLUME_DB})
const sampler = unit.instrument
sampler.voices = VOICES
sampler.ampEnvelope.attack = ATTACK_SECONDS
sampler.ampEnvelope.release = RELEASE_SECONDS
sampler.groups[0].label = NAME
if (RANDOM_START > 0.0) {sampler.addModulation(6, 5, RANDOM_START)} // random to sample start
for (const {low, high, root} of ranges) {
    const audioData = createWavetable(midiToHz(root, TUNING_HZ))
    const sample = await openDAW.addSample(audioData, `${NAME} ${nameOf(root)}`)
    // the wavetable is one seamless cycle, so the whole sample loops without a crossfade
    sampler.addZone(sample, {keyLow: low, keyHigh: high, rootKey: root, keyFade: KEY_FADE, loopMode: 2})
}
if (isNew) {
    project.bpm = DEMO_BPM
    const region = unit.noteTracks[0].addRegion({position: 0, duration: PPQN.Bar * DEMO_CHORDS.length})
    region.addEvents(DEMO_CHORDS.flatMap((chord, bar) =>
        chord.map(pitch => ({position: PPQN.Bar * bar, pitch, velocity: 0.7, duration: PPQN.Bar}))))
}
project.openInStudio()
