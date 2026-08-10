import { OriginSystem, Prisma, Product, SyncStatus } from '@prisma/client'
import logger from '../../config/logger'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import {
  assertLegacyCatalogGovernanceForVenue,
  writeLegacyServiceProductCreationAuditForVenue,
} from '../master-catalog/catalogGovernance.service'

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

/**
 * Procesa un evento de un item de orden desde el POS.
 */
export async function processPosOrderItemEvent(payload: OrderItemPayload) {
  const { venueId, parentOrderExternalId, itemData } = payload
  logger.info(`[🍔 PosSyncItem] Procesando item ${itemData.externalId} para orden ${parentOrderExternalId}`)

  const parentOrder = await prisma.order.findUnique({
    where: { venueId_externalId: { venueId, externalId: parentOrderExternalId } },
  })

  if (!parentOrder) {
    // Podríamos re-en colar el mensaje aquí, pero por ahora lanzamos un error.
    throw new NotFoundError(`La orden padre ${parentOrderExternalId} no fue encontrada. No se puede procesar el item.`)
  }

  // Caso 1: El item fue eliminado
  if (itemData.deleted) {
    try {
      await prisma.orderItem.delete({
        where: { orderId_externalId: { orderId: parentOrder.id, externalId: itemData.externalId } },
      })
      logger.info(`[🍔 PosSyncItem] Item ${itemData.externalId} eliminado de la orden ${parentOrder.id}.`)
      // Aquí deberías recalcular los totales de la orden padre.
      return { id: itemData.externalId, deleted: true }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        logger.warn(`[🍔 PosSyncItem] Se intentó borrar el item ${itemData.externalId} pero no existía.`)
        return { id: itemData.externalId, deleted: true }
      }
      throw error
    }
  }

  // Caso 2: Crear o actualizar el item
  if (!itemData.productExternalId) {
    throw new NotFoundError(`El payload para el item ${itemData.externalId} no tiene productExternalId.`)
  }

  const orderItem = await prisma.$transaction(async tx => {
    const product = await getOrCreatePosProduct(
      tx,
      itemData.productExternalId as string,
      itemData.productName || 'Producto Desconocido',
      itemData.unitPrice || 0,
      venueId,
    )
    return tx.orderItem.upsert({
      where: { orderId_externalId: { orderId: parentOrder.id, externalId: itemData.externalId } },
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
        order: { connect: { id: parentOrder.id } },
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
  })

  logger.info(`[🍔 PosSyncItem] Item ${orderItem.id} (externalId: ${orderItem.externalId}) guardado/actualizado.`)
  // Aquí también deberías recalcular los totales de la orden padre.
  return orderItem
}

/**
 * Función de utilidad para encontrar un producto por su ID del POS, o crearlo si no existe.
 */
async function getOrCreatePosProduct(
  tx: Prisma.TransactionClient,
  externalId: string,
  name: string,
  price: number,
  venueId: string,
): Promise<Product> {
  const existing = await tx.product.findUnique({
    where: { venueId_externalId: { venueId, externalId } },
  })
  if (existing) return existing

  logger.info(`[🍔 PosSyncItem] Producto ${externalId} no encontrado. Creando placeholder...`)
  await assertLegacyCatalogGovernanceForVenue(tx, {
    venueId,
    operation: 'CREATE',
    willBeVendable: true,
    actor: { type: 'SERVICE', servicePrincipalId: 'POS_SYNC' },
  })
  // WHY: The first read is only a fast path. The Venue fence may wait behind
  // another creator, so provenance is decided from this post-lock reread.
  const createdWhileWaiting = await tx.product.findUnique({
    where: { venueId_externalId: { venueId, externalId } },
  })
  if (createdWhileWaiting) return createdWhileWaiting
  const product = await tx.product.upsert({
    where: { venueId_externalId: { venueId, externalId } },
    update: {
      price,
      name,
    },
    create: {
      venue: { connect: { id: venueId } },
      category: {
        connectOrCreate: {
          where: { venueId_slug: { venueId, slug: 'pos-sync' } },
          create: { name: 'Sincronizado desde POS', venueId, slug: 'pos-sync' },
        },
      },
      externalId,
      name: name,
      sku: `pos-${externalId}`,
      price,
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
}
