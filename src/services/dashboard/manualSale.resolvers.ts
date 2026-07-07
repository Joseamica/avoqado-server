import { Prisma, PaymentMethod, SerializedItem } from '@prisma/client'

/**
 * Row resolver helpers for "Subir ventas fuera de TPV" (manual sales bulk
 * upload — PlayTelecom / Walmart SIM sales made outside the TPV).
 *
 * Each function turns one opaque raw value from a parsed Excel/CSV row
 * (`ManualSaleRowInput`, see `src/schemas/dashboard/manualSale.schema.ts`)
 * into a real domain entity scoped to the organization, or a Spanish
 * `{ error }` when it can't be resolved. Pure — no writes, only reads
 * against the passed-in Prisma transaction client — so Task 4 (single-sale
 * creation) and Task 5 (bulk preview) can call them inside a `$transaction`
 * and roll back cleanly on any resolver error.
 *
 * ICCID lookups MUST be case-insensitive: a handful of legacy SerializedItem
 * rows are stored lower-cased (pre-`normalizeSerial()`), matching the
 * precedent in `serializedInventory.service.ts` (`scan`/`ensureSellable`).
 */

// A resolver either returns the resolved value, or a Spanish user-facing error.
type Resolved<T> = T | { error: string }

/**
 * Resolves an ICCID string to its `SerializedItem`, scoped to the org.
 *
 * Requires `status === 'AVAILABLE'` (not yet sold, not returned/damaged) and
 * `organizationId === orgId` (never sell another org's stock). Matches
 * case-insensitively, trimmed, mirroring the precedent in
 * `serializedInventory.service.ts` (`findOrgItem`/`ensureSellable`).
 */
export async function resolveIccid(
  orgId: string,
  iccid: string,
  tx: Prisma.TransactionClient,
): Promise<Resolved<{ item: SerializedItem }>> {
  const item = await tx.serializedItem.findFirst({
    where: {
      organizationId: orgId,
      serialNumber: { equals: iccid.trim(), mode: 'insensitive' },
    },
  })

  if (!item) {
    return { error: 'ICCID no existe' }
  }

  if (item.organizationId !== orgId) {
    return { error: 'ICCID pertenece a otra organización' }
  }

  if (item.status === 'SOLD') {
    return { error: 'ICCID ya vendido' }
  }

  if (item.status !== 'AVAILABLE') {
    // RETURNED / DAMAGED — not sellable, and not usefully described as
    // "already sold". The query is already org+serial scoped, so from the
    // caller's perspective this SIM simply isn't a valid, sellable ICCID.
    return { error: 'ICCID no existe' }
  }

  return { item }
}

/**
 * Resolves a seller ("ID Promotor") to a `Staff` record within the org.
 *
 * Match order: `employeeCode` (case-insensitive) first, falling back to a
 * normalized `firstName + ' ' + lastName` match when the code is empty or
 * doesn't resolve. Either way the match must have an active membership in
 * the org (`StaffVenue`/`StaffOrganization`) — a same-named Staff row in a
 * different org must never be selected.
 */
export async function resolveStaffByCode(
  orgId: string,
  code: string | undefined,
  name: string | undefined,
  tx: Prisma.TransactionClient,
): Promise<Resolved<{ staff: { id: string; firstName: string; lastName: string; employeeCode: string | null } }>> {
  const trimmedCode = code?.trim()
  // Both membership paths must require an ACTIVE membership: a seller offboarded
  // from the org (StaffOrganization.isActive=false) or deactivated at a venue
  // (StaffVenue.active=false) must not resolve as a valid seller.
  const orgMembershipFilter = {
    OR: [
      { venues: { some: { venue: { organizationId: orgId }, active: true } } },
      { organizations: { some: { organizationId: orgId, isActive: true } } },
    ],
  }

  if (trimmedCode) {
    const byCode = await tx.staff.findFirst({
      where: {
        employeeCode: { equals: trimmedCode, mode: 'insensitive' },
        ...orgMembershipFilter,
      },
    })
    if (byCode) {
      return { staff: byCode }
    }
  }

  const trimmedName = name?.trim()
  if (trimmedName) {
    const normalizedTarget = normalizeName(trimmedName)
    const candidates = await tx.staff.findMany({
      where: orgMembershipFilter,
    })
    const byName = candidates.find(
      (c: { firstName: string; lastName: string }) => normalizeName(`${c.firstName} ${c.lastName}`) === normalizedTarget,
    )
    if (byName) {
      return { staff: byName }
    }
  }

  return { error: 'Vendedor no encontrado' }
}

