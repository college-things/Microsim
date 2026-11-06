# What Microsim can't do

This is the honest list: what won't be built, what can only be approximate, what isn't built yet, and what Claude, which is building this app, can't do or check without a person. It was written on 2026-11-05, while features are still being added, so section 3 will shrink.

## Design expansion update

The seven areas requested after this document was written now have initial workflows. See [design-workflows.md](design-workflows.md) for precise supported behavior, setup and verification. The entries below distinguish these implementations from native NI compatibility.

## Analyses update

The **Analyses** dialog now offers list and nested parameter/temperature sweeps, per-part Monte Carlo, sensitivity-first worst case, harmonic distortion, two-tone intermodulation, noise figure, measurements and saved batches. These extend the existing Fourier and sweep code. Multi-run orchestration, solves and spectral processing run in the simulation worker; Stop terminates the whole job. Result tables and plots use pages for large ensembles. The circuit document is not modified.

- **Sweeps:** ranges use an inclusive point count; an explicit comma- or space-separated list replaces the range and accepts engineering suffixes. Nested axes run outer first, preserving list order and duplicates. Either axis can be a parameter or temperature (Celsius); two temperature axes or the same parameter twice are rejected. Operating point, transient and AC are the dialog's base choices; the core accepts every base engine request. The core permits up to 100000 combinations.
- **Monte Carlo:** independently varies the main values of resistors, capacitors and inductors, including imported passives with a supported value key. Per-reference tolerances in the dialog override a part's `params.tolerance`, then the default applies to parts without one. Zero tolerance fixes a part. Uniform draws span plus/minus the tolerance. Gaussian tolerance means three standard deviations, with unbounded draws; a nonpositive drawn value stops the analysis with an error. Seeds are unsigned 32-bit integers, including zero; reproducibility assumes the same circuit, component order and settings. Statistics use population standard deviation and the chosen measurement; the histogram includes every completed run. Correlated tolerances and arbitrary semiconductor/model-parameter tolerances are not implemented.
- **Worst case:** one nominal solve, one positive-tolerance probe per varied passive, then the predicted high and low corners (N + 3 solves). Reports both corner measurements and all varied settings. This sensitivity-first method does not guarantee global extrema in nonlinear or nonmonotonic circuits; it does not enumerate all corners.
- **Distortion:** THD uses the existing Fourier interpolation over the last whole fundamental period, with 1 to 128 harmonics. Each harmonic is reported as a percentage of the fundamental, alongside magnitude and phase. THD includes only the requested harmonics. Two-tone IMD fits both carriers and second/third-order sum and difference products after settling, reporting each product and root-sum-square products relative to root-sum-square carriers. The circuit must already contain the requested tones. Use at least one beat period, adequate transient resolution and settled behavior. Coincident carrier/product frequencies cannot be separated; higher-order products and standardized instrument weighting are not implemented. Very long IMD windows are bounded to 262144 fit samples.
- **Noise figure:** uses total input-referred voltage-noise density squared divided by `4 k 290 Rsource`, in dB versus frequency. The noise run sets circuit temperature to 16.85 C (290 K); explicit device temperature overrides still apply. Include the stated series source resistance in the circuit, since its thermal noise must be part of the total. The input must be a voltage source; current-source and general impedance/noise-correlation formulations are not implemented.
- **Measurements:** value at a time/frequency (linear interpolation), maximum, minimum, peak-to-peak, RMS, average, 10-90% rise time, -3 dB bandwidth and gain at a frequency. AC values use magnitude. Average and RMS use axis-weighted integration over the whole result. Rise thresholds use the observed minimum and maximum and the first rising crossing. Bandwidth is relative to the sweep's peak: the upper cutoff for a low-pass response, or the span between crossings for a band-pass response. Extend the sweep to contain the crossings. Gain is output/input magnitude in V/V and requires an input vector. Arbitrary user-defined measurement expressions are not implemented.
- **Saved batches:** Add to batch saves any dialog analysis, including multi-run and distortion analyses, in browser/desktop local storage. Edit/reorder the JSON list in Saved batch. Entries run sequentially against the current circuit and their results, settings, measurement summaries and histograms appear together. A failed entry stops the batch; a cancelled or failed batch does not present partial runs as a completed result. Nested batches are rejected. These saved lists are local to the installation/browser, not embedded in circuit files.

