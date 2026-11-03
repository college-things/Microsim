// Nonlinear semiconductor models from the published SPICE device equations:
// junction diode, Gummel-Poon BJT, Shichman-Hodges MOSFET (level 1) and JFET.

import { BOLTZMANN, CHARGE, Circuit, Device, type NoiseSink } from "./circuit";
import { Pair } from "./devices";

const K_OVER_Q = 1.380649e-23 / 1.602176634e-19;
const KELVIN = 273.15;

/** Flicker density KF |I|^AF / f; zero unless KF is given. */
function flicker(kf: number, af: number, current: number, f: number): number {
  if (kf <= 0 || f <= 0) return 0;
  return (kf * Math.pow(Math.max(Math.abs(current), 1e-38), af)) / f;
}

/** Silicon band gap in eV at T kelvin, from the usual empirical fit. */
function bandGap(t: number): number {
  return 1.16 - (7.02e-4 * t * t) / (t + 1108);
}

/** Junction potential at T, from the value at Tnom. */
function scaledVj(vj: number, t: number, tn: number): number {
  const ratio = t / tn;
  return vj * ratio - 3 * K_OVER_Q * t * Math.log(ratio) - (bandGap(tn) * ratio - bandGap(t));
}

/** Zero-bias depletion capacitance at T, from the value at Tnom. */
function scaledCj(cj: number, m: number, vj: number, vjT: number, t: number, tn: number): number {
  return cj * (1 + m * (4e-4 * (t - tn) + 1 - vjT / vj));
}

const MAX_EXP_ARG = 100;
const EXP_AT_MAX = Math.exp(MAX_EXP_ARG);

/** exp() that continues linearly above MAX_EXP_ARG, keeping values finite during Newton. */
function limexp(a: number): number {
  return a > MAX_EXP_ARG ? EXP_AT_MAX * (1 + a - MAX_EXP_ARG) : Math.exp(a);
}

/** Junction voltage limiter, keeping Newton steps on the exponential's usable range. */
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > vt + vt) {
    if (vold > 0) {
      const arg = (vnew - vold) / vt;
      if (arg > 0) return vold + vt * (2 + Math.log(arg - 2));
      return vold - vt * (2 + Math.log(2 - arg));
    }
    return vnew > 0 ? vt * Math.log(vnew / vt) : vcrit;
  }
  if (vnew < 0) {
    const arg = vold > 0 ? -vold - 1 : 2 * vold - 1;
    if (vnew < arg) return arg;
  }
  return vnew;
}

/** FET gate-voltage limiter around threshold. */
export function fetlim(vnew: number, vold: number, vto: number): number {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = vtsthi / 2 + 2;
  const vtox = vto + 3.5;
  const delv = vnew - vold;
  if (vold >= vto) {
    if (vold >= vtox) {
      if (delv <= 0) {
        if (vnew >= vtox) {
          if (-delv > vtstlo) return vold - vtstlo;
        } else {
          return Math.max(vnew, vto + 2);
        }
      } else if (delv >= vtsthi) {
        return vold + vtsthi;
      }
    } else if (delv <= 0) {
      return Math.max(vnew, vto - 0.5);
    } else {
      return Math.min(vnew, vto + 4);
    }
  } else if (delv <= 0) {
    if (-delv > vtsthi) return vold - vtsthi;
  } else {
    const vtemp = vto + 0.5;
    if (vnew <= vtemp) {
      if (delv > vtstlo) return vold + vtstlo;
    } else {
      return vtemp;
    }
  }
  return vnew;
}

/** FET drain-source voltage limiter. */
export function limvds(vnew: number, vold: number): number {
  if (vold >= 3.5) {
    if (vnew > vold) return Math.min(vnew, 3 * vold + 2);
    if (vnew < 3.5) return Math.max(vnew, 2);
    return vnew;
  }
  if (vnew > vold) return Math.min(vnew, 4);
  return Math.max(vnew, -0.5);
}

/** Depletion capacitance from the last depletion() call; avoids allocating a pair. */
let deplCap = 0;

/** Depletion charge with the usual forward-bias linearised capacitance above fc*vj. */
function depletion(v: number, cj0: number, vj: number, m: number, fc: number): number {
  if (cj0 === 0) {
    deplCap = 0;
    return 0;
  }
  const mm = Math.min(m, 0.99);
  const fcv = fc * vj;
  if (v < fcv) {
    const a = 1 - v / vj;
    const s = Math.pow(a, -mm);
    deplCap = cj0 * s;
    return ((cj0 * vj) * (1 - a * s)) / (1 - mm);
  }
  const f1 = (vj * (1 - Math.pow(1 - fc, 1 - mm))) / (1 - mm);
  const f2 = Math.pow(1 - fc, 1 + mm);
  const f3 = 1 - fc * (1 + mm);
  deplCap = (cj0 / f2) * (f3 + (mm * v) / vj);
  return cj0 * (f1 + (f3 * (v - fcv) + (mm / (2 * vj)) * (v * v - fcv * fcv)) / f2);
}

export interface DiodeParams {
  is: number;
  n: number;
  rs: number;
  cjo: number;
  vj: number;
  m: number;
  tt: number;
  bv: number;
  ibv: number;
  fc: number;
  tnom: number;
  xti: number;
  eg: number;
  kf: number;
  af: number;
}

export class Diode extends Device {
  private ai = 0;
  private readonly rsPair = new Pair();
  private readonly jn = new Pair();
  private readonly o: { state: number } = { state: 0 };
  private readonly nvt: number;
  private readonly vcrit: number;
  private readonly xbv: number;
  private readonly is: number;
  private readonly gs: number;
  private readonly cjo: number;
  private readonly vj: number;
  private v = 0;
  private id = 0;
  private gd = 0;
  private capd = 0;

  constructor(
    name: string,
    line: number,
    private readonly a: number,
    private readonly k: number,
    private readonly p: DiodeParams,
    area: number,
    tempC: number,
  ) {
    super(name, line);
    this.linear = false;
    const t = tempC + KELVIN;
    const tn = p.tnom + KELVIN;
    const vt = K_OVER_Q * t;
    const ratio = t / tn;
    this.is = p.is * area * Math.pow(ratio, p.xti / p.n) * Math.exp((p.eg / (p.n * vt)) * (ratio - 1));
    this.gs = p.rs > 0 ? area / p.rs : 0;
    this.vj = scaledVj(p.vj, t, tn);
    this.cjo = scaledCj(p.cjo * area, p.m, p.vj, this.vj, t, tn);
    this.nvt = p.n * vt;
    this.vcrit = this.nvt * Math.log(this.nvt / (Math.SQRT2 * this.is));
    this.xbv = this.breakdownVoltage();
  }

  /** Effective breakdown voltage so that reverse current equals IBV at BV. */
  private breakdownVoltage(): number {
    const { bv, ibv } = this.p;
    if (!Number.isFinite(bv)) return Infinity;
    const cbv = ibv;
    if (cbv < (this.is * bv) / (this.nvt / this.p.n)) return bv;
    let xbv = bv - this.nvt * Math.log(1 + cbv / this.is);
    for (let i = 0; i < 25; i++) {
      xbv = bv - this.nvt * Math.log(cbv / this.is + 1 - xbv / this.nvt);
      const check = this.is * (Math.exp((bv - xbv) / this.nvt) - 1 + xbv / this.nvt);
      if (Math.abs(check - cbv) <= 1e-3 * cbv) break;
    }
    return xbv;
  }

