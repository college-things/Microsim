// Arithmetic expressions: numbers with engineering suffixes, parameter values and
// behavioural source functions. Expressions compile to closures over a Float64Array
// of variables, so evaluation allocates nothing; derivatives are symbolic.

export class ExprError extends Error {}

export type Ast =
  | { k: "n"; v: number }
  | { k: "v"; i: number }
  | { k: "neg"; a: Ast }
  | { k: "not"; a: Ast }
  | { k: "b"; op: BinOp; a: Ast; b: Ast }
  | { k: "f"; name: string; args: Ast[] }
  /** Variable computed by the host from arg, such as ddt(); its derivative is gain * d(arg). */
  | { k: "dv"; i: number; arg: Ast; gain: Ast };

export type BinOp =
  | "+" | "-" | "*" | "/" | "%" | "^"
  | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||";

export type Evaluator = (vars: Float64Array) => number;

export interface ExprResolver {
  /** Resolve a bare identifier; return null when unknown. */
  ident(name: string): Ast | null;
  /** Resolve v(...) and i(...) probes; absent in pure parameter expressions. */
  probe?(fn: "v" | "i", args: string[]): Ast;
  /** User-defined functions and host functions such as ddt(); null when not handled. */
  call?(name: string, args: Ast[]): Ast | null;
}

/** Piecewise-linear interpolation of x, flat outside the table. */
export function pwlAst(x: Ast, xs: number[], ys: Ast[]): Ast {
  const n = xs.length;
  let out: Ast = ys[n - 1]!;
  for (let i = n - 1; i >= 1; i--) {
    const dx = xs[i]! - xs[i - 1]!;
    const seg: Ast = dx > 0
      ? { k: "b", op: "+", a: ys[i - 1]!, b: { k: "b", op: "*", a: { k: "b", op: "/", a: { k: "b", op: "-", a: ys[i]!, b: ys[i - 1]! }, b: { k: "n", v: dx } }, b: { k: "b", op: "-", a: x, b: { k: "n", v: xs[i - 1]! } } } }
      : ys[i]!;
    out = { k: "f", name: "if", args: [{ k: "b", op: "<", a: x, b: { k: "n", v: xs[i]! } }, seg, out] };
  }
  return { k: "f", name: "if", args: [{ k: "b", op: "<", a: x, b: { k: "n", v: xs[0]! } }, ys[0]!, out] };
}

const SUFFIX_RE = /^(meg|mil|[fpnumkgt])/;

/** Multiplier for the alphabetic tail of a number; trailing unit letters are ignored. */
export function suffixScale(tail: string): number {
  const m = SUFFIX_RE.exec(tail.toLowerCase());
  if (!m) return 1;
  switch (m[1]) {
    case "f": return 1e-15;
    case "p": return 1e-12;
    case "n": return 1e-9;
    case "u": return 1e-6;
    case "m": return 1e-3;
    case "k": return 1e3;
    case "meg": return 1e6;
    case "g": return 1e9;
    case "t": return 1e12;
    case "mil": return 25.4e-6;
    default: return 1;
  }
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;

/** Parse a complete SPICE number such as 10kOhm, 1.5e-3, 4.7uF. Returns null if not numeric. */
export function parseNumber(tok: string): number | null {
  const m = NUMBER_RE.exec(tok);
  if (!m) return null;
  const tail = tok.slice(m[0].length);
  if (tail !== "" && !/^[a-z_%]+$/i.test(tail)) return null;
  return parseFloat(m[0]) * suffixScale(tail);
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c) || c === "." || c === "$" || c === "#";
}

