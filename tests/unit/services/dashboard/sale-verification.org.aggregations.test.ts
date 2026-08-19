/**
 * Org Sale Verification Aggregations Tests (Asana 1215613218390496)
 *
 * Covers the PlayTelecom org "Ventas" executive dashboard fixes:
 *   - getOrgSalesSummary: `confirmedRevenue` only sums payments whose
 *     SaleVerification is COMPLETED ("solo ventas confirmadas en totales").
 *     Regression: the "Monto confirmado" KPI used totalRevenue, which
 *     includes PENDING ("en revisión") and unverified sales.
 *   - getSalesBySupervisor: a venue's MANAGER (the real "Supervisor
 *     responsable") takes precedence over ADMIN in attribution.
 *     Regression: org ADMINs (e.g. executives) with a lower staffId were
 *     reported as supervisors of every store.
 *   - getSalesBySupervisor / getSalesByStore: expose `byMonth` buckets
 *     (client tables are month-by-month) while keeping `byWeek`.
 *   - getSalesByPromoter: new monthly grouping by the staff who sold.
 */

import {
  getOrgSalesSummary,
  getSalesBySupervisor,
  getSalesByStore,
  getSalesByPromoter,
  getSalesByPromoterDaily,
  getSalesByPromoterWeekly,
  getSalesByWeek,
  getSalesByMonth,
  getSalesByCity,
  getSalesBySaleTypeWeekly,
  getSalesBySimTypeWeekly,
  getSalesBySimType,
  toSimBucket,
  parseRange,
} from '@/services/dashboard/sale-verification.org.dashboard.service'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn() },
    saleVerification: { findMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
    // Desde 2026-08-04 las agregaciones agrupan en Postgres (`$queryRaw`) en vez de
    // recorrer filas en JS. Ver el incidente del event loop en el spec.
    $queryRaw: jest.fn(),
  },
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn() },
}))

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn() },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const mockedPaymentFindMany = prisma.payment.findMany as jest.Mock
const mockedSvFindMany = prisma.saleVerification.findMany as jest.Mock
const mockedStaffVenueFindMany = prisma.staffVenue.findMany as jest.Mock
const mockedQueryRaw = prisma.$queryRaw as jest.Mock

/** El SQL que se le pasó a `$queryRaw` en la llamada N, como texto plano. */
function sqlDeLlamada(n = 0): string {
  const arg = mockedQueryRaw.mock.calls[n]?.[0]
  return arg?.strings ? arg.strings.join(' ') : String(arg ?? '')
}

const ORG_ID = 'org-playtelecom'

beforeEach(() => {
  jest.clearAllMocks()
})

describe('getOrgSalesSummary — confirmedRevenue', () => {
  it('only sums payments whose verification is COMPLETED, and counts each status', async () => {
    // El mismo escenario de antes, ya agrupado por Postgres: 1 COMPLETED de $100,
    // 1 PENDING de $50, 1 FAILED de $25, 1 REJECTED de $30 y 1 sin verificación de $10.
    mockedQueryRaw.mockResolvedValue([
      {
        total_revenue: '215',
        confirmed_revenue: '100',
        total_count: BigInt(5),
        completed_count: BigInt(1),
        pending_count: BigInt(1),
        failed_count: BigInt(1),
        rejected_count: BigInt(1),
        without_verification_count: BigInt(1),
      },
    ])

    const summary = await getOrgSalesSummary(ORG_ID, {})

    expect(summary.confirmedRevenue).toBe(100)
    // totalRevenue conserva la semántica previa (todo pago completado) por compatibilidad.
    expect(summary.totalRevenue).toBe(215)
    expect(summary.completedCount).toBe(1)
    expect(summary.pendingCount).toBe(1)
    expect(summary.failedCount).toBe(1)
    expect(summary.rejectedCount).toBe(1)
    expect(summary.withoutVerificationCount).toBe(1)
  })

  it('returns zero confirmedRevenue when nothing is confirmed', async () => {
    mockedQueryRaw.mockResolvedValue([
      {
        total_revenue: '60',
        confirmed_revenue: '0',
        total_count: BigInt(2),
        completed_count: BigInt(0),
        pending_count: BigInt(1),
        failed_count: BigInt(0),
        rejected_count: BigInt(0),
        without_verification_count: BigInt(1),
      },
    ])

    const summary = await getOrgSalesSummary(ORG_ID, {})

    expect(summary.confirmedRevenue).toBe(0)
    expect(summary.totalRevenue).toBe(60)
  })

  it('devuelve ceros, no NaN ni undefined, cuando no hay pagos', async () => {
    // Postgres devuelve NULL en los SUM cuando no hay filas; el COALESCE + Number(… ?? 0)
    // tiene que dejar ceros de verdad. Un NaN aquí pintaría "$NaN" en el KPI.
    mockedQueryRaw.mockResolvedValue([
      {
        total_revenue: null,
        confirmed_revenue: null,
        total_count: BigInt(0),
        completed_count: BigInt(0),
        pending_count: BigInt(0),
        failed_count: BigInt(0),
        rejected_count: BigInt(0),
        without_verification_count: BigInt(0),
      },
    ])

    const summary = await getOrgSalesSummary(ORG_ID, {})

    expect(summary.totalRevenue).toBe(0)
    expect(summary.confirmedRevenue).toBe(0)
    expect(Number.isNaN(summary.totalRevenue)).toBe(false)
  })

  it('parte de TODOS los pagos completados, no sólo de las ventas confirmadas', async () => {
    // Su universo es distinto al de las demás agregaciones a propósito: incluye pagos
    // sin verificación. Por eso el FROM arranca en "Payment", no en "SaleVerification".
    mockedQueryRaw.mockResolvedValue([
      {
        total_revenue: '0',
        confirmed_revenue: '0',
        total_count: BigInt(0),
        completed_count: BigInt(0),
        pending_count: BigInt(0),
        failed_count: BigInt(0),
        rejected_count: BigInt(0),
        without_verification_count: BigInt(0),
      },
    ])
    await getOrgSalesSummary(ORG_ID, {})
    const sql = sqlDeLlamada().replace(/\s+/g, ' ')
    expect(sql).toContain('FROM "Payment" p')
    expect(sql).toContain(`LEFT JOIN "SaleVerification" sv`)
    expect(sql).toContain(`p."status" = 'COMPLETED'`)
    expect(mockedPaymentFindMany).not.toHaveBeenCalled()
  })
})

