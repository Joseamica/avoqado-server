import { prismaMock } from '@tests/__helpers__/setup'
import {
  construirReporte,
  contarCandidatos,
  ReporteDemasiadoGrandeError,
  TOPE_CSV,
} from '@/services/dashboard/settlementReport/settlementReport.service'
import { calculateSettlementDate } from '@/services/payments/settlementCalculation.service'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { subDays } from 'date-fns'
import { toZonedTime } from 'date-fns-tz'

const TZ = 'America/Mexico_City'
const regla = (o = {}) => ({
  merchantAccountId: 'm1',
  cardType: 'DEBIT',
  settlementDays: 1,
  settlementDayType: 'BUSINESS_DAYS',
  cutoffTime: '23:00',
  cutoffTimezone: TZ,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
  ...o,
})
const cobro = (o: Record<string, unknown> = {}) => ({
  id: 'p1',
  amount: 60,
  tipAmount: 0,
  createdAt: new Date('2026-08-31T18:38:00Z'),
  merchantAccountId: 'm1',
  referenceNumber: '102298819725',
  authorizationNumber: '079820',
  maskedPan: '411111******1073',
  cardBrand: 'VISA',
  terminalId: 't1',
  terminal: { serialNumber: 'AVQD-PP35272416000125' },
  type: 'REGULAR',
  method: 'DEBIT_CARD',
  fundsFlow: 'AVOQADO_PROCESSED',
  tenderTypeId: null,
  tenderCountsAsCash: null,
  processorData: {
    pricing: {
      merchantAccountId: 'm1',
      slot: 'PRIMARY',
      frozenAt: '2026-08-31T18:38:00Z',
      provider: null,
      // snapshot COMPLETO: leerTarifaCongelada exige todos los campos del negocio (transactionCost.service.ts:438) o lo da por INVALIDO
      venue: {
        structureId: 's1',
        source: 'venue',
        accountType: 'PRIMARY',
        debitRate: '0.0195',
        creditRate: '0.0255',
        amexRate: '0.035',
        internationalRate: '0.04',
        includesTax: false,
        taxRate: '0.16',
        fixedFeePerTransaction: '0',
      },
    },
  },
  transactionCost: { transactionType: 'DEBIT', venueChargeAmount: 1.36, venueFixedFee: 0 },
  ...o,
})
function preparar(cobros: unknown[], reglas: unknown[] = [regla()], originales: unknown[] = []) {
  prismaMock.venue.findUnique.mockResolvedValue({ name: 'REST TESTARUDO CAFE', timezone: TZ } as never)
  prismaMock.payment.groupBy.mockResolvedValue([{ merchantAccountId: 'm1' }] as never)
  prismaMock.settlementConfiguration.findMany.mockResolvedValue(reglas as never)
  prismaMock.payment.count.mockResolvedValue(cobros.length as never)
  // Pagina de verdad: ordena por createdAt,id, arranca después del cursor y corta en `take`.
  const ordenados = [...(cobros as any[])].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  prismaMock.payment.findMany.mockImplementation((args: any) => {
    if (args?.where?.id?.in) return Promise.resolve(originales as never)
    let desde = 0
    if (args?.cursor?.id) desde = ordenados.findIndex(c => c.id === args.cursor.id) + (args.skip ?? 0)
    return Promise.resolve(ordenados.slice(desde, args?.take ? desde + args.take : undefined) as never)
  })
}
const base = { venueId: 'v1', startDate: '2026-08-01', endDate: '2026-08-31', dateBasis: 'charge' as const, filtros: {}, tope: TOPE_CSV }

