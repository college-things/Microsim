// Original two-pass assembler for classic Intel-syntax MCS-51 source, written from the published instruction set.
// Generic JMP and CALL assemble to LJMP and LCALL: every jump form takes two machine cycles, so timing is the same.

export interface AsmResult {
  /** Code memory image from address 0 up to the highest byte written. */
  code: Uint8Array;
  symbols: Map<string, number>;
  /** Each instruction's address, size, source line and assembled mnemonic (generic JMP/CALL shown as LJMP/LCALL). */
  listing: { address: number; size: number; line: number; mnemonic: string }[];
}

export class AsmError extends Error {
  constructor(readonly line: number, message: string) {
    super(`Line ${line}: ${message}`);
  }
}

const SFR: Record<string, number> = {
  P0: 0x80, SP: 0x81, DPL: 0x82, DPH: 0x83, PCON: 0x87, TCON: 0x88, TMOD: 0x89, TL0: 0x8a, TL1: 0x8b, TH0: 0x8c, TH1: 0x8d,
  P1: 0x90, SCON: 0x98, SBUF: 0x99, P2: 0xa0, IE: 0xa8, P3: 0xb0, IP: 0xb8, T2CON: 0xc8, RCAP2L: 0xca, RCAP2H: 0xcb,
  TL2: 0xcc, TH2: 0xcd, PSW: 0xd0, ACC: 0xe0, B: 0xf0,
};
const BITS: Record<string, number> = {
  IT0: 0x88, IE0: 0x89, IT1: 0x8a, IE1: 0x8b, TR0: 0x8c, TF0: 0x8d, TR1: 0x8e, TF1: 0x8f,
  RI: 0x98, TI: 0x99, RB8: 0x9a, TB8: 0x9b, REN: 0x9c, SM2: 0x9d, SM1: 0x9e, SM0: 0x9f,
  EX0: 0xa8, ET0: 0xa9, EX1: 0xaa, ET1: 0xab, ES: 0xac, ET2: 0xad, EA: 0xaf,
  RXD: 0xb0, TXD: 0xb1, INT0: 0xb2, INT1: 0xb3, T0: 0xb4, T1: 0xb5, WR: 0xb6, RD: 0xb7,
  PX0: 0xb8, PT0: 0xb9, PX1: 0xba, PT1: 0xbb, PS: 0xbc, PT2: 0xbd,
  CP_RL2: 0xc8, C_T2: 0xc9, TR2: 0xca, EXEN2: 0xcb, TCLK: 0xcc, RCLK: 0xcd, EXF2: 0xce, TF2: 0xcf,
  P: 0xd0, OV: 0xd2, RS0: 0xd3, RS1: 0xd4, F0: 0xd5, AC: 0xd6, CY: 0xd7,
};

type Kind = "A" | "AB" | "C" | "DPTR" | "@A+DPTR" | "@A+PC" | "@DPTR" | "@Ri" | "Rn" | "#" | "/bit" | "expr";
interface Operand { kind: Kind; reg?: number; text?: string }
/** Encoders for each operand pattern; d = direct, b = bit, r = relative, i = 8-bit immediate, w = 16-bit, a = addr11, l = addr16. */
type Field = "d" | "b" | "r" | "i" | "w" | "a" | "l" | "-";
interface Form { ops: Kind[]; code: number; fields: Field[]; addReg?: boolean }

