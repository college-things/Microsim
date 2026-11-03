// Sparse LU for MNA systems.
//
// SparseMatrix owns the structural pattern as "slots": devices keep integer handles and
// write through them. Slot 0 is a trash slot used for anything touching ground, so stamps
// need no branch. SparseLU picks a Markowitz pivot order with threshold pivoting, stores
// the filled pattern in CSR form and refactors in place with no allocation until a pivot
// degrades, which triggers a new ordering.

export const LU_OK = 0;
export const LU_SINGULAR = 1;
export const LU_NONFINITE = 2;
const LU_RETRY = 3;

/** Threshold pivoting: candidate must be this fraction of the column's largest entry. */
const PIVOT_REL = 1e-3;
/** Entries below this fraction of their row's original scale count as numerically zero. */
const ZERO_REL = 1e-15;
/** A refactor multiplier beyond this means the stored pivot order has become unstable. */
const MULTIPLIER_LIMIT = 1e7;
/** Lines examined after a first candidate exists. */
const SEARCH_LIMIT = 8;

/** Stand-in pivot for a floating node: small, nonzero, and scaled to its row. */
function boostedPivot(rowMax: number): number {
  return rowMax > 0 ? rowMax * 1e-12 : 1e-12;
}

export class SparseMatrix {
  /** Tells node rows from branch rows, set by the circuit. */
  isNode: (unknown: number) => boolean = () => false;
  readonly slotRow: number[] = [-1];
  readonly slotCol: number[] = [-1];
  re: Float64Array = new Float64Array(0);
  im: Float64Array = new Float64Array(0);
  private readonly map = new Map<number, number>();

  constructor(readonly n: number) {}

  /** Handle for entry (row, col); indices are 1-based unknowns and 0 means ground. */
  slot(row: number, col: number): number {
    if (row === 0 || col === 0) return 0;
    const key = (row - 1) * this.n + (col - 1);
    let s = this.map.get(key);
    if (s === undefined) {
      s = this.slotRow.length;
      this.slotRow.push(row - 1);
      this.slotCol.push(col - 1);
      this.map.set(key, s);
    }
    return s;
  }

  freeze(): void {
    this.re = new Float64Array(this.slotRow.length);
    this.im = new Float64Array(this.slotRow.length);
  }
}

class Buckets {
  readonly head: Int32Array;
  readonly next: Int32Array;
  private readonly prev: Int32Array;
  private readonly cnt: Int32Array;

  constructor(n: number) {
    this.head = new Int32Array(n + 2).fill(-1);
    this.next = new Int32Array(n).fill(-1);
    this.prev = new Int32Array(n).fill(-1);
    this.cnt = new Int32Array(n);
  }

  insert(i: number, c: number): void {
    this.cnt[i] = c;
    const h = this.head[c]!;
    this.next[i] = h;
    this.prev[i] = -1;
    if (h >= 0) this.prev[h] = i;
    this.head[c] = i;
  }

  remove(i: number): void {
    const p = this.prev[i]!;
    const n = this.next[i]!;
    if (p >= 0) this.next[p] = n;
    else this.head[this.cnt[i]!] = n;
    if (n >= 0) this.prev[n] = p;
  }

  move(i: number, c: number): void {
    if (this.cnt[i] === c) return;
    this.remove(i);
    this.insert(i, c);
  }
}

export class SparseLU {
  /** 1-based unknowns identified when factor() reports LU_SINGULAR. */
  failRow = 0;
  failCol = 0;
  /** Number of pivot orderings computed, a measure of pattern reuse. */
  orderings = 0;
  /** 1-based node whose pivot was too small to trust and was replaced, 0 if none. */
  boostedNode = 0;

  private analyzed = false;
  private rowPtr = new Int32Array(0);
  private colIdx = new Int32Array(0);
  private diag = new Int32Array(0);
  private pr = new Int32Array(0);
  private pc = new Int32Array(0);
  private slotMap = new Int32Array(0);
  private lu = new Float64Array(0);
  private luIm = new Float64Array(0);
  private readonly w: Float64Array;
  private readonly wIm: Float64Array;
  private readonly y: Float64Array;
  private readonly yIm: Float64Array;

