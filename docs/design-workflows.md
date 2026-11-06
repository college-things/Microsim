# Design workflows

The **Design** menu adds the workflows below. These are initial implementations with explicit compatibility boundaries, not a complete replacement for Circuit Design Suite.

## Running without NI software

The implementation target is independent functionality across the entire requested feature list. The table describes current dependencies, not full compatibility.

| Area | Independent implementation | Remaining compatibility gap |
| --- | --- | --- |
| `.ms14` saving | Original container/graph writer and native-record parameter editing | General native simulation equivalence, unknown records and scripts |
| PCB | Original footprint library, SMD/through-hole pads, two-layer routing, pours, silkscreen, DRC, worker autorouter, KiCad/Gerber/drill output | Manufacturing qualification, thermal reliefs, island removal, Ultiboard behavior |
| LabVIEW-style control | Local numeric dataflow blocks and stateful execution | Native `.vi` language/file execution and full development environment |
| VHDL / FPGA | GHDL and Yosys/nextpnr/iCE40 toolchains | More device families, hardware programming, analog/HDL coupling |
| Agilent / Tektronix panels | Original simulated meter and four-channel scope controls | Exact hardware behavior, complete panels and SCPI |
| Component database | Built-in original library and portable user catalogue | NI's collection is not bundled; optional import needs an existing database |
| C compiler | SDCC compilation, Intel HEX import and independent 8051 circuit execution | PIC C compilation and electrical chip behavior |
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

**Design > PCB layout** builds a board from the schematic. Dimensions are millimetres. New parts select an original package pattern; older saved boards retain their generic pads and dimensions. Move parts with X, Y and rotation, or edit pad offsets in pin order. The per-part footprint selector replaces geometry while retaining placement and schematic net assignments. It rejects packages missing mapped pin numbers. Recheck routing after changing packages or refreshing the schematic.

The library includes AXIAL-0.3/0.4/0.5 (inch lead spacing), RADIAL-2.5/5.0 (mm), LED-3mm/5mm, inline TO-92, TO-220, DIP-8/14/16/20/28/40, narrow SOIC-8/14/16, SOT-23, SOT-223, EIA 0603/0805/1206 chips, SMA/SMB diodes, 1x1 through 1x40 headers, a 5.08 mm two-pin screw terminal and a 6x6 mm tactile switch with 6.5 by 4.5 mm lead spacing. DIP pitch is 2.54 mm, row spacing 7.62 mm (8-20 pins) or 15.24 mm (28/40); narrow SOIC pitch is 1.27 mm with pad centres 5.4 mm apart. The pad-one marker and silkscreen identify orientation. Match these particular variants to the part you buy; package names alone do not specify every dimension.

