/**
 * Is this raw SQL a plain read? — the classifier behind the MCP brake (incident 2026-09-23).
 *
 * The brake may only cut READS (`src/utils/requestCancellation.ts`). This repo also runs mutations through
 * `$queryRaw` (`UPDATE … RETURNING`, `INSERT … ON CONFLICT`) and takes advisory locks with it, so a raw query
 * counts as a read only when this module can PROVE it. It tokenizes the SQL — strings (incl. `E'…'` and `$tag$…$tag$`),
 * quoted identifiers, nested block comments — and accepts one SELECT/WITH statement with no write keyword, no row
 * lock and no function outside an allowlist of pure functions. Anything it does not recognize answers false: a
 * read taken for a write only loses the brake; a write taken for a read would break "a write is never interrupted".
 *
 * A regex classifier was tried first and Codex broke it three ways (a side-effect function written in quotes, a
 * `'--'` inside a string that hid the rest of the SQL, a custom function that writes). Keep it a tokenizer — and
 * keep its character classes EXACTLY those of PostgreSQL's lexer (`src/backend/parser/scan.l`): the third audit
 * broke it with a `\r` that ends a comment for Postgres and not for us, and with a keyword that Postgres accepts
 * as a function name.
 */

type TokenKind = 'word' | 'qident' | 'string' | 'param' | 'number' | 'punct'
interface Token {
  kind: TokenKind
  text: string
}

// scan.l: `space [ \t\n\r\f\v]`, `ident_start [A-Za-z\200-\377_]`, `ident_cont [A-Za-z\200-\377_0-9\$]`. Every byte
// >= 0x80 is an identifier character for Postgres, so in a JS string every code unit >= 0x80 is too: `€count` is
// ONE function name, not `€` + `count`.
const SPACE = /[ \t\n\r\f\v]/
const isHighChar = (c: string): boolean => c.charCodeAt(0) >= 0x80
const isWordStart = (c: string): boolean => /[A-Za-z_]/.test(c) || isHighChar(c)
const isWordPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || isHighChar(c)

/** The `$tag$` that opens a dollar-quoted string at `i`, or null. scan.l: `dolq_start [A-Za-z\200-\377_]`, `dolq_cont [A-Za-z\200-\377_0-9]`. */
function dollarTagAt(sql: string, i: number): string | null {
  let j = i + 1
  if (sql[j] !== '$') {
    if (j >= sql.length || !(/[A-Za-z_]/.test(sql[j]) || isHighChar(sql[j]))) return null
    j++
    while (j < sql.length && (/[A-Za-z0-9_]/.test(sql[j]) || isHighChar(sql[j]))) j++
  }
  return sql[j] === '$' ? sql.slice(i, j + 1) : null
}