const forms = new Map<string, Form[]>();
const add = (mn: string, ops: Kind[], code: number, fields: Field[]) => {
  const list = forms.get(mn) ?? [];
  list.push({ ops, code, fields, addReg: ops.some((k) => k === "Rn" || k === "@Ri") });
  forms.set(mn, list);
};
// Arithmetic and logic on A share one layout: #imm, direct, @Ri, Rn at +4, +5, +6, +8.
for (const [mn, base] of [["ADD", 0x20], ["ADDC", 0x30], ["ORL", 0x40], ["ANL", 0x50], ["XRL", 0x60], ["SUBB", 0x90]] as const) {
  add(mn, ["A", "#"], base + 4, ["-", "i"]);
  add(mn, ["A", "expr"], base + 5, ["-", "d"]);
  add(mn, ["A", "@Ri"], base + 6, ["-", "-"]);
  add(mn, ["A", "Rn"], base + 8, ["-", "-"]);
}
for (const [mn, base] of [["ORL", 0x40], ["ANL", 0x50], ["XRL", 0x60]] as const) {
  add(mn, ["expr", "A"], base + 2, ["d", "-"]);
  add(mn, ["expr", "#"], base + 3, ["d", "i"]);
}
add("ORL", ["C", "expr"], 0x72, ["-", "b"]); add("ORL", ["C", "/bit"], 0xa0, ["-", "b"]);
add("ANL", ["C", "expr"], 0x82, ["-", "b"]); add("ANL", ["C", "/bit"], 0xb0, ["-", "b"]);
for (const [mn, base] of [["INC", 0x00], ["DEC", 0x10]] as const) {
  add(mn, ["A"], base + 4, ["-"]); add(mn, ["expr"], base + 5, ["d"]); add(mn, ["@Ri"], base + 6, ["-"]); add(mn, ["Rn"], base + 8, ["-"]);
}
add("INC", ["DPTR"], 0xa3, ["-"]);
add("NOP", [], 0x00, []);
add("AJMP", ["expr"], 0x01, ["a"]); add("ACALL", ["expr"], 0x11, ["a"]);
add("LJMP", ["expr"], 0x02, ["l"]); add("LCALL", ["expr"], 0x12, ["l"]);
add("JMP", ["@A+DPTR"], 0x73, ["-"]); add("JMP", ["expr"], 0x02, ["l"]); add("CALL", ["expr"], 0x12, ["l"]);
add("SJMP", ["expr"], 0x80, ["r"]);
add("RR", ["A"], 0x03, ["-"]); add("RRC", ["A"], 0x13, ["-"]); add("RL", ["A"], 0x23, ["-"]); add("RLC", ["A"], 0x33, ["-"]);
add("JBC", ["expr", "expr"], 0x10, ["b", "r"]); add("JB", ["expr", "expr"], 0x20, ["b", "r"]); add("JNB", ["expr", "expr"], 0x30, ["b", "r"]);
add("RET", [], 0x22, []); add("RETI", [], 0x32, []);
add("JC", ["expr"], 0x40, ["r"]); add("JNC", ["expr"], 0x50, ["r"]); add("JZ", ["expr"], 0x60, ["r"]); add("JNZ", ["expr"], 0x70, ["r"]);
add("MOV", ["A", "#"], 0x74, ["-", "i"]);
add("MOV", ["A", "@Ri"], 0xe6, ["-", "-"]);
add("MOV", ["A", "Rn"], 0xe8, ["-", "-"]);
add("MOV", ["A", "expr"], 0xe5, ["-", "d"]);
add("MOV", ["@Ri", "#"], 0x76, ["-", "i"]);
add("MOV", ["@Ri", "A"], 0xf6, ["-", "-"]);
add("MOV", ["@Ri", "expr"], 0xa6, ["-", "d"]);
add("MOV", ["Rn", "#"], 0x78, ["-", "i"]);
add("MOV", ["Rn", "A"], 0xf8, ["-", "-"]);
add("MOV", ["Rn", "expr"], 0xa8, ["-", "d"]);
add("MOV", ["DPTR", "#"], 0x90, ["-", "w"]);
add("MOV", ["C", "expr"], 0xa2, ["-", "b"]);
add("MOV", ["expr", "C"], 0x92, ["b", "-"]);
add("MOV", ["expr", "#"], 0x75, ["d", "i"]);
add("MOV", ["expr", "A"], 0xf5, ["d", "-"]);
add("MOV", ["expr", "@Ri"], 0x86, ["d", "-"]);
add("MOV", ["expr", "Rn"], 0x88, ["d", "-"]);
add("MOV", ["expr", "expr"], 0x85, ["d", "d"]); // encoded source first, see encode()
add("MOVC", ["A", "@A+PC"], 0x83, ["-", "-"]); add("MOVC", ["A", "@A+DPTR"], 0x93, ["-", "-"]);
add("MOVX", ["A", "@DPTR"], 0xe0, ["-", "-"]); add("MOVX", ["A", "@Ri"], 0xe2, ["-", "-"]);
add("MOVX", ["@DPTR", "A"], 0xf0, ["-", "-"]); add("MOVX", ["@Ri", "A"], 0xf2, ["-", "-"]);
add("DIV", ["AB"], 0x84, ["-"]); add("MUL", ["AB"], 0xa4, ["-"]);
add("CPL", ["A"], 0xf4, ["-"]); add("CPL", ["C"], 0xb3, ["-"]); add("CPL", ["expr"], 0xb2, ["b"]);
add("CLR", ["A"], 0xe4, ["-"]); add("CLR", ["C"], 0xc3, ["-"]); add("CLR", ["expr"], 0xc2, ["b"]);
add("SETB", ["C"], 0xd3, ["-"]); add("SETB", ["expr"], 0xd2, ["b"]);
add("CJNE", ["A", "#", "expr"], 0xb4, ["-", "i", "r"]);
add("CJNE", ["A", "expr", "expr"], 0xb5, ["-", "d", "r"]);
add("CJNE", ["@Ri", "#", "expr"], 0xb6, ["-", "i", "r"]);
add("CJNE", ["Rn", "#", "expr"], 0xb8, ["-", "i", "r"]);
add("PUSH", ["expr"], 0xc0, ["d"]); add("POP", ["expr"], 0xd0, ["d"]);
add("SWAP", ["A"], 0xc4, ["-"]); add("DA", ["A"], 0xd4, ["-"]);
add("XCH", ["A", "expr"], 0xc5, ["-", "d"]); add("XCH", ["A", "@Ri"], 0xc6, ["-", "-"]); add("XCH", ["A", "Rn"], 0xc8, ["-", "-"]);
add("XCHD", ["A", "@Ri"], 0xd6, ["-", "-"]);
add("DJNZ", ["expr", "expr"], 0xd5, ["d", "r"]); add("DJNZ", ["Rn", "expr"], 0xd8, ["-", "r"]);