describe('getSalesBySupervisor — MANAGER-first attribution', () => {
  it('attributes sales to the venue MANAGER even when an ADMIN has a lower staffId', async () => {
    // Postgres ya agrupó: 1 venta en marzo y 1 en abril, ambas de venue-1.
    mockedQueryRaw.mockResolvedValue([
      { venue_id: 'venue-1', week: 'W11', month: '2026-03', count: BigInt(1) },
      { venue_id: 'venue-1', week: 'W16', month: '2026-04', count: BigInt(1) },
    ])
    // El ADMIN va primero por staffId — la lógica vieja lo escogía como "supervisor".
    mockedStaffVenueFindMany.mockResolvedValue([
      { venueId: 'venue-1', staffId: 'a-admin', role: 'ADMIN', staff: { id: 'a-admin', firstName: 'Jordi', lastName: 'Mota' } },
      { venueId: 'venue-1', staffId: 'z-manager', role: 'MANAGER', staff: { id: 'z-manager', firstName: 'Hugo', lastName: 'Gonzalez' } },
    ])

    const rows = await getSalesBySupervisor(ORG_ID, {})

    expect(rows).toHaveLength(1)
    expect(rows[0].supervisorId).toBe('z-manager')
    expect(rows[0].supervisorName).toBe('Hugo Gonzalez')
    expect(rows[0].total).toBe(2)
    // Buckets mensuales para las tablas mes-a-mes del cliente
    expect(rows[0].byMonth).toEqual({ '2026-03': 1, '2026-04': 1 })
    expect(Object.keys(rows[0].byWeek)).toHaveLength(2)
  })

  it('falls back to ADMIN when the venue has no MANAGER', async () => {
    mockedQueryRaw.mockResolvedValue([{ venue_id: 'venue-1', week: 'W11', month: '2026-03', count: BigInt(1) }])
    mockedStaffVenueFindMany.mockResolvedValue([
      { venueId: 'venue-1', staffId: 'a-admin', role: 'ADMIN', staff: { id: 'a-admin', firstName: 'Edgar', lastName: 'Salazar' } },
    ])

    const rows = await getSalesBySupervisor(ORG_ID, {})

    expect(rows[0].supervisorId).toBe('a-admin')
    expect(rows[0].supervisorName).toBe('Edgar Salazar')
  })

  it('reports "Sin supervisor" when the venue has neither', async () => {
    mockedQueryRaw.mockResolvedValue([{ venue_id: 'venue-1', week: 'W11', month: '2026-03', count: BigInt(1) }])
    mockedStaffVenueFindMany.mockResolvedValue([])

    const rows = await getSalesBySupervisor(ORG_ID, {})

    expect(rows[0].supervisorId).toBeNull()
    expect(rows[0].supervisorName).toBe('Sin supervisor')
  })

  it('junta bajo un mismo supervisor las ventas de varias tiendas suyas', async () => {
    // Dos sucursales, mismo responsable: la fila del supervisor debe sumar las dos.
    mockedQueryRaw.mockResolvedValue([
      { venue_id: 'venue-1', week: 'W11', month: '2026-03', count: BigInt(3) },
      { venue_id: 'venue-2', week: 'W11', month: '2026-03', count: BigInt(2) },
    ])
    mockedStaffVenueFindMany.mockResolvedValue([
      { venueId: 'venue-1', staffId: 'sup', role: 'MANAGER', staff: { id: 'sup', firstName: 'Luis', lastName: 'Pérez' } },
      { venueId: 'venue-2', staffId: 'sup', role: 'MANAGER', staff: { id: 'sup', firstName: 'Luis', lastName: 'Pérez' } },
    ])

    const rows = await getSalesBySupervisor(ORG_ID, {})

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ supervisorId: 'sup', total: 5, byWeek: { W11: 5 }, byMonth: { '2026-03': 5 } })
  })
})

