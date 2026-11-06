// Original model of an HD44780-style character LCD, written from the controller's published command set.
// It is decoded from sampled pin voltages: each falling edge of E latches RS and the data lines.

export interface LcdSamples {
  time: ArrayLike<number>;
  rs: ArrayLike<number>;
  e: ArrayLike<number>;
  /** Read/write line, or undefined when it is tied low (write only). Reads are ignored. */
  rw?: ArrayLike<number>;
  /** D0 to D7; lines that aren't connected are undefined (4-bit wiring leaves D0-D3 open). */
  data: (ArrayLike<number> | undefined)[];
}

/** 16x2 by default. Rows start at DDRAM addresses 0x00 and 0x40, as on the controller. */
export class CharacterLcd {
  private ddram = new Uint8Array(128).fill(32);
  private address = 0;
  private increment = 1;
  private shiftOnWrite = false;
  private displayOn = false;
  private cursorOn = false;
  private shift = 0;
  private eightBit = true;
  private twoLines = true;
  /** In 4-bit mode, the high nibble waiting for its low half. */
  private pendingHigh: number | undefined;
  private previousE = 0;
  private lastTime = -Infinity;
  writes = 0;

  constructor(readonly columns = 16, readonly rows = 2, readonly threshold = 2.5) {}

  reset(): void {
    this.ddram.fill(32);
    this.address = 0;
    this.increment = 1;
    this.shiftOnWrite = false;
    this.displayOn = false;
    this.cursorOn = false;
    this.shift = 0;
    this.eightBit = true;
    this.twoLines = true;
    this.pendingHigh = undefined;
    this.previousE = 0;
    this.lastTime = -Infinity;
    this.writes = 0;
  }

  /** Feeds samples in time order; samples at or before the last one already seen are skipped. */
  feed(s: LcdSamples): void {
    const high = (v: ArrayLike<number> | undefined, i: number) => (v ? (v[i] >= this.threshold ? 1 : 0) : 0);
    for (let i = 0; i < s.time.length; i++) {
      if (s.time[i] <= this.lastTime) continue;
      this.lastTime = s.time[i];
      const e = high(s.e, i);
      // The controller latches on E's falling edge; the bus is read from the sample just before it.
      if (this.previousE && !e && !(s.rw && high(s.rw, Math.max(0, i - 1)))) {
        const j = Math.max(0, i - 1);
        let bus = 0;
        for (let bit = 0; bit < 8; bit++) bus |= high(s.data[bit], j) << bit;
        this.latch(high(s.rs, j) === 1, bus);
      }
      this.previousE = e;
    }
  }

  private latch(rs: boolean, bus: number): void {
    if (this.eightBit) { this.transfer(rs, bus); return; }
    const nibble = bus >> 4;
    if (this.pendingHigh === undefined) { this.pendingHigh = nibble; return; }
    const value = (this.pendingHigh << 4) | nibble;
    this.pendingHigh = undefined;
    this.transfer(rs, value);
  }

  private transfer(rs: boolean, value: number): void {
    this.writes++;
    if (rs) {
      this.ddram[this.address & 127] = value;
      this.move(this.increment);
      if (this.shiftOnWrite) this.shift += this.increment;
      return;
    }
    if (value & 0x80) { this.address = value & 0x7f; return; }
    if (value & 0x40) return; // character generator RAM address: custom characters aren't drawn
    if (value & 0x20) {
      this.eightBit = (value & 0x10) !== 0;
      this.twoLines = (value & 0x08) !== 0;
      this.pendingHigh = undefined;
      return;
    }
    if (value & 0x10) {
      const right = (value & 0x04) !== 0;
      if (value & 0x08) this.shift += right ? -1 : 1;
      else this.move(right ? 1 : -1);
      return;
    }
    if (value & 0x08) { this.displayOn = (value & 0x04) !== 0; this.cursorOn = (value & 0x02) !== 0; return; }
    if (value & 0x04) { this.increment = value & 0x02 ? 1 : -1; this.shiftOnWrite = (value & 0x01) !== 0; return; }
    if (value & 0x02) { this.address = 0; this.shift = 0; return; }
    if (value & 0x01) { this.ddram.fill(32); this.address = 0; this.shift = 0; this.increment = 1; }
  }

  /** Moves the address counter, wrapping within a line as the controller does in two-line mode. */
  private move(step: number): void {
    if (!this.twoLines) { this.address = (this.address + step + 80) % 80; return; }
    const base = this.address & 0x40, offset = (this.address & 0x3f) + step;
    // Each line holds 40 characters; running off the end of one continues on the other.
    if (offset >= 40) this.address = (base ^ 0x40) | 0;
    else if (offset < 0) this.address = (base ^ 0x40) | 39;
    else this.address = base | offset;
  }

  /** The visible text, one string per row, or blank rows while the display is off. */
  text(): string[] {
    const lines: string[] = [];
    for (let row = 0; row < this.rows; row++) {
      if (!this.displayOn) { lines.push(" ".repeat(this.columns)); continue; }
      const base = row === 0 ? 0 : row === 1 ? 0x40 : row === 2 ? 20 : 0x54;
      const length = this.twoLines ? 40 : 80;
      let line = "";
      for (let col = 0; col < this.columns; col++) {
        const offset = (((col + this.shift) % length) + length) % length;
        const code = this.ddram[(base + offset) & 127];
        line += code >= 32 && code < 127 ? String.fromCharCode(code) : code === 0xdf ? "°" : " ";
      }
      lines.push(line);
    }
    return lines;
  }

  get cursor(): { row: number; column: number } | undefined {
    if (!this.displayOn || !this.cursorOn) return undefined;
    return { row: this.address & 0x40 ? 1 : 0, column: (this.address & 0x3f) - this.shift };
  }
}