const formSize = (f: Form) => 1 + f.fields.reduce((n, k) => n + (k === "-" ? 0 : k === "w" || k === "l" ? 2 : 1), 0) - (f.fields.includes("a") ? 0 : 0);

/** Splits on commas outside quotes and parentheses. */
function splitOperands(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", cur = "";
  for (const ch of text) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out;
}

function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ";") return line.slice(0, i);
  }
  return line;
}

function classify(text: string): Operand {
  const t = text.replace(/\s+/g, "").toUpperCase();
  if (t === "A") return { kind: "A" };
  if (t === "AB") return { kind: "AB" };
  if (t === "C") return { kind: "C" };
  if (t === "DPTR") return { kind: "DPTR" };
  if (t === "@A+DPTR") return { kind: "@A+DPTR" };
  if (t === "@A+PC") return { kind: "@A+PC" };
  if (t === "@DPTR") return { kind: "@DPTR" };
  const ri = /^@R([01])$/.exec(t);
  if (ri) return { kind: "@Ri", reg: Number(ri[1]) };
  const rn = /^R([0-7])$/.exec(t);
  if (rn) return { kind: "Rn", reg: Number(rn[1]) };
  if (text.trim().startsWith("#")) return { kind: "#", text: text.trim().slice(1) };
  if (text.trim().startsWith("/")) return { kind: "/bit", text: text.trim().slice(1) };
  return { kind: "expr", text };
}

// ---- Expressions ----
type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(text: string, line: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) throw new AsmError(line, "unterminated character constant.");
      const body = text.slice(i + 1, end);
      if (body.length < 1 || body.length > 2) throw new AsmError(line, "a character constant in an expression holds one or two characters.");
      toks.push({ t: "num", v: [...body].reduce((v, c) => (v << 8) | (c.charCodeAt(0) & 255), 0) });
      i = end + 1;
      continue;
    }
    const num = /^(0[xX][0-9A-Fa-f]+|[0-9][0-9A-Za-z]*)/.exec(text.slice(i));
    if (num) {
      toks.push({ t: "num", v: parseNumber(num[1], line) });
      i += num[1].length;
      continue;
    }
    const id = /^[A-Za-z_?][A-Za-z0-9_?]*/.exec(text.slice(i));
    if (id) {
      const word = id[0].toUpperCase();
      toks.push(["MOD", "SHL", "SHR", "AND", "OR", "XOR", "NOT", "HIGH", "LOW", "EQ", "NE", "LT", "LE", "GT", "GE"].includes(word) ? { t: "op", v: word } : { t: "id", v: word });
      i += id[0].length;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (["<<", ">>", "<=", ">=", "<>", "=="].includes(two)) { toks.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/()$.&|^~<>=!".includes(ch)) { toks.push({ t: "op", v: ch }); i++; continue; }
    throw new AsmError(line, `unexpected character "${ch}" in an expression.`);
  }
  return toks;
}

