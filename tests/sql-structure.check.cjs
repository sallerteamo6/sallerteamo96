// Structural check for the SQL migrations: dollar-quote pairing, transaction
// boundaries, and the guards a cron migration must keep.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'supabase', 'v2');

let bad = 0;

// RAISE takes one argument per % in its format string and refuses to compile with
// "too many parameters specified for RAISE" if handed an extra one. That is a
// compile-time fault, so it takes the whole migration down in the SQL editor
// before a single statement runs - which is what happened to migration 22.
//
// This walks the file as a stream rather than line by line, because a RAISE
// statement routinely spans several lines and almost always ends in
// `using errcode = '...',` which is not a format argument.
const RAISE_LEVELS = ['notice', 'warning', 'exception', 'log', 'debug', 'info', 'plain'];

function raiseArity(body) {
  const out = [];
  const n = body.length;
  let i = 0;
  const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;

  // Skips a single-quoted literal starting at `from`, honouring '' as an escaped
  // quote. Returns the decoded contents and the index just past the closing quote.
  function readString(from) {
    let j = from + 1, outp = '';
    while (j < n) {
      if (body[j] === "'") {
        if (body[j + 1] === "'") { outp += "'"; j += 2; continue; }
        return [outp, j + 1];
      }
      outp += body[j++];
    }
    return [outp, n];
  }

  while (i < n) {
    if (body[i] === "'") { i = readString(i)[1]; continue; }
    if (!/[A-Za-z_]/.test(body[i])) { i++; continue; }
    WORD.lastIndex = i;
    const w = WORD.exec(body);
    const word = w[0];
    const end = WORD.lastIndex;
    if (word.toLowerCase() !== 'raise') { i = end; continue; }
    if (end < n && /[A-Za-z0-9_]/.test(body[end])) { i = end; continue; }

    // Level word, then the format string.
    let k = end;
    while (k < n && /\s/.test(body[k])) k++;
    WORD.lastIndex = k;
    const lv = WORD.exec(body);
    if (!lv || RAISE_LEVELS.indexOf(lv[0].toLowerCase()) === -1) { i = end; continue; }
    k = lv.lastIndex;
    while (k < n && /\s/.test(body[k])) k++;
    if (body[k] !== "'") { i = end; continue; }

    const [fmt, after] = readString(k);
    const want = (fmt.replace(/%%/g, '').match(/%/g) || []).length;

    // Collect top-level arguments up to the terminating semicolon, stopping at a
    // USING clause, which is options rather than format arguments.
    //
    // The count is simply the number of top-level commas: the format string sits
    // in argument position 0, so the comma that follows it introduces the first
    // argument rather than separating two of them. 'a %', x has one comma and one
    // argument; 'a %, b %', x, y has two of each.
    let depth = 0, args = 0;
    let j = after;
    for (; j < n; j++) {
      const c = body[j];
      if (c === "'") { j = readString(j)[1] - 1; continue; }
      if (c === '(' || c === '[') { depth++; continue; }
      if (c === ')' || c === ']') { depth--; continue; }
      if (depth === 0 && c === ';') break;
      if (depth === 0 && c === ',') { args++; continue; }
      if (depth === 0 && /[A-Za-z_]/.test(c)) {
        WORD.lastIndex = j;
        const kw = WORD.exec(body);
        if (kw && kw[0].toLowerCase() === 'using') break;
        j = WORD.lastIndex - 1;
      }
    }

    if (args !== want) {
      const line = body.slice(0, k).split('\n').length;
      out.push('line ' + line + ': RAISE has ' + want + ' placeholder(s) but ' + args + ' argument(s)');
    }
    i = j;
  }
  return out;
}
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  // Strip line comments only; block comments are not used for code in these files.
  const body = raw.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  const tags = [...body.matchAll(/\$[A-Za-z_]*\$/g)].map(m => m[0]);
  const plain = tags.filter(t => t === '$$').length;
  const named = tags.filter(t => t !== '$$');
  const problems = [];
  if (plain % 2 !== 0) problems.push('unpaired $$ (' + plain + ')');
  for (const n of named) {
    const c = tags.filter(t => t === n).length;
    if (c % 2 !== 0) problems.push('unpaired ' + n);
  }
  if (body.includes('\uFFFD')) problems.push('contains U+FFFD');
  for (const p of raiseArity(body)) problems.push(p);
  if (problems.length) { bad++; console.log('  FAIL ' + f + ': ' + problems.join(', ')); }
}
console.log(bad ? '  ' + bad + ' file(s) with structural problems' : '  all ' + fs.readdirSync(dir).filter(n => n.endsWith('.sql')).length + ' migrations structurally sound');

const sql22 = fs.readFileSync(path.join(dir, '22_ai_settlement_cron.sql'), 'utf8');
const code = sql22.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
const checks = [
  ['guards on the function existing', /to_regprocedure\('public\.settle_due_investments\(\)'\)/],
  ['guards on the extension existing', /pg_extension where extname = 'pg_cron'/],
  ['removes a previous job before scheduling', /cron\.unschedule\(j\.jobid\)/],
  ['names the job so a re-run cannot double it', /cron\.schedule\(v_jobname/],
  ['every path is wrapped so the migration cannot abort', /when others then/],
  ['opens and commits a transaction', /begin\s*;[\s\S]*commit\s*;/i]
];
console.log('');
for (const [label, re] of checks) {
  const ok = re.test(code);
  if (!ok) bad++;
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + label);
}
// Checked against the raw file, because this one is documentation and lives in a
// comment. It matters: the next person to see a cron job here will assume it
// settles trades too, and trades need a price Postgres cannot fetch.
const documented = /Trades are deliberately NOT scheduled/.test(sql22);
if (!documented) bad++;
console.log('  ' + (documented ? 'PASS ' : 'FAIL ') + 'documents that trades are excluded on purpose');
console.log(bad ? '\nFAIL: ' + bad + ' problem(s)' : '\nPASS: migration 22 is structurally sound and keeps its guards');
process.exit(bad ? 1 : 0);
