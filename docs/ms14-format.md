# .ms14 circuit file format

Structure notes for `src/importer`, worked out from the circuit data files only, by comparing 133
sample circuits saved by version 14. Other versions are untested. Nothing here is an official
specification.

## Container

| Offset | Size | Content |
| --- | --- | --- |
| 0 | 36 | ASCII magic `MSMCompressedElectronicsWorkbenchXML` |
| 36 | 8 | u64 LE, total uncompressed size |
| 44 | ... | chunks until end of file |

Each chunk is a u32 LE uncompressed size (at most 900000 in the samples), a u32 LE compressed size,
then a PKWARE DCL implode stream: byte 0 is 1 for coded literals or 0 for uncoded, byte 1 is the
dictionary bits (4 to 6). Each stream has its own window and ends with the length-519 code.

The magic names no version, so the importer accepts any file that has it, and also plain XML.

## XML

The root is `<MSMElectronicsWorkbench Schema="67">`, single-byte text. Stray NUL bytes are removed
before parsing. Attribute values hold real line breaks, which matter for SPICE text; a parser that
normalises attribute whitespace loses them.

String values carry a prefix after entity decoding:

- `&ASC` plain text, so `&amp;ASCR1` is `R1`.
- `&UNI` text with `_uc1XXXX` escapes for a UTF-16 unit, so `1k_uc103a9` is `1k` and an ohm sign.

`SimState` (over 100 KB) and the preview `Data` (PNG as hex) are large; read them only when needed.

## Layout

```
Project (Name, AppName, AppVersion)
  UniqueSheets/SheetInfos/SheetContainer*          one per sheet
    Sheet/Variable/DesignSheet (Title, DocType)    DocType SCH_CAPDESIGN or DESCRIPTIONBOX
      Sheet/XMLSubSheet/CIITHierDoc
        Diagram/CIITDiagram (SimState)
          Components/CODComposite/Objects/Item*    what is drawn
          Components/CODComposite/ReferencedComponents  repeats objects; not needed
          Background                               page border; not needed
          Elements/Item*                           the electrical model
        InstrumentsData/CSourceSymbolCollectNode*  instrument settings, keyed "XFG1#1/Sheet:"
  Extensions/Extension (Class CMultisimExtension, ActiveAnalysis)
```

`Item` elements are keyed by `CiID` in `Elements` and `ID` in `Objects`. Ids are per sheet in practice,
so build one index per sheet. An `Item` with a `Class` holds one child element of that class.

## Electrical model (`Elements`)

| Class | Key attributes | Children |
| --- | --- | --- |
| `CiComponent` | `LocalName`, `Model`, `SymCompID`, `Circuit` | `Attributes`, `Ports` (`Item CiID`) |
| `CiInstComponent` | as above | a block placed on a sheet |
| `CiPort` | `LocalName` (pin name, empty on connectors), `Component` | `Nodes` |
| `CiNode` | `LocalName` (net name) | `Ports` |
| `CiModel` | `LocalName`, `Scope` | `Attributes` |
| `CiCircuit` | | lists of the above |
| `CiProbeComp`, `CiProbeExtComp` | | measurement only |

`Attributes` is a positional list of `Item`, many empty. For components:

| Index | Class | Content |
| --- | --- | --- |
| 1 | `CiaSpiceTmpltExprt` | `String`, the SPICE template |
| 2 | `CiaParamList` | `doubles`, `strings`, `parameters`, `paramindicators` |
| 4 | `CiaCollString` | part identity: family, part, ... |
| 5 | `CiaCollString` | index 1 and 3 name an instrument type, index 4 the reference prefix |

Index 4 of the second list marks special parts: `IO%d` a block's port, `OnPage` an on-page connector,
`Global` a global connector, `XSC%d` and so on an instrument, `0` ground.

`CiModel` text is the first `CiaCString` in its `Attributes`, holding `.MODEL` or `.SUBCKT` text, or a
comment when the part has no model. Far more models are stored than parts use; a referenced model can
name others, so follow names through the text.

