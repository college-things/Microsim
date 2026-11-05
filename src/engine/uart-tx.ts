import { DigitalDomain, L0, L1, type DigitalModel } from "./digital";

/**
 * A serial line that bytes are typed into during a live run. Idle high; each byte becomes a start bit, 8 data
 * bits LSB first, an optional parity bit and a stop bit. The digital queue holds one pending change per output,
 * so the model clocks itself one bit at a time through an internal net, as the 8051 core does.
 */
export class UartTx implements DigitalModel {
  readonly inputs: number[];
  /** Levels still to send, the current bit first. */
  private bits: number[] = [];
  private running = false;
  private domain: DigitalDomain | undefined;
  constructor(private readonly clock: number, private readonly echo: number, private readonly out: number, private readonly bitTime: number, private readonly parity: "none" | "even" | "odd") {
    this.inputs = [clock];
  }
  copyState(old: DigitalModel): void {
    const o = old as UartTx;
    this.bits = [...o.bits];
    this.running = o.running;
  }
  /** Levels not yet on the line, for tests and status. */
  get pending(): number {
    return this.bits.length;
  }
  /** Queue bytes; they go out back to back after anything already queued. */
  send(bytes: number[]): void {
    for (const byte of bytes) {
      const data = Array.from({ length: 8 }, (_, n) => (byte >>> n) & 1);
      const frame = [0, ...data];
      if (this.parity !== "none") {
        const ones = data.reduce((a, b) => a + b, 0);
        frame.push(this.parity === "even" ? ones & 1 : (ones & 1) ^ 1);
      }
      frame.push(1);
      this.bits.push(...frame);
    }
    this.kick();
  }
  private kick(): void {
    const d = this.domain;
    if (!d || this.running || !this.bits.length || d.initMode) return;
    this.running = true;
    d.schedule(this.echo, d.val(this.clock) === L1 ? L0 : L1, 0);
  }
  evaluate(d: DigitalDomain, trig: number): void {
    this.domain = d;
    if (d.initMode) {
      d.schedule(this.out, L1, 0);
      d.schedule(this.echo, L0, 0);
      return;
    }
    // Arming or resuming after a value change: carry on from wherever the queue is.
    if (trig !== this.clock) {
      if (!this.running) this.kick();
      return;
    }
    const bit = this.bits.shift();
    if (bit === undefined) {
      this.running = false;
      return;
    }
    d.schedule(this.out, bit ? L1 : L0, 0);
    d.schedule(this.echo, d.val(this.clock) === L1 ? L0 : L1, this.bitTime);
  }
}
