import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { AccountType, Prisma } from '@prisma/client'
import { BadRequestError } from '../../errors/AppError'

/**
 * Single choke-point for assigning a merchant account to a terminal (PR-2 · T6).
 *
 * The N-account model's core invariant: a merchant account that a terminal can charge
 * on MUST be a member of the venue roster (VenueMerchantAccount) — otherwise the cost
 * resolver falls back to PRIMARY (the amaena bug class) and routing can't find it.
 * Historically ~11 call sites wrote the FK-less `Terminal.assignedMerchantIds String[]`
 * directly, which could not maintain that invariant. Every assignment should funnel
 * through this function so it ALWAYS, atomically:
 *
 *   1. dual-writes the legacy `Terminal.assignedMerchantIds` (still the read path until
 *      contract) — so it's a safe drop-in for the old raw writes,
 *   2. ensures the account is in the venue roster (VenueMerchantAccount upsert),
 *   3. upserts the TerminalMerchantAccount link (the FK-backed replacement, whose
 *      COMPOSITE FK to VenueMerchantAccount(venueId, merchantAccountId) makes the
 *      invariant structural).
 *
 * `venueId` is derived from the terminal when omitted. If the venue has no
 * VenuePaymentConfig (nowhere to hang a roster row), it DEGRADES to the legacy-only
 * write and logs — never throws — so migrating a call site can't regress provisioning.
 * Idempotent. Pass a transaction client via `db` to compose with a larger operation.
 */

type Db = Prisma.TransactionClient | typeof prisma

export interface AssignMerchantToTerminalParams {
  terminalId: string
  merchantAccountId: string
  /** Derived from the terminal when omitted. */
  venueId?: string
  /** Make this the terminal's default account (clears any other default). */
  isDefault?: boolean
  /** Per-terminal display/selection order. */
  perTerminalOrder?: number
  label?: string
  db?: Db
}

export interface AssignMerchantToTerminalResult {
  venueId: string
  venueMerchantAccountId: string | null
  terminalMerchantAccountId: string | null
  addedToRoster: boolean
  addedToTerminal: boolean
  /** True when the venue had no payment config → only the legacy array was written. */
  legacyOnly: boolean
}

async function run(db: Db, params: AssignMerchantToTerminalParams): Promise<AssignMerchantToTerminalResult> {
  const { terminalId, merchantAccountId, isDefault, perTerminalOrder, label } = params

  const terminal = await db.terminal.findUnique({
    where: { id: terminalId },
    select: { id: true, venueId: true, assignedMerchantIds: true },
  })
  if (!terminal) {
    throw new BadRequestError(`Terminal ${terminalId} not found; cannot assign merchant ${merchantAccountId}`)
  }
  const venueId = params.venueId ?? terminal.venueId

  // (1) Legacy dual-write — always, first, so behavior is never worse than the raw write.
  let addedToTerminal = false
  if (!terminal.assignedMerchantIds.includes(merchantAccountId)) {
    await db.terminal.update({ where: { id: terminalId }, data: { assignedMerchantIds: { push: merchantAccountId } } })
    addedToTerminal = true
  }

  // The roster row hangs off the venue's payment config. A venue that only inherits an
  // org config has no VenuePaymentConfig — degrade to legacy-only (no throw) so this is
  // a safe drop-in for the historical raw writers.
  const config = await db.venuePaymentConfig.findUnique({
    where: { venueId },
    select: { id: true, primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true },
  })
  if (!config) {
    logger.warn('assignMerchantToTerminal: venue has no VenuePaymentConfig; wrote legacy assignedMerchantIds only', {
      venueId,
      terminalId,
      merchantAccountId,
    })
    return { venueId, venueMerchantAccountId: null, terminalMerchantAccountId: null, addedToRoster: false, addedToTerminal, legacyOnly: true }
  }

  // (2) Ensure the roster row. On create, infer the legacy slot anchor from the config
  // slots (so a slot account assigned before backfill still gets the right anchor) and
  // append at the next priority. On hit, leave it untouched (idempotent; preserves the
  // immutable legacySlotType + any curated priority/label).
  const existingRoster = await db.venueMerchantAccount.findUnique({
    where: { venueId_merchantAccountId: { venueId, merchantAccountId } },
    select: { id: true },
  })

  let venueMerchantAccountId: string
  let addedToRoster = false
  if (existingRoster) {
    venueMerchantAccountId = existingRoster.id
  } else {
    const last = await db.venueMerchantAccount.findFirst({
      where: { venuePaymentConfigId: config.id },
      orderBy: { priority: 'desc' },
      select: { priority: true },
    })
    const legacySlotType: AccountType | null =
      merchantAccountId === config.primaryAccountId
        ? AccountType.PRIMARY
        : merchantAccountId === config.secondaryAccountId
          ? AccountType.SECONDARY
          : merchantAccountId === config.tertiaryAccountId
            ? AccountType.TERTIARY
            : null

    const created = await db.venueMerchantAccount.create({
      data: {
        venuePaymentConfigId: config.id,
        venueId,
        merchantAccountId,
        priority: (last?.priority ?? -1) + 1,
        legacySlotType,
        inheritedFromOrg: false,
        ...(label ? { label } : {}),
      },
      select: { id: true },
    })
    venueMerchantAccountId = created.id
    addedToRoster = true
  }

  // (3) One default per terminal: clear any other default before setting this one.
  if (isDefault) {
    await db.terminalMerchantAccount.updateMany({
      where: { terminalId, isDefault: true, NOT: { merchantAccountId } },
      data: { isDefault: false },
    })
  }

  // Upsert the terminal↔account link. The composite FK to VenueMerchantAccount(venueId,
  // merchantAccountId) guarantees the roster membership ensured in (2).
  const existingLink = await db.terminalMerchantAccount.findUnique({
    where: { terminalId_merchantAccountId: { terminalId, merchantAccountId } },
    select: { id: true },
  })
  let terminalMerchantAccountId: string
  if (existingLink) {
    const updated = await db.terminalMerchantAccount.update({
      where: { id: existingLink.id },
      data: {
        active: true,
        ...(isDefault !== undefined ? { isDefault } : {}),
        ...(perTerminalOrder !== undefined ? { perTerminalOrder } : {}),
      },
      select: { id: true },
    })
    terminalMerchantAccountId = updated.id
  } else {
    const created = await db.terminalMerchantAccount.create({
      data: {
        terminalId,
        venueId,
        merchantAccountId,
        isDefault: isDefault ?? false,
        ...(perTerminalOrder !== undefined ? { perTerminalOrder } : {}),
      },
      select: { id: true },
    })
    terminalMerchantAccountId = created.id
  }

  logger.info('assignMerchantToTerminal', { venueId, terminalId, merchantAccountId, addedToRoster, addedToTerminal, isDefault: !!isDefault })

  return { venueId, venueMerchantAccountId, terminalMerchantAccountId, addedToRoster, addedToTerminal, legacyOnly: false }
}

