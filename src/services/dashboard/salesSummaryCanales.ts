/**
 * Ventas por canal y por tipo de pedido del Resumen de ventas (carril G, hz:fefa11b6:D4, 22-nov-2026).
 *
 * «¿Cuánto vendí en línea, por Rappi, en el mostrador?» (canal, como el «source/channel» de Square) y «¿en el local, para llevar,
 * a domicilio?» (tipo de pedido, como el «dining option» de Toast). Cada tabla SUMA LA CABECERA de `getSalesSummary` al centavo:
 * son las MISMAS poblaciones de sus consultas 1 (cuentas), 3 (devoluciones), 5/8 (propinas y transacciones), 6 (comisión de
 * Avoqado) y 9 (comisión de terceros), repartidas por la cuenta de cada cobro. La regla de qué cuenta es venta y en qué fecha NO
 * vive aquí: es `salesSummaryPoblacion.ts` y `horaRealDelAparato.ts`. Si la cabecera cambia de regla, esto se cambia con ella; la
 * prueba de integración `sales-summary-canales` y el aviso `[canales] no cuadra` lo detectan.
 *
 * En la base y sin traer filas: dos enunciados con `GROUPING SETS` (canal y tipo), un puñado de renglones.
 * Sólo la vista de ventas (sin filtro de método ni de comercio): en la de movimientos no hay cuentas que repartir.
 */
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { utcTsParam } from '@/utils/sqlDates'
import { sqlRangoHoraReal } from '@/services/shared/horaRealDelAparato'
import { sqlImpuestoQueSeCobraAparte } from '@/services/shared/orderBalance'
import { sqlOrdenSinTarjetasTexto } from '@/services/giftCards/giftCardMarks'
import { sqlCobroDeCuentaSinCobrar, sqlComisionDeTerceros, sqlCuentaCobrada } from '@/services/dashboard/salesSummaryPoblacion'

/** Por dónde entró la venta, en nombres de dueño (los textos viven en el panel y en la tool del MCP). */
export type SalesChannel =
  | 'COUNTER'
  | 'TABLES'
  | 'KIOSK'
  | 'QR'
  | 'ONLINE_STORE'
  | 'WEB_CHECKOUT'
  | 'PAYMENT_LINK'
  | 'PHONE'
  | 'DASHBOARD'
  | 'RAPPI'
  | 'UBER_EATS'
  | 'DIDI_FOOD'
  | 'OTHER_DELIVERY'
  | 'QR_LEGACY'
  | 'OTHER'

/**
 * Cómo se entregó: `Order.type`, salvo dos que no son una forma de entrega. El cobro de un monto (TPV · PAGO RÁPIDO, el checkout
 * web, cripto: un cobro `FAST`) se guarda como `TAKEOUT` y no es «para llevar» (Codex r1 #6): va como `QUICK_PAYMENT`. El QR viejo
 * de Mindform no tiene cuenta ni tipo.
 */
export type SalesOrderType = 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'PICKUP' | 'MANUAL_ENTRY' | 'QUICK_PAYMENT' | 'QR_LEGACY' | 'OTHER'

export interface SalesBreakdownRow<K extends string = string> {
  key: K
  /** Las mismas unidades que la cabecera: `grossSales − discounts − refunds = netSales`. */
  grossSales: number
  discounts: number
  refunds: number
  netSales: number
  tips: number
  /** Comisión de Avoqado (`platformFees` de la cabecera). */
  platformFees: number
  /** Comisión de terceros: Rappi, Uber Eats, DiDi, tipos de pago propios (`tenderCommissions`). */
  tenderCommissions: number
  /** Neto cobrado (`totalCollected`): ventas netas + propinas − las dos comisiones (puede diferir $0.01 de su renglón por el reparto). */
  totalCollected: number
  /** Cuentas que son venta. `null` en el QR viejo de Mindform: sus cobros no traen cuenta. */
  orderCount: number | null
  /** Cobros (sin devoluciones), como `transactionCount`. */
  transactionCount: number
  refundCount: number
}

export interface SalesByChannel {
  byChannel: SalesBreakdownRow<SalesChannel>[]
  byOrderType: SalesBreakdownRow<SalesOrderType>[]
}

/** Lo que el puente de cobros QR viejos (sólo Mindform) sumó a la cabecera: venta, propina y cobros, sin cuenta. */
export interface LegacyQrAggregate {
  amount: number
  tips: number
  count: number
}

