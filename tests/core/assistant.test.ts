// Drives the assistant loop against a scripted API, since live calls need a key and cost money.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Assistant, explainError, Stopped } from "../../src/agent/assistant";
import { runTool, summarize, TOOL_SPECS } from "../../src/agent/tools";
import { Doc } from "../../src/core/doc";
import { simulate } from "../../src/engine/index";

interface Scripted {
  stop_reason: string;
  content: unknown[];
}

const script: Scripted[] = [];
const requests: any[] = [];
const clientOptions: any[] = [];

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(options: unknown) {
      clientOptions.push(options);
    }
    beta = {
      messages: {
        stream: (params: any) => {
          requests.push(structuredClone(params));
          const reply = script.shift();
          if (!reply) throw new Error("Script ran out of replies.");
          const listeners: ((text: string) => void)[] = [];
          return {
            on(event: string, fn: (text: string) => void) {
              if (event === "text") listeners.push(fn);
              return this;
            },
            async finalMessage() {
              for (const block of reply.content as any[]) if (block.type === "text") listeners.forEach((fn) => fn(block.text));
              return reply;
            },
          };
        },
      },
    };
  },
}));

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const events = () => {
  const text: string[] = [];
  const tools: string[] = [];
  return { text, tools, onText: (t: string) => text.push(t), onTool: (t: string) => tools.push(t) };
};
const run = async (netlist: string, request: any) => simulate(netlist, request);

beforeEach(() => {
  script.length = 0;
  requests.length = 0;
});

