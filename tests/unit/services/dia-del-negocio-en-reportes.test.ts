/**
 * D19 (16-nov-2026) — los reportes que arman «hoy», «esta semana» o «este mes» cuentan el día del NEGOCIO, no el del
 * proceso. Misma familia que D17 (el correo nocturno de ventas).
 *
 * Producción (Render) corre en UTC. `setHours(0, 0, 0, 0)`, `setDate(1)` o `new Date(año, mes, 1)` arman la medianoche del
 * PROCESO: para un negocio de CDMX «hoy» empezaba a las 18:00 del día anterior (y a las 18:00 se reiniciaba), y «este mes»
 * empezaba a las 18:00 del último día del mes anterior. Cada prueba fija el reloj a una hora de la noche en México, cuando
 * el día de UTC ya cambió y el del negocio no.
 *
 * Debe dar lo mismo con el proceso en cualquier zona, también en una cuya medianoche no existe el día del cambio de horario
 * (America/Havana el 8-mar-2026, Codex r1). La zona se fija ANTES de que arranque Jest, así que se corre en varias:
 *
 *   TZ=UTC npx jest --selectProjects=unit --runTestsByPath tests/unit/services/dia-del-negocio-en-reportes.test.ts
 *   TZ=America/Mexico_City …   TZ=America/Tijuana …   TZ=America/Havana …
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { weeklyNewCustomersReportJob } from '@/jobs/weekly-new-customers-report.job'
import { promotersService } from '@/services/promoters/promoters.service'
import { getReferralSummary } from '@/services/referrals/referralReads.service'
import { getCustomerStats } from '@/services/dashboard/customer.dashboard.service'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'
import { commandCenterService } from '@/services/command-center/commandCenter.service'
import tpvRouter from '@/routes/tpv.routes'

const CDMX = 'America/Mexico_City'
const TIJUANA = 'America/Tijuana'
const CANCUN = 'America/Cancun'

/** Sólo el reloj de pared (`Date`): timers y promesas siguen siendo reales, como en D17. */
function fijarReloj(now: string) {
  jest.useFakeTimers({
    now: new Date(now),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  })
}

const zonaDelNegocio = (timezone: string) => prismaMock.venue.findUnique.mockResolvedValue({ timezone })
/** Mueve el reloj a `momento` cuando el servicio hace esa consulta: la petición cruza la medianoche a media llamada (Codex r2). */
const cruzarMedianocheAlConsultar = (consulta: jest.Mock, momento: string, respuesta: unknown) =>
  consulta.mockImplementation(async () => {
    jest.setSystemTime(new Date(momento))
    return respuesta
  })
const iso = (d: Date) => d.toISOString()

beforeEach(() => {
  jest.clearAllMocks()
})
afterEach(() => {
  jest.useRealTimers()
})

describe('correo semanal de clientes nuevos (weekly-new-customers-report)', () => {
  it('la semana va del lunes 00:00 al domingo 23:59:59.999 de CDMX', async () => {
    prismaMock.venue.findMany.mockResolvedValue([])
    // Lunes 16-nov 08:07 de CDMX, la hora del cron.
    const r = await weeklyNewCustomersReportJob.runNow({ previewOnly: true, at: new Date('2026-11-16T14:07:00Z') })

    const { gte, lte } = prismaMock.venue.findMany.mock.calls[0][0].where.onboardingCompletedAt
    expect(iso(gte)).toBe('2026-11-09T06:00:00.000Z') // lunes 9, 00:00 CDMX
    expect(iso(lte)).toBe('2026-11-16T05:59:59.999Z') // domingo 15, 23:59:59.999 CDMX
    expect([iso(r.weekStart), iso(r.weekEnd)]).toEqual([iso(gte), iso(lte)])
  })

  it('si el reloj cruza al lunes a media llamada, la semana sigue siendo la del momento de la consulta', async () => {
    fijarReloj('2026-11-16T05:59:59.000Z') // domingo 15-nov, 23:59:59 CDMX
    cruzarMedianocheAlConsultar(prismaMock.venue.findMany, '2026-11-16T06:00:01.000Z', [])
    const r = await weeklyNewCustomersReportJob.runNow({ previewOnly: true })
    expect([iso(r.weekStart), iso(r.weekEnd)]).toEqual(['2026-11-02T06:00:00.000Z', '2026-11-09T05:59:59.999Z'])
  })

  it('consultado el domingo 8-mar (en Havana esa medianoche no existe): semana del 23-feb al 1-mar', async () => {
    prismaMock.venue.findMany.mockResolvedValue([])
    const r = await weeklyNewCustomersReportJob.runNow({ previewOnly: true, at: new Date('2026-03-08T18:00:00Z') })
    expect([iso(r.weekStart), iso(r.weekEnd)]).toEqual(['2026-02-23T06:00:00.000Z', '2026-03-02T05:59:59.999Z'])
  })
})

