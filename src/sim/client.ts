// Promise wrapper around the simulation worker. Jobs run one at a time, in order,
// because the worker is single-threaded. Stopping terminates it and fails every job.
import type { AnalysisRequest, SimResult } from "../core/sim";
import { SimError } from "../core/sim";

interface Job {
  netlist: string;
  request: AnalysisRequest;
  onProgress?: (fraction: number) => void;
  resolve: (result: SimResult) => void;
  reject: (reason: Error) => void;
}

let worker: Worker | undefined;
let nextId = 1;
let active: Job | undefined;
const queue: Job[] = [];

export function stopSimulation(): void {
  worker?.terminate();
  worker = undefined;
  const pending = [...(active ? [active] : []), ...queue];
  active = undefined;
  queue.length = 0;
  for (const job of pending) job.reject(new Error("Simulation stopped."));
}

function pump(): void {
  if (active) return;
  const job = queue.shift();
  if (!job) return;
  active = job;
  worker ??= new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const id = nextId++;
  const finish = (settle: () => void) => {
    active = undefined;
    settle();
    pump();
  };
  worker.onmessage = (event) => {
    const data = event.data;
    if (data.id !== id) return;
    if (data.progress !== undefined) {
      job.onProgress?.(data.progress);
    } else if (data.error) {
      finish(() => job.reject(data.code ? new SimError(data.error, data.code, data.line) : new Error(data.error)));
    } else {
      finish(() => job.resolve(data.result));
    }
  };
  worker.onerror = (event) => {
    // A crashed worker can't be trusted with the next job.
    worker?.terminate();
    worker = undefined;
    finish(() => job.reject(new Error(event.message || "The simulation stopped unexpectedly.")));
  };
  worker.postMessage({ id, netlist: job.netlist, request: job.request });
}

export function runSimulation(
  netlist: string,
  request: AnalysisRequest,
  onProgress?: (fraction: number) => void,
): Promise<SimResult> {
  return new Promise((resolve, reject) => {
    queue.push({ netlist, request, onProgress, resolve, reject });
    pump();
  });
}
