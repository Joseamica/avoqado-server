/**
 * D17 (16-nov-2026) — el correo nocturno de ventas cuenta el día del NEGOCIO, no el del proceso.
 *
 * El job armaba «hoy» formateando la fecha en la zona del negocio y volviendo a leer «MM/DD/YYYY 00:00:00» con `new Date`,
 * que la lee en la zona del PROCESO. Producción (Render) corre en UTC: para un negocio de CDMX el correo de las 22:02 iba de
 * las 18:00 del día anterior a las 17:59 de hoy y se comía la noche. «Ayer» y «la semana pasada» salían con `setDate`, que
 * también cuenta en la zona del proceso.
 *
 * Decisión del founder (16-nov-2026): el correo sale a las 07:02 de CDMX con el día COMPLETO de ayer, como Square y Toast.
 *
 * Esta suite debe dar lo mismo con el proceso en cualquier zona. La zona se fija ANTES de que arranque Jest (un
 * `process.env.TZ` asignado dentro de una prueba no llega al proceso real), así que se corre dos veces:
 *
 *   TZ=UTC npx jest --selectProjects unit tests/unit/jobs/nightly-sales-dia-del-negocio.test.ts
 *   TZ=America/Mexico_City npx jest --selectProjects unit tests/unit/jobs/nightly-sales-dia-del-negocio.test.ts
 */
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({ getSalesSummary: jest.fn() }))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendSalesSummaryEmail: jest.fn().mockResolvedValue(true) },
}))

import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import emailService from '@/services/email.service'
import { NightlySalesSummaryJob, nightlyReportWindows } from '@/jobs/nightly-sales-summary.job'
import { venueDayKey } from '@/utils/venueDateKeys'
import { prismaMock } from '@tests/__helpers__/setup'

/** La plantilla REAL del correo (el módulo de arriba es el doble que usa el job); sólo se detiene su transporte. */
const plantillaReal = jest.requireActual('@/services/email.service').default

const CDMX = 'America/Mexico_City'
const HORA = 60 * 60 * 1000

const RESUMEN = {
  summary: {
    grossSales: 0,
    items: 0,
    serviceCosts: 0,
    discounts: 0,
    refunds: 0,
    netSales: 0,
    deferredSales: 0,
    taxes: 0,
    tips: 0,
    platformFees: 0,
    staffCommissions: 0,
    commissions: 0,
    totalCollected: 0,
    netProfit: 0,
    transactionCount: 0,
  },
}

const iso = (w: { start: Date; end: Date }) => ({ start: w.start.toISOString(), end: w.end.toISOString() })
/** Lo que dura una ventana: de su primer a su último milisegundo, inclusive. */
const horas = (w: { start: Date; end: Date }) => (w.end.getTime() + 1 - w.start.getTime()) / HORA

