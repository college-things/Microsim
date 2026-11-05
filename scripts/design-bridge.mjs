// Optional localhost service for installed compilers. No shell commands or flashing.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {runTool,toolStatus} from './toolchain.mjs';
import {LabviewSession} from './labview-session.mjs';
export async function buildDesign(request, run = runTool) {
  if (!["c", "vhdl-check", "vhdl-sim", "fpga"].includes(request.action) || typeof request.source !== "string" || request.source.length > 1000000) throw new Error("Invalid build request.");
  if (request.action !== "c" && (typeof request.top !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(request.top))) throw new Error("Use a VHDL entity name for Top.");
  if (request.action === "fpga" && (typeof request.constraints !== "string" || request.constraints.length > 100000)) throw new Error("Expected PCF constraints.");
  const dir = await mkdtemp(join(tmpdir(), "microsim-build-"));
  let log = "";
  const command = async (tool, args) => { const result = await run(tool, args, dir); log += `${tool} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}\n`; return result; };
  const files = [];
  const artifact = async (name, binary = false) => files.push({ name, encoding: binary ? "base64" : "text", contents: binary ? (await readFile(join(dir, name))).toString("base64") : await readFile(join(dir, name), "utf8") });
  try {
    if (request.action === "c") {
      await writeFile(join(dir, "main.c"), request.source);
      await command("sdcc", ["-mmcs51", "--out-fmt-ihx", "-o", "firmware.hex", "main.c"]);
      await artifact("firmware.hex");
    } else {
      await writeFile(join(dir, "design.vhd"), request.source);
      await command("ghdl", ["-a", "--std=08", "design.vhd"]);
      await command("ghdl", ["-e", "--std=08", request.top]);
      if (request.action === "vhdl-sim") {
        await command("ghdl", ["-r", "--std=08", request.top, "--stop-time=1us", "--stop-delta=10000", "--vcd=wave.vcd"]);
        await artifact("wave.vcd");
      }
      if (request.action === "fpga") {
        const synthesized = await command("ghdl", ["--synth", "--std=08", "--out=verilog", request.top]);
        await writeFile(join(dir, "design.v"), synthesized.stdout);
        await writeFile(join(dir, "pins.pcf"), request.constraints);
        await command("yosys", ["-p", `read_verilog design.v; synth_ice40 -top ${request.top} -json design.json`]);
        await command("nextpnr", ["--hx1k", "--package", "tq144", "--json", "design.json", "--pcf", "pins.pcf", "--asc", "design.asc"]);
        await command("icepack", ["design.asc", "design.bin"]);
        await artifact("design.json"); await artifact("design.asc"); await artifact("design.bin", true);
      }
    }
    return { log: log || "Build succeeded.", files };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function startBridge(port = 47832) {
  let catalog;
  const labview=new LabviewSession();
  const token = process.env.MICROSIM_BRIDGE_TOKEN || randomBytes(24).toString("hex");
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const auth = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401); res.end(JSON.stringify({ error: "Invalid bridge token." })); return; }
    if (req.method !== "POST" || !["/build", "/tools", "/labview/exchange", "/labview/close", "/database/open", "/database/search", "/database/part"].includes(req.url)) { res.writeHead(404); res.end("{}"); return; }
    if (busy) { res.writeHead(409); res.end(JSON.stringify({ error: "The design bridge is busy." })); return; }
    let body = "";
    try {
      req.setEncoding("utf8");
      for await (const chunk of req) { body += chunk; if (body.length > 2000000) throw new Error("Build request too large."); }
      // Check again after reading: two requests may have arrived together.
      if (busy) throw new Error("The design bridge is busy.");
      busy = true;
      try {
        const request = JSON.parse(body);
        let result;
        if (req.url === "/build") result = await buildDesign(request);
        else if(req.url==='/tools') result=await toolStatus();
        else if(req.url==='/labview/exchange') result=await labview.exchange(request);
        else if(req.url==='/labview/close'){labview.close();result={closed:true};}
        else if (req.url === "/database/open") {
          const { openNiDatabase } = await import("./ni-database.mjs");
          const next = await openNiDatabase(request.path);
          catalog = next; result = catalog.summary();
        } else {
          if (!catalog) throw new Error("Open an NI component database first.");
          result = req.url === "/database/search" ? catalog.search(request.query, request.offset, request.limit) : catalog.part(request.id, request.model);
        }
        res.end(JSON.stringify(result));
      }
      finally { busy = false; }
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
  });
  let busy = false;
  server.on('close',()=>labview.close());
  server.listen(port, "127.0.0.1", () => console.log(`Microsim design bridge: http://127.0.0.1:${server.address().port}\nToken: ${token}\nPaste this token in Design > Component database, C compiler or VHDL / FPGA.\nRequires SDCC, GHDL, Yosys, nextpnr-ice40 and icepack for the respective builds.`));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startBridge(Number(process.env.MICROSIM_BRIDGE_PORT) || 47832);
