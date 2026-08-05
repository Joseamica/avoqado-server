/**
 * Guard: every PAGINATED `findMany` must sort on a TOTAL key (Asana 1217127206664238)
 *
 * The per-service tests prove specific lists page correctly. This one prevents the whole
 * CLASS of bug from coming back anywhere in `src/`, including in code nobody has written
 * yet — which matters, because the defect is invisible in review (`orderBy: { createdAt:
 * 'desc' }` next to `skip`/`take` looks completely ordinary) and invisible at runtime
 * (no error, no log, just a row that quietly stops appearing).
 *
 * The rule: if a `findMany` paginates — `skip`/`take` OR a `cursor` — its `orderBy` must
 * end in a UNIQUE column. In practice that means appending `id`:
 *
 *     orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
 *
 * Why a single non-unique key is not enough: Postgres makes NO promise about the relative
 * order of rows that tie on every sort key, and it may legitimately order them differently
 * from one query to the next. Pagination issues one query PER PAGE, so a tie group that
 * straddles a page boundary can serve a row twice on one page and never on the next. The
 * row is still in the database and still correct — it just silently stops being listed.
 *
 * Measured against prod: `TpvCommandHistory` (`executedAt` NULL on all 299 rows, so the
 * whole table is one tie group) lost 6 of 299 rows to a plain paged sweep; `ActivityLog`
 * carries tie groups of up to 71 across 15,508 rows; `Order` 619 tied rows; and the
 * original report was 4 SIM sales missing from an org sales export.
 *
 * NOTE for whoever edits the scanner: only the orderBy at DEPTH 1 of the findMany argument
 * governs the page. A nested `orderBy` inside `include: { … }` orders a relation and is
 * irrelevant here — conflating the two produces confident false positives.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(__dirname, '..', '..', '..', 'src')

/** Blank out comments, preserving length and newlines so offsets stay valid. */
function stripComments(s: string): string {
  const out = s.split('')
  let i = 0
  while (i < s.length - 1) {
    if (s[i] === '/' && s[i + 1] === '/') {
      const j = s.indexOf('\n', i)
      const end = j < 0 ? s.length : j
      for (let k = i; k < end; k++) out[k] = ' '
      i = end
    } else if (s[i] === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i)
      const end = j < 0 ? s.length : j + 2
      for (let k = i; k < end; k++) if (s[k] !== '\n') out[k] = ' '
      i = end
    } else {
      i++
    }
  }
  return out.join('')
}

/** Index of the brace/bracket closing the one that opens at `open`. */
function matchClose(s: string, open: number): number {
  let depth = 0
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{' || s[j] === '[') depth++
    else if (s[j] === '}' || s[j] === ']') {
      depth--
      if (depth === 0) return j
    }
  }
  return -1
}

/** Keys at DEPTH 1 of an object-literal body, with the char index where each key starts. */
function topLevelKeys(body: string): Map<string, number> {
  const keys = new Map<string, number>()
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i))
      if (m && (i === 0 || !/[\w$.]/.test(body[i - 1]))) {
        if (!keys.has(m[1])) keys.set(m[1], i)
        i += m[0].length - 1
      }
    }
  }
  return keys
}

type Analysis = { paginated: false } | { paginated: true; mode: 'skip/take' | 'cursor'; orderBy: string | null; stable: boolean }

/**
 * Classify one `findMany({ … })` argument body.
 * `body` must start at the `{` and end at its matching `}`.
 */
function analyzeFindMany(body: string): Analysis {
  const keys = topLevelKeys(body)

  // Paginated? skip/take-style OR cursor-style. `take` ALONE is a plain "top N" — one
  // query, no page boundary for a tie group to straddle — so it is safe and not flagged.
  const hasCursor = keys.has('cursor') || /\bcursor\s*:/.test(body)
  if (!keys.has('skip') && !hasCursor) return { paginated: false }
  const mode = hasCursor ? 'cursor' : 'skip/take'

  const at = keys.get('orderBy')
  if (at === undefined) return { paginated: true, mode, orderBy: null, stable: true }

  const m = /orderBy:\s*/.exec(body.slice(at))
  const vStart = at + (m ? m[0].length : 0)
  const vEnd = matchClose(body, vStart)
  const flat = (vEnd < 0 ? body.slice(vStart, vStart + 160) : body.slice(vStart, vEnd + 1)).replace(/\s+/g, ' ').trim()

  // Stable iff the sort-key list ENDS on a unique column (`id`): either `[…, { id: … }]`
  // or a bare `{ id: … }`.
  const stable = /\{\s*id\s*:[^}]*\}\s*\]$/.test(flat) || /^\{\s*id\s*:[^}]*\}$/.test(flat)
  return { paginated: true, mode, orderBy: flat, stable }
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) tsFiles(p, acc)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(p)
  }
  return acc
}