/** Reads the SQL into tokens. Null when a string, quoted identifier or comment never closes. */
function tokenize(sql: string): Token[] | null {
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  // Two string literals in a row: Postgres either CONTINUES the first one — keeping its escape mode, so `E''` followed by
  // `'\' -- '` on the next line hides what comes after (scan.l, states xqs/xe; Codex, round 4) — or rejects the SQL.
  // Neither is a provable read, so the whole statement is not one.
  const pushString = (text: string): boolean => {
    if (tokens[tokens.length - 1]?.kind === 'string') return false
    tokens.push({ kind: 'string', text })
    return true
  }
  const readQuoted = (quote: string, backslashEscapes: boolean): number => {
    let j = i + 1
    while (j < n) {
      const c = sql[j]
      if (backslashEscapes && c === '\\') {
        j += 2
        continue
      }
      if (c === quote) {
        if (sql[j + 1] === quote) {
          j += 2
          continue
        }
        return j + 1
      }
      j++
    }
    return -1
  }

  while (i < n) {
    const c = sql[i]
    if (SPACE.test(c)) {
      i++
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      // scan.l: `comment ("--"{non_newline}*)` with `non_newline [^\n\r]` — a \r ends it too.
      let j = i + 2
      while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j++
      i = j
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      if (depth > 0) return null
      continue
    }
    if (c === "'") {
      const end = readQuoted("'", false)
      if (end === -1) return null
      if (!pushString(sql.slice(i, end))) return null
      i = end
      continue
    }
    if (c === '"') {
      const end = readQuoted('"', false)
      if (end === -1) return null
      tokens.push({ kind: 'qident', text: sql.slice(i + 1, end - 1).replace(/""/g, '"') })
      i = end
      continue
    }
    if (c === '$') {
      if (/[0-9]/.test(sql[i + 1] ?? '')) {
        let j = i + 1
        while (j < n && /[0-9]/.test(sql[j])) j++
        tokens.push({ kind: 'param', text: sql.slice(i, j) })
        i = j
        continue
      }
      const tag = dollarTagAt(sql, i)
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        if (close === -1) return null
        if (!pushString(sql.slice(i, close + tag.length))) return null
        i = close + tag.length
        continue
      }
      tokens.push({ kind: 'punct', text: '$' })
      i++
      continue
    }
    if (isWordStart(c)) {
      let j = i + 1
      while (j < n && isWordPart(sql[j])) j++
      const word = sql.slice(i, j)
      // E'…' is an escape string: a backslash escapes the next character, so `E'it\'s'` stays one string.
      if ((word === 'E' || word === 'e') && sql[j] === "'") {
        i = j
        const end = readQuoted("'", true)
        if (end === -1) return null
        if (!pushString(sql.slice(j, end))) return null
        i = end
        continue
      }
      // Unicode escapes (scan.l `xuistart [uU]&{dquote}`, `xusstart [uU]&{quote}`): `U&"…"` names an identifier only
      // once its escapes are decoded — with a custom escape character when UESCAPE follows — and PostgreSQL's lexical
      // filter (parser.c) merges `U&"pg_advisory_lock" UESCAPE '!'` into ONE identifier, whose "(" then sits two tokens
      // away (Codex, round 5). None of the repo's raw reads uses them: not provable, so not a read.
      if ((word === 'U' || word === 'u') && sql[j] === '&' && (sql[j + 1] === '"' || sql[j + 1] === "'")) return null
      // Postgres (UTF-8) folds only A-Z (scansup.c, downcase_identifier): a Kelvin sign `K` stays, so `ranK` is not `rank`.
      const folded = word.replace(/[A-Z]+/g, upper => upper.toLowerCase())
      if (folded === 'uescape') return null
      tokens.push({ kind: 'word', text: folded })
      i = j
      continue
    }
    if (/[0-9.]/.test(c) && /[0-9]/.test(c === '.' ? (sql[i + 1] ?? '') : c)) {
      let j = i + 1
      while (j < n && /[0-9.eE]/.test(sql[j])) j++
      tokens.push({ kind: 'number', text: sql.slice(i, j) })
      i = j
      continue
    }
    if (c === ':' && sql[i + 1] === ':') {
      tokens.push({ kind: 'punct', text: '::' })
      i += 2
      continue
    }
    tokens.push({ kind: 'punct', text: c })
    i++
  }
  return tokens
}

/** A set from a whitespace-separated list (keeps the long lists readable). */
const words = (list: string): ReadonlySet<string> => new Set(list.trim().split(/\s+/))

/** Words that make a statement a write (or a lock), wherever they appear unquoted. */
const WRITE_WORDS: ReadonlySet<string> = words(
  'insert update delete merge truncate alter create drop grant revoke copy call do execute lock ' +
    'refresh vacuum analyze reindex cluster notify listen unlisten into set reset discard prepare ' +
    'deallocate',
)

/**
 * Keywords that may precede "(" and that Postgres can NEVER use as a function name: the RESERVED and COL_NAME
 * categories of `src/include/parser/kwlist.h` (PG 16). A word here followed by "(" is grammar, never a call.
 */
const NEVER_A_FUNCTION: ReadonlySet<string> = words(
  'as in any all some from where and or not on using select when then else case lateral with union ' +
    'intersect except having distinct limit offset group order array cast exists values between row',
)

/**
 * Keywords followed by "(" that Postgres ALSO accepts as function names (UNRESERVED or TYPE_FUNC_NAME in
 * kwlist.h): grammar only in the one position the grammar uses them — Codex, round 3: `filter()` and
 * `public.filter()` name user functions. Only positions that are closed-world are accepted: the token right before
 * decides, with no list of "where an expression may start" to keep complete. So `JOIN (subquery)` is NOT accepted —
 * Codex, round 4: `AT TIME ZONE join()` got through such a list — and neither are ROLLUP, CUBE, GROUPING SETS,
 * LIKE or IS before "(" (MATERIALIZED only inside a walked WITH list, `withListGrammar`). Measured on 2026-09-23: none of the repo's raw reads uses any of them, so this
 * costs the brake nothing today; a future query that does only loses the brake.
 */