  constructor(private readonly mat: SparseMatrix, private readonly complex: boolean) {
    const n = mat.n;
    this.w = new Float64Array(n);
    this.y = new Float64Array(n);
    this.wIm = new Float64Array(complex ? n : 0);
    this.yIm = new Float64Array(complex ? n : 0);
  }

  factor(): number {
    if (!this.analyzed) {
      const st = this.analyze();
      if (st !== LU_OK) return st;
      return this.numeric(false);
    }
    const st = this.numeric(true);
    if (st !== LU_RETRY) return st;
    const st2 = this.analyze();
    if (st2 !== LU_OK) return st2;
    return this.numeric(false);
  }

  private numeric(check: boolean): number {
    return this.complex ? this.numericComplex(check) : this.numericReal(check);
  }

  private numericReal(check: boolean): number {
    const { rowPtr, colIdx, diag, lu, w, slotMap } = this;
    const re = this.mat.re;
    const n = this.mat.n;
    lu.fill(0);
    for (let s = 1; s < slotMap.length; s++) lu[slotMap[s]!] = re[s]!;
    for (let k = 0; k < n; k++) {
      const start = rowPtr[k]!;
      const end = rowPtr[k + 1]!;
      const d = diag[k]!;
      let rowMax = 0;
      for (let e = start; e < end; e++) {
        const v = lu[e]!;
        w[colIdx[e]!] = v;
        const a = v < 0 ? -v : v;
        if (a > rowMax) rowMax = a;
      }
      for (let e = start; e < d; e++) {
        const j = colIdx[e]!;
        let m = w[j]!;
        if (m !== 0) {
          m /= lu[diag[j]!]!;
          if (check && (m > MULTIPLIER_LIMIT || m < -MULTIPLIER_LIMIT)) {
            for (let f = start; f < end; f++) w[colIdx[f]!] = 0;
            return LU_RETRY;
          }
          w[j] = m;
          const fEnd = rowPtr[j + 1]!;
          for (let f = diag[j]! + 1; f < fEnd; f++) w[colIdx[f]!]! -= m * lu[f]!;
        }
      }
      for (let e = start; e < end; e++) {
        const c = colIdx[e]!;
        lu[e] = w[c]!;
        w[c] = 0;
      }
      const piv = lu[d]!;
      const ap = piv < 0 ? -piv : piv;
      if (!(ap > ZERO_REL * rowMax) || ap === 0) {
        if (check) return LU_RETRY;
        const unknown = this.pr[k]! + 1;
        if (!Number.isNaN(piv) && this.mat.isNode(this.pc[k]! + 1) && this.mat.isNode(unknown)) {
          lu[d] = boostedPivot(rowMax);
          this.boostedNode = unknown;
          continue;
        }
        this.failRow = this.pr[k]! + 1;
        this.failCol = this.pc[k]! + 1;
        return Number.isNaN(piv) ? LU_NONFINITE : LU_SINGULAR;
      }
    }
    return LU_OK;
  }

