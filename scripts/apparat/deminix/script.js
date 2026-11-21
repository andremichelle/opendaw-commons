// @label Deminix
// @view MatrixView 1 1 4 3
// @view ToneView 5 1 6 3
// @view PatchView 11 1 3 3
// @param family 5 0 15 int [omit-default-ui]
// @param harmonics 5 0 15 int [omit-default-ui]
// @param brightness 5 0 15 int [omit-default-ui]
// @param motion 5 0 15 int [omit-default-ui]
// @param attack 5 0 15 int [omit-default-ui]
// @param decay 5 0 15 int [omit-default-ui]
// @param sustain 5 0 15 int [omit-default-ui]
// @param release 5 0 15 int [omit-default-ui]
// @param character 5 0 15 int [omit-default-ui]
// @param filterEnv 0.45 0 1 linear [omit-default-ui]
// @param filterDecay 0.399128 0.02 4 exp s [omit-default-ui]
// @param width 0.5 0 1 linear [omit-default-ui]
// @param saturation 0.2 0 1 linear [omit-default-ui]
// @param partialDecay 0 0 1 linear [omit-default-ui]
// @param partialTime 0.501252 0.02 4 exp s [omit-default-ui]
// @param fmEnv 0 0 1 linear [omit-default-ui]
// @param fmTime 0.250392 0.02 4 exp s [omit-default-ui]
// @param velocityTimbre 0 0 1 linear [omit-default-ui]
// @param detune 1 0 1 linear [omit-default-ui]
// @param tremolo 1 0 1 linear [omit-default-ui]
// @param vibrato 1 0 1 linear [omit-default-ui]
// @stream uiHints 256 value
// @collection matrix 9
// @field matrix.lock false