describe('getSalesByPromoterWeekly — una fila por (promotor, tienda)', () => {
  it('separa al mismo promotor cuando vendió en dos tiendas', async () => {
    mockedQueryRaw.mockResolvedValue([
      { staff_id: 's1', first_name: 'Ana', last_name: 'López', venue_id: 'v1', venue_name: 'BAE Papagayo', week: 'W32', count: BigInt(4) },
      { staff_id: 's1', first_name: 'Ana', last_name: 'López', venue_id: 'v2', venue_name: 'BAE Pavón', week: 'W32', count: BigInt(1) },
    ])
    mockedStaffVenueFindMany.mockResolvedValue([
      { venueId: 'v1', staffId: 'sup', role: 'MANAGER', staff: { id: 'sup', firstName: 'Luis', lastName: 'Pérez' } },
    ])

    const rows = await getSalesByPromoterWeekly(ORG_ID, {})

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      staffId: 's1',
      promoterName: 'Ana López',
      venueId: 'v1',
      venueName: 'BAE Papagayo',
      supervisorId: 'sup',
      supervisorName: 'Luis Pérez',
      byWeek: { W32: 4 },
      total: 4,
    })
    expect(rows[1]).toMatchObject({ venueId: 'v2', supervisorId: null, supervisorName: 'Sin supervisor', total: 1 })
  })

  it('descarta las ventas sin promotor o sin tienda (no se pueden atribuir)', async () => {
    mockedQueryRaw.mockResolvedValue([
      { staff_id: null, first_name: null, last_name: null, venue_id: 'v1', venue_name: 'BAE Papagayo', week: 'W32', count: BigInt(3) },
    ])
    mockedStaffVenueFindMany.mockResolvedValue([])

    const rows = await getSalesByPromoterWeekly(ORG_ID, {})

    expect(rows).toEqual([])
  })
})

describe('getSalesByStore — byMonth buckets', () => {
  it('exposes month buckets alongside weeks', async () => {
    mockedQueryRaw.mockResolvedValue([
      { venue_id: 'venue-1', venue_name: 'BAE POZOS', week: 'W11', month: '2026-03', count: BigInt(2) },
      { venue_id: 'venue-2', venue_name: 'GEOPLAZAS', week: 'W16', month: '2026-04', count: BigInt(1) },
    ])

    const rows = await getSalesByStore(ORG_ID, {})

    expect(rows).toHaveLength(2)
    // Ordenadas de mayor a menor total
    expect(rows[0].venueName).toBe('BAE POZOS')
    expect(rows[0].byMonth).toEqual({ '2026-03': 2 })
    expect(rows[0].byWeek).toEqual({ W11: 2 })
    expect(rows[1].byMonth).toEqual({ '2026-04': 1 })
  })

  it('suma las semanas de un mismo mes en el bucket mensual', async () => {
    // Dos semanas del mismo mes en la misma tienda: el mes debe traer la suma, no la última.
    mockedQueryRaw.mockResolvedValue([
      { venue_id: 'v1', venue_name: 'BAE POZOS', week: 'W11', month: '2026-03', count: BigInt(2) },
      { venue_id: 'v1', venue_name: 'BAE POZOS', week: 'W12', month: '2026-03', count: BigInt(3) },
    ])

    const rows = await getSalesByStore(ORG_ID, {})

    expect(rows[0].byMonth).toEqual({ '2026-03': 5 })
    expect(rows[0].byWeek).toEqual({ W11: 2, W12: 3 })
    expect(rows[0].total).toBe(5)
  })
})

