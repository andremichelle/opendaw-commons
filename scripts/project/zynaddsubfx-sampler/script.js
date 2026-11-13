// ZynAddSubFX pad for the Sampler
// PADsynth algorithm by Paul Nasca (public domain)
// https://en.wikibooks.org/wiki/ZynAddSubFX/PADsynth/Algorithm
// https://en.wikibooks.org/wiki/ZynAddSubFX/PADsynth/CPP_Implementation

// formants stay at their frequency on every key, which is why each zone needs its own wavetable
const FORMANTS = [
    {frequency: 520.0, width: 180.0, gain: 3.0},
    {frequency: 1250.0, width: 300.0, gain: 2.0},
    {frequency: 2900.0, width: 500.0, gain: 1.2}
]
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

const isNew = !(await openDAW.hasProject())
const values = await openDAW.showDialog({
    headline: "ZynAddSubFX Sampler",
    okText: isNew ? "Create project" : "Add instrument",
    fields: {
        name: {type: "text", label: "Name", value: "Zyn Pad"},
        volume: {type: "slider", label: "Volume", value: -9.0, min: -36.0, max: 0.0, step: 0.5, unit: "dB"},
        voices: {type: "number", label: "Voices", value: 32, min: 1, max: 64, step: 1},
        attack: {type: "slider", label: "Attack", value: 0.4, min: 0.01, max: 8.0, step: 0.01, mapping: "exp", unit: "s"},
        release: {type: "slider", label: "Release", value: 2.5, min: 0.01, max: 8.0, step: 0.01, mapping: "exp", unit: "s"},
        // how far a note starts into its wavetable
        randomStart: {type: "slider", label: "Random start", value: 1.0, min: 0.0, max: 1.0, step: 0.01},
        zones: {type: "section", label: "Zones"},
        lowestKey: {type: "number", label: "Lowest key", value: 24, min: 0, max: 127, step: 1},
        highestKey: {type: "number", label: "Highest key", value: 108, min: 0, max: 127, step: 1},
        semitonesPerZone: {type: "number", label: "Semitones per zone", value: 3, min: 1, max: 12, step: 1},
        // semitones neighbouring zones blend into each other
        keyFade: {type: "slider", label: "Key fade", value: 0, min: 0, max: 12, mapping: "int", unit: "st"},
        wavetables: {type: "section", label: "Wavetables"},
        wavetableSize: {
            type: "dropdown", label: "Size", value: 1 << 17,
            options: [14, 15, 16, 17, 18].map(power => ({label: `${1 << power} frames`, value: 1 << power}))
        },
        tuning: {type: "number", label: "Tuning", value: 440.0, min: 400.0, max: 480.0, step: 0.1, unit: "Hz"},
        // width of the fundamental
        bandwidth: {type: "slider", label: "Bandwidth", value: 45.0, min: 1.0, max: 200.0, step: 0.1, mapping: "exp", unit: "ct"},
        // 1 keeps the harmonics equally wide in cents, more smears the highs
        bandwidthScale: {type: "slider", label: "Bandwidth scale", value: 1.1, min: 0.5, max: 2.0, step: 0.01},
        // 1 is harmonic, more makes it metallic
        overtoneStretch: {type: "slider", label: "Overtone stretch", value: 1.0, min: 0.5, max: 2.0, step: 0.01},
        maxHarmonics: {type: "number", label: "Harmonics", value: 96, min: 1, max: 256, step: 1},
        highestFrequency: {type: "slider", label: "Highest frequency", value: 14000.0, min: 1000.0, max: 20000.0, step: 10.0, mapping: "exp", unit: "Hz"},
        // amplitude of harmonic n is n ^ -falloff
        harmonicFalloff: {type: "slider", label: "Harmonic falloff", value: 1.1, min: 0.0, max: 3.0, step: 0.01},
        // the right channel reads the wavetable this far ahead
        stereoOffset: {type: "slider", label: "Stereo offset", value: 0.5, min: 0.0, max: 1.0, step: 0.01},
        ...(isNew ? {
            demo: {type: "section", label: "Demo notes"},
            demoBpm: {type: "number", label: "Tempo", value: DEMO_BPM, min: 30, max: 300, step: 1, unit: "bpm"}
        } : {})
    }
})
if (values === null) {return}
const {
    name, volume, voices, attack, release, randomStart, lowestKey, highestKey, semitonesPerZone, keyFade,
    wavetableSize, tuning, bandwidth, bandwidthScale, overtoneStretch, maxHarmonics, highestFrequency,
    harmonicFalloff, stereoOffset
} = values
if (lowestKey > highestKey) {
    await openDAW.showInfo("ZynAddSubFX Sampler", "The lowest key must not be above the highest key.")
    return
}

