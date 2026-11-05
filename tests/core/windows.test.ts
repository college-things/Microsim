// Floating windows stay reachable, the menu bar can spell its shortcuts, and copying nothing keeps a copy.
import { describe, expect, it } from "vitest";
import { Doc } from "../../src/core/doc";
import { SchematicCanvas } from "../../src/ui/canvas";
import { clampWindow } from "../../src/ui/instruments";
import { nativeAccelerator } from "../../src/ui/platform";

describe("where a floating window may sit", () => {
  it("leaves one that is already on the sheet alone", () => {
    expect(clampWindow(200, 150, 1000, 600, 28)).toEqual({ left: 200, top: 150 });
  });

  it("can hang off the far edges, but keeps its title bar on the sheet", () => {
    expect(clampWindow(1400, 900, 1000, 600, 28)).toEqual({ left: 880, top: 572 });
  });

  it("stops at the near edges", () => {
    expect(clampWindow(-50, -50, 1000, 600, 28)).toEqual({ left: 0, top: 0 });
  });

  it("stays at the corner of a sheet too small to hold the rule", () => {
    expect(clampWindow(300, 300, 80, 20, 28)).toEqual({ left: 0, top: 0 });
  });
});

describe("shortcuts in the Mac menu bar", () => {
  it("spells Return the way the menu bar reads it", () => {
    expect(nativeAccelerator("Cmd+Return")).toBe("CmdOrCtrl+Enter");
    expect(nativeAccelerator("Cmd+Shift+Return")).toBe("CmdOrCtrl+Shift+Enter");
  });

  it("keeps the others", () => {
    expect(nativeAccelerator("Cmd+Shift+S")).toBe("CmdOrCtrl+Shift+S");
    expect(nativeAccelerator("Ctrl+O")).toBe("CmdOrCtrl+O");
  });

  it("leaves plain keys to keydown, or they couldn't be typed in fields", () => {
    for (const plain of ["L", "F5", "Del", "+", undefined]) expect(nativeAccelerator(plain)).toBeUndefined();
  });
});

describe("copying from the sheet", () => {
  const sheet = () => {
    const doc = new Doc();
    const part = doc.addPart("resistor", 0, 0);
    return { part, canvas: Object.assign(Object.create(SchematicCanvas.prototype), { doc, selection: new Set<string>(), onStatus: () => undefined }) as SchematicCanvas };
  };
  const held = (canvas: SchematicCanvas) => (canvas as unknown as { clipboard?: { components: unknown[] } }).clipboard;

  it("keeps the earlier copy when nothing is selected", () => {
    const { part, canvas } = sheet();
    canvas.selection.add(part.id);
    canvas.copySelected();
    canvas.selection.clear();
    canvas.copySelected();
    expect(held(canvas)?.components).toHaveLength(1);
  });

  it("holds nothing when nothing was ever copied", () => {
    const { canvas } = sheet();
    canvas.copySelected();
    expect(held(canvas)).toBeUndefined();
  });
});
