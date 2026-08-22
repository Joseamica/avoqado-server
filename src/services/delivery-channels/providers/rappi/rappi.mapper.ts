/**
 * El pedido de Rappi → el contrato interno.
 *
 * 🔴 ESCRITO CONTRA LA DOCUMENTACIÓN, SIN UN PEDIDO REAL TODAVÍA. Los nombres de campo salen
 * del JSON que el portal imprime para `NEW_ORDER_SCHEDULED`, y la propia documentación dice
 * que `NEW_ORDER` manda "la misma información". Pero hay una cosa que ese ejemplo NO puede
 * decirnos, porque viene en ceros: **si los montos son pesos o centavos**.
 *
 * Por eso este módulo no adivina: comprueba que los renglones CUADREN contra el total y
 * revienta si no. Un error de unidades es un factor de 100, y prefiero que el primer pedido
 * real falle ruidosamente a que registre una venta de $1,250 como $12.50 —o al revés— y nadie
 * se entere hasta el corte. Es la misma red que ya atrapó el pedido de $0 en Uber.
 */
import { Prisma } from '@prisma/client'

import type { NormalizedDeliveryItem, NormalizedDeliveryOrder, NormalizedDeliveryPayment } from '../../core/types'

const D = (v: unknown): Prisma.Decimal => new Prisma.Decimal(typeof v === 'number' || typeof v === 'string' ? v : 0)

/** Tolerancia al cuadrar: un centavo por renglón, por el redondeo del proveedor. */
const TOLERANCIA_POR_RENGLON = 0.01

interface RappiItem {
  id?: string
  name?: string
  quantity?: number
  sku?: string
  price?: number
  unit_price_with_discount?: number
  unit_price_without_discount?: number
}

interface RappiOrderDetail {
  order_id?: string
  place_at?: string
  delivery_method?: string
  payment_method?: string
  totals?: {
    total_order?: number
    total_to_pay?: number
    charges?: Record<string, unknown>
    other_totals?: { tip?: number; total_rappi_pay?: number; total_rappi_credits?: number }
  }
  items?: RappiItem[]
}

export interface RappiOrderPayload {
  order_detail?: RappiOrderDetail
  customer?: { first_name?: string; last_name?: string; phone_number?: string; email?: string }
  store?: { internal_id?: string; external_id?: string; name?: string }
  action?: string
}

/**
 * ¿Este payload es un pedido PROGRAMADO?
 *
 * 🔴 Importa más de lo que parece: los programados llegan con **todos los montos en CERO**
 * —está documentado, son provisionales— y el ejemplo oficial lo muestra así. Ingerir eso como
 * venta registraría **$0 marcado como pagado**, que es exactamente el bug que ya ocurrió una
 * vez con Uber cuando faltaba el bloque de cargos. Aquí no es un caso raro: es el
 * comportamiento normal y documentado del proveedor.
 */
export function esPedidoProgramado(payload: RappiOrderPayload): boolean {
  return payload.action === 'scheduled'
}

/** El id de la tienda EN RAPPI, que es como se resuelve el venue. */
export function extraerStoreId(payload: RappiOrderPayload): string | null {
  // `external_id` primero: es NUESTRO identificador (`store_integration_id`), el que mapea a
  // nuestro venue. `internal_id` es el de Rappi y sirve de respaldo — en el ejemplo oficial
  // vienen iguales, porque `store_integration_id` es opcional y por default copia el de Rappi.
  const s = payload.store
  return s?.external_id?.trim() || s?.internal_id?.trim() || null
}

function nombreCliente(payload: RappiOrderPayload): string | undefined {
  const c = payload.customer
  const partes = [c?.first_name, c?.last_name].map(p => p?.trim()).filter(Boolean)
  return partes.length ? partes.join(' ') : undefined
}

function mapearItems(items: RappiItem[]): NormalizedDeliveryItem[] {
  return items.map((it, idx) => {
    const cantidad = Number.isFinite(it.quantity) && (it.quantity as number) > 0 ? (it.quantity as number) : 1

    // `unit_price_with_discount` manda sobre `price`: es lo que el cliente REALMENTE pagó por
    // unidad. Usar el precio sin descuento inflaría la venta y descuadraría contra el total.
    const unitario = D(it.unit_price_with_discount ?? it.price ?? 0)

    return {
      // El `sku` es NUESTRO identificador del producto (el que publicamos en el menú); el
      // `id` es el de Rappi. Se prefiere el sku para resolver el producto, igual que en Uber
      // se prefiere `external_data` sobre el id del proveedor.
      externalId: String(it.id ?? '').trim() || `rappi-sin-id-${idx}`,
      externalData: it.sku?.trim() || null,
      name: it.name?.trim() || 'Producto',
      quantity: cantidad,
      unitPrice: unitario.toFixed(2),
      total: unitario.mul(cantidad).toFixed(2),
      notes: null,
    }
  })
}

