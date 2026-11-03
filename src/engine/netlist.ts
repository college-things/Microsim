// SPICE netlist front end: logical lines, scopes, parameters, models and elaboration of
// the (possibly nested) subcircuit hierarchy into a flat Circuit of device objects.

import { SimError } from "../core/sim";
import { Circuit, Device } from "./circuit";
import { buildXspice, emitRational, readPorts, type XHost, type XModel } from "./xspice";
import {
  Behavioral,
  Capacitor,
  CCCS,
  CCVS,
  CurrentSource,
  Inductor,
  MutualInductance,
  Resistor,
  SmoothSwitch,
  Switch,
  VCCS,
  VCVS,
  VoltageSource,
  type BAux,
  type BVar,
  type BranchResolver,
  type SwitchControl,
  type SourceSpec,
} from "./devices";
import { evalConst, ExprError, parseExpr, parseNumber, type Ast, type ExprResolver } from "./expr";
import { Bjt, Diode, Jfet, Mosfet, type BjtParams, type DiodeParams, type JfetParams, type MosParams } from "./semiconductors";
import { Am, Exp, Pulse, Pwl, Sffm, Sin, type Waveform } from "./waveforms";

interface Card {
  line: number;
  raw: string;
  toks: string[];
}

interface ParamDef {
  name: string;
  text: string;
  line: number;
}

interface FuncDef {
  args: string[];
  body: string;
  line: number;
}

interface ModelDef {
  name: string;
  type: string;
  line: number;
  raw: Map<string, string>;
}

class Scope {
  readonly cards: Card[] = [];
  readonly params: ParamDef[] = [];
  readonly models = new Map<string, ModelDef>();
  readonly subckts = new Map<string, Scope>();
  readonly funcs = new Map<string, FuncDef>();
  /** Port names, and default parameters, for a subcircuit scope. */
  ports: string[] = [];
  defaults: ParamDef[] = [];
  constructor(readonly name: string, readonly parent: Scope | null, readonly line: number) {}

  findSubckt(name: string): Scope | null {
    for (let s: Scope | null = this; s; s = s.parent) {
      const f = s.subckts.get(name);
      if (f) return f;
    }
    return null;
  }
}

export interface Deck {
  top: Scope;
  options: Map<string, string>;
  globals: Set<string>;
  warnings: string[];
  temp: number | null;
  /** Running totals for the elaboration limits. */
  instances: number;
  funcExpansions: number;
}

function perr(msg: string, line?: number): SimError {
  return new SimError(line ? `Line ${line}: ${msg}` : msg, "parse", line);
}

/** Split a card into tokens; {..}, <..> and '..' groups stay whole and normalise to {..}. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  const isSep = (c: string): boolean =>
    c === " " || c === "\t" || c === "\n" || c === "," || c === "(" || c === ")" || c === "=" || c === "{" || c === "'" || c === "[" || c === "]" || c === '"';
  while (i < n) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === ",") {
      i++;
    } else if (c === "(" || c === ")" || c === "=" || c === "[" || c === "]") {
      out.push(c);
      i++;
    } else if (c === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) throw new ExprError(`unbalanced quote in '${s}'`);
      out.push(s.slice(i, j + 1));
      i = j + 1;
    } else if (c === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
      if (depth !== 0) throw new ExprError(`unbalanced '{' in '${s}'`);
      out.push(s.slice(i, j));
      i = j;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw new ExprError(`unbalanced quote in '${s}'`);
      out.push(`{${s.slice(i + 1, j)}}`);
      i = j + 1;
    } else if (c === "<") {
      const j = s.indexOf(">", i + 1);
      if (j < 0) {
        // A comparison inside a behavioural expression, which reads the raw text instead.
        out.push("<");
        i++;
      } else {
        out.push(`{${s.slice(i + 1, j)}}`);
        i = j + 1;
      }
    } else {
      let j = i;
      while (j < n && !isSep(s[j]!)) j++;
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

const SUPPORTED_HEADS = ".rclviegfhksdqmjbx";

const SILENT_DIRECTIVES = new Set([
  ".op", ".dc", ".ac", ".tran", ".tf", ".noise", ".pz", ".disto", ".sens", ".four",
  ".print", ".plot", ".probe", ".save", ".meas", ".measure", ".width", ".title", ".backanno",
]);

/** Parse netlist text into a tree of scopes. Device cards stay unparsed until elaboration. */
export function parseDeck(text: string): Deck {
  const lines = text.split(/\r\n|\r|\n/);
  const logical: { line: number; raw: string }[] = [];
  // A double-quoted model string can span continuation lines, keeping its newlines and semicolons.
  let inString = false;
  for (let i = 1; i < lines.length; i++) {
    if (inString) {
      const text = lines[i]!.trimStart().replace(/^\+/, "");
      logical[logical.length - 1]!.raw += "\n" + text;
      if (countQuotes(text) % 2 === 1) inString = false;
      continue;
    }
    const stripped = stripComment(lines[i]!).trim();
    if (stripped === "") continue;
    if (countQuotes(stripped) % 2 === 1) inString = true;
    if (stripped[0] === "+") {
      const last = logical[logical.length - 1];
      if (!last) throw perr("Continuation line with nothing to continue", i + 1);
      last.raw += " " + stripped.slice(1);
    } else {
      logical.push({ line: i + 1, raw: stripped });
    }
  }

  const deck: Deck = { top: new Scope("", null, 0), options: new Map(), globals: new Set(), warnings: [], temp: null, instances: 0, funcExpansions: 0 };
  let scope = deck.top;
  let inControl = false;

  for (const { line, raw: rawCase } of logical) {
    const raw = rawCase.toLowerCase();
    if (inControl) {
      if (/^\.endc\b/.test(raw)) inControl = false;
      continue;
    }
    let toks: string[];
    try {
      toks = tokenize(raw);
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      // Syntax this engine does not read must not stop the rest of the circuit.
      if (SUPPORTED_HEADS.includes(raw[0]!)) throw perr(e.message, line);
      toks = raw.split(/\s+/);
    }
    if (toks.length === 0) continue;
    const head = toks[0]!;
    if (head[0] !== ".") {
      scope.cards.push({ line, raw, toks });
      continue;
    }
    if (head === ".end") break;
    switch (head) {
      case ".subckt": {
        if (toks.length < 2) throw perr(".subckt needs a name", line);
        const sub = new Scope(toks[1]!, scope, line);
        readSubcktHeader(sub, toks, line);
        if (scope.subckts.has(sub.name)) {
          deck.warnings.push(`Line ${line}: duplicate subcircuit '${sub.name}', the later definition is used`);
        }
        scope.subckts.set(sub.name, sub);
        scope = sub;
        break;
      }
      case ".ends": {
        if (!scope.parent) throw perr(".ends without matching .subckt", line);
        scope = scope.parent;
        break;
      }
      case ".model": {
        readModel(scope, toks, line, deck.warnings);
        break;
      }
      case ".param":
      case ".parameter":
      case ".parameters": {
        scope.params.push(...readParams(raw.slice(head.length), line));
        break;
      }
      case ".func": {
        const m = /^\.func\s+([a-z_][\w.$]*)\s*\(([^)]*)\)\s*=?\s*(.*)$/s.exec(raw);
        if (!m) throw perr(`Bad .func syntax: ${raw}`, line);
        const args = m[2]!.split(/[\s,]+/).filter((a) => a !== "");
        scope.funcs.set(m[1]!, { args, body: stripDelims(m[3]!.trim()), line });
        break;
      }
      case ".ic":
      case ".nodeset": {
        scope.cards.push({ line, raw, toks });
        break;
      }
      case ".options":
      case ".option":
      case ".opt": {
        for (let i = 1; i + 2 < toks.length; i++) {
          if (toks[i + 1] === "=") {
            deck.options.set(toks[i]!, toks[i + 2]!);
            i += 2;
          }
        }
        break;
      }
      case ".global": {
        for (let i = 1; i < toks.length; i++) deck.globals.add(toks[i]!);
        break;
      }
      case ".temp": {
        const t = parseNumber(toks[1] ?? "");
        if (t !== null) deck.temp = t;
        break;
      }
      case ".control": {
        inControl = true;
        deck.warnings.push(`Line ${line}: .control block ignored`);
        break;
      }
      default: {
        if (!SILENT_DIRECTIVES.has(head)) {
          deck.warnings.push(`Line ${line}: unsupported directive ignored: ${raw}`);
        }
      }
    }
  }
  if (scope !== deck.top) {
    throw perr(`.subckt '${scope.name}' has no matching .ends`, scope.line);
  }
  return deck;
}