Geometry is independently written from nominal JEDEC MS-001/MS-012/TO and EIA package dimensions, with original land allowances. Pinout references include [onsemi 2N3904](https://www.onsemi.com/pdf/datasheet/2n3904-d.pdf), [TI NE555](https://www.ti.com/lit/ds/symlink/ne555.pdf), [LM358](https://www.ti.com/lit/ds/symlink/lm358.pdf), [LM340/7805](https://www.ti.com/lit/ds/symlink/lm340.pdf), [SN74HC00](https://www.ti.com/lit/ds/symlink/sn74hc00.pdf), [SN74HC161](https://www.ti.com/lit/ds/symlink/sn74hc161.pdf), [SN74HC595](https://www.ti.com/lit/ds/symlink/sn74hc595.pdf) and [Microchip AT89S51](https://ww1.microchip.com/downloads/en/DeviceDoc/doc2487.pdf). No vendor footprint library files are used.

All pages and shared block instances are flattened into qualified physical references before board generation; hierarchy symbols and ports do not become footprints. Named ICs map schematic pin names to physical package numbers. LM358/TL072 and HC gates/flip-flops use the first section of a separate whole package for each symbol. Unused package pads remain individually unconnected. Digital supplies absent from the ideal simulator symbol appear as VCC/GND pads and unassigned supplies block fabrication export: **assign their real supply nets in the pad net fields**. Also wire/bias unused inputs and add MCU clock/reset/EA circuitry as required by the datasheet. No supply net is guessed. The 2N2222A default follows the P2N2222A plastic C-B-E variant; other parts sold under that name can differ. Choosing another footprint retains pad numbers; verify that the alternative package uses the same pinout and tab connections.

Click a pad, optionally click empty space for corners, then click another pad of the same net to finish a track. Right-click cancels. Select front/back copper and track width before routing. **Place via / switch layer** adds a 0.8 mm plated via with 0.4 mm drill and continues on the other layer. Through-hole pads and vias join layers; SMD pads connect only to front copper.

**Autoroute** uses a two-layer A* maze on a grid of at most 0.125 mm, 0.25 mm tracks, shortest-net-first minimum spanning trees, and at most two rip-up retries of generated routes. Existing copper stays fixed. A local benchmark routed the 14 connections of the 555 blinker in 0.41 s and 40 connections on a placed 30-resistor board in 3.01 s; timing depends on placement and hardware. It runs in a worker, reports progress and explicitly lists connections it could not route. **Cancel autoroute** terminates the worker. The default time budget is five seconds and the grid is limited to 1.5 million cells per layer; dense or large boards may need manual work. Keep-outs can be added as rectangles on the selected layer. **Remove all tracks** removes tracks and vias. **Undo route** restores the prior routing operation, including autoroute/removal. **Apply layout** saves the board through the document Undo path; Cancel discards dialog edits.

Set **Pour net** and **Pour layer** for a rectangular fill inset by the board clearance; a blank net disables it. The core also accepts polygon outlines. Other-net copper and keep-outs are cleared using Gerber dark/clear polarity, and same-net pads connect directly without thermal relief. Only one net per layer is supported. Floating pour islands remain in fabrication output. DRC warns about them using a conservative sampled topology check (normally 0.1-0.25 mm, coarser on large boards); very narrow necks can produce conservative warnings and sub-grid islands may be missed. The preview shades the pour outline; it does not render every clearance cutout. KiCad export writes a zone outline/net/clearance and leaves refill to KiCad.

DRC checks shaped pad-to-pad, track/pad/via and board-edge clearance, same-layer crossing shorts, disconnected nets, keep-outs, silkscreen over pads, drill diameters below 0.3 mm, annular rings below 0.15 mm, and track widths below 0.15 mm. Front silkscreen uses an original 1 mm stroke font and trims outlines/text away from pad mask openings. Dashed lines remain connectivity guides after routing. Fabrication export blocks DRC errors; pour warnings remain visible and do not block export.

**Export KiCad board** writes named footprints, shaped SMD/through-hole pads, silkscreen strokes, vias, nets, tracks and zones. **Export Gerber / drill ZIP** includes F.Cu/B.Cu, F.Mask/B.Mask, F.Paste (SMD only), F.SilkS, board profile, plated Excellon drills and a README. SMD pads have no drill hits. Rectangles and obrounds use standard apertures; rotated and rounded rectangles use original aperture macros. Mask openings expand by 0.05 mm per side. Verify the complete set in an independent viewer and match the actual part dimensions/pinout before ordering. Automated tests cover geometry, pin mappings, layer/polarity/aperture structure, font, pours, legacy reloading, a crossing that requires vias, and a fully routed 555 blinker. `node scripts/check-fabrication.mjs <output-directory>` generates a mixed through-hole/SMD/pour fixture for external inspection. The mixed through-hole/rotated SMD/pour fixture was independently parsed with Gerbonara: all seven Gerber layers and four plated drill hits loaded successfully. A browser check routed all 14 connections of the 555 blinker with clean DRC and verified export, routing Undo, cancellation and Apply/reopen. KiCad import/refill and native platform dialog checks remain. No physical board has been manufactured or tested.

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

The component has explicit P0–P3 and RST terminals and assumes a fixed 5 V logic environment. It does not reproduce physical package pins, supply/brownout/oscillator behavior, external bus waveforms or device-specific peripherals. The 8052 timer 2 is included: auto-reload and capture from T2EX (P1.1), counting on T2 (P1.0), and the serial baud generator (RCLK/TCLK, counting at fosc/2), with its interrupt at 2BH. Its custom `d_mcu8051` model runs in this app, not native Multisim. `.ms14` retains it through the editor extension without claiming native NI MCU equivalence.

**Serial port.** SBUF, SCON and SMOD implement all four classic modes. Modes 1 and 3 take their 16× baud clock from timer 1 overflows (halved unless SMOD), mode 2 from fosc/64 or fosc/32, and mode 0 shifts once per machine cycle. TXD (P3.1) carries real start, data, ninth and stop bits; a byte written while the previous frame is still shifting starts at the next bit boundary, so stop bits are never cut short. TI is set at the start of the stop bit. Reception samples RXD (P3.0) mid-bit, honours REN, SM2 and RB8, and only loads SBUF when RI is clear. With timer 0 in split mode 3, timer 1 keeps running as a baud generator without setting TF1. Pin changes appear at instruction boundaries, so edges can be late by up to four machine cycles; at common baud rates this is a few percent of a bit. Mode 0 completes its timing and flags, but its shift clock on TXD is not drawn as a waveform.

The **Serial terminal** instrument (Instruments palette) decodes 8-bit frames on its RX pin, referred to ground, with a selectable baud rate, parity and logic threshold. During a live run it reads every sample chunk from the simulator rather than the redraw window, so slow redraws do not lose characters. If samples are ever missed, it says so and resynchronizes. **Examples > 8051 serial hello** runs a hand-assembled program that prints a line at 9600 baud from an 11.0592 MHz core. In the browser it printed 540 lines over 9.5 simulated seconds without a frame error.

**Typing into the circuit.** While a circuit runs, text typed into the terminal's box goes out on its **TX** pin as 8-bit frames at the terminal's baud rate and parity, with one stop bit. TX idles high and drives 0/5 V logic. Each key is sent as it is typed; Enter sends CR, LF, CR LF or nothing, as chosen beside the box. Backspace, Tab and Escape send their control codes, and pasted text goes out in one burst. Characters beyond one byte are sent as `?`. Bytes queue and go out back to back from the moment they are typed, and the queue survives live value changes. Typing works only during a run, and only when TX is wired into the circuit. On the receiving side, CR, LF and CR LF each start one new line. RTS and CTS handshaking is not modelled. **Examples > 8051 serial echo** has an 8051, assembled from source in the example, that sends back each character with letters in upper case. In the browser, typed lines came back in upper case on separate lines. The engine tests also feed typed bytes into an 8051 echo program and decode its reply.

**Imported NI 8051/8052 parts and the assembler.** When a Multisim circuit contains an 8051-family `d_cpu` part (`cpu_part_id` `mcs51_…`), the import rewrites it to run on this core. It keeps the NI symbol and pin names (`P0B0AD0` … `P3B7^RD^`, `RST`) and the clock from the part's model, and starts with no program. NI's circuit files do not contain the program: NI assembles it from the MCU workspace (`.mcuws`) beside the circuit each time it simulates. The import records that workspace path and its source file names on the part, and the Issues list says which file to load. NI PIC16F84/F84A and F877/F877A parts also convert, using the PIC core described below. An NI virtual terminal (`d_serialport`) becomes the **Serial terminal** at its baud rate, receiving on its RXD pin and sending typed text on its TXD pin.

**Design > Microcontroller program** loads a program into any built-in or converted 8051. It assembles classic Intel-syntax source on the spot, with no other software: all MCS-51 instructions, labels, `EQU`/`SET`/`DATA`/`IDATA`/`XDATA`/`BIT`/`CODE`, `ORG`, `DB` (numbers and strings), `DW`, `DS` and `END`. It also handles `HIGH`/`LOW`, `$`, `+ - * / MOD SHL SHR AND OR XOR NOT`, bit selection such as `P1.3`, `ACC.7` and `20H.0`, and `H`/`B`/`O`/`D`-suffixed numbers. 8052 SFR and bit names are predefined. Generic `JMP` and `CALL` become `LJMP` and `LCALL`. Every jump and call form takes two machine cycles, so timing matches; only code size differs from an assembler that picks short forms. Errors name the line and the problem. **Load Intel HEX** takes a compiled program instead. The program and its source save with the circuit. In a native `.ms14` save they go into the editor extension, and the original NI records stay unchanged.

With their workspace sources, all nine NI 805x sample circuits convert, assemble and run. In eight of them the chip drives pins in a transient run. The ninth, SerialTerminal, waits for input: text typed into its converted virtual terminal comes back as an echo at about 1200 baud. Across the samples, all 1,144 assembled instructions matched the mnemonic and length from SDCC's separately installed uCsim disassembler. That check runs with `MICROSIM_TEST_TOOLS=1` in `tests/importer/mcu-samples.test.ts`. The tests read NI's files from the local installation and skip when it is absent; none of them are stored in the project.

Validation includes 2,040 randomized single-instruction comparisons with the separately installed uCsim C52 emulator (PC, machine cycles, A/B, PSW, SP, DPTR and register banks), exhaustive ADDC/SUBB byte-pair flags, all decimal BCD additions, timer/interrupt cases, GPIO input/reset circuits, and a real SDCC build saved/reopened as `.ms14` then run against a resistor (146 GPIO edges over 5 ms). Browser compilation, firmware attachment and live scope output also passed. These checks do not establish complete peripheral or native Multisim equivalence. Repeat the installed-tool checks with `node scripts/check-mcs51.mjs` and `node scripts/check-mcu-firmware.mjs`. The interpreter follows the published [Atmel instruction set](https://www.keil.com/dd/docs/datashts/atmel/at_c51ism.pdf) and [8051 hardware manual](https://ww1.microchip.com/downloads/aemDocuments/documents/OTH/ProductDocuments/UserGuides/doc4316.pdf).

**PIC16 firmware.** The Digital palette includes original PIC16F84A and PIC16F877A pin-block symbols. **Design > Microcontroller program** selects the assembler for the selected part. PIC listings and breakpoints use word addresses. Intel HEX uses byte addresses: two little-endian bytes make each 14-bit instruction. The configuration word at byte address 400EH is recorded separately; it is not executed. Source `__CONFIG` is likewise recorded with the part. Programs, source and configuration save with the circuit. Hold **MCLR high** to run, or drive it low to reset.

The original core implements all 35 mid-range instructions, W, STATUS flags (including no-borrow carry and digit carry), banked RAM, FSR/INDF, PCL/PCLATH and an eight-entry circular return stack. It uses four oscillator clocks per instruction cycle, with a second cycle for control transfers, PCL writes and taken skips. F84A has A/B ports; F877A has A-E. TRIS bits release input pins; port reads sample pin levels, including read-modify-write instructions. RA4 is open drain and needs an external pull-up for a high level. TMR0 includes the OPTION_REG prescaler, internal/external clock, write delay and overflow flag. INTCON handles TMR0, RB0 edge and RB4-RB7 change interrupts, vector 004H, RETFIE, and interrupt wake from SLEEP. Pins update at instruction boundaries, rather than internal clock phases.

The MPASM-style assembler accepts labels, `EQU`, `CONSTANT`, `CBLOCK`/`ENDC`, `ORG`, `END`, `__CONFIG`, `BANKSEL`, `PAGESEL`, `DT` and `DW`. Standard p16f84a/p16f877a includes resolve to original register and bit definitions written from the data sheets; no vendor header is read or bundled. Numbers accept `H'10'`, `0x10`, `B'10'`, `D'10'`, `.10` and hexadecimal suffixes. The default is hexadecimal; `RADIX DEC` switches to decimal. Destination operands accept F/W or 1/0. Errors report a line and problem without repeating source. Arbitrary includes, macros and conditional assembly are not implemented.

ADC, USART, CCP, timers 1/2, MSSP, EEPROM/program-memory programming, comparators and watchdog timing are not implemented. Disabled peripheral configuration can be initialized without stopping; enabling or using an unsupported peripheral reports its name. An explicitly enabled watchdog configuration stops execution. Other configuration bits are recorded but do not model oscillator selection, protection, low-voltage programming or power behavior. Analog pin modes and internal PORTB pull-ups are not modeled; use external components. The model assumes fixed 5 V logic and does not reproduce package power or oscillator pins. The debugger shows PIC registers, bank, stack pointer, port latches and TRIS through the existing worker API.

The installed-sample tests read the five NI PIC circuits and workspace sources at test time and never copy or print their contents. All five convert and assemble: HTGraphicalDisplay and MultipleInterruptHandler execute 100,000 core steps; LCDDisplay and WriteReadEEDATA stop on EEPROM use; WatchdogTimerWakeup stops on its watchdog configuration. This checks firmware execution and conversion, not native LCD/display equivalence. Portable tests cover every instruction, exhaustive ADDWF/SUBWF flags, banking, indirect access, computed jumps, stack wrapping, TMR0, port interrupts, SLEEP/wake, an RB0 LED at 100 kHz, and live debugging/state retention. SDCC is installed on the validation machine, but gpasm is absent, so independent PIC assembler comparison remains unverified. The optional tests use gpasm when present (or `MICROSIM_GPASM`), without printing tool diagnostics or vendor source.

The implementation follows the published [PIC16F84A data sheet](https://ww1.microchip.com/downloads/en/devicedoc/35007b.pdf) and [PIC16F87XA data sheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/39582C.pdf).

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
