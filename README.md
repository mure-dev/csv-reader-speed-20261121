# csv-reader-speed-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/mure-dev/csv-reader-speed-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/mure-dev/csv-reader-speed-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0: `solve.js` returns exactly
csv-reader's `{columns, rows, errors}` answer for every input, but reads the text
in bulk instead of one character at a time.

## How it is faster

The reference walks the text character by character and builds every field up
a character at a time. This parser jumps from delimiter to delimiter with
`indexOf` and slices whole fields out of the text, so the work is one short scan
per field instead of one step per character. The next `,`, LF and CR positions
are cached and recomputed only once the scan passes them, so searching for a
character that does not occur again never rescans the rest of the text.

Measured on the kit's practice set (6 cases, ~10.2 MB of CSV): the pure parser
runs in ~175 ms against the reference's ~461 ms, and the whole driver run in
~0.68 s against ~1.39 s — about 2.6x faster at parsing, 2x end to end.

## Files

- `solve.js` — the entry: a dependency-free ES module exporting `run(input)`.
- `main.ts` — the house driver, kept as the kit ships it: it reads every case
  from `/input/cases.json`, answers each with `run`, and writes
  `/output/answers.json`. It turns V8's incremental marking off before importing
  `solve.js`, as the house baseline runs.

## Correctness

Verified against the reference on all 6 practice cases (byte-identical answers,
matching `practice/reference/expected.json`) and on a differential fuzzer of
20,112 hand-picked and random tricky inputs (quotes, doubled quotes, junk after
closing quotes, unterminated quotes, lone CRs, CRLF, BOM, empty lines, short
and long rows) — zero mismatches.
