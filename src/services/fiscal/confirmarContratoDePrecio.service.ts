/**
 * IVA por producto, plan 2: confirmar que una venta VIEJA (contrato DESCONOCIDO) se cobró con IVA
 * incluido. Es la única salida para facturar con IVA mixto una venta anterior al plan (p. ej. los
 * cafés en grano de Testarudo). Ligada a la versión que la persona vio (condición 6 de Codex r6) y
 * auditada en la MISMA transacción: si el registro de auditoría falla, la venta NO cambia.
 *
 * No emite ni toca ningún CFDI — sólo corrige el dato que la facturación (plan 3) va a leer.
 */
import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'

const MOTIVOS = {
  yaConfirmada: 'Esta venta ya tiene un contrato de precio definido.',
  impuestoAparte: 'Esta venta separó el impuesto al cobrar; no se puede confirmar como «IVA incluido».',
  posSync: 'Esta venta llegó del puente de SoftRestaurant, que manda el impuesto aparte.',
  cotizacion: 'Esta venta salió de una cotización, que suma el IVA encima.',
} as const

// Mismo patrón que `venueSalesGuard.ts` (`Pick<Prisma.TransactionClient, 'venue'>`): un cliente
// mínimo que tanto `prisma` como el `tx` de una transacción satisfacen, sin `any`.
type Cliente = Pick<Prisma.TransactionClient, 'estimate'>

async function motivoNoConfirmable(
  db: Cliente,
  o: { id: string; taxAmount: unknown; source: string; contratoDePrecio: string },
): Promise<string | null> {
  if (o.contratoDePrecio !== 'DESCONOCIDO') return MOTIVOS.yaConfirmada
  if (Number(o.taxAmount) !== 0) return MOTIVOS.impuestoAparte
  if (o.source === 'POS') return MOTIVOS.posSync
  if ((await db.estimate.count({ where: { convertedOrderId: o.id } })) > 0) return MOTIVOS.cotizacion
  return null
}

const SELECT = {
  id: true,
  orderNumber: true,
  createdAt: true,
  total: true,
  taxAmount: true,
  source: true,
  contratoDePrecio: true,
  version: true,
} as const

export interface VistaPreviaContrato {
  orderId: string
  orderNumber: string
  createdAt: Date
  totalMxn: number
  taxAmountMxn: number
  source: string
  contratoActual: string
  version: number
  confirmable: boolean
  motivo?: string
}

export async function vistaPreviaContrato(venueId: string, orderId: string): Promise<VistaPreviaContrato | null> {
  const o = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: SELECT })
  if (!o) return null
  const motivo = await motivoNoConfirmable(prisma, o)
  return {
    orderId: o.id,
    orderNumber: o.orderNumber,
    createdAt: o.createdAt,
    totalMxn: Number(o.total),
    taxAmountMxn: Number(o.taxAmount),
    source: o.source,
    contratoActual: o.contratoDePrecio,
    version: o.version,
    confirmable: motivo === null,
    ...(motivo ? { motivo } : {}),
  }
}

export async function confirmarContratoIvaIncluido(p: {
  venueId: string
  orderId: string
  versionVista: number
  staffId: string | null
  motivo: string
}): Promise<{ ok: true } | { ok: false; code: 'NO_ENCONTRADA' | 'NO_CONFIRMABLE' | 'CAMBIO_DESDE_LA_VISTA'; message: string }> {
  return prisma.$transaction(async tx => {
    const o = await tx.order.findFirst({ where: { id: p.orderId, venueId: p.venueId }, select: SELECT })
    if (!o) return { ok: false as const, code: 'NO_ENCONTRADA' as const, message: 'No encontré esa venta en este negocio.' }
    const motivo = await motivoNoConfirmable(tx, o)
    if (motivo) return { ok: false as const, code: 'NO_CONFIRMABLE' as const, message: motivo }
    // CAS: sólo si nadie tocó la venta desde la vista previa, y sólo desde DESCONOCIDO.
    const r = await tx.order.updateMany({
      where: { id: o.id, venueId: p.venueId, version: p.versionVista, contratoDePrecio: 'DESCONOCIDO' },
      data: { contratoDePrecio: 'IVA_INCLUIDO', version: { increment: 1 } },
    })
    if (r.count === 0) {
      return {
        ok: false as const,
        code: 'CAMBIO_DESDE_LA_VISTA' as const,
        message: 'La venta cambió desde que la revisaste. Vuelve a pedir la vista previa.',
      }
    }
    // Dentro de la MISMA transacción: si el log no se puede escribir (p. ej. un staffId que
    // viola la FK), la excepción revierte también el UPDATE de arriba — nunca queda un contrato
    // confirmado sin su rastro de auditoría.
    await writeLegacyActivityAuditTx(tx, {
      staffId: p.staffId,
      venueId: p.venueId,
      action: 'ORDER_PRICE_CONTRACT_CONFIRMED',
      entity: 'Order',
      entityId: o.id,
      data: { antes: 'DESCONOCIDO', despues: 'IVA_INCLUIDO', motivo: p.motivo, version: p.versionVista },
    })
    return { ok: true as const }
  })
}
