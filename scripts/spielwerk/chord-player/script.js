// @label Chord Player
// @no-pass
// @param bass false

// Every note plays the chord of the chord track at its position, rooted at or below the played key.
// Where no chord sits, the note passes unchanged.
class Processor {
    bass = false
    paramChanged(name, value) {
        if (name === "bass") this.bass = value === 1
    }
    * process(block, events) {
        for (const event of events) {
            if (!event.gate) continue
            const chord = this.chordAt(event.position)
            if (chord === null) {
                yield event
                continue
            }
            const base = event.pitch - ((event.pitch - chord.root) % 12 + 12) % 12
            if (this.bass && base >= 12) yield {...event, pitch: base - 12}
            for (const note of chord.notes) {
                const pitch = base + note
                if (pitch <= 127) yield {...event, pitch}
            }
        }
    }
}