/** Las fuentes de caja, terminal o tablet: «Mesas» si la cuenta tenía mesa, «Mostrador» si no. */
const FUENTES_DEL_LOCAL = new Set(['TPV', 'POS', 'AVOQADO_ANDROID', 'AVOQADO_IOS', 'APP'])

const CANAL_DE_FUENTE: Record<string, SalesChannel> = {
  KIOSK: 'KIOSK',
  QR: 'QR',
  PAYMENT_LINK: 'PAYMENT_LINK',
  PHONE: 'PHONE',
  DASHBOARD_MANUAL: 'DASHBOARD',
  RAPPI: 'RAPPI',
  UBER_EATS: 'UBER_EATS',
  DIDI_FOOD: 'DIDI_FOOD',
  DELIVERY_PLATFORM: 'OTHER_DELIVERY',
}

/**
 * `Order.source` (+ ¿tenía mesa? + ¿es un pedido de la tienda?) ⇒ canal. `WEB` es la tienda en línea sólo si la cuenta tiene su
 * pedido en línea; si no, es el checkout de un monto (Codex r1 #7). Una fuente que no conocemos va a «Otro»: nunca sale de la suma.
 */
export function canalDeLaCuenta(source: string, tieneMesa: boolean, esDeLaTienda = false): SalesChannel {
  if (FUENTES_DEL_LOCAL.has(source)) return tieneMesa ? 'TABLES' : 'COUNTER'
  if (source === 'WEB') return esDeLaTienda ? 'ONLINE_STORE' : 'WEB_CHECKOUT'
  return CANAL_DE_FUENTE[source] ?? 'OTHER'
}

const TIPOS: ReadonlySet<string> = new Set(['DINE_IN', 'TAKEOUT', 'DELIVERY', 'PICKUP', 'MANUAL_ENTRY'])
export function tipoDeLaCuenta(type: string, esCobroDeUnMonto = false): SalesOrderType {
  if (esCobroDeUnMonto) return 'QUICK_PAYMENT'
  return TIPOS.has(type) ? (type as SalesOrderType) : 'OTHER'
}

const CAMPOS_DE_DINERO = [
  'grossSales',
  'discounts',
  'refunds',
  'netSales',
  'tips',
  'platformFees',
  'tenderCommissions',
  'totalCollected',
] as const
type CampoDeDinero = (typeof CAMPOS_DE_DINERO)[number]
type Crudo = Record<CampoDeDinero, number> & { orderCount: number | null; transactionCount: number; refundCount: number }

/** Lo que dice la cabecera de cada importe (`summary` de `getSalesSummary`): cada tabla se reparte hasta esa cifra. */
export type CabeceraDeCanales = Partial<Record<CampoDeDinero, number | null>>

const vacio = (): Crudo => ({
  grossSales: 0,
  discounts: 0,
  refunds: 0,
  netSales: 0,
  tips: 0,
  platformFees: 0,
  tenderCommissions: 0,
  totalCollected: 0,
  orderCount: 0,
  transactionCount: 0,
  refundCount: 0,
})

/**
 * Reparte `total` (en centavos) entre los importes crudos por «mayor residuo»: cada renglón queda redondeado y Σ renglones = el total.
 * Sin esto, la comisión de Avoqado (4 decimales por cobro) daba $0.01 de diferencia entre la tabla y la cabecera con dos canales de
 * $0.005. Empates: el renglón que va primero. Exportada para probarla sola.
 */
export function repartirCentavos(crudos: number[], totalEnCentavos: number): number[] {
  const escalados = crudos.map(v => v * 100)
  const pisos = escalados.map(v => Math.floor(v + 1e-9))
  let faltan = totalEnCentavos - pisos.reduce((s, v) => s + v, 0)
  const orden = escalados.map((v, i) => ({ i, resto: v - pisos[i] })).sort((a, b) => b.resto - a.resto || a.i - b.i)
  const out = [...pisos]
  // Normalmente 0 ≤ faltan < renglones (sólo redondeo). Más que eso lo detiene `cerrar` antes de llegar aquí.
  for (let k = 0; faltan !== 0 && orden.length > 0; k = (k + 1) % orden.length) {
    const paso = faltan > 0 ? 1 : -1
    out[orden[k].i] += paso
    faltan -= paso
  }
  return out
}