  private numericComplex(check: boolean): number {
    const { rowPtr, colIdx, diag, lu, luIm, w, wIm, slotMap } = this;
    const re = this.mat.re;
    const im = this.mat.im;
    const n = this.mat.n;
    lu.fill(0);
    luIm.fill(0);
    for (let s = 1; s < slotMap.length; s++) {
      lu[slotMap[s]!] = re[s]!;
      luIm[slotMap[s]!] = im[s]!;
    }
    const limit2 = MULTIPLIER_LIMIT * MULTIPLIER_LIMIT;
    for (let k = 0; k < n; k++) {
      const start = rowPtr[k]!;
      const end = rowPtr[k + 1]!;
      const d = diag[k]!;
      let rowMax2 = 0;
      for (let e = start; e < end; e++) {
        const c = colIdx[e]!;
        const vr = lu[e]!;
        const vi = luIm[e]!;
        w[c] = vr;
        wIm[c] = vi;
        const a = vr * vr + vi * vi;
        if (a > rowMax2) rowMax2 = a;
      }
      for (let e = start; e < d; e++) {
        const j = colIdx[e]!;
        const ar = w[j]!;
        const ai = wIm[j]!;
        if (ar !== 0 || ai !== 0) {
          const dj = diag[j]!;
          const br = lu[dj]!;
          const bi = luIm[dj]!;
          const den = br * br + bi * bi;
          const mr = (ar * br + ai * bi) / den;
          const mi = (ai * br - ar * bi) / den;
          if (check && mr * mr + mi * mi > limit2) {
            for (let f = start; f < end; f++) {
              w[colIdx[f]!] = 0;
              wIm[colIdx[f]!] = 0;
            }
            return LU_RETRY;
          }
          w[j] = mr;
          wIm[j] = mi;
          const fEnd = rowPtr[j + 1]!;
          for (let f = dj + 1; f < fEnd; f++) {
            const c = colIdx[f]!;
            const ur = lu[f]!;
            const ui = luIm[f]!;
            w[c]! -= mr * ur - mi * ui;
            wIm[c]! -= mr * ui + mi * ur;
          }
        }
      }
      for (let e = start; e < end; e++) {
        const c = colIdx[e]!;
        lu[e] = w[c]!;
        luIm[e] = wIm[c]!;
        w[c] = 0;
        wIm[c] = 0;
      }
      const pr = lu[d]!;
      const pi = luIm[d]!;
      const ap2 = pr * pr + pi * pi;
      if (!(ap2 > ZERO_REL * ZERO_REL * rowMax2) || ap2 === 0) {
        if (check) return LU_RETRY;
        const unknown = this.pr[k]! + 1;
        if (!Number.isNaN(ap2) && this.mat.isNode(this.pc[k]! + 1) && this.mat.isNode(unknown)) {
          lu[d] = boostedPivot(Math.sqrt(rowMax2));
          luIm[d] = 0;
          this.boostedNode = unknown;
          continue;
        }
        this.failRow = this.pr[k]! + 1;
        this.failCol = this.pc[k]! + 1;
        return Number.isNaN(ap2) ? LU_NONFINITE : LU_SINGULAR;
      }
    }
    return LU_OK;
  }

  /** Solve for a real right-hand side. b and out are 1-based with index 0 ignored. */
  solve(b: Float64Array, out: Float64Array): void {
    const { rowPtr, colIdx, diag, lu, y, pr, pc } = this;
    const n = this.mat.n;
    for (let k = 0; k < n; k++) {
      let s = b[pr[k]! + 1]!;
      const d = diag[k]!;
      for (let e = rowPtr[k]!; e < d; e++) s -= lu[e]! * y[colIdx[e]!]!;
      y[k] = s;
    }
    for (let k = n - 1; k >= 0; k--) {
      let s = y[k]!;
      const d = diag[k]!;
      const end = rowPtr[k + 1]!;
      for (let e = d + 1; e < end; e++) s -= lu[e]! * y[colIdx[e]!]!;
      y[k] = s / lu[d]!;
    }
    for (let k = 0; k < n; k++) out[pc[k]! + 1] = y[k]!;
  }

  /** Solve A^T x = b for a real right-hand side; used for adjoint sensitivities. */
  solveTranspose(b: Float64Array, out: Float64Array): void {
    const { rowPtr, colIdx, diag, lu, y, pr, pc } = this;
    const n = this.mat.n;
    for (let k = 0; k < n; k++) y[k] = b[pc[k]! + 1]!;
    for (let k = 0; k < n; k++) {
      const d = diag[k]!;
      const v = y[k]! / lu[d]!;
      y[k] = v;
      const end = rowPtr[k + 1]!;
      for (let e = d + 1; e < end; e++) y[colIdx[e]!]! -= lu[e]! * v;
    }
    for (let k = n - 1; k >= 0; k--) {
      const v = y[k]!;
      const d = diag[k]!;
      for (let e = rowPtr[k]!; e < d; e++) y[colIdx[e]!]! -= lu[e]! * v;
    }
    for (let k = 0; k < n; k++) out[pr[k]! + 1] = y[k]!;
  }