describe('promotores (PlayTelecom): «hoy» del negocio', () => {
  const NOCHE = '2026-11-16T03:00:00Z' // domingo 15-nov: 21:00 CDMX, 19:00 Tijuana, 22:00 Cancún

  it.each([
    [CDMX, '2026-11-15T06:00:00.000Z'],
    [TIJUANA, '2026-11-15T08:00:00.000Z'],
    [CANCUN, '2026-11-15T05:00:00.000Z'],
  ])('lista: checadas y ventas de hoy desde la medianoche de %s', async (zona, medianoche) => {
    fijarReloj(NOCHE)
    zonaDelNegocio(zona)
    prismaMock.staffVenue.findMany.mockResolvedValue([])
    prismaMock.timeEntry.findMany.mockResolvedValue([])
    prismaMock.order.findMany.mockResolvedValue([])

    await promotersService.getPromotersList('v1')

    expect(iso(prismaMock.timeEntry.findMany.mock.calls[0][0].where.clockInTime.gte)).toBe(medianoche)
    expect(iso(prismaMock.order.findMany.mock.calls[0][0].where.AND[1].OR[0].clientCreatedAt.gte)).toBe(medianoche)
  })

  it('lista: el día del cambio de horario del proceso no mueve la medianoche del negocio (8-mar, Havana)', async () => {
    fijarReloj('2026-03-08T12:00:00Z') // 06:00 CDMX
    zonaDelNegocio(CDMX)
    prismaMock.staffVenue.findMany.mockResolvedValue([])
    prismaMock.timeEntry.findMany.mockResolvedValue([])
    prismaMock.order.findMany.mockResolvedValue([])

    await promotersService.getPromotersList('v1')

    expect(iso(prismaMock.order.findMany.mock.calls[0][0].where.AND[1].OR[0].clientCreatedAt.gte)).toBe('2026-03-08T06:00:00.000Z')
  })

  it('detalle: ventas y checada de hoy, y el calendario de 30 días con días y retardos del negocio', async () => {
    fijarReloj(NOCHE)
    zonaDelNegocio(CDMX)
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      role: 'CASHIER',
      staff: { id: 's1', firstName: 'Ana', lastName: 'P', email: null, phone: null, photoUrl: null, createdAt: new Date() },
    })
    prismaMock.order.findMany.mockResolvedValue([])
    prismaMock.performanceGoal.findUnique.mockResolvedValue(null)
    prismaMock.timeEntry.findFirst.mockResolvedValue(null)
    prismaMock.timeEntry.findMany.mockResolvedValue([
      { clockInTime: new Date('2026-11-13T02:30:00Z') }, // jueves 12, 20:30 CDMX → retardo del 12
      { clockInTime: new Date('2026-11-14T15:00:00Z') }, // sábado 14, 09:00 CDMX → a tiempo
      { clockInTime: new Date('2026-11-15T17:30:00Z') }, // domingo 15, 11:30 CDMX → retardo
    ])

    const d = await promotersService.getPromoterDetail('v1', 's1')

    expect(iso(prismaMock.order.findMany.mock.calls[0][0].where.createdAt.gte)).toBe('2026-11-15T06:00:00.000Z')
    expect(iso(prismaMock.timeEntry.findFirst.mock.calls[0][0].where.clockInTime.gte)).toBe('2026-11-15T06:00:00.000Z')
    expect(iso(prismaMock.timeEntry.findMany.mock.calls[0][0].where.clockInTime.gte)).toBe('2026-10-17T06:00:00.000Z')
    // La llave de la meta del mes: la medianoche del día 1 en el negocio, la misma que lee getManagerDashboard.
    expect(iso(prismaMock.performanceGoal.findUnique.mock.calls[0][0].where.staffId_venueId_month.month)).toBe('2026-11-01T06:00:00.000Z')

    const dias = d!.attendance.days
    expect(dias).toHaveLength(30)
    expect(dias[0].date).toBe('2026-10-17')
    expect(dias[29].date).toBe('2026-11-15') // hoy del negocio, no el 16 de UTC
    const estado = Object.fromEntries(dias.map(x => [x.date, x.status]))
    expect(estado['2026-11-12']).toBe('LATE')
    expect(estado['2026-11-13']).toBe('ABSENT')
    expect(estado['2026-11-14']).toBe('PRESENT')
    expect(estado['2026-11-15']).toBe('LATE')
  })

  it('detalle: si el reloj cruza la medianoche a media petición, el calendario sigue siendo de los 30 días de la consulta (Codex r2)', async () => {
    fijarReloj('2026-11-16T05:59:59.000Z') // domingo 15-nov, 23:59:59 CDMX
    zonaDelNegocio(CDMX)
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      role: 'CASHIER',
      staff: { id: 's1', firstName: 'Ana', lastName: 'P', email: null, phone: null, photoUrl: null, createdAt: new Date() },
    })
    prismaMock.order.findMany.mockResolvedValue([])
    prismaMock.performanceGoal.findUnique.mockResolvedValue(null)
    prismaMock.timeEntry.findFirst.mockResolvedValue(null)
    prismaMock.timeEntry.findMany.mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-11-16T06:00:01.000Z')) // ya es lunes 16 en CDMX
      return []
    })

    const d = await promotersService.getPromoterDetail('v1', 's1')

    const fechas = d!.attendance.days.map(x => x.date)
    expect([fechas[0], fechas[29], new Set(fechas).size]).toEqual(['2026-10-17', '2026-11-15', 30])
  })

  it('gerente de tiendas: el avance estimado del mes usa el día del mes del negocio', async () => {
    fijarReloj(NOCHE)
    prismaMock.staff.findFirst.mockResolvedValue({ id: 'm1', firstName: 'Mara', lastName: 'G', email: null, phone: null })
    prismaMock.staffVenue.findMany.mockResolvedValue([{ venueId: 'v1', venue: { id: 'v1', name: 'Tienda', slug: 'tienda' } }])
    prismaMock.order.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([{ venueId: 'v1', _sum: { total: 7000 } }])
    prismaMock.staffVenue.groupBy.mockResolvedValue([])
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.performanceGoal.findMany.mockResolvedValue([])

    const r = await organizationDashboardService.getManagerDashboard('org1', 'm1', CDMX)

    // $7,000 en 7 días → $1,000 diarios × día 15 = $15,000 de la meta de $50,000 = 30 % (el 16 de UTC daba 32 %).
    expect(r!.stores[0].goalProgress).toBe(30)
    expect(iso(prismaMock.order.groupBy.mock.calls[0][0].where.AND[1].OR[0].clientCreatedAt.gte)).toBe('2026-11-15T06:00:00.000Z') // hoy
    expect(iso(prismaMock.order.groupBy.mock.calls[1][0].where.AND[1].OR[0].clientCreatedAt.gte)).toBe('2026-11-08T06:00:00.000Z') // 7 días
  })

  it('gerente de tiendas: si el reloj cruza la medianoche a media llamada, el día del mes es el de la consulta', async () => {
    fijarReloj('2026-11-16T05:59:59.000Z') // domingo 15-nov, 23:59:59 CDMX
    cruzarMedianocheAlConsultar(prismaMock.staff.findFirst, '2026-11-16T06:00:01.000Z', {
      id: 'm1',
      firstName: 'Mara',
      lastName: 'G',
      email: null,
      phone: null,
    })
    prismaMock.staffVenue.findMany.mockResolvedValue([{ venueId: 'v1', venue: { id: 'v1', name: 'Tienda', slug: 'tienda' } }])
    prismaMock.order.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([{ venueId: 'v1', _sum: { total: 7000 } }])
    prismaMock.staffVenue.groupBy.mockResolvedValue([])
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.performanceGoal.findMany.mockResolvedValue([])

    const r = await organizationDashboardService.getManagerDashboard('org1', 'm1', CDMX)

    expect(r!.stores[0].goalProgress).toBe(30) // día 15, no 16
    expect(iso(prismaMock.order.groupBy.mock.calls[0][0].where.AND[1].OR[0].clientCreatedAt.gte)).toBe('2026-11-15T06:00:00.000Z')
  })
})