function countQuotes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '"') n++;
  return n;
}

function stripComment(line: string): string {
  const t = line.trimStart();
  if (t[0] === "*") return "";
  let quoted = false;
  let dquoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !dquoted) quoted = !quoted;
    if (c === '"' && !quoted) dquoted = !dquoted;
    if (quoted || dquoted) continue;
    if (c === ";") return line.slice(0, i);
    if (c === "$" && i > 0 && (line[i - 1] === " " || line[i - 1] === "\t")) return line.slice(0, i);
  }
  return line;
}

function readSubcktHeader(sub: Scope, toks: string[], line: number): void {
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === "params:" || t === "param:") continue;
    if (t === "(" || t === ")") continue;
    if (toks[i + 1] === "=") {
      const v = toks[i + 2];
      if (v === undefined) throw perr(`Parameter '${t}' has no value`, line);
      sub.defaults.push({ name: t, text: v, line });
      i += 2;
    } else {
      sub.ports.push(t);
    }
  }
}

function readModel(scope: Scope, toks: string[], line: number, warnings: string[]): void {
  if (toks.length < 3) throw perr(".model needs a name and a type", line);
  const name = toks[1]!;
  const def: ModelDef = { name, type: toks[2]!, line, raw: new Map() };
  for (let i = 3; i < toks.length; i++) {
    if (toks[i + 1] === "=" && toks[i + 2] !== undefined) {
      if (toks[i + 2] === "[") {
        const end = toks.indexOf("]", i + 3);
        const stop = end < 0 ? toks.length : end;
        def.raw.set(toks[i]!, `[ ${toks.slice(i + 3, stop).join(" ")} ]`);
        i = stop;
      } else {
        def.raw.set(toks[i]!, toks[i + 2]!);
        i += 2;
      }
    }
  }
  if (scope.models.has(name)) {
    warnings.push(`Line ${line}: duplicate .model '${name}', the later definition is used`);
  }
  scope.models.set(name, def);
}

/** Split "a=1 b={a*2}" at each top-level "name =". */
function readParams(text: string, line: number): ParamDef[] {
  const out: ParamDef[] = [];
  let depth = 0;
  const marks: { nameStart: number; eq: number; name: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "{" || c === "(") depth++;
    else if (c === "}" || c === ")") depth--;
    else if (c === "=" && depth === 0) {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (prev === "<" || prev === ">" || prev === "!" || prev === "=" || next === "=") continue;
      // Walk back over the name by hand: a regex on the prefix would be quadratic on a long line.
      let end = i;
      while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
      let begin = end;
      while (begin > 0 && /[\w.$]/.test(text[begin - 1]!)) begin--;
      const name = text.slice(begin, end);
      if (!/^[a-z_]/.test(name)) throw perr(`Bad .param syntax near '${text.slice(Math.max(0, i - 20), i + 20)}'`, line);
      marks.push({ nameStart: begin, eq: i, name });
    }
  }
  if (marks.length === 0 && text.trim() !== "") throw perr(`Bad .param syntax: '${text.trim()}'`, line);
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const end = i + 1 < marks.length ? marks[i + 1]!.nameStart : text.length;
    const value = text.slice(m.eq + 1, end).trim();
    if (value === "") throw perr(`Parameter '${m.name}' has no value`, line);
    out.push({ name: m.name, text: stripDelims(value), line });
  }
  return out;
}

function stripDelims(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === "{" && b === "}") || (a === "'" && b === "'") || (a === "<" && b === ">")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

interface ParamEntry {
  text: string;
  env: Env;
  line: number;
  value?: number;
  busy?: boolean;
}

/** Tolerated vendor parameters that have no effect here and need no warning. */
const HARMLESS_PARAMS = new Set([
  "level", "mfg", "type", "vceo", "icrating", "iave", "ipk", "vpk", "ns",
]);

class Model {
  private readonly used = new Set<string>();
  private warned = false;
  data: unknown = null;
  readonly name: string;
  readonly type: string;
  readonly line: number;

  constructor(private readonly def: ModelDef, private readonly env: Env) {
    this.name = def.name;
    this.type = def.type;
    this.line = def.line;
  }

  has(key: string): boolean {
    return this.def.raw.has(key);
  }

  num(key: string, fallback: number): number {
    this.used.add(key);
    const raw = this.def.raw.get(key);
    if (raw === undefined) return fallback;
    return this.env.value(raw, this.line);
  }

  str(key: string, fallback: string): string {
    this.used.add(key);
    const raw = this.def.raw.get(key);
    if (raw === undefined) return fallback;
    return raw.length >= 2 && raw[0] === '"' ? raw.slice(1, -1) : raw;
  }

  arr(key: string): number[] {
    this.used.add(key);
    const raw = this.def.raw.get(key);
    if (raw === undefined) return [];
    return tokenize(raw).filter((t) => t !== "[" && t !== "]").map((t) => this.env.value(t, this.line));
  }

  markUsed(...keys: string[]): void {
    for (const k of keys) this.used.add(k);
  }

  /** Warn at most once per model about parameters the device never asked for. */
  finish(c: Circuit): void {
    if (this.warned) return;
    this.warned = true;
    const unknown: string[] = [];
    for (const key of this.def.raw.keys()) {
      if (!this.used.has(key) && !HARMLESS_PARAMS.has(key)) unknown.push(key);
    }
    if (unknown.length > 0) {
      c.warn(`Model '${this.name}': ignored unsupported parameters: ${unknown.join(", ")}`);
    }
  }
}

class Env {
  readonly params = new Map<string, ParamEntry>();
  private readonly modelCache = new Map<string, Model>();
  /** Subcircuits being expanded on the way to this environment. */
  callStack: Scope[] = [];

  constructor(
    readonly scope: Scope,
    readonly parent: Env | null,
    readonly prefix: string,
    readonly ports: Map<string, number>,
    readonly deck: Deck,
  ) {}

  /** Register parameters: defaults and overrides first, then the body's .param lines. */
  init(overrides: { name: string; text: string; env: Env; line: number }[]): void {
    for (const p of this.scope.defaults) this.params.set(p.name, { text: p.text, env: this, line: p.line });
    for (const o of overrides) this.params.set(o.name, { text: o.text, env: o.env, line: o.line });
    for (const p of this.scope.params) this.params.set(p.name, { text: p.text, env: this, line: p.line });
  }

  lookup(name: string, line: number): number | null {
    for (let e: Env | null = this; e; e = e.parent) {
      const p = e.params.get(name);
      if (p) return e.resolve(name, p, line);
    }
    return null;
  }

  private resolve(name: string, p: ParamEntry, line: number): number {
    if (p.value !== undefined) return p.value;
    if (p.busy) throw perr(`Parameter '${name}' depends on itself`, line);
    p.busy = true;
    p.value = p.env.evalText(p.text, p.line);
    p.busy = false;
    return p.value;
  }

  func(name: string): { def: FuncDef; env: Env } | null {
    for (let e: Env | null = this; e; e = e.parent) {
      const def = e.scope.funcs.get(name);
      if (def) return { def, env: e };
    }
    return null;
  }

  /** Add .func expansion to a resolver. Bodies see their arguments, then the caller's names. */
  withFuncs(base: ExprResolver, active: string[] = []): ExprResolver {
    const self: ExprResolver = {
      ident: base.ident,
      call: (name, args) => {
        const found = this.func(name);
        if (found) {
          const { def } = found;
          if (args.length !== def.args.length) throw new ExprError(`${name}() takes ${def.args.length} arguments`);
          if (active.includes(name)) throw new ExprError(`.func ${name}() calls itself`);
          if (++this.deck.funcExpansions > MAX_FUNC_EXPANSIONS) throw new ExprError(`.func expansion grew too large at ${name}()`);
          const inner = this.withFuncs(
            {
              ident: (n) => {
                const at = def.args.indexOf(n);
                return at >= 0 ? args[at]! : base.ident(n);
              },
              probe: base.probe,
              call: base.call,
            },
            [...active, name],
          );
          return parseExpr(def.body, inner);
        }
        return base.call ? base.call(name, args) : null;
      },
    };
    if (base.probe) self.probe = base.probe;
    return self;
  }

  evalText(text: string, line: number): number {
    const inner = stripDelims(text);
    try {
      const ast = parseExpr(inner, this.withFuncs({
        ident: (n): Ast | null => {
          const v = this.lookup(n, line);
          if (v !== null) return { k: "n", v };
          return n === "temp" ? { k: "n", v: this.deck.temp ?? 27 } : null;
        },
      }));
      const v = evalConst(ast);
      if (!Number.isFinite(v)) throw new ExprError(`expression '${inner}' is not finite`);
      return v;
    } catch (e) {
      if (e instanceof ExprError) throw perr(e.message, line);
      throw e;
    }
  }

