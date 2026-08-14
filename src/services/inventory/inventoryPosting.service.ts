/**
 * InventoryPosting — el outbox durable de deducciones de inventario.
 *
 * Fase 2 del plan de remediación (auditoría 2026-08-12 + diseño Codex xhigh):
 * cada transición de venta a PAID crea su posting EN LA MISMA transacción del
 * cobro; el aplicador corre inmediatamente después del commit y el job de
 * respaldo reintenta lo pendiente. Con esto "¿esta venta ya dedujo?" deja de
 * inferirse por logs: se consulta, y un crash entre cobro y deducción deja un
 * posting PENDING visible en vez de una deducción perdida invisible.
 *
 * Invariantes:
 *  - UNIQUE (venueId, sourceKind, sourceId, effectKind): un solo posting SALE
 *    por venta. El duplicado devuelve el existente (idempotencia estructural).
 *  - El aplicador reclama con CAS (PENDING/PARTIAL_FAILED → APPLYING): dos
 *    workers jamás aplican el mismo posting a la vez.
 *  - Reintentable POR LÍNEA: una línea APPLIED nunca se re-deduce; solo las
 *    PENDING/FAILED se reintentan.
 *  - El negativo NO es fallo (Square-parity): la línea queda APPLIED y el
 *    faltante viaja como issue para el aviso del POS.
 *  - Un posting que no aplica lleva skipReason DURABLE — nunca silencio.
 */

import { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import {
  deductInventoryForProduct,
  getProductInventoryMethod,
} from '../dashboard/productInventoryIntegration.service'

/** Mismo shape estructural que OrderInventoryWarning['issues'] (payment.tpv). */
export type InventoryPostingIssue = {
  productId: string
  productName: string
  requested: number | null
  available: number | string | null
  reason: string
}

type SalePostingItem = {
  id: string
  productId: string | null
  productName?: string | null
  quantity: number
  weightQuantity?: Prisma.Decimal | number | string | null
  modifiers?: Array<{ quantity: number; modifier: Record<string, unknown> | null }> | null
}

const itemHasInventoryModifiers = (item: SalePostingItem): boolean =>
  !!item.modifiers?.some(m => (m.modifier as any)?.rawMaterialId && (m.modifier as any)?.quantityPerUnit)

/** Kilos para líneas por peso; piezas para el resto. */
const baseQuantity = (item: SalePostingItem): Prisma.Decimal =>
  item.weightQuantity != null ? new Prisma.Decimal(item.weightQuantity as any) : new Prisma.Decimal(item.quantity)

/**
 * Crea el posting SALE de una orden DENTRO de la transacción del cobro.
 * Una línea por item deducible; sin items deducibles → SKIPPED('NO_ITEMS');
 * `skipReason` explícito (p.ej. área-tickets que ya dedujeron en su propia
 * transacción) → SKIPPED sin líneas. El duplicado devuelve el existente.
 */
export async function createSalePostingInTx(
  tx: Prisma.TransactionClient,
  params: {
    venueId: string
    orderId: string
    items: SalePostingItem[]
    staffId?: string | null
    skipReason?: string
  },
) {
  const { venueId, orderId, skipReason } = params
  const items = params.items ?? []

  const lines: Array<{
    effectKey: string
    orderItemId: string
    productId: string
    expectedQuantityBase: Prisma.Decimal
  }> = []

  if (!skipReason) {
    for (const item of items) {
      if (!item.productId) continue
      const method = await getProductInventoryMethod(item.productId)
      if (!method && !itemHasInventoryModifiers(item)) continue
      lines.push({
        effectKey: item.id,
        orderItemId: item.id,
        productId: item.productId,
        expectedQuantityBase: baseQuantity(item),
      })
    }
  }

  const resolvedSkip = skipReason ?? (lines.length === 0 ? 'NO_ITEMS' : undefined)

  try {
    return await tx.inventoryPosting.create({
      data: {
        venueId,
        sourceKind: 'ORDER',
        sourceId: orderId,
        effectKind: 'SALE',
        orderId,
        ...(resolvedSkip ? { status: 'SKIPPED', skipReason: resolvedSkip } : {}),
        payloadSnapshot: {
          items: items.map(i => ({
            id: i.id,
            productId: i.productId,
            quantity: i.quantity,
            weightQuantity: i.weightQuantity != null ? String(i.weightQuantity) : null,
          })),
        },
        ...(lines.length > 0 ? { lines: { create: lines } } : {}),
      },
    })
  } catch (error) {
    // El UNIQUE hace el trabajo: un segundo cobro/replay de la misma venta
    // encuentra el posting original en vez de duplicar la deducción.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      logger.warn('🔄 [InventoryPosting] Posting duplicado — devolviendo el existente', { venueId, orderId })
      return tx.inventoryPosting.findUnique({
        where: {
          venueId_sourceKind_sourceId_effectKind: {
            venueId,
            sourceKind: 'ORDER',
            sourceId: orderId,
            effectKind: 'SALE',
          },
        },
      })
    }
    throw error
  }
}

