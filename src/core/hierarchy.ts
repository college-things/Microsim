// Hierarchy is resolved before SPICE generation. Qualified ids keep result maps unambiguous;
// qualified reference designators pass through the existing SPICE-name map. We avoid .subckt
// instances here because instruments and probes already address individual component ids.
import { buildFlatNetlist, pinWorld } from "./netlist";
import { circuitPages, emptySchematic, type BlockDefinition, type SchComponent, type Schematic } from "./schematic";

export function hasHierarchy(s: Schematic): boolean {
  return Boolean(s.pages?.length || s.components.some((c) => c.blockId));
}

export function blockPorts(block: BlockDefinition): SchComponent[] {
  return block.components.filter((c) => c.kind === "hierarchy-port");
}

export function blockSymbol(block: BlockDefinition, id: string, refDes: string, x: number, y: number): SchComponent {
  const ports = blockPorts(block);
  const height = Math.max(40, ports.length * 20);
  return {
    id, refDes, kind: "hierarchy-block", blockId: block.id, x, y, rotation: 0, mirrored: false,
    params: {}, spice: "", displayValue: block.name,
    pins: ports.map((p, i) => ({ name: p.params.name, x: -50, y: i * 20 - (ports.length - 1) * 10 })),
    graphics: [
      { kind: "rect", x: -40, y: -height / 2, w: 80, h: height, filled: false },
      ...ports.flatMap((p, i) => {
        const y = i * 20 - (ports.length - 1) * 10;
        return [
          { kind: "line" as const, points: [{ x: -50, y }, { x: -40, y }] },
          { kind: "text" as const, x: 0, y, text: p.params.name, size: 9 },
        ];
      }),
    ],
  };
}

/** Separate sheet geometry before resolving labels: equal coordinates on different sheets
 * never connect, while labels (including aliases) use the existing union-find unchanged. */
function joinedPages(s: Schematic): Schematic {
  const out = emptySchematic(s.name);
  let left = 0;
  for (const page of circuitPages(s)) {
    const copy = structuredClone({ components: page.components, wires: page.wires, labels: page.labels });
    const xs = [...copy.components.flatMap((c) => c.pins.map((p) => pinWorld(c, p).x)), ...copy.wires.flatMap((w) => w.points.map((p) => p.x)), ...copy.labels.map((l) => l.x)];
    const min = xs.reduce((a, b) => Math.min(a, b), 0), max = xs.reduce((a, b) => Math.max(a, b), 0);
    const dx = left - min;
    for (const c of copy.components) c.x += dx;
    for (const p of [...copy.wires.flatMap((w) => w.points), ...copy.labels]) p.x += dx;
    out.components.push(...copy.components);
    out.wires.push(...copy.wires);
    out.labels.push(...copy.labels);
    left += max - min + 200;
  }
  out.definitions = [...new Set(circuitPages(s).map((p) => p.definitions))].filter(Boolean).join("\n");
  return out;
}

export function flattenCircuit(s: Schematic, drawing = false): Schematic {
  if (!hasHierarchy(s)) return s;
  const out = emptySchematic(s.name);
  const definitions = new Set<string>();
  const blocks = new Map((s.blocks ?? []).map((b) => [b.id, b]));
  const sources = new Map<string, SchComponent>();
  let coordinate = 0;
  let count = 0;
  const visit = (sheet: Schematic, path: string, idPath: string, bindings: Map<string, string>, stack: string[]) => {
    if (stack.length > 32) throw new Error("Blocks are nested more than 32 levels deep.");
    definitions.add(sheet.definitions);
    const local = buildFlatNetlist(sheet);
    const portBindings = new Map<string, string>();
    for (const c of sheet.components.filter((c) => c.kind === "hierarchy-port")) {
      const net = local.pinNets.get(c.id)?.get("port");
      const bound = bindings.get(c.params.name);
      if (net && bound) {
        if (net === "0" && bound !== "0") {
          out.labels.push({ id: `ground-${out.labels.length}`, x: (coordinate += 10), y: 0, net: "0" }, { id: `ground-${out.labels.length + 1}`, x: coordinate, y: 0, net: bound });
        }
        const previous = portBindings.get(net);
        // Two ports on the same internal net short their external pins as well.
        if (previous && previous !== bound) {
          const x = (coordinate += 10);
          for (const net of [previous, bound]) out.labels.push({ id: `port-alias-${out.labels.length}`, x, y: 0, net });
        }
        portBindings.set(net, bound);
      }
    }
    const scope = (net: string) => net === "0" ? "0" : portBindings.get(net) ?? `${path}${net}`;
    for (const c of sheet.components) {
      if (++count > 100000) throw new Error("The expanded circuit has more than 100000 parts.");
      if (path && (c.instrument || c.indicator || c.kind === "lcd16x2")) throw new Error(`${path}${c.refDes}: instruments and result displays must be placed outside blocks.`);
      const nets = local.pinNets.get(c.id);
      const pinNets = new Map(c.pins.map((p) => [p.name, scope(nets?.get(p.name) ?? `nc_${c.id}_${p.name}`)]));
      const copy = structuredClone(c);
      delete copy.blockId;
      copy.id = `${idPath}${c.id}`;
      if (drawing) sources.set(copy.id, c);
      copy.refDes = `${path}${c.refDes}`;
      copy.x = copy.y = 0;
      copy.rotation = 0; copy.mirrored = false;
      copy.pins = c.pins.map((p) => ({ ...p, x: (coordinate += 10), y: 0, net: pinNets.get(p.name) }));
      out.components.push(copy);
      if (!c.blockId) continue;
      const block = blocks.get(c.blockId);
      if (!block) throw new Error(`${c.refDes}: the block definition is missing.`);
      if (stack.includes(block.id)) throw new Error(`${block.name}: blocks cannot contain themselves.`);
      const names = blockPorts(block).map((p) => p.params.name);
      if (names.length !== c.pins.length || names.some((name) => !pinNets.has(name))) throw new Error(`${c.refDes}: block pins do not match its ports.`);
      visit(block, `${path}${c.refDes}.`, `${idPath}${c.id}/`, pinNets, [...stack, block.id]);
    }
    const spots = new Map<string, number>();
    for (const [name, net] of local.namedNets) {
      const canonical = scope(net);
      let x = spots.get(canonical);
      if (x === undefined) { x = (coordinate += 10); spots.set(canonical, x); }
      for (const label of [canonical, path ? `${path}${name}` : name]) out.labels.push({ id: `alias-${out.labels.length}`, x, y: 0, net: label });
    }
  };
  visit(joinedPages(s), "", "", new Map(), []);
  out.definitions = [...definitions].filter(Boolean).join("\n");
  if (drawing) {
    // Native flat export uses a simple row of leaf symbols, retaining each original
    // symbol's pin geometry. Resolve aliases before removing the temporary geometry.
    const resolved = buildFlatNetlist(out);
    out.components = out.components.filter((c) => !c.kind.startsWith("hierarchy-"));
    let left = 0;
    for (const c of out.components) {
      const source = sources.get(c.id)!;
      c.rotation = source.rotation; c.mirrored = source.mirrored;
      c.pins = source.pins.map((p) => ({ ...p, net: resolved.pinNets.get(c.id)?.get(p.name) }));
      const xs = c.pins.map((p) => pinWorld(c, p).x);
      const min = xs.reduce((a, b) => Math.min(a, b), 0), max = xs.reduce((a, b) => Math.max(a, b), 0);
      c.x = left - min;
      left += max - min + 200;
    }
    out.labels = [];
  }
  return out;
}
