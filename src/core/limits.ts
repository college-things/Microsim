// Parts a circuit can contain that Ohmlet draws but doesn't simulate. People need to hear
// about these directly, because the rest of the circuit still runs and looks fine.
import type { ImportIssue, Schematic } from "./schematic";

const UNSIMULATED: [RegExp, string][] = [
  [/\bd_cpu(pic)?\b/i, "a microcontroller"],
  [/\bd_lcd\w*/i, "an LCD"],
  [/\bd_serialport\b/i, "a serial port"],
];

const wholeName = (name: string) => new RegExp(`(^|[\\s([])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s)\\]])`, "i");

/** Plain-language notices for what this circuit has that won't be simulated. */
export function unsimulatedParts(doc: Schematic): string[] {
  // A part names its device directly, or through a model defined in the shared text.
  const modelKinds = new Map<RegExp, string>();
  for (const match of doc.definitions.matchAll(/^\s*\.model\s+(\S+)\s+([^\s(]+)/gim)) {
    for (const [pattern, name] of UNSIMULATED) if (pattern.test(match[2])) modelKinds.set(wholeName(match[1]), name);
  }
  const found = new Map<string, string[]>();
  for (const comp of doc.components) {
    let kind: string | undefined;
    for (const [pattern, name] of UNSIMULATED) if (pattern.test(comp.spice)) kind = name;
    if (!kind) for (const [model, name] of modelKinds) if (model.test(comp.spice)) kind = name;
    if (!kind) continue;
    if (!found.has(kind)) found.set(kind, []);
    if (comp.refDes) found.get(kind)!.push(comp.refDes);
  }
  return [...found].map(([kind, refs]) => {
    const noun = kind.replace(/^an? /, "");
    if (refs.length > 1) {
      return `${refs.join(", ")} are each ${kind}, which Ohmlet doesn't simulate. They do nothing here, so anything that depends on them, or on a program running on them, won't respond.`;
    }
    return `${refs[0] ?? "A part"} is ${kind}, which Ohmlet doesn't simulate. This ${noun} does nothing here, so anything that depends on it, or on a program running on it, won't respond.`;
  });
}

export function limitIssues(doc: Schematic): ImportIssue[] {
  return unsimulatedParts(doc).map((message) => ({ severity: "error" as const, message }));
}