const FUNC_ARITY: Record<string, [number, number]> = {
  sin: [1, 1], cos: [1, 1], tan: [1, 1], asin: [1, 1], acos: [1, 1], atan: [1, 1],
  sinh: [1, 1], cosh: [1, 1], tanh: [1, 1], exp: [1, 1], ln: [1, 1], log: [1, 1],
  log10: [1, 1], sqrt: [1, 1], abs: [1, 1], u: [1, 1], uramp: [1, 1], sgn: [1, 1],
  floor: [1, 1], ceil: [1, 1], round: [1, 1], min: [2, 16], max: [2, 16], pow: [2, 2],
  pwr: [2, 2], atan2: [2, 2], if: [3, 3], ternary_fcn: [3, 3], limit: [3, 3], stp: [1, 1], pwrs: [2, 2],
  asinh: [1, 1], acosh: [1, 1], atanh: [1, 1], arctan: [1, 1], fabs: [1, 1], table: [3, 512],
};

const NUMBER_AT = /(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iy;

class Parser {
  private p = 0;
  constructor(private readonly s: string, private readonly r: ExprResolver) {}

  parse(): Ast {
    const a = this.ternary();
    this.ws();
    if (this.p < this.s.length) {
      throw new ExprError(`unexpected '${this.s.slice(this.p, this.p + 8)}' in expression '${this.s}'`);
    }
    return a;
  }

  private ws(): void {
    while (this.p < this.s.length && /\s/.test(this.s[this.p]!)) this.p++;
  }

  private eat(tok: string): boolean {
    this.ws();
    if (this.s.startsWith(tok, this.p)) {
      this.p += tok.length;
      return true;
    }
    return false;
  }

  private ternary(): Ast {
    const c = this.or();
    if (this.eat("?")) {
      const a = this.ternary();
      if (!this.eat(":")) throw new ExprError(`expected ':' in expression '${this.s}'`);
      const b = this.ternary();
      return { k: "f", name: "if", args: [c, a, b] };
    }
    return c;
  }

  private or(): Ast {
    let a = this.and();
    while (this.eat("||") || this.eat("|")) a = { k: "b", op: "||", a, b: this.and() };
    return a;
  }

  private and(): Ast {
    let a = this.equality();
    while (this.eat("&&") || this.eat("&")) a = { k: "b", op: "&&", a, b: this.equality() };
    return a;
  }

  private equality(): Ast {
    let a = this.relational();
    for (;;) {
      if (this.eat("==")) a = { k: "b", op: "==", a, b: this.relational() };
      else if (this.eat("!=")) a = { k: "b", op: "!=", a, b: this.relational() };
      else return a;
    }
  }

  private relational(): Ast {
    let a = this.additive();
    for (;;) {
      if (this.eat("<=")) a = { k: "b", op: "<=", a, b: this.additive() };
      else if (this.eat(">=")) a = { k: "b", op: ">=", a, b: this.additive() };
      else if (this.eat("<")) a = { k: "b", op: "<", a, b: this.additive() };
      else if (this.eat(">")) a = { k: "b", op: ">", a, b: this.additive() };
      else return a;
    }
  }

  private additive(): Ast {
    let a = this.multiplicative();
    for (;;) {
      if (this.eat("+")) a = { k: "b", op: "+", a, b: this.multiplicative() };
      else if (this.eat("-")) a = { k: "b", op: "-", a, b: this.multiplicative() };
      else return a;
    }
  }

  private multiplicative(): Ast {
    let a = this.unary();
    for (;;) {
      this.ws();
      if (this.s.startsWith("**", this.p)) return a;
      if (this.eat("*")) a = { k: "b", op: "*", a, b: this.unary() };
      else if (this.eat("/")) a = { k: "b", op: "/", a, b: this.unary() };
      else if (this.eat("%")) a = { k: "b", op: "%", a, b: this.unary() };
      else return a;
    }
  }

  private unary(): Ast {
    if (this.eat("-")) return { k: "neg", a: this.unary() };
    if (this.eat("+")) return this.unary();
    this.ws();
    if ((this.s[this.p] === "!" && this.s[this.p + 1] !== "=") || this.s[this.p] === "~") {
      this.p++;
      return { k: "not", a: this.unary() };
    }
    return this.power();
  }

  private power(): Ast {
    const a = this.atom();
    if (this.eat("^") || this.eat("**")) return { k: "b", op: "^", a, b: this.unary() };
    return a;
  }

  private atom(): Ast {
    this.ws();
    const s = this.s;
    const c = s[this.p];
    if (c === undefined) throw new ExprError(`unexpected end of expression '${s}'`);
    if (c === "(") {
      this.p++;
      const a = this.ternary();
      if (!this.eat(")")) throw new ExprError(`missing ')' in expression '${s}'`);
      return a;
    }
    if (c === "{") {
      this.p++;
      const a = this.ternary();
      if (!this.eat("}")) throw new ExprError(`missing '}' in expression '${s}'`);
      return a;
    }
    if (isDigit(c) || c === ".") return this.number();
    if (isIdentStart(c)) return this.identOrCall();
    throw new ExprError(`unexpected '${c}' in expression '${s}'`);
  }

  private number(): Ast {
    NUMBER_AT.lastIndex = this.p;
    const m = NUMBER_AT.exec(this.s);
    if (!m) throw new ExprError(`bad number in expression '${this.s.slice(0, 80)}'`);
    this.p += m[0].length;
    const start = this.p;
    while (this.p < this.s.length && /[a-z_]/i.test(this.s[this.p]!)) this.p++;
    return { k: "n", v: parseFloat(m[0]) * suffixScale(this.s.slice(start, this.p)) };
  }

  private identOrCall(): Ast {
    const s = this.s;
    const start = this.p;
    while (this.p < s.length && isIdentPart(s[this.p]!)) this.p++;
    const name = s.slice(start, this.p).toLowerCase();
    const save = this.p;
    this.ws();
    if (s[this.p] !== "(") {
      this.p = save;
      const v = this.r.ident(name);
      if (v) return v;
      if (name === "pi") return { k: "n", v: Math.PI };
      throw new ExprError(`unknown name '${name}' in expression '${s}'`);
    }
    if ((name === "v" || name === "i") && this.r.probe) {
      const end = s.indexOf(")", this.p);
      if (end < 0) throw new ExprError(`missing ')' in expression '${s}'`);
      const args = s
        .slice(this.p + 1, end)
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.length > 0);
      this.p = end + 1;
      return this.r.probe(name, args);
    }
    this.p++;
    const args: Ast[] = [];
    if (!this.eat(")")) {
      for (;;) {
        args.push(this.ternary());
        if (this.eat(")")) break;
        if (!this.eat(",")) throw new ExprError(`expected ',' or ')' in expression '${s}'`);
      }
    }
    const hosted = this.r.call ? this.r.call(name, args) : null;
    if (hosted) return hosted;
    const arity = FUNC_ARITY[name];
    if (!arity) throw new ExprError(`unknown function '${name}' in expression '${s}'`);
    if (args.length < arity[0] || args.length > arity[1]) {
      throw new ExprError(`wrong number of arguments for ${name}() in expression '${s}'`);
    }
    if ((name === "min" || name === "max") && args.length > 2) {
      return args.reduce((acc, x) => ({ k: "f", name, args: [acc, x] }));
    }
    const a0 = args[0]!;
    const a1 = args[1]!;
    switch (name) {
      case "limit": {
        // PSPICE LIMIT(x, min, max), tolerating the bounds in either order.
        const lo: Ast = { k: "f", name: "min", args: [a1, args[2]!] };
        const hi: Ast = { k: "f", name: "max", args: [a1, args[2]!] };
        return { k: "f", name: "max", args: [lo, { k: "f", name: "min", args: [a0, hi] }] };
      }
      case "pwr":
        return { k: "b", op: "^", a: { k: "f", name: "abs", args: [a0] }, b: a1 };
      case "pwrs":
        return {
          k: "b",
          op: "*",
          a: { k: "f", name: "sgn", args: [a0] },
          b: { k: "b", op: "^", a: { k: "f", name: "abs", args: [a0] }, b: a1 },
        };
      case "ternary_fcn":
        return { k: "f", name: "if", args };
      case "arctan":
        return { k: "f", name: "atan", args };
      case "fabs":
        return { k: "f", name: "abs", args };
      case "table": {
        const xs: number[] = [];
        const ys: Ast[] = [];
        if (args.length % 2 !== 1) throw new ExprError(`table() needs x then x/y pairs in '${s}'`);
        for (let i = 1; i + 1 < args.length; i += 2) {
          const xi = args[i]!;
          if (!isConst(xi)) throw new ExprError(`table() x values must be constants in '${s}'`);
          xs.push(evalConst(xi));
          ys.push(args[i + 1]!);
        }
        return pwlAst(a0, xs, ys);
      }
    }
    return { k: "f", name, args };
  }
}