  override allocate(c: Circuit): void {
    this.ai = this.gs > 0 ? c.internalNode(`${this.name}#a`) : this.a;
  }

  setup(c: Circuit): void {
    if (this.gs > 0) this.rsPair.setup(c, this.a, this.ai);
    this.jn.setup(c, this.ai, this.k);
    this.o.state = c.allocState(2);
  }

  load(c: Circuit): void {
    const x = c.x;
    const nvt = this.nvt;
    const gmin = c.gmin;
    let v = x[this.ai]! - x[this.k]!;
    let limited = false;
    if (c.initJct) {
      v = this.vcrit;
    } else if (c.iter > 0) {
      const xbv = this.xbv;
      let l: number;
      if (v < 0 && xbv < Infinity && v < Math.min(0, 10 * nvt - xbv)) {
        const u = pnjlim(-(v + xbv), -(this.v + xbv), nvt, this.vcrit);
        l = -(u + xbv);
      } else {
        l = pnjlim(v, this.v, nvt, this.vcrit);
      }
      if (l !== v) {
        limited = true;
        v = l;
        c.noncon++;
      }
    }

    let id: number;
    let gd: number;
    const is = this.is;
    if (v >= -3 * nvt) {
      const ev = limexp(v / nvt);
      id = is * (ev - 1) + gmin * v;
      gd = (is * ev) / nvt + gmin;
    } else if (v >= -this.xbv) {
      const a = (3 * nvt) / (v * Math.E);
      const a3 = a * a * a;
      id = -is * (1 + a3) + gmin * v;
      gd = (is * 3 * a3) / v + gmin;
    } else {
      const ev = limexp(-(this.xbv + v) / nvt);
      id = -is * ev + gmin * v;
      gd = (is * ev) / nvt + gmin;
    }

    if (c.iter > 0 && !limited && !c.initJct) {
      const hat = this.id + this.gd * (v - this.v);
      if (Math.abs(hat - id) > c.reltol * Math.max(Math.abs(hat), Math.abs(id)) + c.abstol) c.noncon++;
    }
    this.v = v;
    this.id = id;
    this.gd = gd;

    const p = this.p;
    const q = depletion(v, this.cjo, this.vj, p.m, p.fc) + p.tt * id;
    const cap = deplCap + p.tt * gd;
    this.capd = cap;
    const ic = c.integ(this.o.state, q);

    const g = gd + c.ag0 * cap;
    const ieq = id + ic - g * v;
    if (this.gs > 0) this.rsPair.add(c.vals, this.gs);
    this.jn.add(c.vals, g);
    c.rhs[this.ai]! -= ieq;
    c.rhs[this.k]! += ieq;
  }

  loadAc(c: Circuit): void {
    if (this.gs > 0) this.rsPair.add(c.vals, this.gs);
    this.jn.add(c.vals, this.gd);
    this.jn.add(c.imag, this.capd);
  }

  override noise(f: number, sink: NoiseSink): void {
    const kT4 = (4 * BOLTZMANN * this.nvt) / (this.p.n * K_OVER_Q);
    if (this.gs > 0) sink(this.name, this.a, this.ai, kT4 * this.gs);
    sink(this.name, this.ai, this.k, 2 * CHARGE * Math.abs(this.id) + flicker(this.p.kf, this.p.af, this.id, f));
  }
}

export interface BjtParams {
  type: number;
  is: number;
  bf: number;
  br: number;
  nf: number;
  nr: number;
  vaf: number;
  var: number;
  ikf: number;
  ikr: number;
  ise: number;
  ne: number;
  isc: number;
  nc: number;
  rb: number;
  rbm: number;
  re: number;
  rc: number;
  cje: number;
  vje: number;
  mje: number;
  cjc: number;
  vjc: number;
  mjc: number;
  fc: number;
  tf: number;
  tr: number;
  xtf: number;
  vtf: number;
  itf: number;
  xcjc: number;
  cjs: number;
  vjs: number;
  mjs: number;
  irb: number;
  tnom: number;
  xti: number;
  xtb: number;
  eg: number;
  kf: number;
  af: number;
}

export class Bjt extends Device {
  private cp = 0;
  private bp = 0;
  private ep = 0;
  private readonly rcP = new Pair();
  private readonly rbP = new Pair();
  private readonly reP = new Pair();
  private scc = 0;
  private scb = 0;
  private sce = 0;
  private sbc = 0;
  private sbb = 0;
  private sbe = 0;
  private sec = 0;
  private seb = 0;
  private see = 0;
  private oBe = 0;
  private oBc = 0;
  private oBx = 0;
  private oSub = 0;
  private readonly bxP = new Pair();
  private readonly subP = new Pair();
  private readonly vt: number;
  private readonly bf: number;
  private readonly br: number;
  private readonly vje: number;
  private readonly vjc: number;
  private readonly vjs: number;
  private readonly cjx: number;
  private readonly cjsT: number;
  private capBx = 0;
  private capSub = 0;

  private readonly is: number;
  private readonly ise: number;
  private readonly isc: number;
  private readonly oik: number;
  private readonly oikr: number;
  private readonly ova: number;
  private readonly ovb: number;
  private readonly gc: number;
  private readonly ge: number;
  private readonly rb: number;
  private readonly rbm: number;
  private readonly cje: number;
  private readonly cjc: number;
  private readonly vcritE: number;
  private readonly vcritC: number;

  private vbe = 0;
  private vbc = 0;
  private ic = 0;
  private ib = 0;
  // Small-signal values at the last load.
  private dIcBe = 0;
  private dIcBc = 0;
  private dIbBe = 0;
  private dIbBc = 0;
  private gx = 0;
  private capBe = 0;
  private capBc = 0;
  private capX = 0;

  constructor(
    name: string,
    line: number,
    private readonly c: number,
    private readonly b: number,
    private readonly e: number,
    private readonly p: BjtParams,
    area: number,
    tempC: number,
    private readonly sub: number,
  ) {
    super(name, line);
    this.linear = false;
    const t = tempC + KELVIN;
    const tn = p.tnom + KELVIN;
    const ratio = t / tn;
    const vt = K_OVER_Q * t;
    this.vt = vt;
    const gapTerm = (p.eg / vt) * (ratio - 1);
    const beta = Math.pow(ratio, p.xtb);
    this.bf = p.bf * beta;
    this.br = p.br * beta;
    this.is = p.is * area * Math.pow(ratio, p.xti) * Math.exp(gapTerm);
    this.ise = (p.ise * area * Math.pow(ratio, p.xti / p.ne) * Math.exp(gapTerm / p.ne)) / beta;
    this.isc = (p.isc * area * Math.pow(ratio, p.xti / p.nc) * Math.exp(gapTerm / p.nc)) / beta;
    this.vje = scaledVj(p.vje, t, tn);
    this.vjc = scaledVj(p.vjc, t, tn);
    this.vjs = scaledVj(p.vjs, t, tn);
    const cjcAll = scaledCj(p.cjc * area, p.mjc, p.vjc, this.vjc, t, tn);
    this.cjx = cjcAll * (1 - p.xcjc);
    this.cjsT = scaledCj(p.cjs * area, p.mjs, p.vjs, this.vjs, t, tn);
    this.oik = Number.isFinite(p.ikf) && p.ikf > 0 ? 1 / (p.ikf * area) : 0;
    this.oikr = Number.isFinite(p.ikr) && p.ikr > 0 ? 1 / (p.ikr * area) : 0;
    this.ova = Number.isFinite(p.vaf) && p.vaf > 0 ? 1 / p.vaf : 0;
    this.ovb = Number.isFinite(p.var) && p.var > 0 ? 1 / p.var : 0;
    this.gc = p.rc > 0 ? area / p.rc : 0;
    this.ge = p.re > 0 ? area / p.re : 0;
    this.rb = p.rb / area;
    this.rbm = p.rbm / area;
    this.cje = scaledCj(p.cje * area, p.mje, p.vje, this.vje, t, tn);
    this.cjc = cjcAll * p.xcjc;
    const vtf = p.nf * vt;
    const vtr = p.nr * vt;
    this.vcritE = vtf * Math.log(vtf / (Math.SQRT2 * this.is));
    this.vcritC = vtr * Math.log(vtr / (Math.SQRT2 * this.is));
  }

