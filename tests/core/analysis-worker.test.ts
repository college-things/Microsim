import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisPlan } from "../../src/core/analyses";
import { Doc } from "../../src/core/doc";
import { runPlannedSimulation, runSimulation, stopSimulation } from "../../src/sim/client";

const mock = vi.hoisted(() => ({ workers: [] as {
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  terminate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}[] }));
vi.mock("../../src/sim/spawn", () => ({
  NO_WORKER: "Worker unavailable.",
  spawnWorker: () => {
    const worker = { terminate: vi.fn(), postMessage: vi.fn() };
    mock.workers.push(worker);
    return worker;
  },
}));
afterEach(() => { stopSimulation(); mock.workers.length = 0; });
const plan: AnalysisPlan = { type: "batch", entries: [{ label: "bias", request: { type: "op" } }] };
const result = { analysis: "op", vectors: [], warnings: [], stats: { steps: 0, iterations: 0, unknowns: 0, elapsedMs: 0 } };

describe("analysis worker queue", () => {
  it("sends the saved plan and schematic, forwards progress and preserves result metadata", async () => {
    const schematic = new Doc().schematic;
    const progress = vi.fn();
    const pending = runPlannedSimulation("title", schematic, plan, progress);
    const worker = mock.workers[0];
    const job = worker.postMessage.mock.calls[0][0];
    expect(job.plan).toEqual(plan);
    expect(job.schematic).toBe(schematic);
    worker.onmessage!({ data: { id: job.id, progress: 0.4, completed: 2 } });
    expect(progress).toHaveBeenCalledWith(2, 0.4);
    const runs = [{ label: "bias", result, measurement: 5, settings: { R1: 1000 }, summary: ["Mean: 5"] }];
    worker.onmessage!({ data: { id: job.id, result: runs } });
    await expect(pending).resolves.toEqual(runs);
  });

  it("cancels a whole plan and queued analyses and starts a fresh worker on the next run", async () => {
    const pending = runPlannedSimulation("title", new Doc().schematic, plan);
    const queued = runSimulation("title", { type: "op" });
    const rejection = expect(pending).rejects.toThrow("Simulation stopped.");
    const queuedRejection = expect(queued).rejects.toThrow("Simulation stopped.");
    expect(mock.workers[0].postMessage).toHaveBeenCalledTimes(1);
    stopSimulation();
    await rejection; await queuedRejection;
    expect(mock.workers[0].terminate).toHaveBeenCalledTimes(1);
    const next = runSimulation("title", { type: "op" });
    const worker = mock.workers[1];
    const job = worker.postMessage.mock.calls[0][0];
    worker.onmessage!({ data: { id: job.id, result } });
    await expect(next).resolves.toEqual(result);
  });
});

describe("analysis worker entry point", () => {
  afterAll(() => vi.unstubAllGlobals());
  it("executes a mixed plan and transfers result buffers with metadata intact", async () => {
    const postMessage = vi.fn();
    const scope = { postMessage, onmessage: undefined as undefined | ((event: { data: unknown }) => void) };
    vi.stubGlobal("self", scope);
    await import("../../src/sim/worker");
    scope.onmessage!({ data: { id: 42, netlist: "divider\nV1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.end", request: { type: "op" }, plan: { type: "batch", entries: [
      { label: "bias", request: { type: "op" } },
      { label: "transfer", request: { type: "transfer", source: "V1", output: "v(out)" } },
    ] } } });
    await vi.waitFor(() => expect(postMessage.mock.calls.some(([data]) => data.result)).toBe(true));
    const [message, buffers] = postMessage.mock.calls.find(([data]) => data.result)!;
    expect(message.id).toBe(42);
    expect(message.result.map((r: { label: string }) => r.label)).toEqual(["bias", "transfer"]);
    expect(message.result[0].result.vectors.find((v: { name: string }) => v.name === "v(out)").re[0]).toBeCloseTo(5);
    expect(message.result[1].result.transfer.gain).toBeCloseTo(0.5);
    expect(buffers).toContain(message.result[0].result.vectors[0].re.buffer);
    expect(new Set(buffers).size).toBe(buffers.length);
    expect(postMessage.mock.calls.some(([data]) => data.completed === 2 && data.progress === 1)).toBe(true);
  });
});
