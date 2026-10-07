import { CfdiStatus, OrderStatus, PaymentMethod, PaymentType, Prisma, TransactionStatus } from '@prisma/client'

import AppError, { NotFoundError, ServiceUnavailableError, ValidationError } from '../../errors/AppError'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { parseDbDateRange } from '../../utils/datetime'
import { sumarDesglose, type DesgloseDeCobro, type DesglosePorTratamiento } from '../fiscal/ivaMath'
import type { IvaTratamiento } from '../fiscal/ivaTratamiento'
import { paymentInFiscalScope, metodoParaAlcanceFiscal } from '../fiscal/fiscalScope'
import { computePeriodCogsCents } from '../fiscal/cogs.service'
import { MAX_ORDENES_POR_REPORTE, recorrerLibros, sqlDeOrdenesDelPeriodo, type MovimientoLeido } from '../fiscal/librosDeOrdenes'
import type { ParteDelLibro } from '../fiscal/libroDeLaOrden'

/**
 * Accounting — Capa A (gerencial, read-model)
 *
 * Estado de resultados de INGRESOS de un local en un periodo. NO es contabilidad fiscal:
 * corre sobre los pagos que el sistema ya tiene, sin capturar nada. Incluido para todos
 * los venues (gateado por permiso `accounting:read`, sin paywall).
 *
 * Convención de dinero: precios IVA-INCLUIDO (en México el precio al público ya trae el IVA).
 *   neto (base) = monto / (1 + tasa) · IVA trasladado = monto − neto
 * Todo se reporta en CENTAVOS enteros para exactitud contable. Las propinas NO son ingreso
 * (se reportan aparte, informativas). Las devoluciones (type=REFUND, monto negativo) se
 * restan del ingreso.
 *
 * Limitación conocida (v1): no hay costo de venta capturado para retail (QUANTITY) ni
 * serializado, por eso este read-model reporta INGRESOS, no utilidad bruta.
 *
 * B4b (D17): cada movimiento lleva la parte que le da el libro de su orden (`libroDeLaOrden`). La composición es la de la
 * factura; los cobros se acumulan, así que la suma de la orden es exacta. Una devolución por artículos baja la tasa de lo
 * devuelto; una por importe sale de lo que queda; ninguna deja base ni IVA negativos. Lo que no se puede atribuir se cuenta en
 * `movimientosConIvaAproximado`. Todo el reporte es una foto (una transacción REPEATABLE READ) y sólo lee: un SELECT enumera las
 * órdenes del periodo una vez cada una, y `recorrerLibros` lee su historia con topes por orden y por lote. Si el periodo o una
 * venta pasa un tope, o se acaba el tiempo, el reporte falla con código (REPORT_TOO_LARGE, REPORT_TIMEOUT) y nunca da cifras a
 * medias.
 *
 * La base gravable es la de 16 %, 8 % y 0 % (y la de un BLOQUEADO, como hoy); exento y no objeto van aparte (plan 4b).
 * `taxByRate` reporta el IVA separado por tasa (la declaración de IVA del SAT reporta 16% y 8% por separado). Ventas de importe
 * libre (sin items) caen al 16% por defecto. `taxRateAssumed` (0.16) queda como nominal informativo.
 */

const DEFAULT_IVA_RATE = 0.16
/** B4b (Codex r5 R5-3): de cuántas en cuántas órdenes se leen los libros dentro de la foto del reporte. */
export const LOTE_DE_ORDENES = 500
/**
 * B4b (respuesta 14; T7-I1): lo más que puede durar la foto de un estado de resultados.
 * Queda bajo el corte de 100 s del proxy de Cloudflare, para que `REPORT_TIMEOUT` llegue al navegador (un 524 nunca trae nuestro código).
 */
export const TIEMPO_MAXIMO_DEL_REPORTE_MS = 90_000

/** B4b (respuesta 14; fallo 1 de la ronda 6): lo más que puede durar y cuántas órdenes puede tener un estado de resultados. */
export type LimitesDelReporte = { tiempoMaximoMs: number; maxOrdenes: number }
export const LIMITES_DEL_REPORTE: LimitesDelReporte = { tiempoMaximoMs: TIEMPO_MAXIMO_DEL_REPORTE_MS, maxOrdenes: MAX_ORDENES_POR_REPORTE }
const MENSAJE_TIEMPO_AGOTADO = 'El periodo es muy grande para calcularlo de una vez; elige un rango más corto.'
/** Fallo 1 de la ronda 8: el texto de las pantallas de UN mes (IVA e ISR), también cuando vence la foto del ISR. */
export const MENSAJE_MES_NO_CALCULADO =
  'No pudimos calcular este mes de una vez; vuelve a intentarlo en unos minutos o escríbenos a soporte.'

