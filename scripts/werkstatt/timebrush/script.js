// @label Timebrush
// @param dry 1
// @param wet 0.5
// @param feedback 0.25 0 0.8 linear
// @param sync true
// @param time 2 0.125 4 exp
// @param output 0 -18 6 linear dB
// @view PaintView 1 1 6 3
// @buffer paint 1024
// @stream activity 65 value

// A 1024-point, four-overlap STFT. Each painted row is a logarithmic
// frequency range; each column is a tap in that row's spectral delay line.
class Processor {
    constructor() {
        this.n = 1024; this.hop = 256; this.bins = 513
        this.latency = this.n
        this.capacity = Math.ceil(12 * sampleRate / this.hop) + 4
        const length = this.capacity * this.bins
        this.historyLR = new Float32Array(length); this.historyLI = new Float32Array(length)
        this.historyRR = new Float32Array(length); this.historyRI = new Float32Array(length)
        this.inputL = new Float64Array(this.n); this.inputR = new Float64Array(this.n)
        this.overlapL = new Float64Array(this.n); this.overlapR = new Float64Array(this.n)
        this.realL = new Float64Array(this.n); this.imagL = new Float64Array(this.n)
        this.realR = new Float64Array(this.n); this.imagR = new Float64Array(this.n)
        this.window = new Float64Array(this.n)
        this.cosines = new Float64Array(this.n / 2); this.sines = new Float64Array(this.n / 2)
        this.reverse = new Uint16Array(this.n)
        this.band = new Uint8Array(this.bins)
        this.bandCounts = new Uint16Array(32)
        this.meterLower = new Uint8Array(32); this.meterUpper = new Uint8Array(32)
        this.meterBlend = new Float32Array(32)
        this.target = new Float64Array(1024); this.paint = new Float64Array(1024)
        this.normalization = new Float64Array(32); this.tapFrames = new Int32Array(32)
        this.tapColumns = new Uint8Array(1024); this.tapCounts = new Uint8Array(32)
        this.readBases = new Int32Array(32)
        this.energyIn = new Float64Array(32); this.energyOut = new Float64Array(32)
        for (let j = 0; j < this.n; j++) {
            this.window[j] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * j / this.n))
            let bits = j, reversed = 0
            for (let k = 0; k < 10; k++) { reversed = (reversed << 1) | (bits & 1); bits >>= 1 }
            this.reverse[j] = reversed
        }
        for (let j = 0; j < this.n / 2; j++) {
            this.cosines[j] = Math.cos(2 * Math.PI * j / this.n)
            this.sines[j] = Math.sin(2 * Math.PI * j / this.n)
        }
        for (let k = 0; k < this.bins; k++) {
            const frequency = Math.max(60, k * sampleRate / this.n)
            const row = Math.max(0, Math.min(31, Math.floor(Math.log(frequency / 60) / Math.log(16000 / 60) * 32)))
            this.band[k] = row; this.bandCounts[row]++
        }
        // Logarithmic display rows can be narrower than one FFT bin in the bass.
        // Bridge only those empty rows; audio continues to use the original bins.
        for (let row = 0; row < 32; row++) {
            let lower = row, upper = row
            while (lower > 0 && this.bandCounts[lower] === 0) lower--
            while (upper < 31 && this.bandCounts[upper] === 0) upper++
            if (this.bandCounts[lower] === 0) lower = upper
            if (this.bandCounts[upper] === 0) upper = lower
            this.meterLower[row] = lower; this.meterUpper[row] = upper
            this.meterBlend[row] = upper === lower ? 0 : (row - lower) / (upper - lower)
        }
        this.dry = this.dryNow = 1; this.wet = this.wetNow = 0.5
        this.output = this.outputNow = 1; this.feedback = this.feedbackNow = 0.25
        this.sync = true; this.time = 2
        this.smoothing = 1 - Math.exp(-1 / (0.015 * sampleRate))
        this.frameSmoothing = 1 - Math.exp(-this.hop / (0.025 * sampleRate))
        this.reset()
    }
    paramChanged(name, value) {
        if (!Number.isFinite(value)) return
        if (name === 'dry') this.dry = Math.max(0, Math.min(1, value))
        if (name === 'wet') this.wet = Math.max(0, Math.min(1, value))
        if (name === 'feedback') this.feedback = Math.max(0, Math.min(0.8, value))
        if (name === 'sync') this.sync = !!value
        if (name === 'time') this.time = Math.max(0.125, Math.min(4, value))
        if (name === 'output') this.output = Math.pow(10, Math.max(-18, Math.min(6, value)) / 20)
    }
    dataChanged(name) {
        if (name !== 'paint') return
        const values = this.data.paint
        for (let row = 0; row < 32; row++) {
            const start = row * 32
            let count = 0
            for (let column = 0; column < 32; column++) {
                const k = start + column
                this.target[k] = Number.isFinite(values[k]) ? Math.max(0, Math.min(1, values[k])) : 0
                // Keep erased taps until their smoothing tail has finished.
                if (this.target[k] > 0 || this.paint[k] > 0) this.tapColumns[start + count++] = column
            }
            this.tapCounts[row] = count
        }
    }
    fft(real, imag, inverse) {
        const n = this.n
        for (let j = 0; j < n; j++) {
            const k = this.reverse[j]
            if (k > j) {
                let swap = real[j]; real[j] = real[k]; real[k] = swap
                swap = imag[j]; imag[j] = imag[k]; imag[k] = swap
            }
        }
        for (let width = 2; width <= n; width *= 2) {
            const half = width / 2, stride = n / width
            for (let base = 0; base < n; base += width) {
                for (let j = 0; j < half; j++) {
                    const k = j * stride, c = this.cosines[k], s = inverse ? this.sines[k] : -this.sines[k]
                    const a = base + j, b = a + half
                    const tr = c * real[b] - s * imag[b], ti = s * real[b] + c * imag[b]
                    real[b] = real[a] - tr; imag[b] = imag[a] - ti
                    real[a] += tr; imag[a] += ti
                }
            }
        }
        if (inverse) for (let j = 0; j < n; j++) { real[j] /= n; imag[j] /= n }
    }
    frame(span, bpm) {
        const n = this.n, bins = this.bins, capacity = this.capacity
        for (let j = 0; j < n; j++) {
            const k = (this.cursor + j) & 1023
            // Two real stereo channels fit in one complex FFT.
            this.realL[j] = this.inputL[k] * this.window[j]
            this.imagL[j] = this.inputR[k] * this.window[j]
        }
        this.fft(this.realL, this.imagL, false)
        let anyWet = false
        for (let row = 0; row < 32; row++) {
            let sum = 0, kept = 0
            const start = row * 32, count = this.tapCounts[row]
            for (let j = 0; j < count; j++) {
                const column = this.tapColumns[start + j], k = start + column
                this.paint[k] += this.frameSmoothing * (this.target[k] - this.paint[k])
                if (this.target[k] === 0 && this.paint[k] < 1e-7) this.paint[k] = 0
                if (this.paint[k] > 0) this.tapColumns[start + kept++] = column
                sum += this.paint[k]
            }
            this.tapCounts[row] = kept
            if (kept > 0 && this.bandCounts[row] > 0) anyWet = true
            this.normalization[row] = 1 / Math.max(1, sum)
            this.energyIn[row] = 0; this.energyOut[row] = 0
        }
        for (let column = 0; column < 32; column++) {
            this.tapFrames[column] = Math.max(1, Math.min(capacity - 2, Math.round(column / 31 * span * sampleRate / this.hop)))
            let frame = this.frameIndex - this.tapFrames[column]
            if (frame < 0) frame += capacity
            this.readBases[column] = frame * bins
        }
        const write = this.frameIndex * bins
        const feedback = this.feedbackNow
        const stream = this.streams && this.streams.activity
        const metering = stream && stream.active
        for (let k = 0; k < bins; k++) {
            const row = this.band[k], start = row * 32
            const mirror = (n - k) & 1023
            const inLR = (this.realL[k] + this.realL[mirror]) * 0.5
            const inLI = (this.imagL[k] - this.imagL[mirror]) * 0.5
            const inRR = (this.imagL[k] + this.imagL[mirror]) * 0.5
            const inRI = (this.realL[mirror] - this.realL[k]) * 0.5
            let lr = 0, li = 0, rr = 0, ri = 0
            const count = this.tapCounts[row]
            for (let j = 0; j < count; j++) {
                const column = this.tapColumns[start + j]
                const gain = this.paint[start + column]
                const read = this.readBases[column] + k
                lr += this.historyLR[read] * gain; li += this.historyLI[read] * gain
                rr += this.historyRR[read] * gain; ri += this.historyRI[read] * gain
            }
            const norm = this.normalization[row]
            lr *= norm; li *= norm; rr *= norm; ri *= norm
            const limit = n * 8
            const storeLR = Math.max(-limit, Math.min(limit, inLR + lr * feedback))
            const storeLI = Math.max(-limit, Math.min(limit, inLI + li * feedback))
            const storeRR = Math.max(-limit, Math.min(limit, inRR + rr * feedback))
            const storeRI = Math.max(-limit, Math.min(limit, inRI + ri * feedback))
            this.historyLR[write + k] = Math.abs(storeLR) < 1e-20 ? 0 : storeLR
            this.historyLI[write + k] = Math.abs(storeLI) < 1e-20 ? 0 : storeLI
            this.historyRR[write + k] = Math.abs(storeRR) < 1e-20 ? 0 : storeRR
            this.historyRI[write + k] = Math.abs(storeRI) < 1e-20 ? 0 : storeRI
            if (metering) {
                this.energyIn[row] += inLR * inLR + inLI * inLI + inRR * inRR + inRI * inRI
                this.energyOut[row] += lr * lr + li * li + rr * rr + ri * ri
            }
            // Pack L + iR for a single inverse FFT. Analysis arrays stay intact
            // until every conjugate pair has been recovered.
            this.realR[k] = lr - ri; this.imagR[k] = li + rr
            if (k > 0 && k < n / 2) {
                this.realR[n - k] = lr + ri; this.imagR[n - k] = rr - li
            }
        }
        if (anyWet) {
            this.fft(this.realR, this.imagR, true)
            for (let j = 0; j < n; j++) {
                const k = (this.cursor + j) & 1023
                // Four periodic sqrt-Hann windows sum to two after analysis/synthesis.
                this.overlapL[k] += this.realR[j] * this.window[j] * 0.5
                this.overlapR[k] += this.imagR[j] * this.window[j] * 0.5
            }
        }
        if (++this.frameIndex === capacity) this.frameIndex = 0
        if (metering) {
            for (let row = 0; row < 32; row++) {
                const count = Math.max(1, this.bandCounts[row])
                const input = Math.sqrt(this.energyIn[row] / (2 * count)) / n * 4
                const output = Math.sqrt(this.energyOut[row] / (2 * count)) / n * 4
                stream[row] = Math.min(1, Math.log(1 + input * 100) / Math.log(101))
                stream[32 + row] = Math.min(1, Math.log(1 + output * 100) / Math.log(101))
            }
            for (let row = 0; row < 32; row++) {
                if (this.bandCounts[row] > 0) continue
                const lower = this.meterLower[row], upper = this.meterUpper[row], blend = this.meterBlend[row]
                stream[row] = stream[lower] + (stream[upper] - stream[lower]) * blend
                stream[32 + row] = stream[32 + lower] + (stream[32 + upper] - stream[32 + lower]) * blend
            }
            stream[64] = bpm
        }
    }
    process(io, block) {
        const srcL = io.src[0], srcR = io.src[1], outL = io.out[0], outR = io.out[1]
        const bpm = Number.isFinite(block.bpm) ? Math.max(20, Math.min(400, block.bpm)) : 120
        const span = this.sync ? this.time * 60 / bpm : this.time, s = this.smoothing
        for (let i = block.s0; i < block.s1; i++) {
            const k = this.cursor
            const dryL = this.inputL[k], dryR = this.inputR[k]
            const wetL = this.overlapL[k], wetR = this.overlapR[k]
            this.overlapL[k] = 0; this.overlapR[k] = 0
            this.inputL[k] = Number.isFinite(srcL[i]) ? Math.max(-32, Math.min(32, srcL[i])) : 0
            this.inputR[k] = Number.isFinite(srcR[i]) ? Math.max(-32, Math.min(32, srcR[i])) : 0
            this.dryNow += s * (this.dry - this.dryNow); this.wetNow += s * (this.wet - this.wetNow)
            this.outputNow += s * (this.output - this.outputNow); this.feedbackNow += s * (this.feedback - this.feedbackNow)
            outL[i] = Math.max(-64, Math.min(64, (dryL * this.dryNow + wetL * this.wetNow) * this.outputNow))
            outR[i] = Math.max(-64, Math.min(64, (dryR * this.dryNow + wetR * this.wetNow) * this.outputNow))
            this.cursor = (k + 1) & 1023
            if (++this.untilFrame === this.hop) { this.untilFrame = 0; this.frame(span, bpm) }
        }
    }
    reset() {
        this.inputL.fill(0); this.inputR.fill(0); this.overlapL.fill(0); this.overlapR.fill(0)
        this.historyLR.fill(0); this.historyLI.fill(0); this.historyRR.fill(0); this.historyRI.fill(0)
        this.cursor = 0; this.untilFrame = 0; this.frameIndex = 0
        if (this.streams && this.streams.activity) this.streams.activity.fill(0)
    }
}