describe('centro de mando (PlayTelecom): tendencia de ventas con días elegidos en el DASHBOARD', () => {
  it('«AAAA-MM-DD» es el día del negocio, y el periodo anterior es el día de antes', async () => {
    zonaDelNegocio(CDMX)
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.order.aggregate.mockResolvedValue({ _sum: { total: null }, _count: 0 })
    prismaMock.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: null } })

    const r = await commandCenterService.getStockVsSales('v1', { startDate: '2026-11-15', endDate: '2026-11-15' })

    // Antes: `new Date('2026-11-15')` es la medianoche UTC (14-nov 18:00 CDMX) y la gráfica mostraba el 14.
    const anterior = prismaMock.order.aggregate.mock.calls[0][0].where.AND[1].OR[0].clientCreatedAt
    expect([iso(anterior.gte), iso(anterior.lte)]).toEqual(['2026-11-14T06:00:00.000Z', '2026-11-15T05:59:59.999Z'])
    expect(r.trend).toHaveLength(1)
    expect(r.trend[0].date).toBe(new Date('2026-11-15T18:00:00Z').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }))
  })

  function sinVentas() {
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.order.aggregate.mockResolvedValue({ _sum: { total: null }, _count: 0 })
    prismaMock.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: null } })
  }
  const periodoAnterior = () => {
    const w = prismaMock.order.aggregate.mock.calls[0][0].where.AND[1].OR[0].clientCreatedAt
    return [iso(w.gte), iso(w.lte)]
  }

  it('el periodo anterior empieza en la medianoche del negocio aunque la del proceso no exista (Havana, 8-mar; Codex r2 #2)', async () => {
    zonaDelNegocio(CDMX)
    sinVentas()
    await commandCenterService.getStockVsSales('v1', { startDate: '2026-03-09', endDate: '2026-03-09' })
    expect(periodoAnterior()).toEqual(['2026-03-08T06:00:00.000Z', '2026-03-09T05:59:59.999Z'])
  })

  it('el día de 25 h de Tijuana sigue siendo UN día: se compara sólo contra el anterior (Codex r1 #4)', async () => {
    fijarReloj('2026-11-01T20:00:00Z') // 1-nov, 12:00 en Tijuana (ese día dura 25 h)
    zonaDelNegocio(TIJUANA)
    sinVentas()
    const r = await commandCenterService.getStockVsSales('v1', { days: 1 })
    expect(r.trend).toHaveLength(1)
    expect(periodoAnterior()).toEqual(['2026-10-31T07:00:00.000Z', '2026-11-01T06:59:59.999Z'])
  })

  it('si el reloj cruza la medianoche a media llamada, los 7 días y su comparación son los del momento de la consulta', async () => {
    zonaDelNegocio(CDMX)
    sinVentas()
    // Codex r3 #2: el reloj cruza la medianoche JUSTO DESPUÉS de la primera lectura. Mover el reloj dentro de una consulta llega
    // tarde (los bordes ya están calculados) y no atrapa una segunda lectura; aquí cualquier segunda lectura ya es el lunes 16.
    const RealDate = Date
    let lecturas = 0
    const lectura = () => (lecturas++ === 0 ? '2026-11-16T05:59:59.999Z' : '2026-11-16T06:00:00.001Z') // 15-nov 23:59:59.999 CDMX, luego el 16
    class RelojQueCruza extends RealDate {
      constructor(...args: any[]) {
        if (args.length === 0) super(lectura())
        else super(...(args as [any]))
      }
      static now() {
        return new RealDate(lectura()).getTime()
      }
    }
    global.Date = RelojQueCruza as unknown as DateConstructor
    let r
    try {
      r = await commandCenterService.getStockVsSales('v1', { days: 7 })
    } finally {
      global.Date = RealDate
    }
    expect(lecturas).toBe(1) // una sola lectura del reloj por petición
    expect(r.trend).toHaveLength(7)
    expect(r.trend[6].date).toBe(new Date('2026-11-15T18:00:00Z').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }))
    expect(periodoAnterior()).toEqual(['2026-11-02T06:00:00.000Z', '2026-11-09T05:59:59.999Z'])
  })

  it('una zona inválida guardada en el negocio cae a CDMX en vez de tronar (Codex r2 #3)', async () => {
    zonaDelNegocio('No/Existe')
    sinVentas()
    await commandCenterService.getStockVsSales('v1', { startDate: '2026-11-15', endDate: '2026-11-15' })
    expect(periodoAnterior()).toEqual(['2026-11-14T06:00:00.000Z', '2026-11-15T05:59:59.999Z'])
  })
})