describe('getSalesByPromoter — monthly grouping', () => {
  it('groups by verification staff, sorted desc, with "Sin promotor" fallback', async () => {
    mockedQueryRaw.mockResolvedValue([
      { staff_id: 's1', first_name: 'Susana', last_name: 'Valdez', bucket: '2026-03', count: BigInt(1) },
      { staff_id: 's1', first_name: 'Susana', last_name: 'Valdez', bucket: '2026-04', count: BigInt(1) },
      { staff_id: 's2', first_name: 'Ricardo', last_name: 'Martinez', bucket: '2026-04', count: BigInt(1) },
      { staff_id: null, first_name: null, last_name: null, bucket: '2026-04', count: BigInt(1) },
    ])

    const rows = await getSalesByPromoter(ORG_ID, {})

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      staffId: 's1',
      promoterName: 'Susana Valdez',
      total: 2,
      byMonth: { '2026-03': 1, '2026-04': 1 },
    })
    expect(rows[1]).toMatchObject({ staffId: 's2', total: 1 })
    expect(rows[2]).toMatchObject({ staffId: null, promoterName: 'Sin promotor', total: 1 })
  })

  it('only queries CONFIRMED verifications (status=COMPLETED in the where clause)', async () => {
    mockedQueryRaw.mockResolvedValue([])

    await getSalesByPromoter(ORG_ID, {})

    const sql = sqlDeLlamada().replace(/\s+/g, ' ')
    expect(sql).toContain(`sv."status" = 'COMPLETED'`)
    expect(sql).toContain(`v."organizationId"`)
    expect(mockedQueryRaw.mock.calls[0][0].values).toContain(ORG_ID)
  })
})

describe('getSalesByCity', () => {
  it('agrupa por ciudad × mes y ordena por total desc', async () => {
    mockedQueryRaw.mockResolvedValue([
      { city: 'Querétaro', bucket: '2026-07', count: BigInt(2) },
      { city: 'Querétaro', bucket: '2026-08', count: BigInt(5) },
      { city: 'San Luis Potosí', bucket: '2026-08', count: BigInt(3) },
    ])

    const rows = await getSalesByCity(ORG_ID, {})

    expect(rows).toEqual([
      { city: 'Querétaro', byMonth: { '2026-07': 2, '2026-08': 5 }, total: 7 },
      { city: 'San Luis Potosí', byMonth: { '2026-08': 3 }, total: 3 },
    ])
  })

  it('agrupa bajo "Sin ciudad" las sucursales sin ciudad capturada', async () => {
    // Varias sucursales de PlayTelecom no tienen ciudad; deben caer todas en el mismo grupo.
    mockedQueryRaw.mockResolvedValue([
      { city: null, bucket: '2026-08', count: BigInt(4) },
      { city: '', bucket: '2026-08', count: BigInt(1) },
    ])

    const rows = await getSalesByCity(ORG_ID, {})

    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ city: 'Sin ciudad', byMonth: { '2026-08': 5 }, total: 5 })
  })
})

