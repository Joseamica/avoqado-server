import { OriginSystem, Prisma, Product, SyncStatus } from '@prisma/client'
import logger from '../../config/logger'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import {
  assertLegacyCatalogGovernanceForVenue,
  writeLegacyServiceProductCreationAuditForVenue,
} from '../master-catalog/catalogGovernance.service'
import { lockExistingOrderForPayment } from '../shared/paymentShiftClaim'

interface OrderItemPayload {
  venueId: string
  parentOrderExternalId: string
  itemData: {
    externalId: string
    deleted: boolean
    productExternalId?: string
    productName?: string
    quantity?: number
    unitPrice?: number
    discountAmount?: number
    taxAmount?: number
    total?: number
    notes?: string | null
    posRawData?: Prisma.JsonValue
    sequence?: number
  }
}

/** The Product seen before the Order lock is gone; its placeholder needs the Venue fence, which only goes before the Order. */
class PlaceholderFenceRequired extends Error {}

/**
 * Procesa un evento de un item de orden desde el POS.
 */
export async function processPosOrderItemEvent(payload: OrderItemPayload) {
  const { parentOrderExternalId, itemData } = payload
  logger.info(`[🍔 PosSyncItem] Procesando item ${itemData.externalId} para orden ${parentOrderExternalId}`)
  try {
    return await applyPosOrderItemEvent(payload, false)
  } catch (error) {
    if (!(error instanceof PlaceholderFenceRequired)) throw error
    // WHY: the first transaction already rolled back. Starting over with the fence first keeps Venue → Order; the
    // fenced attempt creates the placeholder itself, so it never asks again (one bounded retry).
    return applyPosOrderItemEvent(payload, true)
  }
}

