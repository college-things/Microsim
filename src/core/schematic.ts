// Document model shared by the editor, the agent, the netlister and the importer.

export interface Point {
  x: number;
  y: number;
}

/** Symbol drawing in component-local coordinates, y pointing down. */
export type Graphic =
  | { kind: "line"; points: Point[] }
  | { kind: "polygon"; points: Point[]; filled: boolean }
  | { kind: "rect"; x: number; y: number; w: number; h: number; filled: boolean }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; filled: boolean }
  | { kind: "text"; x: number; y: number; text: string; size: number };

export interface Pin {
  name: string;
  /** Position in component-local coordinates, before rotation and mirroring. */
  x: number;
  y: number;
  /**
   * Named net this pin always joins, whether or not a wire reaches it. Used for
   * ground, hidden power pins and connections restored from an imported file.
   */
  net?: string;
  /** Leaving it unconnected is normal, such as a microcontroller's unused port pin, so it gets no warning. */
  optional?: boolean;
}

export type InstrumentKind =
  | "oscilloscope"
  | "multimeter"
  | "function-generator"
  | "bode-plotter"
  | "wattmeter"
  | "logic-analyzer"
  | "serial-terminal"
  | "clock"
  | "unsupported";

/** How an imported part's setting can change while running. See applyInteractive in src/importer/interactive.ts. */
export type InteractiveSpec =
  | {
      kind: "switch";
      positions: number;
      position: number;
      /** Key shown on the part, such as "A" or "Space". */
      key?: string;
      /** Returns to position 0 when released. */
      momentary?: boolean;
      /** Level of the part's internal control, from low at position 0 to high at the last. */
      apply: { low: number; high: number };
      /** The part's whole drawing for each position. */
      stateGraphics?: Graphic[][];
    }
  | {
      kind: "variable";
      percent: number;
      key?: string;
      /** Percent per key press. */
      increment?: number;
      /** divider: total * percent and the rest. scale: total * percent. span: from min to max. */
      apply:
        | { mode: "divider" | "scale"; total: string; limits: [number, number] }
        | { mode: "span"; min: number; max: number };
    };

/**
 * A part that shows the simulation's result.
 *
 * reads "voltage": take v(net of pin). reads "current": take i(x<ref>.<sense>), where ref is the
 * netlister's SPICE name for the part, lower-cased with the rest of the vector name. Compare with
 * threshold, in thresholdUnit. A two-pin part reads the first pin minus the second.
 */
export interface IndicatorSpec {
  kind: "led" | "lamp" | "sevenseg" | "hexdigit" | "bargraph" | "probe" | "voltmeter" | "ammeter";
  /**
   * Data pins only, in canonical order. hexdigit: least significant bit first, so pins[i] has weight
   * 2^i. sevenseg: exactly segments a, b, c, d, e, f, g. bargraph: one pin per bar. Two-pin parts:
   * positive terminal first. Supply and common pins are never here.
   */
  pins: string[];
  reads: "voltage" | "current";
  /** The device whose current is the reading, inside the part's subcircuit. Positive when lit. */
  sense?: string;
  /** Per-pin version of sense, parallel to pins, for parts with several segments. */
  senses?: string[];
  /** Lit at or above this. Volts or amps as thresholdUnit says. */
  threshold?: number;
  thresholdUnit?: "V" | "A";
  /** Decimal point: its pin, read like the segments. Its sense is dpSense. */
  dp?: string;
  dpSense?: string;
  /** The shared pin of a display. It carries no data. */
  common?: string;
  /** A segment lights when driven low, as on a common-anode display. */
  activeLow?: boolean;
  /** Lamp rating, for brightness. */
  vmax?: number;
  pmax?: number;
  /** Whether a meter shows the RMS of the AC part or the mean. */
  mode?: "ac" | "dc";
}

export interface SchComponent {
  nativeMs14?: { sheet: string; component: string; symbol: string };
  id: string;
  refDes: string;
  /** Library part id such as "resistor", or "imported" for parts read from a file. */
  kind: string;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
  /** Values substituted into the template, e.g. { value: "10k" }. */
  params: Record<string, string>;
  pins: Pin[];
  /**
   * SPICE text for this part. Tokens: {ref} is the reference designator,
   * {pin:NAME} is the net on that pin, {param:NAME} is a params value.
   * Empty for parts that do not simulate, such as instruments and labels.
   */
  spice: string;
  /** Custom symbol. Library parts leave this unset and use their built-in symbol. */
  graphics?: Graphic[];
  /** Label shown beside the symbol, e.g. "10k". */
  displayValue?: string;
  instrument?: InstrumentKind;
  /** Imported parts: which params entry holds the main value, for sweeps and tolerance. */
  valueKey?: string;
  /** Imported parts: what the part is, so analyses can treat it like a library part. */
  family?: "resistor" | "capacitor" | "inductor";
  /** Imported parts: readable names for params keys, shown in Properties. */
  paramLabels?: Record<string, string>;
  /** Imported parts: a setting the user can change while running. */
  interactive?: InteractiveSpec;
  /** Imported parts: this part shows a result. */
  indicator?: IndicatorSpec;
  /** Other parts' SPICE refers to this part by name, so renaming it would break them. */
  lockedName?: boolean;
}

export interface Wire {
  id: string;
  points: Point[];
}

export interface NetLabel {
  id: string;
  x: number;
  y: number;
  /** Joins every wire touching this point to the named net. */
  net: string;
  /** Carries a connection without being drawn, such as an off-page link from a file. */
  hidden?: boolean;
}

export interface FreeText {
  id: string;
  x: number;
  y: number;
  text: string;
}

export interface TitleBlock {
  title?: string;
  author?: string;
  company?: string;
  documentNumber?: string;
  revision?: string;
  date?: string;
}

export interface Schematic {
  titleBlock?: TitleBlock;
  nativeMs14?: { xml: string; baseline: string };
  workspace?: import("./engineering").DesignWorkspace;
  name: string;
  components: SchComponent[];
  wires: Wire[];
  labels: NetLabel[];
  texts: FreeText[];
  /** Shared netlist text: .model, .subckt and similar definitions. */
  definitions: string;
}

export interface ImportIssue {
  severity: "info" | "warning" | "error";
  /** Reference designator, when the issue belongs to one part. */
  refDes?: string;
  message: string;
}

export interface ImportResult {
  schematic: Schematic;
  /** Analysis settings recovered from the file, in the file's order. */
  analyses: import("./sim").AnalysisRequest[];
  issues: ImportIssue[];
  format: { schema: string; application: string; version: string };
}

export function emptySchematic(name = "Untitled"): Schematic {
  return { name, components: [], wires: [], labels: [], texts: [], definitions: "" };
}