/**
 * Centavos de un importe COMO LOS ENSEÑA LA PANTALLA: el formateador redondea el valor exacto del número, no `n * 100` (Codex r1 #4:
 * $6.30 − $0.3150 es 5.984999… y se ve $5.98, pero `Math.round(598.5)` da 599). `toFixed` redondea igual que `Intl` en positivos;
 * el signo va aparte para que un negativo redondee como su valor absoluto.
 */
export const centavosComoSeVen = (n: number): number => Math.sign(n) * Math.round(Number(Math.abs(n).toFixed(2)) * 100)
const centavos = centavosComoSeVen

function cerrar<K extends string>(grupos: Map<K, Crudo>, cabecera: CabeceraDeCanales, ctx: { venueId: string; tabla: string }) {
  const llaves = [...grupos.keys()]
  const crudos = llaves.map(k => grupos.get(k)!)
  const redondeados = new Map<CampoDeDinero, number[]>()
  for (const campo of CAMPOS_DE_DINERO) {
    const valores = crudos.map(c => c[campo])
    const propio = centavos(valores.reduce((s, v) => s + v, 0))
    // El objetivo es la cifra que enseña la cabecera (Codex r1 #4: su resta en `Number` puede redondear $0.01 distinto). Si difiere
    // más que el redondeo de los renglones, NO se esconde la diferencia repartiéndola: es que las poblaciones ya no son las mismas.
    const deLaCabecera = cabecera[campo]
    let objetivo = propio
    if (typeof deLaCabecera === 'number') {
      const suyo = centavos(deLaCabecera)
      if (Math.abs(suyo - propio) <= 1) objetivo = suyo
      else logger.error('[canales] no cuadra con la cabecera', { ...ctx, campo, cabecera: suyo / 100, tabla: propio / 100 })
    }
    redondeados.set(campo, repartirCentavos(valores, objetivo))
  }
  return llaves
    .map((key, i) => {
      const fila = { key } as SalesBreakdownRow<K>
      for (const campo of CAMPOS_DE_DINERO) fila[campo] = redondeados.get(campo)![i] / 100
      fila.orderCount = crudos[i].orderCount
      fila.transactionCount = crudos[i].transactionCount
      fila.refundCount = crudos[i].refundCount
      return fila
    })
    .filter(f => CAMPOS_DE_DINERO.some(c => f[c] !== 0) || (f.orderCount ?? 0) + f.transactionCount + f.refundCount > 0)
    .sort((a, b) => b.netSales - a.netSales || a.key.localeCompare(b.key))
}

type Marcas = {
  source: string | null
  mesa: boolean | null
  tienda: boolean | null
  tipo: string | null
  monto: boolean | null
  por_tipo: number
}
type FilaDeCuentas = Marcas & { bruto: string; descuentos: string; promo_centavos: string; cortesias: string; cuentas: number }
type FilaDeCobros = Marcas & {
  propinas: string
  cobros: number
  comision: string
  terceros: string
  devuelto: string
  reabierto: string
  devoluciones: number
  devoluciones_de_abono: number
}

/** La comisión de UN cobro: la misma `SQL_COMISION_DEL_COBRO` de la cabecera (costo 1:1, o la del cobro en línea de Avoqado). */
const SQL_COMISION_DEL_COBRO = `CASE WHEN tc."id" IS NOT NULL THEN COALESCE(tc."venueChargeAmount", 0) + COALESCE(tc."venueFixedFee", 0) WHEN p."fundsFlow" = 'AVOQADO_PROCESSED' OR p."ecommerceMerchantId" IS NOT NULL THEN COALESCE(p."feeAmount", 0) ELSE 0 END`

/** Las marcas de una cuenta `o` que deciden su canal y su tipo: mesa, pedido de la tienda y cobro de un monto (`FAST`). */
const marcasDe = (o: string) => `
  CROSS JOIN LATERAL (
    SELECT (${o}."tableId" IS NOT NULL) AS mesa,
           (${o}.source = 'WEB' AND EXISTS (SELECT 1 FROM "OnlineOrder" oo WHERE oo."orderId" = ${o}.id)) AS tienda,
           EXISTS (SELECT 1 FROM "Payment" pf WHERE pf."orderId" = ${o}.id AND pf.type = 'FAST') AS monto
  ) marca`
