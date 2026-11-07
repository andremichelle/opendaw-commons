// @label Key Harmonizer
// @param steps 2 1 6 int
// @param below false

// Adds a second voice a number of scale steps away from every note, in the project key at the note's position.
// Steps 2 is a third, 4 a fifth, 6 a seventh. Notes outside the key keep their distance to the step below them.
class Processor {
    steps = 2
    below = false
    paramChanged(name, value) {
        if (name === "steps") this.steps = value
        if (name === "below") this.below = value === 1
    }
    harmonize(pitch, {root, steps}) {
        const offset = ((pitch - root) % 12 + 12) % 12
        let index = 0
        for (let i = 0; i < steps.length; i++) if (steps[i] <= offset) index = i
        const target = index + (this.below ? -this.steps : this.steps)
        const wrapped = ((target % steps.length) + steps.length) % steps.length
        const octave = Math.floor(target / steps.length)
        return pitch - offset + steps[wrapped] + octave * 12 + (offset - steps[index])
    }
    * process(block, events) {
        for (const event of events) {
            if (!event.gate) continue
            const pitch = this.harmonize(event.pitch, this.keyAt(event.position))
            if (pitch >= 0 && pitch <= 127) yield {...event, pitch, velocity: event.velocity * 0.8}
        }
    }
}
