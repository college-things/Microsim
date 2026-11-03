// Generalized eigenvalues of the pencil G + s C, used for poles and zeros.
//
// C is usually singular, so the pencil is shifted: with (G + s0 C)^-1 C x = mu x, the finite
// eigenvalues are s = s0 - 1/mu and mu = 0 stands for s at infinity. A dense QR iteration finds mu,
// then each s is polished on the sparse pencil by two-sided inverse iteration, which restores
// accuracy for eigenvalues far from the shift.

import { LU_OK, SparseLU, SparseMatrix } from "./sparse";

export interface PencilEntry {
  row: number;
  col: number;
  g: number;
  c: number;
}

export interface Complex {
  re: number;
  im: number;
}

/** Thrown when no shift gives a nonsingular matrix: the pencil is singular for every s. */
export class SingularPencil extends Error {}

/** Thrown when the QR iteration does not finish. */
export class EigenFailure extends Error {}

const INFINITE_MU = 1e-13;

/** With keep, only eigenvalues it accepts are polished and returned, which saves most of the work. */
export function pencilEigenvalues(n: number, entries: PencilEntry[], keep?: (s: Complex) => boolean): Complex[] {
  if (n === 0) return [];
  const mat = new SparseMatrix(n);
  const slots = entries.map((e) => mat.slot(e.row + 1, e.col + 1));
  mat.freeze();
  const count = mat.re.length;
  const G = new Float64Array(count);
  const C = new Float64Array(count);
  entries.forEach((e, k) => {
    G[slots[k]!]! += e.g;
    C[slots[k]!]! += e.c;
  });

  const s0Base = typicalRate(n, entries);
  const real = new SparseLU(mat, false);
  let s0 = 0;
  let found = false;
  for (const factor of [1, Math.PI, 1 / Math.PI, 17.3, 1 / 17.3, 311, 1 / 311]) {
    s0 = s0Base * factor;
    for (let i = 1; i < count; i++) mat.re[i] = G[i]! + s0 * C[i]!;
    if (real.factor() === LU_OK) {
      found = true;
      break;
    }
  }
  if (!found) throw new SingularPencil();

  // M = (G + s0 C)^-1 C, one column at a time.
  const mRe = new Float64Array(n * n);
  const rhs = new Float64Array(n + 1);
  const out = new Float64Array(n + 1);
  for (let j = 0; j < n; j++) {
    rhs.fill(0);
    let any = false;
    for (const e of entries) {
      if (e.col === j && e.c !== 0) {
        rhs[e.row + 1]! += e.c;
        any = true;
      }
    }
    if (!any) continue;
    real.solve(rhs, out);
    for (let i = 0; i < n; i++) mRe[i * n + j] = out[i + 1]!;
  }

  const mus = hessenbergQr(n, mRe);
  let largest = 0;
  for (const m of mus) largest = Math.max(largest, Math.hypot(m.re, m.im));
  if (largest === 0) return [];

  const complexLu = new SparseLU(mat, true);
  const results: Complex[] = [];
  for (const m of mus) {
    const size = Math.hypot(m.re, m.im);
    if (size <= INFINITE_MU * largest) continue;
    // s = s0 - 1/mu
    const den = m.re * m.re + m.im * m.im;
    const guess: Complex = { re: s0 - m.re / den, im: m.im / den };
    if (keep && !keep(guess)) continue;
    // An eigenvalue at infinity with a Jordan block comes out of QR as a small but false mu, of
    // order eps^(1/k), so a value counts only when the sparse pencil confirms it.
    const polished = polish(n, mat, complexLu, G, C, guess, Math.abs(s0));
    if (polished.confirmed) results.push(polished.value);
  }
  return tidy(results);
}

function typicalRate(n: number, entries: PencilEntry[]): number {
  const rowG = new Float64Array(n);
  const rowC = new Float64Array(n);
  for (const e of entries) {
    rowG[e.row] = Math.max(rowG[e.row]!, Math.abs(e.g));
    rowC[e.row] = Math.max(rowC[e.row]!, Math.abs(e.c));
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (rowG[i]! > 0 && rowC[i]! > 0) {
      sum += Math.log(rowG[i]! / rowC[i]!);
      count++;
    }
  }
  return count > 0 ? Math.exp(sum / count) : 1;
}