class PaintView {
    constructor(host) {
        this.host = host; this.values = host.data.paint.toArray(); this.mode = 'paint'; this.drag = null; this.last = null
        this.levels = new Float32Array(65)
        this.colors = { accent: '#f6b35a', input: '#8bcfe8', inputRgb: '139,207,232', accentRgb: '246,179,90', eraseRgb: '255,125,110', discardText: '#ffd9d9', discardBorder: '#992b35', discardBackground: '#701e29' }
        this.brushSize = 2; this.brushStrength = 0.8; this.shape = null; this.activePoint = -1
        this.brushHover = null; this.brushGhost = new Float32Array(1024)
        this.shapeResult = new Float32Array(1024); this.shapeCache = null
        this.pendingDraw = 0; this.lastMeterDraw = -Infinity; this.terminated = false
        const root = host.root
        root.style.cssText = 'width:calc(100% - 8px);height:calc(100% - 8px);padding:4px;border-radius:8px;display:grid;grid-template-columns:70px minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:5px;font:400 11px Rubik,sans-serif;'
        const side = document.createElement('div')
        side.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-height:0;font-size:9px;'
        const button = (text, hint, action, parent = side) => {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = text
            b.style.cssText = 'outline:none;font:inherit;padding:2px 4px;border:1px solid ' + host.color('displayGrid', 0.3) + ';border-radius:4px;background:transparent;color:' + host.color('displayStroke', 0.95) + ';cursor:pointer;'
            b.addEventListener('click', action); this.bindHint(b, hint); parent.appendChild(b); return b
        }
        const modes = document.createElement('div'); modes.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px;'
        side.appendChild(modes)
        this.paintButton = button('Paint', 'Drag to paint.', () => this.setMode('paint'), modes)
        this.eraseButton = button('Erase', 'Drag to erase.', () => this.setMode('erase'), modes)
        this.lineButton = button('Line', 'Connect points.', () => this.setMode('line'), modes)
        this.curveButton = button('Curve', 'Pass all points.', () => this.setMode('curve'), modes)
        const shapeActions = document.createElement('div'); shapeActions.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px;'
        side.appendChild(shapeActions)
        this.applyButton = button('Apply', 'Commit points.', () => this.applyShape(), shapeActions)
        this.discardButton = button('Discard', 'Discard points.', () => this.cancelShape(), shapeActions)
        this.discardButton.style.padding = '2px 1px'
        const valueButton = (label, name, property, min, max, step, pixels, format) => {
            const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:2px;min-width:0;'
            const text = document.createElement('span'); text.textContent = label
            text.style.cssText = 'flex:1;color:' + host.color('displayStroke', 0.95) + ';'
            row.appendChild(text); side.appendChild(row)
            const control = button(format(this[property]), 'Drag up/down.', () => {}, row)
            control.setAttribute('aria-label', name)
            control.style.cssText += 'width:30px;flex:none;padding:1px 2px;cursor:ns-resize;touch-action:none;user-select:none;font-variant-numeric:tabular-nums;color:' + this.colors.accent + ';'
            const update = value => {
                if (!Number.isFinite(value)) return
                this[property] = Math.max(min, Math.min(max, Math.round(value / step) * step))
                control.textContent = format(this[property])
                control.setAttribute('aria-description', control.textContent)
                if (this.canvas) this.queueDraw()
            }
            update(this[property])
            let drag = null
            control.addEventListener('pointerdown', e => {
                if (e.button !== 0 || drag) return
                e.preventDefault(); control.focus(); control.setPointerCapture(e.pointerId)
                drag = { pointer: e.pointerId, y: e.clientY, value: this[property] }
            })
            control.addEventListener('pointermove', e => {
                if (drag && e.pointerId === drag.pointer) update(drag.value + (drag.y - e.clientY) / pixels * step)
            })
            const end = e => {
                if (!drag || e.pointerId !== drag.pointer) return
                drag = null
                if (control.hasPointerCapture(e.pointerId)) control.releasePointerCapture(e.pointerId)
            }
            control.addEventListener('pointerup', end); control.addEventListener('pointercancel', end); control.addEventListener('lostpointercapture', end)
            control.addEventListener('keydown', e => {
                if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
                e.preventDefault()
                update(e.key === 'Home' ? min : e.key === 'End' ? max : this[property] + (e.key === 'ArrowUp' ? step : -step))
            })
        }
        valueButton('Width', 'Brush width', 'brushSize', 1, 6, 1, 12, value => String(value))
        valueButton('Strength', 'Paint strength', 'brushStrength', 0, 1, 0.01, 2, value => Math.round(value * 100) + '%')
        const patterns = document.createElement('select')
        patterns.style.cssText = 'outline:none;font:inherit;width:100%;min-width:0;color-scheme:dark;'
        patterns.setAttribute('aria-label', 'Replace whole canvas with pattern')
        for (const [label, mode] of [['Pattern…', -1], ['Fill ↗', 0], ['Fill ↘', 1], ['Scatter', 2], ['Wave', 4], ['Zigzag', 5], ['Spiral', 6], ['Arpeggio', 7], ['Rain', 8], ['Lattice', 9], ['Fan', 10], ['Bloom', 11]]) {
            const option = document.createElement('option'); option.textContent = label; option.value = String(mode); patterns.appendChild(option)
        }
        patterns.addEventListener('change', () => { const mode = Number(patterns.value); if (mode >= 0) this.preset(mode); patterns.selectedIndex = 0 })
        this.bindHint(patterns, 'Replace paint.'); side.appendChild(patterns)
        button('Clear', 'Erase all.', () => this.preset(3))
        this.hint = document.createElement('div'); this.hint.style.cssText = 'font:inherit;line-height:11px;color:' + host.color('displayStroke', 0.9) + ';min-height:0;overflow:auto;'
        this.hint.textContent = ''; side.appendChild(this.hint)
        side.style.overflowY = 'auto'
        this.canvas = document.createElement('canvas'); this.canvas.tabIndex = 0
        this.canvas.style.cssText = 'outline:none;display:block;width:100%;height:100%;min-height:0;border-radius:4px;touch-action:none;cursor:crosshair;'
        this.canvas.setAttribute('aria-label', 'Spectral delay paint plane: time increases right, frequency increases up')
        root.append(side, this.canvas)
        this.canvas.addEventListener('pointerdown', e => {
            if (e.button !== 0 || this.drag) return
            this.updateBrushHover(e)
            this.canvas.focus()
            this.canvas.setPointerCapture(e.pointerId); this.pointer = e.pointerId
            this.drag = host.gesture(); this.last = null
            if (this.mode === 'line' || this.mode === 'curve') {
                const point = this.point(e)
                if (!this.shape) this.shape = { points: [], erase: !!e.altKey }
                const hit = this.hitShapePoint(point)
                this.activePoint = hit < 0 ? this.shape.points.push(point) - 1 : hit
                this.updateShapeButtons()
                this.hint.textContent = 'Click points.\nEnter: apply.'
                this.queueDraw()
            } else this.stroke(e)
        })
        this.canvas.addEventListener('pointermove', e => {
            this.updateBrushHover(e)
            if (!this.drag || e.pointerId !== this.pointer) return
            if (this.shape) this.moveShape(this.point(e)); else this.stroke(e)
        })
        this.canvas.addEventListener('pointerup', e => {
            if (!this.drag || e.pointerId !== this.pointer) return
            if (this.shape) {
                if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) this.moveShape(this.point(e))
            }
            this.drag.end(); this.drag = null; this.last = null; this.queueDraw()
        })
        this.canvas.addEventListener('pointerenter', e => this.updateBrushHover(e))
        this.canvas.addEventListener('pointerleave', () => { this.brushHover = null; this.queueDraw() })
        const cancel = e => {
            if (this.drag && e.pointerId === this.pointer) this.cancelShape()
            if (e.type === 'pointercancel') { this.brushHover = null; this.queueDraw() }
        }
        this.canvas.addEventListener('pointercancel', cancel); this.canvas.addEventListener('lostpointercapture', cancel)
        this.canvas.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.preventDefault(); this.cancelShape() }
            else if (e.key === 'Enter' && this.shape) { e.preventDefault(); this.applyShape() }
            else if ((e.key === 'Delete' || e.key === 'Backspace') && this.shape && !this.drag) {
                e.preventDefault()
                this.shape.points.splice(this.activePoint < 0 ? this.shape.points.length - 1 : this.activePoint, 1)
                this.activePoint = this.shape.points.length - 1
                this.updateShapeButtons()
                this.queueDraw()
            }
        })
        this.sub = host.data.paint.subscribe(() => { this.values = host.data.paint.toArray(); this.queueDraw() })
        this.syncSub = host.params.sync.subscribe(() => this.queueDraw()); this.timeSub = host.params.time.subscribe(() => this.queueDraw())
        this.streamSub = host.streams.activity.subscribe(values => {
            this.levels.set(values)
            const now = typeof performance === 'undefined' ? 0 : performance.now()
            if (now - this.lastMeterDraw >= 1000 / 30) { this.lastMeterDraw = now; this.queueDraw() }
        })
        this.resize = new ResizeObserver(() => this.queueDraw()); this.resize.observe(this.canvas)
        this.setMode('paint'); this.draw()
    }
    bindHint(element, text) {
        const show = () => { if (this.hint) this.hint.textContent = text }
        element.addEventListener('pointerenter', show); element.addEventListener('focus', show)
    }
    setMode(mode) {
        this.cancelShape()
        this.mode = mode
        for (const [name, button] of [['paint', this.paintButton], ['erase', this.eraseButton], ['line', this.lineButton], ['curve', this.curveButton]]) {
            button.style.color = mode === name ? this.colors.accent : this.host.color('displayStroke', 0.95)
            button.setAttribute('aria-pressed', String(mode === name))
        }
        this.hint.textContent = mode === 'curve' || mode === 'line' ? 'Click points.\nEnter: apply.' : ''
    }
    plotBounds(w = this.canvas.clientWidth, h = this.canvas.clientHeight) {
        return { left: 30, top: 12, width: Math.max(1, w - 32), height: Math.max(1, h - 30) }
    }
    clipPlot(c, bounds) {
        c.save(); c.beginPath(); c.rect(bounds.left, bounds.top, bounds.width, bounds.height); c.clip()
    }
    point(e) {
        const r = this.canvas.getBoundingClientRect()
        const b = this.plotBounds(r.width, r.height)
        return { x: Math.max(0, Math.min(31, (e.clientX - r.left - b.left) / b.width * 32 - 0.5)), y: Math.max(0, Math.min(31, (1 - (e.clientY - r.top - b.top) / b.height) * 32 - 0.5)) }
    }
    updateBrushHover(e) {
        const rect = this.canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top
        const b = this.plotBounds(rect.width, rect.height)
        this.brushHover = x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height
            ? { ...this.point(e), erase: !!e.altKey } : null
        this.queueDraw()
    }
    stroke(e) {
        const p = this.point(e), previous = this.last || p
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(p.x - previous.x), Math.abs(p.y - previous.y))))
        const erase = this.mode === 'erase' || e.altKey
        // One gesture edit covers all touched row ranges; untouched cells are not sent.
        const working = Float32Array.from(this.values)
        for (let step = 0; step <= steps; step++) {
            const x = Math.round(previous.x + (p.x - previous.x) * step / steps)
            const y = Math.round(previous.y + (p.y - previous.y) * step / steps)
            this.stamp(working, x, y, erase)
        }
        this.drag.edit(() => this.writeRanges(working))
        this.last = p
        this.hint.textContent = ''
    }
    stamp(working, x, y, erase, previewErase = false) {
        const radius = Math.max(0, Math.min(5, this.brushSize - 1)), strength = this.brushStrength
        for (let row = Math.max(0, y - radius); row <= Math.min(31, y + radius); row++) {
            for (let column = Math.max(0, x - radius); column <= Math.min(31, x + radius); column++) {
                const distance = Math.sqrt((row - y) * (row - y) + (column - x) * (column - x))
                if (distance > radius + 0.25) continue
                const k = row * 32 + column
                working[k] = erase ? 0 : previewErase ? 1 : Math.max(working[k], strength * (1 - distance / (radius + 1)))
            }
        }
    }
    writeRanges(working) {
        for (let row = 0; row < 32; row++) {
            let first = 32, last = -1
            for (let column = 0; column < 32; column++) {
                const k = row * 32 + column
                if (working[k] !== this.values[k]) { first = Math.min(first, column); last = column }
            }
            if (last >= first) this.host.data.paint.set(working.subarray(row * 32 + first, row * 32 + last + 1), row * 32 + first)
        }
    }
    moveShape(point) {
        if (!this.shape || this.activePoint < 0) return
        this.shape.points[this.activePoint] = point
        this.queueDraw()
    }
    hitShapePoint(point) {
        const rect = this.canvas.getBoundingClientRect()
        const bounds = this.plotBounds(rect.width, rect.height)
        let result = -1, distance = 8 * 8
        for (let j = 0; j < this.shape.points.length; j++) {
            const p = this.shape.points[j]
            const dx = (p.x - point.x) * bounds.width / 32, dy = (p.y - point.y) * bounds.height / 32
            const d = dx * dx + dy * dy
            if (d <= distance) { distance = d; result = j }
        }
        return result
    }
    sampleShape(segment, t) {
        const points = this.shape.points, a = points[segment], b = points[segment + 1]
        if (t === 0) return { x: a.x, y: a.y }
        if (t === 1) return { x: b.x, y: b.y }
        if (this.mode === 'line') return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        // Interpolating Catmull-Rom spline: every segment starts/ends exactly
        // on its two points. Neighbours determine tangents, not off-curve handles.
        const before = points[Math.max(0, segment - 1)], after = points[Math.min(points.length - 1, segment + 2)]
        const t2 = t * t, t3 = t2 * t
        const h0 = 2 * t3 - 3 * t2 + 1, h1 = t3 - 2 * t2 + t
        const h2 = -2 * t3 + 3 * t2, h3 = t3 - t2
        return {
            x: Math.max(0, Math.min(31, h0 * a.x + h1 * (b.x - before.x) * 0.5 + h2 * b.x + h3 * (after.x - a.x) * 0.5)),
            y: Math.max(0, Math.min(31, h0 * a.y + h1 * (b.y - before.y) * 0.5 + h2 * b.y + h3 * (after.y - a.y) * 0.5))
        }
    }
    rasterizeShape(working) {
        const shape = this.shape
        if (shape.points.length === 1) {
            const point = shape.points[0]
            this.stamp(working, Math.round(point.x), Math.round(point.y), shape.erase)
        }
        for (let segment = 0; segment < shape.points.length - 1; segment++) {
            for (let step = 0; step <= 64; step++) {
                const point = this.sampleShape(segment, step / 64)
                this.stamp(working, Math.round(point.x), Math.round(point.y), shape.erase)
            }
        }
    }
    prepareShapePreview() {
        const shape = this.shape, cache = this.shapeCache, points = shape.points
        const unchanged = cache && cache.shape === shape && cache.mode === this.mode
            && cache.width === this.brushSize && cache.strength === this.brushStrength
            && cache.values === this.values && cache.erase === shape.erase
            && cache.points.length === points.length * 2
            && points.every((p, i) => p.x === cache.points[i * 2] && p.y === cache.points[i * 2 + 1])
        if (unchanged) return cache
        this.shapeResult.set(this.values); this.rasterizeShape(this.shapeResult)
        const coordinates = new Float64Array(points.length * 2)
        for (let i = 0; i < points.length; i++) { coordinates[i * 2] = points[i].x; coordinates[i * 2 + 1] = points[i].y }
        const path = new Float64Array(points.length ? (1 + (points.length - 1) * 64) * 2 : 0)
        if (points.length) { path[0] = points[0].x; path[1] = points[0].y }
        let next = 2
        for (let segment = 0; segment < points.length - 1; segment++) for (let step = 1; step <= 64; step++) {
            const p = this.sampleShape(segment, step / 64); path[next++] = p.x; path[next++] = p.y
        }
        this.shapeCache = { shape, mode: this.mode, width: this.brushSize, strength: this.brushStrength, values: this.values, erase: shape.erase, points: coordinates, path }
        return this.shapeCache
    }
    commitShape() {
        const working = Float32Array.from(this.values)
        this.rasterizeShape(working)
        this.host.edit(() => this.writeRanges(working))
    }
    applyShape() {
        if (!this.shape || this.shape.points.length < 2 || this.drag) return
        this.commitShape()
        this.shape = null; this.shapeCache = null; this.activePoint = -1; this.updateShapeButtons(); this.hint.textContent = ''; this.queueDraw()
    }
    updateShapeButtons() {
        const count = this.shape ? this.shape.points.length : 0, ready = count >= 2
        this.applyButton.disabled = !ready; this.discardButton.disabled = count === 0
        this.discardButton.style.color = count > 0 ? this.colors.discardText : this.host.color('displayStroke', 0.45)
        this.discardButton.style.borderColor = count > 0 ? this.colors.discardBorder : this.host.color('displayGrid', 0.3)
        this.discardButton.style.background = count > 0 ? this.colors.discardBackground : 'transparent'
        this.applyButton.style.color = ready ? this.colors.accent : this.host.color('displayStroke', 0.45)
        this.applyButton.style.borderColor = ready ? this.colors.accent : this.host.color('displayGrid', 0.3)
        this.applyButton.style.background = ready ? 'rgba(' + this.colors.accentRgb + ',0.12)' : 'transparent'
    }
    cancelShape() {
        if (this.drag) { this.drag.end(); this.drag = null }
        this.shape = null; this.shapeCache = null; this.last = null; this.activePoint = -1; this.updateShapeButtons(); this.hint.textContent = ''; this.queueDraw()
    }
    preset(mode) {
        this.cancelShape()
        const values = new Float32Array(1024)
        // Use exactly the same brush footprint and strength as hand-drawn strokes.
        const plot = (x, y) => this.stamp(values, Math.max(0, Math.min(31, Math.round(x))), Math.max(0, Math.min(31, Math.round(y))), false)
        const line = (x0, y0, x1, y1) => {
            const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2))
            for (let step = 0; step <= steps; step++) plot(x0 + (x1 - x0) * step / steps, y0 + (y1 - y0) * step / steps)
        }
        if (mode < 2) for (let row = 0; row < 32; row++) {
            const column = Math.round(3 + (mode === 0 ? row : 31 - row) * 25 / 31)
            plot(column, row)
        }
        if (mode === 2) for (let j = 0; j < 75; j++) plot(2 + Math.random() * 28, Math.random() * 31)
        if (mode === 4 || mode === 5) {
            let previous = null
            for (let step = 0; step <= 128; step++) {
                const t = step / 128
                const x = mode === 4 ? 15.5 + 12 * Math.sin(t * Math.PI * 4) : 3 + 25 * (1 - Math.abs(2 * ((t * 3) % 1) - 1))
                const y = t * 31
                if (previous) line(previous.x, previous.y, x, y)
                previous = { x, y }
            }
        }
        if (mode === 6) {
            let previous = null
            for (let step = 0; step <= 256; step++) {
                const t = step / 256, radius = 1 + t * 13.5, angle = t * Math.PI * 5
                const x = 15.5 + Math.cos(angle) * radius, y = 15.5 + Math.sin(angle) * radius
                if (previous) line(previous.x, previous.y, x, y)
                previous = { x, y }
            }
        }
        if (mode === 7) for (let j = 0; j < 8; j++) {
            const x = 2 + j * 3.8, y = 2 + j * 3.8
            line(x, y - 1, x, y + 1)
        }
        if (mode === 8) for (let j = 0; j < 24; j++) {
            const x = 2 + Math.floor(Math.random() * 8) * 3.8, y = 3 + Math.random() * 25
            line(x, y, x + 1.5, y - 2 - Math.random() * 3)
        }
        if (mode === 9) for (const x of [5, 15.5, 26]) for (const y of [5, 15.5, 26]) {
            line(x - 4.5, y, x, y + 4.5); line(x, y + 4.5, x + 4.5, y)
            line(x + 4.5, y, x, y - 4.5); line(x, y - 4.5, x - 4.5, y)
        }
        if (mode === 10) for (const y of [2, 7.5, 13, 18.5, 24, 29.5]) line(2, 15.5, 29, y)
        if (mode === 11) for (const radius of [4.5, 9, 13.5]) {
            let previous = null
            for (let step = 0; step <= 128; step++) {
                const angle = step / 128 * Math.PI * 2, x = 15.5 + Math.cos(angle) * radius, y = 15.5 + Math.sin(angle) * radius
                if (previous) line(previous.x, previous.y, x, y)
                previous = { x, y }
            }
        }
        this.host.edit(() => this.host.data.paint.set(values))
        this.hint.textContent = ''
    }
    queueDraw() {
        if (this.terminated || this.pendingDraw) return
        if (typeof requestAnimationFrame !== 'function') { this.draw(); return }
        this.pendingDraw = requestAnimationFrame(() => { this.pendingDraw = 0; if (!this.terminated) this.draw() })
    }
    drawSpectrum(c, bounds, offset, color) {
        const { left, top, width, height } = bounds
        // Share the paint's frequency axis; horizontal extent shows live band level.
        this.clipPlot(c, bounds)
        c.beginPath(); c.moveTo(left, top + height)
        for (let row = 0; row < 32; row++) {
            const level = this.levels[offset + row]
            const x = left + Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0)) * width
            c.lineTo(x, top + (31.5 - row) * height / 32)
        }
        c.lineTo(left, top); c.closePath()
        c.fillStyle = 'rgba(' + color + ',0.12)'; c.fill()
        c.strokeStyle = 'rgba(' + color + ',0.65)'; c.stroke(); c.restore()
    }
    drawGhost(c, bounds, values, erase) {
        const { left, top, width, height } = bounds, cw = width / 32, ch = height / 32
        const color = erase ? this.colors.eraseRgb : this.colors.accentRgb
        this.clipPlot(c, bounds)
        for (let k = 0; k < 1024; k++) {
            const value = values[k]
            if (value <= 0) continue
            c.fillStyle = 'rgba(' + color + ',' + (value * 0.55) + ')'
            c.fillRect(left + (k % 32) * cw, top + (31 - Math.floor(k / 32)) * ch, cw, ch)
        }
        c.restore()
    }
    drawPaint(c, bounds, values) {
        const { left, top, width, height } = bounds, cw = width / 32, ch = height / 32
        for (let row = 0; row < 32; row++) {
            const y = top + (31 - row) * ch
            for (let column = 0; column < 32; column++) {
                const value = values[row * 32 + column]
                if (value > 0) { c.fillStyle = this.host.color('displayStroke', 0.15 + value * 0.8); c.fillRect(left + column * cw, y, Math.max(1, cw - 0.5), Math.max(1, ch - 0.5)) }
            }
        }
    }
    drawShapeGuide(c, bounds) {
        const { left, top, width, height } = bounds, cw = width / 32, ch = height / 32
        const points = this.shape.points, path = this.prepareShapePreview().path
        const x = value => left + (value + 0.5) * cw, y = value => top + (31.5 - value) * ch
        this.clipPlot(c, bounds)
        c.strokeStyle = this.host.color('displayStroke', 1); c.setLineDash([3, 2])
        c.beginPath()
        if (path.length) c.moveTo(x(path[0]), y(path[1]))
        for (let i = 2; i < path.length; i += 2) c.lineTo(x(path[i]), y(path[i + 1]))
        c.stroke(); c.setLineDash([])
        c.fillStyle = this.shape.erase ? 'rgb(' + this.colors.eraseRgb + ')' : this.colors.accent
        for (const point of points) { c.beginPath(); c.arc(x(point.x), y(point.y), 3, 0, Math.PI * 2); c.fill() }
        c.restore()
    }
    draw() {
        const canvas = this.canvas, w = canvas.clientWidth, h = canvas.clientHeight
        if (w < 65 || h < 45) return
        const ratio = window.devicePixelRatio || 1
        const pixelWidth = Math.round(w * ratio), pixelHeight = Math.round(h * ratio)
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight
        const c = canvas.getContext('2d'); c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, w, h)
        c.lineWidth = 1; c.font = '400 9px Rubik,sans-serif'
        const bounds = this.plotBounds(w, h), { left, top, width, height } = bounds
        const cw = width / 32, ch = height / 32
        this.drawSpectrum(c, bounds, 0, this.colors.inputRgb)
        this.drawSpectrum(c, bounds, 32, this.colors.accentRgb)
        if (this.shape) {
            // Preview the complete result once, rather than adding a second layer
            // that changes brightness, gaps and overlaps compared with Apply.
            this.prepareShapePreview()
        }
        this.drawPaint(c, bounds, this.shape ? this.shapeResult : this.values)
        c.strokeStyle = this.host.color('displayGrid', 0.12)
        for (let column = 0; column <= 8; column++) { const x = left + width * column / 8; c.beginPath(); c.moveTo(x, top); c.lineTo(x, top + height); c.stroke() }
        c.fillStyle = this.host.color('displayStroke', 0.95)
        for (const frequency of [100, 1000, 10000]) {
            const y = top + height * (1 - Math.log(frequency / 60) / Math.log(16000 / 60))
            c.fillText(frequency >= 1000 ? frequency / 1000 + 'k' : String(frequency), 1, y + 3)
        }
        c.fillText('Hz', 1, 9)
        const span = this.host.params.time.value
        for (let j = 0; j <= 4; j++) {
            c.textAlign = j === 0 ? 'left' : j === 4 ? 'right' : 'center'
            c.fillText((span * j / 4).toFixed(span < 1 ? 2 : 1), left + width * j / 4, h - 5)
        }
        c.textAlign = 'left'; c.fillText(this.host.params.sync.value ? 'BEATS' : 'SECONDS', left + 4, 9)
        if (this.brushHover && (this.mode === 'paint' || this.mode === 'erase')) {
            const hover = this.brushHover, erase = this.mode === 'erase' || hover.erase
            const x = Math.round(hover.x), y = Math.round(hover.y)
            // Rasterize with the real brush so the preview matches its cells and falloff.
            this.brushGhost.fill(0); this.stamp(this.brushGhost, x, y, false, erase)
            const color = erase ? this.colors.eraseRgb : this.colors.accentRgb
            this.drawGhost(c, bounds, this.brushGhost, erase)
            this.clipPlot(c, bounds)
            c.strokeStyle = 'rgba(' + color + ',0.85)'
            c.strokeRect(left + x * cw + 0.5, top + (31 - y) * ch + 0.5, Math.max(0, cw - 1), Math.max(0, ch - 1))
            c.restore()
        }
        if (this.shape) {
            this.drawShapeGuide(c, bounds)
        }
    }
    terminate() {
        this.terminated = true
        if (this.pendingDraw && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.pendingDraw)
        if (this.drag) this.drag.end()
        this.resize.disconnect()
        for (const subscription of [this.sub, this.syncSub, this.timeSub, this.streamSub]) if (subscription && subscription.terminate) subscription.terminate()
    }
}
