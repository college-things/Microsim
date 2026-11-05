# Design workflows

The **Design** menu adds the workflows below. These are initial implementations with explicit compatibility boundaries, not a complete replacement for Circuit Design Suite.

## Running without NI software

The implementation target is independent functionality across the entire requested feature list. The table describes current dependencies, not full compatibility.

| Area | Independent implementation | Remaining compatibility gap |
| --- | --- | --- |
| `.ms14` saving | Original container/graph writer and native-record parameter editing | General native simulation equivalence, unknown records and scripts |
| PCB | Local two-layer routing, DRC, plated vias, KiCad/Gerber/drill output | Full footprints, zones, autorouting, Ultiboard behavior |
| LabVIEW-style control | Local numeric dataflow blocks and stateful execution | Native `.vi` language/file execution and full development environment |
| VHDL / FPGA | GHDL and Yosys/nextpnr/iCE40 toolchains | More device families, hardware programming, analog/HDL coupling |
| Agilent / Tektronix panels | Original simulated meter and four-channel scope controls | Exact hardware behavior, complete panels and SCPI |
| Component database | Built-in original library and portable user catalogue | NI's collection is not bundled; optional import needs an existing database |
| C compiler | SDCC compilation, Intel HEX import and independent 8051 circuit execution | Imported NI MCU conversion, PICs, UART, debugger and electrical chip behavior |
| Tank / conveyor | Original process models with animated state and sensors | Original NI scripts, falling objects and exact sample behavior |

The independent implementations do not use the NI license manager. Importing an installed NI database and executing a native VI are optional external-product adapters. The latter still requires LabVIEW. Native Multisim is used for interoperability validation, not to generate new files in the running app. Separately installed open-source build tools retain their own licenses.

## Saving `.ms14`

Choose **File > Save as .ms14**. Subsequent Save actions use that format until another format is chosen. Browser saves download a file; desktop saves use a native file dialog. **Save as .microsim** is also available.

There are two save paths:

- **Imported native circuits:** the app retains the original XML records and patches supported component parameters. It updates the parameter list, numeric backing values and the displayed primary value. Unsupported structural, wiring, model, rotation or interactive-script edits stop the export with an error directing you to `.microsim`; they are never silently discarded. Changes to repeated hierarchical instances are also rejected because they share one native definition. Original metadata, sheets, models and records that this editor does not understand remain in the file.
- **Newly created circuits:** the schema-67 writer stores a complete Microsim document plus a flattened graph of components, parameters, native model records, pins, nodes, wires and symbols. All seven starter circuits opened through the installed Multisim 14.2 Automation API. Its native netlist report verified the RC filter's component connections and node `0`. Straight, bent, branched and rotated-component connections were exercised. A generated RC circuit also rendered and entered a transient simulation in the native GUI. This required explicit drawing transforms, simulation-enable and no-fault records, numeric native port names, and correctly encoded empty strings. Native numerical equivalence, specialized native instruments and arbitrary vendor models are not verified.

For structural edits to an imported circuit, choose **File > Export flattened .ms14**. This rebuilds native records from the current editor circuit and leaves the regular save target and dirty state unchanged. Original hierarchy, interactive scripts and unsupported native records survive in the editor extension, but are not recreated as native behavior. Use the normal save path to preserve original native records.

Both use the real `MSMCompressedElectronicsWorkbenchXML` container and independent DCL streams. Chunked XML comments inside the project retain the complete editor document, analyses, issues and engineering workspace for lossless reopening here. Native Multisim saves may remove that editor extension. Raw native records are retained in saved documents and recovery copies, which can make them substantially larger.

Native exported geometry is translated into the positive work area so circuits drawn around the editor's origin are visible when opened in Multisim. The extension retains the original editor coordinates. Native parameter records use enable/value pairs; the sine source frequency is stored in slot 5 for native timestep selection.

Direct validation in installed **Multisim 14.2** opened an exported native power-supply circuit after changing a resistor from 1 kΩ to **2200 Ω**, and showed the updated value. An empty native project also reopened. This verifies those cases, not arbitrary files or full simulation equivalence. Keep original files while evaluating the exporter.

## PCB layout

**Design > PCB layout** builds starting footprints from the schematic. Move a footprint by editing its X, Y and rotation. Edit the pad offsets in pin order with `x,y; x,y; …`. Dimensions are in millimetres. Click a pad, optionally click empty space for corners, then click another pad on the same net to finish a copper track. Right-click cancels an unfinished route. Choose front or back copper and set the width before routing.