function keywordConstruct(word: string, prev: Token | undefined): boolean {
  switch (word) {
    case 'over': // fn(…) OVER (…)
    case 'filter': // agg(…) FILTER (WHERE …)
      return isPunct(prev, ')')
    case 'by': // ORDER BY (…), GROUP BY (…), PARTITION BY (…)
      return prev?.kind === 'word' && (prev.text === 'order' || prev.text === 'group' || prev.text === 'partition')
    default:
      return false
  }
}

/**
 * Functions with no side effects. Built from the functions this repo's raw SQL actually uses (2026-09-23 scan of
 * 135 files) plus the standard families around them. A function missing here only costs the brake for that query;
 * adding a function that writes, locks or talks to the outside (`pg_advisory*`, `nextval`, `set_config`, `lo_*`,
 * `dblink*`, `pg_notify`…) would break the brake's safety rule. Never add one of those.
 */
const PURE_FUNCTIONS: ReadonlySet<string> = words(
  // aggregates
  'count sum avg min max array_agg string_agg bool_and bool_or every json_agg jsonb_agg ' +
    'json_object_agg jsonb_object_agg percentile_cont percentile_disc mode stddev stddev_pop ' +
    'stddev_samp variance var_pop var_samp corr covar_pop covar_samp grouping ' +
    // window
    'row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value ' +
    'nth_value ' +
    // conditional
    'coalesce nullif greatest least ' +
    // text
    'lower upper initcap trim ltrim rtrim btrim length char_length character_length octet_length ' +
    'bit_length substring substr left right concat concat_ws replace regexp_replace regexp_match ' +
    'regexp_matches regexp_split_to_array regexp_split_to_table split_part position strpos lpad rpad ' +
    'repeat reverse translate starts_with format overlay quote_ident quote_literal quote_nullable ' +
    'to_hex chr ascii unaccent similarity word_similarity strict_word_similarity ' +
    // numbers
    'abs round floor ceil ceiling trunc mod power pow sqrt cbrt sign div exp ln log log10 ' +
    'width_bucket random pi degrees radians ' +
    // dates
    'now clock_timestamp statement_timestamp transaction_timestamp date date_trunc date_part extract ' +
    'age timezone make_date make_time make_timestamp make_timestamptz make_interval date_bin ' +
    'justify_days justify_hours justify_interval to_char to_number to_date to_timestamp isfinite ' +
    'generate_series ' +
    // json
    'to_json to_jsonb json_build_object jsonb_build_object json_build_array jsonb_build_array ' +
    'json_object jsonb_object jsonb_array_elements jsonb_array_elements_text json_array_elements ' +
    'json_array_elements_text jsonb_array_length json_array_length jsonb_typeof json_typeof ' +
    'jsonb_extract_path jsonb_extract_path_text json_extract_path json_extract_path_text jsonb_each ' +
    'jsonb_each_text json_each json_each_text jsonb_object_keys json_object_keys jsonb_strip_nulls ' +
    'json_strip_nulls jsonb_set jsonb_insert jsonb_pretty row_to_json array_to_json jsonb_path_query ' +
    'jsonb_path_query_first jsonb_path_exists jsonb_to_record jsonb_to_recordset json_to_record ' +
    'json_to_recordset jsonb_populate_record jsonb_populate_recordset ' +
    // arrays
    'array_length array_position array_positions array_remove array_append array_prepend array_cat ' +
    'array_to_string string_to_array cardinality array_upper array_lower unnest ' +
    // hashing and encoding
    'md5 sha224 sha256 sha384 sha512 encode decode convert_to convert_from hashtext hashtextextended ' +
    // text search
    'to_tsvector to_tsquery plainto_tsquery websearch_to_tsquery ts_rank',
)

const isPunct = (t: Token | undefined, text: string): boolean => t?.kind === 'punct' && t.text === text
const isWord = (t: Token | undefined, text: string): boolean => t?.kind === 'word' && t.text === text
const isName = (t: Token | undefined): boolean => t?.kind === 'word' || t?.kind === 'qident'

/** Index of the ")" matching the "(" at `open`, or -1. */
function matchingParen(tokens: Token[], open: number): number {
  let depth = 0
  for (let k = open; k < tokens.length; k++) {
    if (isPunct(tokens[k], '(')) depth++
    else if (isPunct(tokens[k], ')') && --depth === 0) return k
  }
  return -1
}

