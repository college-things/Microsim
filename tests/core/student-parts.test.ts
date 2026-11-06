import { describe, expect, it } from 'vitest';
import { PART_BY_KIND } from '../../src/core/library';
import { studentParts } from '../../src/core/student-parts';
import { PARTS } from '../../src/core/library';
import { simulate } from '../../src/engine';
import { findVector } from '../../src/core/analyses';
import type { AnalysisRequest, SimResult } from '../../src/core/sim';
import { Doc } from '../../src/core/doc';
import { buildExample, EXAMPLES } from '../../src/core/examples';
import { buildNetlist } from '../../src/core/netlist';
import { readIndicator } from '../../src/core/indicators';
import { applyInteractive } from '../../src/importer/interactive';

function device(kind: string, pins: Record<string, string>, params: Record<string, string> = {}) {
  const p = PART_BY_KIND.get(kind)!;
  const values = { ...Object.fromEntries(p.params.map(p => [p.key, p.default])), ...params };
  return p.spice.replace(/\{ref\}/g, p.prefix + '1').replace(/\{pin:([^}]+)\}/g, (_, pin: string) => pins[pin] ?? pin).replace(/\{param:([^}]+)\}/g, (_, key: string) => values[key]) + '\n' + (p.definitions ?? '');
}
function run(kind: string, pins: Record<string, string>, circuit: string, params = {}, request: AnalysisRequest = { type: 'op' }) {
  const result = simulate(`Library behavior\n${circuit}\n${device(kind, pins, params)}\n.end`, request);
  expect(result.warnings.filter(w => /unsupported|ignored/i.test(w))).toEqual([]);
  return result;
}
const vector = (r: SimResult, name: string) => findVector(r, name)!.re;
const v = (r: SimResult, node: string) => vector(r, `v(${node})`)[0];
const tran: AnalysisRequest = { type: 'tran', tstop: 0.012, tstep: 2e-6, tmax: 5e-6 };
const at = (r: SimResult, name: string, t: number) => {
  const axis = r.axis!.re;
  let i = 0;
  while (i + 1 < axis.length && axis[i] < t) i++;
  return vector(r, `v(${name})`)[i];
};