  /** Solve A^T x = b, plain transpose without conjugation; arrays are 1-based. */
  solveTransposeComplex(bRe: Float64Array, bIm: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
    const { rowPtr, colIdx, diag, lu, luIm, y, yIm, pr, pc } = this;
    const n = this.mat.n;
    for (let k = 0; k < n; k++) {
      y[k] = bRe[pc[k]! + 1]!;
      yIm[k] = bIm[pc[k]! + 1]!;
    }
    for (let k = 0; k < n; k++) {
      const d = diag[k]!;
      const dr = lu[d]!;
      const di = luIm[d]!;
      const den = dr * dr + di * di;
      const sr = y[k]!;
      const si = yIm[k]!;
      const vr = (sr * dr + si * di) / den;
      const vi = (si * dr - sr * di) / den;
      y[k] = vr;
      yIm[k] = vi;
      const end = rowPtr[k + 1]!;
      for (let e = d + 1; e < end; e++) {
        const c = colIdx[e]!;
        const ur = lu[e]!;
        const ui = luIm[e]!;
        y[c]! -= ur * vr - ui * vi;
        yIm[c]! -= ur * vi + ui * vr;
      }
    }
    for (let k = n - 1; k >= 0; k--) {
      const vr = y[k]!;
      const vi = yIm[k]!;
      const d = diag[k]!;
      for (let e = rowPtr[k]!; e < d; e++) {
        const c = colIdx[e]!;
        const lr = lu[e]!;
        const li = luIm[e]!;
        y[c]! -= lr * vr - li * vi;
        yIm[c]! -= lr * vi + li * vr;
      }
    }
    for (let k = 0; k < n; k++) {
      outRe[pr[k]! + 1] = y[k]!;
      outIm[pr[k]! + 1] = yIm[k]!;
    }
  }

  /** Complex solve; all arrays are 1-based with index 0 ignored. */
  solveComplex(bRe: Float64Array, bIm: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
    const { rowPtr, colIdx, diag, lu, luIm, y, yIm, pr, pc } = this;
    const n = this.mat.n;
    for (let k = 0; k < n; k++) {
      let sr = bRe[pr[k]! + 1]!;
      let si = bIm[pr[k]! + 1]!;
      const d = diag[k]!;
      for (let e = rowPtr[k]!; e < d; e++) {
        const c = colIdx[e]!;
        const lr = lu[e]!;
        const li = luIm[e]!;
        sr -= lr * y[c]! - li * yIm[c]!;
        si -= lr * yIm[c]! + li * y[c]!;
      }
      y[k] = sr;
      yIm[k] = si;
    }
    for (let k = n - 1; k >= 0; k--) {
      let sr = y[k]!;
      let si = yIm[k]!;
      const d = diag[k]!;
      const end = rowPtr[k + 1]!;
      for (let e = d + 1; e < end; e++) {
        const c = colIdx[e]!;
        const ur = lu[e]!;
        const ui = luIm[e]!;
        sr -= ur * y[c]! - ui * yIm[c]!;
        si -= ur * yIm[c]! + ui * y[c]!;
      }
      const dr = lu[d]!;
      const di = luIm[d]!;
      const den = dr * dr + di * di;
      y[k] = (sr * dr + si * di) / den;
      yIm[k] = (si * dr - sr * di) / den;
    }
    for (let k = 0; k < n; k++) {
      outRe[pc[k]! + 1] = y[k]!;
      outIm[pc[k]! + 1] = yIm[k]!;
    }
  }

  /** Markowitz ordering by numeric elimination on dynamic structures. Allocates; runs rarely. */
  private analyze(): number {
    const mat = this.mat;
    const n = mat.n;
    const re = mat.re;
    const im = this.complex ? mat.im : null;
    const ns = mat.slotRow.length;
    this.analyzed = false;
    this.orderings++;

    for (let s = 1; s < ns; s++) {
      if (!Number.isFinite(re[s]!) || (im && !Number.isFinite(im[s]!))) return LU_NONFINITE;
    }

    const rowsRe: Map<number, number>[] = new Array(n);
    const rowsIm: Map<number, number>[] = new Array(n);
    const colRows: number[][] = new Array(n);
    const lCols: number[][] = new Array(n);
    const uCols: number[][] = new Array(n);
    const scale = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      rowsRe[i] = new Map();
      if (im) rowsIm[i] = new Map();
      colRows[i] = [];
      lCols[i] = [];
    }
    for (let s = 1; s < ns; s++) {
      const r = mat.slotRow[s]!;
      const c = mat.slotCol[s]!;
      rowsRe[r]!.set(c, re[s]!);
      if (im) rowsIm[r]!.set(c, im[s]!);
      colRows[c]!.push(r);
      const a = im ? Math.hypot(re[s]!, im[s]!) : Math.abs(re[s]!);
      if (a > scale[r]!) scale[r] = a;
    }