  override allocate(c: Circuit): void {
    this.cp = this.gc > 0 ? c.internalNode(`${this.name}#c`) : this.c;
    this.bp = this.rb > 0 ? c.internalNode(`${this.name}#b`) : this.b;
    this.ep = this.ge > 0 ? c.internalNode(`${this.name}#e`) : this.e;
  }

  setup(c: Circuit): void {
    if (this.gc > 0) this.rcP.setup(c, this.c, this.cp);
    if (this.rb > 0) this.rbP.setup(c, this.b, this.bp);
    if (this.ge > 0) this.reP.setup(c, this.e, this.ep);
    const m = c.mat;
    this.scc = m.slot(this.cp, this.cp);
    this.scb = m.slot(this.cp, this.bp);
    this.sce = m.slot(this.cp, this.ep);
    this.sbc = m.slot(this.bp, this.cp);
    this.sbb = m.slot(this.bp, this.bp);
    this.sbe = m.slot(this.bp, this.ep);
    this.sec = m.slot(this.ep, this.cp);
    this.seb = m.slot(this.ep, this.bp);
    this.see = m.slot(this.ep, this.ep);
    this.oBe = c.allocState(2);
    this.oBc = c.allocState(2);
    this.oBx = c.allocState(2);
    this.oSub = c.allocState(2);
    this.bxP.setup(c, this.b, this.cp);
    this.subP.setup(c, this.sub, this.cp);
  }

  private stampJunctions(m: Float64Array, dIcBe: number, dIcBc: number, dIbBe: number, dIbBc: number): void {
    // Terminal currents depend on vbe = Vb-Ve and vbc = Vb-Vc; the emitter row is -(c+b).
    m[this.scb]! += dIcBe + dIcBc;
    m[this.scc]! -= dIcBc;
    m[this.sce]! -= dIcBe;
    m[this.sbb]! += dIbBe + dIbBc;
    m[this.sbc]! -= dIbBc;
    m[this.sbe]! -= dIbBe;
    m[this.seb]! -= dIcBe + dIcBc + dIbBe + dIbBc;
    m[this.sec]! += dIcBc + dIbBc;
    m[this.see]! += dIcBe + dIbBe;
  }

