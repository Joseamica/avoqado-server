/**
 * IVA por producto, plan 2: confirmar que una venta VIEJA (contrato DESCONOCIDO) se cobró con IVA
 * incluido. Es la única salida para facturar con IVA mixto una venta anterior al plan (p. ej. los
 * cafés en grano de Testarudo). Ligada a la versión que la persona vio (condición 6 de Codex r6) y
 * auditada en la MISMA transacción: si el registro de auditoría falla, la venta NO cambia.
 *
 * No emite ni toca ningún CFDI — sólo corrige el dato que la facturación (plan 3) va a leer.
 *
 * B3b (Tarea 2): la versión sola no basta. El motor de descuentos, el cierre del cobro y el editor de
 * órdenes del dashboard cambian la venta SIN subir `version`. Por eso la vista previa trae una `huella`
 * de todo lo que le enseña a la persona (y de lo que identifica la venta), y confirmar exige esa huella:
 * se compara antes de escribir y se repite, campo por campo, en el WHERE del UPDATE.
 */
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'

const MOTIVOS = {
  yaConfirmada: 'Esta venta ya tiene un contrato de precio definido.',
  impuestoAparte: 'Esta venta separó el impuesto al cobrar; no se puede confirmar como «IVA incluido».',
  // Revisión final (F1): el motor de descuentos VIEJO le resta un 16% estimado a `taxAmount`
  // aunque la venta haya cobrado con IVA incluido, dejando `taxAmount < 0` — que NO es lo mismo
  // que «separó el impuesto» (taxAmount > 0). Decir eso ahí sería mentira; se bloquea igual, pero
  // con su propio mensaje, para que alguien lo revise a mano antes de confirmar.
  ajusteDescuentoAnterior: 'Esta venta trae un ajuste de IVA del motor de descuentos anterior; no se puede confirmar hasta revisarla.',
  // Revisión final (F3): una venta cancelada o borrada no se factura, sin importar su IVA.
  cancelada: 'Esta venta está cancelada; no se factura.',
  posSync: 'Esta venta llegó del puente de SoftRestaurant, que manda el impuesto aparte.',
  cotizacion: 'Esta venta salió de una cotización, que suma el IVA encima.',
} as const

// Mismo patrón que `venueSalesGuard.ts` (`Pick<Prisma.TransactionClient, 'venue'>`): un cliente
// mínimo que tanto `prisma` como el `tx` de una transacción satisfacen, sin `any`.
type Cliente = Pick<Prisma.TransactionClient, 'estimate'>

async function motivoNoConfirmable(
  db: Cliente,
  o: { id: string; taxAmount: unknown; source: string; contratoDePrecio: string; status: string },
): Promise<string | null> {
  if (o.contratoDePrecio !== 'DESCONOCIDO') return MOTIVOS.yaConfirmada
  // Orden fijado en la revisión final (F1): primero el impuesto separado de verdad (>0) — que es
  // una causa distinta del ajuste sucio del motor de descuentos (<0) y no pueden compartir
  // mensaje —, luego el estado de la venta (F3), luego el origen, y al final la cotización.
  if (Number(o.taxAmount) > 0) return MOTIVOS.impuestoAparte
  if (Number(o.taxAmount) < 0) return MOTIVOS.ajusteDescuentoAnterior
  if (o.status === 'CANCELLED' || o.status === 'DELETED') return MOTIVOS.cancelada
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
  status: true,
  paymentStatus: true,
  paidAmount: true,
  discountAmount: true,
} as const

const MENSAJE_CAMBIO_DESDE_LA_VISTA = 'La venta cambió desde que la revisaste. Vuelve a pedir la vista previa.'

/**
 * Huella de la venta tal como la vio la persona: todo lo que la vista previa le enseña o que identifica la
 * venta. Si cualquiera de esos datos cambia —aunque `version` no suba—, la huella cambia. Los importes van
 * con `toFixed(2)` para que un mismo Decimal dé siempre la misma cadena. Es una cadena opaca: nadie la
 * interpreta; sólo se compara.
 *
 * Codex (B3b, código r1, P2 #4): la composición lleva el folio COMPLETO, que no tiene límite de largo; como
 * texto plano, un folio de 250 caracteres daba una huella de 311 que el esquema HTTP rechazaba. Por eso sale
 * como SHA-256 en hex: 64 caracteres para cualquier venta (`LONGITUD_HUELLA_CONTRATO`). No es una firma: sólo
 * detecta cambios; quién puede confirmar lo decide el permiso. Las igualdades del UPDATE usan los valores
 * tipados de la orden, no la huella.
 */
export function huellaContrato(o: {
  version: number
  orderNumber: string
  createdAt: Date
  status: string
  total: unknown
  paidAmount: unknown
  discountAmount: unknown
  paymentStatus: string
}): string {
  const d = (x: unknown) => new Prisma.Decimal(String(x ?? 0)).toFixed(2)
  const composicion = [
    o.version,
    o.orderNumber,
    o.createdAt.toISOString(),
    o.status,
    d(o.total),
    d(o.paidAmount),
    d(o.discountAmount),
    o.paymentStatus,
  ].join('|')
  return createHash('sha256').update(composicion, 'utf8').digest('hex')
}