**Apply layout** stores the board inside the circuit and participates in Undo. **Refresh from schematic** updates pad nets and the component list while keeping existing placement and tracks. Existing tracks must be reviewed after schematic changes. **Undo last track** removes the newest track in the dialog; Cancel discards dialog edits.

Checks cover board-edge clearance, pad/via and track clearance, crossing shorts on a copper layer, and disconnected copper islands. Dashed lines are connectivity guides; they stay visible after routing. Use **Place via / switch layer** while routing to finish the current segment at the last corner, add a 0.8 mm plated via with a 0.4 mm drill, and continue on the opposite layer. Click an existing via to route from it. **Undo route** removes the last completed routing operation. Through-hole pads and vias connect both layers; crossings between layers do not.

Pad diameter and drill diameter can be changed for each footprint. **Export KiCad board** writes pads, vias, nets, tracks and outline to `.kicad_pcb`. **Export Gerber / drill ZIP** writes front/back copper and soldermask, the board profile, plated Excellon drill data and a README. Fabrication export requires the implemented checks to pass. The output set and ZIP checksums were independently parsed using Gerbonara and Python's ZIP reader. There are no zones, autorouting, surface-mount pad types, silkscreen export or Ultiboard transfer. Footprints start as generic 1.6 mm through-hole pads with 0.8 mm drills and 2.54 mm pitch: they must be matched to the actual components. KiCad import and manufacturing suitability have not been independently verified. Check the complete output in an independent viewer before ordering a board.

## Installed C and VHDL / FPGA tools

Run this command in the project directory:

```sh
npm run design:bridge
```

Paste the displayed token into **Design > C compiler (8051)** or **Design > VHDL / FPGA design**. The bridge listens only on `127.0.0.1:47832`. Its token stays in the app's memory. It executes fixed tool arguments in a temporary build directory without a shell, returns artifacts and diagnostics, and removes temporary files after the build. The HTTP service allows cross-origin requests, but requires the token for builds. Do not share the token. Closing the dialog cancels the client request; a compiler already started on the server can finish or hit its timeout.

Install the required tools separately and put them on PATH:

| Workflow | Tools | Output |
| --- | --- | --- |
| C compiler | SDCC, MCS-51 target | Intel HEX `firmware.hex` |
| Check VHDL | GHDL with VHDL 2008 support | Analysis/elaboration diagnostics |
| Simulate VHDL | GHDL | `wave.vcd`, limited to 1 µs and 10,000 delta cycles |
| Build FPGA | GHDL synthesis, Yosys, nextpnr-ice40, icepack | Netlist JSON, ASC and binary bitstream |

On the current Windows machine, SDCC 4.5.0 and GHDL 6.0.0 are installed. A Python environment under `%LOCALAPPDATA%\MicrosimTools\fpga` contains YoWASP Yosys 0.70 and nextpnr-ice40 0.11.1 with icepack. The bridge detects SDCC's default installation, WinGet GHDL installations and these YoWASP tools automatically. It adds a selected executable's directory to its subprocess PATH, including SDCC's preprocessor dependencies. **Check installed tools** reports detected paths and executable diagnostics.

To reproduce the YoWASP environment with Python installed, run the following in PowerShell:

```powershell
$fpgaEnvironment = Join-Path $env:LOCALAPPDATA 'MicrosimTools\fpga'
python -m venv $fpgaEnvironment
& (Join-Path $fpgaEnvironment 'Scripts\python.exe') -m pip install -r scripts/requirements-fpga.txt
```