function parseNumber(raw: string, line: number): number {
  const s = raw.toUpperCase();
  let value: number;
  if (s.startsWith("0X")) value = parseInt(s.slice(2), 16);
  else if (s.endsWith("H")) value = /^[0-9A-F]+$/.test(s.slice(0, -1)) ? parseInt(s.slice(0, -1), 16) : NaN;
  else if (s.endsWith("B") && /^[01]+$/.test(s.slice(0, -1))) value = parseInt(s.slice(0, -1), 2);
  else if ((s.endsWith("O") || s.endsWith("Q")) && /^[0-7]+$/.test(s.slice(0, -1))) value = parseInt(s.slice(0, -1), 8);
  else if (s.endsWith("D") && /^[0-9]+$/.test(s.slice(0, -1))) value = parseInt(s.slice(0, -1), 10);
  else value = /^[0-9]+$/.test(s) ? parseInt(s, 10) : NaN;
  if (!Number.isFinite(value)) throw new AsmError(line, `"${raw}" is not a valid number.`);
  return value;
}

interface Scope { lookup(name: string): number | undefined; pc: number; line: number }

function evaluate(text: string, scope: Scope): number | undefined {
  const toks = tokenize(text, scope.line);
  let pos = 0;
  let unknown = false;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const primary = (): number => {
    const tok = toks[pos++];
    if (!tok) throw new AsmError(scope.line, "expression ends too early.");
    if (tok.t === "num") return tok.v;
    if (tok.t === "id") {
      const v = scope.lookup(tok.v);
      if (v === undefined) { unknown = true; return 0; }
      return v;
    }
    if (tok.v === "$") return scope.pc;
    if (tok.v === "(") { const v = or(); if (!isOp(")")) throw new AsmError(scope.line, "missing closing parenthesis."); pos++; return v; }
    if (tok.v === "-") return -unary();
    if (tok.v === "+") return unary();
    if (tok.v === "NOT" || tok.v === "~") return ~unary() & 0xffff;
    if (tok.v === "HIGH") return (unary() >>> 8) & 255;
    if (tok.v === "LOW") return unary() & 255;
    throw new AsmError(scope.line, `unexpected "${tok.v}" in an expression.`);
  };
  // Bit selection binds tightest: P1.3, 20H.0, ACC.7.
  const unary = (): number => {
    let v = primary();
    while (isOp(".")) {
      pos++;
      const bit = primary();
      if (bit < 0 || bit > 7) throw new AsmError(scope.line, "a bit number must be 0 to 7.");
      if (v >= 0x20 && v <= 0x2f) v = (v - 0x20) * 8 + bit;
      else if (v >= 0x80 && v <= 0xff && v % 8 === 0) v = v + bit;
      else if (!unknown) throw new AsmError(scope.line, "only RAM 20H–2FH and SFRs at multiples of 8 are bit-addressable.");
    }
    return v;
  };
  const mul = (): number => {
    let v = unary();
    for (;;) {
      if (isOp("*")) { pos++; v *= unary(); }
      else if (isOp("/")) { pos++; const d = unary(); if (!d && !unknown) throw new AsmError(scope.line, "division by zero."); v = d ? Math.trunc(v / d) : 0; }
      else if (isOp("MOD")) { pos++; const d = unary(); if (!d && !unknown) throw new AsmError(scope.line, "division by zero."); v = d ? v % d : 0; }
      else if (isOp("SHL") || isOp("<<")) { pos++; v <<= unary(); }
      else if (isOp("SHR") || isOp(">>")) { pos++; v >>>= unary(); }
      else return v;
    }
  };
  const sum = (): number => {
    let v = mul();
    for (;;) {
      if (isOp("+")) { pos++; v += mul(); }
      else if (isOp("-")) { pos++; v -= mul(); }
      else return v;
    }
  };
  const compare = (): number => {
    let v = sum();
    const ops: Record<string, (a: number, b: number) => boolean> = { EQ: (a, b) => a === b, "=": (a, b) => a === b, "==": (a, b) => a === b, NE: (a, b) => a !== b, "<>": (a, b) => a !== b, LT: (a, b) => a < b, "<": (a, b) => a < b, LE: (a, b) => a <= b, "<=": (a, b) => a <= b, GT: (a, b) => a > b, ">": (a, b) => a > b, GE: (a, b) => a >= b, ">=": (a, b) => a >= b };
    while (peek()?.t === "op" && ops[peek()!.v]) { const op = toks[pos++].v as string; v = ops[op](v, sum()) ? 0xffff : 0; }
    return v;
  };
  const and = (): number => { let v = compare(); while (isOp("AND") || isOp("&")) { pos++; v &= compare(); } return v; };
  const or = (): number => {
    let v = and();
    for (;;) {
      if (isOp("OR") || isOp("|")) { pos++; v |= and(); }
      else if (isOp("XOR") || isOp("^")) { pos++; v ^= and(); }
      else return v;
    }
  };
  if (!toks.length) throw new AsmError(scope.line, "missing operand.");
  const value = or();
  if (pos < toks.length) throw new AsmError(scope.line, "unexpected text after an expression.");
  return unknown ? undefined : value;
}