/**
 * Codex r5 R5-8, r6 R6-4, r7 R7-5: es el tiempo máximo sólo si la transacción EMPEZÓ (su callback corrió) Y Prisma dice que EXPIRÓ
 * («… cannot be executed on an expired transaction. The timeout for this transaction was N ms…», `@prisma/client/runtime`). Pasan tal
 * cual: el P2028 de la adquisición (el pool, `maxWait`), el de una transacción ya confirmada o revertida, y cualquier otro error
 * (también la cancelación del freno). «Expired» no se decide con el reloj: el de Prisma empieza al abrir la transacción, no al pedirla.
 *
 * Hallazgo T8-B (Tarea 8, 7-oct): con consultas concurrentes (el Resumen en el tope), el vencimiento también puede llegar como P2028
 * «Transaction not found…» (la consulta pidió la transacción mientras Prisma la cerraba por tiempo). Ése sólo es el tiempo máximo si
 * la foto EMPEZÓ y, desde que corrió su callback, ya pasó `tiempoMaximoMs`; antes del límite pasa tal cual (R7-5: un «not found» de
 * una transacción cerrada por otra causa no se disfraza).
 */
function errorDelReporte(e: unknown, empezo: number | null, c: { tiempoMaximoMs: number; mensajeDeTiempo: string }): unknown {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2028' || empezo === null) return e
  const expiro = /expired transaction/i.test(e.message)
  const noEncontradaTrasElLimite = /Transaction not found/i.test(e.message) && Date.now() - empezo >= c.tiempoMaximoMs
  return expiro || noEncontradaTrasElLimite ? new ServiceUnavailableError(c.mensajeDeTiempo, 'REPORT_TIMEOUT') : e
}

/**
 * La foto (Codex r7 R7-1): una transacción REPEATABLE READ con su tiempo máximo. Anota cuándo empezó, traduce el vencimiento y avisa
 * en el log. Una por estado de resultados (`getIncomeStatement`); una para TODOS los meses del ISR (`isr.service.ts`), para que el
 * acumulado se lea en una sola versión de los datos.
 */
