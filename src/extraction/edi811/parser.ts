/**
 * Minimal X12 EDI parser scoped to what the 811 transaction set needs.
 *
 * The parser does NOT understand 811 semantics — it splits the input into
 * envelope metadata + a flat ordered list of segments. The mapper layer
 * (see `mapper.ts`) interprets those segments against the 811 implementation
 * guides each carrier ships.
 *
 * Why hand-roll instead of pulling a library: the X12 spec is small enough
 * that a 100-line parser covers what we need, every wireless carrier ships
 * its own dialect quirks anyway, and avoiding a dependency keeps the
 * production bundle small and the supply chain narrow.
 */

/** A single decoded segment, e.g. `BIG*20260401*INV-12345*...` */
export type Edi811Segment = {
  /** Segment ID, e.g. `BIG`, `IT1`, `SAC`. Always upper-case. */
  id: string;
  /**
   * Data elements in declaration order, indexed from 1 to match the X12 spec
   * (i.e. `elements[1]` is the first data element after the segment id).
   * `elements[0]` is always the segment id, repeated for cheap stringification.
   *
   * Composite/repeating elements are kept as-is — the consumer is responsible
   * for splitting them on the component separator returned in `Edi811Envelope`.
   */
  elements: string[];
};

export type Edi811Envelope = {
  /** Element separator, byte 4 of the ISA header. */
  elementSep: string;
  /** Segment terminator, byte 106 of the ISA header. */
  segmentTerminator: string;
  /** Component (sub-element) separator, byte 105 of the ISA header. */
  componentSep: string;
  /** ISA06 — interchange sender id. Fixed-width 15 chars in the spec. */
  senderId: string;
  /** ISA08 — interchange receiver id. */
  receiverId: string;
  /** ISA13 — interchange control number. */
  controlNumber: string;
  /** GS02 if a GS segment exists, otherwise null. */
  applicationSenderCode: string | null;
};

export class Edi811ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Edi811ParseError';
  }
}

/** Lower-bound for a syntactically-valid ISA + IEA wrapper. */
const MIN_INTERCHANGE_BYTES = 106;

/** ISA segment is exactly 106 chars including the trailing terminator. */
const ISA_HEADER_BYTES = 106;

/**
 * Decode an X12 interchange. Returns the envelope metadata and a flat list
 * of every non-envelope segment between ST and SE (inclusive of ST/SE so
 * mapper code can sanity-check transaction set ids).
 *
 * The parser is forgiving about whitespace between segments — newlines,
 * carriage returns, and tabs after a segment terminator are skipped. It is
 * NOT forgiving about unknown separators: if the ISA header is malformed
 * we throw `Edi811ParseError` so the worker can fail the audit cleanly.
 */
export function parseEdi811(raw: string): {
  envelope: Edi811Envelope;
  segments: Edi811Segment[];
} {
  if (raw.length < MIN_INTERCHANGE_BYTES) {
    throw new Edi811ParseError('input is too short to be a valid X12 interchange');
  }
  if (raw.slice(0, 3) !== 'ISA') {
    throw new Edi811ParseError('input does not start with ISA');
  }

  // The element separator is the first character after the literal "ISA".
  const elementSep = raw.charAt(3);
  if (!elementSep || /[A-Za-z0-9]/.test(elementSep)) {
    throw new Edi811ParseError('ISA element separator is missing or invalid');
  }

  // The X12 spec fixes the ISA segment at exactly 106 bytes including the
  // trailing segment terminator. ISA16 (the component separator) is byte 105
  // and the segment terminator is byte 106 — there is NO element separator
  // between ISA16 and the segment terminator, which makes a generic
  // separator-walker overshoot. Slice the fixed header off and split on the
  // element separator directly.
  const isaHeader = raw.slice(0, ISA_HEADER_BYTES - 1);
  const segmentTerminator = raw.charAt(ISA_HEADER_BYTES - 1);
  if (!segmentTerminator || segmentTerminator === elementSep) {
    throw new Edi811ParseError('segment terminator is missing or conflicts with element separator');
  }

  const isaFields = isaHeader.split(elementSep);
  // 17 fields = "ISA" + ISA01..ISA16.
  if (isaFields.length !== 17) {
    throw new Edi811ParseError('ISA header is malformed');
  }
  // ISA fields are 1-indexed in the spec; our array is 0-indexed with the
  // segment id at index 0, so ISA06 → index 6, ISA08 → 8, ISA13 → 13, ISA16 → 16.
  const senderId = (isaFields[6] ?? '').trim();
  const receiverId = (isaFields[8] ?? '').trim();
  const controlNumber = (isaFields[13] ?? '').trim();
  const componentSep = isaFields[16] ?? '';
  if (componentSep.length !== 1) {
    throw new Edi811ParseError('ISA16 component separator is missing or malformed');
  }

  // Split the rest of the interchange on the segment terminator and trim any
  // inter-segment whitespace. Empty segments are dropped.
  const tail = raw.slice(ISA_HEADER_BYTES);
  const rawSegments = tail.split(segmentTerminator);
  const segments: Edi811Segment[] = [];
  let sawSt = false;
  let sawSe = false;
  let applicationSenderCode: string | null = null;

  for (const rawSegment of rawSegments) {
    const trimmed = rawSegment.replace(/^[\r\n\t ]+/, '').replace(/[\r\n\t ]+$/, '');
    if (trimmed.length === 0) continue;
    const elements = trimmed.split(elementSep);
    const id = (elements[0] ?? '').toUpperCase();
    if (id.length === 0) continue;

    // We do NOT include the envelope segments (ISA was already consumed; GS
    // and IEA/GE are still in the stream and we strip them here so mapper
    // code can iterate without filtering).
    if (id === 'IEA') break;
    if (id === 'GS') {
      applicationSenderCode = (elements[2] ?? '').trim() || null;
      continue;
    }
    if (id === 'GE') continue;

    if (id === 'ST') {
      sawSt = true;
    }
    if (id === 'SE') {
      sawSe = true;
    }

    segments.push({ id, elements });
  }

  if (!sawSt || !sawSe) {
    throw new Edi811ParseError('transaction set ST/SE markers are missing');
  }

  return {
    envelope: {
      elementSep,
      segmentTerminator,
      componentSep,
      senderId,
      receiverId,
      controlNumber,
      applicationSenderCode,
    },
    segments,
  };
}

/** Pull element[i] from a segment, returning '' if absent. */
export function el(segment: Edi811Segment, index: number): string {
  return segment.elements[index] ?? '';
}

/** Like `el` but trimmed and returning null for empty strings. */
export function elOrNull(segment: Edi811Segment, index: number): string | null {
  const v = el(segment, index).trim();
  return v.length === 0 ? null : v;
}