/** Sólo el reloj de pared: los `setTimeout` del job (500 ms entre correos) y las promesas siguen siendo reales. */
function fijarReloj(now: Date) {
  jest.useFakeTimers({
    now,
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

/** Todas las fechas que el job metió en sus consultas crudas (categorías, origen, reembolsos y la revisión de descuentos). */
function fechasDeLasConsultasCrudas(): string[] {
  const fechas: string[] = []
  const recorrer = (valor: unknown) => {
    if (valor instanceof Date) fechas.push(valor.toISOString())
    else if (valor && typeof valor === 'object' && Array.isArray((valor as { values?: unknown[] }).values)) {
      for (const v of (valor as { values: unknown[] }).values) recorrer(v)
    }
  }
  for (const llamada of (prismaMock.$queryRaw as jest.Mock).mock.calls) for (const arg of llamada.slice(1)) recorrer(arg)
  return fechas
}

describe('D17 · el correo nocturno pide el día del negocio', () => {
  beforeEach(() => {
    ;(getSalesSummary as jest.Mock).mockReset().mockResolvedValue(RESUMEN)
    ;(emailService.sendSalesSummaryEmail as jest.Mock).mockClear()
    ;(prismaMock.venue.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'venue-cdmx',
        name: 'Cafetería CDMX',
        slug: 'cafeteria-cdmx',
        timezone: CDMX,
        currency: 'MXN',
        email: null,
        staff: [{ role: 'OWNER', staff: { id: 'duena', email: 'duena@example.com', firstName: 'Ana', lastName: 'López' } }],
      },
    ])
    ;(prismaMock.notificationPreference.findMany as jest.Mock).mockResolvedValue([{ staffId: 'duena' }])
    ;(prismaMock.$queryRaw as jest.Mock).mockReset().mockResolvedValue([])
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('🔴 a las 07:02 de CDMX del 17 (13:02Z) pide el 16 completo, el 15 y el 9 — con el proceso en cualquier zona', async () => {
    fijarReloj(new Date('2026-11-17T13:02:00.000Z'))
    const resultado = await new NightlySalesSummaryJob().runNow('venue-cdmx')
    jest.useRealTimers()
    expect(resultado).toMatchObject({ emailsSent: 1, errors: 0 })

    const pedidos = (getSalesSummary as jest.Mock).mock.calls.map(([, f]) => ({ desde: f.startDate, hasta: f.endDate, zona: f.timezone }))
    expect(pedidos).toEqual([
      { desde: '2026-11-16T06:00:00.000Z', hasta: '2026-11-17T05:59:59.999Z', zona: CDMX }, // hoy
      { desde: '2026-11-15T06:00:00.000Z', hasta: '2026-11-16T05:59:59.999Z', zona: CDMX }, // ayer
      { desde: '2026-11-09T06:00:00.000Z', hasta: '2026-11-10T05:59:59.999Z', zona: CDMX }, // el mismo día de la semana pasada
    ])

    // Categorías y origen del pedido (con sus reembolsos y la revisión de descuentos) usan la misma ventana de hoy.
    const fechas = fechasDeLasConsultasCrudas()
    expect(fechas.length).toBeGreaterThan(0)
    expect(new Set(fechas)).toEqual(new Set(['2026-11-16T06:00:00.000Z', '2026-11-17T05:59:59.999Z']))

    // El correo imprime el 16 en la zona del negocio.
    const datos = (emailService.sendSalesSummaryEmail as jest.Mock).mock.calls[0][1]
    expect(datos.venueTimezone).toBe(CDMX)
    expect(venueDayKey(datos.reportDate, CDMX)).toBe('2026-11-16')
  })

  it('un negocio con la zona mal escrita no se queda sin correo: usa la de CDMX', async () => {
    ;(prismaMock.venue.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'venue-cdmx',
        name: 'Cafetería CDMX',
        slug: 'cafeteria-cdmx',
        timezone: 'Marte/Olimpo',
        currency: 'MXN',
        email: null,
        staff: [{ role: 'OWNER', staff: { id: 'duena', email: 'duena@example.com', firstName: 'Ana', lastName: 'López' } }],
      },
    ])
    fijarReloj(new Date('2026-11-17T13:02:00.000Z'))
    const resultado = await new NightlySalesSummaryJob().runNow('venue-cdmx')
    jest.useRealTimers()
    expect(resultado).toMatchObject({ emailsSent: 1, errors: 0 })
    expect((getSalesSummary as jest.Mock).mock.calls[0][1]).toMatchObject({
      startDate: '2026-11-16T06:00:00.000Z',
      endDate: '2026-11-17T05:59:59.999Z',
      timezone: CDMX,
    })
    expect((emailService.sendSalesSummaryEmail as jest.Mock).mock.calls[0][1].venueTimezone).toBe(CDMX)
  })
})

describe('D17 · cuándo sale el correo', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('🔴 sale a las 07:02 de CDMX: después de la corrida de las 22:02 del 16, la siguiente es la mañana del 17', () => {
    fijarReloj(new Date('2026-11-17T04:02:30.000Z')) // 16-nov 22:02:30 CDMX
    expect(new NightlySalesSummaryJob().getNextRun()?.toISOString()).toBe('2026-11-17T13:02:00.000Z') // 17-nov 07:02 CDMX
  })
})

