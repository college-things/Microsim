import type { PartDef } from './library';
import type { Graphic, Pin } from './schematic';

// Independently fitted educational models. Sources and fitting targets: docs/part-models.md.
const line = (...xy: number[]): Graphic => ({ kind: 'line', points: Array.from({ length: xy.length / 2 }, (_, i) => ({ x: xy[2 * i], y: xy[2 * i + 1] })) });
const text = (x: number, y: number, value: string, size = 9): Graphic => ({ kind: 'text', x, y, text: value, size });
const rect = (x: number, y: number, w: number, h: number): Graphic => ({ kind: 'rect', x, y, w, h, filled: false });
const pair: Pin[] = [{ name: '1', x: -30, y: 0 }, { name: '2', x: 30, y: 0 }];
const param = (key: string, label: string, value: string) => ({ key, label, default: value });
const token = (name: string) => `{pin:${name}}`;
const block = (kind: string, name: string, category: PartDef['category'], inputs: string[], outputs: string[], body: string): PartDef => {
  const height = Math.max(inputs.length, outputs.length) * 20 + 20;
  const pins = [...inputs.map((name, i) => ({ name, x: -70, y: i * 20 - height / 2 + 20 })), ...outputs.map((name, i) => ({ name, x: 70, y: i * 20 - height / 2 + 20 }))];
  return { kind, name, category, prefix: 'U', pins, params: [], spice: body, graphics: [rect(-50, -height / 2, 100, height), text(0, -height / 2 + 10, kind.toUpperCase(), 8), ...pins.flatMap(p => [line(p.x, p.y, p.x < 0 ? -50 : 50, p.y), text(p.x < 0 ? -36 : 36, p.y - 3, p.name, 7)])] };
};

