# Plan: Microsim to production

Started 2026-11-06. This is the working plan for taking Microsim from "works and is tested" to a public release on Windows, macOS, Linux and the web. Tick items as they land. `docs/limits.md` stays the list of what is not possible.

## What "finished" means here

Microsim will not be a 1:1 copy of Multisim. NI's component collection, LabVIEW runtime, machine animations and Ultiboard are NI's property and can only be rebuilt independently, never copied. NI's license also bars reverse engineering its software. "Production" therefore means:

1. Everything a student or hobbyist does in Multisim day to day works: building circuits, the standard analyses and instruments, opening and saving `.ms14`, microcontrollers, reports and printing.
2. No known bugs. Errors are clear and nothing loses work.
3. Signed installers for Windows, macOS and Linux, a website build, a download page and release notes.
4. A person has used each platform's build by hand.

## Phase 0: Decisions only you can make

| Decision | Why it blocks | Status |
| --- | --- | --- |
| License | Releasing without one means nobody may legally use the code | MIT (2026-11-06) |
| Notarization credentials on the MacBook | Without notarization, macOS warns that the app may be harmful. I can't type Apple passwords | You store them as keychain profile `microsim-notary` |
| Windows code-signing certificate | Without one, Windows SmartScreen warns on first launch | Ship unsigned for now; release notes explain the warning |
| Name "Microsim" | It is close to Multisim and to MicroSim's old PSpice trademark | Keep it; you accept the risk |
| Legal review of `.ms14` support and interface similarity | Recommended before a public release | Your call; noted |

## Phase 1: Consolidate and protect the work

- [ ] Commit the uncommitted working tree to a `release/1.0` branch and open a PR to `main`; CI must pass.
- [ ] Add CI for tests, typecheck and the web build on every push (Windows and Linux runners).
- [ ] Version 1.0.0-beta.1 in `package.json`, `Cargo.toml` and `tauri.conf.json`.

## Phase 2: Hands-on testing and bug fixing

- [ ] Drive the web build in Chrome through every menu, dialog, example and instrument; file each problem and fix it.
- [ ] Run the Windows desktop build with computer use; check file open/save dialogs, recovery and the assistant without an API key.
- [ ] Run the macOS build on the MacBook over Tailscale with screenshots: launch, open samples, save, run, quit.
- [ ] Open all NI samples, run each and compare readings against Multisim 14.2 on this PC for a set of reference circuits.
- [ ] Performance: large samples must open in under 3 s and run without freezing the UI.

## Phase 3: Close the feature gaps that matter most

In order of how often Multisim users need them:

1. [x] Reports: bill of materials, electrical rules check, netlist export.
2. [x] Printing and PDF export of the schematic with a title block. File offers editable title fields, a single-sheet preview, A4/A3/US Letter/US Tabloid, either orientation, margins and fit or fixed scale. Print uses the browser/webview OS dialog; direct PDF export embeds a 300 dpi image. Native print dialogs still need hands-on checks on each platform.
3. [ ] Hierarchical blocks, subcircuits and multi-page designs.
4. [x] Analyses: parameter, temperature, nested and list sweeps; seeded Monte Carlo and sensitivity-first worst case; Fourier/THD and two-tone IMD; noise figure, measurements and saved batches. Engine runs, orchestration and spectral processing use the cancellable simulation worker. Circuit tests cover analytic divider spread/corners, RC measurements, clipped-sine THD, cubic two-tone IMD, resistor noise figure, ordering and seed reproducibility. See the analysis conventions and remaining boundaries in `docs/limits.md`; platform hands-on checks remain in Phase 2.
5. [x] Instruments: frequency counter, word generator, spectrum analyzer, logic converter, distortion analyzer and IV analyzer. The RF network analyzer is not planned (see limits).
6. [x] Parts: original student/hobby library expansion with passive controls, fuse/lamp/relay/crystal/buzzer, named diodes and LEDs, seven common transistors, LM741/LM358/TL072/LM311/NE555, 7805/7812/LM317, 74HC gates/flip-flop/counter/shift register, CD4017, seven-segment displays and LDR/NTC sensors. Each has behavior tests; 555 blinker and regulator examples have simulation and exhaustive wiring checks. See `docs/part-models.md` for model equations, datasheet sources, section/package choices and limitations. Remaining: bench/corner characterization and platform hands-on checks; SCR/triac/IGBT, ADC/DAC, analog switches and additional families remain outside this expansion.
7. [ ] Microcontrollers: HD44780-style LCD, 4x4 keypad, 8052 timer 2 and a debugger (breakpoints, pause, continue, step, registers) done; PIC16 core and assembler to go.
8. [ ] PCB: SMD pads, a footprint library, copper zones, silkscreen and a simple autorouter.

Not planned: native LabVIEW `.vi` execution, Ultiboard file compatibility, NI's animation scripts.

## Phase 4: Website

- [ ] Product page: what it does, screenshots, download buttons per platform, honest limits, link to the web app.
- [ ] Publish the web app and the page to GitHub Pages (`deploy-website.yml`).

## Phase 5: Releases

- [ ] GitHub Actions matrix builds: Windows (`.msi` and `.exe`), Linux (`.AppImage` and `.deb`), macOS (Apple Silicon and Intel), plus the web bundle.
- [ ] macOS: download the unsigned `.app` from CI to the MacBook, sign it with Developer ID and the hardened runtime, notarize it, staple it, build a `.dmg` and sign that.
- [ ] Windows: sign if a certificate is available; otherwise ship unsigned and say so in the release notes.
- [ ] Auto-update: Tauri updater keys and a `latest.json` feed.
- [ ] Release notes, checksums, and a GitHub release `v1.0.0`.

## Phase 6: After release

- [ ] Issue templates, a contribution guide and a security contact.
- [ ] Remove temporary NI sample copies from the MacBook (`~/ohmlet-pw/samples`).

## Risks

- **Power cuts.** Long runs die without warning. Work is backed up to `mac-testing-fixes` after each step.
- **MacBook disk.** 18 GB free. Builds run on GitHub; the Mac only signs and notarizes.
- **Scope.** Phase 3 is several weeks of work. Releases can ship as betas between items.