/** Lowercase + collapse whitespace + strip accents, for tolerant name matching. */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/**
 * Resolves a store ("ID Tienda" / "Nombre de la Tienda") to a `Venue`
 * within the org.
 *
 * Match order: a trailing `(NNNN)` numeric id embedded in the store name
 * (e.g. "BAE MUÑOZ SLP (898)" → 898), else `name`/`slug` (case-insensitive).
 * `storeId` (the separate "ID Tienda" column) is used the same way when the
 * number can't be extracted from `storeName`. Always scoped to the org.
 */
export async function resolveVenue(
  orgId: string,
  storeName: string,
  storeId: string | undefined,
  tx: Prisma.TransactionClient,
): Promise<Resolved<{ venue: { id: string; name: string; slug: string } }>> {
  const trailingNumberMatch = storeName.match(/\((\d+)\)\s*$/)
  const numericId = trailingNumberMatch?.[1] ?? storeId?.trim()

  if (numericId) {
    const byNumber = await tx.venue.findFirst({
      where: {
        organizationId: orgId,
        OR: [{ name: { contains: `(${numericId})` } }, { slug: { contains: numericId } }],
      },
    })
    if (byNumber) {
      return { venue: byNumber }
    }
  }

  const trimmedName = storeName.trim()
  const byNameOrSlug = await tx.venue.findFirst({
    where: {
      organizationId: orgId,
      OR: [{ name: { equals: trimmedName, mode: 'insensitive' } }, { slug: { equals: trimmedName, mode: 'insensitive' } }],
    },
  })
  if (byNameOrSlug) {
    return { venue: byNameOrSlug }
  }

  return { error: 'Tienda no encontrada' }
}

/**
 * Resolves "Tipo de SIM" / "Categoría" to an org-level `ItemCategory.id`.
 *
 * Matches by name (case-insensitive), org-scoped. When `simType` is empty,
 * falls back to the item's own existing `categoryId` — SIMs are always
 * pre-categorized at registration, so an empty column just means "keep the
 * category the SIM already has".
 */
export async function resolveCategory(
  orgId: string,
  simType: string | undefined,
  tx: Prisma.TransactionClient,
  existingCategoryId?: string,
): Promise<Resolved<{ categoryId: string }>> {
  const trimmed = simType?.trim()

  if (!trimmed) {
    if (existingCategoryId) {
      return { categoryId: existingCategoryId }
    }
    return { error: 'Categoría no encontrada' }
  }

  const category = await tx.itemCategory.findFirst({
    where: {
      organizationId: orgId,
      name: { equals: trimmed, mode: 'insensitive' },
    },
  })

  if (category) {
    return { categoryId: category.id }
  }

  if (existingCategoryId) {
    return { categoryId: existingCategoryId }
  }

  return { error: 'Categoría no encontrada' }
}

/**
 * Maps the raw "Forma de Pago" sheet value to a `PaymentMethod` enum value
 * plus whether the amount column should be honored (`amountApplies`).
 *
 * The real `PaymentMethod` enum has no plain "CARD" value — it splits
 * `CREDIT_CARD` / `DEBIT_CARD`. The sheet's "Tarjeta"/"Débito"/"Crédito"
 * bucket doesn't reliably distinguish debit from credit (PlayTelecom's own
 * export doesn't either), so all three map to `CREDIT_CARD` as the closest
 * single representative "card" value. See task report for the full
 * reasoning — flagged for founder confirmation if debit/credit ever need to
 * be told apart downstream (commissions, reconciliation).
 */
export function mapPaymentForm(raw: string): { method: PaymentMethod; amountApplies: boolean } {
  const normalized = raw.trim().toLowerCase()

  if (normalized === 'efectivo') {
    return { method: PaymentMethod.CASH, amountApplies: true }
  }

  if (
    normalized === 'tarjeta' ||
    normalized === 'débito' ||
    normalized === 'debito' ||
    normalized === 'crédito' ||
    normalized === 'credito'
  ) {
    return { method: PaymentMethod.CREDIT_CARD, amountApplies: true }
  }

  if (normalized === 'no aplica') {
    return { method: PaymentMethod.OTHER, amountApplies: false }
  }

  return { method: PaymentMethod.OTHER, amountApplies: true }
}

/**
 * Parses the raw "Monto de Venta" sheet value to a `Prisma.Decimal` in
 * pesos (never cents — see `.claude/rules/critical-warnings.md`).
 *
 * `"No aplica"` (case-insensitive) or `!amountApplies` (payment form said
 * the amount doesn't apply, e.g. a SIM swap with no money changing hands)
 * always yields `Decimal(0)`, regardless of what's in the raw value.
 */
export function parseAmount(raw: string | number, amountApplies: boolean): Prisma.Decimal {
  if (!amountApplies) {
    return new Prisma.Decimal(0)
  }

  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'no aplica') {
    return new Prisma.Decimal(0)
  }

  return new Prisma.Decimal(raw)
}
