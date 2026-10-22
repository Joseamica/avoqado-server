/**
 * El pedido de Rappi → el contrato interno.
 *
 * Escrito contra la documentación y calibrado con el recorrido real en el sandbox DEV (21-oct-2026, `recorrido-real.md`):
 * M2 midió las UNIDADES (pesos: `rappi.unidades.ts`) y M10 qué es del negocio en cada variante de entrega.
 *
 * 🔴 F1 (founder, 20-oct): la venta (`saleAmount`) es el precio COMPLETO de los renglones y `discountAmount` es SÓLO lo
 * que asume el negocio. Lo que asume Rappi no baja la venta: queda en el crudo y en el log del pedido.
 *
 * 🔴 Este módulo no adivina el dinero: comprueba que los renglones CUADREN contra `total_products` y revienta si no, y una
 * variante cuyo dinero no está calibrado (o que la caja tendría que cobrar: el bloque 2b) no se registra. Prefiero que un
 * pedido falle ruidosamente a que registre una venta de $1,250 como $12.50 —o al revés— y nadie se entere hasta el corte.
 * Ojo: ese cuadre atrapa un renglón mal leído, NO un factor de unidades equivocado (renglones y `total_products` pasan por el
 * mismo factor y cuadrarían parejo). La red contra el error de unidades es la medición M2 (factor 1, en pesos) más la
 * prueba que fija `FACTOR_MONEDA_RAPPI` en 1 (`rappi.unidades.ts`).
 */
import { Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'

import logger from '@/config/logger'
import { zonaValida } from '@/utils/datetime'

import { assertDeliveryMoneyInvariants } from '../../core/money'
import type { NormalizedDeliveryItem, NormalizedDeliveryOrder, NormalizedDeliveryPayment } from '../../core/types'
import { deRappiAPesos } from './rappi.unidades'

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
  /** «Precio unitario sin descuento»: es el que manda (F1). */
  price?: number
  /** 🔴 OBSOLETO desde el 1-nov-2022 y, en producción, rebajado por la parte del aliado (diferencia 4): NUNCA se lee. */
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
    /** «Total products without discounts»: contra éste cuadran los renglones. */
    total_products?: number
    /** 🔴 OBSOLETO desde el 1-nov-2022: no se lee. */
    total_products_with_discount?: number
    total_discounts?: number
    /** «Lo que recibe el restaurante»: en el recorrido real (M10) dijo exactamente qué es del negocio en cada variante. */
    total_order?: number
    /** La parte de los descuentos que asume el aliado. En producción incluye cupones; en el sandbox no (diferencia 6). */
    total_discount_by_partner?: number
    /** El mismo campo con el nombre de la API nueva. */
    totals_discount_by_partner?: number
    /** Lo que el cliente paga EN EFECTIVO al repartidor (repartidor propio o para recoger, en efectivo). */
    total_to_pay?: number
    /** Descuento que el soporte de Rappi le dio al cliente: lo asume Rappi. */
    discount_by_support?: number
    charges?: { shipping?: number; service_fee?: number } & Record<string, unknown>
    other_totals?: { tip?: number; total_rappi_pay?: number; total_rappi_credits?: number }
  }
  items?: RappiItem[]
  /**
   * Cada descuento con su reparto. Un descuento compartido llega en UNA entrada con las dos partes (sandbox) o en DOS, una
   * por quien lo paga (producción): la suma de `amount_by_partner` sale igual en los dos casos (diferencia 3).
   */
  discounts?: RappiDescuento[] | null
}

interface RappiDescuento {
  value?: number
  type?: string
  /** Lo que asume Rappi, en dinero. */
  amount_by_rappi?: number
  /** Lo que asume el aliado (el negocio), en dinero. */
  amount_by_partner?: number
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

    // 🔴 F1: `price` es el precio unitario SIN descuento, y es el que manda: la venta es el precio completo y el descuento
    // del negocio va aparte (`discountAmount`). `unit_price_with_discount` está obsoleto y en producción llega rebajado por
    // la parte del aliado: leerlo restaría ese descuento DOS veces. Todo monto pasa por el factor de `rappi.unidades.ts`.
    const unitario = deRappiAPesos(it.price)