export async function conFotoDeReporte<T>(
  c: { venueName: string; from: string; to: string; tiempoMaximoMs: number; mensajeDeTiempo: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const inicio = Date.now()
  let empezo: number | null = null // R6-4: cuándo corrió el callback (null = la transacción nunca empezó)
  try {
    return await prisma.$transaction(
      async tx => {
        empezo = Date.now()
        return fn(tx)
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: c.tiempoMaximoMs },
    )
  } catch (e) {
    const error = errorDelReporte(e, empezo, c)
    if (error instanceof AppError && (error.code === 'REPORT_TOO_LARGE' || error.code === 'REPORT_TIMEOUT')) {
      logger.warn('Estado de resultados sin calcular', {
        code: error.code,
        venueName: c.venueName,
        from: c.from,
        to: c.to,
        ms: Date.now() - inicio,
        msEjecucion: empezo === null ? null : Date.now() - empezo,
        details: error.details,
      })
    }
    throw error
  }
}

export interface IncomeStatementFilters {
  /** Fecha inicial en zona horaria del local, formato 'YYYY-MM-DD'. */
  from: string
  /** Fecha final en zona horaria del local, formato 'YYYY-MM-DD'. */
  to: string
}

export interface IncomeStatement {
  venueId: string
  venueName: string
  currency: 'MXN'
  timezone: string
  period: { from: string; to: string }
  /** Tasa de IVA nominal informativa (0.16). El desglose real es por tasa — ver `revenue.taxByRate`. */
  taxRateAssumed: number
  revenue: {
    /** Ventas brutas (IVA-incluido, sin propina), antes de devoluciones. */
    grossSalesCents: number
    /** Devoluciones del periodo (magnitud positiva). */
    refundsCents: number
    /** Ingreso real cobrado = ventas brutas − devoluciones (IVA-incluido). */
    netRevenueCents: number
    /** Base de actos gravados (16 % + 8 % + 0 %), sin IVA. Lo exento y lo no objeto van aparte (plan 4b). */
    taxableBaseCents: number
    /** Plan 4b · base de tasa 0 % (ya incluida en taxableBaseCents). */
    tasa0BaseCents?: number
    /** Plan 4b · base exenta (fuera de taxableBaseCents). */
    exentoBaseCents?: number
    /** Plan 4b · base no objeto de IVA (fuera de taxableBaseCents). */
    noObjetoBaseCents?: number
    /** Plan 4b · todo el ingreso sin IVA (gravado + exento + no objeto): la base del ISR. */
    ingresosSinIvaCents?: number
    /**
     * B4b (D17; Codex B4b r1 P2 #6, r2 N5, N8, r3 R3-3, r4 R4-3) · cuántas ventas y devoluciones del periodo tienen IVA aproximado. Su
     * orden mezcla IVA y algo no se pudo atribuir —un descuento que no dice a qué artículo le tocó, un artículo devuelto que no está en
     * la orden o que se devolvió de más—, o es un ajuste del proveedor sin reparto válido o que no cabe, o se devolvió más de lo que la
     * orden cobró, o un movimiento anterior de la misma orden ya fue aproximado, o es «IVA aparte» de un origen que no declara qué
     * guarda. 0 = todo se pudo atribuir. (El tamaño de una orden nunca la vuelve aproximada: pasar un tope detiene el reporte.)
     */
    movimientosConIvaAproximado?: number
    /** IVA trasladado embebido en el ingreso neto (neto de devoluciones). */
    ivaCents: number
    /** IVA trasladado NETO desglosado por tasa (clave = tasa como string, p.ej. "0.16", "0.08"). */
    taxByRate: Record<string, number>
  }
  /**
   * Subconjunto de `revenue` que SÍ entra a los libros fiscales (pólizas / IVA / ISR / reportes),
   * respetando los toggles configurables: merchants con `includeInAccounting=false` y — salvo opt-in
   * (`FiscalEmisor.includeCashInAccounting`) — las ventas en EFECTIVO quedan FUERA. `revenue` (arriba)
   * siempre es el total gerencial. Cuando no hay exclusiones, `fiscalRevenue === revenue`.
   */
  fiscalRevenue: {
    grossSalesCents: number
    refundsCents: number
    netRevenueCents: number
    /** Base de actos gravados (16 % + 8 % + 0 %), sin IVA. Lo exento y lo no objeto van aparte (plan 4b). */
    taxableBaseCents: number
    /** Plan 4b · base de tasa 0 % (ya incluida en taxableBaseCents). */
    tasa0BaseCents?: number
    /** Plan 4b · base exenta (fuera de taxableBaseCents). */
    exentoBaseCents?: number
    /** Plan 4b · base no objeto de IVA (fuera de taxableBaseCents). */
    noObjetoBaseCents?: number
    /** Plan 4b · todo el ingreso sin IVA (gravado + exento + no objeto): la base del ISR. */
    ingresosSinIvaCents?: number
    /**
     * B4b (D17; Codex B4b r1 P2 #6, r2 N5, N8, r3 R3-3, r4 R4-3) · cuántas ventas y devoluciones del periodo tienen IVA aproximado. Su
     * orden mezcla IVA y algo no se pudo atribuir —un descuento que no dice a qué artículo le tocó, un artículo devuelto que no está en
     * la orden o que se devolvió de más—, o es un ajuste del proveedor sin reparto válido o que no cabe, o se devolvió más de lo que la
     * orden cobró, o un movimiento anterior de la misma orden ya fue aproximado, o es «IVA aparte» de un origen que no declara qué
     * guarda. 0 = todo se pudo atribuir. (El tamaño de una orden nunca la vuelve aproximada: pasar un tope detiene el reporte.)
     */
    movimientosConIvaAproximado?: number
    ivaCents: number
    taxByRate: Record<string, number>
  }
  /** Propinas (informativas, NO forman parte del ingreso). */
  tips: { totalCents: number }
  metrics: { salesCount: number; refundCount: number; averageTicketCents: number }
}

/** Convierte un Decimal/number de pesos a centavos enteros. */
const toCents = (d: { toString(): string } | number | null): number => (d == null ? 0 : Math.round(Number(d) * 100))

/**
 * Calcula el estado de resultados (ingresos) de un local para [from, to], en UNA foto (`conFotoDeReporte`).
 *
 * @param venueId  Local (tenant). Toda query se aísla por este id.
 * @param filters  Rango de fechas en zona horaria del local.
 * @param limites  Sólo lo cambian las pruebas, para probar un tiempo máximo de verdad sin esperar minuto y medio.
 */
export async function getIncomeStatement(
  venueId: string,
  filters: IncomeStatementFilters,
  limites: LimitesDelReporte = LIMITES_DEL_REPORTE,
): Promise<IncomeStatement> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, timezone: true } })
  if (!venue) throw new NotFoundError(`Venue with ID ${venueId} not found`)
  return conFotoDeReporte(
    {
      venueName: venue.name,
      from: filters.from,
      to: filters.to,
      tiempoMaximoMs: limites.tiempoMaximoMs,
      mensajeDeTiempo: MENSAJE_TIEMPO_AGOTADO,
    },
    tx => estadoDeResultadosEnFoto(tx, { id: venueId, ...venue }, filters, limites),
  )
}

