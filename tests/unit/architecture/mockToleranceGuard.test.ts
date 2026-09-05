/**
 * Static guard: production code never tolerates a mis-assembled test double.
 *
 * A `typeof tx.<model>.<op> === 'function' ? … : <default>` — or the `!== 'function') return <default>`
 * form — inside `src/` is test code living in production code. `Prisma.TransactionClient` always
 * exposes every delegate and `$queryRaw`, so the negative branch can never run in production; its only
 * effect is that a unit test with an incomplete double silently takes a business default and the suite
 * stays green for the wrong reason.
 *
 * Two real cases, both on money rails (2026-09-04/05):
 *   - `lockExistingOrderForPayment` returned `false` ("the order is not this venue's") for a double
 *     without `$queryRaw`; 13 `fastPayment*` tests then failed three layers away from the cause.
 *   - Four rails computed `priorCompletedPaymentCount` as `typeof tx.payment.count === 'function' ? … : 0`;
 *     a double without `count` made every payment look like the first one on its order, inflating the
 *     shift's `totalOrders` in the tested scenario. Now `countPriorCompletedPayments` owns the rule.
 *
 * The accepted form is the guard that THROWS naming the missing dependency:
 *   `if (typeof tx.$queryRaw !== 'function') throw new Error('… requiere una transacción con $queryRaw')`
 */
import * as fs from 'fs'
import * as path from 'path'

const SRC_DIR = path.resolve(__dirname, '../../../src')

/** `typeof <transaction-ish identifier>.<member chain> === | !== 'function'` */
const TYPEOF_DEPENDENCY = /typeof\s+(?:tx|db|prisma)\b[\w$?.]*\s*(?:===|!==)\s*['"]function['"]/

/** A ternary `?` — not `?.` (optional chaining) and not `??` (nullish coalescing). */
const TERNARY_OR_RETURN = /(?<![?])\?(?![.?])|\breturn\b/

export interface MockTolerance {
  line: number
  snippet: string
}

/**
 * Flags every `typeof <tx>.<dep> === 'function'` check whose outcome is a value (ternary or `return`)
 * instead of a `throw`. The statement may span lines, so a short window after the match is inspected.
 */
export function findMockTolerance(lines: string[]): MockTolerance[] {
  const found: MockTolerance[] = []
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
    const match = TYPEOF_DEPENDENCY.exec(line)
    if (!match) return
    const window = [line.slice(match.index), ...lines.slice(index + 1, index + 4)].join(' ')
    const throwsAt = window.search(/\bthrow\b/)
    const toleratesAt = window.search(TERNARY_OR_RETURN)
    if (toleratesAt !== -1 && (throwsAt === -1 || toleratesAt < throwsAt)) {
      found.push({ line: index + 1, snippet: trimmed })
    }
  })
  return found
}

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listTsFiles(full, acc)
    else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) acc.push(full)
  }
  return acc
}

describe('production code never tolerates an incomplete test double', () => {
  it('detector: flags the ternary and return forms, accepts the throw form, ignores comments and `??`', () => {
    const multiLineTernary = [
      '      const priorCompletedPaymentCount =',
      "        typeof tx.payment.count === 'function'",
      '          ? ((await tx.payment.count({',
      "              where: { venueId, orderId, status: 'COMPLETED', type: { not: 'REFUND' } },",
      '            })) ?? 0)',
      '          : 0',
    ]
    expect(findMockTolerance(multiLineTernary).map(hit => hit.line)).toEqual([2])

    const singleLineTernary = ["  const n = typeof db.order.count === 'function' ? await db.order.count() : 0"]
    expect(findMockTolerance(singleLineTernary).map(hit => hit.line)).toEqual([1])

    const nestedTernary = [
      '      const priorCompletedPaymentCount = input.orderId',
      "        ? typeof tx.payment.count === 'function'",
      '          ? ((await tx.payment.count({ where })) ?? 0)',
      '          : 0',
      '        : 0',
    ]
    expect(findMockTolerance(nestedTernary).map(hit => hit.line)).toEqual([2])

    const silentReturn = ["  if (typeof tx.$queryRaw !== 'function') return false"]
    expect(findMockTolerance(silentReturn).map(hit => hit.line)).toEqual([1])

    const throwsInsteadOfDefault = [
      "  if (typeof tx.$queryRaw !== 'function') {",
      "    throw new Error('lockExistingOrderForPayment requiere una transacción con $queryRaw')",
      '  }',
      '  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT 1`',
      '  return rows.length === 1',
    ]
    expect(findMockTolerance(throwsInsteadOfDefault)).toEqual([])

    const oneLineThrow = ["  if (typeof prisma.$transaction !== 'function') throw new Error('prisma requiere $transaction')"]
    expect(findMockTolerance(oneLineThrow)).toEqual([])

    const onlyInComments = [
      "  // era `typeof tx.payment.count === 'function' ? … : 0` y se retiró",
      " * `typeof tx.$queryRaw !== 'function') return false` — la forma prohibida",
    ]
    expect(findMockTolerance(onlyInComments)).toEqual([])

    const unrelatedTypeof = ["  if (typeof callback === 'function') return callback(value)"]
    expect(findMockTolerance(unrelatedTypeof)).toEqual([])
  })

  it('src/ has no `typeof tx.<dep> === "function"` that falls back to a value instead of throwing', () => {
    const violations: string[] = []
    for (const file of listTsFiles(SRC_DIR)) {
      const rel = path.relative(path.resolve(SRC_DIR, '..'), file)
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      for (const hit of findMockTolerance(lines)) violations.push(`${rel}:${hit.line} → ${hit.snippet}`)
    }
    expect(violations).toEqual([])
  })
})