export function parseExpr(text: string, resolver: ExprResolver): Ast {
  return new Parser(text, resolver).parse();
}

const num = (v: number): Ast => ({ k: "n", v });
const ZERO = num(0);
const ONE = num(1);

function add(a: Ast, b: Ast): Ast {
  if (a.k === "n" && a.v === 0) return b;
  if (b.k === "n" && b.v === 0) return a;
  return { k: "b", op: "+", a, b };
}

function sub(a: Ast, b: Ast): Ast {
  if (b.k === "n" && b.v === 0) return a;
  if (a.k === "n" && a.v === 0) return { k: "neg", a: b };
  return { k: "b", op: "-", a, b };
}

function mul(a: Ast, b: Ast): Ast {
  if ((a.k === "n" && a.v === 0) || (b.k === "n" && b.v === 0)) return ZERO;
  if (a.k === "n" && a.v === 1) return b;
  if (b.k === "n" && b.v === 1) return a;
  return { k: "b", op: "*", a, b };
}

function div(a: Ast, b: Ast): Ast {
  if (a.k === "n" && a.v === 0) return ZERO;
  if (b.k === "n" && b.v === 1) return a;
  return { k: "b", op: "/", a, b };
}

const call = (name: string, ...args: Ast[]): Ast => ({ k: "f", name, args });