These features have automated circuit and worker-queue tests. Hands-on dialog, cancellation and desktop checks remain part of production-plan Phase 2.

## 1. Remaining boundaries

Each of these depends on another company's product or material, or would work against keeping the app light.

**External data and compatibility**

- **NI's component database.** The local bridge reads supported installed Master/User/Corporate Jet databases and imports chosen model variants; `.ms14` catalogue imports also work. Generic pin-block symbols replace native graphics. Generated instance parameters and database archives remain unsupported. No NI collection is bundled.
- **NI's samples.** They can't be bundled, so someone on a Mac without NI's software won't have them. The app will ship its own example circuits.
- **Agilent and Tektronix instrument panels.** Original styled meter/scope variants are available. They are not exact hardware replicas and do not implement hardware communication or SCPI.
- **Native format investigation.** User-authorized local format investigation and the installed NI Automation API are used to verify compatibility. No NI binary or database is bundled with the app.

**Needs software or hardware the app can't include**

- **LabVIEW co-simulation and instruments.** An independent local numeric dataflow runtime and editable blocks run without NI software, with stateful feedback and mapped DC outputs. It does not read `.vi` binaries or implement the full LabVIEW language. Optional HTTP Web Service coupling and a native Windows VI Server adapter are also implemented. The VI adapter has protocol tests but awaits a real LabVIEW installation for validation. None of these modes negotiates analog solver timesteps with NI's synchronized co-simulation engine.
- **ELVIS and other lab hardware.**
- **Excel and Mathcad links.** CSV and SVG export cover this.
- **NI's result formats** (`.gra`, `.lvm`, `.tdm`). `.gra` has no public description. Results save as CSV, SVG and the app's own file.

**Too large or too risky for a light app**

- **Saving `.ms14`.** Imported native circuits preserve original records for parameter edits. New circuits and explicit flattened exports write native symbols and connections; seven starters opened in Multisim 14.2 and the RC filter's native connectivity was verified. Flattening imported circuits does not reproduce unknown scripts, hierarchy or proprietary behavior. Native simulation equivalence is unverified. See the design workflow guide.
- **PCB layout and transfer.** Two-layer routing with plated vias, adjustable through-hole pads, connectivity/clearance checks, KiCad export, and Gerber/NC-drill ZIP export are available. Gerber, drill and ZIP parsing were independently checked. Zones, autorouting, surface-mount pads, silkscreen export and transfer to Ultiboard are not implemented; fabrication suitability remains unverified.
- **VHDL and FPGA design.** Real GHDL analysis/simulation and an iCE40 HX1K/TQ144 bitstream build passed installed-tool and browser checks. They require the local build bridge and tools. Other families, device programming and analog/HDL co-simulation are not implemented.
- **Database Manager, Component Wizard and Symbol Editor.** A planned model block will build a part from pasted SPICE text instead. File > Title block edits the original Microsim title-block fields; it does not edit native NI title-block artwork or templates.
- **A C compiler for microcontrollers.** Real SDCC compilation and independent built-in 8051 circuit execution are implemented. Compiled or imported Intel HEX can be attached to a core and saved with the circuit. GPIO, timers, interrupts and instruction timing have tests, including uCsim comparisons and real compiled C. The 8051 serial port (modes 0–3) drives real TXD waveforms, and the **Serial terminal** instrument decodes them. Imported NI 8051/8052 parts now convert to this core, and **Design > Microcontroller program** assembles their source here. NI PIC parts, physical chip power behavior and external bus waveforms remain unsupported. See the design workflow guide for the exact boundary.
- **Reading `.mcuws` and `.mcuprj` project files.** They're undocumented and not needed, because a person picks the program file.
- **Tank and conveyor machine behaviour.** Original placeable models simulate transient state and sensor outputs, with animated fill/motion and physical-unit readouts. Imported NI scripts, falling objects and exact sample behavior are still unsupported; those imported parts retain their starting models and notices.
- **Rated parts that blow, and 3D parts.** No sample has them, and blowing needs the circuit to change during a run.
- **Other things left out:**
  - assembly variant editing
  - an editable electrical rules grid
  - description box forms and media
  - project packing
  - interface customising
  - Excel-style reports
  - circuit wizards, which the assistant covers when a key is set

**Only if someone asks**

These aren't impossible, but few or no samples use them.