/**
 * Reparte el dinero entre "lo que liquida la plataforma" y "lo que el comercio cobra en mano".
 *
 * 🔴 `payment_method: "cash"` existe en Rappi y es común en México: el cliente le paga en
 * efectivo al repartidor. Ese efectivo **NO entra al cajón del comercio** —lo recibe el
 * repartidor y Rappi liquida después—, así que sigue siendo dinero liquidado por la
 * plataforma, no `cashDueSale`. Confundirlo haría que el arqueo de caja pida un efectivo que
 * nunca estuvo ahí, y el turno cerraría con faltante todos los días.
 *
 * ⚠️ SUPUESTO ABIERTO hasta tener un pedido real: que `total_to_pay` sea lo que se cobra por
 * la venta y `other_totals.tip` la propina. El bloque `charges` viene vacío en el único
 * ejemplo publicado y no sabemos qué trae — por eso `merchantFees` queda en 0 y el cuadre de
 * abajo se encarga de gritar si eso resulta falso.
 */
function mapearPago(detail: RappiOrderDetail, ventaRenglones: Prisma.Decimal): NormalizedDeliveryPayment {
  const propina = D(detail.totals?.other_totals?.tip ?? 0)
  const cero = new Prisma.Decimal(0).toFixed(2)

  return {
    currency: 'MXN',
    saleAmount: ventaRenglones.toFixed(2),
    merchantFees: cero,
    tipAmount: propina.toFixed(2),
    externallyPaidSale: ventaRenglones.toFixed(2),
    externallyPaidTip: propina.toFixed(2),
    cashDueSale: cero,
    cashDueTip: cero,
  }
}

/**
 * 🔴 LA RED QUE HACE SEGURO PUBLICAR ESTO SIN SANDBOX.
 *
 * Suma los renglones y los compara contra el total que manda Rappi. Si no cuadran, LANZA.
 *
 * Es lo que convierte los dos supuestos que no pude verificar —las unidades (¿pesos o
 * centavos?) y qué campo es el total bueno— de "bug silencioso que aparece en el corte" a
 * "el primer pedido real falla y dice exactamente por qué". Un factor de 100 en dinero no
 * puede descubrirse leyendo un reporte tres semanas después.
 */
function verificarCuadre(renglones: Prisma.Decimal, detail: RappiOrderDetail, orderId: string): void {
  const totalCrudo = detail.totals?.total_to_pay ?? detail.totals?.total_order
  // Sin total no hay nada contra qué cuadrar. No se inventa: se deja pasar el de los
  // renglones, que es el único dato firme, y el pedido igual entra a cocina.
  if (totalCrudo === undefined || totalCrudo === null) return

  const total = D(totalCrudo)
  const propina = D(detail.totals?.other_totals?.tip ?? 0)
  const esperado = total.minus(propina)
  const tolerancia = new Prisma.Decimal(TOLERANCIA_POR_RENGLON).mul(Math.max(1, detail.items?.length ?? 1))

  if (renglones.minus(esperado).abs().gt(tolerancia)) {
    throw new Error(
      `[Rappi] la venta no cuadra en el pedido ${orderId}: los renglones suman ${renglones.toFixed(2)} pero el total ` +
        `menos propina da ${esperado.toFixed(2)}. Revisa las UNIDADES (¿pesos o centavos?) y qué campo de \`totals\` ` +
        `es la venta antes de dar por buena esta integración.`,
    )
  }
}

export function normalizeRappiOrder(raw: unknown): NormalizedDeliveryOrder {
  const payload = (raw ?? {}) as RappiOrderPayload
  const detail = payload.order_detail ?? {}
  const orderId = String(detail.order_id ?? '').trim()

  if (!orderId) throw new Error('[Rappi] el pedido no trae `order_detail.order_id`')

  // 🔴 Un programado NO se convierte en venta: viene en ceros por diseño. Se rechaza aquí, en
  // el traductor, y no más adelante — dejarlo pasar significaría escribir $0 pagado en la base
  // y descubrirlo en el corte del día.
  if (esPedidoProgramado(payload)) {
    throw new Error(
      `[Rappi] el pedido ${orderId} es PROGRAMADO y sus montos vienen en cero (provisionales). ` +
        'No se convierte en venta: la venta nace cuando Rappi lo libera con `NEW_ORDER`.',
    )
  }

  const items = mapearItems(detail.items ?? [])
  if (items.length === 0) throw new Error(`[Rappi] el pedido ${orderId} no trae renglones`)

  const ventaRenglones = items.reduce((acc, it) => acc.plus(new Prisma.Decimal(it.total)), new Prisma.Decimal(0))
  verificarCuadre(ventaRenglones, detail, orderId)

  return {
    externalId: orderId,
    displayId: orderId,
    source: 'RAPPI' as NormalizedDeliveryOrder['source'],
    items,
    payment: mapearPago(detail, ventaRenglones),
    customer: {
      name: nombreCliente(payload),
      phone: payload.customer?.phone_number?.trim() || undefined,
    },
    raw,
    // Sin fecha en el contrato del webhook: se usa la de recepción. Es honesto —el momento en
    // que nos enteramos— y no inventa una precisión que no tenemos.
    placedAt: new Date(),
    scheduledFor: null,
  }
}
