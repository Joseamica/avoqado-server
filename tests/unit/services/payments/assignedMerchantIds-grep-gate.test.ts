/**
 * Grep-gate (PR-2 · T6): bans raw `Terminal.assignedMerchantIds` writes.
 *
 * The N-account invariant (a terminal-charged account must be in the venue roster) is
 * maintained by the `assignMerchantToTerminal` / `setTerminalMerchants` choke-point.
 * A raw `assignedMerchantIds: { push|set }` / `: [..]` write bypasses the roster and
 * can silently recreate the amaena bug class. This test fails if any such write exists
 * outside the choke-point, UNLESS the line (or the line above) carries the marker
 * `assignedMerchantIds-raw-write-ok` documenting why it's intentionally raw.
 *
 * To satisfy it: route the write through assignMerchantToTerminal/setTerminalMerchants,
 * or — if it genuinely must be raw (create-time, cross-venue migration) — annotate it.
 */
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.join(process.cwd(), 'src')

// The sanctioned writer — it's allowed (and expected) to write the array directly.
const CHOKE_POINT = path.join('services', 'payments', 'assignMerchantToTerminal.service.ts')

const MARKER = 'assignedMerchantIds-raw-write-ok'

// Write idioms (not reads/filters/schemas/types): `{ push|set }`, array literal, or a
// known merchant-id-array variable. Reads like `x.assignedMerchantIds`, `: true`
// (select), `{ has|hasSome|isEmpty }` (where), `z.array(..)` (schema) are NOT matched.
const WRITE_PATTERNS = [
  /assignedMerchantIds\s*:\s*\{\s*push\b/,
  /assignedMerchantIds\s*:\s*\{\s*set\b/,
  /assignedMerchantIds\s*:\s*\[/,
  /assignedMerchantIds\s*:\s*merchantsToAssign\b/,
  /assignedMerchantIds\s*:\s*previousMerchantIds\b/,
  /assignedMerchantIds\s*:\s*merchantAccountIds\b/,
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full)
  }
  return out
}

describe('grep-gate: no raw assignedMerchantIds writes (T6)', () => {
  it('every raw assignedMerchantIds write is either via the choke-point or explicitly annotated', () => {
    const violations: string[] = []

    for (const file of walk(SRC)) {
      if (file.endsWith(CHOKE_POINT)) continue
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!WRITE_PATTERNS.some(re => re.test(line))) return
        // Allow the marker on the write line or within the 5 lines above it (covers a
        // multi-line `prisma.x.update({ where, data })` whose marker sits above the call).
        const window = lines.slice(Math.max(0, i - 5), i + 1).join('\n')
        if (window.includes(MARKER)) return
        violations.push(`${path.relative(process.cwd(), file)}:${i + 1}  ${line.trim()}`)
      })
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} raw assignedMerchantIds write(s). Route through assignMerchantToTerminal/` +
          `setTerminalMerchants, or annotate with "${MARKER}: <reason>":\n` +
          violations.join('\n'),
      )
    }
  })
})
