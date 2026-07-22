import { Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { serializedInventoryService } from '../serialized-inventory/serializedInventory.service'
import { logAction } from './activity-log.service'
import { resolveIccid, resolveVenue, resolveStaffByCode, resolveCategory, mapPaymentForm, parseAmount } from './manualSale.resolvers'
import type { ManualSaleRowInput } from '../../schemas/dashboard/manualSale.schema'

/**
 * Creates ONE complete, already-approved external SIM sale in a single atomic
 * transaction — the money-critical core of "Subir ventas fuera de TPV"
 * (PlayTelecom / Walmart SIM sales recorded outside the TPV, after the fact).
 *
 * Unlike a normal TPV sale (which lands as a PENDING SaleVerification awaiting
 * back-office documentation review), a manual upload represents a sale whose
 * documentation was already checked offline, so the SaleVerification is created
 * directly as COMPLETED with the uploading actor stamped as its reviewer.
 *
 * All 6 opaque row values are resolved to real org-scoped records first
 * (`manualSale.resolvers.ts`). On ANY resolver error nothing has been written
 * yet, so returning `{ ok:false }` from inside the `$transaction` rolls back
 * cleanly. The one shared `SerializedItem` (org-level) is flipped to SOLD via
 * `markAsSold`, which sets `sellingVenueId` to the resolved STORE venue.
 *
 * Reuses existing enum values (`Order.type='MANUAL_ENTRY'`,
 * `source='DASHBOARD_MANUAL'`) — no migration. `posRawData.manualSerializedSale`
 * tags the row so reports can distinguish these from real TPV sales.
 *
 * Audit is dual-written AFTER the tx, fire-and-forget (`void`, never throws,
 * outside `$transaction`): an `ActivityLog` (MANUAL_SALE_CREATED) for the owner
 * audit screen + a `SerializedItemCustodyEvent` (MARKED_SOLD) for the custody
 * timeline — mirroring `scripts/temp-mark-sim-sold.ts`.
 */

const VENUE_TIMEZONE_DEFAULT = 'America/Mexico_City'

export type CreateOneManualSaleResult =
  | { ok: true; orderId: string; verificationId: string; venueId: string }
  | { ok: false; error: string }

interface ManualSaleAuditPayload {
  serializedItemId: string
  serialNumber: string
  fromCustodyState: string | null
  fromStaffId: string | null
  sellerStaffId: string
  storeName: string
  amount: string
}

/** Narrows a resolver return to its error branch. */
function isError<T extends object>(v: T | { error: string }): v is { error: string } {
  return (v as { error?: string }).error !== undefined
}

/**
 * Internal tx result: on success it carries the audit payload back OUT of the
 * transaction so the post-tx fire-and-forget audit can run without mutating a
 * closure variable (which TS can't narrow across the callback boundary).
 */
type TxResult =
  | { ok: true; orderId: string; verificationId: string; venueId: string; audit: ManualSaleAuditPayload }
  | { ok: false; error: string }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A transient DB error is one where a retry can succeed unchanged — a dropped
 * connection or a database that is briefly restarting/in-recovery (Render's small
 * Postgres instances OOM-restart and take a few seconds to come back). NOT retried:
 * resolver failures (bad ICCID, unknown seller) which are returned, never thrown.
 */
function isTransientDbError(err: unknown): boolean {
  const message = (err as Error)?.message ?? ''
  const code = (err as { code?: string })?.code
  return (
    /closed the connection|recovery mode|not yet accepting connections|Connection terminated|Can't reach database server|the database system is starting up|ECONNREFUSED|ECONNRESET/i.test(
      message,
    ) || ['P1001', 'P1002', 'P1008', 'P1017'].includes(code ?? '')
  )
}

/**
 * Runs `fn` (the sale transaction), retrying up to `attempts` times ONLY on a
 * transient DB error, with exponential backoff (300ms/600ms/1200ms). The tx rolls
 * back fully on throw and `resolveIccid` re-checks AVAILABLE, so a retry is safe and
 * can't double-sell. This stops a ~5s DB blip mid-upload from dropping sales (prod
 * 2026-07-21: the DB OOM-restarted and 9 rows were lost — infra, not logic).
 */
async function runTxWithRetry<T>(fn: () => Promise<T>, iccid: string, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < attempts && isTransientDbError(err)) {
        const backoffMs = 300 * 2 ** (attempt - 1)
        logger.warn(
          `[MANUAL SALE] transient DB error on iccid=${iccid} (attempt ${attempt}/${attempts}), retrying in ${backoffMs}ms: ${(err as Error).message}`,
        )
        await sleep(backoffMs)
        continue
      }
      throw err
    }
  }
  throw lastErr
}