    // 🔴 Los modificadores cuestan dinero y van EN el total del renglón. La glosario de
    // Rappi confirma que el `sku` es "el identificador que el ALIADO otorga" — el nuestro.
    const subitems = it.subitems ?? []
    const extras = subitems.map((sub, j) => ({
      sub,
      j,
      /** Cuántos de ESTE extra pidió por cada unidad del producto. */
      cantidadPropia: Number.isFinite(sub.quantity) && (sub.quantity as number) > 0 ? (sub.quantity as number) : 1,
      unitario: deRappiAPesos(sub.price),
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

/** Cómo se entrega el pedido: quién lo lleva decide de quién son el envío y la propina. */
export type MetodoDeEntrega = 'delivery' | 'marketplace' | 'pickup'

const METODOS_DE_ENTREGA: ReadonlySet<string> = new Set<MetodoDeEntrega>(['delivery', 'marketplace', 'pickup'])

/**
 * Las variantes cuyo dinero ya se midió con un pedido real (M10, 21-oct): `total_order` dijo qué es del negocio en cada
 * una. «A calibrar» = con un pedido del simulador de esa variante ANTES de habilitarla: una variante fuera de esta lista no
 * se registra con dinero adivinado.
 */
export const VARIANTES_CALIBRADAS: ReadonlySet<MetodoDeEntrega> = new Set<MetodoDeEntrega>(['delivery', 'marketplace', 'pickup'])

/**
 * Los métodos con que el CLIENTE le paga al repartidor del negocio (o en el mostrador, si recoge): la caja tendría que
 * cobrarlo, y eso es el bloque 2b. `pos_terminal` es inferencia (el repartidor lleva una terminal): se confirma con Rappi.
 * Cualquier otro método —Rappi agrega nuevos seguido y pide no validarlos— cuenta como pagado en línea.
 */
const COBRA_EL_NEGOCIO: ReadonlySet<string> = new Set(['cash', 'pos_terminal'])

/**
 * Un pedido real cuyo dinero esta fase todavía no registra. Queda FAILED visible con `codigo` exacto (el job lo trata como
 * terminal): nunca PROCESSED con dinero inventado.
 *  · `VARIANTE_BLOQUE_2B`: repartidor propio o para recoger, cobrado por el negocio (efectivo o terminal).
 *  · `VARIANTE_SIN_CALIBRAR`: una variante sin un pedido real que diga qué es del negocio.
 */
export class VariantePendienteError extends Error {
  constructor(
    readonly codigo: 'VARIANTE_BLOQUE_2B' | 'VARIANTE_SIN_CALIBRAR',
    mensaje: string,
  ) {
    super(mensaje)
    this.name = 'VariantePendienteError'
  }
}

export interface OpcionesDeTraduccion {
  /** Las variantes con dinero calibrado. Default: `VARIANTES_CALIBRADAS`. */
  calibradas?: ReadonlySet<MetodoDeEntrega>
  /** La zona IANA del negocio: `created_at` llega SIN zona y en la de la tienda. Sin ella (o inválida), la de México. */
  zonaHoraria?: string
}

const cero = () => new Prisma.Decimal(0)
const sumar = (montos: Prisma.Decimal[]) => montos.reduce((acc, m) => acc.plus(m), cero())
const centavos = (d: Prisma.Decimal) => d.toDecimalPlaces(2)

/** La variante de entrega del pedido. Desconocida o ausente LANZA: sin ella no se sabe de quién es el envío ni la propina. */
function metodoDeEntrega(detail: RappiOrderDetail, orderId: string): MetodoDeEntrega {
  const metodo = String(detail.delivery_method ?? '')
    .trim()
    .toLowerCase()
  if (!METODOS_DE_ENTREGA.has(metodo)) {
    throw new Error(
      `[Rappi] el pedido ${orderId} trae un \`delivery_method\` desconocido (${JSON.stringify(detail.delivery_method ?? null)}): ` +
        'sin saber quién lo entrega no se sabe de quién son el envío y la propina, y no se registra.',
    )
  }
  return metodo as MetodoDeEntrega
}

/**
 * ¿Esta variante se puede registrar en la fase 2? Si no, lanza `VariantePendienteError` con su código.
 *
 * 🔴 Con repartidor propio o para recoger, el efectivo (o la terminal) lo cobra el NEGOCIO: registrarlo como pagado por la
 * plataforma dejaría ese dinero fuera de la caja. Lo mismo si `total_to_pay` (lo que el cliente paga en efectivo al
 * repartidor) viene con algo, aunque el método sea uno que no conocemos. Con repartidor de Rappi, el efectivo lo cobra SU
 * repartidor y Rappi liquida: no es 2b.
 */
function verificarVariante(
  metodo: MetodoDeEntrega,
  detail: RappiOrderDetail,
  orderId: string,
  calibradas: ReadonlySet<MetodoDeEntrega>,
): void {
  const pago = String(detail.payment_method ?? '')
    .trim()
    .toLowerCase()
  if (metodo !== 'delivery' && (COBRA_EL_NEGOCIO.has(pago) || deRappiAPesos(detail.totals?.total_to_pay).gt(0))) {
    throw new VariantePendienteError(
      'VARIANTE_BLOQUE_2B',
      `[Rappi] variante pendiente: bloque 2b. El pedido ${orderId} es «${metodo}» y lo cobra el negocio ` +
        `(payment_method ${JSON.stringify(detail.payment_method ?? null)}, total_to_pay ${deRappiAPesos(detail.totals?.total_to_pay).toFixed(2)}): ` +
        'cobrarlo en la caja es el bloque 2b, y no se registra como pagado.',
    )
  }
  if (!calibradas.has(metodo)) {
    throw new VariantePendienteError(
      'VARIANTE_SIN_CALIBRAR',
      `[Rappi] variante pendiente: «${metodo}» no está calibrada con un pedido real (pedido ${orderId}). ` +
        'No se registra con dinero adivinado.',
    )
  }
}

/**
 * El descuento del NEGOCIO: Σ `discounts[].amount_by_partner` (F1). Lo que asume Rappi no baja la venta.
 *
 * `total_discount_by_partner` no manda: en el sandbox suma sólo los descuentos por producto y de monto fijo, y en
 * producción la parte del aliado de TODOS, cupones incluidos (diferencia 6). Si existe y no coincide, se loguea la
 * diferencia y se sigue. Lo que asumió Rappi (Σ `amount_by_rappi` y `discount_by_support`) va al log del pedido: en el
 * crudo ya queda, y mostrarlo en el panel es de la fase 3.
 */
function descuentoDelNegocio(detail: RappiOrderDetail, orderId: string): Prisma.Decimal {
  const descuentos = Array.isArray(detail.discounts) ? detail.discounts : []
  const delNegocio = sumar(descuentos.map(d => deRappiAPesos(d?.amount_by_partner)))
  const deRappi = sumar(descuentos.map(d => deRappiAPesos(d?.amount_by_rappi)))
  const deSoporte = deRappiAPesos(detail.totals?.discount_by_support)

  const declarado = detail.totals?.total_discount_by_partner ?? detail.totals?.totals_discount_by_partner
  if (declarado !== undefined && declarado !== null) {
    const declaradoEnPesos = deRappiAPesos(declarado)
    if (!centavos(declaradoEnPesos).equals(centavos(delNegocio))) {
      logger.warn('🛵 [Rappi] total_discount_by_partner no coincide con la suma de amount_by_partner: manda la suma', {
        orderId,
        sumaDeAmountByPartner: centavos(delNegocio).toFixed(2),
        totalDiscountByPartner: centavos(declaradoEnPesos).toFixed(2),
        diferencia: centavos(declaradoEnPesos.minus(delNegocio)).toFixed(2),
      })
    }
  }

  if (deRappi.gt(0) || deSoporte.gt(0)) {
    logger.info('🛵 [Rappi] descuentos que asumió Rappi: no bajan la venta del negocio', {
      orderId,
      asumidoPorRappi: centavos(deRappi).toFixed(2),
      descuentoDeSoporte: centavos(deSoporte).toFixed(2),
    })
  }
  return delNegocio
}

/**
 * Reparte el dinero según quién entrega (tabla del diseño §4.1.4, calibrada con M10):
 *
 *  · `delivery` (repartidor de Rappi): envío y tarifa de servicio son de Rappi, y la propina («Tip for the courier») de su
 *    repartidor ⇒ `merchantFees` 0 y propina 0.
 *  · `marketplace` pagado en línea (repartidor del negocio): el envío (`charges.shipping`) y la propina son del negocio. Rappi
 *    no le traspasa la tarifa de servicio.
 *  · `pickup` pagado en línea: `total_order` trajo SÓLO los productos aunque el aviso traiga envío, servicio y propina ⇒
 *    `merchantFees` 0 y propina 0.
 *
 * Lo liquida la plataforma: venta + `merchantFees` − descuento del negocio, y la propina. 🔴 Efectivo por cobrar en la caja:
 * SIEMPRE 0 en esta fase — lo que el negocio cobraría es el bloque 2b y no llega hasta aquí (`verificarVariante`). Con
 * repartidor de Rappi, el efectivo lo recibe SU repartidor: contarlo como efectivo del cajón dejaría el turno con faltante.
 */
function mapearPago(
  detail: RappiOrderDetail,
  metodo: MetodoDeEntrega,
  venta: Prisma.Decimal,
  descuentoCrudo: Prisma.Decimal,
): NormalizedDeliveryPayment {
  const esDelNegocio = metodo === 'marketplace'
  // Cada parte se lleva a centavos ANTES de sumar: así el reparto cuadra al centavo con lo que se guarda.
  const cargos = esDelNegocio ? centavos(deRappiAPesos(detail.totals?.charges?.shipping)) : cero()
  const propina = esDelNegocio ? centavos(deRappiAPesos(detail.totals?.other_totals?.tip)) : cero()
  const descuento = centavos(descuentoCrudo)

  return {
    currency: 'MXN',
    saleAmount: venta.toFixed(2),
    merchantFees: cargos.toFixed(2),
    discountAmount: descuento.toFixed(2),
    tipAmount: propina.toFixed(2),
    externallyPaidSale: venta.plus(cargos).minus(descuento).toFixed(2),
    externallyPaidTip: propina.toFixed(2),
    cashDueSale: cero().toFixed(2),
    cashDueTip: cero().toFixed(2),
  }
}

/**
 * 🔴 EL CUADRE DE LOS RENGLONES: los renglones (precio completo, con toppings) contra `total_products` («Total products
 * without discounts»). Si no cuadran, LANZA. Sin `total_products` también lanza: no se adivina con otro campo.
 *
 * ⚠️ NO es la red contra un error de unidades: ambos lados pasan por el MISMO factor (`deRappiAPesos`), así que un factor
 * mal puesto y parejo cuadra. Esa red es la medición M2 (factor 1, en pesos) más la prueba que fija `FACTOR_MONEDA_RAPPI` en
 * 1 (`rappi.unidades.ts`). Lo que este cuadre atrapa es un renglón, un topping o una cantidad mal leídos.
 *
 * No se cuadra contra `total_products_with_discount` (obsoleto) ni contra `total_order`, que según la variante trae envío
 * y propina o resta los descuentos del negocio.
 */
function verificarCuadre(renglones: Prisma.Decimal, detail: RappiOrderDetail, orderId: string): void {
  const total = detail.totals?.total_products
  if (total === undefined || total === null) {
    throw new Error(
      `[Rappi] el pedido ${orderId} no trae \`totals.total_products\`: sin él no se pueden comprobar las unidades y no se registra.`,
    )
  }
  const esperado = deRappiAPesos(total)
  const tolerancia = new Prisma.Decimal(TOLERANCIA_POR_RENGLON).mul(Math.max(1, detail.items?.length ?? 1))

  if (renglones.minus(esperado).abs().gt(tolerancia)) {
    throw new Error(
      `[Rappi] la venta no cuadra en el pedido ${orderId}: los renglones suman ${renglones.toFixed(2)} pero ` +
        `\`total_products\` da ${esperado.toFixed(2)}. Revisa las UNIDADES (\`FACTOR_MONEDA_RAPPI\`, medido en pesos) ` +
        'antes de registrar este pedido.',
    )
  }
}

/**
 * 🔴 Invariante del recorrido real (M10): pagado en línea, lo que liquida la plataforma (venta y propina) es exactamente
 * `total_order` («lo que recibe el restaurante»). Si difiere, se GRITA con los dos números y el pedido se registra igual: la
 * venta ya cuadró contra los renglones, y el que no cuadra es el reparto, que una persona revisa con Rappi.
 */
function vigilarTotalDelPedido(detail: RappiOrderDetail, metodo: MetodoDeEntrega, pago: NormalizedDeliveryPayment, orderId: string): void {
  const enLinea = !COBRA_EL_NEGOCIO.has(
    String(detail.payment_method ?? '')
      .trim()
      .toLowerCase(),
  )
  const totalOrder = detail.totals?.total_order
  if (!enLinea || totalOrder === undefined || totalOrder === null) return

  const liquidado = new Prisma.Decimal(pago.externallyPaidSale).plus(pago.externallyPaidTip)
  const declarado = deRappiAPesos(totalOrder)
  if (!centavos(liquidado).equals(centavos(declarado))) {
    logger.error('🚨 [Rappi] lo que liquida la plataforma no es total_order — el pedido se registra igual; revisar el reparto con Rappi', {
      orderId,
      metodoDeEntrega: metodo,
      totalOrder: centavos(declarado).toFixed(2),
      liquidaLaPlataforma: centavos(liquidado).toFixed(2),
    })
  }
}

/** ¿La fecha trae su zona (`Z` o `±hh:mm`)? */
const CON_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i

/**
 * La fecha de Rappi → Date.
 *
 * 🔴 `created_at` llega SIN zona y en la hora de la TIENDA (recorrido real: `2026-10-21 22:15:46` en Bogotá cuando aquí eran
 * las 21:15:46 CST). `new Date()` la leería en la zona del SERVIDOR (UTC en producción): 5 h corrida. Sin offset se lee en
 * la zona del negocio; con offset, tal cual. Una fecha ilegible NUNCA tumba el pedido: cae a «ahora».
 */
function fechaPedido(texto: string | undefined, zonaHoraria: string | undefined): Date {
  if (!texto || !texto.trim()) return new Date()
  const limpio = texto.trim()
  const d = CON_OFFSET.test(limpio) ? new Date(limpio) : fromZonedTime(limpio, zonaValida(zonaHoraria))
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

export function normalizeRappiOrder(raw: unknown, opts: OpcionesDeTraduccion = {}): NormalizedDeliveryOrder {
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

  // De quién es cada peso depende de quién entrega: primero la variante, y si esta fase no la registra, ni se mira el dinero.
  const metodo = metodoDeEntrega(detail, orderId)
  verificarVariante(metodo, detail, orderId, opts.calibradas ?? VARIANTES_CALIBRADAS)

  const items = mapearItems(detail.items ?? [])
  if (items.length === 0) throw new Error(`[Rappi] el pedido ${orderId} no trae renglones`)

  const venta = sumar(items.map(it => new Prisma.Decimal(it.total)))
  verificarCuadre(venta, detail, orderId)

  const payment = mapearPago(detail, metodo, venta, descuentoDelNegocio(detail, orderId))
  // 🔴 Las mismas invariantes que revisa la ingesta, aquí ANTES de aceptar: un reparto que la ingesta rechazaría (un
  // descuento del negocio mayor que la venta, un monto negativo) no se acepta en Rappi para luego no poder registrarlo.
  assertDeliveryMoneyInvariants(payment, items)
  vigilarTotalDelPedido(detail, metodo, payment, orderId)

  return {
    externalId: orderId,
    displayId: orderId,
    source: 'RAPPI' as NormalizedDeliveryOrder['source'],
    items,
    payment,
    customer: {
      name: nombreCliente(payload),
      phone: payload.customer?.phone_number?.trim() || undefined,
    },
    raw,
    // `created_at` es la hora REAL del pedido. Si faltara (o fuera ilegible) se usa el momento de recepción: es honesto
    // —cuándo nos enteramos— y no inventa precisión.
    placedAt: fechaPedido(detail.created_at, opts.zonaHoraria),
    scheduledFor: null,
  }
}