// ─── Deterministic PRNG (Mulberry32) ──────────────────────────────────────
class RNG {
  constructor(seed) {
    this.s = seed >>> 0
  }
  next() {
    this.s = (this.s + 0x6D2B79F5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Waveshape functions ───────────────────────────────────────────────────
// Stop inaudible tails before subnormal floating-point arithmetic slows sustained voices.
function decayEnvelope(value, rate) { return value > 1e-30 ? value * rate : 0 }
function smoothValue(value, target, rate) {
  const next = value + (target - value) * rate
  return Math.abs(next) < 1e-30 ? 0 : next
}
function waveTri(ph) { const p = ph; return p < 0.5 ? 4 * p - 1 : 3 - 4 * p }

const FAMILY_NAMES = ['Reed / harmonium', 'Organ', 'Flute / breath', 'Pluck', 'Sub bass', 'Bell', 'Pad / strings', 'Choir / vowels', 'Wood mallet', 'Metal / cymbal', 'Glass / crystal', 'Electric piano', 'Sync-style lead', 'Chiptune', 'Drone / fifths', 'Bowed resonator']
const FAMILY_TYPES = [9, 0, 5, 1, 6, 2, 3, 7, 4, 8, 10, 11, 12, 13, 14, 15]

const VOICE_SCALARS = ["stage", "decayRate", "noiseState", "noiseMix", "sideFilter", "filterEnvelope", "baseCutoff", "filter", "filterRate", "filterTarget", "filterClock", "filterSeenEnvelope", "filterSeenVelocity", "filterSeenAmount", "fastRelease", "id", "active", "gate", "freq", "velocity", "gain", "attackRate", "releaseRate", "sustainGain", "numPartials", "fmPhase", "fmFreqMul", "fmDepth", "tremPhase", "tremRate", "tremDepth", "vibPhase", "vibRate", "vibDepth", "pitch", "cent", "fmEnvelope", "smoothPartialAmount", "smoothFMAmount", "velocityShade", "smoothDetune", "smoothTremolo", "smoothVibrato"]
const VOICE_ARRAYS = ["phases", "freqMul", "amps", "detuneAmt", "pan", "waveType", "partialGain", "partialRate", "baseFreqs"]

// ─── Voice ─────────────────────────────────────────────────────────────────
class Voice {
  constructor(maxPartials) {
    this.fmEnvelope = 1
    this.smoothPartialAmount = 0
    this.smoothFMAmount = 0
    this.smoothDetune = this.smoothTremolo = this.smoothVibrato = 1
    this.partialGain = new Float64Array(maxPartials).fill(1)
    this.partialRate = new Float64Array(maxPartials).fill(1)
    this.velocityShade = 0
    this.pitch = 69
    this.cent = 0
    this.sampleL = 0
    this.sampleR = 0
    this.fadeRemaining = 0
    this.pendingReady = false
    this.stage = 0
    this.decayRate = 0
    this.noiseState = 1
    this.noiseMix = 0
    this.sideFilter = 0
    this.filterEnvelope = 1
    this.baseCutoff = 1000
    this.filter = 0
    this.filterTarget = 1
    this.filterClock = 0
    this.filterSeenEnvelope = this.filterSeenVelocity = this.filterSeenAmount = NaN
    this.filterRate = 1
    this.fastRelease = false
    this.id = -1
    this.active = false
    this.gate = false
    this.freq = 440
    this.velocity = 1
    this.gain = 0
    this.attackRate = 0
    this.releaseRate = 0
    this.sustainGain = 0.6
    this.numPartials = 1
    this.phases = new Float32Array(maxPartials)
    this.freqMul = new Float32Array(maxPartials)
    this.baseFreqs = new Float64Array(maxPartials)
    this.amps = new Float32Array(maxPartials)
    this.detuneAmt = new Float32Array(maxPartials)
    this.pan = new Float32Array(maxPartials)
    this.waveType = new Uint8Array(maxPartials)
    this.fmPhase = 0
    this.fmFreqMul = 1
    this.fmDepth = 0
    this.tremPhase = 0
    this.tremRate = 0
    this.tremDepth = 0
    this.vibPhase = 0
    this.vibRate = 0
    this.vibDepth = 0
  }
}

// ─── Processor ────────────────────────────────────────────────────────────
class Processor {
  static MAX_VOICES = 16
  static MAX_PARTIALS = 8

  voices = []
  params = new Int32Array(9).fill(5)
  filterEnv = 0.45
  filterDecay = 0.399128
  width = 0.5
  saturation = 0.2
  partialDecay = 0
  partialTime = 0.501252
  fmEnv = 0
  fmTime = 0.250392
  detune = 1
  tremolo = 1
  vibrato = 1
  velocityTimbre = 0
  smoothWidth = 0.5
  smoothDrive = 1.8

  constructor() {
    this.hintChars = new Float32Array(256)
    this.hintRevision = 0
    this.hintDirty = false
    this.sineTable = new Float64Array(4097)
    for (let i = 0; i <= 4096; i++) this.sineTable[i] = Math.sin(i * 6.283185307 / 4096)
    this.invSR = 1 / sampleRate
    this.smoothRate = 1 - Math.exp(-1 / (0.01 * sampleRate))
    this.filterDecayRate = Math.exp(-5 / (this.filterDecay * sampleRate))
    this.fmDecayRate = Math.exp(-5 / (this.fmTime * sampleRate))
    this.fadeLength = Math.max(1, Math.round(sampleRate * 0.02))
    this.invFadeLength = 1 / this.fadeLength
    for (let i = 0; i < Processor.MAX_VOICES; i++) {
      const v = new Voice(Processor.MAX_PARTIALS)
      v.active = false
      v.previous = new Voice(Processor.MAX_PARTIALS)
      v.pending = new Voice(Processor.MAX_PARTIALS)
      this.voices.push(v)
    }
  }

  message(data) {
    if (!data || data.type !== 'uiHint' || typeof data.text !== 'string') return
    this.hintChars.fill(0)
    this.hintChars[0] = ++this.hintRevision
    const length = Math.min(253, data.text.length)
    this.hintChars[1] = length
    this.hintChars[2] = data.transient ? 1 : 0
    for (let i = 0; i < length; i++) this.hintChars[i + 3] = data.text.charCodeAt(i)
    this.hintDirty = true
  }

  paramChanged(name, value) {
    const matrix = MATRIX_NAMES.indexOf(name)
    const tone = TONE_NAMES.indexOf(name)
    if ((matrix < 0 && tone < 0) || !Number.isFinite(value)) return
    if (matrix < 0) this._setTone(name, value)
    else {
      const next = Math.max(0, Math.min(15, Math.round(value)))
      if (next === this.params[matrix]) return
      this.params[matrix] = next
      this._retargetVoices()
    }
  }

  _retargetVoices() {
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i]
      if (!voice.active) continue
      this._bakeVoice(voice.pending, voice.pitch, voice.velocity, voice.cent)
      voice.pendingReady = true
      if (voice.fadeRemaining === 0) this._beginTransition(voice)
    }
  }

  _copyVoice(target, source) {
    for (let i = 0; i < VOICE_SCALARS.length; i++) {
      const key = VOICE_SCALARS[i]
      target[key] = source[key]
    }
    for (let i = 0; i < VOICE_ARRAYS.length; i++) {
      const key = VOICE_ARRAYS[i]
      target[key].set(source[key])
    }
  }

  _inheritTime(target, source) {
    target.id = source.id
    target.active = source.active
    target.gain = source.gain
    target.gate = source.gate
    target.stage = source.stage
    target.fastRelease = source.fastRelease
    target.filterEnvelope = source.filterEnvelope
    target.filter = source.filter
    target.sideFilter = source.sideFilter
    target.filterRate = source.filterRate
    target.filterTarget = source.filterTarget
    target.filterClock = source.filterClock
    target.filterSeenEnvelope = NaN
    target.phases.set(source.phases)
    target.fmPhase = source.fmPhase
    target.tremPhase = source.tremPhase
    target.vibPhase = source.vibPhase
    target.noiseState = source.noiseState
    target.velocityShade = source.velocityShade
    target.fmEnvelope = source.fmEnvelope
    target.partialGain.set(source.partialGain)
    target.smoothPartialAmount = source.smoothPartialAmount
    target.smoothFMAmount = source.smoothFMAmount
    target.smoothDetune = source.smoothDetune
    target.smoothTremolo = source.smoothTremolo
    target.smoothVibrato = source.smoothVibrato
  }

  _beginTransition(voice) {
    this._inheritTime(voice.pending, voice)
    this._copyVoice(voice.previous, voice)
    this._copyVoice(voice, voice.pending)
    voice.fadeRemaining = this.fadeLength
    voice.pendingReady = false
  }

  _setTone(name, value) {
    if (!Number.isFinite(value)) return
    const previous = this[name]
    value = toneValue(name, toneStep(name, value))
    if (name === 'filterEnv') this.filterEnv = Math.max(0, Math.min(1, value))
    if (name === 'filterDecay') {
      this.filterDecay = Math.max(0.02, Math.min(4, value))
      this.filterDecayRate = Math.exp(-5 / (this.filterDecay * sampleRate))
    }
    if (name === 'width') this.width = Math.max(0, Math.min(1, value))
    if (name === 'saturation') this.saturation = Math.max(0, Math.min(1, value))
    if (name === 'partialDecay') this.partialDecay = Math.max(0, Math.min(1, value))
    if (name === 'fmEnv') this.fmEnv = Math.max(0, Math.min(1, value))
    if (name === 'detune' || name === 'tremolo' || name === 'vibrato') this[name] = Math.max(0, Math.min(1, value))
    if (name === 'velocityTimbre') this.velocityTimbre = Math.max(0, Math.min(1, value))
    if (name === 'fmTime') {
      this.fmTime = Math.max(.02, Math.min(4, value))
      this.fmDecayRate = Math.exp(-5 / (this.fmTime * sampleRate))
    }
    if (name === 'partialTime') {
      const next = Math.max(.02, Math.min(4, value))
      if (next !== this.partialTime) {
        this.partialTime = next
        for (let i = 0; i < this.voices.length; i++) {
          const voice = this.voices[i]
          if (!voice.active) continue
          this._partialRates(voice)
          if (voice.fadeRemaining > 0) this._partialRates(voice.previous)
          if (voice.pendingReady) this._partialRates(voice.pending)
        }
      }
    }
    if ((name === 'filterEnv' || name === 'filterDecay') && previous !== this[name]) {
      for (const voice of this.voices) {
        if (!voice.active) continue
        voice.filterEnvelope = 1; voice.filterClock = 0
        if (voice.fadeRemaining > 0) { voice.previous.filterEnvelope = 1; voice.previous.filterClock = 0 }
        if (voice.pendingReady) { voice.pending.filterEnvelope = 1; voice.pending.filterClock = 0 }
      }
    }
  }

  _filterCutoff(voice) {
    // Sweep zero retains the static matrix brightness. Positive sweep opens
    // above it, then closes below it; leave the fundamental audible.
    const floor = Math.max(30, voice.freq * .5)
    const octaves = this.filterEnv * (6 * voice.filterEnvelope - 3) + voice.velocityShade * 3
    return Math.min(sampleRate * .4, Math.max(floor, voice.baseCutoff * Math.pow(2, octaves)))
  }

  _partialRates(voice) {
    let lowest = Infinity, highest = 0
    for (let k = 0; k < voice.numPartials; k++) {
      lowest = Math.min(lowest, voice.freqMul[k])
      highest = Math.max(highest, voice.freqMul[k])
    }
    const span = Math.max(.001, highest - lowest)
    for (let k = 0; k < voice.numPartials; k++) {
      const height = (voice.freqMul[k] - lowest) / span
      voice.partialRate[k] = Math.exp(-5 * height / (this.partialTime * sampleRate))
    }
  }

  _bakeVoice(voice, pitch, velocity, cent) {
    // Only Character changes the seeded variation. Other cells have stable roles.
    const p = this.params
    const rng = new RNG(p[8] * 73856093)
    const family = FAMILY_TYPES[p[0]]
    const harmonicity = p[1] / 15
    const brightness = p[2] / 15
    const motion = p[3] / 15
    const percussive = family === 1 || family === 2 || family === 4 || family === 8 || family === 10 || family === 11
    voice.pitch = pitch
    voice.cent = cent
    voice.freq = 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)
    voice.velocity = Math.max(0, Math.min(1, velocity))
    voice.velocityShade = this.velocityTimbre * (voice.velocity - 1)
    voice.gain = 0
    voice.gate = true
    voice.stage = 0
    voice.fastRelease = false
    voice.fmEnvelope = 1
    voice.partialGain.fill(1)
    voice.smoothPartialAmount = this.partialDecay
    voice.smoothFMAmount = this.fmEnv
    voice.smoothDetune = this.detune
    voice.smoothTremolo = this.tremolo
    voice.smoothVibrato = this.vibrato
    const slowAttack = family === 3 || family === 7 || family === 14 || family === 15
    const attackSec = (slowAttack ? 0.04 : family === 5 ? 0.008 : 0.001) * Math.pow(slowAttack ? 60 : 150, p[4] / 15)
    const decaySec = (family === 2 || family === 4 || family === 8 || family === 10 ? 0.3 : 0.025) * Math.pow(60, p[5] / 15)
    const releaseSec = (family === 3 || family === 2 || family === 7 || family === 8 || family === 10 || family === 14 || family === 15 ? 0.08 : 0.008) * Math.pow(150, p[7] / 15)
    voice.attackRate = 1 / (attackSec * sampleRate)
    voice.decayRate = 1 - Math.exp(-5 / (decaySec * sampleRate))
    voice.releaseRate = 1 - Math.exp(-7 / (releaseSec * sampleRate))
    voice.sustainGain = Math.pow(p[6] / 15, 2) * (percussive ? 0.18 : 1)
    voice.numPartials = family === 13 ? 5 : family === 3 ? 6 : 8
    voice.noiseState = (p[8] * 2654435761) >>> 0
    voice.noiseMix = family === 5 ? 0.015 + brightness * 0.04 : family === 8 ? 0.08 + brightness * 0.15 : family === 9 ? .015 : 0
    voice.sideFilter = 0
    voice.filterEnvelope = 1
    voice.filter = 0
    const cutoff = Math.min(sampleRate * 0.4, (family === 6 ? 80 : 180) * Math.pow(family === 6 ? 24 : 90, brightness))
    voice.baseCutoff = cutoff
    voice.filterRate = 1 - Math.exp(-6.283185307 * this._filterCutoff(voice) / sampleRate)
    voice.filterTarget = voice.filterRate
    voice.filterClock = 0
    voice.filterSeenEnvelope = voice.filterEnvelope
    voice.filterSeenVelocity = voice.velocityShade
    voice.filterSeenAmount = this.filterEnv
    let total = 0
    for (let k = 0; k < voice.numPartials; k++) {
      const n = k + 1
      const variation = rng.next()
      let ratio = n
      if (family === 2 || family === 8) {
        ratio = n + (1 - harmonicity) * (k * k * (family === 8 ? 0.73 : 0.21) + variation * k)
        if (family === 8) ratio *= 2.3
      } else if (family === 3) {
        ratio = k < 3 ? 1 : 2
      } else if (family === 6) {
        ratio = k === 0 ? 0.5 : k === 1 ? 1 : (k - 1) * 2 + 1
      } else {
        ratio = n + (1 - harmonicity) * k * 0.17
      }
      if (family === 9 || family === 13) ratio = k * 2 + 1 + (1 - harmonicity) * k * .05
      if (family === 10) ratio = n + .37 * k * k * (1.1 - harmonicity)
      if (family === 11) ratio = k === 0 ? 1 : n + (1 - harmonicity) * k * .015
      if (family === 12) ratio = k < 4 ? 1 : 2 + harmonicity
      if (family === 14) ratio = k < 2 ? 1 : k < 4 ? 1.5 : k < 6 ? 2 : 3
      if (family === 4) ratio = k === 0 ? 1 : n * n + (1 - harmonicity) * k * .12
      if (family === 15) ratio = n + (1 - harmonicity) * k * .025
      voice.pan[k] = (k % 2 === 0 ? -1 : 1) * (0.3 + variation * 0.5)
      voice.freqMul[k] = ratio
      voice.baseFreqs[k] = voice.freq * voice.freqMul[k]
      voice.amps[k] = Math.pow(n, -(2.8 - brightness * 2.4)) * (0.8 + variation * 0.2)
      if (family === 3) voice.amps[k] = k < 3 ? 1 : 0.2 + brightness * 0.4
      if (family === 5) voice.amps[k] *= k === 0 ? 2 : k === 1 ? 0.45 : 0.08
      if (family === 6) voice.amps[k] = k === 0 ? 1 : k === 1 ? 0.7 : brightness * 0.4 / n
      if (family === 7) {
        // Two broad vocal formants; Character chooses the vowel.
        const hz = voice.freq * ratio
        const f1 = 350 + p[8] / 15 * 520
        const f2 = 1100 + p[8] / 15 * 1040
        voice.amps[k] = 0.08 / n + Math.exp(-Math.pow((hz - f1) / 180, 2)) + 0.6 * Math.exp(-Math.pow((hz - f2) / 300, 2))
      }
      if (family === 8) voice.amps[k] = 0.4 + variation * 0.6
      if (family === 9) voice.amps[k] *= .7 + .6 * Math.exp(-Math.pow((n - 3) / 2, 2))
      if (family === 10) voice.amps[k] = (.3 + variation * .7) / Math.pow(n, 1.2 - brightness)
      if (family === 11) voice.amps[k] *= k === 0 ? 2 : k === 1 ? .7 : .2
      if (family === 12) voice.amps[k] = k < 4 ? 1 : .25 + brightness * .5
      if (family === 13) voice.amps[k] = 1 / Math.pow(n * 2 - 1, 1.8 - brightness)
      if (family === 14) voice.amps[k] = k < 2 ? 1 : .45
      if (family === 4) voice.amps[k] = k === 0 ? 1 : (.22 + brightness * .7) * Math.exp(-.38 * k) / Math.sqrt(n)
      if (family === 15) voice.amps[k] = Math.pow(n, -(1.6 - brightness * .9)) * (.45 + Math.exp(-Math.pow((n - 2 - p[8] / 15 * 4) / 1.3, 2)))
      total += voice.amps[k]
      voice.phases[k] = family === 1 || family === 4 || family === 6 || family === 8 || family === 11 || family === 13 || family === 15 ? 0 : rng.next()
      voice.detuneAmt[k] = family === 7 ? (variation - 0.5) * motion * 0.008 : family === 3 ? (k % 3 - 1) * (0.002 + motion * 0.012) : 0
      if (family === 12 || family === 14) voice.detuneAmt[k] = (k % 2 ? 1 : -1) * (.001 + motion * .008)
      voice.waveType[k] = family === 3 || family === 12 ? 2 : (family === 1 || family === 15) && k === 0 ? 1 : 0
    }
    for (let k = 0; k < voice.numPartials; k++) voice.amps[k] /= total
    voice.fmFreqMul = family === 4 ? 1 + Math.round(p[8] / 15 * 3) : 1 + p[8] / 15 * 4
    voice.fmDepth = family === 8 ? 0.7 + brightness * 2.5 : family === 2 ? 0.2 + brightness * 1.8 : family === 4 ? brightness * 0.12 : family === 1 ? brightness * 0.12 : 0
    if (family === 9) voice.fmDepth = brightness * .05
    if (family === 10) voice.fmDepth = .08 + brightness * .6
    if (family === 11) voice.fmDepth = .1 + brightness * .5
    voice.fmPhase = 0
    voice.tremRate = 0.2 + motion * 7
    voice.tremDepth = motion * (family === 3 ? 0.25 : 0.12)
    voice.tremPhase = 0
    voice.vibRate = 3 + motion * 3
    voice.vibDepth = motion * (family === 3 ? 0.004 : 0.0015)
    voice.vibPhase = 0
    this._partialRates(voice)
  }