describe('referidos: «este mes» y «el mes anterior» del negocio', () => {
  it.each([
    [CDMX, '2026-10-01T06:00:00.000Z', '2026-09-01T06:00:00.000Z'],
    [TIJUANA, '2026-10-01T07:00:00.000Z', '2026-09-01T07:00:00.000Z'],
  ])('%s', async (zona, mes, mesAnterior) => {
    fijarReloj('2026-11-01T03:00:00Z') // sábado 31-oct, 21:00 CDMX: en UTC ya es noviembre
    zonaDelNegocio(zona)
    prismaMock.referral.count.mockResolvedValue(0)
    prismaMock.discount.count.mockResolvedValue(0)
    prismaMock.customer.findFirst.mockResolvedValue(null)

    await getReferralSummary('v1')

    const [esteMes, anterior, calificados, pendientes] = prismaMock.referral.count.mock.calls.map((c: any[]) => c[0].where)
    expect(iso(esteMes.createdAt.gte)).toBe(mes)
    expect([iso(anterior.createdAt.gte), iso(anterior.createdAt.lt)]).toEqual([mesAnterior, mes])
    expect(iso(calificados.qualifiedAt.gte)).toBe(mes)
    expect(iso(pendientes.createdAt.gte)).toBe(mes)
    expect(iso(prismaMock.discount.count.mock.calls[0][0].where.createdAt.gte)).toBe(mes)
  })
})