/** Whether tokens[from..to) is a non-empty list of names separated by commas — a CTE's column list. */
function isNameList(tokens: Token[], from: number, to: number): boolean {
  if (from >= to) return false
  for (let k = from; k < to; k++) {
    if ((k - from) % 2 === 0 ? !isName(tokens[k]) : !isPunct(tokens[k], ',')) return false
  }
  return (to - from) % 2 === 1
}

/**
 * The tokens of a WITH list that are grammar and not a function call, found by walking the list itself (Codex, round
 * 6): each CTE's name when a column list follows — `name (a, b) AS …` — and the MATERIALIZED of `AS [NOT] MATERIALIZED
 * (`. A WITH list only opens a statement: at the very start or right after "(" (`WITH ORDINALITY`, `WITH TIME ZONE` and
 * `WITH TIES` follow something else). A rule that only looked at the tokens around `, f(…) AS` also accepted
 * `SELECT 0, pg_try_advisory_lock(1) AS materialized` and `ROWS FROM (…, f() AS (r integer))`.
 */
function withListGrammar(tokens: Token[]): ReadonlySet<number> {
  const grammar = new Set<number>()
  for (let k = 0; k < tokens.length; k++) {
    if (!isWord(tokens[k], 'with') || (k > 0 && !isPunct(tokens[k - 1], '('))) continue
    let name = isWord(tokens[k + 1], 'recursive') ? k + 2 : k + 1
    while (isName(tokens[name])) {
      const found: number[] = []
      let j = name + 1
      if (isPunct(tokens[j], '(')) {
        const close = matchingParen(tokens, j)
        if (close === -1 || !isNameList(tokens, j + 1, close)) break
        found.push(name)
        j = close + 1
      }
      if (!isWord(tokens[j], 'as')) break
      j++
      if (isWord(tokens[j], 'not')) {
        if (!isWord(tokens[j + 1], 'materialized')) break
        j++
      }
      if (isWord(tokens[j], 'materialized')) found.push(j++)
      if (!isPunct(tokens[j], '(')) break
      const bodyClose = matchingParen(tokens, j)
      if (bodyClose === -1) break
      for (const f of found) grammar.add(f)
      if (!isPunct(tokens[bodyClose + 1], ',')) break
      name = bodyClose + 2
    }
  }
  return grammar
}

/**
 * True only for SQL that is provably a plain read (see the module comment). When in doubt it answers false.
 */
export function isReadOnlySql(sql: string): boolean {
  const all = tokenize(sql)
  if (!all || all.length === 0) return false

  // One statement only: a ";" may appear only at the very end.
  const semicolon = all.findIndex(t => isPunct(t, ';'))
  if (semicolon !== -1 && semicolon !== all.length - 1) return false
  const tokens = semicolon === -1 ? all : all.slice(0, semicolon)

  const first = tokens.find(t => !isPunct(t, '('))
  if (first?.kind !== 'word' || (first.text !== 'select' && first.text !== 'with')) return false
  const cteGrammar = withListGrammar(tokens)

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    const next = tokens[k + 1]
    if (t.kind === 'word') {
      if (WRITE_WORDS.has(t.text)) return false
      // Row locks: FOR SHARE / FOR KEY SHARE / FOR NO KEY UPDATE (FOR UPDATE already hit "update").
      if (t.text === 'for' && next?.kind === 'word' && (next.text === 'share' || next.text === 'key' || next.text === 'no')) {
        return false
      }
    }
    if ((t.kind !== 'word' && t.kind !== 'qident') || !isPunct(next, '(')) continue

    // An identifier followed by "(": a function call unless the grammar says otherwise.
    const prev = tokens[k - 1]
    // A qualified name is never a keyword: `public.filter(` calls a function named filter. Checked FIRST.
    if (isPunct(prev, '.')) {
      const schema = tokens[k - 2]
      if (schema?.kind === 'word' && schema.text === 'pg_catalog' && PURE_FUNCTIONS.has(t.text)) continue
      return false
    }
    if (t.kind === 'word' && (NEVER_A_FUNCTION.has(t.text) || keywordConstruct(t.text, prev))) continue
    if (isPunct(prev, '::')) continue // type modifier: ::numeric(10,2)
    if (prev?.kind === 'word' && prev.text === 'as') continue // alias with a column list: AS e(value)
    if (cteGrammar.has(k)) continue // a CTE's column list, or AS [NOT] MATERIALIZED (…)
    if (!PURE_FUNCTIONS.has(t.text)) return false
  }
  return true
}
