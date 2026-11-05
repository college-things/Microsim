// Runs the engine off the UI thread so the app stays responsive during long simulations.
// One script serves both one-shot jobs and continuous runs, so the engine ships only once.
import type { AnalysisRequest, LiveSession } from "../core/sim";
import { SimError } from "../core/sim";
import { createLiveSession, simulate } from "../engine/index";

export interface WorkerJob {
  id: number;
  netlist: string;
  request: AnalysisRequest;
}

export interface LiveStart {
  type: "start";
  netlist: string;
  /** Vector names to send, lower case. Others are simulated but not transferred. */
  keep: string[];
  /** Simulated seconds per real second. Absent runs as fast as the machine can. */
  rate?: number;
  /** Stop here, in simulated seconds. Absent runs until stopped. */
  stopAt?: number;
}

export type LiveCommand =
  | LiveStart
  | { type: "ack" }
  /** Simulated seconds per real second. Absent runs as fast as the machine can. */
  | { type: "rate"; rate?: number }
  /** Stop here instead, in simulated seconds. Absent runs until stopped. */
  | { type: "stopAt"; stopAt?: number }
  /** Applies changed values to the running circuit, keeping its state. */
  | { type: "update"; id: number; netlist: string }
  /** Bytes typed into a serial input (a d_uart_tx instance), sent from the current simulated time. */
  | { type: "send"; device: string; bytes: number[] };

function runJob({ id, netlist, request }: WorkerJob): void {
  try {
    let last = 0;
    const result = simulate(netlist, request, {
      onProgress: (fraction: number) => {
        const now = performance.now();
        if (now - last > 100) {
          last = now;
          self.postMessage({ id, progress: fraction });
        }
      },
    });
    const buffers: ArrayBuffer[] = [];
    for (const v of [...result.vectors, ...(result.axis ? [result.axis] : [])]) {
      buffers.push(v.re.buffer as ArrayBuffer);
      if (v.im) buffers.push(v.im.buffer as ArrayBuffer);
    }
    (self as unknown as Worker).postMessage({ id, result }, buffers);
  } catch (error) {
    const sim = error instanceof SimError ? error : undefined;
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
      code: sim?.code,
      line: sim?.line,
    });
  }
}

// Continuous run, paced against real time. Each chunk waits for an acknowledgement that the
// page received the last one, so messages can't pile up faster than the page takes them.
let session: LiveSession | undefined;
let indices: number[] = [];
let rate: number | undefined;
let stopAt: number | undefined;
let paceFromWall = 0;
let paceFromSim = 0;

function setPace(next: number | undefined): void {
  rate = next;
  paceFromWall = performance.now();
  paceFromSim = session?.time ?? 0;
}

function liveFailed(error: unknown): void {
  session = undefined;
  self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

function step(): void {
  const live = session;
  if (!live) return;
  try {
    // A stop time moved to before where the run has got to ends it there, with nothing more to show.
    if (stopAt !== undefined && live.time >= stopAt * (1 - 1e-12)) {
      const nothing = () => new Float64Array(0);
      self.postMessage({ type: "chunk", time: nothing(), values: indices.map(nothing), simTime: live.time, finished: true });
      session = undefined;
      return;
    }
    let target: number;
    if (rate === undefined) {
      // Unpaced: a generous horizon, with the time budget deciding how far it really gets.
      target = live.time + 1;
    } else {
      target = paceFromSim + (rate * (performance.now() - paceFromWall)) / 1000;
      if (target <= live.time) {
        setTimeout(step, 8);
        return;
      }
    }
    if (stopAt !== undefined) target = Math.min(stopAt, target);
    const chunk = live.advance(target, 30);
    // A circuit too slow for the requested pace simply runs at its own speed, without a backlog.
    if (rate !== undefined && live.time < target - rate * 0.25) setPace(rate);
    const finished = stopAt !== undefined && live.time >= stopAt * (1 - 1e-12);
    // The integrator can step past a stop time, but what's shown shouldn't.
    if (finished) {
      let keep = chunk.time.length;
      while (keep > 0 && chunk.time[keep - 1] > stopAt!) keep--;
      chunk.time = chunk.time.slice(0, keep);
      chunk.values = chunk.values.map((column) => column.slice(0, keep));
    }
    const values = indices.map((i) => chunk.values[i]);
    const buffers = [chunk.time.buffer as ArrayBuffer, ...values.map((v) => v.buffer as ArrayBuffer)];
    const simTime = finished ? stopAt! : live.time;
    (self as unknown as Worker).postMessage({ type: "chunk", time: chunk.time, values, simTime, finished }, buffers);
    if (finished) session = undefined;
  } catch (error) {
    liveFailed(error);
  }
}

function runLive(message: LiveCommand): void {
  if (message.type === "start") {
    try {
      const started = createLiveSession(message.netlist);
      session = started;
      const lower = started.names.map((n) => n.toLowerCase());
      const kept = message.keep.filter((name) => lower.includes(name));
      indices = kept.map((name) => lower.indexOf(name));
      stopAt = message.stopAt;
      setPace(message.rate);
      self.postMessage({ type: "ready", names: kept, warnings: started.warnings });
      step();
    } catch (error) {
      liveFailed(error);
    }
  } else if (message.type === "rate") {
    setPace(message.rate);
  } else if (message.type === "stopAt") {
    // The next step, never more than a chunk away, acts on it.
    stopAt = message.stopAt;
  } else if (message.type === "update") {
    let applied = false;
    try {
      applied = session?.update(message.netlist) ?? false;
    } catch {
      // The caller falls back to a restart, which reports any real problem with the circuit.
    }
    self.postMessage({ type: "updated", id: message.id, applied });
  } else if (message.type === "send") {
    session?.send(message.device, message.bytes);
  } else {
    step();
  }
}

self.onmessage = (event: MessageEvent<WorkerJob | LiveCommand>) => {
  const message = event.data;
  if ("type" in message) runLive(message);
  else runJob(message);
};