export async function assignMerchantToTerminal(params: AssignMerchantToTerminalParams): Promise<AssignMerchantToTerminalResult> {
  if (params.db) return run(params.db, params)
  return prisma.$transaction(tx => run(tx, params))
}

export interface SetTerminalMerchantsResult {
  added: string[]
  removed: string[]
  final: string[]
}

/**
 * Set the FULL list of merchant accounts a terminal can charge on (PR-2 · T6) — the
 * replacement for raw `assignedMerchantIds: [..]` writes that REPLACE the whole array.
 *
 * Diffs desired vs current: adds new accounts through `assignMerchantToTerminal` (so
 * each gets a roster row + link), removes the dropped TerminalMerchantAccount links,
 * and sets the legacy array authoritatively to `desired`. Atomic; idempotent.
 */
export async function setTerminalMerchants(params: {
  terminalId: string
  merchantAccountIds: string[]
  db?: Db
}): Promise<SetTerminalMerchantsResult> {
  const exec = async (db: Db): Promise<SetTerminalMerchantsResult> => {
    const terminal = await db.terminal.findUnique({
      where: { id: params.terminalId },
      select: { id: true, assignedMerchantIds: true },
    })
    if (!terminal) {
      throw new BadRequestError(`Terminal ${params.terminalId} not found; cannot set its merchant accounts`)
    }

    const desired = [...new Set(params.merchantAccountIds)]
    const current = terminal.assignedMerchantIds
    const toAdd = desired.filter(id => !current.includes(id))
    const toRemove = current.filter(id => !desired.includes(id))

    for (const merchantAccountId of toAdd) {
      await assignMerchantToTerminal({ terminalId: params.terminalId, merchantAccountId, db })
    }
    if (toRemove.length) {
      await db.terminalMerchantAccount.deleteMany({ where: { terminalId: params.terminalId, merchantAccountId: { in: toRemove } } })
    }
    // Authoritative legacy array = desired (covers removals + any per-add push drift).
    await db.terminal.update({ where: { id: params.terminalId }, data: { assignedMerchantIds: { set: desired } } })

    logger.info('setTerminalMerchants', { terminalId: params.terminalId, added: toAdd, removed: toRemove })
    return { added: toAdd, removed: toRemove, final: desired }
  }

  if (params.db) return exec(params.db)
  return prisma.$transaction(exec)
}