describe('getSalesByPromoterDaily — current month, per-day + toReview', () => {
  // "Now" in venue tz (CDMX), exactly how the service derives the current month.
  function cdmxNow(): Date {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }))
  }
  it('counts COMPLETED per day in total, splits FAILED into this-month (toReview) vs prior (toReviewPrevious), excludes both from total, sorted desc', async () => {
    const c = cdmxNow()
    const mes = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}`
    // Postgres ya devuelve agrupado. `day_key` sólo viene lleno en las filas COMPLETED;
    // las de "por revisar" llegan con day_key null.
    mockedQueryRaw.mockResolvedValue([
      // promotora A: 2 confirmadas el día 1 + 1 por revisar de este mes + 1 de meses anteriores
      {
        staff_id: 'A',
        first_name: 'Nancy',
        last_name: 'Casillas',
        day_key: `${mes}-01`,
        completed_count: BigInt(2),
        to_review: BigInt(0),
        to_review_previous: BigInt(0),
      },
      {
        staff_id: 'A',
        first_name: 'Nancy',
        last_name: 'Casillas',
        day_key: null,
        completed_count: BigInt(0),
        to_review: BigInt(1),
        to_review_previous: BigInt(1),
      },
      // promotora B: 1 confirmada
      {
        staff_id: 'B',
        first_name: 'Patricia',
        last_name: 'Navarro',
        day_key: `${mes}-01`,
        completed_count: BigInt(1),
        to_review: BigInt(0),
        to_review_previous: BigInt(0),
      },
      // promotora C: SÓLO una por revisar de meses anteriores → debe aparecer igual, con total 0
      {
        staff_id: 'C',
        first_name: 'Lucía',
        last_name: 'Briones',
        day_key: null,
        completed_count: BigInt(0),
        to_review: BigInt(0),
        to_review_previous: BigInt(1),
      },
    ])

    const result = await getSalesByPromoterDaily(ORG_ID)

    expect(result.rows[0]).toMatchObject({ staffId: 'A', total: 2, toReview: 1, toReviewPrevious: 1 })
    expect(result.rows[1]).toMatchObject({ staffId: 'B', total: 1, toReview: 0, toReviewPrevious: 0 })
    const cRow = result.rows.find(r => r.staffId === 'C')!
    expect(cRow).toMatchObject({ total: 0, toReview: 0, toReviewPrevious: 1 })
    expect(result.rows[0].byDay[`${mes}-01`]).toBe(2)
    // 🔴 `byDay` nunca incluye las "por revisar": su suma tiene que ser exactamente `total`.
    // Si una por-revisar se colara, el promotor cobraría comisión por una venta no confirmada.
    expect(Object.values(result.rows[0].byDay).reduce((a, b) => a + b, 0)).toBe(result.rows[0].total)
  })

  it('queries COMPLETED (this month) OR FAILED (any date), so prior-month to-review is available', async () => {
    mockedQueryRaw.mockResolvedValue([])

    const result = await getSalesByPromoterDaily(ORG_ID)

    const sql = sqlDeLlamada().replace(/\s+/g, ' ')
    expect(sql).toContain(`sv."status" = 'COMPLETED'`)
    expect(sql).toContain(`OR sv."status" = 'FAILED'`)
    // La comparación de fecha marca la columna como UTC: sin eso el mes se corre 6 horas.
    expect(sql).toContain(`sv."createdAt" AT TIME ZONE 'UTC' >=`)
    // El mes es el actual en CDMX; los días van del 1 a hoy.
    const c = cdmxNow()
    expect(result.month).toBe(`${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}`)
    expect(result.days.length).toBe(c.getDate())
    expect(result.days[0]).toBe(`${result.month}-01`)
  })
})

describe('toSimBucket', () => {
  it('maps the three fixed categories exactly', () => {
    expect(toSimBucket('$100 de Promotor')).toBe('$100 de Promotor')
    expect(toSimBucket('SIM de Evento')).toBe('SIM de Evento')
    expect(toSimBucket('SIM de Caja Vinculado')).toBe('SIM de Caja Vinculado')
  })
  it('is trim/case-insensitive', () => {
    // Prod escribe la categoría en minúsculas ("$100 de promotor", "SIM de evento");
    // la etiqueta de la fila es la del bucket, no la del dato.
    expect(toSimBucket('  $100 de promotor ')).toBe('$100 de Promotor')
    expect(toSimBucket('SIM de evento')).toBe('SIM de Evento')
    expect(toSimBucket('sim de caja vinculado')).toBe('SIM de Caja Vinculado')
  })
  it('routes eSIM categories to "e-SIM" via substring match', () => {
    expect(toSimBucket('E-SIM de promotor')).toBe('e-SIM')
    expect(toSimBucket('eSIM')).toBe('e-SIM')
    expect(toSimBucket('E-Sim Telcel')).toBe('e-SIM')
  })
  it('routes null and unknown categories to "Otros SIMs"', () => {
    expect(toSimBucket(null)).toBe('Otros SIMs')
    expect(toSimBucket('Cualquier otra')).toBe('Otros SIMs')
    expect(toSimBucket('SIM de regalo')).toBe('Otros SIMs')
  })
  it('keeps the "$xx de caja" family in "Otros SIMs" — only "SIM de Caja Vinculado" is split out', () => {
    // Isaac pidió visibilidad de UNA categoría "de caja", no de la familia entera
    // (Asana "Cambios a tablas de Ventas", 2026-08-18). Un match por substring
    // arrastraría las 9 categorías "$xx de caja" y rompería lo pedido.
    expect(toSimBucket('$40 de caja')).toBe('Otros SIMs')
    expect(toSimBucket('$20 de caja')).toBe('Otros SIMs')
    expect(toSimBucket('$95 de caja')).toBe('Otros SIMs')
  })
  it('no longer splits out "SIM de Intercambio" (categoría inexistente en prod: 0 ventas)', () => {
    expect(toSimBucket('SIM de Intercambio')).toBe('Otros SIMs')
  })
})

describe('getSalesBySaleTypeWeekly', () => {
  it('splits COMPLETED sales by isPortabilidad into fixed weekly rows', async () => {
    mockedQueryRaw.mockResolvedValue([
      { bucket: '2026-W11', is_portabilidad: false, count: BigInt(1) },
      { bucket: '2026-W12', is_portabilidad: false, count: BigInt(1) },
      { bucket: '2026-W11', is_portabilidad: true, count: BigInt(1) },
    ])
    const rows = await getSalesBySaleTypeWeekly(ORG_ID, {})
    expect(rows.map(r => r.name)).toEqual(['Líneas Nuevas', 'Portabilidades'])
    expect(rows[0]).toMatchObject({ total: 2, byWeek: { '2026-W11': 1, '2026-W12': 1 } })
    expect(rows[1]).toMatchObject({ total: 1, byWeek: { '2026-W11': 1 } })
  })

  it('returns both rows even when one type has zero sales', async () => {
    mockedQueryRaw.mockResolvedValue([{ bucket: '2026-W11', is_portabilidad: false, count: BigInt(1) }])
    const rows = await getSalesBySaleTypeWeekly(ORG_ID, {})
    expect(rows.map(r => r.name)).toEqual(['Líneas Nuevas', 'Portabilidades'])
    expect(rows[1]).toMatchObject({ total: 0, byWeek: {} })
  })

  it('only queries CONFIRMED verifications, scoped to the organization', async () => {
    mockedQueryRaw.mockResolvedValue([])
    await getSalesBySaleTypeWeekly(ORG_ID, {})
    expect(sqlDeLlamada()).toContain(`sv."status" = 'COMPLETED'`)
    expect(sqlDeLlamada()).toContain(`v."organizationId"`)
    expect(mockedQueryRaw.mock.calls[0][0].values).toContain(ORG_ID)
  })

  it('ya no trae filas crudas: una sola consulta agregada', async () => {
    mockedQueryRaw.mockResolvedValue([])
    await getSalesBySaleTypeWeekly(ORG_ID, {})
    expect(mockedQueryRaw).toHaveBeenCalledTimes(1)
    expect(mockedSvFindMany).not.toHaveBeenCalled()
  })
})

describe('llave de semana ISO — la calcula Postgres, no JS', () => {
  /**
   * El bucketing por semana se hace ahora con `to_char(..., 'IYYY-"W"IW')`.
   * La equivalencia real contra Postgres se prueba en
   * `tests/api-tests/sale-verification.org.week-parity.api.test.ts` (13 instantes de
   * frontera, bajo las dos zonas de host). Aquí sólo se blinda el formato: `IYYY` es lo
   * que hace que el 3-ene-2027 caiga en `2026-W53` y no en `2027-W53`.
   */
  it('usa IYYY (año ISO), no YYYY (calendario)', async () => {
    mockedQueryRaw.mockResolvedValue([])
    await getSalesBySaleTypeWeekly(ORG_ID, {})
    expect(sqlDeLlamada()).toContain(`'IYYY-"W"IW'`)
    expect(sqlDeLlamada()).not.toContain(`'YYYY-"W"IW'`)
  })

  it('convierte a hora del venue antes de sacar la semana', async () => {
    mockedQueryRaw.mockResolvedValue([])
    await getSalesBySaleTypeWeekly(ORG_ID, {})
    expect(sqlDeLlamada()).toContain(`AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City'`)
  })
})

