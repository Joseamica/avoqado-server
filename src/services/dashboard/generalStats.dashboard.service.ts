import { PaymentMethod, ProductType, TransactionStatus, OrderStatus, Prisma } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import {
  BasicMetricsDetailsQuery,
  BasicMetricsQuery,
  GeneralStatsResponse,
  GeneralStatsQuery,
} from '../../schemas/dashboard/generalStats.schema'
import { SharedQueryService } from './shared-query.service'
import { isItemLevelDiscountSql, lineRevenueSql } from './lineRevenue'
import { parseDateRange, DEFAULT_TIMEZONE } from '../../utils/datetime'
import { utcTs } from '../../utils/sqlDates'
import { DateTime } from 'luxon'
// ⚠️ TECH DEBT — delete when MindForm migrates to native QR module.
// See: src/services/legacy/mergedPayments.service.ts for full context.
import { fetchPaymentsForAnalytics } from '../legacy/mergedPayments.service'
import { MINDFORM_NEW_VENUE_ID, getLegacyPayments } from '../legacy/qrPayments.legacy.service'

/**
 * ── Reescritura 2026-09-01 (incidente del event loop) ────────────────────────
 *
 * Las agregaciones de este archivo materializaban TODAS las filas del rango en
 * Node (un rango de un año son decenas de miles de órdenes por petición) solo
 * para reducirlas a un puñado de buckets con forEach+Map. En una instancia de
 * una vCPU eso congela el event loop y Render reemplaza la instancia. Ahora
 * agrega Postgres (GROUP BY) y Node únicamente da formato al resultado ya
 * agregado. Las divisiones, redondeos y formateos se quedan en Node a
 * propósito: son los mismos de antes, así que los números no se mueven.
 *
 * Dos reglas de estas consultas, verificadas contra findMany en el borde exacto
 * (la sesión de Postgres corre en America/Mexico_City y las columnas guardan
 * UTC real en `timestamp without time zone`):
 *
 *  · Un bind `Date` llega como timestamptz. Contra `createdAt` se compara
 *    SIEMPRE con `(${d} AT TIME ZONE 'UTC')` — un `::timestamp` pelón convierte
 *    con la zona de la SESIÓN y corre el filtro 6 horas.
 *  · El bucket local replica a Luxon: ((col AT TIME ZONE 'UTC') AT TIME ZONE tz).
 */

/** El mismo filtro de estados que usaba el findMany: fuera borradores, canceladas y borradas. */
const ORDER_NOT_DISCARDED = Prisma.raw(`o."status" NOT IN ('PENDING','CANCELLED','DELETED')`)

/** venue + estados válidos + rango — el WHERE que comparten casi todas las agregaciones. */
const orderScope = (venueId: string, fromDate: Date, toDate: Date) =>
  Prisma.sql`o."venueId" = ${venueId} AND ${ORDER_NOT_DISCARDED} AND o."createdAt" >= ${utcTs(fromDate)} AND o."createdAt" <= ${utcTs(toDate)}`