// ---- Assembly ----
interface Statement { line: number; label?: string; op?: string; args: string; name?: string }

function parse(source: string): Statement[] {
  const out: Statement[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    let text = stripComment(raw).trim();
    if (!text || text.startsWith("$") || text.startsWith("#")) return; // assembler controls such as $MOD51
    const st: Statement = { line, args: "" };
    const label = /^([A-Za-z_?][A-Za-z0-9_?]*)\s*:/.exec(text);
    if (label) { st.label = label[1].toUpperCase(); text = text.slice(label[0].length).trim(); }
    // name EQU value, name DATA value, name BIT value, ...
    const define = /^([A-Za-z_?][A-Za-z0-9_?]*)\s+(EQU|SET|DATA|IDATA|XDATA|BIT|CODE|REG)\b\s*(.*)$/i.exec(text);
    if (define && !st.label) { st.name = define[1].toUpperCase(); st.op = define[2].toUpperCase(); st.args = define[3].trim(); out.push(st); return; }
    if (text) {
      const word = /^(\S+)\s*(.*)$/.exec(text)!;
      st.op = word[1].toUpperCase();
      st.args = word[2].trim();
    }
    out.push(st);
  });
  return out;
}

const RESERVED = new Set(["A", "AB", "C", "DPTR", "PC", "R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7"]);