  noteOn(pitch, velocity, cent, id) {
    let voice = null
    for (const v of this.voices) {
      if (!v.active) { voice = v; break }
    }
    if (!voice) {
      let minGain = Infinity
      for (const v of this.voices) {
        if (v.gain < minGain) { minGain = v.gain; voice = v }
      }
    }
    voice.fadeRemaining = 0
    voice.pendingReady = false
    voice.id = id
    voice.active = true
    this._bakeVoice(voice, pitch, velocity, cent)
  }

  noteOff(id) {
    for (const v of this.voices) {
      if (v.active && v.id === id) {
        v.gate = false
        v.previous.gate = false
        v.pending.gate = false
        break
      }
    }
  }

  reset() {
    for (const v of this.voices) {
      if (v.active) {
        v.gate = false
        v.fastRelease = true
        v.previous.gate = false
        v.previous.fastRelease = true
        v.pending.gate = false
        v.pending.fastRelease = true
      }
    }
  }

  _sine(phase) {
    return this._sineUnit(phase - Math.floor(phase))
  }

  _sineUnit(phase) {
    const position = phase * 4096
    const integer = position | 0
    const index = integer & 4095
    const a = this.sineTable[index]
    return a + (this.sineTable[index + 1] - a) * (position - integer)
  }

  _renderSample(v, invSR, filterDecayRate, smoothRate) {
    if (v.gate) {
      if (v.stage === 0) {
        v.gain = Math.min(1, v.gain + v.attackRate)
        if (v.gain >= 1) v.stage = 1
      } else {
        v.gain += (v.sustainGain - v.gain) * v.decayRate
      }
    } else {
      const rate = v.fastRelease ? 0.05 : v.releaseRate
      v.gain -= v.gain * rate
      if (v.gain < 0.00005) { v.active = false; v.sampleL = 0; v.sampleR = 0; return }
    }

    if (v.stage === 1 && v.sustainGain === 0 && v.gain < 0.000001) {
      v.sampleL = 0; v.sampleR = 0
      v.filter = 0; v.sideFilter = 0
      v.filterEnvelope = decayEnvelope(v.filterEnvelope, filterDecayRate)
      v.fmEnvelope = decayEnvelope(v.fmEnvelope, this.fmDecayRate)
      for (let k = 0; k < v.numPartials; k++) v.partialGain[k] = decayEnvelope(v.partialGain[k], v.partialRate[k])
      return
    }
    v.velocityShade = smoothValue(v.velocityShade, this.velocityTimbre * (v.velocity - 1), smoothRate)
    const velocityColor = 1 + v.velocityShade * .8
    const baseFreq = v.freq
    v.smoothDetune = smoothValue(v.smoothDetune, this.detune, smoothRate)
    v.smoothTremolo = smoothValue(v.smoothTremolo, this.tremolo, smoothRate)
    v.smoothVibrato = smoothValue(v.smoothVibrato, this.vibrato, smoothRate)
    const vibMod = 1 + (v.vibDepth === 0 ? 0 : this._sineUnit(v.vibPhase) * v.vibDepth * v.smoothVibrato)
    v.vibPhase += v.vibRate * invSR
    if (v.vibPhase >= 1) v.vibPhase -= 1

    v.smoothPartialAmount = smoothValue(v.smoothPartialAmount, this.partialDecay, smoothRate)
    v.smoothFMAmount = smoothValue(v.smoothFMAmount, this.fmEnv, smoothRate)
    const fmAccent = v.smoothFMAmount * v.fmEnvelope * velocityColor
    const fmDepth = v.fmDepth * velocityColor + fmAccent * 3
    const fmSig = fmDepth === 0 ? 0 : this._sineUnit(v.fmPhase) * fmDepth
    const fmOffset = fmSig / 6.283185307
    v.fmEnvelope = decayEnvelope(v.fmEnvelope, this.fmDecayRate)
    v.fmPhase = (v.fmPhase + baseFreq * v.fmFreqMul * vibMod * invSR) % 1

    let sig = 0
    let side = 0
    const np = v.numPartials
    const phases = v.phases, frequencies = v.baseFreqs, detune = v.detuneAmt
    const waves = v.waveType, amplitudes = v.amps, pans = v.pan
    const partialGain = v.partialGain, partialRate = v.partialRate
    for (let k = 0; k < np; k++) {
      const pFreq = frequencies[k] * vibMod * (1 + detune[k] * v.smoothDetune)
      const phAdv = Math.min(0.45, pFreq * invSR)
      // Cull partials above Nyquist; pad saws use PolyBLEP edges.
      if (pFreq < sampleRate * 0.45) {
        const phase = phases[k]
        const type = waves[k]
        let value
        if (type === 2) {
          value = 2 * phase - 1
          if (phase < phAdv) { const t = phase / phAdv; value -= t + t - t * t - 1 }
          else if (phase > 1 - phAdv) { const t = (phase - 1) / phAdv; value -= t * t + t + t + 1 }
        } else {
          value = type === 0 ? (fmSig === 0 ? this._sineUnit(phase) : this._sine(phase + fmOffset)) : waveTri(phase)
        }
        // A fading sine-FM layer gives saw/triangle families an accent too.
        if (type !== 0 && fmAccent > 0.00001) {
          const mix = fmAccent * .4
          value += (this._sine(phase + fmOffset) - value) * mix
        }
        const spectralGain = 1 - v.smoothPartialAmount * (1 - partialGain[k])
        const partial = value * amplitudes[k] * spectralGain
        sig += partial
        // Fundamentals below 160 Hz stay centered; upper harmonics spread.
        side += partial * pans[k] * Math.max(0, Math.min(1, (pFreq - 160) / 500))
      }
      partialGain[k] = decayEnvelope(partialGain[k], partialRate[k])
      const nextPhase = phases[k] + phAdv
      phases[k] = nextPhase >= 1 ? nextPhase - 1 : nextPhase
    }

    const trem = 1 - v.tremDepth * v.smoothTremolo * (0.5 + 0.5 * this._sineUnit(v.tremPhase))
    v.tremPhase += v.tremRate * invSR
    if (v.tremPhase >= 1) v.tremPhase -= 1

    v.noiseState = (Math.imul(v.noiseState, 1664525) + 1013904223) >>> 0
    if (v.noiseMix !== 0) sig = sig * (1 - v.noiseMix) + (v.noiseState / 2147483648 - 1) * v.noiseMix
    // Recompute expensive coefficients at a sample-counted control rate (~1.5 kHz).
    // Continue smoothing the coefficient and decaying the envelope every sample.
    if (v.filterClock === 0) {
      if (v.filterEnvelope !== v.filterSeenEnvelope || v.velocityShade !== v.filterSeenVelocity || this.filterEnv !== v.filterSeenAmount) {
        const cutoff = this._filterCutoff(v)
        v.filterTarget = 1 - Math.exp(-6.283185307 * cutoff * invSR)
        v.filterSeenEnvelope = v.filterEnvelope
        v.filterSeenVelocity = v.velocityShade
        v.filterSeenAmount = this.filterEnv
      }
      v.filterClock = 32
    }
    v.filterClock--
    v.filterRate += (v.filterTarget - v.filterRate) * smoothRate
    if (v.stage !== 0 || !v.gate) v.filterEnvelope = decayEnvelope(v.filterEnvelope, filterDecayRate)
    v.filter += (sig - v.filter) * v.filterRate
    v.sideFilter += (side * (1 - v.noiseMix) - v.sideFilter) * v.filterRate
    const gain = v.gain * v.velocity * trem
    v.sampleL = (v.filter + v.sideFilter) * gain
    v.sampleR = (v.filter - v.sideFilter) * gain
  }