/**
 * El estado de resultados dentro de una foto ya abierta (fallo 1 de la ronda 8: el ISR corre todos sus meses en una sola). Sólo lee
 * con `tx`: la foto la abre quien llama. Nunca abre otra transacción.
 */
export async function estadoDeResultadosEnFoto(
  tx: Prisma.TransactionClient,
  venue: { id: string; name: string; timezone: string | null },
  filters: IncomeStatementFilters,
  limites: LimitesDelReporte = LIMITES_DEL_REPORTE,
): Promise<IncomeStatement> {
  const venueId = venue.id
  const timezone = venue.timezone || 'America/Mexico_City'
  // Payment es data creada por Prisma → UTC real. parseDbDateRange convierte los límites
  // del día en zona del local a UTC real (fromZonedTime), NO "fake UTC".
  const { from, to } = parseDbDateRange(filters.from, filters.to, timezone)

  // Opt-in del efectivo en los libros fiscales (per contribuyente). El estado gerencial NO depende de
  // esto; solo el subconjunto `fiscalRevenue`. Sin emisor → cash fuera de lo fiscal (default false).
  const emisorScope = await tx.fiscalEmisor.findFirst({
    where: { venueId },
    orderBy: { createdAt: 'asc' },
    select: { includeCashInAccounting: true },
  })
  const includeCashInAccounting = emisorScope?.includeCashInAccounting ?? false

  // Acumuladores GERENCIALES (todo) y FISCALES (subconjunto en alcance). Cada pago suma al gerencial
  // siempre, y al fiscal solo si `paymentInFiscalScope` lo permite.
  const acumulador = () => ({
    gross: 0,
    refunds: 0,
    base: 0,
    iva: 0,
    byRate: {} as Record<string, number>,
    porTratamiento: {} as DesglosePorTratamiento,
    /** B4b: ventas y devoluciones del periodo cuyo IVA se aproximó (`movimientosConIvaAproximado`). */
    aproximados: 0,
  })
  const ger = acumulador()
  const fis = acumulador()
  let tipsCents = 0
  let salesCount = 0
  let refundCount = 0
  const mergeTax = (dst: Record<string, number>, byRate: Record<string, number>, sign: 1 | -1) => {
    for (const [rate, cents] of Object.entries(byRate)) dst[rate] = (dst[rate] ?? 0) + sign * cents
  }
  /** Suma (o resta) el desglose de un cobro: base, IVA, IVA por tasa y base e IVA por tratamiento. */
  const sumar = (acc: ReturnType<typeof acumulador>, s: DesgloseDeCobro, sign: 1 | -1) => {
    acc.base += sign * s.netCents
    acc.iva += sign * s.taxCents
    mergeTax(acc.byRate, s.taxByRate, sign)
    sumarDesglose(acc.porTratamiento, s.porTratamiento, sign)
  }

  // B4b (D17; Codex B4b r2 N4, r3 R3-2, R3-5, r4 R4-4, r5 R5-2, R5-3, R5-8): UNA foto para todo el reporte. Un solo SELECT junta, una
  // vez y ordenados, los ids de las órdenes con cobros del periodo (del negocio del cobro Y de la orden, sin canceladas, con las fechas
  // por utcTs); de 500 en 500 se suma cada lote con TODOS sus movimientos (`recorrerLibros`). Sólo lecturas: el freno del MCP puede
  // cortar entre dos consultas. Las cifras salen de esa lectura, nunca de la enumeración.
  const sumarMovimiento = (m: MovimientoLeido, parte: ParteDelLibro) => {
    // Un movimiento de antes del periodo construye el libro de su orden; no es de este periodo.
    if (m.createdAt < from || m.createdAt > to) return
    const esDevolucion = m.type === PaymentType.REFUND
    // Ruling M3 (revisión de la Tarea 3): un movimiento de 0 centavos no cuenta como aproximado. Una devolución de $0 hereda
    // `aproximada` del libro, pero su IVA es 0, no aproximado.
    const cuentaComoAproximado = parte.aproximada && m.amountCents !== 0
    const inFiscal = paymentInFiscalScope(
      esDevolucion ? metodoParaAlcanceFiscal(m.method, m.processorData) : m.method,
      m.incluirEnContabilidad,
      includeCashInAccounting,
    )
    if (esDevolucion) {
      const magnitudeCents = Math.abs(m.amountCents)
      ger.refunds += magnitudeCents
      sumar(ger, parte, 1) // la parte ya viene con signo (resta)
      if (cuentaComoAproximado) ger.aproximados += 1
      if (inFiscal) {
        fis.refunds += magnitudeCents
        sumar(fis, parte, 1)
        if (cuentaComoAproximado) fis.aproximados += 1
      }
      refundCount += 1
      return
    }
    // REGULAR / FAST / ADJUSTMENT / null (legacy) → venta real
    ger.gross += m.amountCents
    sumar(ger, parte, 1)
    if (cuentaComoAproximado) ger.aproximados += 1
    if (inFiscal) {
      fis.gross += m.amountCents
      sumar(fis, parte, 1)
      if (cuentaComoAproximado) fis.aproximados += 1
    }
    tipsCents += m.tipCents
    salesCount += 1
  }

  const inicio = Date.now()
  const ids = await tx.$queryRaw<Array<{ orderId: string }>>(sqlDeOrdenesDelPeriodo(venue.id, from, to, limites.maxOrdenes + 1))
  if (ids.length > limites.maxOrdenes) {
    throw new ValidationError(
      `El periodo tiene más de ${limites.maxOrdenes.toLocaleString('es-MX')} ventas y no se puede calcular de una vez; elige un rango más corto.`,
      'REPORT_TOO_LARGE',
      { motivo: 'PERIODO', limite: limites.maxOrdenes },
    )
  }
  const ordenes = ids.length
  let consultas = 1 // la enumeración
  let filasLeidas = ids.length
  for (let i = 0; i < ids.length; i += LOTE_DE_ORDENES) {
    const lote = ids.slice(i, i + LOTE_DE_ORDENES).map(r => r.orderId)
    const leido = await recorrerLibros(tx, { venueId: venue.id, orderIds: lote, hasta: to }, sumarMovimiento)
    consultas += leido.consultas
    filasLeidas += leido.filas
  }
  logger.debug('Estado de resultados calculado', {
    venueName: venue.name,
    from: filters.from,
    to: filters.to,
    ms: Date.now() - inicio,
    ordenes,
    consultas,
    filasLeidas,
  })

  // Poda claves de tasa en 0 tras netear devoluciones (no aportan a la declaración).
  for (const b of [ger.byRate, fis.byRate]) for (const rate of Object.keys(b)) if (b[rate] === 0) delete b[rate]

  /**
   * Plan 4b (spec §3): base gravable = actos gravados (16 %, 8 % y 0 %; LIVA 2-A: la tasa 0 surte efectos de acto gravado; un
   * BLOQUEADO sigue contando como hoy). Exento y no objeto van aparte; `ingresosSinIvaCents` es todo el ingreso sin IVA. Con todo
   * al 16 %, las dos coinciden.
   */
  const bases = (a: ReturnType<typeof acumulador>) => {
    const base = (t: IvaTratamiento) => a.porTratamiento[t]?.baseCents ?? 0
    return {
      taxableBaseCents: a.base - base('EXENTO') - base('NO_OBJETO'),
      tasa0BaseCents: base('IVA_0'),
      exentoBaseCents: base('EXENTO'),
      noObjetoBaseCents: base('NO_OBJETO'),
      ingresosSinIvaCents: a.base,
    }
  }

  const grossSalesCents = ger.gross
  const refundsCents = ger.refunds
  const ivaCents = ger.iva
  const taxByRate = ger.byRate
  const netRevenueCents = grossSalesCents - refundsCents // === ingresosSinIvaCents + ivaCents (cada split es exacto)
  const averageTicketCents = salesCount > 0 ? Math.round(grossSalesCents / salesCount) : 0

  return {
    venueId,
    venueName: venue.name,
    currency: 'MXN',
    timezone,
    period: { from: filters.from, to: filters.to },
    taxRateAssumed: DEFAULT_IVA_RATE,
    revenue: {
      grossSalesCents,
      refundsCents,
      netRevenueCents,
      ...bases(ger),
      movimientosConIvaAproximado: ger.aproximados,
      ivaCents,
      taxByRate,
    },
    fiscalRevenue: {
      grossSalesCents: fis.gross,
      refundsCents: fis.refunds,
      netRevenueCents: fis.gross - fis.refunds,
      ...bases(fis),
      movimientosConIvaAproximado: fis.aproximados,
      ivaCents: fis.iva,
      taxByRate: fis.byRate,
    },
    tips: { totalCents: tipsCents },
    metrics: { salesCount, refundCount, averageTicketCents },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Resumen del negocio + Bancos y cajas (Capa A, read-models)
// ───────────────────────────────────────────────────────────────────────────

/** Cada método de cobro cae en una "cuenta": efectivo (caja) o banco (depósito). */
const METHOD_BUCKET: Record<PaymentMethod, { key: string; kind: 'cash' | 'bank' }> = {
  CASH: { key: 'cash', kind: 'cash' },
  CREDIT_CARD: { key: 'card', kind: 'bank' },
  DEBIT_CARD: { key: 'card', kind: 'bank' },
  DIGITAL_WALLET: { key: 'wallet', kind: 'bank' },
  BANK_TRANSFER: { key: 'transfer', kind: 'bank' },
  CRYPTOCURRENCY: { key: 'crypto', kind: 'bank' },
  OTHER: { key: 'other', kind: 'bank' },
}

interface PeriodAccount {
  key: string
  kind: 'cash' | 'bank'
  methods: PaymentMethod[]
  inflowCents: number // VENTA con signo (las devoluciones restan); NO incluye propina
  tipCents: number // propina del método con signo (las devoluciones restan)
  count: number // ventas (no devoluciones)
}

interface PeriodPaymentAgg {
  accounts: PeriodAccount[]
  cashInflowCents: number
  electronicInflowCents: number
  /** Propina cobrada por métodos electrónicos: se deposita al banco junto con la venta. */
  electronicTipsCents: number
  feesCents: number
}

/** Resuelve venue + timezone + rango UTC una sola vez. */
async function resolvePeriod(venueId: string, filters: { from: string; to: string }) {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, timezone: true } })
  if (!venue) throw new NotFoundError(`Venue with ID ${venueId} not found`)
  const timezone = venue.timezone || 'America/Mexico_City'
  const { from, to } = parseDbDateRange(filters.from, filters.to, timezone)
  return { venueName: venue.name, timezone, from, to }
}

