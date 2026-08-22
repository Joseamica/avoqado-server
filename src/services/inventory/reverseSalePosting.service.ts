/**
 * Devuelve al inventario lo que una venta descontó, cuando esa venta se cae.
 *
 * 🔴 POR QUÉ NO EXISTÍA Y POR QUÉ IMPORTA: hasta el 2026-08-20 NINGÚN camino de la
 * plataforma devolvía stock — ni las cancelaciones de delivery ni los reembolsos. Un pedido
 * cancelado dejaba los ingredientes descontados para siempre: la comida nunca se hizo, pero
 * el sistema juraba que se gastó. El faltante aparecía semanas después en un conteo físico,
 * ya sin forma de rastrear de dónde salió.
 *
 * 🔴 LA DECISIÓN DE DISEÑO QUE HACE ESTO CORRECTO: se revierte leyendo los MOVIMIENTOS que
 * la venta dejó (`postingLineId`), no recalculando desde la orden. La diferencia no es
 * cosmética:
 *   · La receta pudo cambiar entre la venta y la cancelación — recalcular devolvería una
 *     cantidad distinta de la que se tomó.
 *   · PEPS tomó de LOTES concretos, cada uno con su costo. Devolver los 3 kg al lote activo
 *     en vez de repartirlos como salieron deja el costeo mal para siempre, y el reporte de
 *     margen miente sin que nada falle.
 * Los movimientos son el hecho consumado; la orden es sólo la intención.
 */
import { BatchStatus, MovementType, Prisma, RawMaterialMovementType } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

/**
 * 🔴 NO CONECTAR ESTO A LOS REEMBOLSOS SIN LEER ESTO PRIMERO.
 *
 * Parece el siguiente paso obvio —"ya existe la reversa, que los reembolsos también
 * devuelvan stock"— y es un error. Una CANCELACIÓN y un REEMBOLSO no son lo mismo:
 *
 *   · Cancelación: la comida NUNCA se hizo. Los ingredientes siguen en la bodega y el
 *     sistema debe reflejarlo. Es lo que hace este servicio.
 *   · Reembolso: la comida SÍ se hizo y se entregó, y el cliente se quejó. Los ingredientes
 *     ya no existen. Devolverlos INVENTA inventario que físicamente se consumió — y ese
 *     faltante aparece semanas después en un conteo, igual que el bug que este servicio vino
 *     a arreglar, pero en la dirección contraria.
 *
 * [mercado, verificado 2026-08-21] Los dos referentes lo tratan como DECISIÓN HUMANA, nunca
 * automática:
 *   · Toast pregunta "Return items to inventory" y el staff elige qué artículos se
 *     reingresan.
 *   · Square: una devolución POR ARTÍCULO pregunta si se reingresa; un reembolso POR MONTO
 *     asume que NO y no toca el inventario.
 *
 * O sea que el comportamiento actual —los reembolsos no devuelven stock— es el CORRECTO y
 * coincide con el mercado. Si algún día se quiere ofrecer el reingreso, va con una decisión
 * explícita por artículo en la UI del reembolso, no automático y no reusando esta función
 * tal cual (que revierte la venta COMPLETA y sería falso en un reembolso parcial).
 */
export type ReverseOutcome = 'REVERSED' | 'ALREADY_REVERSED' | 'NOTHING_TO_REVERSE'

export interface ReverseResult {
  outcome: ReverseOutcome
  /** Cuántos movimientos de devolución se escribieron. */
  movements: number
}