describe('getSalesBySimTypeWeekly', () => {
  const W11 = '2026-W11'
  /** Fila ya agrupada por Postgres: categoría cruda + conteo en esa semana. */
  const cat = (name: string | null, count: number) => ({ bucket: W11, category_name: name, count: BigInt(count) })

  it('groups by SIM bucket per week; fixed rows (incl. e-SIM) always present; Otros only when > 0', async () => {
    mockedQueryRaw.mockResolvedValue([
      cat('SIM de Caja Vinculado', 2),
      cat('SIM de evento', 1),
      cat('E-SIM de promotor', 1), // → e-SIM (su propia fila)
      cat('$40 de caja', 1), // → Otros SIMs
    ])
    const rows = await getSalesBySimTypeWeekly(ORG_ID, {})
    expect(rows.map(r => r.name)).toEqual(['$100 de Promotor', 'SIM de Evento', 'e-SIM', 'SIM de Caja Vinculado', 'Otros SIMs'])
    expect(rows[0]).toMatchObject({ name: '$100 de Promotor', total: 0, byWeek: {} }) // fija, en cero, presente igual
    expect(rows[1]).toMatchObject({ name: 'SIM de Evento', total: 1 })
    expect(rows[2]).toMatchObject({ name: 'e-SIM', total: 1 })
    expect(rows[3]).toMatchObject({ name: 'SIM de Caja Vinculado', total: 2, byWeek: { '2026-W11': 2 } })
    expect(rows[4]).toMatchObject({ name: 'Otros SIMs', total: 1 })
  })

  it('omits "Otros SIMs" when every sale is a fixed category', async () => {
    mockedQueryRaw.mockResolvedValue([cat('$100 de Promotor', 1)])
    const rows = await getSalesBySimTypeWeekly(ORG_ID, {})
    expect(rows.map(r => r.name)).toEqual(['$100 de Promotor', 'SIM de Evento', 'e-SIM', 'SIM de Caja Vinculado'])
  })

  it('una venta de "SIM de Intercambio" ya NO abre fila propia: cae en Otros SIMs', async () => {
    // La fila se eliminó por pedido de Isaac (Asana, 2026-08-18). La categoría no existe
    // en prod (0 ventas), pero si alguien la crea, el total sigue cuadrando vía Otros SIMs.
    mockedQueryRaw.mockResolvedValue([cat('SIM de Intercambio', 3)])
    const rows = await getSalesBySimTypeWeekly(ORG_ID, {})
    expect(rows.map(r => r.name)).not.toContain('SIM de Intercambio')
    expect(rows.find(r => r.name === 'Otros SIMs')).toMatchObject({ total: 3 })
  })

  it('treats a sale with no serialized item as Otros SIMs', async () => {
    // Sin serializado, el LEFT JOIN deja `category_name` en NULL.
    mockedQueryRaw.mockResolvedValue([cat(null, 1)])
    const rows = await getSalesBySimTypeWeekly(ORG_ID, {})
    expect(rows.find(r => r.name === 'Otros SIMs')).toMatchObject({ total: 1 })
  })

  it('suma varias categorías crudas que caen en el mismo bucket', async () => {
    // "eSIM" y "E-SIM de promotor" son categorías distintas en la base pero el mismo bucket.
    mockedQueryRaw.mockResolvedValue([cat('E-SIM de promotor', 2), cat('eSIM', 3)])
    const rows = await getSalesBySimTypeWeekly(ORG_ID, {})
    expect(rows.find(r => r.name === 'e-SIM')).toMatchObject({ total: 5, byWeek: { '2026-W11': 5 } })
  })
})