/** Symbolic partial derivative with respect to variable i. */
export function diff(e: Ast, i: number): Ast {
  return diffMemo(e, i, new Map());
}

/** Expressions share subtrees heavily after .func expansion, so each is differentiated once. */
function diffMemo(e: Ast, i: number, memo: Map<Ast, Ast>): Ast {
  const known = memo.get(e);
  if (known) return known;
  const d = diffNode(e, i, memo);
  memo.set(e, d);
  return d;
}

function diffNode(e: Ast, i: number, memo: Map<Ast, Ast>): Ast {
  const diff = (x: Ast, _i: number): Ast => diffMemo(x, i, memo);
  switch (e.k) {
    case "n":
      return ZERO;
    case "v":
      return e.i === i ? ONE : ZERO;
    case "neg": {
      const d = diff(e.a, i);
      return d === ZERO ? ZERO : { k: "neg", a: d };
    }
    case "not":
      return ZERO;
    case "dv":
      return mul(e.gain, diff(e.arg, i));
    case "b": {
      const da = diff(e.a, i);
      const db = diff(e.b, i);
      switch (e.op) {
        case "+": return add(da, db);
        case "-": return sub(da, db);
        case "*": return add(mul(da, e.b), mul(e.a, db));
        case "/":
          return sub(div(da, e.b), div(mul(e.a, db), mul(e.b, e.b)));
        case "%": return da;
        case "^": {
          let t = ZERO;
          if (da !== ZERO) {
            t = mul(mul(e.b, { k: "b", op: "^", a: e.a, b: sub(e.b, ONE) }), da);
          }
          if (db !== ZERO) t = add(t, mul(mul(e, call("ln", call("abs", e.a))), db));
          return t;
        }
        default:
          return ZERO;
      }
    }
    case "f":
      return diffCall(e.name, e.args, i, memo);
  }
}