  process(output, block) {
    const outL = output[0]
    const outR = output[1]
    const invSR = this.invSR
    const filterDecayRate = this.filterDecayRate
    const smoothRate = this.smoothRate

    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi]
      if (!v.active) continue

      for (let s = block.s0; s < block.s1; s++) {
        if (v.fadeRemaining === 0 && v.pendingReady) this._beginTransition(v)
        this._renderSample(v, invSR, filterDecayRate, smoothRate)
        if (v.fadeRemaining > 0) {
          this._renderSample(v.previous, invSR, filterDecayRate, smoothRate)
          const mix = 1 - v.fadeRemaining * this.invFadeLength
          outL[s] += v.previous.sampleL * (1 - mix) + v.sampleL * mix
          outR[s] += v.previous.sampleR * (1 - mix) + v.sampleR * mix
          v.fadeRemaining--
          if (!v.active && v.previous.active) v.active = true
        } else {
          outL[s] += v.sampleL
          outR[s] += v.sampleR
        }
        if (!v.active) { v.pendingReady = false; break }
      }
    }
    for (let s = block.s0; s < block.s1; s++) {
      this.smoothWidth = smoothValue(this.smoothWidth, this.width, smoothRate)
      this.smoothDrive += (1 + this.saturation * 4 - this.smoothDrive) * smoothRate
      const mid = (outL[s] + outR[s]) * 0.5
      const side = (outL[s] - outR[s]) * 0.5 * this.smoothWidth
      let l = (mid + side) * this.smoothDrive
      let r = (mid - side) * this.smoothDrive
      // Unity slope below the knee; smooth, bounded saturation above it.
      l = Math.abs(l) <= 0.8 ? l : Math.sign(l) * (0.8 + 0.2 * Math.tanh((Math.abs(l) - 0.8) * 5))
      r = Math.abs(r) <= 0.8 ? r : Math.sign(r) * (0.8 + 0.2 * Math.tanh((Math.abs(r) - 0.8) * 5))
      outL[s] = l
      outR[s] = r
    }
    if (this.hintDirty && this.streams && this.streams.uiHints && this.streams.uiHints.active) {
      this.streams.uiHints.set(this.hintChars)
      this.hintDirty = false
    }
  }
}

const MATRIX_NAMES = ['family', 'harmonics', 'brightness', 'motion', 'attack', 'decay', 'sustain', 'release', 'character']
const TONE_NAMES = ['filterEnv', 'filterDecay', 'width', 'saturation', 'partialDecay', 'partialTime', 'fmEnv', 'fmTime', 'velocityTimbre', 'detune', 'tremolo', 'vibrato']