/** El instante en la zona del venue — réplica SQL de `DateTime.fromJSDate(x, { zone: 'utc' }).setZone(tz)`. */
const localTs = (tz: string, col: Prisma.Sql = Prisma.raw('o."createdAt"')) => Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${tz})`

const localDay = (tz: string, col?: Prisma.Sql) => Prisma.sql`to_char(${localTs(tz, col)}, 'YYYY-MM-DD')`
const localHour = (tz: string) => Prisma.sql`EXTRACT(HOUR FROM ${localTs(tz)})::int`
// ISODOW: 1=lunes … 7=domingo — el mismo convenio que `DateTime.weekday` de Luxon.
const localIsoDow = (tz: string) => Prisma.sql`EXTRACT(ISODOW FROM ${localTs(tz)})::int`

const formatShortDate = (isoDate: string, tz: string) =>
  DateTime.fromISO(isoDate, { zone: tz }).toLocaleString({ month: 'short', day: 'numeric' }, { locale: 'es' })

export async function getGeneralStatsData(venueId: string, filters: GeneralStatsQuery = {}): Promise<GeneralStatsResponse> {
  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Set default date range (last 7 days) if not provided
  const { from: fromDate, to: toDate } = parseDateRange(filters.fromDate, filters.toDate, 7)

  // Fetch only valid payments: COMPLETED status, non-cancelled orders.
  // ⚠️ Este endpoint DEVUELVE las filas al dashboard (contrato de la API), así que
  // no es agregable sin tocar al cliente. El `select` acota la memoria por fila a
  // los 5 campos que la transformación usa; el runtime `[query-guard]` denuncia
  // cuando el rango pedido devuelve un resultado gigante.
  const validPayments = await prisma.payment.findMany({
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
      order: {
        status: { not: OrderStatus.CANCELLED },
      },
    },
    select: {
      id: true,
      amount: true,
      method: true,
      createdAt: true,
      tipAmount: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  // Fetch reviews data — también contrato: el dashboard recibe la lista.
  const reviews = await prisma.review.findMany({
    where: {
      venueId,
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
    select: {
      id: true,
      overallRating: true,
      createdAt: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  // Productos vendidos: agregado en Postgres (antes: TODAS las órdenes del rango
  // con items+product materializadas en Node para sumar cantidades).
  const products = await aggregateProductQuantities(venueId, fromDate, toDate)

  // Generate extra metrics
  const extraMetrics = await generateExtraMetrics(venueId, fromDate, toDate, venue.timezone)

  // Transform data to match legacy format
  const transformedPayments = validPayments.map(payment => ({
    id: payment.id,
    amount: Number(payment.amount),
    method: mapPaymentMethod(payment.method),
    createdAt: payment.createdAt.toISOString(),
    tips: [
      {
        amount: Number(payment.tipAmount),
      },
    ],
  }))

  const transformedReviews = reviews.map(review => ({
    id: review.id,
    stars: review.overallRating,
    createdAt: review.createdAt.toISOString(),
  }))

  const transformedProducts = products.map(product => ({
    id: product.id,
    name: product.name,
    type: product.type,
    quantity: product.quantity,
    price: product.price,
  }))

  return {
    payments: transformedPayments,
    reviews: transformedReviews,
    products: transformedProducts,
    extraMetrics,
  }
}

/**
 * Cantidad vendida por producto en el rango — compartido por el resumen general y
 * la gráfica de más vendidos. INNER JOIN a Product: una línea cuyo producto fue
 * borrado no aparecía antes (`if (item.product)`) y sigue sin aparecer.
 * `name`/`type`/`price` son los del catálogo ACTUAL, como siempre fue.
 */
async function aggregateProductQuantities(venueId: string, fromDate: Date, toDate: Date) {
  const rows = await prisma.$queryRaw<Array<{ id: string; name: string; type: string; quantity: number; price: Prisma.Decimal }>>`
    SELECT p."id", p."name", p."type"::text AS "type",
           SUM(oi."quantity")::int AS "quantity", p."price"
    FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    JOIN "Product" p ON p."id" = oi."productId"
    WHERE ${orderScope(venueId, fromDate, toDate)}
    GROUP BY p."id", p."name", p."type", p."price"
    ORDER BY SUM(oi."quantity") DESC, p."id"
  `

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type || ProductType.OTHER,
    quantity: r.quantity,
    price: Number(r.price),
  }))
}

async function generateExtraMetrics(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  // Fetch table performance data
  const tablePerformance = await generateTablePerformance(venueId, fromDate, toDate)

  // Fetch staff performance data
  const staffPerformanceMetrics = await generateStaffPerformance(venueId, fromDate, toDate)

  // Fetch product profitability data
  const productProfitability = await generateProductProfitability(venueId, fromDate, toDate)

  // Generate peak hours data
  const peakHoursData = await generatePeakHoursData(venueId, fromDate, toDate, timezone)

  // Generate weekly trends data
  const weeklyTrendsData = await generateWeeklyTrendsData(venueId, fromDate, toDate, timezone)

  const prepTimesByCategory = await generatePrepTimesByCategory(venueId, fromDate, toDate)

  return {
    tablePerformance,
    staffPerformanceMetrics,
    productProfitability,
    peakHoursData,
    weeklyTrendsData,
    prepTimesByCategory,
  }
}

async function generateTablePerformance(venueId: string, fromDate: Date, toDate: Date) {
  // Antes: todas las órdenes del rango con su mesa, reducidas en Node. El GROUP BY
  // devuelve una fila por mesa; las órdenes sin mesa quedan fuera (INNER JOIN),
  // igual que el `if (order.table)` de siempre.
  const rows = await prisma.$queryRaw<Array<{ tableId: string; tableNumber: string; totalSales: Prisma.Decimal; orderCount: number }>>`
    SELECT t."id" AS "tableId", t."number" AS "tableNumber",
           SUM(o."total") AS "totalSales", COUNT(*)::int AS "orderCount"
    FROM "Order" o
    JOIN "Table" t ON t."id" = o."tableId"
    WHERE ${orderScope(venueId, fromDate, toDate)}
    GROUP BY t."id", t."number"
    ORDER BY SUM(o."total") DESC, t."id"
  `

  return rows.map(row => {
    const totalSales = Number(row.totalSales)
    const orderCount = row.orderCount
    return {
      tableId: row.tableId,
      // `Table.number` es texto libre: parseInt conserva el comportamiento de
      // siempre (un número no numérico produce NaN → null en el JSON).
      tableNumber: parseInt(row.tableNumber),
      totalSales,
      orderCount,
      avgTicket: orderCount > 0 ? totalSales / orderCount : 0,
      turnoverRate: orderCount * 0.8, // Mock calculation
      occupancyRate: Math.min(orderCount * 10, 100), // Mock calculation
      rotationRate: orderCount * 0.5 || 0, // Mock calculation for rotation rate
      totalRevenue: totalSales || 0, // Ensure totalRevenue is available
    }
  })
}

/**
 * **REFACTORED: Now uses SharedQueryService for 100% consistency with chatbot**
 *
 * Uses SharedQueryService.getStaffPerformance() as single source of truth.
 * Transforms response to match legacy generalStats format.
 */
async function generateStaffPerformance(venueId: string, fromDate: Date, toDate: Date) {
  // Use SharedQueryService as single source of truth
  const staffPerformance = await SharedQueryService.getStaffPerformance(
    venueId,
    { from: fromDate, to: toDate }, // Custom date range
    undefined, // Use venue's configured timezone
  )

  // Transform to match legacy generalStats format
  return staffPerformance.map(staff => ({
    staffId: staff.staffId,
    name: staff.staffName, // SharedQueryService uses 'staffName', generalStats expects 'name'
    role: staff.role,
    totalSales: staff.totalRevenue, // SharedQueryService uses 'totalRevenue', generalStats expects 'totalSales'
    totalTips: staff.totalTips,
    orderCount: staff.totalOrders, // SharedQueryService uses 'totalOrders', generalStats expects 'orderCount'
    // El tiempo de preparación por empleado no se mide hoy: la comanda (KdsOrder) no
    // guarda quién la preparó. Devolvía `Math.random()`. Se deja en 0 —"sin medición"—
    // conservando el campo para no romper el contrato con el dashboard.
    avgPrepTime: 0,
  }))
}

async function generateProductProfitability(venueId: string, fromDate: Date, toDate: Date) {
  // `lineRevenueSql` es el gemelo SQL de `lineRevenue` (una sola definición de lo
  // que ganó una línea: precio × unidades − descuento + modifiers; ver
  // lineRevenue.ts). Antes este reporte materializaba todas las órdenes con
  // items+product+modifiers para hacer la misma cuenta en Node.
  const rows = await prisma.$queryRaw<
    Array<{
      id: string
      name: string
      type: string
      price: Prisma.Decimal
      quantity: number
      totalRevenue: Prisma.Decimal
      totalCost: Prisma.Decimal
    }>
  >`
    SELECT p."id", p."name", p."type"::text AS "type", p."price",
           SUM(oi."quantity")::int AS "quantity",
           SUM(${Prisma.raw(lineRevenueSql('oi'))}) AS "totalRevenue",
           SUM(oi."unitPrice" * 0.3 * oi."quantity") AS "totalCost"
    FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    JOIN "Product" p ON p."id" = oi."productId"
    WHERE ${orderScope(venueId, fromDate, toDate)}
    GROUP BY p."id", p."name", p."type", p."price"
    ORDER BY SUM(${Prisma.raw(lineRevenueSql('oi'))}) DESC, p."id"
  `

  return rows.map(row => {
    const totalRevenue = Number(row.totalRevenue)
    const totalCost = Number(row.totalCost) // Mock 30% cost ratio, como siempre
    const quantity = row.quantity
    const margin = totalRevenue - totalCost
    const marginPercentage = totalRevenue > 0 ? (margin / totalRevenue) * 100 : 0

    return {
      name: row.name,
      type: row.type || ProductType.OTHER,
      price: Number(row.price),
      quantity,
      totalRevenue,
      totalCost,
      cost: quantity > 0 ? totalCost / quantity : 0,
      margin: quantity > 0 ? margin / quantity : 0,
      marginPercentage: marginPercentage || 0, // Ensure never undefined
    }
  })
}

async function generatePeakHoursData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  // La hora se determina en la zona del venue (antes lo hacía Luxon fila por fila).
  const rows = await prisma.$queryRaw<Array<{ hour: number; sales: Prisma.Decimal; transactions: number }>>`
    SELECT ${localHour(tz)} AS "hour", SUM(o."total") AS "sales", COUNT(*)::int AS "transactions"
    FROM "Order" o
    WHERE ${orderScope(venueId, fromDate, toDate)}
    GROUP BY 1
    ORDER BY 1
  `

  return rows.map(row => ({
    hour: row.hour,
    sales: Number(row.sales),
    transactions: row.transactions,
  }))
}

// Tiempo de preparación por categoría.
//
// Hoy NO es medible por categoría: `KdsOrderItem` guarda `productName` como texto
// libre y no tiene liga a `Product`, así que no hay forma de saber a qué tipo de
// producto pertenece una línea de comanda. Para medirlo de verdad hay que agregar
// `productId` a `KdsOrderItem` y sellar los tiempos por línea.
//
// Esta función DEVOLVÍA VALORES INVENTADOS: constantes fijas idénticas para todos los
// venues. Las cuatro categorías van en 0 —que se lee como "sin medición"— en vez de
// fabricar un número.
//
// ⚠️ Un intento anterior de este arreglo calculaba el promedio GLOBAL de todas las
// comandas y lo estampaba en `principales`. Eso NO es medir: el número era real pero
// la etiqueta mentía, y nadie río abajo podía distinguir "los platos fuertes tardan X"
// de "todas las comandas tardan X". Sustituir un dato inventado por uno mal etiquetado
// no es arreglarlo. El promedio global sí se reporta, pero en su propio campo y dicho
// con todas sus letras.
//
// `target` es la meta configurada por tipo de servicio, no un dato medido.
// La forma de la respuesta se CONSERVA (nunca se quita un campo de una API); `overall`
// es aditivo y los clientes viejos simplemente lo ignoran.
async function generatePrepTimesByCategory(venueId: string, fromDate: Date, toDate: Date) {
  // Suma y conteo en Postgres; la división y el redondeo a un decimal quedan en
  // Node, idénticos a los de siempre. El filtro (m > 0 && m < 24h) descarta
  // comandas que quedaron abiertas, como antes.
  const [row] = await prisma.$queryRaw<Array<{ n: number; suma: Prisma.Decimal | null }>>`
    SELECT COUNT(*)::int AS "n", SUM(s."minutos") AS "suma"
    FROM (
      SELECT EXTRACT(EPOCH FROM (k."completedAt" - k."startedAt")) / 60.0 AS "minutos"
      FROM "KdsOrder" k
      WHERE k."venueId" = ${venueId}
        AND k."startedAt" IS NOT NULL
        AND k."completedAt" IS NOT NULL
        AND k."createdAt" >= ${utcTs(fromDate)} AND k."createdAt" <= ${utcTs(toDate)}
    ) s
    WHERE s."minutos" > 0 AND s."minutos" < ${24 * 60}
  `

  const medicion = row?.n ?? 0
  const promedioGlobal = medicion ? Math.round((Number(row.suma) / medicion) * 10) / 10 : 0

  return {
    entradas: { avg: 0, target: 10 },
    principales: { avg: 0, target: 15 },
    postres: { avg: 0, target: 5 },
    bebidas: { avg: 0, target: 3 },
    // Lo único que hoy SÍ se mide: la comanda completa, de que entra a cocina a que
    // sale. `medicion` dice sobre cuántas comandas se calculó, para que un promedio
    // sacado de tres tickets no se lea igual que uno sacado de mil.
    overall: { avg: promedioGlobal, target: null, medicion },
  }
}

// Venta por día de la semana del periodo solicitado, contra el periodo inmediato
// anterior de la MISMA duración. El día se determina en la zona horaria del venue,
// no en la del servidor: en producción Node corre en UTC y agrupar sin convertir
// mueve la venta nocturna al día siguiente.
async function generateWeeklyTrendsData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const weekdays = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']

  // Periodo anterior: se desplaza un número ENTERO DE SEMANAS hacia atrás, no la
  // duración exacta del rango. Es la diferencia entre comparar lunes contra lunes o
  // lunes contra jueves: con un rango de 10 días, restar 10 días mueve cada día de la
  // semana tres posiciones y la "comparación" queda sin sentido, aunque los totales
  // sean reales. Como la gráfica se indexa por día de la semana, el desfase tiene que
  // ser múltiplo de 7.
  const MS_POR_DIA = 24 * 60 * 60 * 1000
  const diasDelRango = Math.max(1, Math.ceil((toDate.getTime() - fromDate.getTime()) / MS_POR_DIA))
  const desfaseMs = Math.ceil(diasDelRango / 7) * 7 * MS_POR_DIA
  const prevFrom = new Date(fromDate.getTime() - desfaseMs)
  const prevTo = new Date(toDate.getTime() - desfaseMs)

  // Una orden en el instante exacto donde ambos rangos se tocan cuenta como ACTUAL
  // (el CASE del periodo anterior exige NO estar en el actual), igual que siempre.
  const rows = await prisma.$queryRaw<Array<{ idx: number; current: Prisma.Decimal; previous: Prisma.Decimal }>>`
    SELECT ${localIsoDow(tz)} AS "idx",
           SUM(CASE WHEN o."createdAt" >= ${utcTs(fromDate)} AND o."createdAt" <= ${utcTs(toDate)} THEN o."total" ELSE 0 END) AS "current",
           SUM(CASE WHEN o."createdAt" >= ${utcTs(fromDate)} AND o."createdAt" <= ${utcTs(toDate)} THEN 0 ELSE o."total" END) AS "previous"
    FROM "Order" o
    WHERE o."venueId" = ${venueId} AND ${ORDER_NOT_DISCARDED}
      AND (
        (o."createdAt" >= ${utcTs(fromDate)} AND o."createdAt" <= ${utcTs(toDate)})
        OR (o."createdAt" >= ${utcTs(prevFrom)} AND o."createdAt" <= ${utcTs(prevTo)})
      )
    GROUP BY 1
  `

  // Se acumula en Decimal, no en float: es dinero, y este total se compara contra
  // reportes que sí son Decimal.
  const current = Array.from({ length: 7 }, () => new Prisma.Decimal(0))
  const previous = Array.from({ length: 7 }, () => new Prisma.Decimal(0))

  for (const row of rows) {
    current[row.idx - 1] = new Prisma.Decimal(row.current)
    previous[row.idx - 1] = new Prisma.Decimal(row.previous)
  }

  return weekdays.map((day, i) => {
    const currentWeek = current[i].toDecimalPlaces(2).toNumber()
    const previousWeek = previous[i].toDecimalPlaces(2).toNumber()
    // Sin base de comparación no existe variación porcentual: 0, no un número
    // inventado. El dashboard pinta `previousWeek` al lado, así que el 0 se lee en
    // contexto y no se confunde con "no cambió".
    const changePercentage = previousWeek === 0 ? 0 : Math.round(((currentWeek - previousWeek) / previousWeek) * 100)

    return { day, currentWeek, previousWeek, changePercentage }
  })
}

// Accepts both the native Prisma `PaymentMethod` enum and the legacy MindForm
// string form ('CARD'/'CASH') already produced by qrPayments.legacy.service →
// mergedPayments.service. Falling through would bucket legacy QR payments as
// 'OTHER' and hide them from the "Sales by method" pie chart on /home.
function mapPaymentMethod(method: PaymentMethod | string): string {
  switch (method) {
    case 'CASH':
      return 'CASH'
    case 'CREDIT_CARD':
    case 'DEBIT_CARD':
    case 'CARD': // legacy MindForm passthrough
      return 'CARD'
    case 'DIGITAL_WALLET':
      return 'OTHER'
    default:
      return 'OTHER'
  }
}

/**
 * Get basic metrics data for initial dashboard load (priority data)
 */
export async function getBasicMetricsData(venueId: string, filters: BasicMetricsQuery = {}) {
  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Set default date range (last 7 days) if not provided
  const { from: fromDate, to: toDate } = parseDateRange(filters.fromDate, filters.toDate, 7)

  // 🔴 2026-09-01 (query-guard en producción): con el rango «este año», Testarudo
  // materializaba 24,631 pagos aquí — la PRIMERA llamada del home — para que el
  // navegador los sumara. Ahora los KPIs los suma Postgres (`summary`,
  // `paymentMethodsData`, `reviewStats`) sobre TODAS las filas del rango, y las
  // listas `payments`/`reviews` se conservan sólo por compatibilidad con pestañas
  // viejas, ACOTADAS a BASIC_METRICS_ROWS_CAP y declaradas en `meta`.
  //
  // Reglas de negocio idénticas a las de siempre: pagos COMPLETED, tipo != REFUND
  // (una devolución también es COMPLETED, pero es corrección, no venta), y órdenes
  // no CANCELLED. Puente legacy de MindForm: sus pagos QR viven en otra base, así
  // que se suman en Node SÓLO para ese venue (conjunto histórico finito).
  const cap = basicMetricsRowsCap()

  const compactResponse = filters.responseMode === 'aggregated-v1'
  const tz = venue.timezone || DEFAULT_TIMEZONE

  const [paymentAggregateRows, reviewStatsRows, payments, reviews] = await Promise.all([
    prisma.$queryRaw<Array<{ method: string; weekday: number; total: unknown; count: unknown; tips: unknown; tipPercentageSum: unknown }>>`
      SELECT
        CASE
          WHEN p."method" = 'CASH' THEN 'Efectivo'
          WHEN p."method" IN ('CREDIT_CARD', 'DEBIT_CARD') THEN 'Tarjeta'
          ELSE 'Otro'
        END AS "method",
        EXTRACT(DOW FROM ${localTs(tz, Prisma.raw('p."createdAt"'))})::int AS "weekday",
        COALESCE(SUM(p."amount"), 0) AS "total",
        COUNT(*) AS "count",
        COALESCE(SUM(p."tipAmount"), 0) AS "tips",
        COALESCE(SUM(CASE WHEN p."amount" > 0 THEN (p."tipAmount" / p."amount") * 100 ELSE 0 END), 0) AS "tipPercentageSum"
      FROM "Payment" p
      LEFT JOIN "Order" o ON o."id" = p."orderId"
      WHERE p."venueId" = ${venueId}
        AND p."status" = 'COMPLETED'
        AND p."type" <> 'REFUND'
        AND p."createdAt" >= ${utcTs(fromDate)} AND p."createdAt" <= ${utcTs(toDate)}
        AND (o."id" IS NULL OR o."status" <> 'CANCELLED')
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
    prisma.$queryRaw<Array<{ total: unknown; fiveStar: unknown }>>`
      SELECT COUNT(*) AS "total", COUNT(*) FILTER (WHERE r."overallRating" = 5) AS "fiveStar"
      FROM "Review" r
      WHERE r."venueId" = ${venueId}
        AND r."createdAt" >= ${utcTs(fromDate)} AND r."createdAt" <= ${utcTs(toDate)}
    `,
    compactResponse
      ? Promise.resolve([])
      : prisma.payment.findMany({
          where: {
            venueId,
            status: TransactionStatus.COMPLETED,
            type: { not: 'REFUND' },
            createdAt: { gte: fromDate, lte: toDate },
            order: { status: { not: 'CANCELLED' } },
          },
          select: { id: true, amount: true, tipAmount: true, method: true, createdAt: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: cap,
        }),
    compactResponse
      ? Promise.resolve([])
      : prisma.review.findMany({
          where: { venueId, createdAt: { gte: fromDate, lte: toDate } },
          select: { id: true, overallRating: true, createdAt: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: cap,
        }),
  ])

  const summary = { totalAmount: 0, totalTransactions: 0, totalTips: 0, avgTipPercentage: 0 }
  const methodTotals: Record<string, number> = {}
  const methodCounts: Record<string, number> = {}
  const reviewStats = { total: toNumber(reviewStatsRows[0]?.total), fiveStar: toNumber(reviewStatsRows[0]?.fiveStar) }
  const performanceByWeekday = new Array<number>(7).fill(0)
  let tipPercentageSum = 0
  for (const row of paymentAggregateRows) {
    const total = toNumber(row.total)
    const count = toNumber(row.count)
    summary.totalAmount += total
    summary.totalTransactions += count
    summary.totalTips += toNumber(row.tips)
    tipPercentageSum += toNumber(row.tipPercentageSum)
    methodTotals[row.method] = (methodTotals[row.method] ?? 0) + total
    methodCounts[row.method] = (methodCounts[row.method] ?? 0) + count
    performanceByWeekday[row.weekday] += total
  }
  summary.totalAmount = round2(summary.totalAmount)
  summary.totalTips = round2(summary.totalTips)
  summary.avgTipPercentage = summary.totalTransactions > 0 ? tipPercentageSum / summary.totalTransactions : 0
  for (let weekday = 0; weekday < performanceByWeekday.length; weekday++) {
    performanceByWeekday[weekday] = round2(performanceByWeekday[weekday])
  }

  // Listas de compatibilidad (acotadas). Se mantiene la forma exacta de siempre.
  const transformedPayments = payments.map(payment => ({
    id: payment.id,
    amount: Number(payment.amount),
    method: mapPaymentMethod(payment.method),
    createdAt: payment.createdAt.toISOString(),
    tips: [{ amount: Number(payment.tipAmount) }],
  }))

  // Puente legacy de MindForm (ver mergedPayments.service.ts): sus pagos QR no
  // están en Postgres, así que se suman aquí con las MISMAS reglas.
  if (venueId === MINDFORM_NEW_VENUE_ID) {
    const legacy = await fetchLegacyAnalyticsPayments(fromDate, toDate)
    for (const p of legacy) {
      summary.totalAmount = round2(summary.totalAmount + p.amount)
      summary.totalTips = round2(summary.totalTips + p.tipAmount)
      summary.totalTransactions += 1
      tipPercentageSum += p.amount > 0 ? (p.tipAmount / p.amount) * 100 : 0
      const label = mapPaymentMethod(p.method) === 'CASH' ? 'Efectivo' : mapPaymentMethod(p.method) === 'CARD' ? 'Tarjeta' : 'Otro'
      methodTotals[label] = (methodTotals[label] ?? 0) + p.amount
      methodCounts[label] = (methodCounts[label] ?? 0) + 1
      const weekday = DateTime.fromJSDate(p.createdAt, { zone: 'utc' }).setZone(tz).weekday % 7
      performanceByWeekday[weekday] = round2(performanceByWeekday[weekday] + p.amount)
      if (transformedPayments.length < cap) {
        transformedPayments.push({
          id: p.id,
          amount: p.amount,
          method: mapPaymentMethod(p.method),
          createdAt: p.createdAt.toISOString(),
          tips: [{ amount: p.tipAmount }],
        })
      }
    }
    summary.avgTipPercentage = summary.totalTransactions > 0 ? tipPercentageSum / summary.totalTransactions : 0
  }

  const transformedReviews = reviews.map(review => ({
    id: review.id,
    stars: review.overallRating,
    createdAt: review.createdAt.toISOString(),
  }))

  const paymentMethodsData = Object.entries(methodTotals).map(([method, total]) => ({
    method,
    total: round2(total),
    count: methodCounts[method] ?? 0,
  }))

  return {
    ...(compactResponse ? { responseMode: 'aggregated-v1' as const } : {}),
    payments: transformedPayments,
    reviews: transformedReviews,
    paymentMethodsData,
    summary,
    reviewStats,
    performanceByWeekday,
    meta: {
      paymentsTruncated: summary.totalTransactions > transformedPayments.length,
      paymentsTotal: summary.totalTransactions,
      reviewsTruncated: reviewStats.total > transformedReviews.length,
      reviewsTotal: reviewStats.total,
    },
  }
}

