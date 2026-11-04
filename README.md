# Ohmlet

A lightweight circuit simulator with an AI assistant, for the browser and the Mac desktop. It can open `.ms14` circuit files.

Ohmlet is an independent project. It is not affiliated with or endorsed by National Instruments or Emerson. Multisim is a trademark of its owner, and is named here only to describe file compatibility.

## Develop

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

See **Help > Getting started** in the app. Ohmlet opens `.ohmlet` circuits, `.ms14` files, and plain SPICE decks (`.cir`, `.sp`). Files from other Multisim versions (`.ms10` to `.ms13`) can be opened but are untested. It saves only to `.ohmlet`, and exports SVG, SPICE netlists and CSV. On the website, Save downloads a new file each time and Save as asks for its name, because a browser can't overwrite the file you opened. The website is made for a computer. On a phone it opens and runs circuits and shows the results, but editing by touch is awkward.

## What it doesn't do

Ohmlet covers analog and basic digital simulation, not everything Multisim does. It doesn't simulate microcontrollers, LCDs or serial ports, or support LabVIEW co-simulation. There's no component database, so real parts come from pasting their SPICE models. It has fewer instruments and analyses, flattens hierarchical sheets, and has no PCB flow. **Help > What Ohmlet doesn't do** has the full list. Circuits containing microcontrollers, LCDs or serial ports show a notice when opened, and other import limits are listed in the Issues tab.

## Assistant

The assistant needs an Anthropic API key, entered in its Settings. The desktop app keeps the key unencrypted in its local storage, and the website keeps it only until the tab closes. The circuit, including any model text from files you imported, and your messages are sent to Anthropic only when you use the assistant. Check that you may share a vendor's model before using the assistant on a circuit that contains it.

## Before a public release

- Test by hand on a real Mac. The app builds and launches on GitHub's macOS runner, but that's no substitute for someone using it.
- Add an Apple Developer ID. The workflow reads the `APPLE_*` secrets it needs for signing and notarization. Until then builds are only ad-hoc signed, so macOS warns people who download them. To open one anyway, right-click the app and choose Open, or if macOS says it's damaged, run `xattr -cr /Applications/Ohmlet.app`.
- Have counsel review `.ms14` support and `docs/ms14-format.md` against the vendor's license terms, how close the interface is to Multisim's, and vendor model text being stored in saved files and sent to the assistant.
- Choose a license for this project, and add third-party notices for its dependencies.