describe('referidos: el reloj cruza al mes siguiente a media llamada', () => {
  it('«este mes» y «el mes anterior» salen de una sola lectura del reloj', async () => {
    fijarReloj('2026-11-01T05:59:59.000Z') // 31-oct, 23:59:59 CDMX
    zonaDelNegocio(CDMX)
    cruzarMedianocheAlConsultar(prismaMock.referral.count, '2026-11-01T06:00:01.000Z', 0)
    prismaMock.discount.count.mockResolvedValue(0)
    prismaMock.customer.findFirst.mockResolvedValue(null)

    await getReferralSummary('v1')

    const [esteMes, anterior] = prismaMock.referral.count.mock.calls.map((c: any[]) => c[0].where)
    expect([iso(esteMes.createdAt.gte), iso(anterior.createdAt.gte), iso(anterior.createdAt.lt)]).toEqual([
      '2026-10-01T06:00:00.000Z',
      '2026-09-01T06:00:00.000Z',
      '2026-10-01T06:00:00.000Z',
    ])
    expect(iso(prismaMock.discount.count.mock.calls[0][0].where.createdAt.gte)).toBe('2026-10-01T06:00:00.000Z')
  })
})

describe('clientes: «nuevos este mes» del negocio', () => {
  it.each([
    [CDMX, '2026-10-01T06:00:00.000Z'],
    [CANCUN, '2026-10-01T05:00:00.000Z'],
  ])('%s', async (zona, mes) => {
    fijarReloj('2026-11-01T03:00:00Z') // sábado 31-oct en la noche en México
    zonaDelNegocio(zona)
    prismaMock.$transaction.mockResolvedValueOnce([0, 0, 0, 0, { _avg: { totalSpent: null, totalVisits: null } }, []])

    await getCustomerStats('v1')

    const nuevos = prismaMock.customer.count.mock.calls.map((c: any[]) => c[0].where).find((w: any) => w.createdAt)
    expect(iso(nuevos.createdAt.gte)).toBe(mes)
  })
})

