import prisma from '@/utils/prismaClient'

/**
 * Pool of safe characters for the random suffix. Excludes ambiguous
 * glyphs (0/O, 1/I/l, 5/S) so codes stay legible on a printed coupon.
 */
// 30 chars; excludes 0, O, I, 1, S, and 5 — they read ambiguously on
// printed coupons and low-DPI screens.
const SAFE_POOL = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789'

export interface CodeGenerationContext {
  venueId: string
  venuePrefix: string
  customerName: string | null | undefined
}

/**
 * Normalize a customer name into a 4-char uppercase ASCII chunk.
 *
 *   - NFD-normalize and strip combining marks (so "María" → "MARI").
 *   - Drop spaces, digits, and symbols (so multi-word names concatenate
 *     letters across words: "Ana Cristina" → "ANAC").
 *   - Take the first 4 letters; pad with X if shorter than 4.
 *   - Return ANON for null/empty/all-symbol input.
 */
export function normalizeNameForCode(name: string | null | undefined): string {
  if (!name) return 'ANON'
  const stripped = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .replace(/[^A-Za-z]/g, '') // strip spaces, digits, symbols
    .toUpperCase()
  if (!stripped) return 'ANON'
  return stripped.slice(0, 4).padEnd(4, 'X')
}

function randomSuffix3(): string {
  let s = ''
  for (let i = 0; i < 3; i++) {
    s += SAFE_POOL[Math.floor(Math.random() * SAFE_POOL.length)]
  }
  return s
}

function normalizeVenuePrefix(prefix: string): string {
  return prefix
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8)
}

/**
 * Generate a referral code of the form `VENUE-NAMERND`.
 *
 *   - `VENUE` = uppercased, sanitized venuePrefix (max 8 chars).
 *   - `NAME` = 4-char normalized customer name (see `normalizeNameForCode`).
 *   - `RND` = 3-char random suffix from a 28-char safe pool.
 *
 * Retries up to 5 times on per-venue collision before throwing.
 */
export async function generateReferralCode(ctx: CodeGenerationContext): Promise<string> {
  const prefix = normalizeVenuePrefix(ctx.venuePrefix)
  const namePart = normalizeNameForCode(ctx.customerName)
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = randomSuffix3()
    const code = `${prefix}-${namePart}${suffix}`
    const existing = await prisma.customer.findFirst({
      where: { venueId: ctx.venueId, referralCode: code },
      select: { id: true },
    })
    if (!existing) return code
  }
  throw new Error(`Referral code generation collision: 5 attempts exhausted for venue ${ctx.venueId}`)
}
