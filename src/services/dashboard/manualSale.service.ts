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

export async function createOneManualSale(
  orgId: string,
  actorStaffId: string,
  row: ManualSaleRowInput,
): Promise<CreateOneManualSaleResult> {
  try {
    const result: TxResult = await prisma.$transaction(async (tx): Promise<TxResult> => {
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
      await serializedInventoryService.markAsSold(venue.id, item.serialNumber, orderItem.id, tx, { staffId: sellerStaffId })

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
    })

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