  /** Numeric value of a token: number with suffix, {expr}, or bare expression. */
  value(tok: string, line: number): number {
    if (tok[0] !== "{") {
      const n = parseNumber(tok);
      if (n !== null) return n;
    }
    return this.evalText(tok, line);
  }

  model(name: string): Model | null {
    for (let e: Env | null = this; e; e = e.parent) {
      const cached = e.modelCache.get(name);
      if (cached) return cached;
      const def = e.scope.models.get(name);
      if (def) {
        const m = new Model(def, e);
        e.modelCache.set(name, m);
        return m;
      }
    }
    return null;
  }

  isGround(name: string): boolean {
    return name === "0" || name === "gnd" || name === "gnd!";
  }

  /** Node index without counting a device connection. */
  nodeRef(c: Circuit, name: string): number {
    const id = this.resolveNode(c, name);
    c.nodeLog.push(id);
    return id;
  }

  private resolveNode(c: Circuit, name: string): number {
    if (this.isGround(name)) return 0;
    const port = this.ports.get(name);
    if (port !== undefined) return port;
    if (this.deck.globals.has(name)) return c.node(name, true);
    return c.node(this.prefix + name, this.prefix === "");
  }

  /** Node index for a device terminal. */
  pin(c: Circuit, name: string): number {
    const id = this.nodeRef(c, name);
    c.pins[id]! += 1;
    return id;
  }

  /** Scope-chain environment for a subcircuit defined in def's parent. */
  definingEnv(def: Scope): Env | null {
    for (let e: Env | null = this; e; e = e.parent) {
      if (e.scope === def.parent) return e;
    }
    return null;
  }
}

/** Build a flat Circuit from a deck, ready for Circuit.build(). */
export function elaborate(deck: Deck): Circuit {
  const c = new Circuit();
  for (const w of deck.warnings) c.warn(w);
  const top = new Env(deck.top, null, "", new Map(), deck);
  top.init([]);
  applyOptions(c, deck, top);
  if (deck.temp !== null) c.temp = deck.temp;
  elaborateScope(c, top, 0);
  for (const job of c.deferred) job();
  addSenseSources(c);
  for (let i = 1; i < c.names.length; i++) {
    if (c.isNode[i] && c.pins[i] === 1 && !/#|(^|.)nc_/.test(c.names[i]!)) {
      c.warn(`Node '${c.names[i]}' has only one device connection`);
    }
  }
  return c;
}

/** Give devices named by i() a series sense source when they have no branch of their own. */
function addSenseSources(c: Circuit): void {
  for (const name of c.sensed) {
    const d = c.named.get(name);
    if (!d) continue;
    if (!d.retargetA(-1)) continue;
    const mid = c.internalNode(`${name}#sense`);
    d.retargetA(mid);
    const a = d.senseNode();
    const spec: SourceSpec = { dc: 0, hasDc: true, acMag: 0, acPhase: 0, wave: null };
    c.addDevice(new VoltageSource(`${name}#sense`, d.line, a, mid, spec));
  }
}

function applyOptions(c: Circuit, deck: Deck, env: Env): void {
  const read = (key: string, set: (v: number) => void): void => {
    const raw = deck.options.get(key);
    if (raw === undefined) return;
    const v = parseNumber(raw);
    if (v !== null) set(v);
    else {
      try {
        set(env.value(raw, 0));
      } catch {
        c.warn(`.options ${key}=${raw} could not be evaluated and was ignored`);
      }
    }
  };
  read("reltol", (v) => { if (v > 0) c.reltol = v; });
  read("abstol", (v) => { if (v > 0) c.abstol = v; });
  read("vntol", (v) => { if (v > 0) c.vntol = v; });
  read("gmin", (v) => { if (v >= 0) c.gmin = v; });
  read("itl1", (v) => { if (v >= 1) c.itl1 = Math.floor(v); });
  read("itl4", (v) => { if (v >= 1) c.itl4 = Math.floor(v); });
  read("temp", (v) => {
    c.temp = v;
    deck.temp = v;
  });
  read("tnom", (v) => { c.tnom = v; });
}

/** Bounds on elaboration, so that subcircuits calling subcircuits cannot run away. */
const MAX_DEVICES = 300_000;
const MAX_INSTANCES = 1_000_000;
const MAX_FUNC_EXPANSIONS = 200_000;

function elaborateScope(c: Circuit, env: Env, depth: number): void {
  if (depth > 64) throw perr(`Subcircuit nesting too deep at '${env.scope.name}'`, env.scope.line);
  for (const card of env.scope.cards) {
    elaborateCard(c, env, card, depth);
  }
}

function need(card: Card, count: number, what: string): void {
  if (card.toks.length < count) throw perr(`${what} '${card.toks[0]}' is missing fields: ${card.raw}`, card.line);
}

/** Separate positional tokens from name=value pairs, dropping parentheses. */
function splitArgs(toks: string[], start: number): { pos: string[]; named: Map<string, string> } {
  const pos: string[] = [];
  const named = new Map<string, string>();
  for (let i = start; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === "(" || t === ")" || t === "params:") continue;
    if (toks[i + 1] === "=" && toks[i + 2] !== undefined) {
      named.set(t, toks[i + 2]!);
      i += 2;
    } else if (t !== "=") {
      pos.push(t);
    }
  }
  return { pos, named };
}

function addDevice(c: Circuit, d: Device, line: number): void {
  if (c.named.has(d.name)) throw perr(`Duplicate device name '${d.name}'`, line);
  if (c.devices.length >= MAX_DEVICES) {
    throw new SimError(`The circuit expands to more than ${MAX_DEVICES} devices`, "unsupported", line);
  }
  c.addDevice(d);
}

function elaborateCard(c: Circuit, env: Env, card: Card, depth: number): void {
  const head = card.toks[0]!;
  if (head === ".ic" || head === ".nodeset") {
    readInitial(c, env, card, head === ".ic");
    return;
  }
  const name = env.prefix + head;
  const line = card.line;
  switch (head[0]) {
    case "r": return buildResistor(c, env, card, name);
    case "c": return buildCapacitor(c, env, card, name);
    case "l": return buildInductor(c, env, card, name);
    case "v":
    case "i": return buildSource(c, env, card, name);
    case "e":
    case "g": return buildVoltageControlled(c, env, card, name);
    case "f":
    case "h": return buildCurrentControlled(c, env, card, name);
    case "k": return buildMutual(c, env, card, name);
    case "s": return buildSwitch(c, env, card, name);
    case "d": return buildDiode(c, env, card, name);
    case "q": return buildBjt(c, env, card, name);
    case "m": return buildMos(c, env, card, name);
    case "j": return buildJfet(c, env, card, name);
    case "b": return buildBehavioral(c, env, card, name);
    case "x": return buildInstance(c, env, card, name, depth);
    case "w": return buildCurrentSwitch(c, env, card, name);
    case "z": return buildMesfet(c, env, card, name);
    case "t": return buildTransmissionLine(c, env, card, name, depth);
    case "a": return buildCodeModel(c, env, card, name, depth);
    default:
      c.warn(`Line ${line}: unsupported device ignored: ${card.raw}`);
  }
}

function readInitial(c: Circuit, env: Env, card: Card, isIc: boolean): void {
  const t = card.toks;
  const out = isIc ? c.ics : c.nodesets;
  for (let i = 1; i < t.length; i++) {
    if (t[i] === "v" && t[i + 1] === "(" && t[i + 3] === ")" && t[i + 4] === "=" && t[i + 5] !== undefined) {
      const node = env.nodeRef(c, t[i + 2]!);
      const value = env.value(t[i + 5]!, card.line);
      if (node !== 0) out.push({ node, value });
      i += 5;
    } else {
      throw perr(`Expected v(node)=value in: ${card.raw}`, card.line);
    }
  }
}

function buildResistor(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 4, "Resistor");
  const line = card.line;
  const a = env.pin(c, card.toks[1]!);
  const b = env.pin(c, card.toks[2]!);
  const { pos, named } = splitArgs(card.toks, 3);
  const tok = named.get("r") ?? named.get("value") ?? (pos.length > 1 && parseNumber(pos[0]!) === null ? pos[1] : pos[0]);
  if (tok === undefined) throw perr(`Resistor '${card.toks[0]}' has no value: ${card.raw}`, line);
  let r = env.value(tok, line);
  const mult = named.has("m") ? env.value(named.get("m")!, line) : 1;
  if (mult > 0) r /= mult;
  r *= resistorTempFactor(c, env, pos, named, line);
  const tempK = instanceTemp(c, env, named, line) + 273.15;
  if (Math.abs(r) < 1e-9) {
    c.warn(`Line ${line}: resistor '${name}' has near-zero value, using 1 nano-ohm`);
    r = r < 0 ? -1e-9 : 1e-9;
  }
  addDevice(c, new Resistor(name, line, a, b, r, tempK), line);
}