/** Tope de las listas de compatibilidad de basic-metrics (ver getBasicMetricsData). */
export const BASIC_METRICS_ROWS_CAP_DEFAULT = 5000
function basicMetricsRowsCap(): number {
  const crudo = Number(process.env.BASIC_METRICS_ROWS_CAP)
  return Number.isFinite(crudo) && crudo > 0 ? Math.floor(crudo) : BASIC_METRICS_ROWS_CAP_DEFAULT
}
function toNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  return Number(value ?? 0)
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Pagos QR legacy de MindForm ya filtrados con las reglas de analytics (COMPLETED,
 * sin REFUND). Sólo se llama para ese venue; para los demás nunca abre el pool.
 */
async function fetchLegacyAnalyticsPayments(fromDate: Date, toDate: Date) {
  const { rows } = await getLegacyPayments({ startDate: fromDate.toISOString(), endDate: toDate.toISOString() })
  return rows
    .filter(p => p.status === 'COMPLETED' && p.type !== 'REFUND')
    .map(p => ({
      id: p.id,
      amount: Number(p.amount),
      tipAmount: Number(p.tipAmount),
      method: String(p.method),
      createdAt: p.createdAt as Date,
    }))
}

/**
 * Página de detalle usada únicamente después de que el usuario pide exportar.
 * La carga normal del home nunca recorre estas filas; una exportación completa
 * avanza en páginas de hasta 500 y conserva el mismo filtro contable del KPI.
 */