/** Assembles classic MCS-51 source into a code image. Errors name the line, not its text. */
export function assemble51(source: string): AsmResult {
  const statements = parse(source);
  const symbols = new Map<string, number>();
  const defined = new Map<string, number>(); // symbol -> line it was defined on
  let pending = true;
  let image = new Uint8Array(0);
  let listing: AsmResult["listing"] = [];
  // Passes repeat until every symbol is known, so EQU may refer forward.
  for (let pass = 0; pass < 8 && pending; pass++) {
    const final = pass > 0;
    pending = false;
    let pc = 0, top = 0;
    const bytes = new Map<number, number>();
    const scopeAt = (line: number): Scope => ({
      pc, line,
      lookup: (name) => symbols.get(name) ?? SFR[name] ?? BITS[name],
    });
    const value = (text: string, line: number, required = true): number => {
      const v = evaluate(text, scopeAt(line));
      if (v === undefined) {
        pending = true;
        if (final && required && pass >= 2) {
          const unknown = tokenize(text, line).find((t) => t.t === "id" && symbols.get(t.v) === undefined && SFR[t.v] === undefined && BITS[t.v] === undefined);
          throw new AsmError(line, `"${unknown && unknown.t === "id" ? unknown.v : text}" is not defined.`);
        }
        return 0;
      }
      return v;
    };
    const define = (name: string, v: number | undefined, line: number, reassign = false) => {
      if (RESERVED.has(name)) throw new AsmError(line, `"${name}" is a reserved name.`);
      const at = defined.get(name);
      if (pass === 0 && at !== undefined && at !== line && !reassign) throw new AsmError(line, `"${name}" is already defined on line ${at}.`);
      defined.set(name, line);
      if (v !== undefined) symbols.set(name, v);
    };
    const emit = (b: number, line: number) => {
      if (pc > 0xffff) throw new AsmError(line, "code runs past 64 KiB.");
      if (bytes.has(pc)) throw new AsmError(line, `code overlaps at ${pc.toString(16).toUpperCase()}H.`);
      bytes.set(pc, b & 255);
      pc++;
      top = Math.max(top, pc);
    };
    let ended = false;
    listing = [];
    for (const st of statements) {
      if (ended) break;
      if (st.label) define(st.label, pc, st.line, pass > 0);
      if (!st.op) continue;
      const line = st.line;
      if (st.name) {
        const v = evaluate(st.args, scopeAt(line));
        if (v === undefined) pending = true;
        define(st.name, v, line, st.op === "SET" || pass > 0);
        continue;
      }
      switch (st.op) {
        case "ORG": { pc = value(st.args, line); continue; }
        case "END": ended = true; continue;
        case "USING": case "NAME": case "CSEG": case "PUBLIC": case "EXTRN": case "RSEG": continue;
        case "DB": {
          for (const item of splitOperands(st.args)) {
            if (/^(['"]).*\1$/.test(item) && item.length > 3) { for (const ch of item.slice(1, -1)) emit(ch.charCodeAt(0), line); }
            else emit(value(item, line), line);
          }
          continue;
        }
        case "DW": { for (const item of splitOperands(st.args)) { const v = value(item, line); emit(v >>> 8, line); emit(v, line); } continue; }
        case "DS": { pc += value(st.args, line); continue; }
      }
      const options = forms.get(st.op);
      if (!options) throw new AsmError(line, `"${st.op}" is not an 8051 instruction or directive.`);
      const operands = st.args ? splitOperands(st.args).map(classify) : [];
      // A plain "A" also matches a direct-address slot as ACC; prefer exact forms first.
      const form = options.find((f) => f.ops.length === operands.length && f.ops.every((k, i) => k === operands[i].kind))
        ?? options.find((f) => f.ops.length === operands.length && f.ops.every((k, i) => k === operands[i].kind || (k === "expr" && operands[i].kind === "A")));
      if (!form) throw new AsmError(line, `${st.op} does not take ${operands.length ? operands.map((o) => o.kind === "expr" ? "an address" : o.kind).join(", ") : "no operands"} here.`);
      const start = pc, size = formSize(form);
      const after = start + size;
      const reg = operands.find((o) => o.kind === "Rn" || o.kind === "@Ri")?.reg ?? 0;
      const fields: number[] = [];
      let opcode = form.code + (form.addReg ? reg : 0);
      form.fields.forEach((field, i) => {
        if (field === "-") return;
        const o = operands[i];
        const text = o.kind === "A" ? "ACC" : o.text!;
        const v = value(text, line);
        const range = (lo: number, hi: number, what: string) => { if (final && !pending && (v < lo || v > hi)) throw new AsmError(line, `${what} ${v} is out of range.`); };
        if (field === "d") { range(0, 255, "direct address"); fields.push(v & 255); }
        else if (field === "b") { range(0, 255, "bit address"); fields.push(v & 255); }
        else if (field === "i") { range(-256, 255, "immediate value"); fields.push(v & 255); }
        else if (field === "w") { range(-65536, 65535, "16-bit value"); fields.push((v >>> 8) & 255, v & 255); }
        else if (field === "l") { range(0, 65535, "address"); fields.push((v >>> 8) & 255, v & 255); }
        else if (field === "a") {
          if (final && !pending && (v & 0xf800) !== (after & 0xf800)) throw new AsmError(line, "AJMP/ACALL target is outside the current 2 KiB page.");
          opcode |= ((v >>> 8) & 7) << 5;
          fields.push(v & 255);
        } else if (field === "r") {
          const offset = v - after;
          if (final && !pending && (offset < -128 || offset > 127)) throw new AsmError(line, `jump target is ${offset} bytes away; a relative jump reaches -128 to 127.`);
          fields.push(offset & 255);
        }
      });
      // MOV direct,direct stores the source address before the destination.
      if (form.code === 0x85) fields.reverse();
      listing.push({ address: start, size, line, mnemonic: st.op === "JMP" && form.code === 0x02 ? "LJMP" : st.op === "CALL" ? "LCALL" : st.op });
      emit(opcode, line);
      for (const b of fields) emit(b, line);
    }
    image = new Uint8Array(top);
    image.fill(0xff);
    for (const [address, b] of bytes) image[address] = b;
  }
  if (pending) throw new AsmError(0, "some symbols could not be resolved.");
  if (!image.length) throw new AsmError(0, "the program contains no code.");
  return { code: image, symbols, listing };
}