- Smith chart, stability circles and matching networks
- RF characterizer table and trace width
- Buses as drawn objects (buses already work electrically)
- Motors, power controllers and other power parts you can place (those in opened files still run from their stored models)
- SCR, triac, IGBT and open-collector logic as library parts
- ADC, DAC and analog switch library parts
- Gear integration
- Align tools and IEC symbols
- Fault injection

## 2. What can only be approximate

- **Results can differ from Multisim.** The engine, models and logic levels are the app's own. The project's tests use hand calculations, datasheet values and values stored in sample files. They don't compare against a running copy of Multisim.
- **Library parts are fits, not vendor models.** Their numbers are fitted from public datasheet values, and many were first written from memory and still need confirming against the datasheet. They're marked approximate.
- **Microcontroller pins are ideal.** Programs and timing are designed to run cycle by cycle, but pins are perfect logic drivers. Too much current from a pin won't show up, and supply voltage has no effect. Crystals do nothing: the clock is a number. External bus cycles aren't modelled.
- **Two microcontroller pins differ from the datasheet on purpose.** P0 and RA4 act as weak highs rather than floating, because samples rely on that.
- **Some timings are nominal.** The watchdog uses 18 ms where the datasheet allows 7 to 33 ms, an EEPROM write takes 10 ms, and LCD delays use typical values.
- **Older Multisim files.** `.ms10` to `.ms13` may open but haven't been tested. Only `.ms14` has samples to test against.
- **Microcontroller samples need their program.** No `.ms14` stores one, only a path, so a person has to pick the file.
- **Stored vendor models are kept as they are.** Opened circuits can carry model text from the file, including when saved and when sent to the assistant. A planned option can swap them for library parts, but that can change results, so it will never happen automatically.
- **Some opened parts are approximations of the original.** They use the closest thing the app has, and an Issues entry says so.

## 3. What isn't built yet

These are planned, in this order. Until they land, the app can't do them.

1. **Wrong-answer fixes**
   - a DC solve that can read 2200 V on a 19 V circuit
   - imported current clamps reading 1000 times too high
   - runs that abort when a digital event lands beside a source's corner
2. **Probes.** 83 of them in 44 samples are dropped when a file opens.
3. **Opened circuits running as their file asks:** stored analyses, chosen outputs and simulation settings.
4. **Opened sheets looking like the file:** page, frame, label spots, fonts and colours.
5. **Multisim-style editing:**
   - right-click menus
   - dragging wires and starting a wire from a wire
   - Find, zoom tools and Pause
   - keys and on-sheet control for switches and potentiometers
6. **Parts library:** about 150 real parts with search, plus generic sources and meters you can place, and a model block with any pin count.
7. **Mac desktop:** opening files from Finder, a second window, copying between circuits and recent files.
8. **Graphs window:** pages, cursors, tables, expressions and saved results.
9. **Instruments:**
   - four-channel scope
   - scope cursors, AC coupling and A/B mode
   - logic analyzer trigger and voltage-following lanes
   - network analyzer. The distortion analyzer shows THD and harmonics 2 to 50 of its input from the last whole period, at a measured or given fundamental. The IV analyzer traces two-terminal I-V curves and BJT or MOSFET output families with DC sweeps at its pins; the device should be wired only to it. The logic converter reads a truth table of up to eight inputs, one operating point per row, and minimizes it to a sum of products; it does not build circuits from expressions. The frequency counter, spectrum analyzer and word generator are done: the counter and analyzer read the stored transient (the analyzer is a Hann-windowed FFT of the last stored span, so its resolution is 1/span), and the word generator drives eight PWL outputs of up to 1024 words, once or repeating, with 1% edges.
10. **Analyses:** arbitrary user-defined measurement expressions remain unimplemented. The standard analyses, sweeps, Monte Carlo, worst case, distortion, noise figure and saved batches are implemented; see the conventions and boundaries above.
11. **Reports and checks:** the Reports menu provides a bill of materials (CSV/HTML), electrical rules check, and SPICE/KiCad netlist export. Footprints appear only when explicitly supplied. Output conflicts are checked for the built-in logic gates, flip-flop, clock and serial transmitter; custom model pin directions and program-dependent MCU GPIO directions are not inferred. KiCad import still needs verification in KiCad.
12. **Sheets and documents:**
    - Spreadsheet View, comments, shapes and description box
    - hierarchical blocks, pages and subcircuits