const AGRUPAR = (o: string) => `GROUP BY GROUPING SETS ((${o}.source, marca.mesa, marca.tienda), (${o}.type, marca.monto))`
const COLUMNAS_DE_MARCA = (o: string) =>
  `${o}.source::text AS source, marca.mesa, marca.tienda, ${o}.type::text AS tipo, marca.monto, GROUPING(${o}.type)::int AS por_tipo`

/**
 * El desglose por canal y por tipo de pedido del rango, en la vista de ventas.
 *
 * @param cabecera la `summary` ya calculada: cada columna se reparte hasta su cifra (al centavo de lo que enseña la pantalla).
 * @param legacy lo que el puente QR de Mindform ya sumó a la cabecera (renglón «QR (sistema anterior)» en las dos tablas).
 * @param db cliente de lectura: la transacción de la foto única del reporte cuando exista (D17/D18), o el de siempre.
 */
export async function computeSalesByChannel(
  venueId: string,
  start: Date,
  end: Date,
  opts: { cabecera?: CabeceraDeCanales; legacy?: LegacyQrAggregate | null; db?: Pick<typeof prisma, '$queryRawUnsafe'> } = {},
): Promise<SalesByChannel> {
  const db = opts.db ?? prisma
  const [cuentas, cobros] = await Promise.all([
    // La consulta 1 de la cabecera, con la misma población (cuentas que son venta, sin tarjetas de regalo, por su hora real).
    db.$queryRawUnsafe<FilaDeCuentas[]>(
      `
      SELECT ${COLUMNAS_DE_MARCA('"Order"')},
             COALESCE(SUM("Order".subtotal + ${sqlImpuestoQueSeCobraAparte()} + "Order"."serviceChargeAmount"), 0)::text AS bruto,
             COALESCE(SUM(LEAST("Order"."discountAmount", "Order".subtotal)), 0)::text AS descuentos,
             COALESCE(SUM(promo.discount_cents), 0)::text AS promo_centavos,
             COALESCE(SUM(comp.given_away), 0)::text AS cortesias,
             COUNT(*)::int AS cuentas
      FROM "Order"
      ${marcasDe('"Order"')}
      LEFT JOIN LATERAL (
        SELECT SUM("discountCents") AS discount_cents FROM "OrderPromotion" WHERE "orderId" = "Order".id
      ) promo ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM("discountAmount") AS given_away FROM "OrderItem" WHERE "orderId" = "Order".id AND "isCortesia" = TRUE AND total = 0
      ) comp ON TRUE
      WHERE "Order"."venueId" = $1
        AND ${sqlRangoHoraReal('"Order"', utcTsParam(2), utcTsParam(3))}
        AND "Order".status NOT IN ('PENDING', 'CANCELLED', 'DELETED')
        AND ${sqlOrdenSinTarjetasTexto('"Order".id')}
        AND ${sqlCuentaCobrada('"Order"')}
      ${AGRUPAR('"Order"')}
      `,
      venueId,
      start,
      end,
    ),
    // TODOS los cobros del rango con su cuenta, cada métrica con la condición de su consulta en la cabecera: propinas y
    // transacciones (5/8), comisión de Avoqado (6, también filas de costo de cobros no completados), de terceros (9) y
    // devoluciones (3, de cualquier día de venta y con lo que sólo regresó un abono).
    db.$queryRawUnsafe<FilaDeCobros[]>(
      `
      SELECT ${COLUMNAS_DE_MARCA('o')},
             COALESCE(SUM(p."tipAmount") FILTER (WHERE p.status = 'COMPLETED' AND NOT ${sqlCobroDeCuentaSinCobrar('p')}), 0)::text AS propinas,
             (COUNT(*) FILTER (WHERE p.status = 'COMPLETED' AND NOT ${sqlCobroDeCuentaSinCobrar('p')}
                AND p.type IS DISTINCT FROM 'REFUND' AND ${sqlOrdenSinTarjetasTexto('p."orderId"')}))::int AS cobros,
             COALESCE(SUM(${SQL_COMISION_DEL_COBRO}) FILTER (WHERE (tc."id" IS NOT NULL OR p.status = 'COMPLETED')
                AND NOT ${sqlCobroDeCuentaSinCobrar('p')}), 0)::text AS comision,
             COALESCE(SUM(${sqlComisionDeTerceros('p', false)}) FILTER (WHERE p.status = 'COMPLETED'
                AND p."tenderCommissionAmount" IS NOT NULL), 0)::text AS terceros,
             COALESCE(SUM(p.amount + p."tipAmount") FILTER (WHERE devolucion.cuenta), 0)::text AS devuelto,
             COALESCE(SUM(COALESCE(p."reopenedAmount", 0) + COALESCE(p."reopenedTipAmount", 0)) FILTER (WHERE devolucion.cuenta), 0)::text AS reabierto,
             (COUNT(*) FILTER (WHERE devolucion.cuenta))::int AS devoluciones,
             (COUNT(*) FILTER (WHERE devolucion.cuenta AND p."reopenedAmount" > 0))::int AS devoluciones_de_abono
      FROM "Payment" p
      JOIN "Order" o ON o.id = p."orderId"
      ${marcasDe('o')}
      LEFT JOIN "TransactionCost" tc ON tc."paymentId" = p.id
      CROSS JOIN LATERAL (
        SELECT (p.type = 'REFUND' AND o.status NOT IN ('CANCELLED', 'DELETED') AND ${sqlOrdenSinTarjetasTexto('o.id')}) AS cuenta
      ) devolucion
      WHERE p."venueId" = $1
        AND ${sqlRangoHoraReal('p', utcTsParam(2), utcTsParam(3))}
      ${AGRUPAR('o')}
      `,
      venueId,
      start,
      end,
    ),
  ])

  const porCanal = new Map<SalesChannel, Crudo>()
  const porTipo = new Map<SalesOrderType, Crudo>()
  const grupo = (f: Marcas): Crudo => {
    // `por_tipo = 1` ⇒ el renglón es del conjunto del canal (el tipo está agregado); 0 ⇒ del conjunto del tipo.
    const m = (Number(f.por_tipo) === 1 ? porCanal : porTipo) as Map<string, Crudo>
    const llave =
      Number(f.por_tipo) === 1
        ? canalDeLaCuenta(f.source ?? '', f.mesa === true, f.tienda === true)
        : tipoDeLaCuenta(f.tipo ?? '', f.monto === true)
    let acc = m.get(llave)
    if (!acc) {
      acc = vacio()
      m.set(llave, acc)
    }
    return acc
  }

  for (const f of cuentas) {
    const acc = grupo(f)
    // Las cortesías y promociones ocultas van a los DOS lados, como `foldGiveawaysIntoSummary`: el neto no se mueve.
    const regalado = Number(f.promo_centavos) / 100 + Number(f.cortesias)
    acc.grossSales += Number(f.bruto) + regalado
    acc.discounts += Number(f.descuentos) + regalado
    acc.orderCount = (acc.orderCount ?? 0) + Number(f.cuentas)
  }
  for (const f of cobros) {
    const acc = grupo(f)
    acc.tips += Number(f.propinas)
    acc.transactionCount += Number(f.cobros)
    acc.platformFees += Number(f.comision)
    acc.tenderCommissions += Number(f.terceros)
    // La cabecera: |Σ devoluciones| menos lo que sólo regresó un abono (vuelve a deberse en «Sin cobrar»).
    acc.refunds += -Number(f.devuelto) - Number(f.reabierto)
    acc.refundCount += Number(f.devoluciones) - Number(f.devoluciones_de_abono)
  }

  const legacy = opts.legacy
  if (legacy && legacy.count > 0) {
    for (const mapa of [porCanal, porTipo] as Array<Map<string, Crudo>>) {
      const acc = vacio()
      acc.grossSales = legacy.amount
      acc.tips = legacy.tips
      acc.transactionCount = legacy.count
      acc.orderCount = null
      mapa.set('QR_LEGACY', acc)
    }
  }

  for (const mapa of [porCanal, porTipo] as Array<Map<string, Crudo>>) {
    for (const acc of mapa.values()) {
      acc.netSales = acc.grossSales - acc.discounts - acc.refunds
      acc.totalCollected = acc.netSales + acc.tips - acc.platformFees - acc.tenderCommissions
    }
  }

  const cabecera = opts.cabecera ?? {}
  return {
    byChannel: cerrar(porCanal, cabecera, { venueId, tabla: 'canal' }),
    byOrderType: cerrar(porTipo, cabecera, { venueId, tabla: 'tipo' }),
  }
}