/**
 * Agrega los pagos COMPLETADOS del periodo por método de cobro, separando
 * efectivo (caja) de electrónico (banco) y sumando las comisiones de procesamiento.
 * Las devoluciones (type=REFUND, monto negativo) restan del método correspondiente.
 * B4b: suma en la base (una fila por método y tipo) y sólo cuenta cobros de órdenes de ESTE negocio.
 */
async function aggregatePeriodPayments(venueId: string, from: Date, to: Date): Promise<PeriodPaymentAgg> {
  // B4b (regla de consultas acotadas): sumas en la base, una fila por (método, tipo); nunca los cobros del periodo.
  const grupos = await prisma.payment.groupBy({
    by: ['method', 'type'],
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      createdAt: { gte: from, lte: to },
      // Codex r3 R3-5 (respuesta 9): también la orden debe ser de este negocio, como en la enumeración del estado de resultados.
      order: { venueId, status: { not: OrderStatus.CANCELLED } },
    },
    _sum: { amount: true, tipAmount: true, feeAmount: true },
    _count: { _all: true },
  })

  const buckets = new Map<string, PeriodAccount>()
  let feesCents = 0

  for (const g of grupos) {
    if (g.type === PaymentType.TEST) continue // pagos de prueba no cuentan
    const method = g.method ?? PaymentMethod.OTHER
    const def = METHOD_BUCKET[method] ?? METHOD_BUCKET.OTHER
    let acc = buckets.get(def.key)
    if (!acc) {
      acc = { key: def.key, kind: def.kind, methods: [], inflowCents: 0, tipCents: 0, count: 0 }
      buckets.set(def.key, acc)
    }
    if (!acc.methods.includes(method)) acc.methods.push(method)

    acc.inflowCents += toCents(g._sum.amount) // devoluciones ya vienen negativas
    acc.tipCents += toCents(g._sum.tipAmount) // propina con signo (las devoluciones traen propina negativa)
    if (g.type === PaymentType.REFUND) continue // no suma conteo ni comisión
    acc.count += g._count._all
    feesCents += toCents(g._sum.feeAmount)
  }

  const accounts = [...buckets.values()].sort((a, b) => b.inflowCents - a.inflowCents)
  let cashInflowCents = 0
  let electronicInflowCents = 0
  let electronicTipsCents = 0
  for (const a of accounts) {
    if (a.kind === 'cash') {
      cashInflowCents += a.inflowCents
    } else {
      electronicInflowCents += a.inflowCents
      electronicTipsCents += a.tipCents // sólo las propinas electrónicas llegan al banco (las de caja no)
    }
  }

  return { accounts, cashInflowCents, electronicInflowCents, electronicTipsCents, feesCents }
}