/** TEMP or DTEMP on an instance, else the circuit temperature, in Celsius. */
function instanceTemp(c: Circuit, env: Env, named: Map<string, string>, line: number): number {
  if (named.has("temp")) return env.value(named.get("temp")!, line);
  const base = c.temp;
  return named.has("dtemp") ? base + env.value(named.get("dtemp")!, line) : base;
}

/** R(T) / R(Tnom) = 1 + TC1 dT + TC2 dT^2, from instance values or a .model R card. */
function resistorTempFactor(c: Circuit, env: Env, pos: string[], named: Map<string, string>, line: number): number {
  let tc1 = 0;
  let tc2 = 0;
  let tnom = c.tnom;
  let modelNotUsed: string | undefined;
  for (const tok of pos) {
    if (parseNumber(tok) !== null) continue;
    const m = env.model(tok);
    if (m && (m.type === "r" || m.type === "res")) {
      tc1 = m.num("tc1", 0);
      tc2 = m.num("tc2", 0);
      tnom = m.num("tnom", tnom);
      m.finish(c);
      m.markUsed("rsh", "defw", "narrow", "tce", "cap", "kf", "af");
    } else modelNotUsed = tok;
  }
  void modelNotUsed;
  if (named.has("tc1")) tc1 = env.value(named.get("tc1")!, line);
  if (named.has("tc2")) tc2 = env.value(named.get("tc2")!, line);
  if (named.has("tc")) tc1 = env.value(named.get("tc")!, line);
  const dt = instanceTemp(c, env, named, line) - tnom;
  const factor = 1 + tc1 * dt + tc2 * dt * dt;
  return factor > 1e-6 ? factor : 1e-6;
}

function buildCapacitor(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 4, "Capacitor");
  const line = card.line;
  const a = env.pin(c, card.toks[1]!);
  const b = env.pin(c, card.toks[2]!);
  const { pos, named } = splitArgs(card.toks, 3);
  const tok = named.get("c") ?? named.get("value") ?? (pos.length > 1 && parseNumber(pos[0]!) === null ? pos[1] : pos[0]);
  if (tok === undefined) throw perr(`Capacitor '${card.toks[0]}' has no value: ${card.raw}`, line);
  let cap = env.value(tok, line);
  if (named.has("m")) cap *= env.value(named.get("m")!, line);
  const ic = named.has("ic") ? env.value(named.get("ic")!, line) : undefined;
  addDevice(c, new Capacitor(name, line, a, b, cap, ic), line);
}

function buildInductor(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 4, "Inductor");
  const line = card.line;
  const a = env.pin(c, card.toks[1]!);
  const b = env.pin(c, card.toks[2]!);
  const { pos, named } = splitArgs(card.toks, 3);
  const tok = named.get("l") ?? named.get("value") ?? (pos.length > 1 && parseNumber(pos[0]!) === null ? pos[1] : pos[0]);
  if (tok === undefined) throw perr(`Inductor '${card.toks[0]}' has no value: ${card.raw}`, line);
  let ind = env.value(tok, line);
  if (named.has("m")) ind /= env.value(named.get("m")!, line);
  const ic = named.has("ic") ? env.value(named.get("ic")!, line) : undefined;
  addDevice(c, new Inductor(name, line, a, b, ind, ic), line);
}

const WAVE_KEYWORDS = new Set(["pulse", "sin", "sine", "exp", "pwl", "sffm", "am"]);
const SOURCE_KEYWORDS = new Set(["dc", "ac", "pulse", "sin", "sine", "exp", "pwl", "sffm", "am", "trnoise", "trrandom", "distof1", "distof2", "noise"]);
/** Distortion specifications matter only to a .disto analysis, which this engine does not run. */
const SILENT_SOURCE_KEYWORDS = new Set(["distof1", "distof2"]);

function buildSource(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 3, "Source");
  const t = card.toks;
  const line = card.line;
  const a = env.pin(c, t[1]!);
  const b = env.pin(c, t[2]!);
  const spec: SourceSpec = { dc: 0, hasDc: false, acMag: 0, acPhase: 0, wave: null };
  const isNum = (s: string | undefined): s is string =>
    s !== undefined && s !== "(" && s !== ")" && s !== "=" && !SOURCE_KEYWORDS.has(s);

  let i = 3;
  while (i < t.length) {
    const tok = t[i]!;
    if (tok === "(" || tok === ")" || tok === "=") {
      i++;
    } else if (tok === "dc") {
      i++;
      if (t[i] === "=") i++;
      if (!isNum(t[i])) throw perr(`DC keyword without a value: ${card.raw}`, line);
      spec.dc = env.value(t[i]!, line);
      spec.hasDc = true;
      i++;
    } else if (tok === "ac") {
      i++;
      spec.acMag = 1;
      if (isNum(t[i])) {
        spec.acMag = env.value(t[i]!, line);
        i++;
        if (isNum(t[i])) {
          spec.acPhase = env.value(t[i]!, line);
          i++;
        }
      }
    } else if (WAVE_KEYWORDS.has(tok)) {
      i++;
      const args: string[] = [];
      const options = new Map<string, number>();
      const paren = t[i] === "(";
      if (paren) i++;
      while (i < t.length) {
        const a2 = t[i]!;
        if (paren ? a2 === ")" : SOURCE_KEYWORDS.has(a2)) break;
        if (t[i + 1] === "=" && t[i + 2] !== undefined) {
          if (tok === "pwl" && (a2 === "r" || a2 === "td")) {
            options.set(a2, env.value(t[i + 2]!, line));
          } else {
            c.warn(`Line ${line}: source option '${a2}' ignored in: ${card.raw}`);
          }
          i += 3;
          continue;
        }
        if (a2 !== "(" && a2 !== ")") args.push(a2);
        i++;
      }
      if (paren) i++;
      // PWL options may also follow the closing parenthesis.
      while (tok === "pwl" && (t[i] === "r" || t[i] === "td") && t[i + 1] === "=" && t[i + 2] !== undefined) {
        options.set(t[i]!, env.value(t[i + 2]!, line));
        i += 3;
      }
      spec.wave = buildWave(tok, args.map((v) => env.value(v, line)), card, options);
    } else if (SOURCE_KEYWORDS.has(tok)) {
      if (!SILENT_SOURCE_KEYWORDS.has(tok)) {
        c.warn(`Line ${line}: source function '${tok}' not supported, using the DC value: ${card.raw}`);
      }
      i++;
      if (t[i] === "(") {
        while (i < t.length && t[i] !== ")") i++;
        i++;
      } else {
        while (i < t.length && !SOURCE_KEYWORDS.has(t[i]!)) i++;
      }
    } else {
      spec.dc = env.value(tok, line);
      spec.hasDc = true;
      i++;
    }
  }
  const d = t[0]![0] === "v" ? new VoltageSource(name, line, a, b, spec) : new CurrentSource(name, line, a, b, spec);
  addDevice(c, d, line);
}

function buildWave(kind: string, v: number[], card: Card, options: Map<string, number>): Waveform {
  const line = card.line;
  const arg = (i: number, fallback: number): number => (i < v.length ? v[i]! : fallback);
  switch (kind) {
    case "pulse":
      if (v.length < 2) throw perr(`PULSE needs at least V1 and V2: ${card.raw}`, line);
      return new Pulse(v[0]!, v[1]!, arg(2, 0), arg(3, 0), arg(4, 0), arg(5, 0), arg(6, 0));
    case "sin":
    case "sine":
      if (v.length < 2) throw perr(`SIN needs at least VO and VA: ${card.raw}`, line);
      return new Sin(v[0]!, v[1]!, arg(2, 0), arg(3, 0), arg(4, 0), arg(5, 0));
    case "exp":
      if (v.length < 2) throw perr(`EXP needs at least V1 and V2: ${card.raw}`, line);
      return new Exp(v[0]!, v[1]!, arg(2, 0), arg(3, 0), arg(4, 0), arg(5, 0));
    case "sffm":
      if (v.length < 2) throw perr(`SFFM needs at least VO and VA: ${card.raw}`, line);
      return new Sffm(v[0]!, v[1]!, arg(2, 0), arg(3, 0), arg(4, 0));
    case "am":
      if (v.length < 2) throw perr(`AM needs at least the amplitude and offset: ${card.raw}`, line);
      return new Am(v[0]!, v[1]!, arg(2, 0), arg(3, 0), arg(4, 0));
    default: {
      if (v.length < 2 || v.length % 2 !== 0) throw perr(`PWL needs time/value pairs: ${card.raw}`, line);
      const n = v.length / 2;
      const times = new Float64Array(n);
      const values = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        times[i] = v[2 * i]!;
        values[i] = v[2 * i + 1]!;
        if (i > 0 && times[i]! < times[i - 1]!) throw perr(`PWL times must not decrease: ${card.raw}`, line);
      }
      return new Pwl(times, values, options.get("td") ?? 0, options.get("r") ?? -1);
    }
  }
}

