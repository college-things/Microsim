# Original student-library models

These symbols, equations, state tables and SPICE parameters were written for Microsim. No vendor SPICE decks, NI assets or component databases were used. Named devices are educational fits to public electrical specifications, not manufacturer-qualified models. Pin names describe electrical functions, not physical package lead numbers. The palette keeps its existing Basic, Diodes, Transistors, Analog and Digital categories.

## Passive parts, controls and sensors

| Part | Model and default | Boundary |
| --- | --- | --- |
| Polarized electrolytic capacitor | Ideal 100 uF capacitor; positive plate marked + at pin 1 | No ESR, leakage or reverse-polarity damage |
| Variable resistor / trimmer | Two-terminal 10 kohm rheostat at 50%; resistance = maximum × setting / 100, with a 1 milliohm floor | Use the existing three-pin potentiometer for a divider |
| Fuse | 0.1 A rating, 0.1 ohm cold resistance; integrates `max((I/rating)^2 - 1, 0)`; opens when the integral reaches the 10 ms parameter | Approximate excess-I-squared trip curve; holds open for the remainder of the run. A fresh run replaces the fuse. No cooling or arc model |
| Lamp | Fixed hot resistance, 120 ohm; indicator brightness reaches full at 12 V | No cold inrush or thermal state |
| Buzzer | 100 ohm resistive load | No sound generation or mechanical resonance |
| Relay | 120 ohm / 100 mH coil; normally open 0.05 ohm contact; pulls in above +9 V, drops below +3 V | Positive coil-voltage control, with hysteresis; no armature delay, bounce, arcing or magnetic current threshold. External flyback protection is needed |
| SPDT switch | COM connects to NC at position 0 or NO at position 1; 1 milliohm / 1 Gohm contacts | Ideal contacts, no bounce |
| Push button | Normally open momentary contact, same contact resistances | Reuses the live interactive-control mechanism: click presses for 200 ms; an assigned key holds until release |
| Crystal | Series motional RLC, 30 ohm and 20 fF, with 3 pF parallel capacitance; default 1 MHz; `L = 1/((2*pi*f)^2*Cm)` | Linear resonance; no drive-level, temperature or aging effects. Does not set the firmware-core clock |
| LDR | 10 kohm at 10 lux; `R = R10*(10/lux)^gamma`, gamma = 0.7 | Static light parameter, floored at 0.001 lux; no response-time model |
| NTC | 10 kohm at 25 C, beta = 3950 K; `R = R25*exp(beta*(1/T - 1/298.15))`, T in kelvin | Static temperature parameter; no self-heating; use above absolute zero |

## Diodes and transistors

Diode fits use the Shockley equation plus series resistance, junction capacitance, transit time and breakdown. The 1N4148 is a fast silicon signal diode, 1N4007 a slow 1000 V rectifier, and 1N5819 a 40 V Schottky rectifier. Zeners use 5.1 V and 12 V breakdown at 5 mA. Generic colored LEDs target approximately 1.9 / 2.2 / 3.1 / 3.2 V at 10 mA for red / green / blue / white. Green is the conventional low-voltage green type. These LEDs represent colors, not specific manufacturers or bins.