### Connectivity

A port's `Nodes` holds one `Item`; with no `CiID` the pin is unconnected unless a modifier below names its net.
Net `0` is ground.

A `CiNode` is one piece of wiring, not one net, and its `LocalName` proves nothing on its own: names go stale, and
in NPCThreeLevelInverter or CoupledShaftMachines unrelated pieces share a name. These join pieces into a net:

| Link | Where |
| --- | --- |
| Same name and touching | Two nodes of one name where a wire end or pin lands on the other's wire |
| `NI_EWB_NET_VIRTUAL` | On a connector's pin, `ElectricalObject/ModifierInfo/Element (NetModifier)/Item (Value)`. One value is one net on the sheet, whatever the nodes are called |
| `NI_EWB_NET_GLOBAL` | The same across all sheets |
| `NI_EWB_NET_GLOBAL_GROUND` | Net 0 |
| `NI_EWB_NET_HIERARCHY` | The port on a sheet; `NI_EWB_NET_HIERARCHY_COMP` is its pin on the block |
| `NI_EWB_NET_BUS_ENTRY` | On `CIITBusEntry`, the line's name. The bus lists entries in `BusEntries`, with its own name in `NI_EWB_NET_VIRTUAL`. Entries of one name on buses of one name are one net; the entry's `CIITPinConnectorComp` is where the wire lands |

Also on wires: `NI_EWB_NET_NAME` is a name the user gave, used by expressions (`v(pri)` where the node is `6`).
`NI_EWB_NET_AUTONAMED` adds nothing. The name on a bus entry and on its wire can differ; the entry's is what links.

Hidden power pins are ordinary ports. Connector ports can have no stored node at all, and are then on their net by
the modifier alone. A connector's `LocalName` can name a net that behavioural expressions use, such as `V(Lval)`.

`GND` and `DGND` are ground: the digital ground model is a subcircuit holding only `.mergenodes 1 0`, or in some
files a 0.1 ohm resistor to node 0.
`VCC`, `VDD`, `VSS` and similar are global across sheets. Repeated supplies on one net are one source.

### Hierarchy

A block is a `CiInstComponent` whose symbol is a `CIITMacroComponent` holding
`HierBlock/CHierBlock (FileName, Subcircuit)`. With `Subcircuit="1"`, `FileName` is the `Title` of a sheet
in this file. With `Subcircuit="0"`, it is a path to another file, whose contents are absent. A block
port named `INPUT` joins the single-port `CiComponent` named `INPUT` on the inner sheet. The block's
stored template calls a subcircuit named after the sheet, which does not exist as text; drop it when
flattening. All samples are single-page (`PageName` 1).

Behavioural expressions in `CiaParamList` strings use sheet-level names and can refer to parts on
outer sheets, as `I(Vsensor1)`.

### Reference designators

`LocalName` and the symbol's `CIITSymTextCompName` text can be stale. The reference shown on the sheet, and
the name SPICE uses, is in the project-wide table
`Extensions/.../RefDesMgr/RefDesInfoContainers/RefDesInfoContainer/CIRToInfoMap/CIRToInfoMapItem`:
`RefDesInfo` holds `IRPrefix`, `IRNumber` (-1 means no number) and `IRSection`. `CIRKey` is the symbol's stored name
text, not `LocalName`: a section stored as `U2`, whose text reads `U2A`, is filed under `U2A` and shows as `U1B`.

The name text is what says whether a name shows at all: when `Output` is empty the file hides the name, though
the part still has a table entry and a SPICE name.
Its `RefDesInfoData RefDes` is `!0` separated, with the sheet title at index 6. So a part stored as `V5` on
sheet `current limiter` can show `Sensor1`, and an expression then calls it `I(Vsensor1)`. Checked against the
embedded previews. `InstrumentsData` is keyed by the stored name.

### Nets with no name