function branchResolver(env: Env, ctrl: string, card: Card, circuit: Circuit): BranchResolver {
  const candidates = [env.prefix + ctrl, ctrl];
  for (const n of candidates) circuit.sensed.add(n);
  return (c) => {
    for (const n of candidates) {
      const d = c.named.get(n);
      if (d && d.branch > 0) return d.branch;
      const sense = c.named.get(`${n}#sense`);
      if (sense && sense.branch > 0) return sense.branch;
    }
    throw perr(`'${ctrl}' is not a voltage source or inductor, referenced by: ${card.raw}`, card.line);
  };
}

/** Text of the POLY polynomial over the controls, in SPICE coefficient order. */
function polyText(controls: string[], coef: number[]): string {
  const n = controls.length;
  if (coef.length === 1) coef = [0, coef[0]!];
  const terms: string[] = [];
  let at = 0;
  if (coef[at] !== undefined && coef[at] !== 0) terms.push(`${coef[at]}`);
  at++;
  const walk = (remain: number, from: number, picked: number[]): void => {
    if (at >= coef.length) return;
    if (remain === 0) {
      const k = coef[at];
      at++;
      if (k !== undefined && k !== 0) {
        terms.push(`${k}*${picked.map((i) => controls[i]).join("*")}`);
      }
      return;
    }
    for (let i = from; i < n; i++) walk(remain - 1, i, picked.concat(i));
  };
  for (let degree = 1; at < coef.length && degree < 16; degree++) walk(degree, 0, []);
  return terms.length > 0 ? terms.join("+") : "0";
}

function makeBehavioral(
  c: Circuit,
  env: Env,
  card: Card,
  name: string,
  a: number,
  b: number,
  isVoltage: boolean,
  text: string,
): void {
  const vars: BVar[] = [];
  const aux: BAux[] = [];
  const keys = new Map<string, number>();
  const varFor = (key: string, def: () => BVar): Ast => {
    let i = keys.get(key);
    if (i === undefined) {
      i = vars.length;
      keys.set(key, i);
      vars.push(def());
    }
    return { k: "v", i };
  };
  const nodeVar = (n: string): Ast => {
    const id = env.nodeRef(c, n);
    if (id === 0) return { k: "n", v: 0 };
    return varFor(`n${id}`, () => ({ kind: "node", id }));
  };
  let ast: Ast;
  try {
    ast = parseExpr(stripDelims(text), env.withFuncs({
      call: (fn, args): Ast | null => {
        if (fn === "ddt") {
          if (args.length !== 1) throw new ExprError("ddt() takes one argument");
          const gain = varFor("ag0", () => ({ kind: "ag0" }));
          const out = vars.length;
          vars.push({ kind: "aux" });
          aux.push({ kind: "ddt", arg: args[0]!, out, ic: 0 });
          return { k: "dv", i: out, arg: args[0]!, gain };
        }
        if (fn === "sdt" || fn === "idt") {
          if (args.length < 1 || args.length > 2) throw new ExprError(`${fn}() takes the integrand and an optional initial value`);
          const gain = varFor("inv", () => ({ kind: "invag0" }));
          const out = vars.length;
          vars.push({ kind: "aux" });
          const ic = args[1] ? evalConst(args[1]) : 0;
          aux.push({ kind: "sdt", arg: args[0]!, out, ic });
          return { k: "dv", i: out, arg: args[0]!, gain };
        }
        return null;
      },
      ident: (id): Ast | null => {
        if (id === "time") return varFor("time", () => ({ kind: "time" }));
        const v = env.lookup(id, card.line);
        if (v !== null) return { k: "n", v };
        return id === "temp" ? { k: "n", v: c.temp } : null;
      },
      probe: (fn, args): Ast => {
        if (fn === "v") {
          if (args.length === 1) return nodeVar(args[0]!);
          if (args.length === 2) return { k: "b", op: "-", a: nodeVar(args[0]!), b: nodeVar(args[1]!) };
          throw new ExprError(`v() takes one or two nodes`);
        }
        if (args.length !== 1) throw new ExprError(`i() takes one device name`);
        const ctrl = args[0]!;
        return varFor(`i${ctrl}`, () => ({ kind: "branch", resolve: branchResolver(env, ctrl, card, c) }));
      },
    }));
  } catch (e) {
    if (e instanceof ExprError) throw perr(e.message, card.line);
    throw e;
  }
  addDevice(c, new Behavioral(name, card.line, a, b, isVoltage, ast, vars, aux), card.line);
}

function buildBehavioral(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 4, "Behavioral source");
  const m = /^\S+\s+\S+\s+\S+\s+([vi])\s*=\s*(.*)$/.exec(card.raw);
  if (!m) throw perr(`Behavioral source needs V= or I=: ${card.raw}`, card.line);
  const a = env.pin(c, card.toks[1]!);
  const b = env.pin(c, card.toks[2]!);
  makeBehavioral(c, env, card, name, a, b, m[1] === "v", m[2]!);
}

function buildVoltageControlled(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 4, "Controlled source");
  const t = card.toks;
  const line = card.line;
  const isE = t[0]![0] === "e";
  const a = env.pin(c, t[1]!);
  const b = env.pin(c, t[2]!);
  const key = t[3]!;
  if (key === "value") {
    const m = /value\s*=?\s*(.*)$/.exec(card.raw);
    makeBehavioral(c, env, card, name, a, b, isE, m ? m[1]! : "");
    return;
  }
  if (key === "poly") {
    const { pos } = splitArgs(t, 4);
    const n = Math.floor(env.value(pos[0] ?? "", line));
    if (!(n >= 1) || pos.length < 1 + 2 * n) throw perr(`Bad POLY source: ${card.raw}`, line);
    const controls: string[] = [];
    for (let i = 0; i < n; i++) controls.push(`v(${pos[1 + 2 * i]},${pos[2 + 2 * i]})`);
    const coef = pos.slice(1 + 2 * n).map((v) => env.value(v, line));
    makeBehavioral(c, env, card, name, a, b, isE, polyText(controls, coef));
    return;
  }
  if (key === "table") {
    const m = /table\s*(\{[^}]*\}|\S+)\s*=?\s*(.*)$/s.exec(card.raw);
    const pairs = m ? m[2]!.split(/[\s,()]+/).filter((v) => v !== "") : [];
    if (!m || pairs.length < 2 || pairs.length % 2 !== 0) throw perr(`Bad TABLE source: ${card.raw}`, line);
    const values = pairs.map((v) => env.value(v, line));
    makeBehavioral(c, env, card, name, a, b, isE, `table(${stripDelims(m[1]!)},${values.join(",")})`);
    return;
  }
  if (key === "laplace") {
    const m = /laplace\s*(\{[^}]*\})\s*=?\s*(\{.*\})/s.exec(card.raw);
    if (!m) throw perr(`Bad LAPLACE source: ${card.raw}`, line);
    const rat = laplaceRational(stripDelims(m[2]!), env, line);
    if (rat) {
      const host = xHost(c, env, card, name, 0);
      if (emitRational(host, `(${stripDelims(m[1]!)})`, t[1]!, t[2]!, isE, rat.num, rat.den)) return;
    }
    c.warn(`Line ${line}: unsupported device ignored: ${card.raw}`);
    return;
  }
  if (key === "freq" || key === "cur" || key === "vol") {
    c.warn(`Line ${line}: unsupported device ignored: ${card.raw}`);
    return;
  }
  const { pos } = splitArgs(t, 3);
  if (pos.length < 3) throw perr(`Controlled source '${t[0]}' needs two control nodes and a gain: ${card.raw}`, line);
  const cp = env.pin(c, pos[0]!);
  const cn = env.pin(c, pos[1]!);
  const gain = env.value(pos[2]!, line);
  addDevice(c, isE ? new VCVS(name, line, a, b, cp, cn, gain) : new VCCS(name, line, a, b, cp, cn, gain), line);
}