export function studentParts(base: PartDef[]): PartDef[] {
  const parts: PartDef[] = [];
  const clone = (kind: string, name: string, from: string): PartDef => {
    const part = { ...structuredClone(base.find(p => p.kind === from)!), kind, name };
    parts.push(part);
    return part;
  };
  const capacitor = clone('electrolytic', 'Polarized electrolytic capacitor', 'capacitor');
  capacitor.params[0].default = '100u';
  capacitor.graphics.push(text(-12, -13, '+'));
  parts.push({ kind: 'trimmer', name: 'Variable resistor / trimmer', category: 'Basic', prefix: 'R', pins: pair,
    params: [param('value', 'Maximum resistance', '10k'), param('percent', 'Setting (%)', '50')], valueParam: 'percent',
    spice: 'R{ref} {pin:1} {pin:2} {max(0.001,{param:value}*limit({param:percent},0,100)/100)}',
    graphics: [...base.find(p => p.kind === 'resistor')!.graphics, line(-12, 20, 12, -20), line(12, -20, 5, -16)] });
  for (const [kind, name, value, label] of [['lamp', 'Lamp (fixed hot resistance)', '120', 'LAMP'], ['buzzer', 'Buzzer (resistive load)', '100', 'BUZZ']] as const) {
    parts.push({ kind, name, category: 'Basic', prefix: 'R', pins: pair, params: [param('value', 'Resistance', value)], valueParam: 'value',
      spice: 'R{ref} {pin:1} {pin:2} {param:value}', graphics: [line(-30, 0, -16, 0), rect(-16, -16, 32, 32), line(16, 0, 30, 0), text(0, 3, label, 7)],
      ...(kind === 'lamp' ? { indicator: { kind: 'lamp' as const, pins: ['1', '2'], reads: 'voltage' as const, vmax: 12 } } : {}) });
  }
  parts.push({ kind: 'ldr', name: 'LDR light-dependent resistor', category: 'Basic', prefix: 'R', pins: pair,
    params: [param('r10', 'Resistance at 10 lux', '10k'), param('lux', 'Light level (lux)', '10'), param('gamma', 'Light exponent', '0.7')],
    spice: 'R{ref} {pin:1} {pin:2} {{param:r10}*pow(10/max({param:lux},0.001),{param:gamma})}',
    graphics: [...base.find(p => p.kind === 'resistor')!.graphics, line(-17, -22, -5, -12), line(-7, -24, 5, -14)], valueParam: 'lux' });
  parts.push({ kind: 'ntc', name: 'NTC thermistor (beta)', category: 'Basic', prefix: 'R', pins: pair,
    params: [param('r25', 'Resistance at 25 C', '10k'), param('beta', 'Beta (K)', '3950'), param('temperature', 'Temperature (C)', '25')],
    spice: 'R{ref} {pin:1} {pin:2} {{param:r25}*exp({param:beta}*(1/({param:temperature}+273.15)-1/298.15))}',
    graphics: [...base.find(p => p.kind === 'resistor')!.graphics, line(-15, 16, 15, -16), text(18, -16, 'T')], valueParam: 'temperature' });
  parts.push({ kind: 'crystal', name: 'Quartz crystal (motional RLC)', category: 'Basic', prefix: 'X', pins: pair,
    params: [param('freq', 'Series resonance (Hz)', '1meg'), param('cm', 'Motional capacitance', '20f'), param('rs', 'Series resistance', '30'), param('c0', 'Shunt capacitance', '3p')],
    spice: 'X{ref} {pin:1} {pin:2} MS_CRYSTAL f={param:freq} cm={param:cm} rs={param:rs} c0={param:c0}',
    definitions: `.subckt MS_CRYSTAL a b params: f=1meg cm=20f rs=30 c0=3p
Rmot a r {rs}
Lmot r c {1/(39.478417604*f*f*cm)}
Cmot c b {cm}
Csh a b {c0}
.ends`,
    graphics: [line(-30, 0, -9, 0), line(9, 0, 30, 0), line(-9, -13, -9, 13), line(9, -13, 9, 13), rect(-5, -10, 10, 20)], valueParam: 'freq' });
  parts.push({ kind: 'fuse', name: 'Fuse (overcurrent time integral)', category: 'Basic', prefix: 'X', pins: pair,
    params: [param('rating', 'Rated current (A)', '0.1'), param('delay', 'Excess I-squared time (s)', '10m'), param('ron', 'Cold resistance', '0.1')],
    spice: 'X{ref} {pin:1} {pin:2} MS_FUSE rating={param:rating} delay={param:delay} ron={param:ron}',
    definitions: `.subckt MS_FUSE a b params: rating=0.1 delay=10m ron=0.1
Vsense a s 0
Rwire s w {ron}
Scontact w b 0 dose MS_FUSE_SW
.model MS_FUSE_SW SW(RON=0.001 ROFF=1e9 VT=-1 VH=0.001)
Cdose dose 0 1 IC=0
Rhold dose 0 1e15
Bheat 0 dose I={if(time>0,max(0,pow(i(Vsense)/rating,2)-1)/delay,0)}
.ends`,
    graphics: [line(-30, 0, -18, 0), rect(-18, -8, 36, 16), line(-18, 0, 18, 0), line(18, 0, 30, 0)], valueParam: 'rating' });
  const relay = block('relay', 'Relay (coil and hysteretic NO contact)', 'Analog', ['coil+', 'coil-'], ['COM', 'NO'], 'X{ref} {pin:coil+} {pin:coil-} {pin:COM} {pin:NO} MS_RELAY rc={param:rc} lc={param:lc} pull={param:pull} drop={param:drop}');
  relay.params = [param('rc', 'Coil resistance', '120'), param('lc', 'Coil inductance', '100m'), param('pull', 'Pull-in voltage', '9'), param('drop', 'Drop-out voltage', '3')];
  relay.definitions = `.subckt MS_RELAY cp cn a b params: rc=120 lc=100m pull=9 drop=3
Rcoil cp ci {rc}
Lcoil ci cn {lc}
Scontact a b cp cn CONTACT
.model CONTACT SW(RON=0.05 ROFF=1e9 VT={(pull+drop)/2} VH={(pull-drop)/2})
.ends`;
  parts.push(relay);
  for (const spdt of [false, true]) {
    const kind = spdt ? 'spdt' : 'push-button';
    const p = block(kind, spdt ? 'SPDT switch (live)' : 'Push button (momentary, live)', 'Basic', ['COM'], spdt ? ['NC', 'NO'] : ['NO'],
      `X{ref} ${spdt ? '{pin:COM} {pin:NC} {pin:NO}' : '{pin:COM} {pin:NO}'} MS_${spdt ? 'SPDT' : 'BUTTON'} level={param:level}`);
    p.params = [param('level', 'Position (0 or 1)', '0')];
    p.definitions = `.subckt MS_${spdt ? 'SPDT' : 'BUTTON'} c ${spdt ? 'nc ' : ''}no params: level=0
Vcontrol ctl 0 {level}
Sno c no ctl 0 SWNO
${spdt ? 'Snc c nc 0 ctl SWNC\n.model SWNC SW(RON=0.001 ROFF=1e9 VT=-0.5)' : ''}
.model SWNO SW(RON=0.001 ROFF=1e9 VT=0.5)
.ends`;
    parts.push(p);
  }

  for (const [kind, name, from, model] of [
    ['1n4148', '1N4148 switching diode', 'diode', 'IS=2n N=1.75 RS=0.6 CJO=4p TT=4n BV=100 IBV=100u'],
    ['1n4007', '1N4007 rectifier', 'diode', 'IS=8n N=1.9 RS=0.035 CJO=15p TT=2u BV=1000 IBV=5u'],
    ['1n5819', '1N5819 Schottky', 'diode', 'IS=20u N=1.1 RS=0.12 CJO=110p TT=0 BV=40 IBV=1m'],
    ['zener-5v1', 'Zener 5.1 V', 'zener', 'IS=1n N=1.5 RS=2 CJO=100p BV=5.1 IBV=5m'],
    ['zener-12v', 'Zener 12 V', 'zener', 'IS=1n N=1.5 RS=4 CJO=60p BV=12 IBV=5m'],
    ['led-red', 'LED red (1.9 V)', 'led', 'IS=2e-18 N=2 RS=3 CJO=20p BV=5 IBV=10u'],
    ['led-green', 'LED green (2.2 V)', 'led', 'IS=6e-21 N=2 RS=3 CJO=20p BV=5 IBV=10u'],
    ['led-blue', 'LED blue (3.1 V)', 'led', 'IS=2e-28 N=2 RS=3 CJO=20p BV=5 IBV=10u'],
    ['led-white', 'LED white (3.2 V)', 'led', 'IS=3e-29 N=2 RS=3 CJO=20p BV=5 IBV=10u'],
  ]) {
    const p = clone(kind, name, from), id = `MS_${kind.replace(/-/g, '_')}`;
    p.spice = `{ref} {pin:A} {pin:K} ${id}`;
    p.definitions = `.model ${id} D(${model})`;
    if (from === 'led') p.indicator = { kind: 'led', pins: ['A', 'K'], reads: 'voltage', threshold: kind === 'led-red' ? 1.6 : kind === 'led-green' ? 1.9 : 2.7 };
  }
  for (const [kind, name, from, model] of [
    ['2n3904', '2N3904 NPN', 'npn', 'NPN(IS=7f BF=190 IKF=0.1 VAF=100 CJE=8p CJC=4p TF=450p TR=50n RB=10 RC=0.5 RE=0.2)'],
    ['2n3906', '2N3906 PNP', 'pnp', 'PNP(IS=7f BF=180 IKF=0.08 VAF=80 CJE=10p CJC=4.5p TF=600p TR=80n RB=10 RC=0.6 RE=0.3)'],
    ['2n2222a', '2N2222A NPN', 'npn', 'NPN(IS=15f BF=200 IKF=0.5 VAF=100 CJE=25p CJC=8p TF=400p TR=100n RB=8 RC=0.25 RE=0.15)'],
    ['bc547b', 'BC547B NPN', 'npn', 'NPN(IS=10f BF=300 IKF=0.1 VAF=100 CJE=12p CJC=4p TF=500p TR=80n RB=20 RC=0.5 RE=0.2)'],
  ]) {
    const p = clone(kind, name, from), id = `MS_${kind}`;
    p.spice = `{ref} {pin:C} {pin:B} {pin:E} ${id}`;
    p.definitions = `.model ${id} ${model}`;
  }
  const darlington = clone('tip120', 'TIP120 NPN Darlington', 'npn');
  darlington.prefix = 'X';
  darlington.spice = 'X{ref} {pin:C} {pin:B} {pin:E} MS_TIP120';
  darlington.definitions = `.subckt MS_TIP120 c b e
Qdriver c b mid MS_TIP_DRIVER
Qpower c mid e MS_TIP_POWER
Rbe mid e 8k
.model MS_TIP_DRIVER NPN(IS=10f BF=60 VAF=80 CJE=30p CJC=10p TF=10n RC=1)
.model MS_TIP_POWER NPN(IS=100f BF=60 IKF=5 VAF=80 CJE=300p CJC=100p TF=30n RC=0.15 RE=0.05)
.ends`;
  darlington.graphics.push(line(-3, -4, 5, -4, 5, 12));
  for (const [kind, name, vto, kp, rd, cg, cd] of [
    ['2n7000', '2N7000 NMOS', '2.1', '0.12', '0.6', '40p', '5p'],
    ['irf540n', 'IRF540N power NMOS', '3', '6', '0.012', '1.55n', '120p'],
  ]) {
    const p = clone(kind, name, 'nmos');
    p.params = []; p.prefix = 'X';
    p.spice = `X{ref} {pin:D} {pin:G} {pin:S} MS_${kind}`;
    p.definitions = `.subckt MS_${kind} d g s
Rd d di ${rd}
Mchannel di g s s MS_${kind}_M W=1u L=1u
Cgs g s ${cg}
Cgd g d ${cd}
Dbody s d MS_${kind}_D
.model MS_${kind}_M NMOS(VTO=${vto} KP=${kp} LAMBDA=0.001)
.model MS_${kind}_D D(IS=1n RS=0.02 CJO=${cg})
.ends`;
  }

  for (const [kind, gain, gbw, slew, rin, low, high] of [
    ['lm741', '200k', '1meg', '0.5meg', '2meg', '2', '2'],
    ['lm358', '100k', '1meg', '0.3meg', '10meg', '0.02', '1.5'],
    ['tl072', '200k', '3meg', '13meg', '1e12', '1.5', '1.5'],
  ]) {
    const p = block(kind, `${kind.toUpperCase()} op-amp (one section)`, 'Analog', ['+', '-', 'V+', 'V-'], ['OUT'], `X{ref} {pin:+} {pin:-} {pin:V+} {pin:V-} {pin:OUT} MS_${kind}`);
    p.definitions = `.subckt MS_${kind} p n vp vn out
Rin p n ${rin}
Bmid mid 0 V={(v(vp)+v(vn)+${low}-${high})/2}
Cdom state mid {${gain}/(6.283185307*${gbw}*1meg)}
Rdom state mid 1meg
Bdrive mid state I={limit(${gain}*v(p,n)/1meg,-${slew}*${gain}/(6.283185307*${gbw}*1meg),${slew}*${gain}/(6.283185307*${gbw}*1meg))}
Bclip raw mid V={max(0.01,(v(vp,vn)-${low}-${high})/2)*tanh(v(state,mid)/max(0.01,(v(vp,vn)-${low}-${high})/2))}
Rout raw out 50
.ends`;
    parts.push(p);
  }
  const comparator = block('lm311', 'LM311 comparator (open collector)', 'Analog', ['+', '-', 'V+', 'V-'], ['C', 'E'], 'X{ref} {pin:+} {pin:-} {pin:V+} {pin:V-} {pin:C} {pin:E} MS_LM311');
  comparator.definitions = `.subckt MS_LM311 p n vp vn c e
Rin p n 10meg
Bdecision decision 0 V={if(v(p,n)>0,0,5)}
Rdelay decision ctl 10k
Cdelay ctl 0 24p
Sout c e ctl 0 MS_LM311_SW
.model MS_LM311_SW SW(RON=10 ROFF=1e10 VT=2.5)
Rpower vp vn 20k
.ends`;
  parts.push(comparator);
  for (const [kind, voltage] of [['7805', '5'], ['7812', '12'], ['lm317', '1.25']]) {
    const adjustable = kind === 'lm317';
    const p = block(kind, adjustable ? 'LM317 adjustable regulator' : `${kind} voltage regulator`, 'Analog', ['IN', adjustable ? 'ADJ' : 'GND'], ['OUT'], `X{ref} {pin:IN} ${token(adjustable ? 'ADJ' : 'GND')} {pin:OUT} MS_${kind}`);
    p.definitions = `.subckt MS_${kind} inp g out
Btarget raw g V={min(${voltage},max(0,v(inp,g)-2))}
Bpass inp out I={limit((v(raw,g)-v(out,g))/0.02,-0.01,1.5)}
Rleak out g 1e9
${adjustable ? 'Iadj inp g 50u' : 'Iq inp g 5m'}
.ends`;
    parts.push(p);
  }
  const timer = block('ne555', 'NE555 timer', 'Analog', ['TRIG', 'THRESH', 'RESET', 'CTRL', 'VCC', 'GND'], ['OUT', 'DISCH'], 'X{ref} {pin:TRIG} {pin:THRESH} {pin:RESET} {pin:CTRL} {pin:VCC} {pin:GND} {pin:OUT} {pin:DISCH} MS_NE555');
  timer.definitions = `.subckt MS_NE555 trig thresh reset ctrl vcc g out disch
Rtop vcc ctrl 5k
Rmid ctrl low 5k
Rbottom low g 5k
Bset set 0 V={if(v(reset,g)<0.7,0,if(v(trig,g)<v(low,g),5,0))}
Breset rst 0 V={if(v(reset,g)<0.7,5,if(v(thresh,g)>v(ctrl,g),5,0))}
Ven en 0 5
Alatch set rst en NULL NULL q qn MS_555_LATCH
.model MS_555_LATCH d_srlatch(ic=1 sr_delay=100n)
Boutput raw g V={if(v(q)>2.5,max(0,v(vcc,g)-1.2),0.1)}
Rout raw out 10
Sdisch disch g qn 0 MS_555_DISCH
.model MS_555_DISCH SW(RON=1 ROFF=1e10 VT=2.5)
.ends`;
  parts.push(timer);

  for (const [kind, from] of [['74hc00', 'nand'], ['74hc02', 'nor'], ['74hc04', 'not'], ['74hc08', 'and'], ['74hc32', 'or'], ['74hc86', 'xor']]) {
    const p = clone(kind, `${kind.toUpperCase()} (one gate)`, from);
    // Original existing gate models, explicit family name selects HC input/output levels.
    const model = `MS_${kind}__74hc_5v`;
    p.spice = p.spice.replace(/\w+_GENERIC$/, model);
    p.definitions = p.definitions!.replace(/\w+_GENERIC/, model);
  }
  const ff = block('74hc74', '74HC74 D flip-flop (one section)', 'Digital', ['D', 'CLK', 'PRE_N', 'CLR_N'], ['Q', 'QN'], 'X{ref} {pin:D} {pin:CLK} {pin:PRE_N} {pin:CLR_N} {pin:Q} {pin:QN} MS_74HC74');
  ff.definitions = `.subckt MS_74HC74 d clk pre clr q qn
Apre pre ps MS_HC_INV__74hc_5v
Aclr clr rs MS_HC_INV__74hc_5v
Aff d clk ps rs q qn MS_HC_FF__74hc_5v
.model MS_HC_INV__74hc_5v d_inverter(rise_delay=10n fall_delay=10n)
.model MS_HC_FF__74hc_5v d_dff(clk_delay=15n set_delay=15n reset_delay=15n)
.ends`;
  parts.push(ff);
  const chip = (kind: string, name: string, inputs: string[], outputs: string[], behavior: string) => {
    const p = block(kind, name, 'Digital', inputs, outputs, `a{ref} [${inputs.map(token).join(' ')}] [${outputs.map(token).join(' ')}] MS_${kind}__${kind.startsWith('cd') ? 'cmos' : '74hc'}_5v`);
    p.definitions = `.model MS_${kind}__${kind.startsWith('cd') ? 'cmos' : '74hc'}_5v d_chip(behavior="/inputs ${inputs.join(' ')} /outputs ${outputs.join(' ')} ${behavior}")`;
    parts.push(p);
  };
  chip('74hc161', '74HC161 synchronous 4-bit counter', ['CLK', 'CLR_N', 'LOAD_N', 'ENP', 'ENT', 'A', 'B', 'C', 'D'], ['QA', 'QB', 'QC', 'QD', 'RCO'],
    '/clock CLK + 4 2 1 ' +
    'x10xxxxxx xxxx A B C D ' +
    'x1111xxxx xxxx f+0 f+1 f+2 f+3 ' +
    'x0xxxxxxx xxxx 0 0 0 0 ' +
    '/table 2 xxxx1xxxx 1111 f0 f1 f2 f3 1 xxxxxxxxx xxxx f0 f1 f2 f3 0');
  // Two state modules give independent shift and storage clocks, with tri-state outputs.
  chip('74hc595', '74HC595 8-bit shift/storage register', ['SER', 'SRCLK', 'RCLK', 'CLR_N', 'OE_N'], ['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'QH_SER'],
    '/wires s0 s1 s2 s3 s4 s5 s6 s7 ' +
    '/module shift /inputs SER SRCLK CLR_N /outputs s0 s1 s2 s3 s4 s5 s6 s7 serial ' +
    '/clock SRCLK + 8 1 1 xx1 xxxxxxxx SER f0 f1 f2 f3 f4 f5 f6 xx0 xxxxxxxx 0 0 0 0 0 0 0 0 ' +
    '/table 1 xxx xxxxxxxx f0 f1 f2 f3 f4 f5 f6 f7 f7 /endmodule ' +
    '/module store /inputs RCLK OE_N s0 s1 s2 s3 s4 s5 s6 s7 /outputs QA QB QC QD QE QF QG QH ' +
    '/clock RCLK + 8 1 0 xxxxxxxxxx xxxxxxxx s0 s1 s2 s3 s4 s5 s6 s7 ' +
    '/table 2 x0xxxxxxxx xxxxxxxx f0 f1 f2 f3 f4 f5 f6 f7 x1xxxxxxxx xxxxxxxx z z z z z z z z /endmodule ' +
    '/instance shift SER SRCLK CLR_N s0 s1 s2 s3 s4 s5 s6 s7 QH_SER ' +
    '/instance store RCLK OE_N s0 s1 s2 s3 s4 s5 s6 s7 QA QB QC QD QE QF QG QH');
  const decadeOutputs = [...Array.from({ length: 10 }, (_, i) => `Q${i}`), 'CARRY'];
  const decadeRows = Array.from({ length: 10 }, (_, i) => 'xx ' + Array.from({ length: 4 }, (_, bit) => (i >> bit) & 1).join('') + ' ' + Array.from({ length: 10 }, (_, j) => i === j ? '1' : '0').join(' ') + ` ${i < 5 ? 1 : 0}`).join(' ');
  chip('cd4017', 'CD4017 decade counter', ['CLK', 'INHIBIT', 'RESET'], decadeOutputs,
    '/wires tick ' +
    '/module clockgate /inputs CLK INHIBIT /outputs tick /table 2 10 1 xx 0 /endmodule ' +
    `/module decade /inputs tick RESET /outputs ${decadeOutputs.join(' ')} ` +
    '/clock tick + 4 2 1 x0 1001 0 0 0 0 x0 xxxx f+0 f+1 f+2 f+3 x1 xxxx 0 0 0 0 /table 10 ' + decadeRows +
    ' /endmodule /instance clockgate CLK INHIBIT tick /instance decade tick RESET ' + decadeOutputs.join(' '));

  for (const anode of [false, true]) {
    const kind = anode ? 'sevenseg-ca' : 'sevenseg-cc', segments = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const p = block(kind, `Seven-segment display (common ${anode ? 'anode' : 'cathode'})`, 'Diodes', [...segments, 'dp'], ['COM'], `X{ref} ${[...segments, 'dp', 'COM'].map(token).join(' ')} MS_${kind.replace('-', '_')}`);
    p.definitions = `.subckt MS_${kind.replace('-', '_')} ${[...segments, 'dp', 'common'].join(' ')}\n` + [...segments, 'dp'].map(s => anode ? `V${s} common ${s}i 0\nD${s} ${s}i ${s} MS_SEG_LED` : `V${s} ${s} ${s}i 0\nD${s} ${s}i common MS_SEG_LED`).join('\n') + '\n.ends\n.model MS_SEG_LED D(IS=2e-18 N=2 RS=3 CJO=20p BV=5 IBV=10u)';
    p.indicator = { kind: 'sevenseg', pins: segments, reads: 'current', common: 'COM', senses: segments.map(s => `v${s}`), dp: 'dp', dpSense: 'vdp', threshold: 0.001, thresholdUnit: 'A', activeLow: anode };
    parts.push(p);
  }
  return parts;
}