describe('construirReporte', () => {
  it('renglón completo con fecha proyectada, comisión e IVA del snapshot', async () => {
    preparar([cobro()])
    const r = await construirReporte(base)
    expect(r.transacciones[0]).toMatchObject({
      folio: '102298819725',
      fechaCobro: '2026-08-31 12:38',
      terminal: 'AVQD-PP35272416000125',
      ultimos4: '1073',
      tipoTarjeta: 'DEBIT',
      operacion: 'SALE',
      marca: 'VISA',
      consumo: 60,
      propina: 0,
      total: 60,
      totalComision: 1.36,
      comision: 1.17,
      ivaComision: 0.19,
      montoADepositar: 58.64,
      fechaDeposito: '2026-09-01',
      motivoSinFecha: null,
    })
    expect(r.depositos).toHaveLength(1)
  })

  it('TZ: un cobro de las 23:30 del 31 (hora del venue) queda en agosto y en su día', async () => {
    preparar([cobro({ createdAt: new Date('2026-09-01T05:30:00Z') })]) // 31-ago 23:30 CDMX
    const r = await construirReporte(base)
    expect(r.transacciones[0].fechaCobro).toBe('2026-08-31 23:30')
  })

  it('el rango pide cobros con createdAt entre inicio y fin locales, cortado al instante de inicio', async () => {
    preparar([])
    const ahora = new Date('2026-08-15T00:00:00Z')
    await construirReporte({ ...base, ahora })
    const where = (prismaMock.payment.findMany.mock.calls[0][0] as any).where
    expect(where.createdAt.gte).toEqual(new Date('2026-08-01T06:00:00.000Z'))
    expect(where.createdAt.lte).toEqual(ahora) // corte: min(fin, ahora)
    expect(where.AND).toEqual(expect.arrayContaining([{ OR: [{ type: null }, { type: { notIn: ['TEST', 'ADJUSTMENT'] } }] }]))
  })

  it('sin costo ⇒ «Sin calcular» (SIN_COSTO), sin comisión ni neto; nunca cero', async () => {
    preparar([cobro({ transactionCost: null })])
    const r = await construirReporte(base)
    expect(r.transacciones[0]).toMatchObject({
      fechaDeposito: null,
      motivoSinFecha: 'SIN_COSTO',
      totalComision: null,
      montoADepositar: null,
    })
    expect(r.depositos).toHaveLength(0)
    expect(r.sinFecha).toMatchObject({ cobros: 1, total: 60 })
  })

  it('negocio sin reglas ⇒ todo en «Sin fecha calculada», con comisión y neto conocidos (SIN_REGLA)', async () => {
    preparar([cobro()], [])
    const r = await construirReporte(base)
    expect(r.transacciones[0]).toMatchObject({
      motivoSinFecha: 'SIN_REGLA',
      totalComision: 1.36,
      montoADepositar: 58.64,
      fechaDeposito: null,
    })
  })

  it('regla inválida ⇒ REGLA_INVALIDA y el motor NO corre', async () => {
    preparar([cobro()], [regla({ settlementDays: 400 })])
    const r = await construirReporte(base)
    expect(r.transacciones[0].motivoSinFecha).toBe('REGLA_INVALIDA')
  })

  it('con cargo fijo el desglose queda vacío; el total sí sale', async () => {
    preparar([cobro({ transactionCost: { transactionType: 'DEBIT', venueChargeAmount: 1.36, venueFixedFee: 0.5 } })])
    const r = await construirReporte(base)
    expect(r.transacciones[0]).toMatchObject({ totalComision: 1.86, comision: null, ivaComision: null })
  })

  it('efectivo NO procesado por Avoqado queda fuera (paymentIsAvoqadoSettled)', async () => {
    preparar([cobro({ fundsFlow: 'EXTERNAL_RECORDED', method: 'OTHER' })])
    const r = await construirReporte(base)
    expect(r.transacciones).toHaveLength(0)
  })

  it('devolución: hereda terminal, marca, tarjeta y snapshot del original; cae en el siguiente depósito', async () => {
    const original = cobro({ id: 'orig' })
    preparar(
      [
        cobro({
          id: 'r1',
          amount: -65,
          terminalId: null,
          terminal: null,
          cardBrand: null,
          maskedPan: null,
          processorData: { originalPaymentId: 'orig' },
          transactionCost: { transactionType: 'DEBIT', venueChargeAmount: -1.47, venueFixedFee: 0 },
        }),
      ],
      [regla()],
      [original],
    )
    const r = await construirReporte({ ...base, filtros: { terminalIds: ['t1'] } })
    expect(r.transacciones[0]).toMatchObject({
      operacion: 'REFUND',
      terminal: 'AVQD-PP35272416000125',
      marca: 'VISA',
      ultimos4: '1073',
      totalComision: -1.47,
      comision: -1.27,
      ivaComision: -0.2,
      fechaDeposito: '2026-09-01',
    })
  })

  it('base «fecha de depósito»: lee desde antes del inicio y se queda con lo que cae dentro', async () => {
    // 31-jul 15:00 (viernes) con 1 día hábil cae el 3-ago (lunes): entra en agosto aunque se cobró en julio.
    preparar([cobro({ createdAt: new Date('2026-07-31T21:00:00Z') }), cobro({ id: 'p2', createdAt: new Date('2026-08-31T21:00:00Z') })])
    const r = await construirReporte({ ...base, dateBasis: 'deposit' })
    expect(r.transacciones.map(t => t.paymentId)).toEqual(['p1']) // p2 deposita el 1-sep: fuera de agosto
    expect(r.ventanaDesde < '2026-08-01').toBe(true)
  })

  it('DST (America/Tijuana, cambio 1-nov-2026): la ventana resta días del calendario local, no 24 h', async () => {
    const tj = 'America/Tijuana'
    prismaMock.venue.findUnique.mockResolvedValue({ name: 'TJ', timezone: tj } as never)
    prismaMock.payment.groupBy.mockResolvedValue([{ merchantAccountId: 'm1' }] as never)
    prismaMock.settlementConfiguration.findMany.mockResolvedValue([
      regla({ settlementDays: 30, settlementDayType: 'CALENDAR_DAYS', cutoffTime: '00:00', cutoffTimezone: tj }),
    ] as never)
    prismaMock.payment.count.mockResolvedValue(0 as never)
    prismaMock.payment.findMany.mockResolvedValue([] as never)
    const r = await construirReporte({ ...base, startDate: '2026-11-02', endDate: '2026-11-02', dateBasis: 'deposit' })
    const inicio = fromZonedTime('2026-11-02T00:00:00.000', tj)
    const esperado = fromZonedTime(subDays(toZonedTime(inicio, tj), 31), tj)
    expect(esperado.toISOString()).toBe('2026-10-02T07:00:00.000Z') // 2-oct 00:00 locales (PDT, UTC-7)
    expect(esperado.getTime()).not.toBe(inicio.getTime() - 31 * 864e5) // restar 744 h lo corría a 01:00 locales
    expect(r.ventanaDesde).toBe(formatInTimeZone(esperado, tj, 'yyyy-MM-dd'))
    expect(formatInTimeZone(esperado, tj, 'HH:mm')).toBe('00:00')
  })

  it('tope: el conteo previo rechaza, y si a media lectura se pasa también, sin devolver renglones', async () => {
    preparar([cobro()])
    prismaMock.payment.count.mockResolvedValue((TOPE_CSV + 1) as never)
    await expect(construirReporte(base)).rejects.toBeInstanceOf(ReporteDemasiadoGrandeError)

    preparar(Array.from({ length: 3 }, (_, i) => cobro({ id: `p${i}` })))
    prismaMock.payment.count.mockResolvedValue(2 as never) // el conteo previo pasa; la LECTURA trae 3
    await expect(construirReporte({ ...base, tope: 2 })).rejects.toMatchObject({ statusCode: 413 })
  })

  it('más de 500 versiones de reglas ⇒ 413', async () => {
    preparar(
      [cobro()],
      Array.from({ length: 501 }, () => regla()),
    )
    await expect(construirReporte(base)).rejects.toMatchObject({ statusCode: 413 })
  })

  it('aislamiento: toda consulta lleva venueId', async () => {
    preparar([cobro()])
    await construirReporte(base)
    for (const call of prismaMock.payment.findMany.mock.calls) expect((call[0] as any).where.venueId).toBe('v1')
    expect((prismaMock.payment.groupBy.mock.calls[0][0] as any).where.venueId).toBe('v1')
  })

  it('rango > 92 días o fecha mal formada ⇒ 400', async () => {
    preparar([])
    await expect(construirReporte({ ...base, startDate: '2026-01-01', endDate: '2026-08-31' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(construirReporte({ ...base, startDate: '2026-8-1' })).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('contarCandidatos', () => {
  it('cuenta con el MISMO where que la lectura', async () => {
    preparar([cobro()])
    const c = await contarCandidatos({ ...base })
    expect(c.candidateCount).toBe(1)
    await construirReporte(base)
    const whereConteo = (prismaMock.payment.count.mock.calls[0][0] as any).where
    const whereLectura = (prismaMock.payment.findMany.mock.calls[0][0] as any).where
    expect(whereConteo).toEqual(whereLectura)
  })
})

describe('construirReporte — casos de la corrección C4/C5', () => {
  afterEach(() => jest.restoreAllMocks())

  const llamadasDeLectura = () =>
    prismaMock.payment.findMany.mock.calls.map((c: unknown[]) => c[0] as any).filter((a: any) => !a.where?.id?.in)

  it('pagina de verdad: 1,001 cobros en 3 páginas, todos leídos una sola vez, con orderBy/take/cursor/skip', async () => {
    const t0 = new Date('2026-08-10T15:00:00Z').getTime()
    const cobros = Array.from({ length: 1001 }, (_, i) =>
      cobro({ id: `p${String(i).padStart(4, '0')}`, createdAt: new Date(t0 + i * 60_000) }),
    )
    preparar(cobros)
    const r = await construirReporte(base)
    expect(r.transacciones).toHaveLength(1001)
    expect(new Set(r.transacciones.map(t => t.paymentId)).size).toBe(1001)
    expect(r.candidatosLeidos).toBe(1001)
    const llamadas = llamadasDeLectura()
    expect(llamadas).toHaveLength(3)
    for (const a of llamadas) {
      expect(a.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
      expect(a.take).toBe(500)
    }
    expect(llamadas[0].cursor).toBeUndefined()
    expect(llamadas[1]).toMatchObject({ cursor: { id: 'p0499' }, skip: 1 })
    expect(llamadas[2]).toMatchObject({ cursor: { id: 'p0999' }, skip: 1 })
  })

  it('empate de createdAt entre la última fila de una página y la primera de la siguiente: sin duplicar ni perder', async () => {
    const t0 = new Date('2026-08-10T15:00:00Z').getTime()
    const cobros = Array.from({ length: 501 }, (_, i) =>
      cobro({ id: `p${String(i).padStart(4, '0')}`, createdAt: new Date(t0 + Math.min(i, 499) * 60_000) }),
    ) // las filas 499 y 500 comparten createdAt
    preparar(cobros)
    const r = await construirReporte(base)
    expect(r.transacciones.map(t => t.paymentId)).toEqual(cobros.map(c => c.id))
  })

  it('11 días hábiles cruzando un festivo mexicano: la fecha sale del motor real', async () => {
    const createdAt = new Date('2026-09-10T18:00:00Z') // cruza el 16-sep
    const r11 = regla({ settlementDays: 11 })
    const esperado = formatInTimeZone(
      calculateSettlementDate(createdAt, {
        settlementDays: 11,
        settlementDayType: 'BUSINESS_DAYS',
        cutoffTime: '23:00',
        cutoffTimezone: TZ,
      }),
      TZ,
      'yyyy-MM-dd',
    )
    preparar([cobro({ createdAt })], [r11])
    const r = await construirReporte({ ...base, startDate: '2026-09-01', endDate: '2026-09-30' })
    expect(r.transacciones[0].fechaDeposito).toBe(esperado)
  })

  it('regla histórica de 30 hábiles que venció antes del rango y aun así coloca un cobro dentro (base depósito)', async () => {
    const vieja = regla({ settlementDays: 30, effectiveFrom: new Date('2026-01-01'), effectiveTo: new Date('2026-07-15T23:59:59Z') })
    const nueva = regla({ settlementDays: 1, effectiveFrom: new Date('2026-07-16') })
    const createdAt = new Date('2026-07-10T18:00:00Z')
    const esperado = formatInTimeZone(
      calculateSettlementDate(createdAt, {
        settlementDays: 30,
        settlementDayType: 'BUSINESS_DAYS',
        cutoffTime: '23:00',
        cutoffTimezone: TZ,
      }),
      TZ,
      'yyyy-MM-dd',
    )
    expect(esperado >= '2026-08-17' && esperado <= '2026-08-31').toBe(true)
    preparar([cobro({ createdAt })], [nueva, vieja])
    const r = await construirReporte({ ...base, startDate: '2026-08-17', endDate: '2026-08-31', dateBasis: 'deposit' })
    expect(r.transacciones).toHaveLength(1)
    expect(r.transacciones[0].fechaDeposito).toBe(esperado)
    expect(r.ventanaDesde < '2026-07-10').toBe(true)
  })

  it('devoluciones parciales sucesivas del mismo original y una de sólo propina: herencia completa, un solo original leído', async () => {
    const original = cobro({ id: 'orig' })
    const hija = (id: string, amount: number, tipAmount: number, cargo: number, min: number) =>
      cobro({
        id,
        amount,
        tipAmount,
        terminalId: null,
        terminal: null,
        cardBrand: null,
        maskedPan: null,
        authorizationNumber: null,
        createdAt: new Date(new Date('2026-08-31T19:00:00Z').getTime() + min * 60_000),
        processorData: { originalPaymentId: 'orig' },
        transactionCost: { transactionType: 'DEBIT', venueChargeAmount: cargo, venueFixedFee: 0 },
      })
    preparar([hija('r1', -20, 0, -0.45, 0), hija('r2', -15, 0, -0.34, 1), hija('r3', 0, -5, -0.11, 2)], [regla()], [original])
    const r = await construirReporte({ ...base, filtros: { terminalIds: ['t1'] } })
    expect(r.transacciones.map(t => t.operacion)).toEqual(['REFUND', 'REFUND', 'TIP_REFUND'])
    for (const t of r.transacciones) {
      expect(t).toMatchObject({
        terminal: 'AVQD-PP35272416000125',
        marca: 'VISA',
        ultimos4: '1073',
        tipoTarjeta: 'DEBIT',
        fechaDeposito: '2026-09-01',
      })
      expect(t.comision).not.toBeNull()
    }
    const lecturasDeOriginales = prismaMock.payment.findMany.mock.calls.filter((c: unknown[]) => (c[0] as any).where?.id?.in)
    expect(lecturasDeOriginales).toHaveLength(1)
    expect((lecturasDeOriginales[0][0] as any).where.id.in).toEqual(['orig'])
  })

  it('regla inválida: el motor (projectPaymentSettlement) NO se invoca', async () => {
    const espia = jest.spyOn(require('@/services/dashboard/settlementCalendar.dashboard.service'), 'projectPaymentSettlement')
    preparar([cobro()], [regla({ settlementDays: 400 })])
    const r = await construirReporte(base)
    expect(r.transacciones[0].motivoSinFecha).toBe('REGLA_INVALIDA')
    expect(espia).not.toHaveBeenCalled()
  })

  it('fecha imposible (2026-02-31) ⇒ 400', async () => {
    preparar([])
    await expect(construirReporte({ ...base, startDate: '2026-02-31', endDate: '2026-03-05' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('más de 200 cuentas de cobro (groupBy devuelve 201) ⇒ 413', async () => {
    preparar([cobro()])
    prismaMock.payment.groupBy.mockResolvedValue(Array.from({ length: 201 }, (_, i) => ({ merchantAccountId: `m${i}` })) as never)
    await expect(construirReporte(base)).rejects.toMatchObject({ statusCode: 413, code: 'SETTLEMENT_REPORT_TOO_MANY_ACCOUNTS' })
  })
})