function buildCurrentControlled(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 4, "Controlled source");
  const t = card.toks;
  const line = card.line;
  const isH = t[0]![0] === "h";
  const a = env.pin(c, t[1]!);
  const b = env.pin(c, t[2]!);
  if (t[3] === "poly") {
    const { pos } = splitArgs(t, 4);
    const n = Math.floor(env.value(pos[0] ?? "", line));
    if (!(n >= 1) || pos.length < 1 + n) throw perr(`Bad POLY source: ${card.raw}`, line);
    const controls = pos.slice(1, 1 + n).map((v) => `i(${v})`);
    const coef = pos.slice(1 + n).map((v) => env.value(v, line));
    makeBehavioral(c, env, card, name, a, b, isH, polyText(controls, coef));
    return;
  }
  const { pos } = splitArgs(t, 3);
  if (pos.length < 2) throw perr(`Controlled source '${t[0]}' needs a control source and a gain: ${card.raw}`, line);
  const ctrl = branchResolver(env, pos[0]!, card, c);
  const gain = env.value(pos[1]!, line);
  addDevice(c, isH ? new CCVS(name, line, a, b, ctrl, gain) : new CCCS(name, line, a, b, ctrl, gain), line);
}

function buildMutual(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 4, "Mutual inductance");
  const line = card.line;
  const { pos, named } = splitArgs(card.toks, 1);
  const kTok = named.get("k") ?? pos[2];
  if (pos.length < 2 || kTok === undefined) throw perr(`Mutual inductance needs two inductors and k: ${card.raw}`, line);
  const k = env.value(kTok, line);
  if (Math.abs(k) > 1) throw perr(`Coupling coefficient must be within -1..1: ${card.raw}`, line);
  const find = (cc: Circuit, n: string): Inductor => {
    for (const candidate of [env.prefix + n, n]) {
      const d = cc.named.get(candidate);
      if (d instanceof Inductor) return d;
    }
    throw perr(`Inductor '${n}' not found for mutual inductance: ${card.raw}`, line);
  };
  const resolve = (cc: Circuit): { l1: Inductor; l2: Inductor } => ({ l1: find(cc, pos[0]!), l2: find(cc, pos[1]!) });
  addDevice(c, new MutualInductance(name, line, resolve, k), line);
}

function getModel(env: Env, name: string | undefined, types: string[], what: string, card: Card): Model {
  if (name === undefined) throw perr(`${what} '${card.toks[0]}' has no model: ${card.raw}`, card.line);
  const m = env.model(name);
  if (!m) throw perr(`Unknown model '${name}' for ${what} '${card.toks[0]}'`, card.line);
  if (!types.includes(m.type)) {
    throw perr(`Model '${name}' has type '${m.type}', which cannot be used by ${what} '${card.toks[0]}'`, card.line);
  }
  return m;
}

function buildSwitch(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 6, "Switch");
  const t = card.toks;
  const a = env.pin(c, t[1]!);
  const b = env.pin(c, t[2]!);
  const cp = env.pin(c, t[3]!);
  const cn = env.pin(c, t[4]!);
  const m = getModel(env, t[5], ["sw", "vswitch"], "switch", card);
  addSwitch(c, m, name, card, a, b, { kind: "nodes", cp, cn }, t[6] === "on", "vt", "vh", "von", "voff", m.type === "vswitch");
}

function buildCurrentSwitch(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 5, "Current switch");
  const t = card.toks;
  const a = env.pin(c, t[1]!);
  const b = env.pin(c, t[2]!);
  const m = getModel(env, t[4], ["csw", "iswitch"], "current switch", card);
  const control: SwitchControl = { kind: "branch", resolve: branchResolver(env, t[3]!, card, c) };
  addSwitch(c, m, name, card, a, b, control, t[5] === "on", "it", "ih", "ion", "ioff", m.type === "iswitch");
}

/**
 * SPICE3 models hold a hysteretic state from VT and VH. PSpice models give VON and VOFF, and
 * use the smooth log-cubic resistance between them, which needs no state.
 */
function addSwitch(
  c: Circuit,
  m: Model,
  name: string,
  card: Card,
  a: number,
  b: number,
  control: SwitchControl,
  initialOn: boolean,
  vtKey: string,
  vhKey: string,
  onKey: string,
  offKey: string,
  pspiceType: boolean,
): void {
  const line = card.line;
  if (pspiceType || m.has(onKey) || m.has(offKey)) {
    const isCurrent = onKey === "ion";
    const von = m.num(onKey, isCurrent ? 1e-3 : 1);
    const voff = m.num(offKey, 0);
    const ron = m.num("ron", 1);
    const roff = m.num("roff", 1e6);
    m.markUsed(vtKey, vhKey);
    m.finish(c);
    if (von === voff) {
      addDevice(c, new Switch(name, line, a, b, control, { vt: von, vh: 0, ron, roff }, initialOn), line);
    } else {
      addDevice(c, new SmoothSwitch(name, line, a, b, control, von, voff, ron, roff), line);
    }
    return;
  }
  const params = {
    vt: m.num(vtKey, 0),
    vh: Math.abs(m.num(vhKey, 0)),
    ron: m.num("ron", 1),
    roff: m.num("roff", 1e12),
  };
  m.finish(c);
  addDevice(c, new Switch(name, line, a, b, control, params, initialOn), line);
}

function buildDiode(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 4, "Diode");
  const t = card.toks;
  const line = card.line;
  const a = env.pin(c, t[1]!);
  const k = env.pin(c, t[2]!);
  const { pos, named } = splitArgs(t, 3);
  const m = getModel(env, pos[0], ["d"], "diode", card);
  const areaTok = named.get("area") ?? pos[1];
  const area = areaTok !== undefined && parseNumber(areaTok) !== null ? env.value(areaTok, line) : 1;
  let p = m.data as DiodeParams | null;
  if (!p) {
    p = {
      is: m.num("is", 1e-14),
      n: m.num("n", 1),
      rs: m.num("rs", 0),
      cjo: m.has("cj0") ? m.num("cj0", 0) : m.num("cjo", 0),
      vj: m.num("vj", 1),
      m: m.num("m", 0.5),
      tt: m.num("tt", 0),
      bv: m.num("bv", Infinity),
      ibv: m.num("ibv", 1e-3),
      fc: m.num("fc", 0.5),
      tnom: m.num("tnom", c.tnom),
      xti: m.num("xti", 3),
      eg: m.num("eg", 1.11),
      kf: m.num("kf", 0),
      af: m.num("af", 1),
    };
    m.num("cj0", 0);
    m.data = p;
    m.finish(c);
  }
  addDevice(c, new Diode(name, line, a, k, p, area, instanceTemp(c, env, named, line)), line);
}

function buildBjt(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 5, "BJT");
  const t = card.toks;
  const line = card.line;
  const { pos, named } = splitArgs(t, 1);
  if (pos.length < 4) throw perr(`BJT '${t[0]}' needs three nodes and a model: ${card.raw}`, line);
  const hasSubstrate = !env.model(pos[3]!) && pos[4] !== undefined && env.model(pos[4]!) !== null;
  const modelAt = hasSubstrate ? 4 : 3;
  const m = getModel(env, pos[modelAt], ["npn", "pnp"], "BJT", card);
  const cNode = env.pin(c, pos[0]!);
  const bNode = env.pin(c, pos[1]!);
  const eNode = env.pin(c, pos[2]!);
  const subNode = hasSubstrate ? env.pin(c, pos[3]!) : 0;
  const areaTok = named.get("area") ?? pos[modelAt + 1];
  const area = areaTok !== undefined && parseNumber(areaTok) !== null ? env.value(areaTok, line) : 1;
  let p = m.data as BjtParams | null;
  if (!p) {
    const rb = m.num("rb", 0);
    const vaf = m.has("va") ? m.num("va", Infinity) : m.num("vaf", Infinity);
    const varv = m.has("vb") ? m.num("vb", Infinity) : m.num("var", Infinity);
    const ikf = m.has("ik") ? m.num("ik", Infinity) : m.num("ikf", Infinity);
    p = {
      type: m.type === "npn" ? 1 : -1,
      is: m.num("is", 1e-16),
      bf: m.num("bf", 100),
      br: m.num("br", 1),
      nf: m.num("nf", 1),
      nr: m.num("nr", 1),
      vaf,
      var: varv,
      ikf,
      ikr: m.num("ikr", Infinity),
      ise: m.num("ise", 0),
      ne: m.num("ne", 1.5),
      isc: m.num("isc", 0),
      nc: m.num("nc", 2),
      rb,
      rbm: m.num("rbm", rb),
      re: m.num("re", 0),
      rc: m.num("rc", 0),
      cje: m.num("cje", 0),
      vje: m.num("vje", 0.75),
      mje: m.num("mje", 0.33),
      cjc: m.num("cjc", 0),
      vjc: m.num("vjc", 0.75),
      mjc: m.num("mjc", 0.33),
      fc: m.num("fc", 0.5),
      tf: m.num("tf", 0),
      tr: m.num("tr", 0),
      xtf: m.num("xtf", 0),
      vtf: m.num("vtf", Infinity),
      itf: m.num("itf", 0),
      xcjc: m.num("xcjc", 1),
      cjs: m.num("cjs", 0),
      vjs: m.num("vjs", 0.75),
      mjs: m.num("mjs", 0),
      irb: m.num("irb", 0),
      tnom: m.num("tnom", c.tnom),
      xti: m.num("xti", 3),
      xtb: m.num("xtb", 0),
      eg: m.num("eg", 1.11),
      kf: m.num("kf", 0),
      af: m.num("af", 1),
    };
    m.markUsed("iss", "nk", "ns");
    for (const alias of ["va", "vb", "ik"]) m.num(alias, 0);
    m.data = p;
    m.finish(c);
  }
  addDevice(c, new Bjt(name, line, cNode, bNode, eNode, p, area, instanceTemp(c, env, named, line), subNode), line);
}