    const rowB = new Buckets(n);
    const colB = new Buckets(n);
    for (let i = 0; i < n; i++) {
      rowB.insert(i, rowsRe[i]!.size);
      colB.insert(i, colRows[i]!.length);
    }

    const mag = (r: number, c: number): number => {
      const a = rowsRe[r]!.get(c)!;
      if (!im) return Math.abs(a);
      return Math.hypot(a, rowsIm[r]!.get(c)!);
    };

    const colMaxVal = new Float64Array(n);
    const colMaxStep = new Int32Array(n).fill(-1);
    const colMax = (c: number, k: number): number => {
      if (colMaxStep[c] === k) return colMaxVal[c]!;
      let m = 0;
      const list = colRows[c]!;
      for (let i = 0; i < list.length; i++) {
        const a = mag(list[i]!, c);
        if (a > m) m = a;
      }
      colMaxVal[c] = m;
      colMaxStep[c] = k;
      return m;
    };

    const pr = new Int32Array(n);
    const pc = new Int32Array(n);
    const rowDone = new Uint8Array(n);
    const colDone = new Uint8Array(n);

    for (let k = 0; k < n; k++) {
      let bestRow = -1;
      let bestCol = -1;
      let bestCost = Infinity;
      let bestMag = 0;
      let examined = 0;

      const consider = (r: number, c: number, cost: number): void => {
        if (cost > bestCost) return;
        const a = mag(r, c);
        if (cost === bestCost && a <= bestMag) return;
        if (a <= ZERO_REL * scale[r]! || a === 0) return;
        if (a < PIVOT_REL * colMax(c, k)) return;
        bestRow = r;
        bestCol = c;
        bestCost = cost;
        bestMag = a;
      };

      search: for (let cnt = 1; cnt <= n; cnt++) {
        for (let c = colB.head[cnt]!; c >= 0; c = colB.next[c]!) {
          if (bestRow >= 0 && ++examined > SEARCH_LIMIT) break search;
          const list = colRows[c]!;
          for (let i = 0; i < list.length; i++) {
            const r = list[i]!;
            consider(r, c, (cnt - 1) * (rowsRe[r]!.size - 1));
          }
        }
        for (let r = rowB.head[cnt]!; r >= 0; r = rowB.next[r]!) {
          if (bestRow >= 0 && ++examined > SEARCH_LIMIT) break search;
          for (const c of rowsRe[r]!.keys()) {
            consider(r, c, (cnt - 1) * (colRows[c]!.length - 1));
          }
        }
        if (bestRow >= 0 && bestCost <= cnt * cnt) break;
      }

      if (bestRow < 0) {
        // A node left with only rounding noise floats behind very large conductances: its row is
        // numerically zero, not contradictory, so pivot on the diagonal and let numeric() fix it.
        for (let r = 0; r < n && bestRow < 0; r++) {
          if (rowDone[r] || !mat.isNode(r + 1)) continue;
          for (const col of rowsRe[r]!.keys()) {
            if (!colDone[col] && mat.isNode(col + 1)) {
              rowsRe[r]!.set(col, boostedPivot(scale[r]!));
              if (im) rowsIm[r]!.set(col, 0);
              bestRow = r;
              bestCol = col;
              break;
            }
          }
        }
      }
      if (bestRow < 0) {
        this.reportSingular(rowDone, colDone, n);
        return LU_SINGULAR;
      }

      const p = bestRow;
      const q = bestCol;
      pr[k] = p;
      pc[k] = q;
      rowDone[p] = 1;
      colDone[q] = 1;
      const pivotRe = rowsRe[p]!;
      const pivotIm = im ? rowsIm[p]! : null;
      const pCols = Array.from(pivotRe.keys());
      uCols[p] = pCols;
      rowB.remove(p);
      colB.remove(q);
      for (let i = 0; i < pCols.length; i++) {
        const list = colRows[pCols[i]!]!;
        const at = list.indexOf(p);
        list[at] = list[list.length - 1]!;
        list.pop();
      }

      const pvr = pivotRe.get(q)!;
      const pvi = pivotIm ? pivotIm.get(q)! : 0;
      const pden = pvr * pvr + pvi * pvi;
      const elim = colRows[q]!;
      for (let i = 0; i < elim.length; i++) {
        const r = elim[i]!;
        const rowR = rowsRe[r]!;
        const rowI = im ? rowsIm[r]! : null;
        const ar = rowR.get(q)!;
        const ai = rowI ? rowI.get(q)! : 0;
        const mr = (ar * pvr + ai * pvi) / pden;
        const mi = (ai * pvr - ar * pvi) / pden;
        rowR.delete(q);
        if (rowI) rowI.delete(q);
        lCols[r]!.push(q);
        for (let j = 0; j < pCols.length; j++) {
          const c = pCols[j]!;
          if (c === q) continue;
          const ur = pivotRe.get(c)!;
          const old = rowR.get(c);
          if (rowI) {
            const ui = pivotIm!.get(c)!;
            const dr = mr * ur - mi * ui;
            const di = mr * ui + mi * ur;
            if (old === undefined) {
              rowR.set(c, -dr);
              rowI.set(c, -di);
              colRows[c]!.push(r);
            } else {
              rowR.set(c, old - dr);
              rowI.set(c, rowI.get(c)! - di);
            }
          } else if (old === undefined) {
            rowR.set(c, -mr * ur);
            colRows[c]!.push(r);
          } else {
            rowR.set(c, old - mr * ur);
          }
        }
        rowB.move(r, rowR.size);
      }
      for (let j = 0; j < pCols.length; j++) {
        const c = pCols[j]!;
        if (c !== q) colB.move(c, colRows[c]!.length);
      }
      colRows[q] = [];
    }

