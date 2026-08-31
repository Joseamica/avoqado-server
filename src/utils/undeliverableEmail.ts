/**
 * Undeliverable-recipient guard for every outbound email.
 *
 * WHY THIS EXISTS
 * ---------------
 * Demo/seed data plants staff rows whose `email` is a placeholder that no mail
 * server will ever accept, and Avoqado itself mints placeholders for TPV-only
 * staff (`tpv-…@internal.avoqado.io`) and for soft-deleted staff
 * (`deleted-…@deleted.avoqado.io`). Those rows are indistinguishable from real
 * staff to the cron jobs: the venue is ACTIVE, the StaffVenue row is active, the
 * role is OWNER/ADMIN/MANAGER. So `nightly-low-stock` (and every sibling job)
 * happily emailed them nightly and collected a hard bounce ~14h later, every
 * single day.
 *
 * Hard bounces are the one email metric that compounds against you: Resend adds
 * the address to its suppression list, and every further attempt produces
 * another Permanent bounce on OUR account. That reputation is shared with the
 * transactional mail that actually matters — signup verification, onboarding
 * welcome, the `onboarding@avoqado.io` new-venue notice.
 *
 * WHAT IT BLOCKS
 * --------------
 * Only addresses that are *provably* undeliverable — never a heuristic that
 * could silence a paying customer:
 *
 *   RESERVED_TLD      RFC 2606 / 6761 / 6762 special-use names (.test .invalid
 *                     .example .localhost .local). Never routable, by standard.
 *   RESERVED_DOMAIN   RFC 2606 example.com / .net / .org and their subdomains.
 *   PLACEHOLDER_DOMAIN Any *subdomain* of avoqado.io. The real corporate mail
 *                     domain is the apex `@avoqado.io` (Google Workspace); the
 *                     subdomains carry no MX and exist only as placeholders.
 *   SEED_ACCOUNT      An Avoqado role name (optionally suffixed with a digit)
 *                     repeated as its own domain — `admin@admin.com`,
 *                     `waiter2@waiter2.com`. These belong to third parties, so
 *                     beyond bouncing they leak venue data to strangers.
 *   NON_ASCII         Any non-ASCII character in the address. Resend rejects the
 *                     whole send with 422 `validation_error` ("The email address
 *                     contains non-ASCII characters"), so it is provably
 *                     undeliverable — and in Mexico it is easy to produce by
 *                     accident: derive a login from "Lucía" or "Ríos" and the
 *                     accent lands in the address.
 *   MALFORMED         Not a syntactically usable address at all.
 *
 * WHAT IT DELIBERATELY DOES NOT BLOCK
 * -----------------------------------
 * The tempting rule "local part equals the domain label" would also block
 * `mindform@mindform.com.mx`, a real client. Keying on Avoqado ROLE names is
 * what keeps the rule narrow. Anything not provably fake stays deliverable —
 * addresses that turn out to bounce are the suppression list's job, not this
 * file's.
 */

import logger from '../config/logger'

export type UndeliverableReason =
  | 'RESERVED_TLD'
  | 'RESERVED_DOMAIN'
  | 'PLACEHOLDER_DOMAIN'
  | 'SEED_ACCOUNT'
  | 'NON_ASCII'
  | 'MALFORMED'

/** Special-use TLDs that can never resolve on the public internet. */
const RESERVED_TLDS = new Set(['test', 'invalid', 'example', 'localhost', 'local'])

/** RFC 2606 second-level domains reserved for documentation. */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org']

/**
 * The apex is real mail (Google Workspace). Every subdomain under it is an
 * Avoqado-minted placeholder: `internal.` (TPV service accounts), `deleted.`
 * (soft-deleted staff), `avoqado-full.` (demo seed). If a real mail subdomain
 * is ever provisioned, add it to MAIL_SUBDOMAINS below — do not weaken the rule.
 */
const CORPORATE_MAIL_DOMAIN = 'avoqado.io'
const MAIL_SUBDOMAINS: string[] = []

/**
 * Lowercased Avoqado role names, used to recognise seeded role accounts.
 *
 * 🔴 Deliberately a literal, NOT `Object.values(StaffRole)`. Importing
 * `@prisma/client` runs dotenv as a side effect and repopulates `process.env`,
 * which broke three `resend.service` tests that assert "no API key configured →
 * do not send": the mere import revived `RESEND_API_KEY`. This module is on the
 * hot path of every outbound email, so it stays free of heavy imports.
 *
 * `tests/unit/utils/undeliverableEmail.test.ts` fails if this list ever drifts
 * from the real `StaffRole` enum — the test may import Prisma, this file may not.
 */