export async function getBasicMetricsDetailsPage(venueId: string, filters: BasicMetricsDetailsQuery) {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true } })
  if (!venue) throw new NotFoundError(`Venue with ID ${venueId} not found`)

  const { from: fromDate, to: toDate } = parseDateRange(filters.fromDate, filters.toDate, 7)
  const limit = filters.limit ?? 500

  if (filters.kind === 'payments') {
    // MindForm is the only two-database exception. Its legacy history cannot
    // participate in a Prisma cursor, so the explicit export merges/sorts it
    // first and then slices deterministically. Other venues stay DB-paginated.
    if (venueId === MINDFORM_NEW_VENUE_ID) {
      const merged = (await fetchPaymentsForAnalytics(venueId, { fromDate, toDate })).sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
      )
      const cursorIndex = filters.cursor ? merged.findIndex(payment => payment.id === filters.cursor) : -1
      const start = cursorIndex >= 0 ? cursorIndex + 1 : 0
      const pageRows = merged.slice(start, start + limit + 1)
      const hasMore = pageRows.length > limit
      const visible = pageRows.slice(0, limit)
      return {
        items: visible.map(payment => transformBasicMetricPayment(payment)),
        nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      }
    }

    const rows = await prisma.payment.findMany({
      where: {
        venueId,
        status: TransactionStatus.COMPLETED,
        type: { not: 'REFUND' },
        createdAt: { gte: fromDate, lte: toDate },
        order: { status: { not: 'CANCELLED' } },
      },
      select: { id: true, amount: true, tipAmount: true, method: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    })
    const hasMore = rows.length > limit
    const visible = rows.slice(0, limit)
    return {
      items: visible.map(payment => transformBasicMetricPayment(payment)),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
    }
  }

  const rows = await prisma.review.findMany({
    where: { venueId, createdAt: { gte: fromDate, lte: toDate } },
    select: { id: true, overallRating: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
  })
  const hasMore = rows.length > limit
  const visible = rows.slice(0, limit)
  return {
    items: visible.map(review => ({
      id: review.id,
      stars: review.overallRating,
      createdAt: review.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
  }
}

function transformBasicMetricPayment(payment: {
  id: string
  amount: Prisma.Decimal | number
  tipAmount: Prisma.Decimal | number
  method: PaymentMethod | string
  createdAt: Date
}) {
  return {
    id: payment.id,
    amount: Number(payment.amount),
    method: mapPaymentMethod(payment.method),
    createdAt: payment.createdAt.toISOString(),
    tips: [{ amount: Number(payment.tipAmount) }],
  }
}

/**
 * Get specific chart data based on chart type
 */
export async function getChartData(venueId: string, chartType: string, filters: GeneralStatsQuery = {}) {
  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  const { from: fromDate, to: toDate } = parseDateRange(filters.fromDate, filters.toDate, 7)

  const dateFilter = {
    createdAt: {
      gte: fromDate,
      lte: toDate,
    },
  }

  switch (chartType) {
    case 'best-selling-products':
      return await getBestSellingProductsData(venueId, fromDate, toDate)

    case 'tips-over-time':
      return await getTipsOverTimeData(venueId, dateFilter)

    case 'sales-by-payment-method':
      return await getSalesByPaymentMethodData(venueId, dateFilter)

    case 'peak-hours':
      return await generatePeakHoursData(venueId, fromDate, toDate, venue.timezone)

    case 'weekly-trends':
      return await generateWeeklyTrendsData(venueId, fromDate, toDate, venue.timezone)

    // Strategic Analytics Chart Types
    case 'revenue-trends':
      return await getRevenueTrendsData(venueId, fromDate, toDate, venue.timezone)

    case 'aov-trends':
      return await getAOVTrendsData(venueId, fromDate, toDate, venue.timezone)

    case 'order-frequency':
      return await getOrderFrequencyData(venueId, fromDate, toDate, venue.timezone)

    case 'customer-satisfaction':
      return await getCustomerSatisfactionData(venueId, fromDate, toDate, venue.timezone)

    case 'kitchen-performance':
      return await getKitchenPerformanceData(venueId, fromDate, toDate)

    case 'sales-by-weekday':
      return await getSalesByWeekdayData(venueId, fromDate, toDate, venue.timezone)

    case 'category-mix':
      return await getCategoryMixData(venueId, fromDate, toDate)

    case 'channel-mix':
      return await getChannelMixData(venueId, fromDate, toDate)

    case 'sales-heatmap':
      return await getSalesHeatmapData(venueId, fromDate, toDate, venue.timezone)

    case 'discount-analysis':
      return await getDiscountAnalysisData(venueId, fromDate, toDate)

    case 'reservation-overview':
      return await getReservationOverviewData(venueId, fromDate, toDate, venue.timezone)

    case 'staff-ranking':
      return await getStaffRankingData(venueId, fromDate, toDate)

    default:
      throw new NotFoundError(`Chart type '${chartType}' not found`)
  }
}

/**
 * Get extended metrics data based on metric type
 */
export async function getExtendedMetrics(venueId: string, metricType: string, filters: GeneralStatsQuery = {}) {
  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  const { from: fromDate, to: toDate } = parseDateRange(filters.fromDate, filters.toDate, 7)

  switch (metricType) {
    case 'table-performance':
      return await generateTablePerformance(venueId, fromDate, toDate)

    case 'product-profitability':
      return await generateProductProfitability(venueId, fromDate, toDate)

    case 'staff-performance':
      return await generateStaffPerformance(venueId, fromDate, toDate)

    case 'prep-times':
      return {
        prepTimesByCategory: {
          entradas: { avg: 8, target: 10 },
          principales: { avg: 12, target: 15 },
          postres: { avg: 4, target: 5 },
          bebidas: { avg: 2, target: 3 },
        },
      }

    // Strategic Analytics Metric Types
    case 'staff-efficiency':
      return { staffPerformance: await generateStaffPerformance(venueId, fromDate, toDate) }

    case 'table-efficiency':
      return { tablePerformance: await generateTablePerformance(venueId, fromDate, toDate) }

    case 'product-analytics':
      return { productProfitability: await generateProductProfitability(venueId, fromDate, toDate) }

    default:
      throw new NotFoundError(`Metric type '${metricType}' not found`)
  }
}

// Helper functions for chart data
async function getBestSellingProductsData(venueId: string, fromDate: Date, toDate: Date) {
  const products = await aggregateProductQuantities(venueId, fromDate, toDate)
  return { products }
}

async function getTipsOverTimeData(venueId: string, dateFilter: { createdAt: { gte: Date; lte: Date } }) {
  // Exclude refund payments — their tipAmount is negative (post 2026-04-19
  // tip-split fix) and would under-report tips earned on sales.
  // ⚠️ Uses fetchPaymentsForAnalytics so MindForm legacy QR is included.
  // Remove helper + revert to prisma.payment.findMany once native QR ships.
  const payments = await fetchPaymentsForAnalytics(venueId, {
    fromDate: dateFilter.createdAt.gte,
    toDate: dateFilter.createdAt.lte,
  })

  const transformedPayments = payments.map(payment => ({
    createdAt: payment.createdAt.toISOString(),
    tips: [{ amount: payment.tipAmount }],
  }))

  return { payments: transformedPayments }
}

async function getSalesByPaymentMethodData(venueId: string, dateFilter: { createdAt: { gte: Date; lte: Date } }) {
  // Exclude refund payments from the "sales by method" breakdown — refunds
  // have negative amount and would show up as deductions in the chart.
  // ⚠️ Uses fetchPaymentsForAnalytics so MindForm legacy QR is included.
  // Remove helper + revert to prisma.payment.findMany once native QR ships.
  const payments = await fetchPaymentsForAnalytics(venueId, {
    fromDate: dateFilter.createdAt.gte,
    toDate: dateFilter.createdAt.lte,
  })

  const transformedPayments = payments.map(payment => ({
    amount: payment.amount,
    method: mapPaymentMethod(payment.method),
    createdAt: payment.createdAt.toISOString(),
  }))

  return { payments: transformedPayments }
}

// Strategic Analytics Chart Data Functions
async function getRevenueTrendsData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  // El ingreso del día = pagos COMPLETED de las órdenes CREADAS ese día local
  // (el pago cuenta con su orden aunque haya entrado después del rango, igual que
  // siempre). LEFT JOIN: un día cuyas órdenes no tienen pagos existe con 0.
  const rows = await prisma.$queryRaw<Array<{ date: string; revenue: Prisma.Decimal }>>`
    SELECT ${localDay(tz)} AS "date", COALESCE(SUM(p."amount"), 0) AS "revenue"
    FROM "Order" o
    LEFT JOIN "Payment" p ON p."orderId" = o."id" AND p."status" = 'COMPLETED'
    WHERE ${orderScope(venueId, fromDate, toDate)}
    GROUP BY 1
    ORDER BY 1
  `

  const revenue = rows.map(row => ({
    date: row.date,
    revenue: Number(row.revenue),
    formattedDate: formatShortDate(row.date, tz),
  }))

  return { revenue }
}

async function getAOVTrendsData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  // Ticket promedio por día local, contando SOLO órdenes con cobro (revenue > 0),
  // como siempre. La división total/count se queda en Node, idéntica.
  const rows = await prisma.$queryRaw<Array<{ date: string; total: Prisma.Decimal; count: number }>>`
    SELECT t."date", SUM(t."rev") AS "total", COUNT(*)::int AS "count"
    FROM (
      SELECT ${localDay(tz)} AS "date",
             (SELECT COALESCE(SUM(p."amount"), 0) FROM "Payment" p WHERE p."orderId" = o."id" AND p."status" = 'COMPLETED') AS "rev"
      FROM "Order" o
      WHERE ${orderScope(venueId, fromDate, toDate)}
    ) t
    WHERE t."rev" > 0
    GROUP BY t."date"
    ORDER BY t."date"
  `

  const aov = rows.map(row => ({
    date: row.date,
    aov: row.count > 0 ? Number(row.total) / row.count : 0,
    orderCount: row.count,
    formattedDate: formatShortDate(row.date, tz),
  }))

  return { aov }
}

async function getOrderFrequencyData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const rows = await prisma.$queryRaw<Array<{ hourNum: number; orders: number }>>`
    SELECT ${localHour(tz)} AS "hourNum", COUNT(*)::int AS "orders"
    FROM "Order" o
    WHERE ${orderScope(venueId, fromDate, toDate)}
    GROUP BY 1
    ORDER BY 1
  `

  const frequency = rows.map(row => ({
    hour: `${row.hourNum}:00`,
    orders: row.orders,
    hourNum: row.hourNum,
  }))

  return { frequency }
}

