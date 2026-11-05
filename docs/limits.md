# What Microsim can't do

This is the honest list: what won't be built, what can only be approximate, what isn't built yet, and what Claude, which is building this app, can't do or check without a person. It was written on 2026-11-05, while features are still being added, so section 3 will shrink.

## 1. What won't be built

Each of these depends on another company's product or material, or would work against keeping the app light.

**Blocked by the rules of this project**

- **NI's component database.** It can't be copied, so the app won't have NI's parts lists or models. The planned parts library uses numbers fitted from public datasheets instead.
- **NI's samples.** They can't be bundled, so someone on a Mac without NI's software won't have them. The app will ship its own example circuits.
- **Agilent and Tektronix instrument panels.** They reproduce named companies' front panels. Generic instruments measure the same things.
- **Inspecting NI's programs.** NI's license bars reverse engineering, so NI's executables, DLLs and database files are never opened. Everything known about `.ms14` comes from circuit files and observed behaviour.

**Needs software or hardware the app can't include**

- **LabVIEW co-simulation and LabVIEW instruments.** They need LabVIEW, which can't run in a browser or ship with a Mac app.
- **ELVIS and other lab hardware.**
- **Excel and Mathcad links.** CSV and SVG export cover this.
- **NI's result formats** (`.gra`, `.lvm`, `.tdm`). `.gra` has no public description. Results save as CSV, SVG and the app's own file.

**Too large or too risky for a light app**

- **Saving back to `.ms14`.** The format is undocumented, a written file might not open in Multisim, and it adds legal exposure. The app opens these files and saves its own format. SPICE decks can be exported.
- **PCB layout, and transfer to Ultiboard.** Multisim hands layout to a separate product too. The planned KiCad netlist export is the replacement.
- **VHDL, PLD and FPGA design flows.** No sample uses them.
- **Database Manager, Component Wizard, Symbol Editor and Title Block Editor.** A planned model block will build a part from pasted SPICE text instead.
- **A C compiler for microcontrollers.** Programs can be written in assembly, or built elsewhere and loaded as `.hex`.
- **Reading `.mcuws` and `.mcuprj` project files.** They're undocumented and not needed, because a person picks the program file.
- **Tank and conveyor machine behaviour.** In those 2 samples it lives in scripts rather than in the circuit. They will keep showing a notice.
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

- IV analyzer and spectrum analyzer
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
   - network analyzer, frequency counter, word generator, logic converter and distortion analyzer
10. **Analyses:** distortion, worst case, fuller Monte Carlo, nested and list sweeps, sensitivity, noise figure, batched and user-defined.
11. **Reports and checks:** electrical rules check, bill of materials and KiCad netlist.
12. **Sheets and documents:**
    - Spreadsheet View, comments, shapes and description box
    - hierarchical blocks, pages and subcircuits
    - title block and printing
13. **Microcontrollers:** 8051 and PIC16 running in the simulator, with assemblers, LCDs, serial terminal, keypad and debugger.
14. **Assistant coverage, original examples and final docs.**

Today, microcontrollers, LCDs and serial ports open but do nothing, and a notice says so.

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