`empty_name` marks a node that never got a name. Several can exist on a sheet and they are separate nets,
unlike every other repeated name. Repeated numeric names are real: members of a bus, for instance.

### What the sheet shows

- Net names: a `CODNodeTextComp` with a non-empty `Output` shows on the wire named in its `Links`. Most are empty.
- Notes: `CIITPostItComp` is an icon with text on hover unless `ShowInfo` is 1, when the box stays open at
  `InfoBoxOffsetX`, `InfoBoxOffsetY` from the icon.

### Current probes

`CIITIMeterSymbolComp` draws a probe clamped on a wire. Its model is `.subckt X 1 2 3`, `v1 2 1 dc 0`, `h1 0 3 v1 K`,
but pins 1 and 2 have no node, so as stored it reads nothing. The clamp is the first `CODEllipseComp`, where the file splits
the wire into two ending at that point. `Direction` is the arrow, inferred as 1 up, 3 right, 5 down, 7 left: all 26 probes
in the samples are 3 or 5, and all have a wire running along or against the arrow (one clamps a corner). Current entering pin 1 reads positive. `WB_RATIOVALUE` holds the
ratio, already in the model's `K`. Checked by simulation: the reading in TrapezoidalOscillation matches 1000 C dv/dt.

## SPICE templates

`#N` indexes `parameters`, not `doubles`: `doubles` can hold unscaled mantissas, for instance 100 for
100u. A capital M in `parameters` is mega: `2M` sits beside `2000000.` in `doubles`. Lower-case m is milli.
Even positions in the common value lists are flags and odd ones values. A few parts store a value
only in `doubles`, with `parameters` empty; those use `doubles` at the same index.

| Token | Meaning |
| --- | --- |
| `%p` | reference designator |
| `%m` | `LocalName` of the component's model |
| `%tPIN` | net on a pin; the pin name ends at the longest port-name match |
| `%tPIN?%t:d%t;PIN` | net on a pin with a prefix choice, `d` or `r` for digital and resistive port forms |
| `%tPIN%t:d%t;PIN` | the same, with the `?` missing; seen in a few templates |
| `#N` | parameter N |
| `%vN?a%v:b%v;` | `a` when parameter N is non-zero, otherwise `b` |
| `%SN` | entry N of `strings`, verbatim, often a whole subcircuit body |
| `%fA:C:S` | parameters A, A+S, ... while the offset is below parameter C; list arguments |
| `<expr>` | computed when the template is expanded, as in `<1/#1>` |
| `{expr}` | SPICE expression, which may hold `#N` |
| `%%` | literal `%`, as in the XSPICE port type `%vd(` |

`%vN?TEMP=#M%v:%v;` and its `TC1`, `TC2`, `TNOM` companions: flag 1 usually means nothing, because old files switch all of them
on with defaults (27, 0, 0, 27). No sample sets another TEMP. Stated on a part, TEMP=27 pins it against an analysis's temperature.

Non-numeric parameters are expressions over circuit parameters and need braces. One stored template has
an unbalanced form: `[ %v:%v;%v25?#13 %v:%v;...%v26?#14 ])`, where the leading `%v:%v;` is empty and the
last conditional runs to the end.

Templates may hold several statements with inline `.model` and `.subckt`. A block from
`* !!!BEGIN-INTERACT` to `* !!!END-INTERACT` is an on-screen behaviour script. What follows it is the
circuit. `* SHOW_TEMPLATE_DATA_ONLY` is a marker comment.

`.mergenodes a b` is not SPICE; it shorts two nodes. `pwldynamic("...")` is a live data source from a
co-simulated panel.

### Interactive parts

Values in the circuit after an interactive script can be placeholders that the script overwrites when a
simulation starts. Within a script, `++++fN` is entry N-1 of `parameters`.