/**
 * Aplica un posting SALE: reclama con CAS, deduce línea por línea (solo
 * PENDING/FAILED) y deja el estado final consultable. NUNCA lanza por un fallo
 * de deducción — el fallo queda en la línea y el posting en PARTIAL_FAILED
 * para que el job de respaldo lo reintente.
 *
 * @returns null si otro worker tiene el claim; si no, los issues para el aviso
 *          del POS (negativos y fallos) y si quedó completamente aplicado.
 */
export async function applySalePosting(
  postingId: string,
  staffId?: string | null,
): Promise<{ postingId: string; applied: boolean; issues: InventoryPostingIssue[] } | null> {
  const claim = await prisma.inventoryPosting.updateMany({
    where: { id: postingId, status: { in: ['PENDING', 'PARTIAL_FAILED'] } },
    data: { status: 'APPLYING', attempts: { increment: 1 } },
  })
  if (claim.count === 0) return null

  const posting = await prisma.inventoryPosting.findUnique({
    where: { id: postingId },
    include: { lines: true },
  })
  if (!posting) return null

  const orderItems = await prisma.orderItem.findMany({
    where: { orderId: posting.sourceId },
    include: { modifiers: { include: { modifier: true } } },
  })
  const itemsById = new Map(orderItems.map(item => [item.id, item]))

  const issues: InventoryPostingIssue[] = []
  let anyFailed = false

  for (const line of posting.lines) {
    if (line.status === 'APPLIED' || line.status === 'SKIPPED') continue

    const item = itemsById.get(line.orderItemId ?? line.effectKey)
    if (!item || !line.productId) {
      // La línea apunta a un item que ya no existe — se marca, no se inventa.
      await prisma.inventoryPostingLine.update({
        where: { id: line.id },
        data: { status: 'SKIPPED', reason: 'ORPHAN_LINE' },
      })
      continue
    }

    const orderModifiers =
      item.modifiers
        ?.filter((m: any) => m.modifier)
        .map((m: any) => ({
          quantity: m.quantity,
          modifier: {
            id: m.modifier.id,
            name: m.modifier.name,
            groupId: m.modifier.groupId,
            rawMaterialId: m.modifier.rawMaterialId,
            quantityPerUnit: m.modifier.quantityPerUnit,
            unit: m.modifier.unit,
            inventoryMode: m.modifier.inventoryMode,
          },
        })) ?? []

    const effectiveQuantity = Number(line.expectedQuantityBase)

    try {
      const result: any = await deductInventoryForProduct(
        posting.venueId,
        line.productId,
        effectiveQuantity,
        posting.orderId ?? posting.sourceId,
        staffId ?? undefined,
        orderModifiers,
        { postingLineId: line.id },
      )
      if (typeof result?.remainingStock === 'number' && result.remainingStock < 0) {
        issues.push({
          productId: line.productId,
          productName: result.productName || (item as any).productName || 'Producto',
          requested: effectiveQuantity,
          available: result.remainingStock,
          reason: 'la venta dejó el stock en negativo',
        })
      }
      await prisma.inventoryPostingLine.update({
        where: { id: line.id },
        data: { status: 'APPLIED', appliedQuantityBase: line.expectedQuantityBase, reason: null },
      })
    } catch (error: any) {
      anyFailed = true
      issues.push({
        productId: line.productId,
        productName: (item as any).productName || 'Producto',
        requested: effectiveQuantity,
        available: null,
        reason: error.message,
      })
      await prisma.inventoryPostingLine.update({
        where: { id: line.id },
        data: { status: 'FAILED', reason: error.message },
      })
      logger.error('❌ [InventoryPosting] Línea de posting falló — queda para reintento', {
        postingId,
        lineId: line.id,
        productId: line.productId,
        error: error.message,
      })
    }
  }

  await prisma.inventoryPosting.update({
    where: { id: postingId },
    data: anyFailed
      ? { status: 'PARTIAL_FAILED', lastError: issues.find(i => i.available === null)?.reason ?? 'línea fallida' }
      : { status: 'APPLIED', appliedAt: new Date(), lastError: null },
  })

  return { postingId, applied: !anyFailed, issues }
}
