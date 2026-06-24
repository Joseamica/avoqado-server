import { AccountType, Prisma, PrismaClient } from '@prisma/client'

/**
 * PR-1 backfill (feat/venue-merchant-accounts). Pobla los rosters nuevos desde el
 * modelo de 3 slots + `Terminal.assignedMerchantIds` + `Payment.merchantAccountId`
 * históricos. Spec: docs/specs/2026-06-17-venue-merchant-accounts-design.md §6.2.
 *
 * Propiedades clave:
 * - **IDEMPOTENTE**: upsert por claves naturales con `update: {}` → re-correr nunca
 *   duplica ni pisa filas existentes (`legacySlotType` es inmutable).
 * - **Solo aditivo**: nada lee estas tablas todavía (eso es PR-2 + flag).
 * - **Universo = UNIÓN** (slots ∪ assignedMerchantIds ∪ pagos históricos), no solo slots.
 * - Acepta un client/tx para que los tests corran dentro de una transacción y hagan rollback.
 *
 * PENDIENTE (NO PR-1, requiere decisión de diseño): materializar cuentas org en venues
 * que HEREDAN del org (sin `VenuePaymentConfig` propia). Una cuenta así no se puede
 * insertar en `VenueMerchantAccount` (necesita `venuePaymentConfigId`). Esas cuentas se
 * reportan en `unslottedAccounts` y la fila de terminal correspondiente se OMITE (para no
 * violar la FK compuesta), nunca se inventa.
 */

type Db = PrismaClient | Prisma.TransactionClient

export interface BackfillResult {
  venueConfigs: number
  orgConfigs: number
  rosterRows: number
  orgRosterRows: number
  terminalRows: number
  /** (unión − slots): cuentas solo-en-terminal / solo-en-pago. Para reportar (§6.2). */
  unslottedAccounts: { venueId: string; merchantAccountId: string }[]
  /** cuentas en una terminal que NO se pudieron materializar al roster (venue sin config). */
  skippedTerminalAccounts: { terminalId: string; venueId: string; merchantAccountId: string }[]
}

function slotEntries(cfg: { primaryAccountId: string | null; secondaryAccountId: string | null; tertiaryAccountId: string | null }) {
  const out: { acct: string; priority: number; legacy: AccountType }[] = []
  if (cfg.primaryAccountId) out.push({ acct: cfg.primaryAccountId, priority: 0, legacy: AccountType.PRIMARY })
  if (cfg.secondaryAccountId) out.push({ acct: cfg.secondaryAccountId, priority: 1, legacy: AccountType.SECONDARY })
  if (cfg.tertiaryAccountId) out.push({ acct: cfg.tertiaryAccountId, priority: 2, legacy: AccountType.TERTIARY })
  return out
}

export async function backfillVenueMerchantAccounts(db: Db): Promise<BackfillResult> {
  const result: BackfillResult = {
    venueConfigs: 0,
    orgConfigs: 0,
    rosterRows: 0,
    orgRosterRows: 0,
    terminalRows: 0,
    unslottedAccounts: [],
    skippedTerminalAccounts: [],
  }

  // ---- 1) Roster del venue: slots ∪ assignedMerchantIds ∪ pagos históricos ----
  const venueConfigs = await db.venuePaymentConfig.findMany({
    select: { id: true, venueId: true, primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true },
  })
  result.venueConfigs = venueConfigs.length

  for (const cfg of venueConfigs) {
    const slots = slotEntries(cfg)
    const slotAccts = new Set(slots.map(s => s.acct))

    for (const s of slots) {
      await db.venueMerchantAccount.upsert({
        where: { venuePaymentConfigId_merchantAccountId: { venuePaymentConfigId: cfg.id, merchantAccountId: s.acct } },
        create: { venuePaymentConfigId: cfg.id, venueId: cfg.venueId, merchantAccountId: s.acct, priority: s.priority, legacySlotType: s.legacy },
        update: {}, // idempotente
      })
      result.rosterRows++
    }

    const terminals = await db.terminal.findMany({ where: { venueId: cfg.venueId }, select: { assignedMerchantIds: true } })
    const histPayments = await db.payment.findMany({
      where: { venueId: cfg.venueId, merchantAccountId: { not: null } },
      distinct: ['merchantAccountId'],
      select: { merchantAccountId: true },
    })

    const extra = new Set<string>()
    for (const t of terminals) for (const id of t.assignedMerchantIds) if (!slotAccts.has(id)) extra.add(id)
    for (const p of histPayments) if (p.merchantAccountId && !slotAccts.has(p.merchantAccountId)) extra.add(p.merchantAccountId)

    let priority = 3
    for (const acct of extra) {
      result.unslottedAccounts.push({ venueId: cfg.venueId, merchantAccountId: acct })
      await db.venueMerchantAccount.upsert({
        where: { venuePaymentConfigId_merchantAccountId: { venuePaymentConfigId: cfg.id, merchantAccountId: acct } },
        create: { venuePaymentConfigId: cfg.id, venueId: cfg.venueId, merchantAccountId: acct, priority: priority++, legacySlotType: null },
        update: {},
      })
      result.rosterRows++
    }
  }

  // ---- 2) Roster a nivel org (plantilla) ----
  const orgConfigs = await db.organizationPaymentConfig.findMany({
    select: { id: true, organizationId: true, primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true },
  })
  result.orgConfigs = orgConfigs.length

  for (const cfg of orgConfigs) {
    for (const s of slotEntries(cfg)) {
      await db.organizationMerchantAccount.upsert({
        where: { organizationPaymentConfigId_merchantAccountId: { organizationPaymentConfigId: cfg.id, merchantAccountId: s.acct } },
        create: { organizationPaymentConfigId: cfg.id, organizationId: cfg.organizationId, merchantAccountId: s.acct, priority: s.priority, legacySlotType: s.legacy },
        update: {},
      })
      result.orgRosterRows++
    }
  }

  // ---- 3) TerminalMerchantAccount desde assignedMerchantIds ----
  // La FK compuesta exige que la cuenta esté en el roster del venue (paso 1 ya la metió).
  // Si no está (venue que hereda del org, sin config materializada) → se OMITE y se reporta.
  const terminals = await db.terminal.findMany({
    where: { assignedMerchantIds: { isEmpty: false } },
    select: { id: true, venueId: true, assignedMerchantIds: true },
  })

  for (const t of terminals) {
    if (!t.venueId) continue
    const rosterAccts = new Set(
      (await db.venueMerchantAccount.findMany({ where: { venueId: t.venueId }, select: { merchantAccountId: true } })).map(r => r.merchantAccountId),
    )
    for (const acct of t.assignedMerchantIds) {
      if (!rosterAccts.has(acct)) {
        result.skippedTerminalAccounts.push({ terminalId: t.id, venueId: t.venueId, merchantAccountId: acct })
        continue
      }
      await db.terminalMerchantAccount.upsert({
        where: { terminalId_merchantAccountId: { terminalId: t.id, merchantAccountId: acct } },
        create: { terminalId: t.id, venueId: t.venueId, merchantAccountId: acct },
        update: {},
      })
      result.terminalRows++
    }
  }

  return result
}