  load(c: Circuit): void {
    const x = c.x;
    const p = this.p;
    const type = p.type;
    let vbe = type * (x[this.bp]! - x[this.ep]!);
    let vbc = type * (x[this.bp]! - x[this.cp]!);
    const vtf = p.nf * this.vt;
    const vtr = p.nr * this.vt;
    const gmin = c.gmin;
    let limited = false;
    if (c.initJct) {
      vbe = this.vcritE;
      vbc = 0;
    } else if (c.iter > 0) {
      const l1 = pnjlim(vbe, this.vbe, vtf, this.vcritE);
      const l2 = pnjlim(vbc, this.vbc, vtr, this.vcritC);
      if (l1 !== vbe || l2 !== vbc) {
        limited = true;
        vbe = l1;
        vbc = l2;
        c.noncon++;
      }
    }

    // Base-emitter junction and its leakage.
    let cbe: number;
    let gbe: number;
    let cben = 0;
    let gben = 0;
    if (vbe >= -5 * vtf) {
      const ev = limexp(vbe / vtf);
      cbe = this.is * (ev - 1) + gmin * vbe;
      gbe = (this.is * ev) / vtf + gmin;
      if (this.ise > 0) {
        const vtn = p.ne * this.vt;
        const en = limexp(vbe / vtn);
        cben = this.ise * (en - 1) + gmin * vbe;
        gben = (this.ise * en) / vtn + gmin;
      }
    } else {
      gbe = -this.is / vbe + gmin;
      cbe = gbe * vbe;
      if (this.ise > 0) {
        gben = -this.ise / vbe + gmin;
        cben = gben * vbe;
      }
    }

    // Base-collector junction and its leakage.
    let cbc: number;
    let gbc: number;
    let cbcn = 0;
    let gbcn = 0;
    if (vbc >= -5 * vtr) {
      const ev = limexp(vbc / vtr);
      cbc = this.is * (ev - 1) + gmin * vbc;
      gbc = (this.is * ev) / vtr + gmin;
      if (this.isc > 0) {
        const vtn = p.nc * this.vt;
        const en = limexp(vbc / vtn);
        cbcn = this.isc * (en - 1) + gmin * vbc;
        gbcn = (this.isc * en) / vtn + gmin;
      }
    } else {
      gbc = -this.is / vbc + gmin;
      cbc = gbc * vbc;
      if (this.isc > 0) {
        gbcn = -this.isc / vbc + gmin;
        cbcn = gbcn * vbc;
      }
    }

    // Normalised base charge.
    const q1 = 1 / (1 - this.ova * vbc - this.ovb * vbe);
    let qb: number;
    let dqbBe: number;
    let dqbBc: number;
    if (this.oik === 0 && this.oikr === 0) {
      qb = q1;
      dqbBe = q1 * q1 * this.ovb;
      dqbBc = q1 * q1 * this.ova;
    } else {
      const q2 = this.oik * cbe + this.oikr * cbc;
      const arg = Math.max(0, 1 + 4 * q2);
      const sq = arg > 0 ? Math.sqrt(arg) : 1;
      qb = (q1 * (1 + sq)) / 2;
      dqbBe = q1 * ((qb * this.ovb) + (this.oik * gbe) / sq);
      dqbBc = q1 * ((qb * this.ova) + (this.oikr * gbc) / sq);
    }

    // Transport current and terminal currents.
    const it = (cbe - cbc) / qb;
    const dItBe = (gbe - it * dqbBe) / qb;
    const dItBc = (-gbc - it * dqbBc) / qb;
    const ibc = cbc / this.br + cbcn;
    const gmu = gbc / this.br + gbcn;
    const gpi = gbe / this.bf + gben;
    let ic = it - ibc;
    let ib = cbe / this.bf + cben + ibc;
    const ibDc = ib;
    let dIcBe = dItBe;
    let dIcBc = dItBc - gmu;
    let dIbBe = gpi;
    let dIbBc = gmu;

    if (c.iter > 0 && !limited && !c.initJct) {
      const dvbe = vbe - this.vbe;
      const dvbc = vbc - this.vbc;
      const hatC = this.ic + this.dIcBe * dvbe + this.dIcBc * dvbc;
      const hatB = this.ib + this.dIbBe * dvbe + this.dIbBc * dvbc;
      if (
        Math.abs(hatC - ic) > c.reltol * Math.max(Math.abs(hatC), Math.abs(ic)) + c.abstol ||
        Math.abs(hatB - ib) > c.reltol * Math.max(Math.abs(hatB), Math.abs(ib)) + c.abstol
      ) {
        c.noncon++;
      }
    }

    this.vbe = vbe;
    this.vbc = vbc;
    this.ic = ic;
    this.ib = ib;
    this.dIcBe = dIcBe;
    this.dIcBc = dIcBc;
    this.dIbBe = dIbBe;
    this.dIbBc = dIbBc;

    // Base resistance, optionally modulated toward RBM by the base charge.
    if (this.rb > 0) {
      let r: number;
      if (p.irb > 0) {
        // Current-dependent crowding: the base resistance falls from RB toward RBM with base current.
        const a1 = Math.max(Math.abs(ibDc) / p.irb, 1e-9);
        const a2 = (-1 + Math.sqrt(1 + 14.59025 * a1)) / (2.4317 * Math.sqrt(a1));
        const tn = Math.tan(a2);
        r = this.rbm + (3 * (this.rb - this.rbm) * (tn - a2)) / (a2 * tn * tn);
      } else {
        r = this.rbm + (this.rb - this.rbm) / qb;
      }
      this.gx = 1 / r;
      this.rbP.add(c.vals, this.gx);
    }
    if (this.gc > 0) this.rcP.add(c.vals, this.gc);
    if (this.ge > 0) this.reP.add(c.vals, this.ge);

    // Charge storage: depletion plus diffusion, with TF scaled by the base charge.
    const tf = p.tf;
    const tr = p.tr;
    const qDepBe = depletion(vbe, this.cje, this.vje, p.mje, p.fc);
    const cDepBe = deplCap;
    const qDepBc = depletion(vbc, this.cjc, this.vjc, p.mjc, p.fc);
    const cDepBc = deplCap;
    // Transit time rises with current (XTF, ITF) and with base-collector reverse bias (VTF).
    let argtf = 0;
    let arg2 = 0;
    let arg3 = 0;
    if (tf > 0 && p.xtf > 0 && vbe > 0) {
      argtf = p.xtf;
      const ovtf = Number.isFinite(p.vtf) && p.vtf > 0 ? 1 / p.vtf : 0;
      if (ovtf !== 0) argtf *= Math.exp(Math.min(vbc * ovtf, 50));
      arg2 = argtf;
      if (p.itf > 0) {
        const f = cbe / (cbe + p.itf);
        argtf *= f * f;
        arg2 = argtf * (3 - 2 * f);
      }
      arg3 = cbe * argtf * ovtf;
    }
    const cbeTf = (cbe * (1 + argtf)) / qb;
    const qbeTotal = qDepBe + tf * cbeTf;
    const capBe = cDepBe + (tf * (gbe * (1 + arg2) - cbeTf * dqbBe)) / qb;
    const capX = (tf * (arg3 - cbeTf * dqbBc)) / qb;
    const qbcTotal = qDepBc + tr * cbc;
    const capBc = cDepBc + tr * gbc;
    this.capBe = capBe;
    this.capBc = capBc;
    this.capX = capX;
    const iqbe = c.integ(this.oBe, qbeTotal);
    const iqbc = c.integ(this.oBc, qbcTotal);
    const ag0 = c.ag0;

    // Parts of the junction capacitance beyond the internal base, as linearised branches.
    if (this.cjx > 0) {
      const vbx = type * (x[this.b]! - x[this.cp]!);
      const qbx = depletion(vbx, this.cjx, this.vjc, p.mjc, p.fc);
      this.capBx = deplCap;
      const ibx = c.integ(this.oBx, qbx);
      const g = ag0 * this.capBx;
      this.bxP.add(c.vals, g);
      const eq = type * (ibx - g * vbx);
      c.rhs[this.b]! -= eq;
      c.rhs[this.cp]! += eq;
    }
    if (this.cjsT > 0) {
      // Substrate junction, reverse biased in normal use: charge is a function of Vsub - Vc.
      const vsc = type * (x[this.sub]! - x[this.cp]!);
      const qs = depletion(vsc, this.cjsT, this.vjs, p.mjs, p.fc);
      this.capSub = deplCap;
      const isub = c.integ(this.oSub, qs);
      const g = ag0 * this.capSub;
      this.subP.add(c.vals, g);
      const eq = type * (isub - g * vsc);
      c.rhs[this.sub]! -= eq;
      c.rhs[this.cp]! += eq;
    }

    ib += iqbe + iqbc;
    ic -= iqbc;
    dIbBe += ag0 * capBe;
    dIbBc += ag0 * (capX + capBc);
    dIcBc -= ag0 * capBc;

    this.stampJunctions(c.vals, dIcBe, dIcBc, dIbBe, dIbBc);

    const ieqC = type * (ic - dIcBe * vbe - dIcBc * vbc);
    const ieqB = type * (ib - dIbBe * vbe - dIbBc * vbc);
    const rhs = c.rhs;
    rhs[this.cp]! -= ieqC;
    rhs[this.bp]! -= ieqB;
    rhs[this.ep]! += ieqC + ieqB;
  }

  loadAc(c: Circuit): void {
    if (this.rb > 0) this.rbP.add(c.vals, this.gx);
    if (this.gc > 0) this.rcP.add(c.vals, this.gc);
    if (this.ge > 0) this.reP.add(c.vals, this.ge);
    this.stampJunctions(c.vals, this.dIcBe, this.dIcBc, this.dIbBe, this.dIbBc);
    this.stampJunctions(c.imag, 0, -this.capBc, this.capBe, this.capX + this.capBc);
    if (this.cjx > 0) this.bxP.add(c.imag, this.capBx);
    if (this.cjsT > 0) this.subP.add(c.imag, this.capSub);
  }

  override noise(f: number, sink: NoiseSink): void {
    const kT4 = 4 * BOLTZMANN * (this.vt / K_OVER_Q);
    if (this.gc > 0) sink(this.name, this.c, this.cp, kT4 * this.gc);
    if (this.rb > 0) sink(this.name, this.b, this.bp, kT4 * this.gx);
    if (this.ge > 0) sink(this.name, this.e, this.ep, kT4 * this.ge);
    sink(this.name, this.cp, this.ep, 2 * CHARGE * Math.abs(this.ic));
    sink(this.name, this.bp, this.ep, 2 * CHARGE * Math.abs(this.ib) + flicker(this.p.kf, this.p.af, this.ib, f));
  }
}

export interface MosParams {
  type: number;
  vto: number;
  kp: number;
  gamma: number;
  phi: number;
  lambda: number;
  rd: number;
  rs: number;
  cgso: number;
  cgdo: number;
  cgbo: number;
  cbd: number;
  cbs: number;
  pb: number;
  mj: number;
  fc: number;
  is: number;
  ld: number;
  tox: number;
  cj: number;
  cjsw: number;
  mjsw: number;
  js: number;
  tnom: number;
  kf: number;
  af: number;
}