Public fitting references: [Vishay 1N4148](https://www.vishay.com/docs/81857/1n4148.pdf), [1N4001–1N4007](https://www.vishay.com/docs/88503/1n4001.pdf), and [1N5817–1N5819](https://www.vishay.com/docs/88525/1n5817.pdf). Capacitances and switching times are approximate single-point fits. Reverse breakdown is not a safe operating rating or a damage simulation.

| Transistor | Fit targets and construction |
| --- | --- |
| 2N3904 | BF 190, gain in the 100–300 range near 10 mA, sub-0.3 V saturation at forced beta ten, roughly 300 MHz transition frequency; CJE/CJC 8/4 pF |
| 2N3906 | PNP, BF 180, comparable low-current saturation, roughly 250 MHz transition frequency; CJE/CJC 10/4.5 pF |
| 2N2222A | BF 200, high-current knee 0.5 A, roughly 300 MHz transition frequency; CJE/CJC 25/8 pF |
| BC547B | BF 300, middle of the B gain selection, roughly 300 MHz transition frequency; CJE/CJC 12/4 pF |
| TIP120 | Two original NPN stages, each BF 60; Darlington input drop and gain above 1000; finite power-stage resistance and capacitance |
| 2N7000 | Level-1 channel with 2.1 V threshold and 0.12 A/V² transconductance parameter, plus 0.6 ohm drain resistance, body diode and 40/5 pF gate-source/gate-drain capacitances |
| IRF540N | Level-1 channel with 3 V threshold and 6 A/V² transconductance parameter, 12 milliohm drain resistance, body diode and 1550/120 pF gate-source/gate-drain capacitances; about 36 milliohm on resistance at Vgs = 10 V |

Fitting uses [onsemi 2N3904](https://www.onsemi.com/pdf/datasheet/2n3904-d.pdf), [2N3906](https://www.onsemi.com/pdf/datasheet/2n3906-d.pdf), [P2N2222A](https://www.onsemi.com/pdf/datasheet/p2n2222a-d.pdf), [BC546–BC550](https://www.onsemi.com/pdf/datasheet/bc546-d.pdf), [ST TIP120](https://www.st.com/resource/en/datasheet/tip120.pdf), [Microchip 2N7000](https://ww1.microchip.com/downloads/aemDocuments/documents/APID/ProductDocuments/DataSheets/2N7000-N-Channel-Enhancement-Mode-Vertical-DMOS-FET-Data-Sheet-20005695A.pdf) and [Infineon IRF540N](https://www.infineon.com/assets/row/public/documents/24/49/infineon-irf540n-datasheet-en.pdf). The 2N2222A fit represents this common family, not every metal/plastic package variant. Junction charge and gain are simplified; device spread, detailed gate charge, avalanche, safe operating area and destructive heating are not fitted.

## Analog ICs

LM741, LM358 and TL072 have explicit supply pins and one amplifier section per symbol. Each uses differential input resistance, a dominant pole, limited charging current for slew rate, smooth output saturation and 50 ohm output resistance. Nominal gain / gain-bandwidth / slew rate are 200000 / 1 MHz / 0.5 V/us, 100000 / 1 MHz / 0.3 V/us, and 200000 / 3 MHz / 13 V/us respectively. Output headroom is 2 V from either rail for LM741, 20 mV from the negative and 1.5 V from the positive rail for LM358, and 1.5 V from either rail for TL072. These are approximate light-load fits to the legacy [LM741](https://www.ti.com/lit/ds/symlink/lm741.pdf), [LM358](https://www.ti.com/lit/ds/symlink/lm358.pdf) and [TL072](https://www.ti.com/lit/ds/symlink/tl072.pdf), not newer B/H variants. Input offset, common-mode violations, bias currents, output current protection, supply current and thermal behavior are omitted.

[LM311](https://www.ti.com/lit/ds/symlink/lm311.pdf) has separate collector/emitter output pins, a 10 ohm sinking path and an RC decision delay of about 166 ns at its midpoint. It needs an external pull-up. Balance and strobe pins, offset, overdrive-dependent delay and common-mode restrictions are omitted.

[NE555](https://www.ti.com/lit/ds/symlink/ne555.pdf) uses three 5 kohm divider resistors, trigger/threshold comparisons, an existing digital SR latch, an active-low reset, a 1 ohm discharge switch, 10 ohm output resistance and a 1.2 V high-side drop. CTRL is accessible. Astable operation charges through R1+R2 and discharges through R2, between one-third and two-thirds supply. Tests compare measured frequency with `1.44/((R1+2*R2)*C)` within 10%. Reset overrides a low trigger. Very short intervals need fine timesteps. Supply-current transients, exact output drive curves and pathological simultaneous trigger/threshold inputs are not characterized.

[7805/7812](https://www.ti.com/lit/ds/symlink/lm340.pdf) use fixed references, 2 V dropout, 20 milliohm regulation resistance, a 1.5 A pass-current limit and 5 mA ground current. [LM317](https://www.ti.com/lit/ds/symlink/lm317.pdf) regulates OUT–ADJ to 1.25 V with the same dropout/current limit, and injects 50 uA into ADJ. Use the usual OUT-to-ADJ and ADJ-to-ground divider. No regulator loop dynamics, thermal shutdown, safe-area limiting, minimum-load qualification or reverse-supply protection is simulated.

## Digital ICs and displays

All digital parts use existing event-driven primitives and original functional tables. Levels are fixed at 0/5 V, with 2.5 V input thresholds and ideal implicit power. These are functional educational parts, not transistor-level HC/CMOS supply models. Timing is nominal: gates 10 ns, the 74HC74 15 ns, state-table transitions 1 ns. Setup/hold, metastability, loading limits and power-on randomness are not modeled. Internal state starts at zero; assert reset/clear for portable circuits.

- 74HC00/02/04/08/32/86: one NAND/NOR/inverter/AND/OR/XOR gate per part.
- 74HC74: one D flip-flop section per part, positive clock edge, active-low asynchronous preset and clear. Both controls asserted together is invalid.
- 74HC161: whole four-bit synchronous counter, active-low asynchronous clear, synchronous active-low parallel load, ENP/ENT enables, and terminal-count carry.
- 74HC595: whole eight-bit serial shift register and separate storage register, separate rising clocks, active-low shift clear, active-low tri-state output enable and serial cascade output.
- CD4017: whole decade counter, decoded Q0–Q9, carry, asynchronous reset, positive CLK edge with INHIBIT low; a falling INHIBIT edge also clocks when CLK is high.

Both seven-segment variants contain eight red diode segments, each with its own zero-volt current sensor. Use external current-limiting resistors. Common cathode sources current into segment pins; common anode sinks it. The canvas renders the actual a–g pattern and decimal point, including patterns that do not form a digit. Segments light at 1 mA. The indicator also retains a decoded text reading for recognized digits. There is no optical persistence or multiplex duty-cycle brightness model.

## Verification and remaining work

`tests/core/student-parts.test.ts` exercises every added part with hand calculations or the targets above, including diode current/voltage, transistor gain/saturation/RF roll-off, MOS capacitance/threshold/on-resistance, op-amp DC/bandwidth/slew, regulators under load/dropout/current limit, 555 astable timing/reset, digital tables/sequences/controls, relay hysteresis, fuse trip, sensors and both display polarities. Examples add a 555 LED blinker and 7805 supply; existing example simulation and exhaustive pin-pair wiring tests cover both. No new engine primitive was needed.

Remaining verification: physical bench comparison, model corners and broad temperature characterization, and hands-on canvas/live-control checks on desktop platforms. The approximations above are intentional boundaries, not hardware guarantees. More library families remain future work (SCR/triac/IGBT, ADC/DAC, analog switches, motors and further packages).