function diffCall(name: string, args: Ast[], i: number, memo: Map<Ast, Ast>): Ast {
  const diff = (x: Ast, _i: number): Ast => diffMemo(x, i, memo);
  const a = args[0]!;
  const da = diff(a, i);
  switch (name) {
    case "if": {
      const d1 = diff(args[1]!, i);
      const d2 = diff(args[2]!, i);
      if (d1 === ZERO && d2 === ZERO) return ZERO;
      return call("if", a, d1, d2);
    }
    case "min":
    case "max": {
      const b = args[1]!;
      const db = diff(b, i);
      if (da === ZERO && db === ZERO) return ZERO;
      const op: BinOp = name === "min" ? "<" : ">";
      return call("if", { k: "b", op, a, b }, da, db);
    }
    case "pow":
    case "pwr":
      return diff({ k: "b", op: "^", a, b: args[1]! }, i);
    case "atan2": {
      const b = args[1]!;
      const db = diff(b, i);
      const den = add(mul(a, a), mul(b, b));
      return div(sub(mul(b, da), mul(a, db)), den);
    }
  }
  if (da === ZERO) return ZERO;
  switch (name) {
    case "sin": return mul(call("cos", a), da);
    case "cos": return { k: "neg", a: mul(call("sin", a), da) };
    case "tan": {
      const t = call("tan", a);
      return mul(add(ONE, mul(t, t)), da);
    }
    case "asin": return div(da, call("sqrt", sub(ONE, mul(a, a))));
    case "acos": return { k: "neg", a: div(da, call("sqrt", sub(ONE, mul(a, a)))) };
    case "atan": return div(da, add(ONE, mul(a, a)));
    case "sinh": return mul(call("cosh", a), da);
    case "cosh": return mul(call("sinh", a), da);
    case "tanh": {
      const t = call("cosh", a);
      return div(da, mul(t, t));
    }
    case "asinh": return div(da, call("sqrt", add(mul(a, a), ONE)));
    case "acosh": return div(da, call("sqrt", sub(mul(a, a), ONE)));
    case "atanh": return div(da, sub(ONE, mul(a, a)));
    case "exp": return mul(call("exp", a), da);
    case "ln": return mul(call("$inv", a), da);
    case "log":
    case "log10": return mul(num(1 / Math.LN10), mul(call("$inv", a), da));
    case "sqrt": return mul(call("$dsqrt", a), da);
    case "abs": return mul(call("sgn", a), da);
    case "uramp": return mul(call("u", a), da);
    default:
      return ZERO; // u, sgn, floor, ceil, round are piecewise constant
  }
}

// Derivative floors keep Jacobian entries in a range the pivoting can distinguish from zero.
const safeInv = (x: number): number => 1 / (Math.abs(x) < 1e-15 ? (x < 0 ? -1e-15 : 1e-15) : x);

const FN1: Record<string, (x: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: (x) => Math.asin(Math.max(-1, Math.min(1, x))),
  acos: (x) => Math.acos(Math.max(-1, Math.min(1, x))),
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: (x) => Math.atanh(Math.max(-1 + 1e-15, Math.min(1 - 1e-15, x))),
  stp: (x) => (x >= 0 ? 1 : 0),
  exp: (x) => Math.exp(x > 700 ? 700 : x),
  ln: (x) => Math.log(x < 1e-300 ? 1e-300 : x),
  log: (x) => Math.log10(x < 1e-300 ? 1e-300 : x),
  log10: (x) => Math.log10(x < 1e-300 ? 1e-300 : x),
  sqrt: (x) => Math.sqrt(x < 0 ? 0 : x),
  abs: Math.abs,
  u: (x) => (x > 0 ? 1 : 0),
  uramp: (x) => (x > 0 ? x : 0),
  sgn: (x) => (x > 0 ? 1 : x < 0 ? -1 : 0),
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  $inv: safeInv,
  $dsqrt: (x) => 0.5 / Math.sqrt(x < 1e-15 ? 1e-15 : x),
};

