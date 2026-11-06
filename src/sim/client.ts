// Promise wrapper around the simulation worker. Jobs run one at a time, in order,
// because the worker is single-threaded. Stopping terminates it and fails every job.
import type { AnalysisPlan, SweepRun } from "../core/analyses";
import type { Schematic } from "../core/schematic";
import type { AnalysisRequest, SimResult } from "../core/sim";
import { SimError } from "../core/sim";
import { NO_WORKER, spawnWorker } from "./spawn";

interface Job {
  netlist: string;
  request: AnalysisRequest;
  onProgress?: (fraction: number) => void;
  plan?: AnalysisPlan;
  schematic?: Schematic;
  onRunProgress?: (completed: number, fraction: number) => void;
  resolve: (result: SimResult | SweepRun[]) => void;
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
  worker ??= spawnWorker();
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
      job.onRunProgress?.(data.completed ?? 0, data.progress);
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
    finish(() => job.reject(new Error(event.message || NO_WORKER)));
  };
  worker.postMessage({ id, netlist: job.netlist, request: job.request, plan: job.plan, schematic: job.schematic });
}

export function runSimulation(
  netlist: string,
  request: AnalysisRequest,
  onProgress?: (fraction: number) => void,
): Promise<SimResult> {
  return new Promise((resolve, reject) => {
    queue.push({ netlist, request, onProgress, resolve: value => resolve(value as SimResult), reject });
    pump();
  });
}

/** Runs multi-run orchestration and result processing in the same cancellable worker. */
export function runPlannedSimulation(
  netlist: string, schematic: Schematic, plan: AnalysisPlan,
  onRunProgress?: (completed: number, fraction: number) => void,
): Promise<SweepRun[]> {
  return new Promise((resolve, reject) => {
    queue.push({ netlist, schematic, plan, request: { type: "op" }, onRunProgress, resolve: value => resolve(value as SweepRun[]), reject });
    pump();
  });
}
