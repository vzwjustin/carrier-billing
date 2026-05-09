/**
 * Minimal ANSI X12 tokenizer.
 *
 * X12 wraps every transaction in an ISA…IEA interchange envelope. The ISA
 * segment is fixed-width (106 chars) so we can deterministically read all
 * three delimiters out of it without any prior configuration:
 *
 *   - `element separator`     = byte at position 3 (immediately after "ISA")
 *   - `subelement separator`  = byte at position 104 (penultimate char)
 *   - `segment terminator`    = byte at position 105 (last char of ISA)
 *
 * Some carriers add a trailing `\n` between segments; we strip CR/LF + tabs
 * after the segment terminator so the parser is whitespace-tolerant.
 *
 * What this module does NOT do:
 *   - Honor repetition separators (X12 5010+; ISA byte 82). Telecom 811
 *     implementations we care about don't use them.
 *   - Validate envelope integrity (ISA13 = control number, IEA01 = group
 *     count, etc). The 811 mapper does loose mapping — bad envelopes just
 *     produce missing data, not crashes.
 *   - Handle binary BIN segments. None of those appear in 811.
 */

export interface X12Delimiters {
  element: string;
  subelement: string;
  segment: string;
}

export interface X12Segment {
  /** Segment ID, e.g. "ISA" / "ST" / "BIG" / "IT1". Always upper-case. */
  tag: string;
  /**
   * Elements *after* the tag, in 1-based order from the X12 spec but stored
   * 0-indexed. `elements[0]` is BIG01, `elements[1]` is BIG02, etc.
   */
  elements: string[];
}

export class EdiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdiParseError';
  }
}

const ISA_PREFIX = 'ISA';
const MIN_ISA_LENGTH = 106;

/** Quick test used to route between PDF / EDI in the extraction pipeline. */
export function looksLikeX12(buffer: Buffer): boolean {
  // Skip up to 8 leading bytes of whitespace (some senders wrap the file).
  let i = 0;
  while (i < buffer.length && i < 8) {
    const b = buffer[i] ?? 0;
    if (b === 0x09 || b === 0x0a || b === 0x0d || b === 0x20) {
      i += 1;
      continue;
    }
    break;
  }
  if (i + 3 > buffer.length) return false;
  return (
    buffer[i] === 0x49 /* I */ &&
    buffer[i + 1] === 0x53 /* S */ &&
    buffer[i + 2] === 0x41 /* A */
  );
}

export function detectDelimiters(text: string): X12Delimiters {
  const start = text.search(/ISA/);
  if (start < 0) {
    throw new EdiParseError('No ISA segment found');
  }
  if (text.length < start + MIN_ISA_LENGTH) {
    throw new EdiParseError(
      `ISA segment is too short (${text.length - start} chars, need ${MIN_ISA_LENGTH})`,
    );
  }
  const element = text[start + 3];
  const subelement = text[start + 104];
  const segment = text[start + 105];
  if (!element || !subelement || !segment) {
    throw new EdiParseError('ISA segment delimiter byte is empty');
  }
  if (element === segment) {
    throw new EdiParseError(
      'ISA segment delimiters collide (element == segment)',
    );
  }
  return { element, subelement, segment };
}

/**
 * Tokenize the entire interchange into segments. Empty trailing elements
 * inside a segment are preserved (X12 is positional — `REF**foo` means
 * REF01 is empty and REF02 = 'foo').
 */
export function parseX12(input: Buffer | string): {
  delimiters: X12Delimiters;
  segments: X12Segment[];
} {
  const text =
    typeof input === 'string' ? input : input.toString('utf8');
  const delimiters = detectDelimiters(text);

  // Slice off any pre-ISA garbage (rare but defensive).
  const isaStart = text.indexOf(ISA_PREFIX);
  const body = text.slice(isaStart);

  const rawSegments = body.split(delimiters.segment);
  const segments: X12Segment[] = [];

  for (const raw of rawSegments) {
    // Strip whitespace introduced by line-wrapped EDI ("segment terminator
    // + CRLF" is common). We don't touch internal whitespace because element
    // values may legitimately contain spaces.
    const trimmed = raw.replace(/^[\s\r\n\t]+/, '').replace(/[\r\n\t]+$/, '');
    if (trimmed.length === 0) continue;

    const parts = trimmed.split(delimiters.element);
    const tag = (parts[0] ?? '').trim().toUpperCase();
    if (tag.length === 0) continue;
    segments.push({ tag, elements: parts.slice(1) });
  }

  if (segments.length === 0) {
    throw new EdiParseError('Interchange has zero segments');
  }
  if (segments[0]?.tag !== 'ISA') {
    throw new EdiParseError(
      `First segment must be ISA, got ${segments[0]?.tag ?? '(none)'}`,
    );
  }

  return { delimiters, segments };
}

/** Look up the first segment with `tag` — useful for envelope segments. */
export function findSegment(
  segments: ReadonlyArray<X12Segment>,
  tag: string,
): X12Segment | null {
  const upper = tag.toUpperCase();
  for (const s of segments) {
    if (s.tag === upper) return s;
  }
  return null;
}

/** Filter all segments matching `tag`. */
export function findAllSegments(
  segments: ReadonlyArray<X12Segment>,
  tag: string,
): X12Segment[] {
  const upper = tag.toUpperCase();
  return segments.filter((s) => s.tag === upper);
}

/**
 * Split the interchange into transaction-set windows (ST…SE). An interchange
 * may contain multiple transaction sets; each maps to one logical bill.
 */
export function partitionTransactionSets(
  segments: ReadonlyArray<X12Segment>,
): X12Segment[][] {
  const sets: X12Segment[][] = [];
  let current: X12Segment[] | null = null;
  for (const seg of segments) {
    if (seg.tag === 'ST') {
      current = [seg];
    } else if (seg.tag === 'SE' && current) {
      current.push(seg);
      sets.push(current);
      current = null;
    } else if (current) {
      current.push(seg);
    }
  }
  return sets;
}