describe('tipo de SIM — la categoría se elige de forma DETERMINISTA', () => {
  /**
   * 🔴 El código anterior hacía `order.items.find(oi => oi.serializedItem)` sobre una
   * relación SIN `orderBy`: una orden con dos serializados de categorías distintas podía
   * cambiar de bucket entre corridas. Mismo defecto de familia que la pérdida silenciosa
   * de filas en listas paginadas. `DISTINCT ON` con `ORDER BY` explícito lo fija.
   */
  it('usa DISTINCT ON con desempate explícito, no el orden que devuelva Postgres', async () => {
    mockedQueryRaw.mockResolvedValue([])
    await getSalesBySimTypeWeekly(ORG_ID, {})
    const sql = sqlDeLlamada().replace(/\s+/g, ' ')
    expect(sql).toContain('DISTINCT ON (sv."id")')
    // 1º los items CON serializado, 2º desempate estable por id del item.
    expect(sql).toContain('ORDER BY sv."id", (si."id" IS NULL), oi."id"')
  })

  it('resuelve la categoría por el camino completo pago → orden → item → serializado', async () => {
    mockedQueryRaw.mockResolvedValue([])
    await getSalesBySimType(ORG_ID, {})
    const sql = sqlDeLlamada().replace(/\s+/g, ' ')
    expect(sql).toContain(`LEFT JOIN "Order" o ON o."id" = p."orderId"`)
    expect(sql).toContain(`LEFT JOIN "OrderItem" oi ON oi."orderId" = o."id"`)
    expect(sql).toContain(`LEFT JOIN "SerializedItem" si ON si."orderItemId" = oi."id"`)
    expect(sql).toContain(`LEFT JOIN "ItemCategory" ic ON ic."id" = si."categoryId"`)
  })
})

/**
 * 🔴 REGLA DE NEGOCIO EXPLÍCITA (Isaac, 2026-06-29): *"el total debe cuadrar en todas las
 * tablas y gráficas"*. Los reportes semanales alimentan el cobro a Walmart; si dos tablas
 * de la misma pantalla cuentan conjuntos distintos de ventas, alguien cobra de menos.
 *
 * Antes esa garantía se probaba alimentando UN dataset a las tres funciones: como todas
 * llamaban al mismo `baseAggregationWhere`, contaban lo mismo por construcción.
 *
 * Desde que agrupan en SQL (2026-08-04), la garantía vive en otro lado: todas arman su
 * consulta a partir del MISMO `completedSalesFromWhere`. Por eso el test cambia de forma
 * — ya no compara totales sobre un dataset compartido, sino que exige que las consultas
 * lleven el mismo filtro base. Es una comprobación más fuerte: detecta la divergencia en
 * el momento en que alguien escribe su propio WHERE, sin depender de que el dataset de
 * prueba tuviera el caso que la destapa.
 */