export async function reverseSalePosting(params: {
  venueId: string
  orderId: string
  reason: string
  staffId?: string | null
}): Promise<ReverseResult> {
  const { venueId, orderId, reason, staffId } = params

  const venta = await prisma.inventoryPosting.findUnique({
    where: { venueId_sourceKind_sourceId_effectKind: { venueId, sourceKind: 'ORDER', sourceId: orderId, effectKind: 'SALE' } },
    include: { lines: { select: { id: true } } },
  })

  // Sin venta aplicada no hay nada que devolver, y eso NO es un error: una orden puede
  // cancelarse antes de cobrarse, o el venue puede no llevar inventario.
  if (!venta || venta.lines.length === 0) return { outcome: 'NOTHING_TO_REVERSE', movements: 0 }

  const lineIds = venta.lines.map(l => l.id)
  const [movProducto, movMateria] = await Promise.all([
    prisma.inventoryMovement.findMany({ where: { postingLineId: { in: lineIds } } }),
    prisma.rawMaterialMovement.findMany({ where: { postingLineId: { in: lineIds } } }),
  ])

  const deducciones = {
    producto: movProducto.filter(m => m.quantity.lessThan(0)),
    materia: movMateria.filter(m => m.quantity.lessThan(0)),
  }
  if (deducciones.producto.length + deducciones.materia.length === 0) {
    return { outcome: 'NOTHING_TO_REVERSE', movements: 0 }
  }

  try {
    return await prisma.$transaction(async tx => {
      // 🔴 EL CANDADO DE IDEMPOTENCIA. Se crea PRIMERO, dentro de la transacción: el UNIQUE
      // (venueId, sourceKind, sourceId, effectKind) hace que un segundo intento reviente
      // aquí, ANTES de tocar una sola cantidad. Sin esto, un reintento del webhook —que son
      // at-least-once— infla el inventario: el mismo daño que el problema original, en la
      // dirección contraria y mucho más difícil de notar.
      const reversa = await tx.inventoryPosting.create({
        data: {
          venueId,
          sourceKind: 'ORDER',
          sourceId: orderId,
          effectKind: 'CANCELLATION',
          orderId,
          status: 'APPLIED',
          appliedAt: new Date(),
        },
      })

      let escritos = 0

      for (const m of deducciones.producto) {
        const cantidad = m.quantity.abs()
        const inv = await tx.inventory.update({
          where: { id: m.inventoryId },
          data: { currentStock: { increment: cantidad } },
        })
        await tx.inventoryMovement.create({
          data: {
            inventoryId: m.inventoryId,
            // `ADJUSTMENT` y no `PURCHASE`: no entró mercancía nueva, se deshizo una salida.
            // El enum no tiene un tipo "reversa" y agregarlo pide migración; el motivo lo
            // deja explícito para quien lea el kardex.
            type: MovementType.ADJUSTMENT,
            quantity: cantidad,
            previousStock: inv.currentStock.sub(cantidad),
            newStock: inv.currentStock,
            reason: `Devolución por venta cancelada: ${reason}`,
            reference: orderId,
            createdBy: staffId ?? null,
          },
        })
        escritos++
      }

      // Agrupado por lote: la venta pudo tomar del MISMO lote en varias líneas (producto y
      // modificador con el mismo ingrediente), y actualizarlo dos veces por separado deja
      // `previousStock`/`newStock` incoherentes en el kardex.
      const porLote = new Map<
        string,
        { batchId: string | null; rawMaterialId: string; unit: (typeof deducciones.materia)[number]['unit']; cantidad: Prisma.Decimal }
      >()
      for (const m of deducciones.materia) {
        const clave = `${m.rawMaterialId}::${m.batchId ?? 'sin-lote'}`
        const previo = porLote.get(clave)
        porLote.set(clave, {
          batchId: m.batchId,
          rawMaterialId: m.rawMaterialId,
          unit: m.unit,
          cantidad: (previo?.cantidad ?? new Prisma.Decimal(0)).add(m.quantity.abs()),
        })
      }

      for (const d of porLote.values()) {
        const mp = await tx.rawMaterial.update({
          where: { id: d.rawMaterialId },
          data: { currentStock: { increment: d.cantidad } },
        })

        if (d.batchId) {
          // Al lote EXACTO del que salió. Y si estaba agotado vuelve a ACTIVE con su
          // `depletedAt` limpio: dejarlo DEPLETED con cantidad > 0 lo esconde del motor
          // PEPS, o sea que ese stock existiría en el total pero nadie podría venderlo.
          await tx.stockBatch.update({
            where: { id: d.batchId },
            data: {
              remainingQuantity: { increment: d.cantidad },
              status: BatchStatus.ACTIVE,
              depletedAt: null,
            },
          })
        }

        await tx.rawMaterialMovement.create({
          data: {
            rawMaterialId: d.rawMaterialId,
            venueId,
            batchId: d.batchId,
            type: RawMaterialMovementType.ADJUSTMENT,
            quantity: d.cantidad,
            unit: d.unit,
            previousStock: mp.currentStock.sub(d.cantidad),
            newStock: mp.currentStock,
            reason: `Devolución por venta cancelada: ${reason}`,
            reference: orderId,
            createdBy: staffId ?? null,
          },
        })
        escritos++
      }

      await tx.inventoryPostingLine.create({
        data: {
          postingId: reversa.id,
          effectKey: `reversa:${orderId}`,
          expectedQuantityBase: new Prisma.Decimal(escritos),
          appliedQuantityBase: new Prisma.Decimal(escritos),
          status: 'APPLIED',
          reason,
        },
      })

      logger.info('♻️ [InventoryReverse] stock devuelto de una venta cancelada', {
        venueId,
        orderId,
        movimientos: escritos,
        motivo: reason,
      })
      return { outcome: 'REVERSED' as const, movements: escritos }
    })
  } catch (error) {
    // P2002 = el UNIQUE del posting de arriba: alguien ya revirtió esta orden. La
    // transacción entera se deshizo, así que NADA se devolvió dos veces.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { outcome: 'ALREADY_REVERSED', movements: 0 }
    }
    throw error
  }
}