/** KP from mobility in cm^2/Vs and oxide thickness in m, when the model gives those instead. */
function kpFromProcess(m: Model): number {
  const uo = m.has("u0") ? m.num("u0", 600) : m.num("uo", 600);
  const tox = m.num("tox", 0);
  if (!m.has("tox") || tox <= 0) return 2e-5;
  return ((uo * 1e-4) * 3.9 * 8.854187817e-12) / tox;
}

function buildMos(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 5, "MOSFET");
  const t = card.toks;
  const line = card.line;
  const { pos, named } = splitArgs(t, 1);
  if (pos.length < 4) throw perr(`MOSFET '${t[0]}' needs nodes and a model: ${card.raw}`, line);
  const threeTerminal = env.model(pos[3]!) !== null;
  const modelTok = threeTerminal ? pos[3] : pos[4];
  const m = getModel(env, modelTok, ["nmos", "pmos"], "MOSFET", card);
  const d = env.pin(c, pos[0]!);
  const g = env.pin(c, pos[1]!);
  const s = env.pin(c, pos[2]!);
  const bulk = threeTerminal ? s : env.pin(c, pos[3]!);
  const dim = (key: string, fallback: number): number => (named.has(key) ? env.value(named.get(key)!, line) : fallback);
  const geo = {
    w: dim("w", 100e-6),
    l: dim("l", 100e-6),
    mult: dim("m", 1),
    ad: dim("ad", 0),
    as: dim("as", 0),
    pd: dim("pd", 0),
    ps: dim("ps", 0),
    tempC: instanceTemp(c, env, named, line),
  };
  let p = m.data as MosParams | null;
  if (!p) {
    p = {
      type: m.type === "nmos" ? 1 : -1,
      vto: m.num("vto", 0),
      kp: m.has("kp") ? m.num("kp", 2e-5) : kpFromProcess(m),
      gamma: m.num("gamma", 0),
      phi: m.num("phi", 0.6),
      lambda: m.num("lambda", 0),
      rd: m.has("rd") ? m.num("rd", 0) : m.num("rsh", 0) * dim("nrd", 0),
      rs: m.has("rs") ? m.num("rs", 0) : m.num("rsh", 0) * dim("nrs", 0),
      tox: m.num("tox", 0),
      cj: m.num("cj", 0),
      cjsw: m.num("cjsw", 0),
      mjsw: m.num("mjsw", 0.33),
      js: m.num("js", 0),
      tnom: m.num("tnom", c.tnom),
      kf: m.num("kf", 0),
      af: m.num("af", 1),
      cgso: m.num("cgso", 0),
      cgdo: m.num("cgdo", 0),
      cgbo: m.num("cgbo", 0),
      cbd: m.num("cbd", 0),
      cbs: m.num("cbs", 0),
      pb: m.num("pb", 0.8),
      mj: m.num("mj", 0.5),
      fc: m.num("fc", 0.5),
      is: m.num("is", 1e-14),
      ld: m.num("ld", 0),
    };
    const level = m.num("level", 1);
    if (level !== 1) c.warn(`Model '${m.name}': MOS level ${level} is simulated with the level 1 equations`);
    // Process values only derive parameters the model already states, so they change nothing here.
    m.markUsed("u0", "uo", "rsh");
    if (m.has("vto") && m.has("gamma") && m.has("phi")) m.markUsed("tpg", "nss", "nsub");
    m.data = p;
    m.finish(c);
  }
  addDevice(c, new Mosfet(name, line, d, g, s, bulk, p, geo), line);
}

function buildJfet(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 5, "JFET");
  const t = card.toks;
  const line = card.line;
  const { pos, named } = splitArgs(t, 1);
  if (pos.length < 4) throw perr(`JFET '${t[0]}' needs three nodes and a model: ${card.raw}`, line);
  const m = getModel(env, pos[3], ["njf", "pjf"], "JFET", card);
  const d = env.pin(c, pos[0]!);
  const g = env.pin(c, pos[1]!);
  const s = env.pin(c, pos[2]!);
  const areaTok = named.get("area") ?? pos[4];
  const area = areaTok !== undefined && parseNumber(areaTok) !== null ? env.value(areaTok, line) : 1;
  let p = m.data as JfetParams | null;
  if (!p) {
    p = {
      type: m.type === "njf" ? 1 : -1,
      vto: m.num("vto", -2),
      beta: m.num("beta", 1e-4),
      lambda: m.num("lambda", 0),
      is: m.num("is", 1e-14),
      rd: m.num("rd", 0),
      rs: m.num("rs", 0),
      cgs: m.num("cgs", 0),
      cgd: m.num("cgd", 0),
      pb: m.num("pb", 1),
      fc: m.num("fc", 0.5),
      m: m.num("m", 0.5),
      alpha: 0,
      b: 0,
      tnom: m.num("tnom", c.tnom),
      xti: m.num("xti", 3),
      eg: m.num("eg", 1.11),
      kf: m.num("kf", 0),
      af: m.num("af", 1),
    };
    m.data = p;
    m.finish(c);
  }
  addDevice(c, new Jfet(name, line, d, g, s, p, area, instanceTemp(c, env, named, line)), line);
}

function buildMesfet(c: Circuit, env: Env, card: Card, name: string): void {
  need(card, 5, "MESFET");
  const t = card.toks;
  const line = card.line;
  const { pos, named } = splitArgs(t, 1);
  if (pos.length < 4) throw perr(`MESFET '${t[0]}' needs three nodes and a model: ${card.raw}`, line);
  const m = getModel(env, pos[3], ["nmf", "pmf"], "MESFET", card);
  const d = env.pin(c, pos[0]!);
  const g = env.pin(c, pos[1]!);
  const s = env.pin(c, pos[2]!);
  const areaTok = named.get("area") ?? pos[4];
  const area = areaTok !== undefined && parseNumber(areaTok) !== null ? env.value(areaTok, line) : 1;
  let p = m.data as JfetParams | null;
  if (!p) {
    p = {
      type: m.type === "nmf" ? 1 : -1,
      vto: m.num("vto", -2),
      beta: m.num("beta", 2.5e-3),
      lambda: m.num("lambda", 0),
      is: m.num("is", 1e-14),
      rd: m.num("rd", 0),
      rs: m.num("rs", 0),
      cgs: m.num("cgs", 0),
      cgd: m.num("cgd", 0),
      pb: m.num("pb", 1),
      fc: m.num("fc", 0.5),
      m: 0.5,
      alpha: m.num("alpha", 2),
      b: m.num("b", 0.3),
      tnom: m.num("tnom", c.tnom),
      xti: 3,
      eg: 1.11,
      kf: m.num("kf", 0),
      af: m.num("af", 1),
    };
    m.data = p;
    m.finish(c);
  }
  addDevice(c, new Jfet(name, line, d, g, s, p, area, instanceTemp(c, env, named, line)), line);
}

/** Lossless line as an LC ladder: valid well below sections / (pi TD), and usable in every analysis. */
const TLINE_SECTIONS = 40;