export async function createOneManualSale(
  orgId: string,
  actorStaffId: string,
  row: ManualSaleRowInput,
): Promise<CreateOneManualSaleResult> {
  try {
    const result: TxResult = await runTxWithRetry<TxResult>(
      () =>
        prisma.$transaction(async (tx): Promise<TxResult> => {
      // 1. Resolve the SIM (org-level; markAsSold sets sellingVenueId later).
      const iccidResult = await resolveIccid(orgId, row.iccid, tx)
      if (isError(iccidResult)) return { ok: false as const, error: iccidResult.error }
      const { item } = iccidResult

      // 2. Resolve the rest. On any error → return (tx rolls back; nothing created).
      const venueResult = await resolveVenue(orgId, row.storeName, row.storeId, tx)
      if (isError(venueResult)) return { ok: false as const, error: venueResult.error }
      const { venue } = venueResult

      const staffResult = await resolveStaffByCode(orgId, row.promoterCode, row.promoterName, tx)
      if (isError(staffResult)) return { ok: false as const, error: staffResult.error }
      const sellerStaffId = staffResult.staff.id

      // resolveCategory falls back to the SIM's own categoryId when the sheet's
      // "Tipo de SIM" column is empty (the controller-approved 4th arg).
      const categoryResult = await resolveCategory(orgId, row.simType, tx, item.categoryId ?? undefined)
      if (isError(categoryResult)) return { ok: false as const, error: categoryResult.error }

      const { method, amountApplies } = mapPaymentForm(row.paymentForm)
      const amount = parseAmount(row.amount, amountApplies)

      // 3. Venue-local calendar day → UTC. STRING + noon anchor (host-tz-safe).
      const venueTz = (venue as { timezone?: string | null }).timezone ?? VENUE_TIMEZONE_DEFAULT
      const soldAt = fromZonedTime(`${row.saleDate}T12:00:00`, venueTz)

      const zero = new Prisma.Decimal(0)
      const orderNumber = `ORD-EXT-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

      // 4. Order (shadow MANUAL_ENTRY). taxAmount is required on the model.
      const order = await tx.order.create({
        data: {
          venueId: venue.id,
          orderNumber,
          type: 'MANUAL_ENTRY',
          source: 'DASHBOARD_MANUAL',
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          subtotal: amount,
          taxAmount: zero,
          total: amount,
          paidAmount: amount,
          remainingBalance: zero,
          createdAt: soldAt,
          completedAt: soldAt,
          createdById: actorStaffId,
          servedById: sellerStaffId,
          posRawData: {
            manualSerializedSale: true,
            recordedByStaffId: actorStaffId,
            iccid: item.serialNumber,
            storeName: row.storeName,
          },
        },
      })

      // 5. OrderItem for the SIM. productName from category label; productSku
      //    carries the serial (matches the TPV serialized sell path).
      const orderItem = await tx.orderItem.create({
        data: {
          orderId: order.id,
          productName: row.simType?.trim() || 'SIM',
          quantity: 1,
          unitPrice: amount,
          taxAmount: zero,
          total: amount,
          productSku: item.serialNumber,
        },
      })

      // 6. Flip the SIM to SOLD (org-level → sets sellingVenueId = store venue).
      //    Pass the STORE venueId as where-it-was-sold + the seller as staffId.
      //    `skipCustodyCheck`: a manual back-office sale bypasses the TPV custody precheck.
      //    These SIMs were sold outside the TPV (promoter without a terminal), so they're
      //    still SUPERVISOR_HELD/ADMIN_HELD and never PROMOTER_HELD — under ENFORCE mode the
      //    precheck would throw SIM_NOT_ACCEPTED and roll back the whole row. resolveIccid's
      //    AVAILABLE gate above still blocks re-selling an already-sold SIM.
      await serializedInventoryService.markAsSold(venue.id, item.serialNumber, orderItem.id, tx, {
        staffId: sellerStaffId,
        skipCustodyCheck: true,
        // Backdate the SIM's soldAt to the real sale day (not the upload day).
        soldAt,
      })

      // 7. Payment (COMPLETED, pesos 1:1, no processor fees, net == amount).
      //    NOTE: `PaymentSource` has no DASHBOARD_MANUAL value (that lives on
      //    OrderSource, set on the Order above). Mirroring manualPayment.service,
      //    a dashboard-entered payment uses `OTHER` with the provenance carried
      //    in `externalSource` + `processorData.manualSerializedSale`.
      const payment = await tx.payment.create({
        data: {
          venueId: venue.id,
          orderId: order.id,
          amount,
          method,
          source: 'OTHER',
          externalSource: 'DASHBOARD_MANUAL',
          status: 'COMPLETED',
          processedById: actorStaffId,
          feePercentage: zero,
          feeAmount: zero,
          netAmount: amount,
          processorData: { manualSerializedSale: true },
          // Backdate to the real sale day so payment-dated reports agree with the sale.
          createdAt: soldAt,
        },
      })

      // 8. SaleVerification created directly COMPLETED (NOT createPendingSaleVerification,
      //    which hardcodes PENDING). Reviewer = the uploading actor, at soldAt.
      const normalizedIccid = item.serialNumber
      const verification = await tx.saleVerification.create({
        data: {
          venueId: venue.id,
          paymentId: payment.id,
          staffId: sellerStaffId,
          photos: [],
          scannedProducts: [],
          status: 'COMPLETED',
          inventoryDeducted: false,
          isPortabilidad: /portabilidad/i.test(row.saleType),
          serialNumbers: [normalizedIccid],
          // Backdate to the real sale day (row.saleDate). The org sales list + weekly/monthly
          // reports GROUP BY SaleVerification.createdAt, so leaving it at now() files a May
          // sale under July — the bug Isaac reported. Mirrors Order.createdAt above.
          createdAt: soldAt,
          reviewedById: actorStaffId,
          reviewedAt: soldAt,
        },
      })

      // 9. Return success + the audit payload. Audit itself runs OUTSIDE the tx
      //    (below) so an audit failure can't roll back the sale.
      const audit: ManualSaleAuditPayload = {
        serializedItemId: item.id,
        serialNumber: item.serialNumber,
        fromCustodyState: (item as { custodyState?: string | null }).custodyState ?? null,
        fromStaffId: (item as { assignedSupervisorId?: string | null }).assignedSupervisorId ?? null,
        sellerStaffId,
        storeName: row.storeName,
        amount: amount.toString(),
      }

      return { ok: true, orderId: order.id, verificationId: verification.id, venueId: venue.id, audit }
        }),
      row.iccid,
    )

    if (!result.ok) return { ok: false, error: result.error }

    // Post-tx, fire-and-forget audit dual-write (never blocks/rolls back). Only
    // reached when the tx committed with a successful sale.
    void logAction({
      action: 'MANUAL_SALE_CREATED',
      entity: 'Order',
      entityId: result.orderId,
      staffId: actorStaffId,
      venueId: result.venueId,
      data: {
        iccid: result.audit.serialNumber,
        sellerStaffId: result.audit.sellerStaffId,
        storeName: result.audit.storeName,
        amount: result.audit.amount,
      },
    })
    void writeCustodyEvent(result.audit, actorStaffId)

    return { ok: true, orderId: result.orderId, verificationId: result.verificationId, venueId: result.venueId }
  } catch (err) {
    logger.error(`[MANUAL SALE] createOneManualSale failed for iccid=${row.iccid}: ${(err as Error).message}`)
    return { ok: false, error: 'No se pudo registrar la venta' }
  }
}

/**
 * SerializedItemCustodyEvent (MARKED_SOLD) for the custody timeline — mirrors
 * temp-mark-sim-sold.ts. Fire-and-forget: swallows its own errors so a failed
 * audit write can never surface as a failed sale.
 */
async function writeCustodyEvent(audit: ManualSaleAuditPayload, actorStaffId: string): Promise<void> {
  try {
    await prisma.serializedItemCustodyEvent.create({
      data: {
        serializedItemId: audit.serializedItemId,
        serialNumber: audit.serialNumber,
        eventType: 'MARKED_SOLD',
        fromState: (audit.fromCustodyState as any) ?? null,
        toState: 'SOLD',
        fromStaffId: audit.fromStaffId,
        toStaffId: null,
        actorStaffId,
        payloadVersion: 1,
      },
    })
  } catch (err) {
    logger.error(`[MANUAL SALE] custody event write failed for serial=${audit.serialNumber}: ${(err as Error).message}`)
  }
}

/**
 * Bulk orchestrator for "Subir ventas fuera de TPV" — takes every parsed row
 * from the operator's sheet and either PREVIEWS (dry, read-only) or APPLIES
 * (writes, one sale per row) them. This is what the upload endpoint (Task 6)
 * and the dashboard upload UI call — `createOneManualSale` (above) handles
 * exactly one row; this function is the many-rows wrapper around it.
 *
 * Dedup happens FIRST, before either mode resolves/creates anything: rows are
 * deduplicated by NORMALIZED ICCID (trim + uppercase — matching how the
 * resolvers themselves compare, see `resolveIccid`'s `mode: 'insensitive'`
 * match). The first occurrence of a given ICCID is kept; every later
 * occurrence is short-circuited straight into `omitir` and never touches a
 * resolver or `createOneManualSale` — two rows racing for the same physical
 * SIM in the same upload would otherwise resolve identically and the second
 * would always fail anyway (once the first sells it), so surfacing it as an
 * upfront duplicate is a clearer signal to the operator than a generic
 * "ICCID ya vendido" from the second row.
 *
 * PREVIEW (`apply=false`): runs the resolvers directly, WITHOUT writing.
 * Resolvers are pure reads (`findFirst`/`findMany`), so they're called with
 * the base `prisma` client as their `tx` argument — no `$transaction` needed
 * for a dry run. A row's `resolveIccid` failure with `'ICCID ya vendido'`
 * lands in `omitir` (it's a legitimate reason to skip, not an input error);
 * any OTHER resolver error (bad ICCID, seller/venue/category not found)
 * lands in `error`. Every resolver must succeed for a row to land in
 * `crear`; preview does not create anything.
 *
 * APPLY (`apply=true`): calls `createOneManualSale` once per (deduped) row.
 * Each call opens and commits its OWN `$transaction` internally (Task 4) —
 * `bulkManualSales` never wraps the loop in a shared outer transaction, so
 * one row failing (e.g. the SIM got sold by a concurrent upload) can NEVER
 * roll back the rows that already committed successfully. Classification
 * mirrors preview: `{ok:true}` → `crear`, `{ok:false, error:'ICCID ya
 * vendido'}` → `omitir`, any other `{ok:false}` → `error`. `created` counts
 * the final `crear` length (only set in apply mode, per the brief).
 */
export interface RowResult {
  index: number
  iccid: string
  storeName: string
  motivo?: string
}

export interface BulkManualSalesResult {
  crear: RowResult[]
  omitir: RowResult[]
  error: RowResult[]
  created?: number
}

const ICCID_ALREADY_SOLD_ERROR = 'ICCID ya vendido'
const DUPLICATE_ICCID_ERROR = 'ICCID duplicado en el archivo'

/** trim + uppercase — matches the `mode: 'insensitive'` comparison `resolveIccid` itself uses. */
function normalizeIccid(iccid: string): string {
  return iccid.trim().toUpperCase()
}

export async function bulkManualSales(
  orgId: string,
  actorStaffId: string,
  rows: ManualSaleRowInput[],
  apply: boolean,
): Promise<BulkManualSalesResult> {
  const crear: RowResult[] = []
  const omitir: RowResult[] = []
  const error: RowResult[] = []

  // 1. Dedup by normalized ICCID — keep the first occurrence, short-circuit
  //    every later one into `omitir` before any resolver/create runs.
  const seenIccids = new Set<string>()
  const dedupedRows: Array<{ index: number; row: ManualSaleRowInput }> = []

  rows.forEach((row, index) => {
    const normalized = normalizeIccid(row.iccid)
    if (seenIccids.has(normalized)) {
      omitir.push({ index, iccid: row.iccid, storeName: row.storeName, motivo: DUPLICATE_ICCID_ERROR })
      return
    }
    seenIccids.add(normalized)
    dedupedRows.push({ index, row })
  })

  // 2. Classify each deduped row via the requested mode.
  for (const { index, row } of dedupedRows) {
    if (apply) {
      const result = await createOneManualSale(orgId, actorStaffId, row)
      if (result.ok) {
        crear.push({ index, iccid: row.iccid, storeName: row.storeName })
      } else if (result.error === ICCID_ALREADY_SOLD_ERROR) {
        omitir.push({ index, iccid: row.iccid, storeName: row.storeName, motivo: result.error })
      } else {
        error.push({ index, iccid: row.iccid, storeName: row.storeName, motivo: result.error })
      }
      continue
    }

    // Preview: run the resolvers directly, read-only, against the base
    // `prisma` client (no $transaction — nothing is written in preview).
    const iccidResult = await resolveIccid(orgId, row.iccid, prisma)
    if (isError(iccidResult)) {
      if (iccidResult.error === ICCID_ALREADY_SOLD_ERROR) {
        omitir.push({ index, iccid: row.iccid, storeName: row.storeName, motivo: iccidResult.error })
      } else {
        error.push({ index, iccid: row.iccid, storeName: row.storeName, motivo: iccidResult.error })
      }
      continue
    }
    const { item } = iccidResult

    const venueResult = await resolveVenue(orgId, row.storeName, row.storeId, prisma)
    if (isError(venueResult)) {
      error.push({ index, iccid: row.iccid, storeName: row.storeName, motivo: venueResult.error })
      continue
    }

    const staffResult = await resolveStaffByCode(orgId, row.promoterCode, row.promoterName, prisma)
    if (isError(staffResult)) {
      error.push({ index, iccid: row.iccid, storeName: row.storeName, motivo: staffResult.error })
      continue
    }

    const categoryResult = await resolveCategory(orgId, row.simType, prisma, item.categoryId ?? undefined)
    if (isError(categoryResult)) {
      error.push({ index, iccid: row.iccid, storeName: row.storeName, motivo: categoryResult.error })
      continue
    }

    crear.push({ index, iccid: row.iccid, storeName: row.storeName })
  }

  if (apply) {
    return { crear, omitir, error, created: crear.length }
  }
  return { crear, omitir, error }
}
