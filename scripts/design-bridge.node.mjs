import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { buildDesign, startBridge } from "./design-bridge.mjs";
test("C build returns Intel HEX, uses fixed arguments, and cleans up", async () => {
  let directory;
  const result = await buildDesign({ action: "c", source: "void main(void){}" }, async (tool, args, cwd) => {
    directory = cwd;
    assert.equal(tool, "sdcc");
    assert.deepEqual(args, ["-mmcs51", "--out-fmt-ihx", "-o", "firmware.hex", "main.c"]);
    await writeFile(join(cwd, "firmware.hex"), ":00000001FF\n");
    return { stdout: "", stderr: "" };
  });
  assert.equal(result.files[0].contents, ":00000001FF\n");
  await assert.rejects(access(directory));
});
test("FPGA flow runs synthesis, placement and packing and returns a binary", async () => {
  const called = [];
  const result = await buildDesign({ action: "fpga", source: "entity top is end;", top: "top", constraints: "set_io led 99" }, async (tool, args, cwd) => {
    called.push([tool, args]);
    if (tool === "ghdl" && args.includes("--synth")) return { stdout: "module top(); endmodule", stderr: "" };
    if (tool === "yosys") await writeFile(join(cwd, "design.json"), "{}");
    if (tool === "nextpnr") await writeFile(join(cwd, "design.asc"), "design");
    if (tool === "icepack") await writeFile(join(cwd, "design.bin"), Buffer.from([0, 255, 128]));
    return { stdout: "", stderr: "" };
  });
  assert.deepEqual(called.map(([tool]) => tool), ["ghdl", "ghdl", "ghdl", "yosys", "nextpnr", "icepack"]);
  assert.equal(result.files[2].encoding, "base64");
  assert.deepEqual(Buffer.from(result.files[2].contents, "base64"), Buffer.from([0, 255, 128]));
});
test("bad top names never reach the tool runner; failures clean up", async () => {
  let called = false;
  await assert.rejects(buildDesign({ action: "fpga", source: "", top: "x; exec foo", constraints: "" }, async () => { called = true; }), /entity name/);
  assert.equal(called, false);
  let dir;
  await assert.rejects(buildDesign({ action: "vhdl-check", source: "bad", top: "top" }, async (_, __, cwd) => { dir = cwd; throw new Error("invalid VHDL"); }), /invalid VHDL/);
  await assert.rejects(access(dir));
});
test("local service requires a token and rejects unsupported requests", async () => {
  process.env.MICROSIM_BRIDGE_TOKEN = "test-key";
  const server = startBridge(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/build`;
  try {
    const denied = await fetch(url, { method: "POST", body: "{}" }); assert.equal(denied.status, 401);
    const rejected = await fetch(url, { method: "POST", headers: { Authorization: "Bearer test-key" }, body: JSON.stringify({ action: "shell", source: "" }) });
    assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /Invalid build request/);
  } finally { await new Promise((resolve) => server.close(resolve)); delete process.env.MICROSIM_BRIDGE_TOKEN; }
});
