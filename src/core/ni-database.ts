import { expandTemplate, rewriteMergeNodes } from "../importer/template";
import type { DatabasePart } from "./component-database";
export interface NiPart {
  id: string; name: string; manufacturer: string; family: string; prefix: string;
  model: string; choices: string[]; pinNames: string[]; templates: string[]; definitions: string; source: string;
}
export function niPartToDatabasePart(part: NiPart): DatabasePart {
  if (!part || typeof part.name !== "string" || typeof part.model !== "string" || !Array.isArray(part.pinNames) || !part.pinNames.every((p) => typeof p === "string" && p.length > 0 && !/[{}\r\n]/.test(p)) || !Array.isArray(part.templates) || !part.templates.every((s) => typeof s === "string") || typeof part.definitions !== "string") throw new Error("Invalid NI component response.");
  const templates = part.templates.map((template) => expandTemplate({ template, parameters: [], strings: [], modelName: part.model, pinNames: part.pinNames }));
  const issues = templates.flatMap((t) => [...t.problems, ...t.unknownPins.map((p) => `Unknown pin ${p}`)]);
  if (issues.length) throw new Error(`The stored template cannot be converted: ${issues.join(" ")}`);
  const half = Math.ceil(part.pinNames.length / 2), height = Math.max(60, (half + 1) * 20);
  const pins = part.pinNames.map((name, i) => ({ name, x: i < half ? -70 : 70, y: -height / 2 + 20 * (i % half + 1) }));
  return {
    name: `${part.name} — ${part.model} (${part.manufacturer})`,
    definitions: rewriteMergeNodes(part.definitions),
    component: {
      id: `ni:${part.id}:${part.model}`, kind: "imported", refDes: `${part.prefix.replace(/[^A-Za-z]/g, "") || "U"}1`, x: 0, y: 0, rotation: 0, mirrored: false, pins, params: Object.assign({}, ...templates.map((t) => t.params)), spice: templates.map((t) => t.spice).join("\n"),
      displayValue: part.name,
      graphics: [{ kind: "rect", x: -50, y: -height / 2, w: 100, h: height, filled: false }, { kind: "text", x: 0, y: 0, text: part.name, size: 9 }, ...pins.flatMap((p) => [{ kind: "line" as const, points: [{ x: p.x, y: p.y }, { x: p.x < 0 ? -50 : 50, y: p.y }] }, { kind: "text" as const, x: p.x < 0 ? -36 : 36, y: p.y, text: p.name, size: 8 }])],
    },
  };
}