describe("assistant loop", () => {
  it("builds and simulates a divider through tools, then reports", async () => {
    const doc = new Doc();
    script.push({
      stop_reason: "tool_use",
      content: [
        toolUse("a", "add_component", { kind: "vdc", x: 0, y: 0, params: { value: "10" } }),
        toolUse("b", "add_component", { kind: "resistor", x: 120, y: -30, params: { value: "1k" } }),
        toolUse("c", "add_component", { kind: "resistor", x: 280, y: -30, params: { value: "1k" } }),
        toolUse("d", "add_component", { kind: "ground", x: 0, y: 120 }),
      ],
    }, {
      stop_reason: "tool_use",
      content: [
        toolUse("e", "connect", { from_ref: "V1", from_pin: "p", to_ref: "R1", to_pin: "1" }),
        toolUse("f", "connect", { from_ref: "R1", from_pin: "2", to_ref: "R2", to_pin: "1" }),
        toolUse("g", "connect", { from_ref: "R2", from_pin: "2", to_ref: "GND1", to_pin: "g" }),
        toolUse("h", "connect", { from_ref: "V1", from_pin: "n", to_ref: "GND1", to_pin: "g" }),
        toolUse("i", "run_analysis", { type: "op" }),
      ],
    }, { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] });

    const log = events();
    await new Assistant(doc, run, () => "test-key").send("Build a divider", log);

    expect(doc.schematic.components).toHaveLength(4);
    expect(doc.schematic.wires.length).toBeGreaterThanOrEqual(4);
    expect(log.text.join("")).toContain("Done.");
    expect(log.tools).toContain("Ran op analysis");

    // Every tool_use gets a result in one following user message.
    const final = requests[2].messages;
    const results = final[final.length - 1].content;
    expect(results.map((r: any) => r.tool_use_id)).toEqual(["e", "f", "g", "h", "i"]);
    const op = JSON.parse(results[4].content);
    const values = op.vectors.filter((v: any) => v.name.startsWith("v(")).map((v: any) => v.value).sort((a: number, b: number) => a - b);
    expect(values).toEqual([5, 10]);
  });

  it("sends the expected model and request shape", async () => {
    script.push({ stop_reason: "end_turn", content: [{ type: "text", text: "Hi" }] });
    await new Assistant(new Doc(), run, () => "k").send("hello", events());
    const request = requests[0];
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.fallbacks).toBe("default");
    expect(request.betas).toContain("server-side-fallback-2026-07-01");
    expect(request.tools.every((t: any) => t.eager_input_streaming === true)).toBe(true);
    expect(request.thinking).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
  });

  it("returns tool failures to the model instead of crashing", async () => {
    script.push(
      { stop_reason: "tool_use", content: [toolUse("x", "set_parameter", { ref: "R9", param: "value", value: "1k" })] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "No such part." }] },
    );
    const log = events();
    await new Assistant(new Doc(), run, () => "k").send("change R9", log);
    const result = requests[1].messages.at(-1).content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("No component named R9");
  });

  it("rejects incomplete tool input without running the tool", async () => {
    const doc = new Doc();
    script.push(
      { stop_reason: "tool_use", content: [toolUse("x", "add_component", { kind: "resistor" })] },
      { stop_reason: "end_turn", content: [] },
    );
    await new Assistant(doc, run, () => "k").send("add", events());
    expect(doc.schematic.components).toHaveLength(0);
    const result = requests[1].messages.at(-1).content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Missing required input: x, y.");
  });

  it("keeps the conversation valid after a reply was cut off or refused", async () => {
    for (const stop_reason of ["max_tokens", "refusal"]) {
      const doc = new Doc();
      const assistant = new Assistant(doc, run, () => "k");
      script.push({ stop_reason, content: [toolUse("x", "add_component", { kind: "resistor", x: 0, y: 0 })] });
      const log = events();
      await assistant.send("add", log);
      expect(doc.schematic.components).toHaveLength(0);
      expect(log.text.join("")).not.toBe("");

      // The next message must not carry a tool_use with no matching result.
      script.push({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] });
      await assistant.send("again", events());
      const history = requests.at(-1).messages;
      const answered = new Set(history.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id));
      const asked = history.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
      for (const id of asked) expect(answered.has(id)).toBe(true);
    }
  });

  it("retries cleanly after a failed request, leaving no undo step", async () => {
    const doc = new Doc();
    const assistant = new Assistant(doc, run, () => "k");
    await expect(assistant.send("first", events())).rejects.toThrow(/ran out/);
    expect(doc.dirty).toBe(false);
    script.push({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] });
    await assistant.send("second", events());
    expect(requests.at(-1).messages).toEqual([{ role: "user", content: "second" }]);
  });

  it("refuses a second message while one is running", async () => {
    const assistant = new Assistant(new Doc(), run, () => "k");
    script.push({ stop_reason: "end_turn", content: [] });
    const first = assistant.send("one", events());
    await expect(assistant.send("two", events())).rejects.toThrow(/still working/);
    await first;
    script.push({ stop_reason: "end_turn", content: [] });
    await expect(assistant.send("three", events())).resolves.toBeUndefined();
  });

  it("stops between tool calls, leaving a simulation it didn't start alone", async () => {
    let cancelled = 0;
    const doc = new Doc();
    const assistant = new Assistant(doc, run, () => "k", () => { cancelled++; });
    script.push({
      stop_reason: "tool_use",
      content: [toolUse("a", "add_component", { kind: "resistor", x: 0, y: 0 }), toolUse("b", "add_component", { kind: "resistor", x: 200, y: 0 })],
    });
    const log = {
      ...events(),
      onTool() { assistant.stop(); },
    };
    await expect(assistant.send("add", log)).rejects.toBeInstanceOf(Stopped);
    expect(cancelled).toBe(0);
    expect(doc.schematic.components).toHaveLength(1);
    const results = (assistant as any).history.at(-1).content;
    expect(results.map((r: any) => r.tool_use_id)).toEqual(["a", "b"]);
    expect(results[1].is_error).toBe(true);
  });

  it("cancels a simulation that a tool started", async () => {
    let cancelled = 0;
    let startedSimulation = () => {};
    const simulating = new Promise<void>((resolve) => { startedSimulation = resolve; });
    let failSimulation = (_: Error) => {};
    const slow = () => {
      startedSimulation();
      return new Promise<never>((_, reject) => { failSimulation = reject; });
    };
    const assistant = new Assistant(new Doc(), slow, () => "k", () => { cancelled++; failSimulation(new Error("Simulation stopped.")); });
    script.push({ stop_reason: "tool_use", content: [toolUse("a", "run_analysis", { type: "op" })] });
    const log = events();
    const sending = assistant.send("simulate", log);
    await simulating;
    assistant.stop();
    await expect(sending).rejects.toBeInstanceOf(Stopped);
    expect(cancelled).toBe(1);
    expect(log.tools).toEqual(["Ran op analysis"]);
  });

  it("drops a run when a new chat starts", async () => {
    const doc = new Doc();
    let assistant = new Assistant(doc, run, () => "k");
    script.push({
      stop_reason: "tool_use",
      content: [toolUse("a", "add_component", { kind: "resistor", x: 0, y: 0 }), toolUse("b", "add_component", { kind: "resistor", x: 200, y: 0 })],
    }, { stop_reason: "end_turn", content: [{ type: "text", text: "from the old run" }] });
    const text: string[] = [];
    const tools: string[] = [];
    const log = {
      onText: (t: string) => text.push(t),
      onTool(t: string) { tools.push(t); assistant.reset(); },
    };
    // It ends quietly, having reported nothing more and made no further request or change.
    await expect(assistant.send("add", log)).resolves.toBeUndefined();
    expect(tools).toHaveLength(1);
    expect(text).toEqual([]);
    expect(doc.schematic.components).toHaveLength(1);
    expect(requests).toHaveLength(1);

    script.length = 0;
    script.push({ stop_reason: "end_turn", content: [{ type: "text", text: "fresh" }] });
    await assistant.send("next", events());
    expect(requests.at(-1).messages).toEqual([{ role: "user", content: "next" }]);
  });

  it("makes no request for a run stopped before it began", async () => {
    const assistant = new Assistant(new Doc(), run, () => "k");
    const sending = assistant.send("hello", events());
    assistant.stop();
    await expect(sending).rejects.toBeInstanceOf(Stopped);
    expect(requests).toHaveLength(0);
    expect((assistant as any).history).toEqual([]);
  });

  it("explains failures in plain words", () => {
    const api = (status: number | undefined, type: string, message: string) => Object.assign(new Error(`${status} {"type":"error"}`), {
      status, type, error: { type: "error", error: { type, message } },
    });
    expect(explainError(api(401, "authentication_error", "invalid x-api-key"))).toMatch(/API key.*Settings/);
    expect(explainError(api(403, "permission_error", "no"))).toMatch(/Settings/);
    expect(explainError(api(429, "rate_limit_error", "slow"))).toMatch(/rate limit/);
    expect(explainError(api(529, "overloaded_error", "busy"))).toMatch(/overloaded/);
    expect(explainError(api(500, "api_error", "oops"))).toMatch(/try again/i);
    // A failure partway through a reply has no status.
    expect(explainError(api(undefined, "overloaded_error", "busy"))).toMatch(/overloaded/);
    expect(explainError(api(400, "invalid_request_error", "Your credit balance is too low."))).toBe("Anthropic refused the request: Your credit balance is too low.");
    expect(explainError(new Error("Connection error."))).toMatch(/Couldn't reach Anthropic/);
    expect(explainError(new Error("Request timed out."))).toMatch(/Couldn't reach Anthropic/);
    expect(explainError(new Error("stream ended without producing a Message with role=assistant"))).toBe("The reply was cut off. Try again.");
    for (const status of [401, 403, 402, 413, 429, 529, 500, 400, 418]) {
      expect(explainError(api(status, "x", "y"))).not.toContain("{");
    }
  });

  it("does not use a credential from the environment", async () => {
    script.push({ stop_reason: "end_turn", content: [] });
    await new Assistant(new Doc(), run, () => "k").send("hi", events());
    expect(clientOptions.at(-1).apiKey).toBe("k");
    expect(clientOptions.at(-1).authToken).toBeNull();
  });

  it("makes a whole assistant turn one undo step", async () => {
    const doc = new Doc();
    script.push(
      { stop_reason: "tool_use", content: [toolUse("a", "add_component", { kind: "resistor", x: 0, y: 0 }), toolUse("b", "add_component", { kind: "resistor", x: 200, y: 0 })] },
      { stop_reason: "end_turn", content: [] },
    );
    await new Assistant(doc, run, () => "k").send("add two", events());
    expect(doc.schematic.components).toHaveLength(2);
    doc.undo();
    expect(doc.schematic.components).toHaveLength(0);
  });
});

describe("tools", () => {
  it("all have valid strict-style schemas", () => {
    for (const tool of TOOL_SPECS) {
      expect(tool.input_schema.additionalProperties).toBe(false);
      for (const key of tool.input_schema.required) expect(tool.input_schema.properties).toHaveProperty(key);
    }
  });

  it("validate analysis arguments", async () => {
    const doc = new Doc();
    await expect(runTool(doc, "run_analysis", { type: "tran" }, run)).rejects.toThrow(/tstop/);
    await expect(runTool(doc, "run_analysis", { type: "ac", fstart: 0, fstop: 1 }, run)).rejects.toThrow(/fstart/);
  });

  it("summarize AC with the -3 dB point", () => {
    const summary = summarize(simulate(
      "t\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.end",
      { type: "ac", sweep: "dec", points: 100, fstart: 1, fstop: 1e5 },
    )) as any;
    const out = summary.vectors.find((v: any) => v.name === "v(out)");
    expect(out.minus_3db_hz).toBeGreaterThan(150);
    expect(out.minus_3db_hz).toBeLessThan(170);
  });
});
