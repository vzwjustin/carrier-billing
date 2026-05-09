/**
 * Helpers for building EDI 811 test fixtures.
 *
 * Avoid hand-writing the ISA header in raw strings — the fixed-width fields
 * are error-prone and the parser is strict about byte counts.
 */

export function pad(value: string, length: number): string {
  if (value.length >= length) return value.slice(0, length);
  return value + ' '.repeat(length - value.length);
}

export type IsaOptions = {
  senderId: string; // ISA06, padded to 15 chars
  receiverId: string; // ISA08, padded to 15 chars
  controlNumber?: string; // ISA13, default 000000001 (9 chars)
  date?: string; // ISA09, YYMMDD (6 chars), default 260401
  time?: string; // ISA10, HHMM (4 chars), default 1200
  elementSep?: string; // default '*'
  segmentTerminator?: string; // default '~'
  componentSep?: string; // default ':'
};

/** Build a valid 106-byte ISA segment ending with the segment terminator. */
export function buildIsa(opts: IsaOptions): string {
  const elementSep = opts.elementSep ?? '*';
  const segmentTerminator = opts.segmentTerminator ?? '~';
  const componentSep = opts.componentSep ?? ':';
  const fields = [
    'ISA',
    '00', // ISA01
    pad('', 10), // ISA02 (10 spaces)
    '00', // ISA03
    pad('', 10), // ISA04
    'ZZ', // ISA05
    pad(opts.senderId, 15), // ISA06
    'ZZ', // ISA07
    pad(opts.receiverId, 15), // ISA08
    opts.date ?? '260401', // ISA09 (6)
    opts.time ?? '1200', // ISA10 (4)
    'U', // ISA11
    '00401', // ISA12
    (opts.controlNumber ?? '000000001').padStart(9, '0'), // ISA13
    '0', // ISA14
    'P', // ISA15
    componentSep, // ISA16
  ];
  return fields.join(elementSep) + segmentTerminator;
}

/** Build a GS segment. */
export function buildGs(applicationSenderCode: string, control = '1'): string {
  return `GS*IN*${applicationSenderCode}*ACME*20260401*1200*${control}*X*004010~`;
}

export function buildGe(control = '1'): string {
  return `GE*1*${control}~`;
}

export function buildIea(control = '000000001'): string {
  return `IEA*1*${control.padStart(9, '0')}~`;
}

/**
 * Build a SAC (Service, Promotion, Allowance, or Charge) segment with the
 * X12 4010 wireless 811 layout: indicator at SAC01, service code at SAC02,
 * amount at SAC05, optional DPP installment counts at SAC07/SAC08, and the
 * free-form description at SAC15. Trailing empty elements are trimmed.
 */
export function buildSac({
  indicator,
  code,
  amount,
  description,
  remainingPayments,
  totalPayments,
}: {
  indicator: 'A' | 'C';
  code: string;
  amount: string; // dollars or cents — the mapper sniffs based on the decimal
  description?: string;
  remainingPayments?: number;
  totalPayments?: number;
}): string {
  const els = new Array<string>(16).fill('');
  els[0] = 'SAC';
  els[1] = indicator;
  els[2] = code;
  els[5] = amount;
  if (remainingPayments !== undefined) els[7] = String(remainingPayments);
  if (totalPayments !== undefined) els[8] = String(totalPayments);
  if (description) els[15] = description;
  while (els.length > 1 && els[els.length - 1] === '') els.pop();
  return `${els.join('*')}~`;
}

/**
 * Wrap a transaction set body (ST...SE included) in a full ISA/GS/GE/IEA
 * envelope. Returns the complete interchange string.
 */
export function buildInterchange({
  isa,
  gs,
  body,
  ge = buildGe(),
  iea = buildIea(),
}: {
  isa: string;
  gs: string;
  body: string;
  ge?: string;
  iea?: string;
}): string {
  return `${isa}${gs}${body.trim()}\n${ge}${iea}`;
}
