// Classic-Fast: a faithful, faster drop-in for csv-reader 1.0.0.
//
// Same answer for every input {text, header}: {columns, rows, errors}.
// One tight loop over the text with charCodeAt and numeric codes (44 comma,
// 34 quote, 10 LF, 13 CR). Fields are taken out with slice(), never built
// character by character. No closures, no per-field helper calls: the
// unquoted scan is a single inline block shared by plain fields, quote junk
// and unterminated-quote re-reads. Quoted fields find their closing quote
// with indexOf; doubled quotes and CR/LF inside quotes are the cold path.
//
// Semantics (csv-reader 1.0.0): a U+FEFF at the very start is dropped. A
// record ends at LF or CRLF; a line with no characters is no record.
// Outside quotes a CR not followed by LF is dropped (stray_cr). A field
// opening with a quote runs to the next non-doubled quote, "" inside is one
// quote, CRLF or a lone CR inside reads as LF; junk after the closing
// quote up to the next comma or line break is appended as-is (quote_junk
// when the field ends); a quote that never closes is a literal and the
// text after it is re-read as unquoted (unterminated_quote). A quote inside
// an unquoted field is literal. Fields stay strings. columns is the first
// record when header is true, else null; rows are the rest, each padded
// (short_row, fields: count before padding) or cut (long_row, extra: the
// cut fields) to the first record's width. Errors are {code, line, row} in
// the order met; line is the 1-based line the record starts on, row its
// index in rows (null for the header). A line holding only stray CRs yields
// no record, its stray_cr errors stay. Header true with no records at all
// gives columns [].

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  while (true) {
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
    let ended = 0; // 0 comma, 1 line break, 2 end of text
    let lastQuoted = false;

    do {
      let fieldValue;
      lastQuoted = pos < n && text.charCodeAt(pos) === 34;

      // The unquoted scan runs for plain fields, for junk after a closing
      // quote, and for the re-read after an unterminated quote. `init` is
      // the value it starts from; `junkCheck` asks for quote_junk when the
      // scan kept any character.
      let needUnquoted = false;
      let junkCheck = false;
      let init = '';

      if (lastQuoted) {
        const open = pos;
        const openLine = line;
        let p = pos + 1;
        let segStart = p;
        let bounds = null; // flat [s0, e0, s1, e1, ...] of literal runs between doubled quotes
        let closed = -1;
        while (true) {
          const qi = text.indexOf('"', p);
          if (qi === -1) break;
          if (text.charCodeAt(qi + 1) === 34) {
            if (bounds === null) bounds = [];
            bounds.push(segStart, qi);
            p = qi + 2;
            segStart = p;
            continue;
          }
          closed = qi;
          break;
        }

        if (closed === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          init = '"';
          needUnquoted = true;
        } else {
          // Build the quoted content. The runs between doubled quotes hold
          // no quote by construction; a doubled quote is one quote. Line
          // breaks and CR mapping are counted once over the whole quoted
          // region [open + 1, closed): each CR or bare LF inside is one
          // more line, and CR / CRLF inside reads as LF.
          const a0 = open + 1;
          const b0 = closed;
          const ri = text.indexOf('\r', a0);
          const ni = text.indexOf('\n', a0);
          if ((ri !== -1 && ri < b0) || (ni !== -1 && ni < b0)) {
            let idx = a0;
            for (;;) {
              const r = text.indexOf('\r', idx);
              if (r === -1 || r >= b0) break;
              line += 1;
              idx = r + 1;
            }
            idx = a0;
            for (;;) {
              const w = text.indexOf('\n', idx);
              if (w === -1 || w >= b0) break;
              if (w === a0 || text.charCodeAt(w - 1) !== 13) line += 1;
              idx = w + 1;
            }
          }
          let content;
          if (bounds === null) {
            content = text.slice(segStart, closed);
          } else {
            bounds.push(segStart, closed);
            const parts = [];
            for (let bi = 0; bi < bounds.length; bi += 2) {
              if (bi > 0) parts.push('"');
              parts.push(text.slice(bounds[bi], bounds[bi + 1]));
            }
            content = parts.length === 1 ? parts[0] : parts.join('');
          }
          if (ri !== -1 && ri < b0) content = content.replace(/\r\n?/g, '\n');

          // What follows the closing quote decides how the field ends.
          pos = closed + 1;
          if (pos >= n) {
            fieldValue = content;
            ended = 2;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              fieldValue = content;
              ended = 0;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              fieldValue = content;
              ended = 1;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fieldValue = content;
              ended = 1;
            } else {
              // Junk after the closing quote, appended as it stands.
              init = content;
              needUnquoted = true;
              junkCheck = true;
            }
          }
        }
      } else {
        init = '';
        needUnquoted = true;
      }

      if (needUnquoted) {
        // Read unquoted characters from pos onto `init` up to the next
        // comma or line break. A CR not followed by LF is dropped
        // (stray_cr) and the scan goes on; the dropped CRs are the only
        // reason the value ever needs more than one slice.
        let parts = null;
        let seg = pos;
        let i = pos;
        let endKind = 2;
        while (true) {
          while (i < n) {
            const c = text.charCodeAt(i);
            if (c === 44 || c === 10 || c === 13) break;
            i += 1;
          }
          if (i >= n) {
            endKind = 2;
            break;
          }
          const c = text.charCodeAt(i);
          if (c === 44) {
            endKind = 0;
            break;
          }
          if (c === 10) {
            endKind = 1;
            break;
          }
          if (text.charCodeAt(i + 1) === 10) {
            endKind = 1;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          if (parts === null) {
            parts = [];
            if (init !== '') parts.push(init);
          }
          parts.push(text.slice(seg, i));
          i += 1;
          seg = i;
        }
        if (parts === null) {
          fieldValue = init === '' ? text.slice(seg, i) : init + text.slice(seg, i);
        } else {
          parts.push(text.slice(seg, i));
          fieldValue = parts.join('');
        }
        if (endKind === 0) {
          pos = i + 1;
          ended = 0;
        } else if (endKind === 1) {
          pos = text.charCodeAt(i) === 13 ? i + 2 : i + 1;
          line += 1;
          ended = 1;
        } else {
          pos = n;
          ended = 2;
        }
        if (junkCheck && fieldValue.length > init.length) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }

      fields.push(fieldValue);
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

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

  return { columns: header ? (columns === null ? [] : columns) : null, rows, errors };
}
