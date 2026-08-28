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

interface RappiSubItem {
  id?: string
  sku?: string
  name?: string
  type?: string
  price?: number
  quantity?: number
}

interface RappiItem {
  id?: string
  name?: string
  quantity?: number
  sku?: string
  price?: number
  unit_price_with_discount?: number
  unit_price_without_discount?: number
  /** Lo que el cliente escribió para ESTE renglón ("sin cebolla"). */
  comments?: string
  /**
   * Los modificadores. 🔴 Se llaman `subitems`, no `modifiers` — y venían fuera del ejemplo
   * de webhook que publica el portal, así que la primera versión de este mapeo los tiraba a
   * la basura: la cocina no se enteraba del queso extra Y el dinero no cuadraba.
   */
  subitems?: RappiSubItem[]
}

interface RappiOrderDetail {
  order_id?: string
  created_at?: string
  place_at?: string
  delivery_method?: string
  payment_method?: string
  /** Minutos de preparación: Rappi manda su sugerencia y el rango permitido. */
  cooking_time?: number
  min_cooking_time?: number
  max_cooking_time?: number
  totals?: {
    total_products?: number
    /** El total DESPUÉS de descuentos. Es contra éste que cuadran los renglones. */
    total_products_with_discount?: number
    total_discounts?: number
    total_order?: number
    /** La parte de los descuentos que ABSORBE EL COMERCIO, no Rappi. */
    total_discount_by_partner?: number
    total_to_pay?: number
    charges?: { shipping?: number; service_fee?: number } & Record<string, unknown>
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

    // 🔴 Los modificadores cuestan dinero y van EN el total del renglón. La glosario de
    // Rappi confirma que el `sku` es "el identificador que el ALIADO otorga" — el nuestro.
    const subitems = it.subitems ?? []
    const extras = subitems.map((sub, j) => ({
      sub,
      j,
      /** Cuántos de ESTE extra pidió por cada unidad del producto. */
      cantidadPropia: Number.isFinite(sub.quantity) && (sub.quantity as number) > 0 ? (sub.quantity as number) : 1,
      unitario: D(sub.price ?? 0),
    }))

    // Lo que cuestan los extras en UNA unidad del producto. Es lo que multiplica `total`.
    const extrasPorUnidad = extras.reduce((acc, e) => acc.plus(e.unitario.mul(e.cantidadPropia)), new Prisma.Decimal(0))

    // 🔴 El reparto entre `price` y `quantity` NO es cosmético: el dashboard suma el ingreso
    // del renglón con `unitPrice × cantidad + Σ(price × quantity)` (`lineGrossSql`), y NO
    // multiplica los modificadores por la cantidad del padre. Así que ese producto tiene que
    // dar por sí solo la contribución COMPLETA del extra a la línea. El contrato lo fija
    // `core/types.ts`: `price` ya viene multiplicado por la cantidad del PADRE, `quantity` es
    // la cantidad PROPIA. Guardar el precio "a secas" reportaba de menos (2 ensaladas con
    // burrata: $230 sobre una venta de $260) y multiplicarlo por su propia cantidad reportaba
    // de más (1 ensalada con 2 burratas: $220 sobre $160). Los dos son dinero que no cuadra.
    //
    // El reparto tampoco se puede invertir aunque el producto salga igual: el KDS imprime
    // "2x Queso burrata" leyendo `quantity`, y en 2 ensaladas con una burrata cada una eso
    // le mentiría a la cocina.
    const modifiers = extras.map(({ sub, j, cantidadPropia, unitario }) => ({
      externalId: String(sub.sku ?? sub.id ?? '').trim() || `rappi-sub-${idx}-${j}`,
      name: sub.name?.trim() || 'Modificador',
      quantity: cantidadPropia,
      price: unitario.mul(cantidad).toFixed(2),
    }))

    return {
      // El `sku` es NUESTRO identificador del producto (el que publicamos en el menú); el
      // `id` es el de Rappi. Se prefiere el sku para resolver el producto, igual que en Uber
      // se prefiere `external_data` sobre el id del proveedor.
      externalId: String(it.id ?? '').trim() || `rappi-sin-id-${idx}`,
      externalData: it.sku?.trim() || null,
      name: it.name?.trim() || 'Producto',
      quantity: cantidad,
      unitPrice: unitario.toFixed(2),
      // El total del renglón incluye los modificadores. Sin ellos el cuadre contra el total
      // de Rappi falla siempre que alguien pida queso extra — o sea, casi siempre.
      total: unitario.plus(extrasPorUnidad).mul(cantidad).toFixed(2),
      // Lo que el cliente escribió. Es lo que separa servir bien de servir mal, y el único
      // lugar del sistema donde sobrevive.
      notes: it.comments?.trim() || null,
      ...(modifiers.length ? { modifiers } : {}),
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
  const t = detail.totals

  // 🔴 `total_products_with_discount` PRIMERO. Su propio FAQ lo dice: "el total del pedido con
  // descuentos aplicados" está en ese campo — y es contra ése que suman los renglones, porque
  // los renglones ya vienen con el precio con descuento. Cuadrar contra `total_order` metería
  // el envío y la cuota de servicio, y contra `total_products` (sin descuento) inflaría todo.
  //
  // Ojo: ese campo NO aparece en el ejemplo JSON del portal, sólo en el FAQ. La referencia y
  // el FAQ no coinciden, así que se intenta en cascada y se acepta el primero que exista.
  const totalCrudo = t?.total_products_with_discount ?? t?.total_products ?? t?.total_to_pay ?? t?.total_order
  // Sin total no hay nada contra qué cuadrar. No se inventa: se deja pasar el de los
  // renglones, que es el único dato firme, y el pedido igual entra a cocina.
  if (totalCrudo === undefined || totalCrudo === null) return

  // Si el total que encontramos incluye la propina (los que son del PEDIDO, no de los
  // productos), se resta antes de comparar.
  const incluyePropina = t?.total_products_with_discount === undefined && t?.total_products === undefined
  const esperado = incluyePropina ? D(totalCrudo).minus(D(t?.other_totals?.tip ?? 0)) : D(totalCrudo)
  const tolerancia = new Prisma.Decimal(TOLERANCIA_POR_RENGLON).mul(Math.max(1, detail.items?.length ?? 1))

  if (renglones.minus(esperado).abs().gt(tolerancia)) {
    throw new Error(
      `[Rappi] la venta no cuadra en el pedido ${orderId}: los renglones suman ${renglones.toFixed(2)} pero el total ` +
        `de referencia da ${esperado.toFixed(2)}. Revisa las UNIDADES (la documentación NO dice si los montos son ` +
        `pesos o centavos) y qué campo de \`totals\` es la venta antes de dar por buena esta integración.`,
    )
  }
}

/** ISO 8601 de Rappi → Date. Una fecha ilegible NUNCA tumba el pedido. */
function fechaPedido(iso?: string): Date {
  if (!iso) return new Date()
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

/**
 * Cuántos minutos declarar al aceptar, respetando el rango que Rappi permite.
 *
 * 🔴 Resulta que Rappi MANDA su propia sugerencia (`cooking_time`) y el rango válido
 * (`min`/`max`) dentro del pedido. O sea que el "dato que Avoqado no tiene" casi no existe:
 * el default correcto es devolverle el suyo. Sólo si algún día queremos declarar un tiempo
 * propio hay que recortarlo al rango, o la llamada se rechaza.
 */
export function tiempoDeCoccion(
  detail: { cooking_time?: number; min_cooking_time?: number; max_cooking_time?: number },
  propuesto?: number,
): number {
  const sugerido = Number.isFinite(detail.cooking_time) ? (detail.cooking_time as number) : 15
  const min = Number.isFinite(detail.min_cooking_time) ? (detail.min_cooking_time as number) : 1
  const max = Number.isFinite(detail.max_cooking_time) ? (detail.max_cooking_time as number) : 60
  const elegido = Number.isFinite(propuesto) ? (propuesto as number) : sugerido
  return Math.min(Math.max(elegido, min), max)
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
    // `created_at` viene en la respuesta de `getOrders` (ISO 8601). Si faltara se usa el
    // momento de recepción: es honesto —cuándo nos enteramos— y no inventa precisión.
    placedAt: fechaPedido(detail.created_at),
    scheduledFor: null,
  }
}