function buildTransmissionLine(c: Circuit, env: Env, card: Card, name: string, depth: number): void {
  const line = card.line;
  const { pos, named } = splitArgs(card.toks, 1);
  if (pos.length < 4) throw perr(`Transmission line needs four nodes: ${card.raw}`, line);
  const z0 = env.value(named.get("z0") ?? named.get("zo") ?? "", line);
  let td: number;
  if (named.has("td")) td = env.value(named.get("td")!, line);
  else if (named.has("f")) td = (named.has("nl") ? env.value(named.get("nl")!, line) : 0.25) / env.value(named.get("f")!, line);
  else throw perr(`Transmission line needs TD or F: ${card.raw}`, line);
  if (!(z0 > 0) || !(td > 0)) throw perr(`Transmission line needs positive Z0 and delay: ${card.raw}`, line);
  c.warn(`Model 'transmission line' ${name} is approximated by a ${TLINE_SECTIONS}-section LC ladder`);
  const h = xHost(c, env, card, name, depth);
  const lEach = (z0 * td) / TLINE_SECTIONS;
  const cEach = td / (z0 * TLINE_SECTIONS);
  const base = name.replace(/\./g, "_");
  const nodeAt = (k: number): string => (k === 0 ? pos[0]! : k === TLINE_SECTIONS ? pos[2]! : `${base}#${k}`);
  for (let k = 0; k < TLINE_SECTIONS; k++) {
    h.emit(`l#${base}${k} ${nodeAt(k)} ${nodeAt(k + 1)} ${lEach}`);
    const half = k === 0 ? cEach / 2 : cEach;
    h.emit(`c#${base}${k} ${nodeAt(k)} ${pos[1]} ${half}`);
  }
  h.emit(`c#${base}end ${pos[2]} ${pos[3]} ${cEach / 2}`);
}

/** Rational form of a Laplace expression; e^(k s) becomes a [4/4] Pade approximant. */
function laplaceRational(text: string, env: Env, line: number): { num: number[]; den: number[] } | null {
  type Rat = { num: number[]; den: number[] };
  const padd = (a: number[], b: number[], sign: number): number[] => {
    const out = new Array(Math.max(a.length, b.length)).fill(0) as number[];
    a.forEach((v, i) => (out[i]! += v));
    b.forEach((v, i) => (out[i]! += sign * v));
    return out;
  };
  const pmul = (a: number[], b: number[]): number[] => {
    const out = new Array(a.length + b.length - 1).fill(0) as number[];
    a.forEach((va, i) => b.forEach((vb, j) => (out[i + j]! += va * vb)));
    return out;
  };
  const exps = (k: number): Rat => {
    const c1 = 1 / 2;
    const c2 = 3 / 28;
    const c3 = 1 / 84;
    const c4 = 1 / 1680;
    return {
      num: [1, c1 * k, c2 * k ** 2, c3 * k ** 3, c4 * k ** 4],
      den: [1, -c1 * k, c2 * k ** 2, -c3 * k ** 3, c4 * k ** 4],
    };
  };
  const linearCoef = (r: Rat): number | null => {
    if (r.den.length !== 1 || r.num.length > 2 || r.num[0] !== 0) return null;
    return (r.num[1] ?? 0) / r.den[0]!;
  };
  const walk = (e: Ast): Rat | null => {
    switch (e.k) {
      case "n":
        return { num: [e.v], den: [1] };
      case "v":
        return { num: [0, 1], den: [1] };
      case "neg": {
        const a = walk(e.a);
        return a && { num: a.num.map((v) => -v), den: a.den };
      }
      case "f": {
        if (e.name !== "exp") return null;
        const a = walk(e.args[0]!);
        const k = a && linearCoef(a);
        return k === null || k === undefined ? null : exps(k);
      }
      case "b": {
        const a = walk(e.a);
        if (e.op === "^") {
          const base = e.a.k === "n" ? e.a.v : null;
          const power = walk(e.b);
          if (!power) return null;
          const k = linearCoef(power);
          if (base !== null && k !== null && base > 0) return exps(k * Math.log(base));
          const n = e.b.k === "n" ? e.b.v : NaN;
          if (!a || !Number.isInteger(n) || Math.abs(n) > 16) return null;
          let r: Rat = { num: [1], den: [1] };
          for (let i = 0; i < Math.abs(n); i++) r = { num: pmul(r.num, a.num), den: pmul(r.den, a.den) };
          return n >= 0 ? r : { num: r.den, den: r.num };
        }
        const b = walk(e.b);
        if (!a || !b) return null;
        switch (e.op) {
          case "+":
          case "-": {
            const sign = e.op === "+" ? 1 : -1;
            return { num: padd(pmul(a.num, b.den), pmul(b.num, a.den), sign), den: pmul(a.den, b.den) };
          }
          case "*":
            return { num: pmul(a.num, b.num), den: pmul(a.den, b.den) };
          case "/":
            return { num: pmul(a.num, b.den), den: pmul(a.den, b.num) };
          default:
            return null;
        }
      }
      default:
        return null;
    }
  };
  try {
    const ast = parseExpr(text, env.withFuncs({
      ident: (n): Ast | null => {
        if (n === "s") return { k: "v", i: 0 };
        const v = env.lookup(n, line);
        if (v !== null) return { k: "n", v };
        return n === "e" ? { k: "n", v: Math.E } : null;
      },
    }));
    return walk(ast);
  } catch (e) {
    if (e instanceof ExprError) return null;
    throw e;
  }
}

/** Host interface for generating devices in this scope. */
function xHost(c: Circuit, env: Env, card: Card, name: string, depth: number): XHost {
  const line = card.line;
  return {
    c,
    name,
    line,
    raw: card.raw,
    ref: (node) => env.nodeRef(c, node),
    pin: (node) => env.pin(c, node),
    value: (tok) => env.value(tok, line),
    emit: (text) => {
      const lower = text.toLowerCase();
      elaborateCard(c, env, { line, raw: lower, toks: tokenize(lower) }, depth);
    },
    behavioral: (suffix, a, b, isVoltage, expr) => {
      const aId = env.pin(c, a);
      const bId = env.pin(c, b);
      makeBehavioral(c, env, card, `${name}${suffix}`, aId, bId, isVoltage, expr);
    },
  };
}

function buildCodeModel(c: Circuit, env: Env, card: Card, name: string, depth: number): void {
  const parsed = readPorts(card.toks);
  const unsupported = (): void => c.warn(`Line ${card.line}: unsupported device ignored: ${card.raw}`);
  if (!parsed) return unsupported();
  const m = env.model(parsed.model);
  if (!m) return unsupported();
  const adapter: XModel = m;
  try {
    if (!buildXspice(xHost(c, env, card, name, depth), parsed.ports, adapter)) unsupported();
  } catch (e) {
    if (e instanceof SimError) throw e;
    c.warn(`Line ${card.line}: unsupported device ignored: ${card.raw} (${e instanceof Error ? e.message : String(e)})`);
  }
}

function buildInstance(c: Circuit, env: Env, card: Card, name: string, depth: number): void {
  const t = card.toks;
  const line = card.line;
  const { pos, named } = splitArgs(t, 1);
  if (pos.length < 1) throw perr(`Subcircuit instance '${t[0]}' has no subcircuit name: ${card.raw}`, line);
  const subName = pos[pos.length - 1]!;
  const sub = env.scope.findSubckt(subName);
  if (!sub) throw perr(`Unknown subcircuit '${subName}' for instance '${t[0]}'`, line);
  if (env.callStack.includes(sub)) throw perr(`Subcircuit '${subName}' instantiates itself`, line);
  if (++env.deck.instances > MAX_INSTANCES) {
    throw new SimError(`The circuit expands to more than ${MAX_INSTANCES} subcircuit instances`, "unsupported", line);
  }
  const nodes = pos.slice(0, -1);
  if (nodes.length !== sub.ports.length) {
    throw perr(
      `Instance '${t[0]}' connects ${nodes.length} nodes but subcircuit '${subName}' has ${sub.ports.length} ports`,
      line,
    );
  }
  const ports = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) ports.set(sub.ports[i]!, env.nodeRef(c, nodes[i]!));
  const parent = env.definingEnv(sub);
  const childEnv = new Env(sub, parent, `${name}.`, ports, env.deck);
  const overrides: { name: string; text: string; env: Env; line: number }[] = [];
  for (const [k, v] of named) overrides.push({ name: k, text: v, env, line });
  childEnv.callStack = [...env.callStack, sub];
  childEnv.init(overrides);
  elaborateScope(c, childEnv, depth + 1);
}