describe('todas las agregaciones cuentan el MISMO conjunto de ventas', () => {
  const FILTRO_BASE = [
    `FROM "SaleVerification" sv`,
    `JOIN "Venue" v ON v."id" = sv."venueId"`,
    `sv."status" = 'COMPLETED'`,
    `v."organizationId"`,
  ]

  it.each([
    ['getSalesByMonth', () => getSalesByMonth(ORG_ID, {})],
    ['getSalesByWeek', () => getSalesByWeek(ORG_ID, {})],
    ['getSalesBySaleTypeWeekly', () => getSalesBySaleTypeWeekly(ORG_ID, {})],
  ])('%s usa el filtro base compartido', async (_nombre, fn) => {
    mockedQueryRaw.mockResolvedValue([])
    await fn()
    const sql = sqlDeLlamada().replace(/\s+/g, ' ')
    for (const fragmento of FILTRO_BASE) {
      expect(sql).toContain(fragmento.replace(/\s+/g, ' '))
    }
  })

  it('los totales cuadran entre la barra semanal y la tabla por tipo de venta', async () => {
    // Mismo conjunto de ventas, agrupado de dos maneras: 3 en W11 y 1 en W12.
    mockedQueryRaw.mockResolvedValueOnce([
      { bucket: 'W11', count: BigInt(3), revenue: '300.00' },
      { bucket: 'W12', count: BigInt(1), revenue: '100.00' },
    ])
    const byWeek = await getSalesByWeek(ORG_ID, {})

    mockedQueryRaw.mockResolvedValueOnce([
      { bucket: '2026-W11', is_portabilidad: false, count: BigInt(2) },
      { bucket: '2026-W11', is_portabilidad: true, count: BigInt(1) },
      { bucket: '2026-W12', is_portabilidad: true, count: BigInt(1) },
    ])
    const sale = await getSalesBySaleTypeWeekly(ORG_ID, {})

    const grand = byWeek.reduce((a, r) => a + r.count, 0)
    expect(sale.reduce((a, r) => a + r.total, 0)).toBe(grand)
    expect(grand).toBe(4)
  })
})

describe('getSalesBySimType — regrouped into SIM buckets', () => {
  it('collapses raw categories into the fixed buckets (incl. e-SIM) + Otros SIMs', async () => {
    mockedQueryRaw.mockResolvedValue([
      { bucket: '2026-03', category_name: 'SIM de Caja Vinculado', count: BigInt(1) },
      { bucket: '2026-03', category_name: 'E-SIM de promotor', count: BigInt(1) },
      { bucket: '2026-03', category_name: '$40 de caja', count: BigInt(1) }, // sigue en Otros SIMs
    ])
    const rows = await getSalesBySimType(ORG_ID, {})
    expect(rows).toHaveLength(1)
    expect(rows[0].byCategory).toEqual({ 'SIM de Caja Vinculado': 1, 'e-SIM': 1, 'Otros SIMs': 1 })
    expect(rows[0].total).toBe(3)
  })

  it('ordena los meses del más reciente al más viejo', async () => {
    mockedQueryRaw.mockResolvedValue([
      { bucket: '2026-03', category_name: 'SIM de Evento', count: BigInt(1) },
      { bucket: '2026-08', category_name: 'SIM de Evento', count: BigInt(5) },
      { bucket: '2026-05', category_name: 'SIM de Evento', count: BigInt(2) },
    ])
    const rows = await getSalesBySimType(ORG_ID, {})
    expect(rows.map(r => r.month)).toEqual(['2026-08', '2026-05', '2026-03'])
  })

  it('queries the COMPLETED SaleVerification base (same as weekly bar)', async () => {
    mockedQueryRaw.mockResolvedValue([])
    await getSalesBySimType(ORG_ID, {})
    const sql = sqlDeLlamada().replace(/\s+/g, ' ')
    expect(sql).toContain(`sv."status" = 'COMPLETED'`)
    expect(sql).toContain(`v."organizationId"`)
    expect(mockedQueryRaw.mock.calls[0][0].values).toContain(ORG_ID)
    expect(mockedSvFindMany).not.toHaveBeenCalled()
  })
})

describe('parseRange — rejects malformed dates without breaking the venue-tz conversion', () => {
  it('ignores a non-date string instead of yielding an Invalid Date (was a Prisma 500)', () => {
    expect(parseRange('notadate', undefined)).toEqual({})
    expect(parseRange(undefined, 'garbage')).toEqual({})
    expect(parseRange('\'; DROP TABLE "Payment"--', undefined)).toEqual({})
  })

  it('ignores well-shaped but impossible dates (2026-13-99, 0000-00-00)', () => {
    expect(parseRange('2026-13-99', '0000-00-00')).toEqual({})
  })

  it('preserves the EXACT venue-timezone → UTC conversion for valid dates (DB stores UTC)', () => {
    const r = parseRange('2026-05-01', '2026-05-31')
    // Identical formula to the original implementation — proves the tz conversion is untouched.
    expect(r.fromDate).toEqual(fromZonedTime(new Date('2026-05-01T00:00:00'), 'America/Mexico_City'))
    expect(r.toDate).toEqual(fromZonedTime(new Date('2026-05-31T23:59:59.999'), 'America/Mexico_City'))
    expect(Number.isNaN(r.fromDate!.getTime())).toBe(false)
  })

  it('applies only the valid bound when the other is malformed', () => {
    const r = parseRange('notadate', '2026-05-31')
    expect(r.fromDate).toBeUndefined()
    expect(r.toDate).toEqual(fromZonedTime(new Date('2026-05-31T23:59:59.999'), 'America/Mexico_City'))
  })
})