function flashStatus(element, text) {
  clearTimeout(element._clearTimer)
  element.textContent = text
  element._clearTimer = setTimeout(() => { element.textContent = element._hintText || element._idleText || '' }, 2800)
}
function isToneTime(name) {
  return name === 'filterDecay' || name === 'partialTime' || name === 'fmTime'
}
function toneStep(name, value) {
  const normalized = isToneTime(name) ? Math.log(Math.max(.02, Math.min(4, value)) / .02) / Math.log(200) : value
  return Math.max(0, Math.min(1000, Math.round(normalized * 1000)))
}
function toneValue(name, step) {
  step = Math.max(0, Math.min(1000, Math.round(step)))
  // Microsecond precision preserves every logarithmic slider position on export.
  return isToneTime(name) ? Math.round(.02 * Math.pow(200, step / 1000) * 1000000) / 1000000 : step / 1000
}
function quantizedTone(tone) {
  const result = {}
  for (const name of TONE_NAMES) result[name] = toneValue(name, toneStep(name, tone[name]))
  return result
}
function readTone(host) {
  const tone = {}
  for (const name of TONE_NAMES) tone[name] = toneValue(name, toneStep(name, host.params[name].value))
  return tone
}
function writeTone(host, tone) {
  for (const name of TONE_NAMES) host.params[name].set(tone[name])
}
function matrixValue(host, index) {
  const value = host.params[MATRIX_NAMES[index]].value
  return Math.max(0, Math.min(15, Math.round(value)))
}
function setMatrixValue(host, index, value) { host.params[MATRIX_NAMES[index]].set(value) }
function watchParameters(host, names, observer, subscriptions) {
  for (const name of names) subscriptions.push(host.params[name].subscribe(observer))
}
function validTone(tone) {
  if (!tone || typeof tone !== 'object' || Array.isArray(tone)) return false
  for (const name of TONE_NAMES) {
    const value = tone[name]
    if (!Number.isFinite(value) || value < (isToneTime(name) ? .02 : 0) || value > (isToneTime(name) ? 4 : 1)) return false
  }
  return true
}
function hexDigit(value) { return value.toString(16).toUpperCase() }
function publishHint(host, text, transient = false) {
  host.send({ type: 'uiHint', text, transient })
}
function bindHint(host, element, text) {
  const show = () => publishHint(host, typeof text === 'function' ? text() : text)
  element.addEventListener('pointerenter', show)
  element.addEventListener('pointerleave', () => { if (!element.contains(document.activeElement)) publishHint(host, '') })
  element.addEventListener('focusin', show)
  element.addEventListener('focusout', event => { if (!element.matches(':hover') && !element.contains(event.relatedTarget)) publishHint(host, '') })
}
function familyColor(name, opacity = 1) {
  return 'hsl(var(--family-hue) ' + (name === 'displayGrid' ? '62% 72%' : '78% 85%') + ' / ' + opacity + ')'
}
function terminateSubscription(subscription) {
  if (typeof subscription === 'function') subscription()
  else if (subscription && typeof subscription.terminate === 'function') subscription.terminate()
}
function installFamilyTheme(host) {
  host.root.style.setProperty('--family-surface', 'hsl(var(--family-hue) 22% 13%)')
  const update = () => host.root.style.setProperty('--family-hue',
    (matrixValue(host, 0) * 360 / 16).toFixed(3))
  const style = document.createElement('style')
  style.textContent = `
        * { box-sizing:border-box; }
        :where(.deminix, .tone, .patch) { margin:1px; width:calc(100% - 2px); height:calc(100% - 2px); padding:4px;
            border:.5px solid ${familyColor('displayGrid', .12)}; border-radius:8px; display:grid;
            gap:3px; font:inherit; font-size:11px; color:${familyColor('displayStroke')}; background:var(--family-surface); }
        :where(.deminix, .tone, .patch) button { font:inherit; color:inherit; background:transparent;
            border:1px solid var(--button-border, ${familyColor('displayGrid', .18)}); border-radius:4px; cursor:pointer; }
        .caption, .title, .patchTitle { font-size:9px; letter-spacing:.08em; }
        .actions, .toneActions, .patchRow { display:flex; gap:3px; }
        button:focus-visible { outline:1px solid ${familyColor('displayStroke', .75)}; outline-offset:-2px; }
        :root button { background:transparent; }
        :root button:hover:not(:disabled), :root button:focus-visible {
            background:${familyColor('displayStroke', .16)};
            border-color:${familyColor('displayStroke', .75)};
        }
        :root button:hover:disabled { background:${familyColor('displayStroke', .04)}; }
        ::selection { background:hsl(var(--family-hue) 78% 50% / .35); }
    `
  host.root.append(style)
  update()
  const subscription = host.params.family.subscribe(update)
  const releaseButtonFocus = event => {
    if (event.detail === 0) return
    const button = event.target.closest('button')
    if (button && !button.matches('.cell, .valueButton')) button.blur()
  }
  host.root.addEventListener('click', releaseButtonFocus)
  const ignoreButtonSpace = event => {
    if ((event.key === ' ' || event.code === 'Space') && event.target.closest('button')) event.preventDefault()
  }
  host.root.addEventListener('keydown', ignoreButtonSpace, true)
  host.root.addEventListener('keyup', ignoreButtonSpace, true)
  return {
    terminate() {
      terminateSubscription(subscription)
      host.root.removeEventListener('click', releaseButtonFocus)
      host.root.removeEventListener('keydown', ignoreButtonSpace, true)
      host.root.removeEventListener('keyup', ignoreButtonSpace, true)
    }
  }
}
function shuffleMatrix(host) {
  const currentFamily = matrixValue(host, 0)
  let f = currentFamily
  if (!host.data.matrix.get(0).lock) {
    f = Math.floor(Math.random() * 15)
    if (f >= currentFamily) f++
    setMatrixValue(host, 0, f)
  }
  // Ranges for harmonicity, brightness, motion, attack, decay, sustain, release, character.
  const ranges = [
    [[10, 15], [3, 12], [0, 7], [1, 8], [4, 12], [9, 15], [2, 10], [0, 15]],
    [[11, 15], [2, 11], [0, 6], [0, 8], [4, 13], [9, 15], [1, 11], [0, 15]],
    [[11, 15], [2, 9], [2, 8], [2, 8], [6, 13], [9, 15], [2, 8], [0, 15]],
    [[9, 15], [4, 15], [0, 4], [0, 2], [2, 11], [0, 4], [2, 9], [0, 15]],
    [[11, 15], [0, 9], [0, 4], [0, 4], [2, 9], [4, 13], [0, 6], [0, 15]],
    [[0, 11], [4, 15], [0, 4], [0, 2], [8, 15], [0, 2], [8, 15], [0, 15]],
    [[8, 15], [2, 13], [4, 13], [4, 13], [8, 15], [8, 15], [8, 15], [0, 15]],
    [[11, 15], [4, 13], [2, 9], [4, 11], [6, 13], [9, 15], [6, 13], [0, 15]],
    [[10, 15], [3, 13], [0, 5], [0, 3], [6, 13], [0, 4], [3, 10], [0, 15]],
    [[0, 8], [8, 15], [0, 6], [0, 2], [6, 15], [0, 2], [6, 15], [0, 15]],
    [[1, 10], [7, 15], [0, 4], [0, 2], [9, 15], [0, 2], [8, 15], [0, 15]],
    [[12, 15], [3, 12], [0, 5], [0, 3], [5, 12], [0, 6], [3, 10], [0, 15]],
    [[7, 15], [7, 15], [2, 12], [0, 5], [4, 12], [7, 15], [2, 9], [0, 15]],
    [[12, 15], [4, 15], [0, 5], [0, 1], [1, 8], [0, 12], [0, 6], [0, 15]],
    [[6, 15], [2, 12], [4, 15], [6, 15], [8, 15], [10, 15], [9, 15], [0, 15]],
    [[9, 15], [4, 13], [2, 11], [4, 11], [6, 14], [10, 15], [7, 14], [0, 15]]
  ][f]
  for (let i = 1; i < 9; i++) if (!host.data.matrix.get(i).lock) {
    const range = ranges[i - 1]
    setMatrixValue(host, i, range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1)))
  }
  return f
}
function mutateMatrix(host) {
  const candidates = []
  for (let i = 1; i < 9; i++) if (!host.data.matrix.get(i).lock) candidates.push(i)
  if (candidates.length === 0) return 0
  const count = Math.min(candidates.length, 1 + Math.floor(Math.random() * 3))
  host.edit(() => {
    for (let n = 0; n < count; n++) {
      const pick = Math.floor(Math.random() * candidates.length)
      const index = candidates.splice(pick, 1)[0]
      const value = matrixValue(host, index)
      const step = 1 + Math.floor(Math.random() * 2)
      let next = value + (Math.random() < .5 ? -step : step)
      if (next < 0 || next > 15) next = value + (next < 0 ? step : -step)
      setMatrixValue(host, index, next)
    }
  })
  return count
}
function randomTone(family) {
  const time = () => .04 * Math.pow(50, Math.random())
  return quantizedTone({
    filterEnv: .15 + Math.random() * .85, filterDecay: time(),
    width: Math.random() * (family === 4 ? .25 : 1), saturation: Math.random() * .45,
    partialDecay: Math.random() * .85, partialTime: time(),
    fmEnv: Math.random() * (family === 2 || family === 6 || family === 7 || family === 15 ? .35 : .75), fmTime: time(), velocityTimbre: Math.random() * .8, detune: Math.random(), tremolo: Math.random(), vibrato: Math.random()
  })
}