Real integration checks compiled an 8051 C program including `<8051.h>` into checksummed Intel HEX, simulated a clocking VHDL testbench to 1 µs, rejected invalid VHDL, and generated a packed HX1K bitstream for an inverter with explicit package pins. The same operations passed through the browser UI. Hardware programming and electrical behavior on a physical board remain untested. Set `MICROSIM_TEST_TOOLS=1` when running `npm run test:bridge` to repeat these installed-tool tests. YoWASP is documented by its [maintainers](https://github.com/YoWASP/yowasp.github.io/blob/main/index.md).

FPGA builds target **iCE40 HX1K, package TQ144**. Supply PCF pin constraints for the actual board. The example's commented pins are placeholders, not a validated board pinout. Other FPGA families and programming hardware are not supported. A VHDL testbench must supply its own stimulus to produce useful VCD output. This workflow does not co-simulate VHDL with the analog circuit.

Source, entity name and constraints save with the circuit. Successful C output is retained with its source and can be downloaded. For C, choose **Attach firmware** after compilation, or **Import Intel HEX** for an existing `.hex`/`.ihx` program. Choose an existing built-in 8051 core or create one. The attached program is copied into the component and saved with the circuit, so running it needs neither SDCC nor NI software. HEX import verifies checksums, record sizes, overlaps, end-of-file and the 64 KiB address bound. Importing an unrelated HEX clears the source editor to avoid associating it with the wrong C source. Source changes invalidate the stored compiled artifact until rebuilt. No build uploads firmware or programs an FPGA.

The **8051 firmware core** in the Digital palette implements all defined classic MCS-51 opcodes (the reserved `A5` opcode reports an error), a classic 12-oscillator-clock machine cycle, 256 bytes of internal RAM, separate SFRs, register banks, bit addressing, stack/calls, 64 KiB program memory and abstract 64 KiB external data memory. It supports timer/counter 0 and 1 modes, interrupt priorities and active-high reset. P0 is open drain; P1–P3 use weak pull-ups. Port latch reads for read-modify-write operations are separate from pin reads. Outputs and inputs use the existing digital/analog bridges. Firmware runs at instruction boundaries in the accepted-time event queue; it is not a transistor-level or internal clock-phase model. Reset preserves RAM after initial power-on. Live analog value changes retain execution state; changing the firmware or oscillator requires a restarted run.

The component has explicit P0–P3 and RST terminals and assumes a fixed 5 V logic environment. It does not reproduce physical package pins, supply/brownout/oscillator behavior, external bus waveforms, UART, timer 2 or device-specific peripherals. UART transmission fails explicitly. Imported NI `d_cpu`/`d_cpupic` parts are still unsupported and keep their notices; attaching firmware targets the independent built-in core only. Its custom `d_mcu8051` model runs in this app, not native Multisim. `.ms14` retains it through the editor extension without claiming native NI MCU equivalence.

Validation includes 2,040 randomized single-instruction comparisons with the separately installed uCsim C52 emulator (PC, machine cycles, A/B, PSW, SP, DPTR and register banks), exhaustive ADDC/SUBB byte-pair flags, all decimal BCD additions, timer/interrupt cases, GPIO input/reset circuits, and a real SDCC build saved/reopened as `.ms14` then run against a resistor (146 GPIO edges over 5 ms). Browser compilation, firmware attachment and live scope output also passed. These checks do not establish complete peripheral or native Multisim equivalence. Repeat the installed-tool checks with `node scripts/check-mcs51.mjs` and `node scripts/check-mcu-firmware.mjs`. The interpreter follows the published [Atmel instruction set](https://www.keil.com/dd/docs/datashts/atmel/at_c51ism.pdf) and [8051 hardware manual](https://ww1.microchip.com/downloads/aemDocuments/documents/OTH/ProductDocuments/UserGuides/doc4316.pdf).

To override tool locations, set `MICROSIM_SDCC`, `MICROSIM_GHDL`, `MICROSIM_YOSYS`, `MICROSIM_NEXTPNR` or `MICROSIM_ICEPACK` before starting the bridge. `MICROSIM_BRIDGE_PORT` and `MICROSIM_BRIDGE_TOKEN` configure the endpoint and token. A missing tool is reported as a build failure, never as a successful compilation.

Reference: [SDCC](https://sdcc.sourceforge.net/), [GHDL synthesis](https://ghdl.github.io/ghdl/using/Synthesis.html), [nextpnr's documented iCE40 flow](https://github.com/YosysHQ/nextpnr/blob/main/README.md).

## LabVIEW

**Local dataflow (no NI installation)** is the default for new configurations. It is an independent numeric block runtime with an editable block/connection table and a connection diagram. It needs neither the bridge nor LabVIEW. Supported blocks are numeric inputs, constants, simulation time, addition, subtraction, multiplication, division, sine, absolute value, minimum, maximum, greater-than, numeric selection, unit delay, and integration. Outputs can drive mapped built-in DC sources using the same signal mappings as the external adapters. Include a simulator vector in `inputs`, such as `"v(out)": 0`, to sample its latest value; otherwise an input block uses its finite fallback value. Connect validates and saves the program, then starts a fresh runtime. Editing the program disconnects it; reconnect to save and run the changes.

Blocks execute in dependency order regardless of their table order. Combinational cycles are rejected; feedback must cross a delay or integrator. Initial state is explicit. State advances only when the simulator's reported time advances, not on each wall-clock polling interval. Integrators use the previous sample multiplied by elapsed simulation time (explicit Euler). Repeated timestamps keep the same state, restarting simulation time resets it, and failed arithmetic does not commit state. DC-only runs therefore do not advance state. This is sampled coupling and is not an integration inside each analog solver timestep. Programs persist in `.microsim` and in the editor extension of `.ms14`; native Multisim does not execute them.

The local runtime does **not** read native `.vi` binaries or implement the full LabVIEW language, front panel environment, arrays/clusters, event structures, DAQ drivers, or synchronized co-simulation. Native `.vi` execution still uses the optional adapter below. Local dataflow is an independently implemented feature, not a claim of 1:1 LabVIEW compatibility.

**Design > LabVIEW integration** supports HTTP Web Services and a native Windows VI Server adapter. For HTTP mode, a user-created HTTP method VI must implement this protocol and allow cross-origin requests from the app. It receives a JSON POST:

```json
{"time": 0.05, "signals": {"v(out)": 2.4, "setpoint": 3}}
```

It returns:

```json
{"signals": {"drive": 1.25}}
```

Configure mappings in the dialog:

```json
{"inputs":{"v(out)":0,"setpoint":3},"outputs":{"drive":"V1"}}
```

Input names matching simulator vectors send the latest available sample; other inputs send their configured number. `time` is the latest transient timestamp, or zero without a transient. Outputs map returned signals to the exact references of built-in DC voltage sources. All mapped returned signals must exist and be finite numbers. Changes use the simulator's existing live source-update mechanism and are undoable. Requests run sequentially, with 100 ms between completed exchanges and a 5 s timeout. Closing the dialog, opening a new circuit or a request failure disconnects it.

For **Native VI (Windows)** mode, run the design bridge, enter its token and an absolute `.vi` path, and select the installed LabVIEW bitness. Input mapping keys are VI numeric control labels, output mapping keys are numeric indicator labels, and an optional time-control label receives simulation time. Each VI invocation must return within 3 seconds. The adapter primes indicator access before running, retains the VI reference between frames, and aborts only a run it started when the step times out. It releases the session on disconnect or after 30 seconds without an exchange. It does not quit the LabVIEW application. The token is never saved in the circuit.

The selected integration target is **LabVIEW 2019 SP1 Full/Professional, 32-bit**. NI's [Circuit Design Suite 14.2 release requirements](https://www.ni.com/pdf/manuals/375231d.html) list LabVIEW 2017–2019 32-bit for its API Toolkit and co-simulation integration. However, NI's [newer co-simulation article](https://knowledge.ni.com/KnowledgeArticleDetails?id=kA00Z0000019P2xSAE) says the legacy plug-in was last compatible with LabVIEW 2016 32-bit. These sources conflict; the selected target is for VI/API integration, and native synchronized co-simulation must be validated separately. NI's [older-version download flow](https://www.ni.com/en/support/downloads/software-products/download.labview.html) requires account entitlement. LabVIEW is not installed on this machine, so the native adapter has protocol/process tests but no real VI execution verification.

Both modes are sampled coupling to the current simulator; neither negotiates analog solver timesteps with NI's synchronized co-simulation plug-in. No LabVIEW VI or development environment is bundled. Browser HTTPS/mixed-content or local-network rules can restrict local HTTP endpoints; use a compatible origin/endpoint when needed. The bridge does not proxy HTTP Web Service traffic.

NI documents [JSON responses from LabVIEW Web Services](https://knowledge.ni.com/KnowledgeArticleDetails?id=kA00Z0000015ChLSAU&l=en-US).

## Component catalogue and NI parts

**Design > Component database** imports a `.ms14` circuit's embedded components and model definitions or a Microsim catalogue JSON. Search and remove parts in the dialog, then place them from the searchable Analog palette. Export a catalogue to move it to another computer. Browser local storage keeps it between sessions where storage is available. Placed components carry their own SPICE text, graphics and shared definitions so reopening their circuit does not depend on the catalogue being installed.

The **Browse an installed NI database** section also reads local NI Jet-format Master, User and Corporate databases (`.prd`, `.usr`, `.prj`, or compatible `.mdb`) through `npm run design:bridge`. Enter the bridge token and absolute database path, open it, search, choose a model variant, and import the selected component. Access is read-only. Templates, all selected model sections, shared supply pins and model dependencies are retained. Graphics use an original generic pin block. Parts requiring generated instance parameters are rejected with an explicit explanation; place those in a native circuit and import that circuit instead. Database archives such as `.prz` are not supported.

The installed 14.2 Master database was read successfully: 57,162 entries. Direct imports of 2N3904, 1N4148 and the eight-pin, dual-section LM358N converted and ran in the local simulator with no warnings in grounded smoke circuits. That verifies conversion and parser acceptance, not every device's electrical accuracy. Proprietary code models and interactive scripts may require adaptation. No NI database or vendor model collection is bundled.

`npm run test:bridge` includes fixture-based database tests. Set `MICROSIM_TEST_NI_DB` to the absolute installed database path to enable the local integration check. `node scripts/check-ni-conversion.mjs <database-path>` exercises those three parts through catalogue placement, netlist generation and the simulator without copying models into the repository. Database parsing uses [mdb-reader](https://github.com/andipaetzold/mdb-reader).

NI confirms that [saved designs carry component information](https://www.ni.com/docs/sw-UG/bundle/multisim/page/topics/component-database-structure.html).

## Instrument panels

The palette includes **Agilent style multimeter** and **Tektronix style oscilloscope**. The meter provides DC/AC voltage and current, and resistance modes. The Tektronix variant has four independent inputs, A–D, and a common reference. Each scope channel supports DC, a simulated 10 Hz RC AC input coupling, or GND coupling, and its own vertical scale. Trigger source and rising/falling edge are selectable; trigger crossings are interpolated in time. Channel settings save with the circuit. These are original styled panels, not exact replicas of particular hardware models; they do not implement SCPI or connect to physical instruments. Existing generic instruments remain available.

## Tank and conveyor parts

The Analog palette includes original **Holding tank** and **Conveyor belt** models. Both run inside the transient circuit solver and expose output pins for control circuits; source values can change during a live run.

| Part | Inputs | Outputs | Parameters |
| --- | --- | --- | --- |
| Tank | `FILL`, `DRAIN`: nonnegative flow command voltages | `LEVEL`: litres represented as volts; `FULL`: 5 V at 99% capacity | capacity in litres, flow in L/s per V |
| Conveyor | `SPEED`: nonnegative voltage; `ENABLE`: above 2.5 V enables motion | `POSITION`: metres represented as volts, wraps at belt length; `SENSOR`: 5 V within 0.1 m of sensor position | length in metres, gain in m/s per V, sensor position in metres |

Both use `GND` as signal reference. Outputs have 1 Ω series resistance. The tank starts empty and tapers flow in a 0.001 L boundary layer near empty/full for stable integration. The belt starts at position zero and represents one periodically circulating position. The canvas animates the tank fill and a moving conveyor object from the latest simulated state, with readings in litres and metres. These are simplified process models: they do not execute NI's machine animation scripts, model falling boxes or reproduce imported NI machine behavior. Imported NI tanks and conveyors retain their existing static starting models and import notices.

## Verification

Automated tests cover DCL encoding, Unicode and complete `.ms14` round trips, native drawing/enable/port/parameter records, a model-based operating point without the extension, via connectivity and clearance, fabrication files, saved engineering data, catalogue placement, NI model sections/dependencies, native VI process framing, scope coupling and triggers, machine transient state/animation readings, and bridge argument/artifact handling. Installed compiler, HDL simulation and FPGA bitstream tests have passed. Physical FPGA hardware, real LabVIEW VI execution and KiCad import remain unverified. Native Multisim validation is limited to the cases documented above.

On Windows with Multisim installed, `scripts/native-ms14-check.ps1` runs under 32-bit Windows PowerShell and uses NI's Automation API (`OpenFile`, `EnumComponents`, `ReportNetlist`). Run each experimental file in an isolated process: malformed native records can crash the COM client. `scripts/check-ms14-lab.mjs` automates isolated checks and cleans up only hidden automation instances it started. `scripts/ms14-lab.mjs` generates format experiments from a user-created blank native reference. Do not point it at a bundled vendor asset for redistribution.
