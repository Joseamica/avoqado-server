/**
 * Órdenes fantasma del cobro fallido a terminal (corrección de datos, sep-2026).
 *
 * ── Qué corrige ─────────────────────────────────────────────────────────────────────────────
 * El POS (avoqado-android 2.18.3 y anteriores) crea la orden en el servidor al entrar a «Cobrar»
 * y, si el cobro a la terminal falla —422, 409 «terminal busy», o el DELETE de la orden llega
 * mientras el cobro sigue en vuelo y el servidor lo rechaza con 409—, la orden se queda
 * CONFIRMED sin un solo pago. El cajero rehace la venta como orden nueva. El dinero entró UNA vez;
 * la orden abandonada infla «Ventas brutas» de la app y de Reportes → Resumen de ventas, que
 * suman `Order.subtotal` de toda orden no cancelada, pagada o no (Testarudo, 15-sep-2026: $695 en
 * 3 órdenes; 42 desde el 2-sep). La fuente ya está corregida en `main` de Android/iOS
 * (cancelación durable, 12-sep) pero sin publicar.
 *
 * ── Cómo decide ─────────────────────────────────────────────────────────────────────────────
 * `clasificarOrdenFantasma` es PURA y estricta a propósito: describe exactamente la clase medida
 * en producción, no «toda orden abierta». Cada regla que rechaza da su motivo para la lista que
 * aprueba el founder. La gemela (`emparejarGemela`) es informativa: ayuda a leer la lista, NO es
 * criterio — una fantasma sin gemela sigue siendo fantasma (el cliente pudo irse sin pagar), y una
 * orden con gemela pero con dinero encima jamás se cancela.
 *
 * Lo que NO hace: no toca inventario (nunca se dedujo: la deducción es al pagar), no libera mesa
 * (la clase es de mostrador, `tableId` nulo) y no decide el reporte — eso es decisión de producto
 * (ver `product-decisions-industry-reference.md`, precedente Square/Toast del 15-sep).
 */
import { Prisma } from '@prisma/client'

/** Estados de una solicitud de cobro a terminal cuyo desenlace todavía puede mover dinero. */
export const SOLICITUDES_VIVAS = ['PENDING', 'SENT', 'CANCEL_REQUESTED', 'UNKNOWN'] as const

/**
 * Edad mínima en minutos. Un cobro a terminal espera hasta 330 s y el POS puede reintentar; tres
 * horas dejan atrás cualquier venta en vuelo sin excluir las fantasmas del mismo día.
 */
export const EDAD_MINIMA_MIN = 180

/** Ventana en la que se busca la venta rehecha: las medidas van de 14 s a 163 s. */
export const VENTANA_GEMELA_SEG = 300

export type OrdenFoto = {
  id: string
  orderNumber: string
  status: string
  paymentStatus: string
  subtotal: Prisma.Decimal | number
  tableId: string | null
  createdAt: Date
  updatedAt: Date
  /** Filas de `Payment` de CUALQUIER estado ligadas a la orden. */
  pagos: number
  /** Solicitudes de cobro a terminal en un estado de `SOLICITUDES_VIVAS`. */
  solicitudesVivas: number
}

export type PagoFoto = {
  id: string
  orderId: string
  orderNumber: string
  orderSource: string
  orderSubtotal: Prisma.Decimal | number
  status: string
  type: string
  method: string
  createdAt: Date
}

export type Veredicto = { fantasma: true } | { fantasma: false; motivo: string }

export type Gemela = { orderNumber: string; method: string; source: string; segundos: number }

export function clasificarOrdenFantasma(o: OrdenFoto, ahora: Date, edadMinimaMin: number = EDAD_MINIMA_MIN): Veredicto {
  if (!Number.isFinite(edadMinimaMin) || edadMinimaMin < 1) {
    throw new Error(`La edad mínima tiene que ser al menos 1 minuto (recibí ${edadMinimaMin}).`)
  }
  // 🔴 Dinero primero: cualquier señal de que hubo cobro corta antes que las reglas de forma.
  if (o.paymentStatus !== 'PENDING') return no(`tiene dinero encima (paymentStatus=${o.paymentStatus})`)
  if (o.pagos > 0) return no(`tiene ${o.pagos} pago(s) registrado(s)`)
  if (o.solicitudesVivas > 0) return no(`tiene ${o.solicitudesVivas} cobro(s) a terminal sin desenlace`)
  if (o.status !== 'CONFIRMED') return no(`status=${o.status}; sólo CONFIRMED es de esta clase`)
  if (o.tableId) return no('ligada a una mesa: puede ser una cuenta abierta legítima')
  if (o.updatedAt.getTime() !== o.createdAt.getTime()) return no('fue tocada después de crearse')
  const edadMin = (ahora.getTime() - o.createdAt.getTime()) / 60_000
  if (edadMin < edadMinimaMin) return no(`demasiado reciente (${Math.floor(edadMin)} min, mínimo ${edadMinimaMin})`)
  return { fantasma: true }
}

/**
 * La venta rehecha: el primer cobro COMPLETED (no reembolso) de OTRA orden con el MISMO subtotal,
 * dentro de la ventana posterior a la creación de la fantasma. `pagos` puede venir sin ordenar.
 */
export function emparejarGemela(o: OrdenFoto, pagos: readonly PagoFoto[], ventanaSeg: number = VENTANA_GEMELA_SEG): Gemela | null {
  const desde = o.createdAt.getTime()
  const hasta = desde + ventanaSeg * 1_000
  const subtotal = new Prisma.Decimal(o.subtotal)
  const candidatas = pagos
    .filter(p => p.status === 'COMPLETED' && p.type !== 'REFUND' && p.orderId !== o.id)
    .filter(p => p.createdAt.getTime() >= desde && p.createdAt.getTime() <= hasta)
    .filter(p => new Prisma.Decimal(p.orderSubtotal).equals(subtotal))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const p = candidatas[0]
  if (!p) return null
  return {
    orderNumber: p.orderNumber,
    method: p.method,
    source: p.orderSource,
    segundos: Math.round((p.createdAt.getTime() - desde) / 1_000),
  }
}

function no(motivo: string): Veredicto {
  return { fantasma: false, motivo }
}