// Views communicate with the processor through parameters, custom data and streams.
class MatrixView {
  constructor(host) {
    this.host = host
    this.subscriptions = [installFamilyTheme(host)]
    this.drag = null
    this.selected = 0
    this.cells = []
    this.quickLocks = []
    this.roles = ['Family', 'Harmonics', 'Brightness', 'Motion', 'Attack', 'Decay', 'Sustain', 'Release', 'Character']
    this.descriptions = [
      'Choose a sound family',
      'Inharmonic → harmonic',
      'Dark → bright',
      'Detune, vibrato and tremolo',
      'Fade-in time',
      'Time to sustain level',
      'Held-note level',
      'Fade-out after note-off',
      'Overtone and FM variation'
    ]
    const root = host.root
    const style = document.createElement('style')
    style.textContent = `
            .deminix { --button-border:${familyColor('displayGrid', .12)}; grid-template-columns:minmax(0,1fr); grid-template-rows:12px minmax(0,1fr) 22px; gap:4px 6px; }
            .matrix { display:grid; grid-template:repeat(3,minmax(0,1fr))/repeat(3,minmax(0,1fr)); gap:3px; min-height:0; }
            .matrixCell { position:relative; min-width:0; min-height:0; }
            .quickLock { position:absolute; right:1px; bottom:1px; width:18px; height:19px; padding:2px; display:grid; place-items:center; border-color:transparent; opacity:.85; touch-action:manipulation; }
            .quickLock[aria-pressed=true], .quickLock:hover, .quickLock:focus-visible { opacity:1; }
            .quickLock svg { width:13px; height:13px; pointer-events:none; }
            .cell { width:100%; height:100%; position:relative; font-size:17px; line-height:1; touch-action:none; cursor:ns-resize; padding:6px 14px 0 0; }
            .cell[aria-selected=true] { border-color:${familyColor('displayStroke', .45)}; background:${familyColor('displayStroke', .06)}; }
            .index { position:absolute; top:1px; left:3px; max-width:calc(100% - 6px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:8px; opacity:1; }
            .level { position:absolute; bottom:3px; left:4px; height:2px; background:${familyColor('displayStroke', .45)}; pointer-events:none; }
            .matrixActions { grid-column:1/-1; min-width:0; }
            .matrixActions button { min-width:0; padding:3px 2px; white-space:nowrap; }
            .actions button { padding:3px 4px; flex:1; font-size:9px; }
            button[aria-pressed=true] { background:${familyColor('displayStroke', .1)}; border-color:${familyColor('displayStroke', .65)}; }
        `
    const panel = document.createElement('div')
    panel.className = 'deminix'
    const matrix = document.createElement('div')
    matrix.className = 'matrix'
    matrix.setAttribute('role', 'group')
    matrix.setAttribute('aria-label', 'Sound seed matrix, row by row')
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('button')
      cell.className = 'cell'
      cell.type = 'button'
      this.subscriptions.push(host.attachParameter(cell, MATRIX_NAMES[i]))
      cell.innerHTML = `<span class="index">${this.roles[i]}</span><span class="digit"></span><span class="level"></span>`
      bindHint(host, cell, this.roles[i] + ': ' + this.descriptions[i])
      cell.addEventListener('pointerdown', event => this.start(event, i))
      cell.addEventListener('pointermove', event => this.move(event))
      cell.addEventListener('pointerup', () => this.finish())
      cell.addEventListener('pointercancel', () => this.finish())
      cell.addEventListener('lostpointercapture', () => this.finish())
      cell.addEventListener('focus', () => { this.selected = i; this.render() })
      cell.addEventListener('keydown', event => this.key(event, i))
      cell.addEventListener('wheel', event => {
        if (!Number.isFinite(event.deltaY) || event.deltaY === 0 || event.ctrlKey || event.metaKey || this.drag) return
        event.preventDefault()
        host.edit(() => this.set(i, this.value(i) - Math.sign(event.deltaY)))
      }, { passive: false })
      cell.addEventListener('dblclick', () => { this.finish(); host.edit(() => this.set(i, 5)) })
      const wrapper = document.createElement('div')
      wrapper.className = 'matrixCell'
      const lock = document.createElement('button')
      lock.type = 'button'
      lock.className = 'quickLock'
      lock.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path class="shackle"/><path d="M12 14v3"/></svg>'
      bindHint(host, lock, () => (this.locked(i) ? 'Unlock ' : 'Lock ') + this.roles[i])
      lock.addEventListener('click', () => {
        this.finish()
        const locked = !this.locked(i)
        host.edit(() => host.data.matrix.set(i, { lock: locked ? 1 : 0 }))
        this.setStatus(this.roles[i] + (locked ? ' locked for shuffle' : ' free for shuffle'))
      })
      wrapper.append(cell, lock)
      matrix.append(wrapper)
      this.quickLocks.push(lock)
      this.cells.push(cell)
    }
    const title = document.createElement('div')
    title.className = 'caption'
    title.textContent = 'MATRIX'
    const actions = document.createElement('div')
    actions.className = 'actions matrixActions'
    actions.innerHTML = '<button type="button">Shuffle</button><button type="button">Mutate</button><button type="button">Copy</button><button type="button">Paste</button>'
    const clipboardButtons = [actions.querySelectorAll('button')[2], actions.querySelectorAll('button')[3]]
    bindHint(host, clipboardButtons[0], 'Copy matrix')
    bindHint(host, clipboardButtons[1], 'Paste matrix')
    this.clipboard = new ViewClipboard(host, text => this.setStatus(text), 'seed', () => this.seedText(), text => this.applySeed(text))
    clipboardButtons[0].addEventListener('click', () => this.clipboard.copy())
    clipboardButtons[1].addEventListener('click', () => this.clipboard.paste())
    const buttons = actions.querySelectorAll('button')
    bindHint(host, buttons[0], 'Shuffle unlocked fields')
    buttons[0].addEventListener('click', () => this.shuffle())
    bindHint(host, buttons[1], 'Vary 1–3 unlocked fields')
    buttons[1].addEventListener('click', () => {
      this.finish()
      const count = mutateMatrix(host)
      this.setStatus(count ? count + ' fields mutated' : 'No unlocked shape fields to mutate')
    })
    panel.append(title, matrix, actions)
    root.append(style, panel)
    this.subscriptions.push(host.data.matrix.subscribe(() => this.render()))
    watchParameters(host, MATRIX_NAMES, () => this.render(), this.subscriptions)
    this.render()
  }
  setStatus(text) { publishHint(this.host, text, true) }
  locked(i) { return !!this.host.data.matrix.get(i).lock }
  value(i) { return matrixValue(this.host, i) }
  set(i, value) {
    value = Math.max(0, Math.min(15, Math.round(value)))
    if (this.value(i) !== value) setMatrixValue(this.host, i, value)
  }
  render() {
    for (let i = 0; i < 9; i++) {
      const value = this.value(i)
      const cell = this.cells[i]
      cell.querySelector('.digit').textContent = hexDigit(value)
      cell.querySelector('.index').textContent = i === 0 ? FAMILY_NAMES[value] : this.roles[i]
      const lock = this.quickLocks[i]
      const locked = this.locked(i)
      lock.setAttribute('aria-pressed', String(locked))
      lock.setAttribute('aria-label', (locked ? 'Unlock ' : 'Lock ') + this.roles[i])
      lock.querySelector('.shackle').setAttribute('d', locked ? 'M8 10V7a4 4 0 0 1 8 0v3' : 'M8 10V6a4 4 0 0 1 8 0')
      cell.querySelector('.level').style.width = `${value / 15 * 45}%`
      cell.setAttribute('aria-label', `${this.roles[i]}${i === 0 ? ': ' + FAMILY_NAMES[value] : ''}, value ${hexDigit(value)}. Type a hexadecimal digit or use up and down arrows.`)
      cell.setAttribute('aria-selected', String(i === this.selected))
    }
  }

  start(event, i) {
    if (event.button !== 0 || this.drag) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    this.drag = { i, y: event.clientY, value: this.value(i), gesture: this.host.gesture() }
    publishHint(this.host, this.roles[i] + ': ' + this.descriptions[i])
  }
  move(event) {
    if (!this.drag) return
    const drag = this.drag
    const value = drag.value + Math.round((drag.y - event.clientY) / (event.shiftKey ? 24 : 10))
    drag.gesture.edit(() => this.set(drag.i, value))
  }
  finish() {
    if (!this.drag) return
    const drag = this.drag
    this.drag = null
    drag.gesture.end()
  }
  key(event, i) {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    let value
    if (/^[0-9a-f]$/i.test(event.key)) value = parseInt(event.key, 16)
    else if (event.key === 'ArrowUp' || event.key === 'ArrowRight') value = this.value(i) + 1
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') value = this.value(i) - 1
    else if (event.key === 'Home') value = 0
    else if (event.key === 'End') value = 15
    else return
    event.preventDefault()
    this.host.edit(() => this.set(i, value))
  }
  seedText() {
    let text = ''
    for (let i = 0; i < 9; i++) text += hexDigit(this.value(i))
    return text
  }
  applySeed(text) {
    const digits = String(text).replace(/\s/g, '').replace(/^0x/i, '')
    if (!/^[0-9a-f]{9}$/i.test(digits)) return false
    this.finish()
    this.host.edit(() => {
      for (let i = 0; i < 9; i++) this.set(i, parseInt(digits[i], 16))
    })
    return true
  }
  shuffle() {
    this.finish()
    let family
    this.host.edit(() => { family = shuffleMatrix(this.host) })
    this.setStatus(FAMILY_NAMES[family] + ' shuffled · locks preserved')
  }
  terminate() {
    this.finish()
    this.clipboard.terminate()
    for (const subscription of this.subscriptions) terminateSubscription(subscription)
  }
}

