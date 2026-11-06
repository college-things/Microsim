# Microsim

A lightweight circuit simulator with an AI assistant, for the browser and the Mac desktop. It can open `.ms14` circuit files.

Microsim is an independent project. It is not affiliated with or endorsed by National Instruments or Emerson. Multisim is a trademark of its owner, and is named here only to describe file compatibility.

## Develop

Open **Settings** in the toolbar or press **Ctrl/Cmd+,** to choose English, Ukrainian or Russian, a system/light/dark/midnight/high-contrast theme, accent color, text size, reduced motion, editor grid and snapping, live wire voltages, and recovery autosave delay. Changes preview immediately; Save keeps them locally and Cancel restores the previous preferences. Restore defaults keeps circuit data and the assistant key.

Translations cover interface labels and built-in part properties. Circuit names, notes, net names, component values, SPICE, firmware source, expressions, and units remain as authored. Technical diagnostics from external tools may remain in English. UI translations live in `src/ui/locales/messages.ts`; explicit text bindings in `src/ui/i18n.ts` retain the original keys for live language switching.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run typecheck
```

Tests that read `.ms14` samples use a local Circuit Design Suite install and skip when it is absent. No vendor files or models are stored in this repository.

## Build the website

```bash
npm run build:web
```

```bash
npm run preview
```

The site is static files in `dist`, and circuits are simulated and stay in the browser. The `Deploy website` workflow in GitHub Actions publishes it to GitHub Pages when run by hand.

## Build the Mac app

macOS builds must run on macOS. Install Rust and the Xcode command line tools, then run:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

```bash
npm install
```

```bash
npx tauri build --target universal-apple-darwin
```

Or run the `Build macOS app` workflow in GitHub Actions, which uploads a `.dmg`. Public distribution also needs an Apple Developer ID for signing and notarization.

## Layout

| Path | Purpose |
| --- | --- |
| `src/core` | Document model, parts library, netlister, multi-run analyses |
| `src/engine` | SPICE-compatible simulator |
| `src/importer` | `.ms14` reader. The format is described in `docs/ms14-format.md` |
| `src/sim` | Web Worker wrapper around the engine |
| `src/ui` | Schematic canvas, instruments, plots, application shell |
| `src/agent` | Assistant loop and circuit tools |
| `src-tauri` | Native desktop shell |

## Using it

See **Help > Getting started** in the app. Microsim opens `.microsim` circuits (and `.ohmlet` ones saved before the rename), `.ms14` files, and plain SPICE decks (`.cir`, `.sp`). Files from other Multisim versions (`.ms10` to `.ms13`) can be opened but are untested. It saves `.microsim` files and can write `.ms14` through **File > Save as .ms14**. It also exports SVG, SPICE netlists, CSV and a KiCad PCB board. Imported `.ms14` circuits can retain native records and supported parameter edits (checked in Multisim 14.2). All seven new starter circuits opened in Multisim 14.2, including verified native RC connectivity and ground; a generated RC circuit also entered native transient simulation. Imported structural edits can use the explicit flattened `.ms14` export; unknown native behavior is not recreated. Native simulation equivalence remains unverified. On the website, Save downloads a new file each time and Save as asks for its name, because a browser can't overwrite the file you opened. The website is made for a computer. On a phone it opens and runs circuits and shows the results, but editing by touch is awkward.

## What it doesn't do

Microsim covers analog and basic digital simulation. The **Design** menu adds PCB editing and fabrication export, an editable local dataflow controller, optional LabVIEW HTTP/native VI links, a component catalogue with installed NI database import, and build integration for 8051 C and VHDL/iCE40 FPGA designs. The local dataflow controller runs without NI software. C and FPGA builds use separately installed SDCC and GHDL/Yosys/nextpnr tools. Native VI execution requires LabVIEW; synchronized NI co-simulation is not implemented. The palette includes original tank/conveyor models and Agilent/Tektronix style instruments. These workflows are not full Multisim or LabVIEW equivalents. Compiled or imported Intel HEX runs on the independent built-in 8051 core with GPIO, timers and interrupts. Imported NI 8051/8052 and supported PIC16 parts run once their programs are loaded. NI LCDs and other MCU families remain unsupported; PIC peripherals beyond GPIO and TMR0 report an error when used. Imported hierarchical sheets are flattened. See [design workflows](docs/design-workflows.md) and **Help > What Microsim doesn't do** for supported behavior and remaining limits.

## Assistant

The assistant needs an Anthropic API key, entered in its Settings. The desktop app keeps the key unencrypted in its local storage, and the website keeps it only until the tab closes. The circuit, including any model text from files you imported, and your messages are sent to Anthropic only when you use the assistant. Check that you may share a vendor's model before using the assistant on a circuit that contains it.

See [docs/limits.md](docs/limits.md) for the full list of what can't be done, what is only approximate, and what still needs a person.

## Before a public release

- Test by hand on a real Mac. The app builds and launches on GitHub's macOS runner, but that's no substitute for someone using it.
- Add an Apple Developer ID. The workflow reads the `APPLE_*` secrets it needs for signing and notarization. Until then builds are only ad-hoc signed, so macOS warns people who download them. To open one anyway, right-click the app and choose Open, or if macOS says it's damaged, run `xattr -cr /Applications/Microsim.app`.
- Clear the name. `Microsim` is close to Multisim, and MicroSim was the name of the company behind PSpice, with a past trademark for circuit design software. Check its current status before release.
- Have counsel review `.ms14` support and `docs/ms14-format.md` against the vendor's license terms, how close the interface is to Multisim's, and vendor model text being stored in saved files and sent to the assistant.
- Choose a license for this project, and add third-party notices for its dependencies.