describe('D17 · el correo dice qué día cubre y contra qué compara', () => {
  const transporte = jest.spyOn(plantillaReal, 'sendEmail').mockResolvedValue(true)
  afterAll(() => transporte.mockRestore())

  it('🔴 el asunto y el título llevan el día reportado (el 16), y las comparaciones dicen contra qué día', async () => {
    transporte.mockClear()
    const { reportDate } = nightlyReportWindows(new Date('2026-11-17T13:02:00.000Z'), CDMX, 'yesterday')
    await plantillaReal.sendSalesSummaryEmail('duena@example.com', {
      venueId: 'venue-cdmx',
      venueName: 'Cafetería CDMX',
      venueTimezone: CDMX,
      venueCurrency: 'MXN',
      reportDate,
      businessHoursStart: '',
      businessHoursEnd: '',
      dashboardUrl: 'https://dashboard.avoqado.io/venues/cafeteria-cdmx',
      metrics: { ...RESUMEN.summary, netSales: 120, transactionCount: 2 },
      lastWeekMetrics: { ...RESUMEN.summary, netSales: 100, transactionCount: 2 },
      categoryBreakdown: [],
      orderSources: [],
    })
    const { subject, html } = transporte.mock.calls[0][0] as { subject: string; html: string }
    // La fecha con el MISMO formato que ya usa el correo, de un instante que sin duda es el 16 en CDMX (no depende del ICU).
    const el16 = new Date('2026-11-16T18:00:00.000Z').toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      timeZone: CDMX,
    })
    const el16Mayuscula = el16.charAt(0).toUpperCase() + el16.slice(1)
    expect(el16).toMatch(/lunes.*16/i)
    expect(subject).toBe(`${el16Mayuscula} - Resumen de ventas - Cafetería CDMX`)
    expect(html).toContain(`>${el16Mayuscula}, Cafetería CDMX</h1>`)
    expect(html).toContain('+20.0% vs el mismo día de la semana pasada')
    expect(html).toContain('>vs el mismo día de la semana pasada</td>')
    expect(html).not.toMatch(/semanal/i)
  })
})