async function getCustomerSatisfactionData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  // SUM y COUNT exactos (enteros) en Postgres; la división y el `.toFixed(1)` —que
  // devuelve STRING, contrato de siempre— se quedan en Node.
  const rows = await prisma.$queryRaw<Array<{ date: string; totalRating: number; count: number }>>`
    SELECT ${localDay(tz, Prisma.raw('r."createdAt"'))} AS "date",
           SUM(r."overallRating")::int AS "totalRating", COUNT(*)::int AS "count"
    FROM "Review" r
    WHERE r."venueId" = ${venueId}
      AND r."createdAt" >= ${utcTs(fromDate)} AND r."createdAt" <= ${utcTs(toDate)}
    GROUP BY 1
    ORDER BY 1
  `

  const satisfaction = rows.map(row => ({
    date: row.date,
    rating: row.count > 0 ? (row.totalRating / row.count).toFixed(1) : 0,
    reviewCount: row.count,
    formattedDate: formatShortDate(row.date, tz),
  }))

  return { satisfaction }
}

async function getKitchenPerformanceData(venueId: string, fromDate: Date, toDate: Date) {
  // Cuenta líneas vendidas por TIPO de producto. ⚠️ Sin filtro de status de la
  // orden: el include original tampoco lo tenía, y cambiarlo aquí movería el
  // conteo. El tiempo de preparación por categoría no se mide hoy (`KdsOrderItem`
  // no tiene liga a `Product`); devolvía una constante más `Math.random()` y se
  // dejó en 0.
  const rows = await prisma.$queryRaw<Array<{ category: string; orders: number }>>`
    SELECT p."type"::text AS "category", COUNT(*)::int AS "orders"
    FROM "OrderItem" oi
    JOIN "Product" p ON p."id" = oi."productId"
    JOIN "Order" o ON o."id" = oi."orderId"
    WHERE p."venueId" = ${venueId}
      AND o."venueId" = ${venueId}
      AND o."createdAt" >= ${utcTs(fromDate)} AND o."createdAt" <= ${utcTs(toDate)}
    GROUP BY 1
    ORDER BY 1
  `

  const kitchen = rows.map(row => {
    const category = row.category || ProductType.OTHER
    const categoryName = category === ProductType.FOOD ? 'Comida' : category === ProductType.BEVERAGE ? 'Bebidas' : 'Otros'
    const target = category === ProductType.FOOD ? 15 : category === ProductType.BEVERAGE ? 5 : 10

    return {
      category: categoryName,
      prepTime: 0,
      target,
      orders: row.orders,
    }
  })

  return { kitchen }
}