export const SEED_ROLE_NAMES = ['superadmin', 'owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'host', 'viewer'] as const

const ROLE_NAMES = new Set<string>(SEED_ROLE_NAMES)

/**
 * Pull the bare address out of an RFC 5322 `Name <addr>` string. Anything else
 * is returned trimmed and unchanged.
 */
function extractAddress(raw: string): string {
  const angled = raw.match(/<([^<>]*)>\s*$/)
  return (angled ? angled[1] : raw).trim().toLowerCase()
}

/**
 * Classify a recipient. Returns `null` when the address is deliverable as far
 * as we can prove — which is the default, and the safe answer.
 */
export function classifyUndeliverable(email: string): UndeliverableReason | null {
  if (typeof email !== 'string') return 'MALFORMED'

  const address = extractAddress(email)
  if (!address) return 'MALFORMED'

  const parts = address.split('@')
  if (parts.length !== 2) return 'MALFORMED'

  const [localPart, domain] = parts
  if (!localPart || !domain) return 'MALFORMED'
  if (/[\s<>,;]/.test(localPart) || /[\s<>,;]/.test(domain)) return 'MALFORMED'
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return 'MALFORMED'

  const labels = domain.split('.')
  const tld = labels[labels.length - 1]
  if (RESERVED_TLDS.has(tld)) return 'RESERVED_TLD'

  if (RESERVED_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`))) return 'RESERVED_DOMAIN'

  if (domain.endsWith(`.${CORPORATE_MAIL_DOMAIN}`) && !MAIL_SUBDOMAINS.includes(domain)) {
    return 'PLACEHOLDER_DOMAIN'
  }

  // Seed accounts: `<role><digits?>@<same-string>.<tld>`
  if (labels[0] === localPart && ROLE_NAMES.has(localPart.replace(/\d+$/, ''))) {
    return 'SEED_ACCOUNT'
  }

  // 🔴 Resend rechaza el envío COMPLETO con 422 («Invalid `to` field … non-ASCII») y su
  // mensaje no dice a QUIÉN no le llegó. Encontrado el 2026-08-31 capturando la guía de
  // asistencia: el aviso de retardo fallaba en silencio.
  //
  // Va AL FINAL a propósito: un placeholder que Avoqado mismo acuña a partir de un nombre
  // con ñ (`tpv-doña-simona-…@internal.avoqado.io`) también es no-ASCII, pero el motivo
  // ÚTIL para quien lee el log es que es un placeholder. Lo específico gana.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(address)) return 'NON_ASCII'

  return null
}

/** Convenience predicate over {@link classifyUndeliverable}. */
export function isUndeliverableEmail(email: string): boolean {
  return classifyUndeliverable(email) !== null
}

/**
 * Split a recipient list into the addresses worth sending to and the ones that
 * are provably undeliverable. Used at the send boundary so a single bad address
 * never poisons a whole multi-recipient send.
 */
export function partitionRecipients(recipients: string[]): {
  deliverable: string[]
  blocked: Array<{ email: string; reason: UndeliverableReason }>
} {
  const deliverable: string[] = []
  const blocked: Array<{ email: string; reason: UndeliverableReason }> = []

  for (const recipient of recipients) {
    const reason = classifyUndeliverable(recipient)
    if (reason) blocked.push({ email: recipient, reason })
    else deliverable.push(recipient)
  }

  return { deliverable, blocked }
}

/**
 * Gate a single recipient at a send site, logging the skip. `source` names the
 * call site so the log line says which sender tried it.
 *
 * Returns `true` when the send should proceed.
 */
export function isDeliverableRecipient(email: string, source: string, meta?: Record<string, unknown>): boolean {
  const reason = classifyUndeliverable(email)
  if (!reason) return true

  logger.warn('📧 Skipped undeliverable recipient', { to: email, reason, source, ...meta })
  return false
}

/**
 * Gate a recipient list, logging whatever got dropped. Returns the addresses
 * still worth sending to (possibly empty — callers must handle that).
 */
export function filterDeliverableRecipients(emails: string[], source: string): string[] {
  const { deliverable, blocked } = partitionRecipients(emails)

  if (blocked.length > 0) {
    logger.warn('📧 Skipped undeliverable recipients', { source, blocked, kept: deliverable.length })
  }

  return deliverable
}