13. **Microcontrollers:** NI PIC conversion and a PIC16 core, a PIC assembler, NI LCD conversion, keypad and debugger. A built-in 16x2 character LCD (HD44780 command set, 8-bit and 4-bit) is decoded from its pins during a run and drawn on the part; custom characters and reads (busy flag) are not modelled. The built-in 8051 core executes firmware, and imported NI 8051/8052 parts and their assembly source now run on it.
14. **Assistant coverage, original examples and final docs.**

Imported NI PIC microcontrollers and LCDs still open with notices and do nothing. NI 8051/8052 parts run on the built-in core once their program is loaded, and NI virtual terminals become the serial terminal, which shows what arrives and sends what you type.

**Printing and PDF export:** File > Title block stores optional title, drawn by, company, document number, revision and date with the circuit, including in the Microsim `.ms14` editor extension. File > Print (Ctrl/Cmd+P) and Export PDF preview one black-on-white sheet with a border, title block and sheet count. A4, A3, US Letter and US Tabloid support portrait/landscape, margins in millimetres, fit, and 50%, 100% or 200% scale. At 100%, 96 schematic units occupy one inch. Oversized fixed-scale drawings are clipped to the drawing area and the preview warns about this. Long title fields are compressed to fit their row. Printing sends SVG to the browser or desktop webview's OS print dialog, which can save a PDF where the OS provides that option; printer settings may override the requested size, margins or scale. Direct PDF export uses a 300 dpi JPEG image inside a PDF 1.4 file, so its text is not selectable and its drawing is not vector. Multiple sheets, tiling, custom page sizes and editable title-block layouts are not implemented. Real printers and the native print/save-as-PDF dialogs on Windows, macOS and Linux still need hands-on verification.

## 4. What Claude can't do

**Needs you or another person**

- **Passwords and keys.** Claude can't enter passwords or real API keys, or create accounts. You type `sudo` passwords yourself.
- **Apple Developer ID, signing and notarization.** This needs your Apple account. Until then Mac builds are ad-hoc signed, and macOS warns people who download them.
- **Legal review.** Claude can't give legal clearance. Counsel should look at `.ms14` support, how close the interface is to Multisim's, stored vendor model text, and the program files in microcontroller tests.
- **Clearing the name.** `Microsim` is close to `Multisim`, and MicroSim was the company behind PSpice, with a past trademark for circuit design software. Claude can find public records but can't confirm whether the name is free to use.
- **Choosing a license** and approving third-party notices.
- **Merging to `main`, publishing to GitHub Pages and renaming the GitHub repository.** Claude can do these, but waits for your go-ahead.

**Can't be checked without a person**

- **Real Safari.** Testing uses Playwright's WebKit, which isn't the same as Safari. That leaves the file picker's filter, "Allow downloads", and whether Cmd+O and Cmd+S reach the app.
- **Real hands on a Mac.** Trackpad gestures, a real second finger, and Fn and media keys were not tried by a person. Where they were tested, they were simulated events.
- **The desktop app's native parts.** Real menus, file dialogs, the close guard and the window itself. CI proves the app builds, launches and runs a circuit, but nobody has used it. Your Mac is in use, so Claude runs tests there out of sight and doesn't take over the screen.
- **The live assistant.** It has never run against the real Anthropic API, because that needs your key. Tests use a mock.
- **KiCad import.** Someone with KiCad has to confirm that the export opens there.
- **Real circuits.** Nothing has been compared with hardware on a bench.
- **Whether it feels right.** Whether it looks and works like Multisim in daily use is a person's judgement.

**Limits on the work itself**

- **Power cuts and usage limits.** Work stops when the PC loses power or a usage limit is reached, and it can't restart itself. Finished work stays on disk and goes to the `mac-testing-fixes` branch at each stage, but someone has to say "continue".
- **Private test link.** It runs from your PC, so it's down whenever the PC is off.
- **Proving it's bug-free.** Testing finds bugs but can't show none are left. So far every round of testing has found more.

## 5. Size

The planned features add about 17,800 lines of code and 5,700 lines of tests to a project of 22,800 lines. They load only when needed, and a build check will guard the first page load, but this doubles what has to be maintained. Microcontrollers are 28% of the new code and appear in 15 of the 133 samples. If it needs to stay smaller, those and the later analyses are the first places to cut.
