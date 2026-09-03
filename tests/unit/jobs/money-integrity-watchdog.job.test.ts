/**
 * Money watchdog — lo que cambió el 2026-09-02 y por qué.
 *
 * El 31-ago-2026 se borraron A PROPÓSITO 1,092 `Payment` (limpieza de cuentas Blumon "Externo");
 * sus 1,091 órdenes siguen PAID sin ningún cobro. La regla «PROPINA NO CUADRA» comparaba
 * `Order.tipAmount` contra una suma que sin pagos vale 0, así que pasó de 2 a 200 alertas por
 * corrida — y el «200» era el `LIMIT 200`, no el total (había 672).
 *
 * Tres garantías, cada una con su prueba:
 *  1. la propina sólo se juzga cuando HAY cobros con qué compararla;
 *  2. una orden PAID sin cobro es otra invariante, acotada a lo creado DESPUÉS de la limpieza;
 *  3. el resumen reporta el total REAL por tipo, no el tope de la lista.
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import {
  MoneyIntegrityWatchdogJob,
  TRIAGED_AWAITING_THIRD_PARTY,
  HUERFANAS_DESDE,
  DETAIL_LIMIT,
  VENTANA_DEL_BARRIDO_MIN,
  buildWatchdogSql,
} from '@/jobs/money-integrity-watchdog.job'
import { COBRO_QUE_CUBRE, criterioPagadaPeroAbiertaSql } from '@/services/shared/pagadaPeroAbierta'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $queryRawUnsafe: jest.fn() },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const raw = prisma.$queryRawUnsafe as unknown as jest.Mock
const info = logger.info as jest.Mock
const error = logger.error as jest.Mock

const NOW = new Date('2026-09-02T18:17:00Z')
const propina = (i: number) => ({ check: 'PROPINA NO CUADRA', venue: 'Doña Simona', order_id: `o${i}`, detalle: 'orden=95.10 cobros=0' })

/** El job hace dos lecturas: primero los totales por tipo, después el detalle acotado. */
function arm(counts: Array<{ check: string; n: number }>, rows: unknown[]) {
  raw.mockReset()
  raw.mockResolvedValueOnce(counts).mockResolvedValueOnce(rows)
}

beforeEach(() => {
  info.mockReset()
  error.mockReset()
})