| Part | Placeholder | What the script sets |
| --- | --- | --- |
| `Potentiometer%p` | `R1`, `R2` at 1e-3 | total from `setresistance`; `R1` = total x setting, clamped; `R2` = the rest |
| `VariableCapacitor%p` | `C1` at 50e-12 | `tcapacitance` x setting, clamped |
| `VariableDCVoltage%p` | `V1` at 10 | the shown output; otherwise `tminvalue` + (`tmaxvalue` - `tminvalue`) x setting |
| Switches | `V2 ... DC 0` | `*animation_state max_states low high STATE`: the level for the saved state |
| Digital constant | `d_constsource(state=0)` | the same, through `SET_MODEL_INSTANCE` |
| `Bulb%p` | `R1` at 100 | `vmax` squared over `pmax`, from the script's constants |

The setting is what the part shows: `CIITVariableSymText` `Output`, such as `40 %` or `30V`. The saved state is
`CurIndex` on `CIITAnimationSymbolComp`, which also picks the `CIITAnimationLayerComp` that is drawn.

Momentary switches (`SW_UP`, `SW_DOWN` in the script) rest at the low level whatever state is saved, and the script releases
them itself after 5 output steps. The key is `strings[0]` of the parameter list, where a single space means the space bar; the
sheet's value text repeats it as `Key = X`, or replaces it with a caption.

Display scripts read as follows. `hex_display`: R1 to R4 are 500 ohms to ground, and a current over `i_on` (0.005) on Rn sets a
bit of weight 2^(n-1), so pins `1` to `4` are least significant first, lit at 2.5 V. `dig7seg`: the same weights, reading node
voltage against 0.9, with `VCC` and `GND` as supply pins. `seven_segment`: `V1` to `V8` are the current senses of pins `A` to
`H` (the point), in series with diodes from `COM`, so a segment lights when `i(Vn)` exceeds `i_on`. Digital probes also read 0.9 V.

`Ammeter`: `R1` between the pins is the shunt, and the `AC` or `DC` in the stored strings picks the reading. The file offers no indicator data beyond the script: its `Ion`, `i_on`, `v_level`, `vmax` and `pmax`
values and the circuit it reads, such as an LED's internal `V` source.

The holding tank, conveyor belt and keypad parts change their values continuously from their scripts, so
what is stored there is only a starting point.

Instrument templates start with `%p` because the reference (`XFG1`) is itself a subcircuit call; the
model holds the behaviour, including generator settings written as source values.

## Drawing (`Objects`)

Each object has a matrix in `Transformer-M00..M21`:
`x' = x*M00 + y*M10 + M20`, `y' = x*M01 + y*M11 + M21`. Matrices compose from the object out through its
parents. A missing matrix is the identity. Wires (`CIITLinkComp`) carry matrices too.

Checked over the corpus: every one of 10484 wire ends with a resolvable connection lands within 1.5
units of the pin or junction it names, using this rule.

Symbol objects (`CIITSymbolComp`, `CIITMacroComponent`, `CIITHierConnector`, `CVirtualConnector`,
`CIITAnimationSymbolComp`) name their component in `CiComponent`. Their own matrix is always a plain
translation. Rotation and mirroring are already applied to the children, and recorded in
`OrientationFlip`:

| Bits | Meaning (in `pinWorld` terms: mirror x, then rotate clockwise on a y-down screen) |
| --- | --- |
| low 2 | quarter turns |
| 4096 | mirrored |
| 256 | mirrored and turned 180 degrees |

This was established by matching pin layouts of each part across orientations.

| Class | Geometry |
| --- | --- |
| `CODLineComp`, `CODRectComp` | `pt0X pt0Y pt1X pt1Y` |
| `CODPolygonComp`, `CODMultiLineComp`, `CIITLinkComp`, `CIITBusCompV8` | `Points/Item X Y` |
| `CODEllipseComp` | `CenterX CenterY Radius1 Radius2` |
| `CIITArcComp` | ellipse fields plus `Start`, `Middle`, `End` points; the arc passes through the middle |
| `CODTextComp`, `CIITSym*`, pin texts | `Output`; position is the matrix translation |
| `CIITPinSymbolComp` | `PinName`, `ShowName`, `ShowNumber`, children below |
| `CIITPinConnectorComp` | `ptCenterX ptCenterY`, where wires land; `ConnectList` names wire-end pins |
| `CODPinComp` | a junction: `CenterX CenterY`; wires name these in `Connect1`, `Connect2` |
| `CIITPostItComp` | a note, in `Text` |