function powSafe(a: number, b: number): number {
  if (a >= 0 || Number.isInteger(b)) return Math.pow(a, b);
  return Math.pow(-a, b);
}

function isConst(e: Ast, memo = new Map<Ast, boolean>()): boolean {
  const known = memo.get(e);
  if (known !== undefined) return known;
  let out: boolean;
  switch (e.k) {
    case "n": out = true; break;
    case "v":
    case "dv": out = false; break;
    case "neg":
    case "not": out = isConst(e.a, memo); break;
    case "b": out = isConst(e.a, memo) && isConst(e.b, memo); break;
    case "f": out = e.args.every((x) => isConst(x, memo)); break;
  }
  memo.set(e, out);
  return out;
}

const NO_VARS = new Float64Array(0);

const enum Op {
  Var, Neg, Not, Add, Sub, Mul, Div, Mod, Pow, Lt, Le, Gt, Ge, Eq, Ne, And, Or, If, Min, Max, Atan2, Fn,
}

const FN_NAMES = Object.keys(FN1);
const FN_LIST = FN_NAMES.map((n) => FN1[n]!);

/**
 * Evaluates several expressions as one list of instructions over shared registers. Equal
 * subexpressions get one register, which matters because derivatives repeat most of a function:
 * a vendor model's expanded .func expression has a tree size far beyond its distinct terms.
 */
export class Tape {
  private readonly op: Uint8Array;
  private readonly ra: Int32Array;
  private readonly rb: Int32Array;
  private readonly rc: Int32Array;
  private readonly rd: Int32Array;
  private readonly regs: Float64Array;
  /** Register of each root, in the order given. */
  private readonly outs: Int32Array;

  constructor(roots: Ast[]) {
    const ops: number[] = [];
    const ra: number[] = [];
    const rb: number[] = [];
    const rc: number[] = [];
    const rd: number[] = [];
    const constants: number[] = [];
    const seen = new Map<Ast, number>();
    const keys = new Map<string, number>();
    let count = 0;
    const emit = (op: number, a: number, b: number, c: number): number => {
      const key = `${op}:${a}:${b}:${c}`;
      const known = keys.get(key);
      if (known !== undefined) return known;
      const reg = count++;
      ops.push(op);
      ra.push(a);
      rb.push(b);
      rc.push(c);
      rd.push(reg);
      keys.set(key, reg);
      return reg;
    };
    const constant = (v: number): number => {
      const key = `c:${v}`;
      const known = keys.get(key);
      if (known !== undefined) return known;
      const reg = count++;
      constants.push(reg, v);
      keys.set(key, reg);
      return reg;
    };
    const BIN: Record<BinOp, number> = {
      "+": Op.Add, "-": Op.Sub, "*": Op.Mul, "/": Op.Div, "%": Op.Mod, "^": Op.Pow, "<": Op.Lt, "<=": Op.Le,
      ">": Op.Gt, ">=": Op.Ge, "==": Op.Eq, "!=": Op.Ne, "&&": Op.And, "||": Op.Or,
    };
    const walk = (e: Ast): number => {
      const known = seen.get(e);
      if (known !== undefined) return known;
      let reg: number;
      switch (e.k) {
        case "n":
          reg = constant(e.v);
          break;
        case "v":
        case "dv":
          reg = emit(Op.Var, e.i, 0, 0);
          break;
        case "neg":
          reg = emit(Op.Neg, walk(e.a), 0, 0);
          break;
        case "not":
          reg = emit(Op.Not, walk(e.a), 0, 0);
          break;
        case "b":
          reg = emit(BIN[e.op], walk(e.a), walk(e.b), 0);
          break;
        case "f": {
          const args = e.args.map(walk);
          switch (e.name) {
            case "if":
              reg = emit(Op.If, args[0]!, args[1]!, args[2]!);
              break;
            case "min":
              reg = emit(Op.Min, args[0]!, args[1]!, 0);
              break;
            case "max":
              reg = emit(Op.Max, args[0]!, args[1]!, 0);
              break;
            case "pow":
            case "pwr":
              reg = emit(Op.Pow, args[0]!, args[1]!, 0);
              break;
            case "atan2":
              reg = emit(Op.Atan2, args[0]!, args[1]!, 0);
              break;
            default: {
              const fn = FN_NAMES.indexOf(e.name);
              if (fn < 0) throw new ExprError(`unknown function '${e.name}'`);
              reg = emit(Op.Fn, args[0]!, fn, 0);
            }
          }
        }
      }
      seen.set(e, reg);
      return reg;
    };
    const outs = roots.map(walk);
    this.op = Uint8Array.from(ops);
    this.ra = Int32Array.from(ra);
    this.rb = Int32Array.from(rb);
    this.rc = Int32Array.from(rc);
    this.rd = Int32Array.from(rd);
    this.outs = Int32Array.from(outs);
    this.regs = new Float64Array(count);
    for (let i = 0; i < constants.length; i += 2) this.regs[constants[i]!] = constants[i + 1]!;
  }