async function applyPosOrderItemEvent({ venueId, parentOrderExternalId, itemData }: OrderItemPayload, fenceFirst: boolean) {
  const parentNotFound = () => new NotFoundError(`La orden padre ${parentOrderExternalId} no fue encontrada. No se puede procesar el item.`)
  const parentKey = { venueId, externalId: parentOrderExternalId }

  const result = await prisma.$transaction(
    async tx => {
      const candidate = await tx.order.findUnique({ where: { venueId_externalId: parentKey }, select: { id: true } })
      if (!candidate) throw parentNotFound()

      // WHY: the same Order lock fiscal capture takes. Tenant and natural key are reread under it, so the line lands only
      // on the order that STILL is this venue's `parentOrderExternalId`. The imported POS header is the monetary
      // authority (IVA_APARTE): a line event never recomputes it. `createPlaceholder` is passed only while this
      // transaction already holds the Venue fence.
      const writeUnderOrderLock = async (createPlaceholder?: (productExternalId: string) => Promise<Product>) => {
        const locked = await lockExistingOrderForPayment(tx, { venueId, orderId: candidate.id })
        const parent = locked ? await tx.order.findFirst({ where: { id: candidate.id, ...parentKey }, select: { id: true } }) : null
        if (!parent) throw parentNotFound()

        // Caso 1: El item fue eliminado
        if (itemData.deleted) {
          const { count } = await tx.orderItem.deleteMany({ where: { orderId: parent.id, externalId: itemData.externalId } })
          return { deleted: count > 0, orderId: parent.id }
        }

        // Caso 2: Crear o actualizar el item
        if (!itemData.productExternalId) {
          throw new NotFoundError(`El payload para el item ${itemData.externalId} no tiene productExternalId.`)
        }
        // WHY: provenance is decided from this post-lock read: another creator may have won the fence first, and then
        // its Product is reused without a second CREATE audit.
        const product =
          (await findPosProduct(tx, venueId, itemData.productExternalId)) ??
          (createPlaceholder ? await createPlaceholder(itemData.productExternalId) : null)
        if (!product) throw new PlaceholderFenceRequired()

        const orderItem = await tx.orderItem.upsert({
          where: { orderId_externalId: { orderId: parent.id, externalId: itemData.externalId } },
          update: {
            quantity: itemData.quantity,
            unitPrice: itemData.unitPrice,
            discountAmount: itemData.discountAmount,
            taxAmount: itemData.taxAmount,
            total: itemData.total,
            notes: itemData.notes,
            posRawData: itemData.posRawData ?? undefined,
            syncStatus: SyncStatus.SYNCED,
            lastSyncAt: new Date(),
            sequence: itemData.sequence,
          },
          create: {
            order: { connect: { id: parent.id } },
            product: { connect: { id: product.id } },
            externalId: itemData.externalId,
            quantity: itemData.quantity || 1,
            unitPrice: itemData.unitPrice || 0,
            discountAmount: itemData.discountAmount || 0,
            taxAmount: itemData.taxAmount || 0,
            total: itemData.total || 0,
            notes: itemData.notes,
            posRawData: itemData.posRawData ?? undefined,
            originSystem: OriginSystem.POS_SOFTRESTAURANT,
            syncStatus: SyncStatus.SYNCED,
            sequence: itemData.sequence,
            lastSyncAt: new Date(),
          },
        })
        return { orderItem }
      }

      // WHY: lock order is [Venue fence] → Order → Product. deleteVenue holds Venue FOR UPDATE and then deletes Orders, so
      // the placeholder path takes the fence here, before the Order; the existing-product fast path never takes it. This
      // unlocked read only chooses the path: the Product actually used is read again under the Order lock.
      const needsFence =
        !itemData.deleted &&
        !!itemData.productExternalId &&
        (fenceFirst || !(await findPosProduct(tx, venueId, itemData.productExternalId)))
      if (!needsFence) return writeUnderOrderLock()

      await assertLegacyCatalogGovernanceForVenue(tx, {
        venueId,
        operation: 'CREATE',
        willBeVendable: true,
        actor: { type: 'SERVICE', servicePrincipalId: 'POS_SYNC' },
      })
      return writeUnderOrderLock(async productExternalId => {
        logger.info(`[🍔 PosSyncItem] Producto ${productExternalId} no encontrado. Creando placeholder...`)
        const product = await tx.product.upsert({
          where: { venueId_externalId: { venueId, externalId: productExternalId } },
          update: {
            price: itemData.unitPrice || 0,
            name: itemData.productName || 'Producto Desconocido',
          },
          create: {
            venue: { connect: { id: venueId } },
            category: {
              connectOrCreate: {
                where: { venueId_slug: { venueId, slug: 'pos-sync' } },
                create: { name: 'Sincronizado desde POS', venueId, slug: 'pos-sync' },
              },
            },
            externalId: productExternalId,
            name: itemData.productName || 'Producto Desconocido',
            sku: `pos-${productExternalId}`,
            price: itemData.unitPrice || 0,
            originSystem: OriginSystem.POS_SOFTRESTAURANT,
            syncStatus: SyncStatus.SYNCED,
          },
        })
        await writeLegacyServiceProductCreationAuditForVenue(tx, {
          venueId,
          productId: product.id,
          actor: { type: 'SERVICE', servicePrincipalId: 'POS_SYNC' },
        })
        return product
      })
    },
    { timeout: 15_000, maxWait: 5_000 },
  )

  if (result.orderItem) {
    logger.info(`[🍔 PosSyncItem] Item ${result.orderItem.id} (externalId: ${result.orderItem.externalId}) guardado/actualizado.`)
    return result.orderItem
  }
  if (result.deleted) logger.info(`[🍔 PosSyncItem] Item ${itemData.externalId} eliminado de la orden ${result.orderId}.`)
  else logger.warn(`[🍔 PosSyncItem] Se intentó borrar el item ${itemData.externalId} pero no existía.`)
  return { id: itemData.externalId, deleted: true }
}

function findPosProduct(tx: Prisma.TransactionClient, venueId: string, externalId: string): Promise<Product | null> {
  return tx.product.findUnique({ where: { venueId_externalId: { venueId, externalId } } })
}