/** Instance geometry beyond W and L. */
export interface MosGeometry {
  w: number;
  l: number;
  mult: number;
  ad: number;
  as: number;
  pd: number;
  ps: number;
  tempC: number;
}

const EPS_OX = 3.9 * 8.854187817e-12;

const MEYER_DC = { i: 0, g: 0 };
const MEYER_OUT = { i: 0, g: 0 };

export class Mosfet extends Device {
  private dp = 0;
  private sp = 0;
  private readonly rdP = new Pair();
  private readonly rsP = new Pair();
  private readonly gsP = new Pair();
  private readonly gdP = new Pair();
  private readonly gbP = new Pair();
  private readonly bdP = new Pair();
  private readonly bsP = new Pair();
  // Drain/source rows of the channel current.
  private dd = 0;
  private dg = 0;
  private ds = 0;
  private db = 0;
  private sd = 0;
  private sg = 0;
  private ss = 0;
  private sb = 0;
  private oGs = 0;
  private oGd = 0;
  private oGb = 0;
  private oBd = 0;
  private oBs = 0;

  private readonly beta: number;
  private readonly gd: number;
  private readonly gs: number;
  private readonly cgs: number;
  private readonly cgd: number;
  private readonly cgb: number;
  private readonly cbdz: number;
  private readonly cbsz: number;
  private readonly isD: number;
  private readonly isS: number;
  private readonly phi: number;
  private readonly sqrtPhi: number;
  private readonly vcrit: number;
  private readonly vt: number;
  private readonly vtoSigned: number;
  private readonly cox: number;
  private readonly swD: number;
  private readonly swS: number;
  private readonly flickerScale: number;
  private oMs = 0;
  private oMd = 0;
  private oMb = 0;
  private acGs = 0;
  private acGd = 0;
  private acGb = 0;

  private vgs = 0;
  private vds = 0;
  private vbs = 0;
  private von = 0;
  private mode = 1;
  private cd = 0;
  private gm = 0;
  private gds = 0;
  private gmbs = 0;
  private gbd = 0;
  private gbs = 0;
  private capBd = 0;
  private capBs = 0;

  constructor(
    name: string,
    line: number,
    private readonly d: number,
    private readonly g: number,
    private readonly s: number,
    private readonly b: number,
    private readonly p: MosParams,
    geo: MosGeometry,
  ) {
    super(name, line);
    this.linear = false;
    const { w, l, mult } = geo;
    const t = geo.tempC + KELVIN;
    const tn = p.tnom + KELVIN;
    const ratio = t / tn;
    const vt = K_OVER_Q * t;
    this.vt = vt;
    const leff = Math.max(l - 2 * p.ld, 1e-12);
    this.beta = (p.kp * Math.pow(ratio, -1.5) * w * mult) / leff;
    this.gd = p.rd > 0 ? mult / p.rd : 0;
    this.gs = p.rs > 0 ? mult / p.rs : 0;
    this.cgs = p.cgso * w * mult;
    this.cgd = p.cgdo * w * mult;
    this.cgb = p.cgbo * l * mult;
    this.cox = p.tox > 0 ? (EPS_OX / p.tox) * w * leff * mult : 0;
    // SPICE assumes 100 nm oxide for flicker noise when no TOX is given.
    this.flickerScale = 1 / ((EPS_OX / (p.tox > 0 ? p.tox : 1e-7)) * leff * leff);
    // Junctions: CBD and CBS win when given, otherwise CJ per area and CJSW per perimeter.
    this.cbdz = (p.cbd > 0 ? p.cbd : p.cj * geo.ad) * mult;
    this.cbsz = (p.cbs > 0 ? p.cbs : p.cj * geo.as) * mult;
    this.swD = p.cjsw * geo.pd * mult;
    this.swS = p.cjsw * geo.ps * mult;
    // Saturation current follows the band gap; JS per area replaces IS when it applies.
    const egT = bandGap(t);
    const egN = bandGap(tn);
    const isScale = Math.exp(-egT / vt + egN / (K_OVER_Q * tn));
    this.isD = (p.js > 0 && geo.ad > 0 ? p.js * geo.ad : p.is) * mult * isScale;
    this.isS = (p.js > 0 && geo.as > 0 ? p.js * geo.as : p.is) * mult * isScale;
    const phiT = ratio * p.phi - 2 * vt * (1.5 * Math.log(ratio) + (egN / (2 * K_OVER_Q * tn) - egT / (2 * vt)));
    this.phi = phiT > 0.01 ? phiT : 0.01;
    this.sqrtPhi = Math.sqrt(this.phi);
    // Threshold from the shifted built-in potential, with the body term in signed form.
    const shift = p.type * 0.5 * (this.phi - p.phi) + 0.5 * (egN - egT);
    const vbi = p.vto - p.type * p.gamma * Math.sqrt(p.phi) + shift;
    this.vtoSigned = p.type * (vbi + p.type * p.gamma * this.sqrtPhi);
    const isMin = Math.min(this.isD, this.isS);
    this.vcrit = vt * Math.log(vt / (Math.SQRT2 * isMin));
    this.von = this.vtoSigned;
  }

  override allocate(c: Circuit): void {
    this.dp = this.gd > 0 ? c.internalNode(`${this.name}#d`) : this.d;
    this.sp = this.gs > 0 ? c.internalNode(`${this.name}#s`) : this.s;
  }

  setup(c: Circuit): void {
    if (this.gd > 0) this.rdP.setup(c, this.d, this.dp);
    if (this.gs > 0) this.rsP.setup(c, this.s, this.sp);
    const m = c.mat;
    const { dp, sp, g, b } = this;
    this.dd = m.slot(dp, dp);
    this.dg = m.slot(dp, g);
    this.ds = m.slot(dp, sp);
    this.db = m.slot(dp, b);
    this.sd = m.slot(sp, dp);
    this.sg = m.slot(sp, g);
    this.ss = m.slot(sp, sp);
    this.sb = m.slot(sp, b);
    this.gsP.setup(c, g, sp);
    this.gdP.setup(c, g, dp);
    this.gbP.setup(c, g, b);
    this.bdP.setup(c, b, dp);
    this.bsP.setup(c, b, sp);
    this.oGs = c.allocState(2);
    this.oGd = c.allocState(2);
    this.oGb = c.allocState(2);
    this.oBd = c.allocState(2);
    this.oBs = c.allocState(2);
    // Meyer gate charges: charge, current, half capacitance and voltage for each.
    this.oMs = c.allocState(4);
    this.oMd = c.allocState(4);
    this.oMb = c.allocState(4);
  }

  /** Charge from averaging the Meyer half capacitances across the step, as SPICE does. */
  private meyer(c: Circuit, o: number, half: number, v: number): { i: number; g: number } {
    const st1 = c.st1;
    const st0 = c.st0;
    st0[o + 2] = half;
    st0[o + 3] = v;
    if (c.ag0 === 0) {
      c.integ(o, 2 * half * v);
      return MEYER_DC;
    }
    const avg = half + st1[o + 2]!;
    const q = st1[o]! + avg * (v - st1[o + 3]!);
    const i = c.integ(o, q);
    MEYER_OUT.i = i;
    MEYER_OUT.g = c.ag0 * avg;
    return MEYER_OUT;
  }