  run(v: Float64Array): void {
    const { op, ra, rb, rc, rd, regs: r } = this;
    for (let i = 0; i < op.length; i++) {
      const a = ra[i]!;
      const b = rb[i]!;
      let y: number;
      switch (op[i]) {
        case Op.Var: y = v[a]!; break;
        case Op.Neg: y = -r[a]!; break;
        case Op.Not: y = r[a] === 0 ? 1 : 0; break;
        case Op.Add: y = r[a]! + r[b]!; break;
        case Op.Sub: y = r[a]! - r[b]!; break;
        case Op.Mul: y = r[a]! * r[b]!; break;
        case Op.Div: y = r[a]! / r[b]!; break;
        case Op.Mod: y = r[a]! % r[b]!; break;
        case Op.Pow: y = powSafe(r[a]!, r[b]!); break;
        case Op.Lt: y = r[a]! < r[b]! ? 1 : 0; break;
        case Op.Le: y = r[a]! <= r[b]! ? 1 : 0; break;
        case Op.Gt: y = r[a]! > r[b]! ? 1 : 0; break;
        case Op.Ge: y = r[a]! >= r[b]! ? 1 : 0; break;
        case Op.Eq: y = r[a] === r[b] ? 1 : 0; break;
        case Op.Ne: y = r[a] !== r[b] ? 1 : 0; break;
        case Op.And: y = r[a] !== 0 && r[b] !== 0 ? 1 : 0; break;
        case Op.Or: y = r[a] !== 0 || r[b] !== 0 ? 1 : 0; break;
        case Op.If: y = r[a] !== 0 ? r[b]! : r[rc[i]!]!; break;
        case Op.Min: y = Math.min(r[a]!, r[b]!); break;
        case Op.Max: y = Math.max(r[a]!, r[b]!); break;
        case Op.Atan2: y = Math.atan2(r[a]!, r[b]!); break;
        default: y = FN_LIST[b]!(r[a]!);
      }
      r[rd[i]!] = y;
    }
  }

  /** Value of root k after run(). */
  out(k: number): number {
    return this.regs[this.outs[k]!]!;
  }
}

export function compile(e: Ast): Evaluator {
  const tape = new Tape([e]);
  return (v) => {
    tape.run(v);
    return tape.out(0);
  };
}

/** Evaluate an expression holding no variables. */
export function evalConst(e: Ast): number {
  return compile(e)(NO_VARS);
}