class ToneView {
  constructor(host) {
    this.host = host
    this.subscriptions = [installFamilyTheme(host)]
    this.controls = []
    const style = document.createElement('style')
    style.textContent = `
            .tone { grid-template-rows:12px minmax(0,1fr) 22px; }
            .title { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
            .toneActions button { flex:1; padding:3px; font-size:9px; }
            .toneControls { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); grid-template-rows:repeat(2,minmax(0,1fr)); grid-template-areas:"filter partial output" "fm motion output"; gap:3px; min-height:0; }
            .tonePair { min-height:0; min-width:0; padding:2px 4px; border:1px solid ${familyColor('displayGrid', .15)}; border-radius:4px; display:grid; grid-template-rows:10px auto; align-content:start; gap:3px; }
            .pairTitle { font-size:8px; letter-spacing:.03em; white-space:nowrap; }
            .pairControls { display:grid; grid-template-columns:minmax(0,1fr); gap:2px; min-height:0; }
            .toneControl { display:flex; align-items:center; justify-content:space-between; gap:3px; min-width:0; min-height:0; font-size:9px; }
            .tone .valueButton { box-sizing:border-box; width:48px; flex:none; min-width:0; padding:1px 2px; font:inherit; font-variant-numeric:tabular-nums; cursor:ns-resize; touch-action:none; user-select:none; }
            .tone .valueButton:focus-visible { outline:1px solid ${familyColor('displayStroke', .75)}; outline-offset:2px; }
        `
    const panel = document.createElement('div')
    panel.className = 'tone'
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = 'TONE / SHAPING'
    const controls = document.createElement('div')
    controls.className = 'toneControls'
    const definitions = [
      ['filterEnv', 'FILTER', 'Filter sweep', 'Amount', 'Filter envelope depth'],
      ['filterDecay', 'FILTER', 'Filter decay', 'Decay', 'Filter envelope time'],
      ['partialDecay', 'PARTIAL DECAY', 'Partial fade', 'Amount', 'Upper-overtone fade amount'],
      ['partialTime', 'PARTIAL DECAY', 'Partial decay', 'Decay', 'Upper-overtone fade time'],
      ['fmEnv', 'FM', 'FM accent', 'Amount', 'Initial FM boost'],
      ['fmTime', 'FM', 'FM decay', 'Decay', 'FM boost fade time'],
      ['detune', 'MOTION', 'Detune', 'Detune', 'Detune multiplier'],
      ['tremolo', 'MOTION', 'Tremolo', 'Trem', 'Tremolo depth multiplier'],
      ['vibrato', 'MOTION', 'Vibrato', 'Vib', 'Vibrato depth multiplier'],
      ['width', 'OUTPUT / EXPRESSION', 'Stereo width', 'Width', 'Stereo spread; 0 = mono'],
      ['saturation', 'OUTPUT / EXPRESSION', 'Saturation', 'Drive', 'Soft-clipping drive'],
      ['velocityTimbre', 'OUTPUT / EXPRESSION', 'Velocity → Timbre', 'Vel', 'Velocity sensitivity of brightness and FM']
    ]
    const groups = new Map()
    for (const caption of new Set(definitions.map(([, group]) => group))) {
      const pair = document.createElement('div')
      pair.className = 'tonePair'
      pair.style.gridArea = { 'FILTER': 'filter', 'PARTIAL DECAY': 'partial', 'FM': 'fm', 'MOTION': 'motion', 'OUTPUT / EXPRESSION': 'output' }[caption]
      pair.setAttribute('role', 'group')
      pair.setAttribute('aria-label', caption)
      const heading = document.createElement('div')
      heading.className = 'pairTitle'; heading.textContent = caption === 'OUTPUT / EXPRESSION' ? 'OUTPUT / EXPR.' : caption
      const body = document.createElement('div')
      body.className = 'pairControls'
      pair.append(heading, body); controls.append(pair); groups.set(caption, body)
    }
    for (const [name, group, caption, shortLabel, hint] of definitions) {
      const label = document.createElement('div')
      label.className = 'toneControl'
      bindHint(host, label, caption + ': ' + hint + '. Drag up/down or use the mouse wheel; hold Shift for fine adjustments.')
      const text = document.createElement('span')
      text.textContent = shortLabel
      const valueButton = document.createElement('button')
      valueButton.type = 'button'; valueButton.className = 'valueButton'
      valueButton.setAttribute('aria-label', caption + ' ' + shortLabel)
      this.subscriptions.push(host.attachParameter(valueButton, name))
      const control = { name, valueButton, gesture: null, drag: null }
      const writePosition = position => {
        if (!Number.isFinite(position)) return
        const step = Math.round(Math.max(0, Math.min(1, position)) * 1000)
        if (step === toneStep(name, host.params[name].value)) return
        const write = () => host.params[name].set(toneValue(name, step))
        if (control.gesture) control.gesture.edit(write)
        else host.edit(write)
      }
      const end = event => {
        if (control.drag && event.pointerId !== undefined && event.pointerId !== control.drag.pointerId) return
        const drag = control.drag
        control.drag = null
        if (control.gesture) {
          const gesture = control.gesture
          control.gesture = null
          gesture.end()
        }
        if (drag && valueButton.hasPointerCapture(drag.pointerId)) valueButton.releasePointerCapture(drag.pointerId)
      }
      valueButton.addEventListener('pointerdown', event => {
        if (event.button !== 0 || control.drag) return
        event.preventDefault(); valueButton.focus(); valueButton.setPointerCapture(event.pointerId)
        control.gesture = host.gesture()
        control.drag = { pointerId: event.pointerId, lastY: event.clientY, position: toneStep(name, host.params[name].value) / 1000 }
      })
      valueButton.addEventListener('pointermove', event => {
        const drag = control.drag
        if (!drag || event.pointerId !== drag.pointerId) return
        event.preventDefault()
        const distance = drag.lastY - event.clientY
        drag.lastY = event.clientY
        drag.position = Math.max(0, Math.min(1, drag.position + distance / 200 * (event.shiftKey ? .1 : 1)))
        writePosition(drag.position)
      })
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) valueButton.addEventListener(event, end)
      valueButton.addEventListener('wheel', event => {
        if (!Number.isFinite(event.deltaY) || event.deltaY === 0 || event.ctrlKey || event.metaKey || control.drag) return
        event.preventDefault()
        const position = toneStep(name, host.params[name].value) / 1000
        writePosition(position - Math.sign(event.deltaY) * (event.shiftKey ? .001 : .01))
      }, { passive: false })
      valueButton.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const position = toneStep(name, host.params[name].value) / 1000
        const step = event.shiftKey ? .001 : .01
        writePosition(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : position + (event.key === 'ArrowUp' ? step : -step))
      })
      label.append(text, valueButton)
      groups.get(group).append(label)
      this.controls.push(control)
    }
    const status = text => publishHint(host, text, true)
    this.clipboard = new ViewClipboard(host, status, 'tone',
      () => JSON.stringify({ format: 'deminix.tone', version: 1, tone: readTone(host) }),
      text => this.applyTone(text))
    const actions = document.createElement('div')
    actions.className = 'toneActions'
    for (const [caption, action, hint] of [
      ['Shuffle', () => { host.edit(() => writeTone(host, randomTone(matrixValue(host, 0)))); status('Tone shuffled') }, 'Shuffle Tone'],
      ['Copy', () => this.clipboard.copy(), 'Copy Tone'], ['Paste', () => this.clipboard.paste(), 'Paste Tone']
    ]) {
      const button = document.createElement('button')
      button.type = 'button'; button.textContent = caption
      bindHint(host, button, hint)
      button.addEventListener('click', action)
      actions.append(button)
    }
    panel.append(title, controls, actions)
    host.root.append(style, panel)
    watchParameters(host, TONE_NAMES, () => this.render(), this.subscriptions)
    this.render()
  }
  applyTone(text) {
    let parsed
    try { parsed = JSON.parse(text) } catch { return false }
    if (!parsed || parsed.format !== 'deminix.tone' || parsed.version !== 1 || !validTone(parsed.tone)) return false
    const tone = quantizedTone(parsed.tone)
    this.host.edit(() => writeTone(this.host, tone))
    return true
  }
  render() {
    const tone = readTone(this.host)
    for (const control of this.controls) {
      const value = tone[control.name]
      control.valueButton.textContent = isToneTime(control.name) ? (value < .1 ? (value * 1000).toFixed(1) + ' ms' : value.toFixed(3) + ' s') : (value * 100).toFixed(1).replace(/\.0$/, '') + '%'
      control.valueButton.setAttribute('aria-description', control.valueButton.textContent)
    }
  }
  terminate() {
    for (const control of this.controls) if (control.gesture) control.gesture.end()
    this.clipboard.terminate()
    for (const subscription of this.subscriptions) terminateSubscription(subscription)
  }
}