  private stampChannel(m: Float64Array, gm: number, gds: number, gmbs: number): void {
    // Channel current flows effective drain to effective source; reverse mode swaps the rows.
    const sum = gds + gm + gmbs;
    if (this.mode > 0) {
      m[this.dd]! += gds;
      m[this.dg]! += gm;
      m[this.ds]! -= sum;
      m[this.db]! += gmbs;
      m[this.sd]! -= gds;
      m[this.sg]! -= gm;
      m[this.ss]! += sum;
      m[this.sb]! -= gmbs;
    } else {
      m[this.ss]! += gds;
      m[this.sg]! += gm;
      m[this.sd]! -= sum;
      m[this.sb]! += gmbs;
      m[this.ds]! -= gds;
      m[this.dg]! -= gm;
      m[this.dd]! += sum;
      m[this.db]! -= gmbs;
    }
  }

  load(c: Circuit): void {
    const x = c.x;
    const p = this.p;
    const type = p.type;
    let vbs = type * (x[this.b]! - x[this.sp]!);
    let vgs = type * (x[this.g]! - x[this.sp]!);
    let vds = type * (x[this.dp]! - x[this.sp]!);
    let limited = false;

    const VT_T = this.vt;
    if (c.initJct) {
      vbs = -1;
      vgs = this.vtoSigned;
      vds = 0;
    } else if (c.iter > 0) {
      const vbs0 = vbs;
      const vgs0 = vgs;
      const vds0 = vds;
      const vgdOld = this.vgs - this.vds;
      let vgd = vgs - vds;
      if (this.vds >= 0) {
        vgs = fetlim(vgs, this.vgs, this.von);
        vds = vgs - vgd;
        vds = limvds(vds, this.vds);
      } else {
        vgd = fetlim(vgd, vgdOld, this.von);
        vds = vgs - vgd;
        vds = -limvds(-vds, -this.vds);
        vgs = vgd + vds;
      }
      if (vds >= 0) {
        vbs = pnjlim(vbs, this.vbs, VT_T, this.vcrit);
      } else {
        const vbd = pnjlim(vbs - vds, this.vbs - this.vds, VT_T, this.vcrit);
        vbs = vbd + vds;
      }
      // vds is rebuilt through vgd above, so compare with a rounding margin.
      if (Math.abs(vbs - vbs0) + Math.abs(vgs - vgs0) + Math.abs(vds - vds0) > 1e-12) {
        limited = true;
        c.noncon++;
      } else {
        vbs = vbs0;
        vgs = vgs0;
        vds = vds0;
      }
    }

    const vbd = vbs - vds;
    const vgd = vgs - vds;

    // Bulk junctions.
    let gbs: number;
    let cbs: number;
    if (vbs <= 0) {
      gbs = this.isS / VT_T + c.gmin;
      cbs = gbs * vbs;
    } else {
      const ev = limexp(vbs / VT_T);
      gbs = (this.isS * ev) / VT_T + c.gmin;
      cbs = this.isS * (ev - 1) + c.gmin * vbs;
    }
    let gbd: number;
    let cbd: number;
    if (vbd <= 0) {
      gbd = this.isD / VT_T + c.gmin;
      cbd = gbd * vbd;
    } else {
      const ev = limexp(vbd / VT_T);
      gbd = (this.isD * ev) / VT_T + c.gmin;
      cbd = this.isD * (ev - 1) + c.gmin * vbd;
    }

    // Channel current in the effective (drain high) frame.
    const mode = vds >= 0 ? 1 : -1;
    const vgsE = mode > 0 ? vgs : vgd;
    const vdsE = mode > 0 ? vds : -vds;
    const vbsE = mode > 0 ? vbs : vbd;
    let sarg: number;
    if (vbsE <= 0) {
      sarg = Math.sqrt(this.phi - vbsE);
    } else {
      sarg = this.sqrtPhi - vbsE / (2 * this.sqrtPhi);
      if (sarg < 0) sarg = 0;
    }
    const von = this.vtoSigned + p.gamma * (sarg - this.sqrtPhi);
    const vgst = vgsE - von;
    const arg = sarg > 0 ? p.gamma / (2 * sarg) : 0;
    let cd = 0;
    let gm = 0;
    let gds = 0;
    let gmbs = 0;
    if (vgst > 0) {
      const betap = this.beta * (1 + p.lambda * vdsE);
      if (vgst <= vdsE) {
        cd = 0.5 * betap * vgst * vgst;
        gm = betap * vgst;
        gds = 0.5 * p.lambda * this.beta * vgst * vgst;
      } else {
        cd = betap * vdsE * (vgst - 0.5 * vdsE);
        gm = betap * vdsE;
        gds = betap * (vgst - vdsE) + p.lambda * this.beta * vdsE * (vgst - 0.5 * vdsE);
      }
      gmbs = gm * arg;
    }

    if (c.iter > 0 && !limited && !c.initJct && mode === this.mode) {
      const dg = vgsE - (mode > 0 ? this.vgs : this.vgs - this.vds);
      const dd = vdsE - (mode > 0 ? this.vds : -this.vds);
      const db = vbsE - (mode > 0 ? this.vbs : this.vbs - this.vds);
      const hat = this.cd + this.gm * dg + this.gds * dd + this.gmbs * db;
      if (Math.abs(hat - cd) > c.reltol * Math.max(Math.abs(hat), Math.abs(cd)) + c.abstol) c.noncon++;
    }

    this.vgs = vgs;
    this.vds = vds;
    this.vbs = vbs;
    this.von = von;
    this.mode = mode;
    this.cd = cd;
    this.gm = gm;
    this.gds = gds;
    this.gmbs = gmbs;
    this.gbd = gbd;
    this.gbs = gbs;

    const m = c.vals;
    const rhs = c.rhs;
    const { dp, sp, g, b } = this;
    if (this.gd > 0) this.rdP.add(m, this.gd);
    if (this.gs > 0) this.rsP.add(m, this.gs);

    this.stampChannel(m, gm, gds, gmbs);
    const ieq = type * (cd - gm * vgsE - gds * vdsE - gmbs * vbsE);
    const nd = mode > 0 ? dp : sp;
    const ns = mode > 0 ? sp : dp;
    rhs[nd]! -= ieq;
    rhs[ns]! += ieq;

    const ag0 = c.ag0;

    // Bulk junction currents plus their depletion charge.
    let qbd = depletion(vbd, this.cbdz, p.pb, p.mj, p.fc);
    this.capBd = deplCap;
    qbd += depletion(vbd, this.swD, p.pb, p.mjsw, p.fc);
    this.capBd += deplCap;
    let qbs = depletion(vbs, this.cbsz, p.pb, p.mj, p.fc);
    this.capBs = deplCap;
    qbs += depletion(vbs, this.swS, p.pb, p.mjsw, p.fc);
    this.capBs += deplCap;
    const iqbd = c.integ(this.oBd, qbd);
    const iqbs = c.integ(this.oBs, qbs);
    const gBd = gbd + ag0 * this.capBd;
    const gBs = gbs + ag0 * this.capBs;
    this.bdP.add(m, gBd);
    this.bsP.add(m, gBs);
    const eqBd = type * (cbd + iqbd - gBd * vbd);
    const eqBs = type * (cbs + iqbs - gBs * vbs);
    rhs[b]! -= eqBd + eqBs;
    rhs[dp]! += eqBd;
    rhs[sp]! += eqBs;

    // Overlap capacitors are linear; no Meyer channel capacitance in this model.
    const vgb = vgs - vbs;
    if (this.cgs > 0) {
      const i = c.integ(this.oGs, this.cgs * vgs);
      const gc = ag0 * this.cgs;
      this.gsP.add(m, gc);
      const eq = type * (i - gc * vgs);
      rhs[g]! -= eq;
      rhs[sp]! += eq;
    }
    if (this.cgd > 0) {
      const i = c.integ(this.oGd, this.cgd * vgd);
      const gc = ag0 * this.cgd;
      this.gdP.add(m, gc);
      const eq = type * (i - gc * vgd);
      rhs[g]! -= eq;
      rhs[dp]! += eq;
    }
    if (this.cgb > 0) {
      const i = c.integ(this.oGb, this.cgb * vgb);
      const gc = ag0 * this.cgb;
      this.gbP.add(m, gc);
      const eq = type * (i - gc * vgb);
      rhs[g]! -= eq;
      rhs[b]! += eq;
    }

    // Meyer channel capacitance from the oxide, when TOX is given.
    if (this.cox > 0) {
      const cox = this.cox;
      const phi = this.phi;
      let hGs = 0;
      let hGd = 0;
      let hGb = 0;
      if (vgst <= -phi) {
        hGb = cox / 2;
      } else if (vgst <= -phi / 2) {
        hGb = (-vgst * cox) / (2 * phi);
      } else if (vgst <= 0) {
        hGb = (-vgst * cox) / (2 * phi);
        hGs = (vgst * cox) / (1.5 * phi) + cox / 3;
      } else if (vgst <= vdsE) {
        hGs = cox / 3;
      } else {
        const d1 = 2 * vgst - vdsE;
        const d2 = vgst - vdsE;
        hGd = (cox * (1 - (vgst * vgst) / (d1 * d1))) / 3;
        hGs = (cox * (1 - (d2 * d2) / (d1 * d1))) / 3;
      }
      // In reverse mode the effective source is the drain terminal.
      const toS = mode > 0 ? hGs : hGd;
      const toD = mode > 0 ? hGd : hGs;
      this.acGs = 2 * toS;
      this.acGd = 2 * toD;
      this.acGb = 2 * hGb;
      const ms = this.meyer(c, this.oMs, toS, vgs);
      if (ms.g !== 0) {
        this.gsP.add(m, ms.g);
        const eq = type * (ms.i - ms.g * vgs);
        rhs[g]! -= eq;
        rhs[sp]! += eq;
      }
      const md = this.meyer(c, this.oMd, toD, vgd);
      if (md.g !== 0) {
        this.gdP.add(m, md.g);
        const eq = type * (md.i - md.g * vgd);
        rhs[g]! -= eq;
        rhs[dp]! += eq;
      }
      const mb = this.meyer(c, this.oMb, hGb, vgb);
      if (mb.g !== 0) {
        this.gbP.add(m, mb.g);
        const eq = type * (mb.i - mb.g * vgb);
        rhs[g]! -= eq;
        rhs[b]! += eq;
      }
    }
  }