/** Estados de cuenta subidos + cuántos depósitos cuadraron (conciliación bancaria). */
async function reconciliationSummary(venueId: string) {
  const [count, sums] = await Promise.all([
    prisma.bankStatement.count({ where: { venueId } }),
    prisma.bankStatement.aggregate({ where: { venueId }, _sum: { lineCount: true, matchedCount: true } }),
  ])
  return {
    statements: count,
    lineCount: sums._sum.lineCount ?? 0,
    matchedCount: sums._sum.matchedCount ?? 0,
  }
}

export interface BusinessSummary {
  venueId: string
  venueName: string
  currency: 'MXN'
  timezone: string
  period: { from: string; to: string }
  taxRateAssumed: number
  revenue: IncomeStatement['revenue']
  /** Facturación del periodo (CFDIs timbrados). */
  invoicing: {
    stampedCount: number
    stampedTotalCents: number
    nominativeCount: number
    globalCount: number
    /** Aproximación de lo facturado = total de CFDIs timbrados (IVA-incluido). */
    invoicedApproxCents: number
    /** Ingreso neto del periodo aún sin amparar por un CFDI (estimado, ≥ 0). */
    uninvoicedApproxCents: number
    /** % del ingreso neto ya facturado (0-100). */
    invoicedPct: number
  }
  /** Cómo cobró: efectivo (caja) vs electrónico (banco). */
  collection: { cashCents: number; electronicCents: number; cashPct: number }
  costs: { processingFeesCents: number }
  /**
   * `netAfterFeesCents` = ingreso neto − comisiones. `cogsCents` = costo del inventario consumido en el
   * periodo (FIFO). `grossProfitCents` = ingreso neto − costo de ventas (UTILIDAD BRUTA). No es utilidad
   * NETA (no resta gastos ni nómina).
   */
  result: { netAfterFeesCents: number; cogsCents: number; grossProfitCents: number }
  tips: { totalCents: number }
  reconciliation: { statements: number; lineCount: number; matchedCount: number }
  metrics: IncomeStatement['metrics']
}