/** Two-sided inverse iteration with the generalized Rayleigh correction. */
function polish(n: number, mat: SparseMatrix, lu: SparseLU, G: Float64Array, C: Float64Array, start: Complex, rate: number): { value: Complex; confirmed: boolean } {
  let s = start;
  const bRe = new Float64Array(n + 1);
  const bIm = new Float64Array(n + 1);
  const xRe = new Float64Array(n + 1);
  const xIm = new Float64Array(n + 1);
  const yRe = new Float64Array(n + 1);
  const yIm = new Float64Array(n + 1);
  const cxRe = new Float64Array(n + 1);
  const cxIm = new Float64Array(n + 1);
  let seed = 12345;
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 1; i <= n; i++) {
    xRe[i] = noise();
    yRe[i] = noise();
  }
  let confirmed = false;
  const slotRow = mat.slotRow;
  const slotCol = mat.slotCol;
  const load = (at: Complex): number => {
    for (let k = 1; k < G.length; k++) {
      mat.re[k] = G[k]! + at.re * C[k]!;
      mat.im[k] = at.im * C[k]!;
    }
    return lu.factor();
  };
  for (let it = 0; it < 5; it++) {
    if (load(s) !== LU_OK) {
      // Singular to working precision is what an exact eigenvalue looks like, but a nudge tells it
      // apart from a matrix that is singular everywhere or merely badly scaled at this s.
      const size = Math.max(Math.hypot(s.re, s.im), 1e-6 * rate);
      s = { re: s.re + 1e-7 * size, im: s.im + 1e-7 * size };
      if (load(s) !== LU_OK) break;
    }
    const applyC = (vr: Float64Array, vi: Float64Array, transpose: boolean): void => {
      cxRe.fill(0);
      cxIm.fill(0);
      for (let k = 1; k < C.length; k++) {
        const cv = C[k]!;
        if (cv === 0) continue;
        const r = (transpose ? slotCol[k]! : slotRow[k]!) + 1;
        const q = (transpose ? slotRow[k]! : slotCol[k]!) + 1;
        cxRe[r]! += cv * vr[q]!;
        cxIm[r]! += cv * vi[q]!;
      }
    };
    normalize(xRe, xIm);
    applyC(xRe, xIm, false);
    bRe.set(cxRe);
    bIm.set(cxIm);
    lu.solveComplex(bRe, bIm, xRe, xIm);
    normalize(yRe, yIm);
    applyC(yRe, yIm, true);
    bRe.set(cxRe);
    bIm.set(cxIm);
    lu.solveTransposeComplex(bRe, bIm, yRe, yIm);
    // With (G + s C) x = C x_old, and y on the left, the correction is y^T C x_old / y^T C x.
    normalize(xRe, xIm);
    normalize(yRe, yIm);
    applyC(xRe, xIm, false);
    let denRe = 0;
    let denIm = 0;
    for (let i = 1; i <= n; i++) {
      denRe += yRe[i]! * cxRe[i]! - yIm[i]! * cxIm[i]!;
      denIm += yRe[i]! * cxIm[i]! + yIm[i]! * cxRe[i]!;
    }
    // Residual of the pencil at s along x, measured through y.
    let numRe = 0;
    let numIm = 0;
    for (let k = 1; k < G.length; k++) {
      const r = slotRow[k]! + 1;
      const q = slotCol[k]! + 1;
      const ar = mat.re[k]!;
      const ai = mat.im[k]!;
      const px = ar * xRe[q]! - ai * xIm[q]!;
      const pi = ar * xIm[q]! + ai * xRe[q]!;
      numRe += yRe[r]! * px - yIm[r]! * pi;
      numIm += yRe[r]! * pi + yIm[r]! * px;
    }
    const den2 = denRe * denRe + denIm * denIm;
    if (!(den2 > 0)) break;
    const dRe = (numRe * denRe + numIm * denIm) / den2;
    const dIm = (numIm * denRe - numRe * denIm) / den2;
    const step = Math.hypot(dRe, dIm);
    // A pole at the origin has no size of its own, so measure against the circuit's typical rate.
    const size = Math.max(Math.hypot(s.re, s.im), 1e-6 * rate);
    if (!(step <= 0.01 * size)) break;
    s = { re: s.re - dRe, im: s.im - dIm };
    if (step <= 1e-6 * size) confirmed = true;
    if (step <= 1e-12 * size) break;
  }
  return { value: s, confirmed };
}

function normalize(re: Float64Array, im: Float64Array): void {
  let m = 0;
  for (let i = 1; i < re.length; i++) m = Math.max(m, Math.abs(re[i]!), Math.abs(im[i]!));
  if (!(m > 0)) return;
  for (let i = 1; i < re.length; i++) {
    re[i]! /= m;
    im[i]! /= m;
  }
}