  loadAc(c: Circuit): void {
    const m = c.vals;
    if (this.gd > 0) this.rdP.add(m, this.gd);
    if (this.gs > 0) this.rsP.add(m, this.gs);
    this.stampChannel(m, this.gm, this.gds, this.gmbs);
    this.bdP.add(m, this.gbd);
    this.bsP.add(m, this.gbs);
    const im = c.imag;
    this.bdP.add(im, this.capBd);
    this.bsP.add(im, this.capBs);
    this.gsP.add(im, this.cgs + this.acGs);
    this.gdP.add(im, this.cgd + this.acGd);
    this.gbP.add(im, this.cgb + this.acGb);
  }

  override noise(f: number, sink: NoiseSink): void {
    const kT4 = 4 * BOLTZMANN * (this.vt / K_OVER_Q);
    if (this.gd > 0) sink(this.name, this.d, this.dp, kT4 * this.gd);
    if (this.gs > 0) sink(this.name, this.s, this.sp, kT4 * this.gs);
    const channel = (2 / 3) * kT4 * Math.abs(this.gm) + this.flickerScale * flicker(this.p.kf, this.p.af, this.cd, f);
    sink(this.name, this.dp, this.sp, channel);
  }
}

export interface JfetParams {
  type: number;
  vto: number;
  beta: number;
  lambda: number;
  is: number;
  rd: number;
  rs: number;
  cgs: number;
  cgd: number;
  pb: number;
  fc: number;
  m: number;
  /** Statz MESFET terms; alpha 0 selects the JFET equations. */
  alpha: number;
  b: number;
  tnom: number;
  xti: number;
  eg: number;
  kf: number;
  af: number;
}

export class Jfet extends Device {
  private dp = 0;
  private sp = 0;
  private readonly rdP = new Pair();
  private readonly rsP = new Pair();
  private readonly gsP = new Pair();
  private readonly gdP = new Pair();
  private dd = 0;
  private dg = 0;
  private ds = 0;
  private sd = 0;
  private sg = 0;
  private ss = 0;
  private oGs = 0;
  private oGd = 0;

  private readonly beta: number;
  private readonly isat: number;
  private readonly gdr: number;
  private readonly gsr: number;
  private readonly cgs: number;
  private readonly cgd: number;
  private readonly vcrit: number;
  private readonly vt: number;

  private vgs = 0;
  private vgd = 0;
  private mode = 1;
  private cdr = 0;
  private gm = 0;
  private gds = 0;
  private ggs = 0;
  private ggd = 0;
  private capGs = 0;
  private capGd = 0;

  constructor(
    name: string,
    line: number,
    private readonly d: number,
    private readonly g: number,
    private readonly s: number,
    private readonly p: JfetParams,
    area: number,
    tempC: number,
  ) {
    super(name, line);
    this.linear = false;
    const t = tempC + KELVIN;
    const ratio = t / (p.tnom + KELVIN);
    const vt = K_OVER_Q * t;
    this.vt = vt;
    this.beta = p.beta * area;
    this.isat = p.is * area * Math.pow(ratio, p.xti) * Math.exp((p.eg / vt) * (ratio - 1));
    this.gdr = p.rd > 0 ? area / p.rd : 0;
    this.gsr = p.rs > 0 ? area / p.rs : 0;
    this.cgs = p.cgs * area;
    this.cgd = p.cgd * area;
    this.vcrit = vt * Math.log(vt / (Math.SQRT2 * this.isat));
  }

  override allocate(c: Circuit): void {
    this.dp = this.gdr > 0 ? c.internalNode(`${this.name}#d`) : this.d;
    this.sp = this.gsr > 0 ? c.internalNode(`${this.name}#s`) : this.s;
  }