/** Largo fijo de `huellaContrato` (SHA-256 en hex). El esquema de la ruta topa la huella con este valor. */
export const LONGITUD_HUELLA_CONTRATO = 64

export interface VistaPreviaContrato {
  orderId: string
  orderNumber: string
  createdAt: Date
  totalMxn: number
  taxAmountMxn: number
  source: string
  contratoActual: string
  version: number
  // F3: para que quien confirme (o el mensaje del tool) nunca diga «cobrada» de una venta que no
  // se ha cobrado. `fechaLocal` NO vive aquí a propósito: este servicio no conoce el timezone del
  // venue — quien la necesite (el tool MCP) la calcula y la agrega al objeto que devuelve.
  status: string
  paymentStatus: string
  paidAmountMxn: number
  confirmable: boolean
  motivo?: string
  // B3b: lo que hay que devolver para confirmar (ver `huellaContrato`).
  huella: string
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
    status: o.status,
    paymentStatus: o.paymentStatus,
    paidAmountMxn: Number(o.paidAmount),
    confirmable: motivo === null,
    ...(motivo ? { motivo } : {}),
    huella: huellaContrato(o),
  }
}

export async function confirmarContratoIvaIncluido(p: {
  venueId: string
  orderId: string
  versionVista: number
  huellaVista: string
  staffId: string | null
  motivo: string
}): Promise<{ ok: true } | { ok: false; code: 'NO_ENCONTRADA' | 'NO_CONFIRMABLE' | 'CAMBIO_DESDE_LA_VISTA'; message: string }> {
  return prisma.$transaction(async tx => {
    const o = await tx.order.findFirst({ where: { id: p.orderId, venueId: p.venueId }, select: SELECT })
    if (!o) return { ok: false as const, code: 'NO_ENCONTRADA' as const, message: 'No encontré esa venta en este negocio.' }
    const motivo = await motivoNoConfirmable(tx, o)
    if (motivo) return { ok: false as const, code: 'NO_CONFIRMABLE' as const, message: motivo }
    // B3b: lo que la persona vio tiene que ser lo que hay. La huella cubre lo que `version` no ve
    // (descuentos, cobros y ediciones que no la suben). Si no coincide, no se escribe nada.
    if (huellaContrato(o) !== p.huellaVista) {
      return { ok: false as const, code: 'CAMBIO_DESDE_LA_VISTA' as const, message: MENSAJE_CAMBIO_DESDE_LA_VISTA }
    }
    // CAS: sólo si nadie tocó la venta desde la vista previa (version y huella) Y sigue siendo
    // elegible EN ESTE INSTANTE (F2 — TOCTOU). Entre la lectura de arriba y este UPDATE, otra
    // transacción puede haber cambiado taxAmount/source/status —o cualquier dato de la huella—
    // SIN tocar `version`: es exactamente lo que hacen el motor de descuentos viejo (F1), el
    // cierre del cobro y el editor de órdenes del dashboard. Repetir esos hechos en el WHERE hace
    // que Postgres los vuelva a comprobar contra el dato YA comprometido en el instante del
    // UPDATE, no contra el que leímos arriba (EvalPlanQual bajo READ COMMITTED). Las igualdades
    // de la huella usan los valores TIPADOS de `o` (no se interpreta la cadena): `o` ya pasó la
    // comparación de arriba, así que es lo que la persona vio. El vínculo con la cotización NO
    // puede cambiar tras convertirse (una orden no se "desconvierte"), así que ese sigue siendo
    // sólo un chequeo previo — no hace falta repetirlo en el WHERE.
    const r = await tx.order.updateMany({
      where: {
        id: o.id,
        venueId: p.venueId,
        version: p.versionVista,
        contratoDePrecio: 'DESCONOCIDO',
        taxAmount: 0,
        source: { not: 'POS' },
        // La igualdad ya excluye CANCELLED/DELETED: `motivoNoConfirmable` rechazó esos estados arriba.
        status: o.status,
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        total: o.total,
        paidAmount: o.paidAmount,
        discountAmount: o.discountAmount,
        paymentStatus: o.paymentStatus,
      },
      data: { contratoDePrecio: 'IVA_INCLUIDO', version: { increment: 1 } },
    })
    if (r.count === 0) {
      return { ok: false as const, code: 'CAMBIO_DESDE_LA_VISTA' as const, message: MENSAJE_CAMBIO_DESDE_LA_VISTA }
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
      // F8: snapshot de la venta al momento de confirmar — en pesos, nunca centavos — para poder
      // leer la bitácora sin tener que ir a buscar la orden aparte.
      data: {
        antes: 'DESCONOCIDO',
        despues: 'IVA_INCLUIDO',
        motivo: p.motivo,
        version: p.versionVista,
        orderNumber: o.orderNumber,
        total: Number(o.total),
        paidAmount: Number(o.paidAmount),
      },
    })
    return { ok: true as const }
  })
}