/** Round off imaginary dust, make complex values exact conjugate pairs, and sort by magnitude. */
function tidy(values: Complex[]): Complex[] {
  const out: Complex[] = [];
  const used = new Array<boolean>(values.length).fill(false);
  for (let i = 0; i < values.length; i++) {
    if (used[i]) continue;
    const a = values[i]!;
    const size = Math.hypot(a.re, a.im);
    if (Math.abs(a.im) <= 1e-8 * size) {
      out.push({ re: a.re, im: 0 });
      used[i] = true;
      continue;
    }
    let partner = -1;
    let best = Infinity;
    for (let j = i + 1; j < values.length; j++) {
      if (used[j]) continue;
      const b = values[j]!;
      const d = Math.hypot(a.re - b.re, a.im + b.im);
      if (d < best) {
        best = d;
        partner = j;
      }
    }
    used[i] = true;
    if (partner >= 0 && best <= 1e-4 * size) {
      const b = values[partner]!;
      used[partner] = true;
      const re = (a.re + b.re) / 2;
      const im = (Math.abs(a.im) + Math.abs(b.im)) / 2;
      out.push({ re, im }, { re, im: -im });
    } else {
      out.push(a);
    }
  }
  out.sort((p, q) => Math.hypot(p.re, p.im) - Math.hypot(q.re, q.im) || q.im - p.im);
  return out;
}

/** Eigenvalues of a real dense matrix (row-major), by balancing, Hessenberg form and complex QR. */
export function hessenbergQr(n: number, a: Float64Array): Complex[] {
  if (n === 0) return [];
  const m = a.slice();
  balance(n, m);
  hessenberg(n, m);
  const hRe = m;
  const hIm = new Float64Array(n * n);
  const eig: Complex[] = new Array(n);
  const at = (i: number, j: number): number => i * n + j;
  let hi = n - 1;
  let iter = 0;
  const rotCr = new Float64Array(n);
  const rotCi = new Float64Array(n);
  const rotSr = new Float64Array(n);
  const rotSi = new Float64Array(n);
  while (hi >= 0) {
    let l = hi;
    while (l > 0) {
      const sub = Math.hypot(hRe[at(l, l - 1)]!, hIm[at(l, l - 1)]!);
      const d =
        Math.hypot(hRe[at(l - 1, l - 1)]!, hIm[at(l - 1, l - 1)]!) + Math.hypot(hRe[at(l, l)]!, hIm[at(l, l)]!);
      if (sub <= 2.2e-16 * (d > 0 ? d : 1e-300)) {
        hRe[at(l, l - 1)] = 0;
        hIm[at(l, l - 1)] = 0;
        break;
      }
      l--;
    }
    if (l === hi) {
      eig[hi] = { re: hRe[at(hi, hi)]!, im: hIm[at(hi, hi)]! };
      hi--;
      iter = 0;
      continue;
    }
    if (++iter > 200) throw new EigenFailure();
    // Wilkinson shift from the trailing 2 by 2 block, with an occasional exceptional shift.
    const shift =
      iter % 11 === 10
        ? { re: Math.hypot(hRe[at(hi, hi - 1)]!, hIm[at(hi, hi - 1)]!) + hRe[at(hi, hi)]!, im: 0 }
        : wilkinson(
            hRe[at(hi - 1, hi - 1)]!, hIm[at(hi - 1, hi - 1)]!,
            hRe[at(hi - 1, hi)]!, hIm[at(hi - 1, hi)]!,
            hRe[at(hi, hi - 1)]!, hIm[at(hi, hi - 1)]!,
            hRe[at(hi, hi)]!, hIm[at(hi, hi)]!,
          );
    for (let k = l; k <= hi; k++) {
      hRe[at(k, k)]! -= shift.re;
      hIm[at(k, k)]! -= shift.im;
    }
    // QR by Givens rotations on the active window, then RQ.
    for (let k = l; k < hi; k++) {
      const ar = hRe[at(k, k)]!;
      const ai = hIm[at(k, k)]!;
      const br = hRe[at(k + 1, k)]!;
      const bi = hIm[at(k + 1, k)]!;
      const r = Math.hypot(ar, ai, br, bi);
      const cr = r > 0 ? ar / r : 1;
      const ci = r > 0 ? ai / r : 0;
      const sr = r > 0 ? br / r : 0;
      const si = r > 0 ? bi / r : 0;
      rotCr[k] = cr;
      rotCi[k] = ci;
      rotSr[k] = sr;
      rotSi[k] = si;
      // Row k and k+1: [conj(c) conj(s); -s c] [a; b] = [r; 0].
      for (let j = k; j <= hi; j++) {
        const xr = hRe[at(k, j)]!;
        const xi = hIm[at(k, j)]!;
        const yr = hRe[at(k + 1, j)]!;
        const yi = hIm[at(k + 1, j)]!;
        hRe[at(k, j)] = cr * xr + ci * xi + (sr * yr + si * yi);
        hIm[at(k, j)] = cr * xi - ci * xr + (sr * yi - si * yr);
        hRe[at(k + 1, j)] = -(sr * xr - si * xi) + (cr * yr - ci * yi);
        hIm[at(k + 1, j)] = -(sr * xi + si * xr) + (cr * yi + ci * yr);
      }
    }
    // R Q^H: columns k and k+1 by the conjugate transpose of each rotation.
    for (let k = l; k < hi; k++) {
      const cr = rotCr[k]!;
      const ci = rotCi[k]!;
      const sr = rotSr[k]!;
      const si = rotSi[k]!;
      const top = Math.min(k + 1, hi);
      for (let i = l; i <= top; i++) {
        const xr = hRe[at(i, k)]!;
        const xi = hIm[at(i, k)]!;
        const yr = hRe[at(i, k + 1)]!;
        const yi = hIm[at(i, k + 1)]!;
        hRe[at(i, k)] = xr * cr - xi * ci + (yr * sr - yi * si);
        hIm[at(i, k)] = xr * ci + xi * cr + (yr * si + yi * sr);
        hRe[at(i, k + 1)] = -(xr * sr + xi * si) + (yr * cr + yi * ci);
        hIm[at(i, k + 1)] = -(xi * sr - xr * si) + (yi * cr - yr * ci);
      }
    }
    for (let k = l; k <= hi; k++) {
      hRe[at(k, k)]! += shift.re;
      hIm[at(k, k)]! += shift.im;
    }
  }
  return eig;
}