Wire `Node` gives the wire's `CiNode`. A wire can pass over a pin it does not join. The drawing alone does not
always carry a net: connectors, bus members, hidden pins and block ports are joined only by name. Fill is
`Brush-Style` 0 with colour `FgColor`, a BGR integer; 1 is hollow.

## Analyses

`SimState` on the sheet's `CIITDiagram`, entries `NAME:type{value}` where type is `long`, `double`,
`string`, `flag`, or `list` holding more entries. Under `SIMULATION_INFO/ANALYSES`, each analysis has an
`ANALYSIS` list:

| Analysis | Fields |
| --- | --- |
| `OP` | none needed |
| `AC` | `VARIATION` (`dec`, `oct`, `lin`), `NPOINTS_PER_VARIATION`, `FSTART`, `FSTOP` |
| `TRAN` | `TSTEP`, `TSTOP`, `TSTART`, `TMAX` (`calculate` or a number), `IC` (`auto_ic`, `zero_ic`, `uic`, `dcop`), `TPOINTS` |
| `DC_SWEEP` | `Source1`, `Start1`, `Stop1`, `Increment1`, `UseSource2`, and the same for source 2 |

In 30 samples the parameter sweep's nested settings close more lists than they open, leaving the analyses after
it at the top level of the text, beside `SIMULATION_INFO`. The active DC sweeps are among them, so look in both.

The source names follow the shown reference with the instance letter: `vvpulse1` is the part shown as `Vpulse1`.

Also present: `FOUR`, `NOISE`, `DISTO`, `TSWEEP`, `PSWEEP`, `PZ`, `TF`, `SENS`, `WORST`, `MONTE`, `USER`,
`RUN`, `NOISE_FIGURE`, `TRACEWIDTH`, `PHASOR`. Every file stores defaults for most of them;
`ActiveAnalysis` says which was in use (`interactive`, `transient`, `ac`, `dcSweep`, ...).

## Circuit parameters and instruments

`CCircuitParamSheetGroupExtension` holds `CircuitParamName (NameItem)` entries and, per instance,
`CircuitParamValueList/CircuitParamValue (ValueItem)` in the same order. Values may be expressions.

Instrument settings are `MapData/Element (Key)/CDataElement (Data)` under `InstrumentProperties`:
`NI_EWB_WAVE_MODE`, `FREQUENCY_VALUE`, `AMPLITUDE_VALUE`, `OFFSET_VALUE`, `DEPUTY_CYCLE_VALUE` on the function
generator, `MEASUREMENT_MODE` on the multimeter, `TIMEBASE_SCALE_VALUE` (seconds per division),
`A_CHANNEL_SCALE_VALUE`, `B_CHANNEL_SCALE_VALUE` (volts per division), `A_CHANNEL_POSITION_VALUE` and
`B_CHANNEL_POSITION_VALUE` (inferred: divisions, as stored values run in 0.2 steps from -1.6 to 1.8 whatever the scale),
`TRIGGERBASE_TRIGGERLEVEL` (inferred: volts) on the oscilloscope, `HORZ_INITIAL_VALUE` and
`HORZ_FINAL_VALUE` on the Bode plotter. The four-channel oscilloscope uses `TKSCOPE_` keys instead and stores no
plain timebase.

Function generator pins: 1 positive, 2 common, 3 negative. Six-pin oscilloscope pins: 1 A+, 2 B+,
3 trigger+, 4 A-, 5 B-, 6 trigger-. The wave mode and measurement mode numbers are inferred from button
order, with one sample each confirming the sine and ohms values.