describe('original student part library', () => {
  it('registers every addition with unique pins, a drawing and a model', () => {
    const parts = studentParts(PARTS);
    expect(new Set(PARTS.map(p => p.kind)).size).toBe(PARTS.length);
    for (const p of parts) {
      expect(PART_BY_KIND.get(p.kind)).toBeDefined();
      expect(p.graphics.length, p.kind).toBeGreaterThan(0);
      expect(p.spice, p.kind).not.toBe('');
      expect(new Set(p.pins.map(p => p.name)).size).toBe(p.pins.length);
    }
  });
  for (const [kind, params, resistance] of [
    ['trimmer', { percent: '25' }, 2500], ['lamp', {}, 120], ['buzzer', {}, 100],
    ['ldr', { lux: '100' }, 10000 * 10 ** -0.7], ['ntc', { temperature: '50' }, 10000 * Math.exp(3950 * (1 / 323.15 - 1 / 298.15))],
  ] as const) {
    it(`${kind} follows its resistance law`, () => {
      const r = run(kind, { '1': 'a', '2': '0' }, 'Vtest a 0 1', params);
      expect(-vector(r, 'i(vtest)')[0]).toBeCloseTo(1 / resistance, 7);
    });
  }
  it('electrolytic has the requested charge time constant', () => {
    const r = run('electrolytic', { '1': 'cap', '2': '0' }, 'Vtest a 0 PULSE(0 1 1u 1n 1n 1 2)\nRcharge a cap 100', { value: '10u' }, { type: 'tran', tstop: 0.002, tstep: 2e-6, tmax: 2e-6 });
    expect(at(r, 'cap', 0.001001)).toBeCloseTo(1 - Math.exp(-1), 2);
  });
  it('crystal series branch resonates at the selected frequency', () => {
    const r = run('crystal', { '1': 'a', '2': '0' }, 'Vtest a 0 AC 1', {}, { type: 'ac', sweep: 'lin', points: 3, fstart: 0.99e6, fstop: 1.01e6 });
    expect(Math.abs(vector(r, 'i(vtest)')[1])).toBeCloseTo(1 / 30, 4);
    expect(Math.abs(vector(r, 'i(vtest)')[0])).toBeLessThan(0.001);
  });
  it('fuse holds its rating and opens irreversibly after excess I-squared time', () => {
    const r = run('fuse', { '1': 's', '2': 'out' }, 'Vtest s 0 PULSE(0 5 1m 1u 1u 1 2)\nRload out 0 10', { rating: '0.1', delay: '10m' }, { type: 'tran', tstop: 0.02, tstep: 10e-6, tmax: 20e-6 });
    expect(at(r, 'out', 0.0011)).toBeGreaterThan(4.8);
    expect(at(r, 'out', 0.015)).toBeLessThan(0.001);
    const held = run('fuse', { '1': 's', '2': 'out' }, 'Vtest s 0 0.5\nRload out 0 10', {}, { type: 'tran', tstop: 0.02, tstep: 0.0001 });
    expect(at(held, 'out', 0.02)).toBeGreaterThan(0.49);
  });
  it('relay pulls in at 9 V, holds at 6 V and drops below 3 V', () => {
    const r = run('relay', { 'coil+': 'coil', 'coil-': '0', COM: 'supply', NO: 'out' }, 'Vcoil coil 0 PWL(0 0 1m 0 2m 12 3m 12 4m 6 5m 6 6m 0)\nVcc supply 0 5\nRload out 0 1k', {}, { type: 'tran', tstop: 0.007, tstep: 2e-6, tmax: 5e-6 });
    expect(at(r, 'out', 0.0015)).toBeLessThan(0.01);
    expect(at(r, 'out', 0.0025)).toBeGreaterThan(4.99);
    expect(at(r, 'out', 0.0045)).toBeGreaterThan(4.99);
    expect(at(r, 'out', 0.0065)).toBeLessThan(0.01);
  });
  for (const kind of ['push-button', 'spdt']) it(`${kind} changes live through the existing control mechanism`, () => {
    const doc = new Doc(), c = doc.addPart(kind, 0, 0);
    expect(c.interactive?.kind).toBe('switch');
    expect(c.interactive?.kind === 'switch' && c.interactive.momentary).toBe(kind === 'push-button');
    for (const level of [0, 1, 0]) {
      const changed = applyInteractive(c, level);
      const r = run(kind, { COM: 'supply', NC: 'nc', NO: 'out' }, 'Vtest supply 0 5\nRload out 0 1k' + (kind === 'spdt' ? '\nRnc nc 0 1k' : ''), changed.params);
      expect(v(r, 'out') > 2.5).toBe(level === 1);
      if (kind === 'spdt') expect(v(r, 'nc') > 2.5).toBe(level === 0);
    }
  });
  for (const [kind, target, tolerance] of [
    ['1n4148', 0.71, 0.1], ['1n4007', 0.69, 0.1], ['1n5819', 0.18, 0.1],
    ['led-red', 1.9, 0.12], ['led-green', 2.2, 0.12], ['led-blue', 3.1, 0.12], ['led-white', 3.2, 0.12],
  ] as const) it(`${kind} forward voltage at 10 mA`, () => {
    const r = run(kind, { A: 'anode', K: '0' }, 'Itest 0 anode 10m');
    expect(Math.abs(v(r, 'anode') - target)).toBeLessThan(tolerance);
  });
  for (const [kind, target] of [['zener-5v1', 5.1], ['zener-12v', 12]] as const) it(`${kind} clamps at 5 mA`, () => {
    const r = run(kind, { A: '0', K: 'cathode' }, 'Itest 0 cathode 5m');
    expect(v(r, 'cathode')).toBeCloseTo(target, 1);
  });
  for (const [kind, beta, pnp] of [['2n3904', 190, false], ['2n3906', 180, true], ['2n2222a', 200, false], ['bc547b', 300, false]] as const) it(`${kind} has plausible gain and Vbe near 10 mA`, () => {
    const sign = pnp ? -1 : 1;
    const r = run(kind, { C: 'collector', B: 'base', E: '0' }, `Vcollector collector 0 ${sign * 5}\nIbase 0 base ${sign * 0.00005}`);
    const gain = -vector(r, 'i(vcollector)')[0] / (sign * 0.00005);
    expect(gain).toBeGreaterThan(beta * 0.65);
    expect(gain).toBeLessThan(beta * 1.15);
    expect(sign * v(r, 'base')).toBeGreaterThan(0.6);
    expect(sign * v(r, 'base')).toBeLessThan(0.85);
  });
  it('TIP120 has two Vbe drops and Darlington gain', () => {
    const r = run('tip120', { C: 'collector', B: 'base', E: '0' }, 'Vcollector collector 0 5\nIbase 0 base 100u');
    expect(-vector(r, 'i(vcollector)')[0] / 0.0001).toBeGreaterThan(1000);
    expect(v(r, 'base')).toBeGreaterThan(1.2);
    expect(v(r, 'base')).toBeLessThan(1.8);
  });
  for (const [kind, target] of [['2n7000', 2.5], ['irf540n', 0.036]] as const) it(`${kind} on resistance at Vgs=10 V`, () => {
    const r = run(kind, { D: 'drain', G: 'gate', S: '0' }, 'Vgate gate 0 10\nIdrain 0 drain 100m');
    const resistance = v(r, 'drain') / 0.1;
    expect(resistance).toBeGreaterThan(target * 0.5);
    expect(resistance).toBeLessThan(target * 1.3);
  });
  for (const kind of ['lm741', 'lm358', 'tl072']) it(`${kind} follows its input and clips at its supply headroom`, () => {
    const circuit = 'Vp vp 0 15\nVn vn 0 -15\nVin inp 0 2\nRload out 0 10k';
    const r = run(kind, { '+': 'inp', '-': 'out', 'V+': 'vp', 'V-': 'vn', OUT: 'out' }, circuit);
    expect(v(r, 'out')).toBeCloseTo(2, 2);
    const saturated = run(kind, { '+': 'inp', '-': '0', 'V+': 'vp', 'V-': 'vn', OUT: 'out' }, circuit);
    expect(v(saturated, 'out')).toBeGreaterThan(12.5);
    expect(v(saturated, 'out')).toBeLessThan(14);
  });
  it('LM311 needs a pull-up and sinks when IN- exceeds IN+', () => {
    for (const input of [1, 3]) {
      const r = run('lm311', { '+': 'inp', '-': 'ref', 'V+': 's', 'V-': '0', C: 'out', E: '0' }, `Vcc s 0 5\nVin inp 0 ${input}\nVref ref 0 2\nRpull s out 1k`);
      expect(v(r, 'out') > 2.5).toBe(input === 3);
    }
  });
  for (const [kind, target] of [['7805', 5], ['7812', 12]] as const) it(`${kind} regulates under load and exhibits dropout`, () => {
    const r = run(kind, { IN: 's', GND: '0', OUT: 'out' }, 'Vin s 0 18\nRload out 0 100');
    expect(v(r, 'out')).toBeCloseTo(target, 2);
    const dropout = run(kind, { IN: 's', GND: '0', OUT: 'out' }, 'Vin s 0 6\nRload out 0 100');
    expect(v(dropout, 'out')).toBeCloseTo(4, 2);
  });
  it('LM317 follows 1.25*(1+R2/R1)+Iadj*R2', () => {
    const r = run('lm317', { IN: 's', ADJ: 'adj', OUT: 'out' }, 'Vin s 0 15\nR1 out adj 240\nR2 adj 0 720\nRload out 0 1k');
    expect(v(r, 'out')).toBeCloseTo(5.036, 2);
  });
  it('NE555 astable frequency agrees with 1.44/((R1+2R2)*C) within 10%', () => {
    const r = run('ne555', { TRIG: 'cap', THRESH: 'cap', RESET: 's', CTRL: 'ctrl', VCC: 's', GND: '0', OUT: 'out', DISCH: 'disch' }, 'Vcc s 0 5\nR1 s disch 1k\nR2 disch cap 10k\nCtime cap 0 10n\nCctrl ctrl 0 10n\nRload out 0 10k', {}, { type: 'tran', tstop: 0.003, tstep: 0.5e-6, tmax: 1e-6 });
    const times: number[] = [], out = vector(r, 'v(out)');
    for (let i = 1; i < out.length; i++) if (out[i - 1] < 2 && out[i] >= 2) times.push(r.axis!.re[i]);
    expect(times.length).toBeGreaterThan(5);
    const frequency = (times.length - 2) / (times[times.length - 1] - times[1]);
    expect(Math.abs(frequency / (1.44 / (21000 * 10e-9)) - 1)).toBeLessThan(0.1);
  });
  for (const [kind, truth] of [['74hc00', [1, 1, 1, 0]], ['74hc02', [1, 0, 0, 0]], ['74hc08', [0, 0, 0, 1]], ['74hc32', [0, 1, 1, 1]], ['74hc86', [0, 1, 1, 0]]] as const) it(`${kind} truth table`, () => {
    truth.forEach((expected, i) => {
      const r = run(kind, { a: 'a', b: 'b', y: 'out' }, `Va a 0 ${i >> 1 ? 5 : 0}\nVb b 0 ${i & 1 ? 5 : 0}\nRload out 0 10k`);
      expect(v(r, 'out') > 2.5).toBe(expected === 1);
    });
  });
  it('74HC04 inverts', () => {
    for (const input of [0, 5]) expect(v(run('74hc04', { a: 'a', y: 'out' }, `Va a 0 ${input}\nRload out 0 10k`), 'out') > 2.5).toBe(input === 0);
  });
  it('74HC74 captures D and honors active-low preset and clear', () => {
    const pins = { D: 'data', CLK: 'clk', PRE_N: 'pre', CLR_N: 'clr', Q: 'q', QN: 'qn' };
    const r = run('74hc74', pins, 'Vdata data 0 5\nVclk clk 0 PULSE(0 5 1m 1u 1u 0.4m 1m)\nVpre pre 0 5\nVclr clr 0 PWL(0 0 0.1m 0 0.11m 5 2.5m 5 2.51m 0)\nRq q 0 10k\nRqn qn 0 10k', {}, tran);
    expect(at(r, 'q', 0.0005)).toBeLessThan(0.1);
    expect(at(r, 'q', 0.0012)).toBeGreaterThan(4.9);
    expect(at(r, 'q', 0.0027)).toBeLessThan(0.1);
  });
  it('74HC161 counts, wraps, loads and asynchronously clears', () => {
    const pins = { CLK: 'clk', CLR_N: 'clr', LOAD_N: 'load', ENP: 'en', ENT: 'en', A: 'one', B: '0', C: 'one', D: '0', QA: 'a', QB: 'b', QC: 'c', QD: 'd', RCO: 'carry' };
    const r = run('74hc161', pins, 'Vclk clk 0 PULSE(0 5 1m 1u 1u 0.4m 1m)\nVclr clr 0 PWL(0 0 0.1m 0 0.11m 5 10.5m 5 10.51m 0)\nVload load 0 PWL(0 5 3.5m 5 3.51m 0 4.5m 0 4.51m 5)\nVen en 0 5\nVone one 0 5', {}, tran);
    const count = (t: number) => ['a', 'b', 'c', 'd'].reduce((n, pin, i) => n + (at(r, pin, t) > 2.5 ? 2 ** i : 0), 0);
    expect(count(0.0005)).toBe(0);
    expect(count(0.0012)).toBe(1);
    expect(count(0.0032)).toBe(3);
    expect(count(0.0042)).toBe(5);
    expect(count(0.0062)).toBe(7);
    expect(count(0.0107)).toBe(0);
  });
  it('74HC595 shifts serial data then latches, with separate clear and output enable', () => {
    const pins = { SER: 'data', SRCLK: 'clk', RCLK: 'latch', CLR_N: 'clr', OE_N: '0', ...Object.fromEntries(['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'QH_SER'].map(s => [s, s.toLowerCase()])) };
    const r = run('74hc595', pins, 'Vdata data 0 5\nVclk clk 0 PULSE(0 5 1m 1u 1u 0.4m 1m)\nVlatch latch 0 PULSE(0 5 3.5m 1u 1u 0.1m 10m)\nVclr clr 0 PWL(0 0 0.1m 0 0.11m 5)', {}, tran);
    expect(at(r, 'qa', 0.0032)).toBeLessThan(0.1);
    for (const pin of ['qa', 'qb', 'qc']) expect(at(r, pin, 0.0037)).toBeGreaterThan(4.9);
    expect(at(r, 'qd', 0.0037)).toBeLessThan(0.1);
    expect(at(r, 'qh_ser', 0.0082)).toBeGreaterThan(4.9);
  });
  it('CD4017 advances one output at a time and wraps at ten', () => {
    const pins = { CLK: 'clk', INHIBIT: '0', RESET: 'rst', ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Q${i}`, `q${i}`])), CARRY: 'carry' };
    const r = run('cd4017', pins, 'Vclk clk 0 PULSE(0 5 1m 1u 1u 0.4m 1m)\nVrst rst 0 PWL(0 5 0.1m 5 0.11m 0)', {}, tran);
    for (let count = 0; count <= 11; count++) for (let pin = 0; pin < 10; pin++) expect(at(r, `q${pin}`, count * 0.001 + 0.0002) > 2.5, `${count} Q${pin}`).toBe(pin === count % 10);
  });
  for (const anode of [false, true]) it(`seven segment common ${anode ? 'anode' : 'cathode'} senses actual diode currents`, () => {
    const kind = anode ? 'sevenseg-ca' : 'sevenseg-cc', p = PART_BY_KIND.get(kind)!;
    const pins = { ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'].map(s => [s, s])), COM: anode ? 'vcc' : '0' };
    const sources = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'].map((s, i) => `R${s} ${s} ${i === 1 || i === 2 ? (anode ? '0' : 'vcc') : (anode ? 'vcc' : '0')} 330`).join('\n');
    const r = run(kind, pins, 'Vcc vcc 0 5\n' + sources);
    const comp = new Doc().addPart(kind, 0, 0);
    const display = readIndicator(comp, r, new Map(Object.entries(pins)), 'U1');
    expect(display?.text).toBe('1');
    expect(display?.segments).toEqual([false, true, true, false, false, false, false, false]);
    for (const sense of p.indicator!.senses!) expect(vector(r, `i(xu1.${sense})`)[0] > 0.001).toBe(sense === 'vb' || sense === 'vc');
  });
  for (const [kind, gbw] of [['lm741', 1e6], ['lm358', 1e6], ['tl072', 3e6]] as const) it(`${kind} unity-gain bandwidth matches the dominant-pole fit`, () => {
    const r = run(kind, { '+': 'inp', '-': 'out', 'V+': 'vp', 'V-': 'vn', OUT: 'out' }, 'Vp vp 0 15\nVn vn 0 -15\nVin inp 0 DC 0 AC 1\nRload out 0 1meg', {}, { type: 'ac', sweep: 'lin', points: 3, fstart: gbw * 0.99, fstop: gbw * 1.01 });
    const out = findVector(r, 'v(out)')!;
    expect(Math.hypot(out.re[1], out.im![1])).toBeCloseTo(1 / Math.SQRT2, 2);
  });
  for (const [kind, slew] of [['lm741', 0.5e6], ['lm358', 0.3e6], ['tl072', 13e6]] as const) it(`${kind} limits a follower step to its nominal slew rate`, () => {
    const r = run(kind, { '+': 'inp', '-': 'out', 'V+': 'vp', 'V-': 'vn', OUT: 'out' }, 'Vp vp 0 15\nVn vn 0 -15\nVin inp 0 PULSE(-2 2 1u 1n 1n 1m 2m)\nRload out 0 1meg', {}, { type: 'tran', tstop: 25e-6, tstep: 10e-9, tmax: 10e-9 });
    const axis = r.axis!.re, out = vector(r, 'v(out)');
    let fastest = 0;
    for (let i = 1; i < out.length; i++) if (axis[i - 1] > 1.1e-6 && out[i] < 1) fastest = Math.max(fastest, (out[i] - out[i - 1]) / (axis[i] - axis[i - 1]));
    expect(fastest).toBeGreaterThan(slew * 0.8);
    expect(fastest).toBeLessThan(slew * 1.05);
  });
  for (const kind of ['2n3904', '2n3906', '2n2222a', 'bc547b']) it(`${kind} saturates with forced beta ten`, () => {
    const sign = kind === '2n3906' ? -1 : 1;
    const r = run(kind, { C: 'collector', B: 'base', E: '0' }, `Ic 0 collector ${sign * 0.01}\nIb 0 base ${sign * 0.001}`);
    expect(sign * v(r, 'collector')).toBeGreaterThan(0);
    expect(sign * v(r, 'collector')).toBeLessThan(0.3);
    expect(sign * v(r, 'base')).toBeGreaterThan(0.65);
    expect(sign * v(r, 'base')).toBeLessThan(0.95);
  });
  it('7805 current limit holds at 1.5 A into overload', () => {
    const r = run('7805', { IN: 's', GND: '0', OUT: 'out' }, 'Vin s 0 12\nRload out 0 1');
    expect(v(r, 'out')).toBeCloseTo(1.5, 3);
  });
  it('74HC161 holds when disabled and wraps from 15 to zero', () => {
    const pins = { CLK: 'clk', CLR_N: 'clr', LOAD_N: 'one', ENP: 'en', ENT: 'one', A: '0', B: '0', C: '0', D: '0', QA: 'a', QB: 'b', QC: 'c', QD: 'd', RCO: 'carry' };
    const r = run('74hc161', pins, 'Vclk clk 0 PULSE(0 5 1m 1u 1u 0.4m 1m)\nVclr clr 0 PWL(0 0 0.1m 0 0.11m 5)\nVen en 0 PWL(0 0 2.5m 0 2.51m 5)\nVone one 0 5', {}, { ...tran, tstop: 0.019 });
    expect(at(r, 'a', 0.0022)).toBeLessThan(0.1);
    expect(at(r, 'carry', 0.0172)).toBeGreaterThan(4.9);
    for (const pin of ['a', 'b', 'c', 'd', 'carry']) expect(at(r, pin, 0.0182)).toBeLessThan(0.1);
  });
  it('74HC595 preserves storage on shift clear and releases its pins on OE_N', () => {
    const pins = { SER: 'one', SRCLK: 'clk', RCLK: 'latch', CLR_N: 'clr', OE_N: 'oe', ...Object.fromEntries(['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'QH_SER'].map(s => [s, s.toLowerCase()])) };
    const r = run('74hc595', pins, 'Vone one 0 5\nVclk clk 0 PULSE(0 5 1m 1u 1u 0.4m 1m)\nVlatch latch 0 PULSE(0 5 3.5m 1u 1u 0.1m 10m)\nVclr clr 0 PWL(0 0 0.1m 0 0.11m 5 4.5m 5 4.51m 0)\nVoe oe 0 PWL(0 0 5.5m 0 5.51m 5)\nRpull qa 0 100k', {}, tran);
    expect(at(r, 'qa', 0.005)).toBeGreaterThan(4.9);
    expect(at(r, 'qh_ser', 0.005)).toBeLessThan(0.1);
    expect(at(r, 'qa', 0.006)).toBeLessThan(0.1);
  });
  it('CD4017 inhibits counting and accepts the falling inhibit edge while CLK is high', () => {
    const pins = { CLK: 'clk', INHIBIT: 'inhibit', RESET: 'rst', ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Q${i}`, `q${i}`])), CARRY: 'carry' };
    const r = run('cd4017', pins, 'Vclk clk 0 PWL(0 0 1m 0 1.001m 5)\nVinh inhibit 0 PWL(0 5 2m 5 2.001m 0)\nVrst rst 0 PWL(0 5 0.1m 5 0.11m 0)', {}, tran);
    expect(at(r, 'q0', 0.0015)).toBeGreaterThan(4.9);
    expect(at(r, 'q1', 0.0025)).toBeGreaterThan(4.9);
  });
  it('NE555 RESET overrides a low trigger and clamps the discharge terminal', () => {
    const r = run('ne555', { TRIG: '0', THRESH: '0', RESET: '0', CTRL: 'ctrl', VCC: 's', GND: '0', OUT: 'out', DISCH: 'disch' }, 'Vcc s 0 5\nRcharge s disch 1k\nCctrl ctrl 0 10n\nRload out 0 10k');
    expect(v(r, 'out')).toBeLessThan(0.2);
    expect(v(r, 'disch')).toBeLessThan(0.01);
  });
  for (const [kind, pnp] of [['2n3904', false], ['2n3906', true], ['2n2222a', false], ['bc547b', false]] as const) it(`${kind} current gain rolls through unity in the datasheet RF range`, () => {
    const sign = pnp ? -1 : 1;
    const r = run(kind, { C: 'collector', B: 'base', E: '0' }, `Vc collector 0 ${sign * 5}\nVb base 0 DC ${sign * 0.72} AC 1`, {}, { type: 'ac', sweep: 'lin', points: 2, fstart: 100e6, fstop: 600e6 });
    const ic = findVector(r, 'i(vc)')!, ib = findVector(r, 'i(vb)')!;
    const gain = (i: number) => Math.hypot(ic.re[i], ic.im![i]) / Math.hypot(ib.re[i], ib.im![i]);
    expect(gain(0)).toBeGreaterThan(1);
    expect(gain(1)).toBeLessThan(1);
  });
  for (const [kind, capacitance, threshold] of [['2n7000', 45e-12, 2.1], ['irf540n', 1670e-12, 3]] as const) it(`${kind} has the fitted gate capacitance and threshold`, () => {
    const r = run(kind, { D: 'drain', G: 'gate', S: '0' }, 'Vd drain 0 10\nVg gate 0 DC 0 AC 1', {}, { type: 'ac', sweep: 'lin', points: 2, fstart: 1e6, fstop: 2e6 });
    const ig = findVector(r, 'i(vg)')!;
    expect(Math.abs(ig.im![0]) / (2 * Math.PI * 1e6)).toBeCloseTo(capacitance, 12);
    const below = run(kind, { D: 'drain', G: 'gate', S: '0' }, `Vd drain 0 5\nVg gate 0 ${threshold - 0.5}`);
    const above = run(kind, { D: 'drain', G: 'gate', S: '0' }, `Vd drain 0 5\nVg gate 0 ${threshold + 0.5}`);
    expect(-vector(below, 'i(vd)')[0]).toBeLessThan(1e-6);
    expect(-vector(above, 'i(vd)')[0]).toBeGreaterThan(0.01);
  });
  it('the drawn 555 blinker oscillates at the annotated frequency', () => {
    const schematic = buildExample(EXAMPLES.find(e => e.name === '555 LED blinker')!);
    const netlist = buildNetlist(schematic), timer = schematic.components.find(c => c.kind === 'ne555')!;
    const r = simulate(netlist.text, { type: 'tran', tstop: 1, tstep: 0.0002, tmax: 0.0002 });
    const out = vector(r, `v(${netlist.pinNets.get(timer.id)!.get('OUT')})`), times: number[] = [];
    for (let i = 1; i < out.length; i++) if (out[i - 1] < 2 && out[i] >= 2) times.push(r.axis!.re[i]);
    expect(times.length).toBeGreaterThan(4);
    const frequency = (times.length - 1) / (times[times.length - 1] - times[0]);
    expect(Math.abs(frequency / (1.44 / (21000 * 10e-6)) - 1)).toBeLessThan(0.1);
  });
  it('the drawn 7805 supply delivers 5 V into its 100 ohm load', () => {
    const schematic = buildExample(EXAMPLES.find(e => e.name === '7805 regulated supply')!);
    const netlist = buildNetlist(schematic), regulator = schematic.components.find(c => c.kind === '7805')!;
    const r = simulate(netlist.text, { type: 'op' });
    expect(v(r, netlist.pinNets.get(regulator.id)!.get('OUT')!)).toBeCloseTo(5, 2);
  });
});