const PROFILE_CUT = Math.sqrt(14.71280603) // beyond it the gaussian is silent
const fft = new FFT(wavetableSize)
const half = wavetableSize >> 1
let seed = SEED
const random = () => {
    seed = (seed * 1664525 + 1013904223) | 0
    return (seed >>> 0) / 4294967296
}
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
const ranges = []
for (let low = lowestKey; low <= highestKey; low += semitonesPerZone) {
    const high = Math.min(low + semitonesPerZone - 1, highestKey)
    ranges.push({low, high, root: (low + high) >> 1})
}
ranges[0].low = 0
ranges[ranges.length - 1].high = 127

const project = isNew ? openDAW.newProject(name) : await openDAW.getProject()
const unit = project.addInstrumentUnit("Sampler", {label: name, volume})
const sampler = unit.instrument
sampler.voices = voices
sampler.ampEnvelope.attack = attack
sampler.ampEnvelope.release = release
sampler.groups[0].label = name
if (randomStart > 0.0) {sampler.addModulation(6, 5, randomStart)} // random to sample start
const limit = Math.min(highestFrequency, sampleRate / 2)
const shift = Math.round(stereoOffset * wavetableSize)
for (const {low, high, root} of ranges) {
    const fundamental = midiToHz(root, tuning)
    const spectrum = new Float32Array(half)
    for (let harmonic = 1; harmonic <= maxHarmonics; harmonic++) {
        const relative = Math.pow(harmonic, overtoneStretch)
        const frequency = fundamental * relative
        if (frequency >= limit) {break}
        const bandwidthHz = (Math.pow(2.0, bandwidth / 1200.0) - 1.0) * fundamental * Math.pow(relative, bandwidthScale)
        const width = bandwidthHz / (2.0 * sampleRate)
        const center = frequency / sampleRate
        let amplitude = 1.0
        for (const formant of FORMANTS) {
            const distance = (frequency - formant.frequency) / formant.width
            amplitude += formant.gain * Math.exp(-distance * distance)
        }
        amplitude /= Math.pow(harmonic, harmonicFalloff)
        const first = Math.max(1, Math.floor((center - width * PROFILE_CUT) * wavetableSize))
        const last = Math.min(half - 1, Math.ceil((center + width * PROFILE_CUT) * wavetableSize))
        for (let bin = first; bin <= last; bin++) {
            const offset = (bin / wavetableSize - center) / width
            spectrum[bin] += amplitude * Math.exp(-offset * offset) / width
        }
    }
    const real = new Float32Array(wavetableSize)
    const imag = new Float32Array(wavetableSize)
    for (let bin = 1; bin < half; bin++) {
        const phase = random() * 2.0 * Math.PI
        real[bin] = real[wavetableSize - bin] = spectrum[bin] * Math.cos(phase)
        imag[bin] = spectrum[bin] * Math.sin(phase)
        imag[wavetableSize - bin] = -imag[bin]
    }
    fft.process(real, imag)
    let max = 1e-5
    for (let index = 0; index < wavetableSize; index++) {max = Math.max(max, Math.abs(real[index]))}
    const gain = PEAK / max
    const audioData = AudioData.create(sampleRate, wavetableSize, 2)
    const left = audioData.frames[0]
    const right = audioData.frames[1]
    for (let index = 0; index < wavetableSize; index++) {
        left[index] = real[index] * gain
        right[index] = real[(index + shift) % wavetableSize] * gain
    }
    const sample = await openDAW.addSample(audioData, `${name} ${NOTE_NAMES[root % 12]}${Math.floor(root / 12) - 1}`)
    // the wavetable is one seamless cycle, so the whole sample loops without a crossfade
    sampler.addZone(sample, {keyLow: low, keyHigh: high, rootKey: root, keyFade, loopMode: 2})
}
if (isNew) {
    project.bpm = values.demoBpm ?? DEMO_BPM
    const region = unit.noteTracks[0].addRegion({position: 0, duration: PPQN.Bar * DEMO_CHORDS.length})
    region.addEvents(DEMO_CHORDS.flatMap((chord, bar) =>
        chord.map(pitch => ({position: PPQN.Bar * bar, pitch, velocity: 0.7, duration: PPQN.Bar}))))
}
project.openInStudio()