// Clipboard payloads are versioned and validated completely before any writes.
class ViewClipboard {
  constructor(host, status, target, serialize, apply) {
    this.host = host
    this.status = status
    this.target = target
    this.label = { seed: "Seed", tone: "Tone", patch: "Whole patch" }[target]
    this.error = target === "seed" ? "Use nine hexadecimal digits, 0–F; spaces and 0x are allowed." : "Invalid " + target + " data; nothing changed."
    this.disposed = false
    this.serialize = serialize
    this.apply = apply
  }
  async copy() {
    if (this.disposed) return
    const text = this.serialize()
    try {
      await navigator.clipboard.writeText(text)
      if (!this.disposed) this.status(this.label + ' copied')
    } catch { if (!this.disposed) this.fallback(false, text) }
  }
  async paste() {
    if (this.disposed) return
    try {
      const text = await navigator.clipboard.readText()
      if (!this.disposed) this.applyText(text)
    } catch { if (!this.disposed) this.fallback(true, '') }
  }
  applyText(text) {
    if (this.disposed) return false
    const applied = this.apply(text)
    this.status(applied ? this.label + ' pasted' : this.error)
    return applied
  }
  close() {
    if (this.panel) this.panel.remove()
    this.panel = null
  }
  terminate() { this.disposed = true; this.close() }
  fallback(paste, text) {
    if (this.disposed) return
    this.close()
    const panel = document.createElement('div')
    this.panel = panel
    panel.style.cssText = 'position:fixed;inset:4px;z-index:10;padding:7px;border:1px solid ' + familyColor('displayStroke', .5) + ';border-radius:6px;color-scheme:dark;background:var(--family-surface);color:' + familyColor('displayStroke', 1) + ';display:flex;flex-direction:column;gap:4px;font:inherit;font-size:10px;overflow:auto'
    const label = document.createElement('label')
    label.textContent = paste ? 'Paste ' + this.target + ' (Ctrl/⌘+V):' : 'Copy ' + this.target + ' (Ctrl/⌘+C):'
    const input = document.createElement('textarea')
    input.value = text; input.readOnly = !paste; input.rows = 2
    input.setAttribute('aria-label', (this.target === 'seed' ? 'Seed' : this.target) + (paste ? ' to paste' : ' to copy'))
    input.style.cssText = 'width:100%;min-height:30px;resize:none;font:inherit;color:inherit;background:transparent;border:1px solid ' + familyColor('displayStroke', .5)
    label.append(input)
    const hint = document.createElement('div')
    hint.setAttribute('role', 'status')
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;gap:4px'
    const close = () => this.close()
    const button = (text, handler) => {
      const b = document.createElement('button')
      b.type = 'button'; b.textContent = text
      b.style.cssText = 'flex:1;font:inherit;color:inherit;background:transparent;border:1px solid ' + familyColor('displayStroke', .5) + ';border-radius:3px;padding:3px'
      bindHint(this.host, b, text.startsWith('Apply') ? 'Apply ' + this.target : text === 'Cancel' ? 'Cancel paste' : 'Close clipboard')
      b.addEventListener('click', handler); actions.append(b)
    }
    if (paste) button('Apply ' + this.target, () => {
      if (this.applyText(input.value)) close()
      else hint.textContent = this.error
    })
    else input.addEventListener('copy', () => this.status(this.label + ' copied'))
    button(paste ? 'Cancel' : 'Close', close)
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close() } })
    panel.append(label, hint, actions); this.host.root.append(panel)
    input.focus(); input.select()
  }
}

class PatchView {
  constructor(host) {
    this.host = host
    this.subscriptions = [installFamilyTheme(host)]
    const style = document.createElement('style')
    style.textContent = `
            .patch { font-size:10px; grid-template-rows:12px minmax(0,1fr) 22px; }
            .patchActions > .patchRow { width:100%; min-width:0; }
            .patchActions button { min-width:0; font-size:9px; padding:3px 1px; }
            .patch button { flex:1; font:inherit; padding:4px 2px; }
            .patchStatus { font-size:10px; line-height:1.25; opacity:1; min-height:0; overflow:auto; white-space:pre-line; }
        `
    const panel = document.createElement('div')
    panel.className = 'patch'
    const title = document.createElement('div')
    title.className = 'patchTitle'; title.textContent = 'PATCH'
    this.status = document.createElement('div')
    this.status.className = 'patchStatus'
    this.status.setAttribute('role', 'status')
    this.status._idleText = 'Hold Shift for fine adjustments\nDouble-click a matrix field to reset to 5'
    this.status.textContent = this.status._idleText
    const status = text => flashStatus(this.status, text)
    this.clipboard = new ViewClipboard(host, status, 'patch',
      () => JSON.stringify({ format: 'deminix.patch', version: 2, matrix: this.matrixValues(), tone: readTone(host) }),
      text => this.applyPatch(text))
    const actions = document.createElement('div')
    actions.className = 'patchRow patchActions'
    panel.append(title, this.status, actions)
    const row = (definitions, parent) => {
      const container = document.createElement('div')
      container.className = 'patchRow'
      for (const [caption, handler, hint] of definitions) {
        const button = document.createElement('button')
        button.type = 'button'; button.textContent = caption
        bindHint(host, button, hint)
        button.addEventListener('click', handler); container.append(button)
      }
      parent.append(container)
      return container
    }
    row([['Shuffle', () => {
      host.edit(() => { const family = shuffleMatrix(host); writeTone(host, randomTone(family)) })
      status('Patch shuffled')
    }, 'Shuffle patch'],
    ['Copy', () => this.clipboard.copy(), 'Copy patch'],
    ['Paste', () => this.clipboard.paste(), 'Paste patch']
    ], actions)
    host.root.append(style, panel)
    this.hintRevision = -1
    const hintSubscription = host.streams.uiHints.subscribe(values => {
      if (values[0] === this.hintRevision) return
      this.hintRevision = values[0]
      let text = ''
      const length = Math.max(0, Math.min(253, Math.round(values[1])))
      for (let i = 0; i < length; i++) text += String.fromCharCode(values[i + 3])
      clearTimeout(this.status._clearTimer)
      if (values[2]) flashStatus(this.status, text)
      else {
        this.status._hintText = text
        this.status.textContent = text || this.status._idleText
      }
    })
    this.subscriptions.push(hintSubscription)
  }
  matrixValues() {
    const values = []
    for (let i = 0; i < 9; i++) values.push(matrixValue(this.host, i))
    return values
  }
  validMatrix(values) {
    return Array.isArray(values) && values.length === 9 && values.every(value => Number.isInteger(value) && value >= 0 && value <= 15)
  }
  restore(matrix, tone) {
    if (!this.validMatrix(matrix) || !validTone(tone)) return false
    const values = quantizedTone(tone)
    this.host.edit(() => {
      for (let i = 0; i < 9; i++) setMatrixValue(this.host, i, matrix[i])
      writeTone(this.host, values)
    })
    return true
  }
  applyPatch(text) {
    let parsed
    try { parsed = JSON.parse(text) } catch { return false }
    if (!parsed || parsed.format !== 'deminix.patch' || parsed.version !== 2) return false
    return this.restore(parsed.matrix, parsed.tone)
  }
  terminate() {
    this.clipboard.terminate()
    clearTimeout(this.status._clearTimer)
    for (const subscription of this.subscriptions) terminateSubscription(subscription)
  }
}