function wilkinson(ar: number, ai: number, br: number, bi: number, cr: number, ci: number, dr: number, di: number): Complex {
  // Eigenvalue of [a b; c d] closest to d.
  const hr = (ar - dr) / 2;
  const hi = (ai - di) / 2;
  // q = h^2 + b c
  const qr = hr * hr - hi * hi + (br * cr - bi * ci);
  const qi = 2 * hr * hi + (br * ci + bi * cr);
  const mod = Math.hypot(qr, qi);
  const rootR = Math.sqrt((mod + qr) / 2);
  const rootI = (qi >= 0 ? 1 : -1) * Math.sqrt(Math.max(0, (mod - qr) / 2));
  const e1r = hr + rootR;
  const e1i = hi + rootI;
  const e2r = hr - rootR;
  const e2i = hi - rootI;
  const small = Math.hypot(e1r, e1i) < Math.hypot(e2r, e2i) ? { re: e1r, im: e1i } : { re: e2r, im: e2i };
  return { re: dr + small.re, im: di + small.im };
}

/** Diagonal similarity that evens out row and column norms. */
function balance(n: number, a: Float64Array): void {
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let r = 0;
      let c = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        r += Math.abs(a[i * n + j]!);
        c += Math.abs(a[j * n + i]!);
      }
      if (r === 0 || c === 0) continue;
      let f = 1;
      const g = r / 2;
      const s = c + r;
      let cc = c;
      while (cc < g) {
        f *= 2;
        cc *= 4;
      }
      const g2 = r * 2;
      while (cc >= g2) {
        f /= 2;
        cc /= 4;
      }
      if ((cc + r) / f < 0.95 * s) {
        changed = true;
        for (let j = 0; j < n; j++) a[i * n + j]! /= f;
        for (let j = 0; j < n; j++) a[j * n + i]! *= f;
      }
    }
    if (!changed) break;
  }
}

/** Reduce to upper Hessenberg form in place by Householder reflections. */
function hessenberg(n: number, a: Float64Array): void {
  const v = new Float64Array(n);
  for (let k = 0; k < n - 2; k++) {
    let norm = 0;
    for (let i = k + 1; i < n; i++) norm = Math.hypot(norm, a[i * n + k]!);
    if (norm === 0) continue;
    const alpha = a[(k + 1) * n + k]! > 0 ? -norm : norm;
    let vnorm = 0;
    for (let i = k + 1; i < n; i++) {
      v[i] = a[i * n + k]!;
      if (i === k + 1) v[i]! -= alpha;
      vnorm += v[i]! * v[i]!;
    }
    if (vnorm === 0) continue;
    const beta = 2 / vnorm;
    for (let j = k; j < n; j++) {
      let d = 0;
      for (let i = k + 1; i < n; i++) d += v[i]! * a[i * n + j]!;
      d *= beta;
      for (let i = k + 1; i < n; i++) a[i * n + j]! -= d * v[i]!;
    }
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let j = k + 1; j < n; j++) d += a[i * n + j]! * v[j]!;
      d *= beta;
      for (let j = k + 1; j < n; j++) a[i * n + j]! -= d * v[j]!;
    }
    for (let i = k + 2; i < n; i++) a[i * n + k] = 0;
  }
}
