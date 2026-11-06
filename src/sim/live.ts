// Holds the latest samples of a continuous run in a fixed amount of memory.
import type { McuState, SimResult } from "../core/sim";
import type { LiveCommand } from "./worker";
import { NO_WORKER, spawnWorker } from "./spawn";

/** Keeps the newest samples. When full it discards the older half, so memory stays bounded. */
export class LiveBuffer {
  private time: Float64Array;
  private columns: Float64Array[];
  length = 0;

  constructor(readonly names: string[], readonly capacity = 300_000) {
    this.time = new Float64Array(capacity);
    this.columns = names.map(() => new Float64Array(capacity));
  }

  append(time: Float64Array, values: Float64Array[]): void {
    let start = 0;
    // A chunk larger than the buffer can only keep its own tail.
    if (time.length > this.capacity) {
      start = time.length - this.capacity;
      this.length = 0;
    }
    const count = time.length - start;
    if (this.length + count > this.capacity) {
      const keep = Math.max(0, Math.min(this.length, this.capacity - count, Math.floor(this.capacity / 2)));
      const from = this.length - keep;
      this.time.copyWithin(0, from, this.length);
      for (const column of this.columns) column.copyWithin(0, from, this.length);
      this.length = keep;
    }
    this.time.set(time.subarray(start), this.length);
    this.columns.forEach((column, i) => column.set(values[i].subarray(start), this.length));
    this.length += count;
  }

  /** The newest `span` seconds as a result the instruments can read. Valid until the next append. */
  snapshot(span: number): SimResult | undefined {
    if (!this.length) return undefined;
    const end = this.time[this.length - 1];
    let lo = 0, hi = this.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.time[mid] < end - span) lo = mid + 1; else hi = mid;
    }
    return {
      analysis: "tran",
      axis: { name: "time", unit: "s", re: this.time.subarray(lo, this.length) },
      vectors: this.names.map((name, i) => ({
        name, unit: name.startsWith("i(") ? "A" as const : "V" as const, re: this.columns[i].subarray(lo, this.length),
      })),
      warnings: [],
      stats: { unknowns: 0, iterations: 0, steps: this.length - lo, elapsedMs: 0 },
    };
  }
}

export interface LiveCallbacks {
  onReady(names: string[], warnings: string[]): void;
  /** `debug` carries the watched microcontroller's state, and which device has halted the run, if any. */
  onChunk(time: Float64Array, values: Float64Array[], simTime: number, debug?: { mcu?: McuState; halted?: string }): void;
  onFinished(): void;
  onError(message: string): void;
}

export class LiveRun {
  private worker: Worker;
  private stopped = false;
  private nextUpdate = 1;
  private updates = new Map<number, (applied: boolean) => void>();

  constructor(netlist: string, keep: string[], rate: number | undefined, stopAt: number | undefined, callbacks: LiveCallbacks) {
    this.worker = spawnWorker();
    const send = (message: LiveCommand) => this.worker.postMessage(message);
    this.worker.onmessage = (event) => {
      if (this.stopped) return;
      const data = event.data;
      if (data.type === "ready") {
        callbacks.onReady(data.names, data.warnings);
      } else if (data.type === "chunk") {
        callbacks.onChunk(data.time, data.values, data.simTime, { mcu: data.mcu, halted: data.halted });
        if (data.finished) {
          this.stop();
          callbacks.onFinished();
        } else {
          send({ type: "ack" });
        }
      } else if (data.type === "updated") {
        this.updates.get(data.id)?.(data.applied);
        this.updates.delete(data.id);
      } else if (data.type === "error") {
        this.stop();
        callbacks.onError(data.message);
      }
    };
    this.worker.onerror = (event) => {
      if (this.stopped) return;
      this.stop();
      callbacks.onError(event.message || NO_WORKER);
    };
    send({ type: "start", netlist, keep, rate, stopAt });
  }

  setRate(rate: number | undefined): void {
    if (!this.stopped) this.worker.postMessage({ type: "rate", rate } satisfies LiveCommand);
  }

  setStopAt(stopAt: number | undefined): void {
    if (!this.stopped) this.worker.postMessage({ type: "stopAt", stopAt } satisfies LiveCommand);
  }

  /** Debugger commands for a microcontroller; see the "debug" LiveCommand. */
  debug(command: { device: string; watch?: boolean; breakpoints?: number[]; step?: boolean; resume?: boolean; pause?: boolean }): void {
    if (!this.stopped) this.worker.postMessage({ type: "debug", ...command } satisfies LiveCommand);
  }

  /** Types bytes into a serial input of the running circuit. */
  send(device: string, bytes: number[]): void {
    if (!this.stopped) this.worker.postMessage({ type: "send", device, bytes } satisfies LiveCommand);
  }

  /** Applies changed values without losing state. Resolves false if it needs a restart instead. */
  update(netlist: string): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    const id = this.nextUpdate++;
    return new Promise((resolve) => {
      this.updates.set(id, resolve);
      this.worker.postMessage({ type: "update", id, netlist } satisfies LiveCommand);
    });
  }

  stop(): void {
    this.stopped = true;
    this.worker.terminate();
    for (const resolve of this.updates.values()) resolve(false);
    this.updates.clear();
  }
}