// ==========================================
// Dashboard Engine: Additional Chart Types
// ==========================================

async function getSalesByWeekdayData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const rows = await prisma.$queryRaw<Array<{ weekday: number; sales: Prisma.Decimal; transactions: number }>>`
    SELECT ${localIsoDow(tz)} AS "weekday", SUM(o."total") AS "sales", COUNT(*)::int AS "transactions"
    FROM "Order" o
    WHERE ${orderScope(venueId, fromDate, toDate)}
    GROUP BY 1
  `

  const weekdayNames = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
  const weekdayData = new Map<number, { sales: number; transactions: number }>()
  for (const row of rows) {
    weekdayData.set(row.weekday, { sales: Number(row.sales), transactions: row.transactions })
  }

  return weekdayNames.map((name, i) => {
    const data = weekdayData.get(i + 1) || { sales: 0, transactions: 0 }
    return { day: name, sales: data.sales, transactions: data.transactions }
  })
}

async function getCategoryMixData(venueId: string, fromDate: Date, toDate: Date) {
  // `categoryName` es texto denormalizado en la línea: NULLIF replica el `|| 'Sin
  // categoría'` de siempre también para la cadena vacía.
  const rows = await prisma.$queryRaw<Array<{ category: string; revenue: Prisma.Decimal; quantity: number }>>`
    SELECT COALESCE(NULLIF(oi."categoryName", ''), 'Sin categoría') AS "category",
           SUM(COALESCE(oi."total", 0)) AS "revenue", SUM(oi."quantity")::int AS "quantity"
    FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    WHERE ${orderScope(venueId, fromDate, toDate)}
    GROUP BY 1
    ORDER BY 2 DESC, 1
  `

  const categories = rows.map(row => ({ category: row.category, revenue: Number(row.revenue), quantity: row.quantity }))
  const totalRevenue = categories.reduce((sum, c) => sum + c.revenue, 0)

  return categories.map(c => ({
    category: c.category,
    revenue: c.revenue,
    quantity: c.quantity,
    percentage: totalRevenue > 0 ? (c.revenue / totalRevenue) * 100 : 0,
  }))
}