    this.buildPattern(pr, pc, lCols, uCols);
    return LU_OK;
  }

  private reportSingular(rowDone: Uint8Array, colDone: Uint8Array, n: number): void {
    this.failRow = 0;
    this.failCol = 0;
    for (let i = 0; i < n; i++) {
      if (!this.failRow && !rowDone[i]) this.failRow = i + 1;
      if (!this.failCol && !colDone[i]) this.failCol = i + 1;
    }
  }

  private buildPattern(pr: Int32Array, pc: Int32Array, lCols: number[][], uCols: number[][]): void {
    const mat = this.mat;
    const n = mat.n;
    const cinv = new Int32Array(n);
    const rinv = new Int32Array(n);
    let nnz = 0;
    for (let k = 0; k < n; k++) {
      cinv[pc[k]!] = k;
      rinv[pr[k]!] = k;
      nnz += lCols[pr[k]!]!.length + uCols[pr[k]!]!.length;
    }
    const rowPtr = new Int32Array(n + 1);
    const colIdx = new Int32Array(nnz);
    const diag = new Int32Array(n);
    let at = 0;
    for (let k = 0; k < n; k++) {
      const r = pr[k]!;
      rowPtr[k] = at;
      const cols = lCols[r]!.concat(uCols[r]!).map((c) => cinv[c]!);
      cols.sort((a, b) => a - b);
      for (let i = 0; i < cols.length; i++) {
        if (cols[i] === k) diag[k] = at;
        colIdx[at++] = cols[i]!;
      }
    }
    rowPtr[n] = at;
    const ns = mat.slotRow.length;
    const slotMap = new Int32Array(ns);
    for (let s = 1; s < ns; s++) {
      const k = rinv[mat.slotRow[s]!]!;
      const j = cinv[mat.slotCol[s]!]!;
      let lo = rowPtr[k]!;
      let hi = rowPtr[k + 1]! - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (colIdx[mid]! < j) lo = mid + 1;
        else hi = mid;
      }
      slotMap[s] = lo;
    }
    this.pr = pr;
    this.pc = pc;
    this.rowPtr = rowPtr;
    this.colIdx = colIdx;
    this.diag = diag;
    this.slotMap = slotMap;
    this.lu = new Float64Array(nnz);
    if (this.complex) this.luIm = new Float64Array(nnz);
    this.analyzed = true;
  }

  /** Stored entries in L+U, for reporting. */
  get fillNonzeros(): number {
    return this.colIdx.length;
  }
}