/**
 * Resumen del negocio — la portada de Contabilidad (Capa A). Reúne en una sola
 * vista lo que el dueño quiere saber del periodo: cuánto ingresó, cuánto facturó,
 * cómo cobró (efectivo vs banco), qué pagó de comisiones y si su banco ya cuadró.
 * Read-model: corre sobre Payment + Cfdi + BankStatement, sin capturar nada.
 *
 * @param venueId  Local (tenant). Toda query se aísla por este id.
 * @param filters  Rango de fechas en zona horaria del local (YYYY-MM-DD).
 */
export async function getBusinessSummary(venueId: string, filters: IncomeStatementFilters): Promise<BusinessSummary> {
  const { venueName, timezone, from, to } = await resolvePeriod(venueId, filters)

  const [income, payAgg, recon, stampedAgg, byScope, cogsCents] = await Promise.all([
    getIncomeStatement(venueId, filters),
    aggregatePeriodPayments(venueId, from, to),
    reconciliationSummary(venueId),
    prisma.cfdi.aggregate({
      where: { venueId, status: CfdiStatus.STAMPED, stampedAt: { gte: from, lte: to } },
      _sum: { totalCents: true },
      _count: { _all: true },
    }),
    prisma.cfdi.groupBy({
      by: ['isGlobal'],
      where: { venueId, status: CfdiStatus.STAMPED, stampedAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    computePeriodCogsCents(venueId, from, to),
  ])

  const stampedCount = stampedAgg._count._all
  const stampedTotalCents = stampedAgg._sum.totalCents ?? 0
  const globalCount = byScope.find(g => g.isGlobal)?._count._all ?? 0
  const nominativeCount = stampedCount - globalCount

  const netRevenueCents = income.revenue.netRevenueCents
  const invoicedApproxCents = Math.min(stampedTotalCents, Math.max(netRevenueCents, 0))
  const uninvoicedApproxCents = Math.max(0, netRevenueCents - stampedTotalCents)
  const invoicedPct = netRevenueCents > 0 ? Math.round((invoicedApproxCents / netRevenueCents) * 100) : 0

  const cashCents = payAgg.cashInflowCents
  const electronicCents = payAgg.electronicInflowCents
  const totalInflow = cashCents + electronicCents
  const cashPct = totalInflow > 0 ? Math.round((cashCents / totalInflow) * 100) : 0

  return {
    venueId,
    venueName,
    currency: 'MXN',
    timezone,
    period: { from: filters.from, to: filters.to },
    taxRateAssumed: income.taxRateAssumed,
    revenue: income.revenue,
    invoicing: { stampedCount, stampedTotalCents, nominativeCount, globalCount, invoicedApproxCents, uninvoicedApproxCents, invoicedPct },
    collection: { cashCents, electronicCents, cashPct },
    costs: { processingFeesCents: payAgg.feesCents },
    result: { netAfterFeesCents: netRevenueCents - payAgg.feesCents, cogsCents, grossProfitCents: netRevenueCents - cogsCents },
    tips: income.tips,
    reconciliation: recon,
    metrics: income.metrics,
  }
}

export interface BankAndCashSummary {
  venueId: string
  venueName: string
  currency: 'MXN'
  timezone: string
  period: { from: string; to: string }
  accounts: PeriodAccount[]
  totals: {
    cashInflowCents: number
    electronicInflowCents: number
    /** Propina electrónica: se deposita al banco junto con la venta. */
    electronicTipsCents: number
    feesCents: number
    /** Lo que debería llegar al banco = venta electrónica + propina electrónica − comisiones. */
    netToBankCents: number
  }
  reconciliation: { statements: number; lineCount: number; matchedCount: number }
}

/**
 * Bancos y cajas — vista de las "cuentas de dinero" del local (Capa A). Para cada
 * forma de cobro (efectivo, tarjetas, transferencias, monederos…) muestra cuánto
 * entró en el periodo, separando lo que se quedó en CAJA (efectivo) de lo que va al
 * BANCO (electrónico, neto de comisiones). Liga con la conciliación bancaria.
 *
 * @param venueId  Local (tenant). Toda query se aísla por este id.
 * @param filters  Rango de fechas en zona horaria del local (YYYY-MM-DD).
 */
export async function getBankAndCashSummary(venueId: string, filters: IncomeStatementFilters): Promise<BankAndCashSummary> {
  const { venueName, timezone, from, to } = await resolvePeriod(venueId, filters)
  const [payAgg, recon] = await Promise.all([aggregatePeriodPayments(venueId, from, to), reconciliationSummary(venueId)])

  return {
    venueId,
    venueName,
    currency: 'MXN',
    timezone,
    period: { from: filters.from, to: filters.to },
    accounts: payAgg.accounts,
    totals: {
      cashInflowCents: payAgg.cashInflowCents,
      electronicInflowCents: payAgg.electronicInflowCents,
      electronicTipsCents: payAgg.electronicTipsCents,
      feesCents: payAgg.feesCents,
      // El procesador liquida venta + propina − comisión; el neto al banco refleja lo mismo.
      netToBankCents: payAgg.electronicInflowCents + payAgg.electronicTipsCents - payAgg.feesCents,
    },
    reconciliation: recon,
  }
}