describe('money-integrity-watchdog · la forma de las consultas', () => {
  const { counts, details } = buildWatchdogSql()
  const regla = (nombre: string) => {
    const desde = details.indexOf(`'${nombre}'`)
    const hasta = details.indexOf('UNION ALL', desde)
    return details.slice(desde, hasta === -1 ? undefined : hasta)
  }

  it('🔴 la propina sólo se juzga cuando la orden tiene al menos un cobro', () => {
    const propinaSql = regla('PROPINA NO CUADRA')
    // Un JOIN (no LEFT JOIN) contra el agregado de pagos: sin filas de Payment, la orden no entra.
    expect(propinaSql).toMatch(/\n\s*JOIN \(\s*SELECT "orderId", COUNT\(\*\) AS n/)
    expect(propinaSql).not.toMatch(/LEFT JOIN \(\s*SELECT "orderId"/)
  })

  it('🔴 «orden pagada sin cobro» existe, exige dinero y sólo mira lo creado después de la limpieza', () => {
    const huerfanas = regla('ORDEN PAGADA SIN COBRO')
    expect(huerfanas).toContain(`o."createdAt" >= '${HUERFANAS_DESDE}'`)
    expect(huerfanas).toContain('o."paidAmount" > 0')
    expect(huerfanas).toContain(`o."paymentStatus" = 'PAID'`)
    expect(huerfanas).toMatch(/NOT EXISTS \(SELECT 1 FROM "Payment" p WHERE p\."orderId" = o\.id\)/)
    expect(HUERFANAS_DESDE).toBe('2026-08-31')
  })

  it('🔴 «pagada pero abierta»: criterio del barrido, su ventana, y el `pagado` que reporta es el que la eligió', () => {
    for (const sql of [counts, details]) expect(sql).toContain("'PAGADA PERO ABIERTA'")

    const pagadaAbierta = regla('PAGADA PERO ABIERTA')
    // Por HUELLA, no por forma: una copia inline del criterio de hoy pasaría los regex y luego
    // se quedaría atrás en cuanto el módulo compartido cambiara — justo lo que esto impide.
    expect(pagadaAbierta).toContain(criterioPagadaPeroAbiertaSql('o'))
    // La gracia va con el reloj de pared UTC: un `NOW()` pelón acertaría en Render (sesión UTC) y
    // abriría un hueco de 6 h en la Mac (sesión America/Mexico_City) — ver sqlDates.ts.
    expect(pagadaAbierta).toContain(`o."updatedAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '${VENTANA_DEL_BARRIDO_MIN} minutes'`)
    expect(VENTANA_DEL_BARRIDO_MIN).toBe(15) // gracia del barrido (5) + un ciclo suyo (10)
    // Y el número del detalle sale de la MISMA regla de dinero (REFUND fuera), no de una copia:
    // si sumara distinto, explicaría la alerta con una cifra que no fue la que la disparó.
    expect(pagadaAbierta).toContain(
      `' pagado=' || (SELECT COALESCE(SUM(p.amount), 0) FROM "Payment" p WHERE p."orderId" = o.id AND ${COBRO_QUE_CUBRE})`,
    )
    expect(pagadaAbierta).toContain('Grupo Avoqado Prime')
  })

  it('los totales se cuentan sin tope y el detalle sí lleva tope', () => {
    expect(counts).not.toMatch(/LIMIT/i)
    expect(counts).toMatch(/GROUP BY "check"/)
    expect(details).toMatch(new RegExp(`LIMIT ${DETAIL_LIMIT}\\s*$`))
  })

  it('regresión: las 5 invariantes previas siguen ahí y con el filtro de venues reales', () => {
    for (const nombre of ['TOTAL NEGATIVO', 'DESCUENTO EXCEDE EL CONSUMO', 'PROPINA NO CUADRA', 'SOBREPAGO', 'ORDEN PAGADA SIN COBRO']) {
      expect(regla(nombre)).toContain('Grupo Avoqado Prime')
    }
  })
})

describe('money-integrity-watchdog · lo que reporta', () => {
  it('🔴 el resumen dice el total REAL aunque el detalle esté acotado', async () => {
    arm(
      [{ check: 'PROPINA NO CUADRA', n: 672 }],
      Array.from({ length: DETAIL_LIMIT }, (_, i) => propina(i)),
    )

    const r = await new MoneyIntegrityWatchdogJob().runNow(NOW)

    expect(r).toEqual({ expired: false, total: 672, mostrados: DETAIL_LIMIT, porTipo: { 'PROPINA NO CUADRA': 672 } })
    const resumen = error.mock.calls.find(([msg]) => String(msg).includes('problema(s) de dinero'))
    expect(resumen?.[0]).toContain('672 problema(s)')
    expect(resumen?.[1]).toMatchObject({ porTipo: { 'PROPINA NO CUADRA': 672 }, mostrados: DETAIL_LIMIT })
    // Una línea por violación mostrada, con el nombre del venue en el campo que filtra Better Stack.
    expect(error.mock.calls.filter(([msg]) => String(msg).includes('PROPINA NO CUADRA'))).toHaveLength(DETAIL_LIMIT)
    expect(error.mock.calls[0][1]).toMatchObject({ venueName: 'Doña Simona', orderId: 'o0' })
  })

  it('los casos ya triados se restan del total y no gritan', async () => {
    const [triado] = Object.keys(TRIAGED_AWAITING_THIRD_PARTY)
    arm([{ check: 'SOBREPAGO', n: 1 }], [{ check: 'SOBREPAGO', venue: 'Mindform', order_id: triado, detalle: 'cobrado=734 cuenta=380' }])

    const r = await new MoneyIntegrityWatchdogJob().runNow(NOW)

    expect(r).toEqual({ expired: false, total: 0, mostrados: 0, porTipo: {} })
    expect(error).not.toHaveBeenCalled()
    expect(info.mock.calls.some(([msg]) => String(msg).includes('ya triado'))).toBe(true)
    expect(info.mock.calls.some(([msg]) => String(msg).includes('Todo cuadra'))).toBe(true)
  })

  it('regresión: todo en verde calla, y no grita por nada', async () => {
    arm([], [])

    const r = await new MoneyIntegrityWatchdogJob().runNow(NOW)

    expect(r).toEqual({ expired: false, total: 0, mostrados: 0, porTipo: {} })
    expect(error).not.toHaveBeenCalled()
  })

  it('regresión: pasada la fecha de vigencia no consulta nada', async () => {
    arm([], [])

    const r = await new MoneyIntegrityWatchdogJob().runNow(new Date('2027-01-01T00:00:00Z'))

    expect(r).toEqual({ expired: true, total: 0, mostrados: 0, porTipo: {} })
    expect(raw).not.toHaveBeenCalled()
  })

  it('regresión: un fallo de la base se reporta y no tumba el cron', async () => {
    raw.mockReset()
    raw.mockRejectedValue(new Error('connection lost'))

    await expect(new MoneyIntegrityWatchdogJob().runNow(NOW)).resolves.toEqual({ expired: false, total: 0, mostrados: 0, porTipo: {} })
    expect(error.mock.calls.some(([msg]) => String(msg).includes('La revisión falló'))).toBe(true)
  })
})