interface Violation {
  file: string
  line: number
  orderBy: string
  mode: string
}

function findViolations(): { violations: Violation[]; paginatedCount: number } {
  const violations: Violation[] = []
  let paginatedCount = 0

  for (const file of tsFiles(SRC)) {
    const raw = readFileSync(file, 'utf8')
    if (!raw.includes('.findMany(')) continue
    const src = stripComments(raw)

    const re = /\.findMany\(\s*\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const open = src.indexOf('{', m.index)
      const close = matchClose(src, open)
      if (close < 0) continue

      const a = analyzeFindMany(src.slice(open, close + 1))
      if (!a.paginated) continue
      paginatedCount++
      if (a.stable || a.orderBy === null) continue

      const keyAt = topLevelKeys(src.slice(open, close + 1)).get('orderBy')!
      violations.push({
        file: relative(SRC, file).split('\\').join('/'),
        line: src.slice(0, open + keyAt).split('\n').length,
        orderBy: a.orderBy,
        mode: a.mode,
      })
    }
  }
  return { violations, paginatedCount }
}

describe('Paginated findMany must sort on a total key (Asana 1217127206664238)', () => {
  const { violations, paginatedCount } = findViolations()

  // ── THE RULE ──

  it('no paginated findMany sorts on a non-unique key alone', () => {
    if (violations.length > 0) {
      const detail = violations.map(v => `  src/${v.file}:${v.line}  [${v.mode}]  orderBy: ${v.orderBy}`).join('\n')
      throw new Error(
        `${violations.length} paginated findMany call(s) sort on a NON-UNIQUE key, so pages can ` +
          `silently drop rows (Asana 1217127206664238):\n\n${detail}\n\n` +
          `Fix each by appending the unique \`id\` as a tiebreak, LAST:\n` +
          `  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]\n` +
          `When the sort field is caller-supplied, \`id\` still goes last:\n` +
          `  orderBy: [{ [sortBy]: sortOrder }, { id: sortOrder }]\n`,
      )
    }

    expect(violations).toEqual([])
  })

  // ── GUARDS THE GUARD: a broken scanner would make the rule above vacuously green ──

  it('classifies paginated vs top-N, and stable vs unstable, correctly', () => {
    const bodyOf = (code: string) => {
      const open = code.indexOf('{', code.indexOf('findMany'))
      return code.slice(open, matchClose(code, open) + 1)
    }
    const verdict = (code: string) => {
      const a = analyzeFindMany(bodyOf(code))
      return !a.paginated ? 'not-paginated' : a.stable ? 'stable' : 'unstable'
    }

    // the defect
    expect(verdict(`p.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: 0, take: 20 })`)).toBe('unstable')
    // the fix
    expect(verdict(`p.payment.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: 0, take: 20 })`)).toBe('stable')
    // caller-supplied sort field, tiebreak last
    expect(verdict(`p.n.findMany({ orderBy: [{ [sortBy]: sortOrder }, { id: sortOrder }], skip: 0, take: 20 })`)).toBe('stable')
    // an array that still ends on a NON-unique key is NOT stable
    expect(verdict(`p.n.findMany({ orderBy: [{ a: 'desc' }, { b: 'asc' }], skip: 0, take: 20 })`)).toBe('unstable')
    // plain top-N: one query, nothing to straddle → must not be flagged
    expect(verdict(`p.payment.findMany({ where, orderBy: { createdAt: 'desc' }, take: 1 })`)).toBe('not-paginated')
    // cursor pagination counts as paginated
    expect(verdict(`p.c.findMany({ orderBy: { updatedAt: 'desc' }, take: 20, cursor: { id }, skip: 1 })`)).toBe('unstable')

    // A NESTED orderBy inside `include` must NOT be mistaken for the page's sort key.
    // This is the exact false positive that an earlier version of this scanner produced.
    expect(
      verdict(`p.o.findMany({
        where,
        include: { payments: { orderBy: { createdAt: 'desc' } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 20,
      })`),
    ).toBe('stable')
  })

  it('is actually scanning a realistic amount of code', () => {
    // If a refactor moved every list out of src/, or the regex stopped matching, the rule
    // above would go green for the wrong reason.
    expect(paginatedCount).toBeGreaterThan(25)
  })
})