async function getChannelMixData(venueId: string, fromDate: Date, toDate: Date) {
  const rows = await prisma.$queryRaw<Array<{ channel: string; revenue: Prisma.Decimal; count: number }>>`
    SELECT o."type"::text AS "channel", SUM(o."total") AS "revenue", COUNT(*)::int AS "count"
    FROM "Order" o
    WHERE ${orderScope(venueId, fromDate, toDate)}
    GROUP BY 1
    ORDER BY 2 DESC, 1
  `

  const channels = rows.map(row => ({ channel: row.channel || 'DINE_IN', revenue: Number(row.revenue), count: row.count }))
  const totalRevenue = channels.reduce((sum, c) => sum + c.revenue, 0)

  return channels.map(c => ({
    channel: c.channel,
    revenue: c.revenue,
    count: c.count,
    percentage: totalRevenue > 0 ? (c.revenue / totalRevenue) * 100 : 0,
  }))
}

async function getSalesHeatmapData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  // Rejilla weekday (0=lunes … 6=domingo) × hora, en la zona del venue.
  const rows = await prisma.$queryRaw<Array<{ day: number; hour: number; value: Prisma.Decimal }>>`
    SELECT (${localIsoDow(tz)} - 1) AS "day", ${localHour(tz)} AS "hour", SUM(o."total") AS "value"
    FROM "Order" o
    WHERE ${orderScope(venueId, fromDate, toDate)}
    GROUP BY 1, 2
  `

  const grid = new Map<string, number>()
  for (const row of rows) {
    grid.set(`${row.day}-${row.hour}`, Number(row.value))
  }

  const heatmap: Array<{ day: number; hour: number; value: number }> = []
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      heatmap.push({ day, hour, value: grid.get(`${day}-${hour}`) || 0 })
    }
  }

  return { heatmap }
}

