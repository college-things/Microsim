import { describe, expect, it } from "vitest";
import { countFrequency, fft, parseWords, spectrum, wordGeneratorSources } from "../../src/core/measure";
import { simulate } from "../../src/engine";
import { at } from "../engine/helpers";

const sampled = (f: (t: number) => number, duration: number, samples: number) => {
  const time = Array.from({ length: samples }, (_, i) => (i / (samples - 1)) * duration);
  return { time, values: time.map(f) };
};

describe("frequency counter", () => {
  it("measures a sine's frequency to within 0.1%", () => {
    const { time, values } = sampled((t) => 2 + 3 * Math.sin(2 * Math.PI * 1234 * t), 0.02, 20000);
    const r = countFrequency(time, values)!;
    expect(r.frequency).toBeGreaterThan(1234 * 0.999);
    expect(r.frequency).toBeLessThan(1234 * 1.001);
    expect(r.duty).toBeCloseTo(0.5, 2);
    expect(r.peakToPeak).toBeCloseTo(6, 2);
  });
  it("reads a 25% duty pulse train and ignores noise near the threshold", () => {
    let seed = 1;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2;
    const { time, values } = sampled((t) => ((t * 5000) % 1 < 0.25 ? 5 : 0) + noise(), 0.01, 40000);
    const r = countFrequency(time, values)!;
    expect(r.frequency).toBeCloseTo(5000, -1);
    expect(r.duty).toBeCloseTo(0.25, 2);
    expect(r.highTime).toBeCloseTo(50e-6, 6);
  });
  it("gives nothing for a flat line or under two periods", () => {
    expect(countFrequency([0, 1, 2, 3, 4], [1, 1, 1, 1, 1])).toBeUndefined();
    const { time, values } = sampled((t) => Math.sin(2 * Math.PI * 10 * t), 0.15, 1000);
    expect(countFrequency(time, values)).toBeUndefined();
  });
});

describe("spectrum", () => {
  it("transforms a known sequence like a direct DFT", () => {
    const re = Float64Array.from([1, 2, 3, 4, 0, -1, 0.5, 2]), im = new Float64Array(8);
    const expected = Array.from({ length: 8 }, (_, k) => {
      let a = 0, b = 0;
      re.forEach((x, n) => { a += x * Math.cos((-2 * Math.PI * k * n) / 8); b += x * Math.sin((-2 * Math.PI * k * n) / 8); });
      return [a, b];
    });
    fft(re, im);
    expected.forEach(([a, b], k) => { expect(re[k]).toBeCloseTo(a, 9); expect(im[k]).toBeCloseTo(b, 9); });
  });
  it("finds two tones at their amplitudes", () => {
    const { time, values } = sampled((t) => 1 + 2 * Math.sin(2 * Math.PI * 1000 * t) + 0.5 * Math.sin(2 * Math.PI * 3000 * t), 0.05, 50000);
    const s = spectrum(time, values, 8192)!;
    expect(s.peak.frequency).toBeCloseTo(1000, -1);
    expect(s.peak.amplitude).toBeCloseTo(2, 1);
    const near3k = s.frequency.findIndex((f) => f >= 3000 - s.resolution / 2);
    expect(Math.max(s.amplitude[near3k - 1], s.amplitude[near3k], s.amplitude[near3k + 1])).toBeCloseTo(0.5, 1);
    expect(s.amplitude[0]).toBeLessThan(0.05); // the mean is removed
  });
});

describe("word generator", () => {
  it("reads hex and binary words and rejects others", () => {
    expect(parseWords("00 ff, 0x55; 1010b")).toEqual([0, 255, 0x55, 10]);
    expect(() => parseWords("1FF")).toThrow("more than 8 bits");
    expect(() => parseWords("zz")).toThrow("not a word");
    expect(() => parseWords("  ")).toThrow("at least one word");
  });
  it("drives each output bit through the pattern, repeating", () => {
    const sources = wordGeneratorSources([0x01, 0x02, 0x03], 1000, 5, true).map((line, bit) => line.replace("V{ref}", "VW").replace(`{pin:D${bit}}`, `d${bit}`)).join("\n");
    const result = simulate(`* words\n${sources}\n${Array.from({ length: 8 }, (_, b) => `R${b} d${b} 0 1k`).join("\n")}\n.end`, { type: "tran", tstep: 10e-6, tstop: 6e-3, tmax: 10e-6 });
    const word = (t: number) => Array.from({ length: 8 }, (_, b) => (at(result, `v(d${b})`, t) > 2.5 ? 1 << b : 0)).reduce((a, b) => a | b, 0);
    expect([0.5e-3, 1.5e-3, 2.5e-3, 3.5e-3, 4.5e-3, 5.5e-3].map(word)).toEqual([1, 2, 3, 1, 2, 3]);
  });
  it("holds the last word after a single pass", () => {
    const line = wordGeneratorSources([0x00, 0x01], 1000, 3.3, false)[0];
    expect(line).not.toContain("R=");
    expect(line).toMatch(/2e-3 3\.3\)|0\.002 3\.3\)/);
  });
});