  setup(c: Circuit): void {
    if (this.gdr > 0) this.rdP.setup(c, this.d, this.dp);
    if (this.gsr > 0) this.rsP.setup(c, this.s, this.sp);
    const m = c.mat;
    this.dd = m.slot(this.dp, this.dp);
    this.dg = m.slot(this.dp, this.g);
    this.ds = m.slot(this.dp, this.sp);
    this.sd = m.slot(this.sp, this.dp);
    this.sg = m.slot(this.sp, this.g);
    this.ss = m.slot(this.sp, this.sp);
    this.gsP.setup(c, this.g, this.sp);
    this.gdP.setup(c, this.g, this.dp);
    this.oGs = c.allocState(2);
    this.oGd = c.allocState(2);
  }

  private stampChannel(m: Float64Array, gm: number, gds: number): void {
    if (this.mode > 0) {
      m[this.dd]! += gds;
      m[this.dg]! += gm;
      m[this.ds]! -= gds + gm;
      m[this.sd]! -= gds;
      m[this.sg]! -= gm;
      m[this.ss]! += gds + gm;
    } else {
      m[this.ss]! += gds;
      m[this.sg]! += gm;
      m[this.sd]! -= gds + gm;
      m[this.ds]! -= gds;
      m[this.dg]! -= gm;
      m[this.dd]! += gds + gm;
    }
  }

  load(c: Circuit): void {
    const x = c.x;
    const p = this.p;
    const type = p.type;
    let vgs = type * (x[this.g]! - x[this.sp]!);
    let vgd = type * (x[this.g]! - x[this.dp]!);
    const gmin = c.gmin;
    let limited = false;
    const VT_T = this.vt;
    if (c.initJct) {
      vgs = -1;
      vgd = -1;
    } else if (c.iter > 0) {
      const a = fetlim(pnjlim(vgs, this.vgs, VT_T, this.vcrit), this.vgs, p.vto);
      const b = fetlim(pnjlim(vgd, this.vgd, VT_T, this.vcrit), this.vgd, p.vto);
      if (a !== vgs || b !== vgd) {
        limited = true;
        vgs = a;
        vgd = b;
        c.noncon++;
      }
    }
    const vds = vgs - vgd;

    let cg: number;
    let gg: number;
    if (vgs >= -3 * VT_T) {
      const ev = limexp(vgs / VT_T);
      cg = this.isat * (ev - 1) + gmin * vgs;
      gg = (this.isat * ev) / VT_T + gmin;
    } else {
      gg = -this.isat / vgs + gmin;
      cg = gg * vgs;
    }
    let cgd: number;
    let ggd: number;
    if (vgd >= -3 * VT_T) {
      const ev = limexp(vgd / VT_T);
      cgd = this.isat * (ev - 1) + gmin * vgd;
      ggd = (this.isat * ev) / VT_T + gmin;
    } else {
      ggd = -this.isat / vgd + gmin;
      cgd = ggd * vgd;
    }

    const mode = vds >= 0 ? 1 : -1;
    const vgsE = mode > 0 ? vgs : vgd;
    const vdsE = mode > 0 ? vds : -vds;
    const vgst = vgsE - p.vto;
    let cdr = 0;
    let gm = 0;
    let gds = 0;
    if (vgst > 0 && p.alpha > 0) {
      // Statz: a quadratic with velocity saturation, shaped by a cubic in the drain voltage.
      const lam = 1 + p.lambda * vdsE;
      const den = 1 + p.b * vgst;
      const gq = (this.beta * vgst * vgst) / den;
      const dgq = (this.beta * vgst * (2 + p.b * vgst)) / (den * den);
      let shape = 1;
      let dshape = 0;
      const u = 1 - (p.alpha * vdsE) / 3;
      if (u > 0) {
        shape = 1 - u * u * u;
        dshape = p.alpha * u * u;
      }
      cdr = gq * shape * lam;
      gm = dgq * shape * lam;
      gds = gq * (dshape * lam + shape * p.lambda);
    } else if (vgst > 0) {
      const betap = this.beta * (1 + p.lambda * vdsE);
      if (vgst >= vdsE) {
        cdr = betap * vdsE * (2 * vgst - vdsE);
        gm = 2 * betap * vdsE;
        gds = 2 * betap * (vgst - vdsE) + this.beta * p.lambda * vdsE * (2 * vgst - vdsE);
      } else {
        cdr = betap * vgst * vgst;
        gm = 2 * betap * vgst;
        gds = this.beta * p.lambda * vgst * vgst;
      }
    }

    if (c.iter > 0 && !limited && !c.initJct && mode === this.mode) {
      const dg = vgsE - (mode > 0 ? this.vgs : this.vgd);
      const dd = vdsE - (mode > 0 ? this.vgs - this.vgd : this.vgd - this.vgs);
      const hat = this.cdr + this.gm * dg + this.gds * dd;
      if (Math.abs(hat - cdr) > c.reltol * Math.max(Math.abs(hat), Math.abs(cdr)) + c.abstol) c.noncon++;
    }

    this.vgs = vgs;
    this.vgd = vgd;
    this.mode = mode;
    this.cdr = cdr;
    this.gm = gm;
    this.gds = gds;
    this.ggs = gg;
    this.ggd = ggd;

    const m = c.vals;
    const rhs = c.rhs;
    if (this.gdr > 0) this.rdP.add(m, this.gdr);
    if (this.gsr > 0) this.rsP.add(m, this.gsr);

    this.stampChannel(m, gm, gds);
    const ieq = type * (cdr - gm * vgsE - gds * vdsE);
    const nd = mode > 0 ? this.dp : this.sp;
    const ns = mode > 0 ? this.sp : this.dp;
    rhs[nd]! -= ieq;
    rhs[ns]! += ieq;

    const ag0 = c.ag0;
    const qgs = depletion(vgs, this.cgs, p.pb, p.m, p.fc);
    this.capGs = deplCap;
    const qgd = depletion(vgd, this.cgd, p.pb, p.m, p.fc);
    this.capGd = deplCap;
    const iqgs = c.integ(this.oGs, qgs);
    const iqgd = c.integ(this.oGd, qgd);
    const gGs = gg + ag0 * this.capGs;
    const gGd = ggd + ag0 * this.capGd;
    this.gsP.add(m, gGs);
    this.gdP.add(m, gGd);
    const eqGs = type * (cg + iqgs - gGs * vgs);
    const eqGd = type * (cgd + iqgd - gGd * vgd);
    rhs[this.g]! -= eqGs + eqGd;
    rhs[this.sp]! += eqGs;
    rhs[this.dp]! += eqGd;
  }

  loadAc(c: Circuit): void {
    const m = c.vals;
    if (this.gdr > 0) this.rdP.add(m, this.gdr);
    if (this.gsr > 0) this.rsP.add(m, this.gsr);
    this.stampChannel(m, this.gm, this.gds);
    this.gsP.add(m, this.ggs);
    this.gdP.add(m, this.ggd);
    this.gsP.add(c.imag, this.capGs);
    this.gdP.add(c.imag, this.capGd);
  }

  override noise(f: number, sink: NoiseSink): void {
    const kT4 = 4 * BOLTZMANN * (this.vt / K_OVER_Q);
    if (this.gdr > 0) sink(this.name, this.d, this.dp, kT4 * this.gdr);
    if (this.gsr > 0) sink(this.name, this.s, this.sp, kT4 * this.gsr);
    sink(this.name, this.dp, this.sp, (2 / 3) * kT4 * Math.abs(this.gm) + flicker(this.p.kf, this.p.af, this.cdr, f));
  }
}