describe('D17 · nightlyReportWindows', () => {
  it("CDMX, 'today' a las 22:02 del 16: el 16 de 00:00 a 23:59:59.999, ayer el 15 y la semana pasada el 9", () => {
    const v = nightlyReportWindows(new Date('2026-11-17T04:02:00.000Z'), CDMX, 'today')
    expect(iso(v.reportDay)).toEqual({ start: '2026-11-16T06:00:00.000Z', end: '2026-11-17T05:59:59.999Z' })
    expect(iso(v.previousDay)).toEqual({ start: '2026-11-15T06:00:00.000Z', end: '2026-11-16T05:59:59.999Z' })
    expect(iso(v.sameDayLastWeek)).toEqual({ start: '2026-11-09T06:00:00.000Z', end: '2026-11-10T05:59:59.999Z' })
    expect(venueDayKey(v.reportDate, CDMX)).toBe('2026-11-16')
  })

  it("CDMX, 'yesterday' a las 06:00 del 17: el 16 completo", () => {
    const v = nightlyReportWindows(new Date('2026-11-17T12:00:00.000Z'), CDMX, 'yesterday')
    expect(iso(v.reportDay)).toEqual({ start: '2026-11-16T06:00:00.000Z', end: '2026-11-17T05:59:59.999Z' })
    expect(iso(v.previousDay)).toEqual({ start: '2026-11-15T06:00:00.000Z', end: '2026-11-16T05:59:59.999Z' })
    expect(iso(v.sameDayLastWeek)).toEqual({ start: '2026-11-09T06:00:00.000Z', end: '2026-11-10T05:59:59.999Z' })
    expect(venueDayKey(v.reportDate, CDMX)).toBe('2026-11-16')
  })

  it("'yesterday' el 1 de enero reporta el 31 de diciembre del año anterior", () => {
    const v = nightlyReportWindows(new Date('2027-01-01T12:00:00.000Z'), CDMX, 'yesterday')
    expect(iso(v.reportDay)).toEqual({ start: '2026-12-31T06:00:00.000Z', end: '2027-01-01T05:59:59.999Z' })
    expect(iso(v.previousDay)).toEqual({ start: '2026-12-30T06:00:00.000Z', end: '2026-12-31T05:59:59.999Z' })
    expect(iso(v.sameDayLastWeek)).toEqual({ start: '2026-12-24T06:00:00.000Z', end: '2026-12-25T05:59:59.999Z' })
  })

  it('Cancún (UTC-5 todo el año): su 16 va de 05:00Z a 04:59:59.999Z, y su 1-nov dura 24 h', () => {
    const v = nightlyReportWindows(new Date('2026-11-17T03:02:00.000Z'), 'America/Cancun', 'today')
    expect(iso(v.reportDay)).toEqual({ start: '2026-11-16T05:00:00.000Z', end: '2026-11-17T04:59:59.999Z' })
    expect(iso(v.sameDayLastWeek)).toEqual({ start: '2026-11-09T05:00:00.000Z', end: '2026-11-10T04:59:59.999Z' })

    const unoDeNoviembre = nightlyReportWindows(new Date('2026-11-02T03:00:00.000Z'), 'America/Cancun', 'today')
    expect(iso(unoDeNoviembre.reportDay)).toEqual({ start: '2026-11-01T05:00:00.000Z', end: '2026-11-02T04:59:59.999Z' })
    expect(horas(unoDeNoviembre.reportDay)).toBe(24)
  })

  it('Tijuana: el 1-nov-2026 (se atrasa la hora) dura 25 h', () => {
    const v = nightlyReportWindows(new Date('2026-11-02T06:00:00.000Z'), 'America/Tijuana', 'today') // 1-nov 22:00 PST
    expect(iso(v.reportDay)).toEqual({ start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T07:59:59.999Z' })
    expect(horas(v.reportDay)).toBe(25)
    expect(iso(v.previousDay)).toEqual({ start: '2026-10-31T07:00:00.000Z', end: '2026-11-01T06:59:59.999Z' })
  })

  it('Tijuana: el 8-mar-2026 (se adelanta la hora) dura 23 h', () => {
    const v = nightlyReportWindows(new Date('2026-03-09T05:00:00.000Z'), 'America/Tijuana', 'today') // 8-mar 22:00 PDT
    expect(iso(v.reportDay)).toEqual({ start: '2026-03-08T08:00:00.000Z', end: '2026-03-09T06:59:59.999Z' })
    expect(horas(v.reportDay)).toBe(23)
  })

  it('Tijuana: «la semana pasada» cruzando el cambio de horario cae en SU medianoche, no 7 × 24 h antes', () => {
    const noviembre = nightlyReportWindows(new Date('2026-11-09T06:00:00.000Z'), 'America/Tijuana', 'today') // 8-nov 22:00 PST
    expect(iso(noviembre.reportDay)).toEqual({ start: '2026-11-08T08:00:00.000Z', end: '2026-11-09T07:59:59.999Z' })
    expect(iso(noviembre.sameDayLastWeek)).toEqual({ start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T07:59:59.999Z' })

    const marzo = nightlyReportWindows(new Date('2026-03-16T05:00:00.000Z'), 'America/Tijuana', 'today') // 15-mar 22:00 PDT
    expect(iso(marzo.reportDay)).toEqual({ start: '2026-03-15T07:00:00.000Z', end: '2026-03-16T06:59:59.999Z' })
    expect(iso(marzo.sameDayLastWeek)).toEqual({ start: '2026-03-08T08:00:00.000Z', end: '2026-03-09T06:59:59.999Z' })

    // 'yesterday' en la mañana del 2-nov: reporta el 1-nov de 25 h y compara con el 31-oct, todavía en horario de verano.
    const manana = nightlyReportWindows(new Date('2026-11-02T14:00:00.000Z'), 'America/Tijuana', 'yesterday')
    expect(horas(manana.reportDay)).toBe(25)
    expect(iso(manana.previousDay)).toEqual({ start: '2026-10-31T07:00:00.000Z', end: '2026-11-01T06:59:59.999Z' })
    expect(venueDayKey(manana.reportDate, 'America/Tijuana')).toBe('2026-11-01')
  })

  it.each([null, undefined, '', 'Marte/Olimpo'])('un negocio sin zona válida (%p) usa la de CDMX', zona => {
    const now = new Date('2026-11-17T04:02:00.000Z')
    expect(nightlyReportWindows(now, zona, 'today')).toEqual(nightlyReportWindows(now, CDMX, 'today'))
  })
})