describe('TPV: «Mis ventas» del mes (PlayTelecom)', () => {
  function handlerDeMisVentas() {
    for (const layer of (tpvRouter as any).stack) {
      if (layer.route?.path === '/serialized-inventory/my-sales' && layer.route.methods.get) {
        return layer.route.stack[layer.route.stack.length - 1].handle
      }
    }
    throw new Error('no encontré GET /serialized-inventory/my-sales')
  }

  async function pedir(query: Record<string, string>) {
    prismaMock.order.findMany.mockResolvedValue([])
    prismaMock.order.count.mockResolvedValue(0)
    prismaMock.order.aggregate.mockResolvedValue({ _sum: { total: null } })
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()
    await handlerDeMisVentas()({ authContext: { venueId: 'v1', userId: 's1' }, query, correlationId: 'c1' }, res, next)
    expect(next).not.toHaveBeenCalled()
    const { gte, lt } = prismaMock.order.findMany.mock.calls[0][0].where.createdAt
    return { gte: iso(gte), lt: iso(lt), month: res.json.mock.calls[0][0].data.month }
  }

  it('sin mes: el mes en curso del negocio, de su medianoche del día 1 a la del mes siguiente', async () => {
    fijarReloj('2026-11-01T03:00:00Z') // 31-oct, 21:00 CDMX
    zonaDelNegocio(CDMX)
    expect(await pedir({})).toEqual({ gte: '2026-10-01T06:00:00.000Z', lt: '2026-11-01T06:00:00.000Z', month: '2026-10' })
  })

  it('sin mes, si el reloj cruza al mes siguiente a media llamada: el mes y sus bordes salen de una sola lectura', async () => {
    fijarReloj('2026-11-01T05:59:59.000Z') // 31-oct, 23:59:59 CDMX
    zonaDelNegocio(CDMX)
    prismaMock.venue.findUnique.mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-11-01T06:00:01.000Z'))
      return { timezone: CDMX }
    })
    expect(await pedir({})).toEqual({ gte: '2026-11-01T06:00:00.000Z', lt: '2026-12-01T06:00:00.000Z', month: '2026-11' })
  })

  it('con mes: ese mes en la zona del negocio (Tijuana)', async () => {
    fijarReloj('2026-11-16T03:00:00Z')
    zonaDelNegocio(TIJUANA)
    // Tijuana cambia de horario el 1-nov: el mes empieza a las 07:00Z (PDT) y el siguiente a las 08:00Z (PST).
    expect(await pedir({ month: '2026-11' })).toEqual({ gte: '2026-11-01T07:00:00.000Z', lt: '2026-12-01T08:00:00.000Z', month: '2026-11' })
  })
})