/**
 * Discount analysis — counts BOTH places a giveaway can be booked.
 *
 * This used to filter `Order.discountAmount > 0` only. Combos and promotions
 * write their giveaway on the LINE (`OrderItem.discountAmount`) and leave
 * `Order.discountAmount` at 0, so a day with two discounted combos reported
 * `{ ordersWithDiscount: 0, totalDiscount: 0 }`.
 *
 * The two sources are kept SEPARATE in the response (`orderLevelDiscount` /
 * `itemLevelDiscount`) rather than silently merged: an accountant needs to see
 * whether a peso came off the whole ticket or off one product, and the split is
 * additive — the pre-existing fields keep their meaning ("all discount"), the
 * breakdown is new.
 *
 * A line only counts as item-level when its own total is already net of the
 * discount (`isItemLevelDiscountSql`, el gemelo SQL de `isItemLevelDiscount`).
 * "Cobrar" cortesías leave the line GROSS and book the giveaway on
 * `Order.discountAmount` instead — counting both sides would double them. Same
 * trap `salesGiveaways.ts` documents for Sales Summary.
 */
async function getDiscountAnalysisData(venueId: string, fromDate: Date, toDate: Date) {
  // Una fila por orden con descuento contable (subconsulta), reducida a totales en
  // el SELECT exterior. El filtro exterior (od > 0 OR idisc > 0) replica el
  // "continue" de siempre: el OR de la subconsulta casa el descuento CRUDO de la
  // línea, y una línea cuyo regalo ya vive en Order.discountAmount no aporta nada.
  const [row] = await prisma.$queryRaw<
    Array<{
      ordersWithDiscount: number
      orderLevelDiscount: Prisma.Decimal
      itemLevelDiscount: Prisma.Decimal
      totalRevenue: Prisma.Decimal
    }>
  >`
    SELECT COUNT(*)::int AS "ordersWithDiscount",
           COALESCE(SUM(t."od"), 0) AS "orderLevelDiscount",
           COALESCE(SUM(t."idisc"), 0) AS "itemLevelDiscount",
           COALESCE(SUM(t."total"), 0) AS "totalRevenue"
    FROM (
      SELECT o."total" AS "total",
             o."discountAmount" AS "od",
             COALESCE((SELECT SUM(oi."discountAmount") FROM "OrderItem" oi
                       WHERE oi."orderId" = o."id" AND ${Prisma.raw(isItemLevelDiscountSql('oi'))}), 0) AS "idisc"
      FROM "Order" o
      WHERE ${orderScope(venueId, fromDate, toDate)}
        AND (o."discountAmount" > 0 OR EXISTS (SELECT 1 FROM "OrderItem" oi2 WHERE oi2."orderId" = o."id" AND oi2."discountAmount" > 0))
    ) t
    WHERE t."od" > 0 OR t."idisc" > 0
  `

  const totalOrders = await prisma.order.count({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      createdAt: { gte: fromDate, lte: toDate },
    },
  })

  const ordersWithDiscount = row?.ordersWithDiscount ?? 0
  const orderLevelDiscount = Number(row?.orderLevelDiscount ?? 0)
  const itemLevelDiscount = Number(row?.itemLevelDiscount ?? 0)
  const totalRevenue = Number(row?.totalRevenue ?? 0)
  const totalDiscount = orderLevelDiscount + itemLevelDiscount

  return {
    ordersWithDiscount,
    totalOrders,
    discountRate: totalOrders > 0 ? (ordersWithDiscount / totalOrders) * 100 : 0,
    totalDiscount,
    // Breakdown of `totalDiscount` — whole-ticket vs per-product giveaways.
    orderLevelDiscount,
    itemLevelDiscount,
    averageDiscount: ordersWithDiscount > 0 ? totalDiscount / ordersWithDiscount : 0,
    revenueWithDiscount: totalRevenue,
  }
}

async function getReservationOverviewData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE

  // Check if venue has reservations table — return empty if not
  const reservationCount = await prisma.reservation
    .count({
      where: { venueId, createdAt: { gte: fromDate, lte: toDate } },
    })
    .catch(() => 0)

  if (reservationCount === 0) {
    return { reservations: [], summary: { total: 0, confirmed: 0, cancelled: 0, noShow: 0 } }
  }

  const rows = await prisma.$queryRaw<Array<{ date: string; total: number; confirmed: number; cancelled: number; noShow: number }>>`
    SELECT ${localDay(tz, Prisma.raw('r."createdAt"'))} AS "date",
           COUNT(*)::int AS "total",
           (COUNT(*) FILTER (WHERE r."status" IN ('CONFIRMED', 'COMPLETED')))::int AS "confirmed",
           (COUNT(*) FILTER (WHERE r."status" = 'CANCELLED'))::int AS "cancelled",
           (COUNT(*) FILTER (WHERE r."status" = 'NO_SHOW'))::int AS "noShow"
    FROM "Reservation" r
    WHERE r."venueId" = ${venueId}
      AND r."createdAt" >= ${utcTs(fromDate)} AND r."createdAt" <= ${utcTs(toDate)}
    GROUP BY 1
    ORDER BY 1
  `

  // El resumen sale de los mismos buckets; el arreglo por fecha conserva su forma
  // de siempre (sin noShow por día — agregarlo cambiaría el contrato sin motivo).
  const summary = { total: 0, confirmed: 0, cancelled: 0, noShow: 0 }
  for (const row of rows) {
    summary.total += row.total
    summary.confirmed += row.confirmed
    summary.cancelled += row.cancelled
    summary.noShow += row.noShow
  }

  return {
    reservations: rows.map(row => ({ date: row.date, total: row.total, confirmed: row.confirmed, cancelled: row.cancelled })),
    summary,
  }
}

async function getStaffRankingData(venueId: string, fromDate: Date, toDate: Date) {
  const rows = await prisma.$queryRaw<
    Array<{
      staffId: string
      firstName: string | null
      lastName: string | null
      revenue: Prisma.Decimal
      orders: number
      tips: Prisma.Decimal
    }>
  >`
    SELECT o."createdById" AS "staffId", s."firstName" AS "firstName", s."lastName" AS "lastName",
           SUM(o."total") AS "revenue", COUNT(*)::int AS "orders", SUM(COALESCE(o."tipAmount", 0)) AS "tips"
    FROM "Order" o
    LEFT JOIN "Staff" s ON s."id" = o."createdById"
    WHERE ${orderScope(venueId, fromDate, toDate)}
      AND o."createdById" IS NOT NULL
    GROUP BY o."createdById", s."firstName", s."lastName"
    ORDER BY SUM(o."total") DESC, o."createdById"
  `

  return rows.map(row => {
    const revenue = Number(row.revenue)
    const orders = row.orders
    return {
      name: `${row.firstName || ''} ${row.lastName || ''}`.trim() || 'Sin nombre',
      revenue,
      orders,
      tips: Number(row.tips),
      averageTicket: orders > 0 ? revenue / orders : 0,
    }
  })
}
