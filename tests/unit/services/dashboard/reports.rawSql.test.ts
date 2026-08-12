/**
 * The inventory reports query columns that ACTUALLY EXIST.
 *
 * Three reports with a live route — PMIX (sales mix), raw-material consumption and cost
 * variance — were building their SQL with snake_case column names (`o.venue_id`,
 * `rmm.raw_material_id`, `rm.cost_per_unit`) against tables whose columns are camelCase.
 * This schema does NOT map names: the only `@@map`s that exist belong to other tables
 * (time_entries, tpv_messages, training_*, mcp_*). PostgreSQL answered
 * `column ... does not exist` and all three blew up on EVERY call.
 *
 * Verified against the production database on 2026-08-07:
 *     ERROR: column o.venue_id does not exist
 *     HINT:  Perhaps you meant to reference the column "o.venueId".
 *
 * Nobody noticed because PMIX and cost variance sit behind the premium inventory gate and
 * hardly any venue opens them.
 *
 * Second defect in the same file: the conditional fragments (LIMIT, OFFSET, raw-material
 * filter) were interpolated as `${cond ? `LIMIT ${n}` : ''}` INSIDE a tagged template.
 * There, that does not concatenate SQL — it sends the text as a PARAMETER — so the query
 * ended up as `ORDER BY ... DESC $4 $5` (a syntax error) and the raw-material filter never
 * filtered anything.
 *
 * This test is static on purpose: the bug is only visible by reading the SQL, and a test
 * with a mocked prisma would have let it through exactly like before.
 */

import * as fs from 'fs'
import * as path from 'path'

const FILE = path.join(__dirname, '../../../../src/services/dashboard/report.service.ts')
const source = fs.readFileSync(FILE, 'utf8')

/** Comments out: they do mention the old names, on purpose. */
const codeOnly = source
  .split('\n')
  .filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
  .join('\n')

/**
 * ONLY the SQL inside the tagged templates. The SELECT aliases (`as product_id`) ARE
 * snake_case on purpose, because they type the returned row in TypeScript; what can never
 * go back to snake_case are the COLUMNS being queried.
 */
const sqlOnly = codeOnly
  .split('$queryRaw')
  .slice(1)
  .map(block => {
    const start = block.indexOf('`')
    return start === -1 ? '' : block.slice(start + 1, block.indexOf('`', start + 1))
  })
  .join('\n')

describe('raw SQL in the inventory reports', () => {
  it.each([
    ['venue', /\b\w+\.venue_id\b/],
    ['creation date', /\b\w+\.created_at\b/],
    ['product', /\b\w+\.product_id\b/],
    ['order', /\b\w+\.order_id\b/],
    ['unit price', /\b\w+\.unit_price\b/],
    ['recipe cost', /\br\.total_cost\b/],
    ['raw material unit cost', /\brm\.cost_per_unit\b/],
    ['raw material of the movement', /\brmm\.raw_material_id\b/],
  ])('🔴 no snake_case reference is left to the %s column', (_field, pattern) => {
    expect(sqlOnly).not.toMatch(pattern)
  })

  it('camelCase columns are double-quoted', () => {
    // Without quotes, PostgreSQL lowercases them and the exact same error comes back.
    for (const column of ['"venueId"', '"createdAt"', '"productId"', '"orderId"', '"unitPrice"', '"costPerUnit"', '"rawMaterialId"']) {
      expect(sqlOnly).toContain(column)
    }
  })

  it('🔴 the conditional fragments are composed with Prisma.sql / Prisma.empty', () => {
    // A backtick interpolation inside a tagged template does NOT concatenate SQL: it sends
    // the text as a parameter and blows up the syntax.
    expect(codeOnly).toContain('Prisma.sql`LIMIT')
    expect(codeOnly).toContain('Prisma.empty')
    expect(codeOnly).not.toMatch(/\?\s*`LIMIT \$\{/)
    expect(codeOnly).not.toMatch(/\?\s*`OFFSET \$\{/)
    expect(codeOnly).not.toMatch(/\?\s*`AND \w+\./)
  })

  it('the raw-material filter is real SQL again', () => {
    expect(codeOnly).toMatch(/Prisma\.sql`AND rmm\."rawMaterialId" = \$\{options\.rawMaterialId\}`/)
  })

  it('TENANT: every raw query filters by venue', () => {
    const queries = codeOnly.split('$queryRaw').slice(1)
    expect(queries.length).toBeGreaterThanOrEqual(4)
    for (const q of queries) {
      const body = q.slice(0, q.indexOf('`', q.indexOf('`') + 1) + 1)
      expect(body).toMatch(/"venueId" = \$\{venueId\}/)
    }
  })

  it('paginated listings order by something UNIQUE', () => {
    // A non-unique ORDER BY silently drops rows when paginating: it already happened to us
    // in 37 places.
    expect(codeOnly).toContain('ORDER BY total_revenue DESC, oi."productId" ASC')
    expect(codeOnly).toContain('ORDER BY total_cost DESC, rmm."rawMaterialId" ASC')
  })
})

describe('days of coverage', () => {
  it('counts spoilage as consumption', () => {
    // Spoilage is not "good" consumption, but it DOES empty the warehouse. Ignoring it
    // gives an optimistic coverage precisely on the products that spoil the most.
    expect(codeOnly).toMatch(/FILTER \(WHERE rmm\.type IN \('USAGE', 'SPOILAGE'\)\)/)
  })

  it('🔴 zero consumption returns null, not infinity', () => {
    // "It has not moved" and "it lasts me forever" are different things. An ∞ sorted in a
    // table pushes to the bottom exactly what needs to be reviewed.
    // The variable name is deliberately not pinned here: a rename must not silently turn
    // this guard into a no-op.
    expect(codeOnly).toMatch(/\w+\.greaterThan\(0\)\s*\?\s*[^:]+:\s*null/)
  })

  it('the window is rolling and does not depend on the server timezone', () => {
    // Production runs in UTC with no TZ configured; a window anchored to the calendar day
    // would shift by a whole day.
    expect(codeOnly).toMatch(/Date\.now\(\) - \w+ \* 24 \* 60 \* 60 \* 1000/)
  })
})
