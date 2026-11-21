// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader), written from
// scratch to return exactly its answer for every input, {columns, rows, errors}.
// The reference reads one character at a time and builds every field up a
// character at a time. This one reads in bulk instead: it jumps from delimiter
// to delimiter with indexOf, and slices whole fields out of the text, so the
// work is one short scan per field instead of one step per character. Nothing
// is cached from one call to the next; every call reads its input fresh.
//
// The policy it follows, exactly as the reference states it:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended to it as it stands (quote_junk, when the field ends); a quote that
//     never closes is read as a literal character and the text after it is read
//     again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings,
//     never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside a quoted field counted), row its record's
//     index in rows (null for the header), in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record ends.

/** How a field ended: 0 at a comma (the record goes on), 1 at a line break or 2 at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The next ',' / LF / CR at or after pos, cached so a character that does not
  // occur again is not searched for from scratch at every field: each cached
  // index is recomputed with indexOf only once the scan has passed it, so the
  // searches over the whole text add up to one pass. -1 means "not searched yet".
  let nc = -1;
  let nl = -1;
  let nr = -1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Joins a field's kept pieces: `head` is the string the field started with
  // ('' for a plain field, the opening quote for an unterminated re-read, the
  // quoted value for quote junk), `parts` the slices gathered after it, or null
  // when nothing was gathered and the head alone is the field.
  function joinField(head, parts) {
    if (parts === null) return head;
    return head + parts.join('');
  }

  // Reads unquoted characters from pos up to the next comma or line break: a CR
  // not followed by LF is dropped (stray_cr). Returns {value, ended, added};
  // `added` counts the characters kept, which the quote-junk path needs.
  function readUnquoted(head) {
    let parts = null;
    let segStart = pos;
    let added = 0;
    for (;;) {
      if (nc < pos) nc = text.indexOf(',', pos);
      if (nl < pos) nl = text.indexOf('\n', pos);
      if (nr < pos) nr = text.indexOf('\r', pos);
      // The nearest delimiter of the three (-1 counts as past the end).
      let idx = -1;
      let kind = -1;
      if (nc !== -1 && (idx === -1 || nc < idx)) { idx = nc; kind = COMMA; }
      if (nl !== -1 && (idx === -1 || nl < idx)) { idx = nl; kind = LINE_BREAK; }
      if (nr !== -1 && (idx === -1 || nr < idx)) { idx = nr; kind = 2; }
      if (idx === -1) {
        if (segStart < n) {
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, n));
          added += n - segStart;
        }
        pos = n;
        return { value: joinField(head, parts), ended: END, added };
      }
      if (kind === COMMA) {
        if (segStart < idx) {
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, idx));
          added += idx - segStart;
        }
        pos = idx + 1;
        nc = -1;
        return { value: joinField(head, parts), ended: COMMA, added };
      }
      if (kind === LINE_BREAK) {
        if (segStart < idx) {
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, idx));
          added += idx - segStart;
        }
        pos = idx + 1;
        line += 1;
        nl = -1;
        return { value: joinField(head, parts), ended: LINE_BREAK, added };
      }
      // A CR: CRLF ends the record, a lone CR is dropped with a stray_cr error.
      if (text.charCodeAt(idx + 1) === 10) {
        if (segStart < idx) {
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, idx));
          added += idx - segStart;
        }
        pos = idx + 2;
        line += 1;
        nr = -1;
        return { value: joinField(head, parts), ended: LINE_BREAK, added };
      }
      error('stray_cr');
      if (segStart < idx) {
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, idx));
        added += idx - segStart;
      }
      pos = idx + 1;
      segStart = pos;
      nr = -1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Scan for the closing quote, skipping "" escapes. The value's pieces are
    // gathered only when an escape is met; the common case (no escapes) keeps
    // the raw slice between the quotes untouched.
    let parts = null;
    let segStart = open + 1;
    let scan = open + 1;
    let close = -1;
    for (;;) {
      const q = text.indexOf('"', scan);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, q));
        parts.push('"');
        scan = q + 2;
        segStart = q + 2;
        continue;
      }
      close = q;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text after it
      // is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    const tail = text.slice(segStart, close);
    let value;
    if (parts === null) {
      value = tail;
    } else {
      parts.push(tail);
      value = parts.join('');
    }
    // Inside the quotes every CRLF or lone CR is one LF. Count the line breaks
    // in the raw quoted text (escapes hold no line breaks) and convert the CRs.
    const raw = text.slice(open + 1, close);
    if (raw.indexOf('\r') !== -1 || raw.indexOf('\n') !== -1) {
      const breaks = raw.match(/\r\n|\r|\n/g);
      if (breaks !== null) line += breaks.length;
      if (raw.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
    }
    pos = close + 1;
    if (pos >= n) return { value, ended: END, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA, added: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
