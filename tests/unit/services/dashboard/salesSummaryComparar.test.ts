/**
 * Resumen de ventas · comparar con otro periodo (carril F2, hz:fefa11b6:D7). Plan v5 en el workspace:
 * `docs/audit/2026-11-21-resumen-de-ventas/comparar/promesa.md`.
 *
 * - `rangoComparado`: qué periodo se lee del otro lado, en días del negocio, y hasta qué hora si el actual va a la mitad.
 * - `cambioDe`: la diferencia en pesos y en %, con «nuevo» si antes era $0, redondeada como la pinta el panel (Intl).
 */
import { cambioDe, cambiosDelResumen, rangoComparado } from '@/services/dashboard/salesSummaryComparar'
import type { SalesSummaryMetrics } from '@/services/dashboard/sales-summary.dashboard.service'
import { DateTime } from 'luxon'

const MX = 'America/Mexico_City'
// lun 23-nov-2026, 2:00 p. m. en la Ciudad de México.
const T = DateTime.fromISO('2026-11-23T14:00', { zone: MX }).toJSDate()

const dia = (s: string, zona = MX) => DateTime.fromISO(s, { zone: zona })
const rango = (desde: string, hasta: string, zona = MX) => ({
  startDate: dia(desde, zona).startOf('day').toUTC().toISO()!,
  endDate: dia(hasta, zona).endOf('day').toUTC().toISO()!,
})
/** El resultado en reloj del negocio, para leer las pruebas como la tabla de la promesa. */
const local = (iso: string, zona = MX) => DateTime.fromISO(iso).setZone(zona).toFormat('yyyy-MM-dd HH:mm:ss.SSS')

function comparado(desde: string, hasta: string, con: 'previous_period' | 'previous_year', ahora = T, zona = MX) {
  const r = rango(desde, hasta, zona)
  const res = rangoComparado(r.startDate, r.endDate, con, zona, ahora)
  if (res.status !== 'ok') return res
  return {
    status: res.status,
    base: `${local(res.base.startDate, zona)} → ${local(res.base.endDate, zona)}`,
    comparado: `${local(res.comparado.startDate, zona)} → ${local(res.comparado.endDate, zona)}`,
    untilSameTime: res.untilSameTime,
    matchedWeekday: res.matchedWeekday,
  }
}

describe('rangoComparado · la pasada exhaustiva de la promesa', () => {
  it('«Hoy» a la mitad: hasta la misma hora, contra ayer y contra 52 semanas antes (mismo día de la semana)', () => {
    expect(comparado('2026-11-23', '2026-11-23', 'previous_period')).toEqual({
      status: 'ok',
      base: '2026-11-23 00:00:00.000 → 2026-11-23 14:00:00.000',
      comparado: '2026-11-22 00:00:00.000 → 2026-11-22 14:00:00.000',
      untilSameTime: true,
      matchedWeekday: false,
    })
    expect(comparado('2026-11-23', '2026-11-23', 'previous_year')).toMatchObject({
      comparado: '2025-11-24 00:00:00.000 → 2025-11-24 14:00:00.000',
      matchedWeekday: true,
    })
  })

  it('«Ayer» y «Semana pasada» cerrados: sin corte', () => {
    expect(comparado('2026-11-22', '2026-11-22', 'previous_period')).toMatchObject({
      comparado: '2026-11-21 00:00:00.000 → 2026-11-21 23:59:59.999',
      untilSameTime: false,
    })
    expect(comparado('2026-11-16', '2026-11-22', 'previous_year')).toMatchObject({
      comparado: '2025-11-17 00:00:00.000 → 2025-11-23 23:59:59.999',
      matchedWeekday: true,
    })
  })

  it('«Últimos 7 días» a la mitad: los 7 anteriores hasta la misma hora', () => {
    expect(comparado('2026-11-17', '2026-11-23', 'previous_period')).toMatchObject({
      comparado: '2026-11-10 00:00:00.000 → 2026-11-16 14:00:00.000',
      untilSameTime: true,
    })
  })

  it('un mes completo contra el mes completo anterior (octubre con su 31), y «Este mes» a la mitad', () => {
    expect(comparado('2026-10-01', '2026-10-31', 'previous_period')).toMatchObject({
      comparado: '2026-09-01 00:00:00.000 → 2026-09-30 23:59:59.999',
    })
    expect(comparado('2026-11-01', '2026-11-30', 'previous_period')).toMatchObject({
      base: '2026-11-01 00:00:00.000 → 2026-11-23 14:00:00.000',
      comparado: '2026-10-01 00:00:00.000 → 2026-10-23 14:00:00.000',
    })
    expect(comparado('2025-12-01', '2025-12-31', 'previous_period')).toMatchObject({
      comparado: '2025-11-01 00:00:00.000 → 2025-11-30 23:59:59.999',
    })
  })

  it('🔴 febrero completo es «mes» antes que «4 semanas»: feb 2026 ⇒ feb 2025 (no 2-feb → 1-mar)', () => {
    expect(comparado('2026-02-01', '2026-02-28', 'previous_year')).toMatchObject({
      comparado: '2025-02-01 00:00:00.000 → 2025-02-28 23:59:59.999',
      matchedWeekday: false,
    })
  })

  it('🔴 febrero 2025 contra febrero 2024, con su 29', () => {
    expect(comparado('2025-02-01', '2025-02-28', 'previous_year')).toMatchObject({
      comparado: '2024-02-01 00:00:00.000 → 2024-02-29 23:59:59.999',
    })
  })

  it('31-dic con 52 semanas cae el 1-ene del mismo año (el día de la semana más cercano, como Shopify)', () => {
    const ahora = DateTime.fromISO('2027-01-05T12:00', { zone: MX }).toJSDate()
    expect(comparado('2026-12-31', '2026-12-31', 'previous_year', ahora)).toMatchObject({
      comparado: '2026-01-01 00:00:00.000 → 2026-01-01 23:59:59.999',
      matchedWeekday: true,
    })
  })

  it('10 días: el periodo anterior son los 10 de antes; el año pasado, las mismas fechas', () => {
    expect(comparado('2026-11-05', '2026-11-14', 'previous_period')).toMatchObject({
      comparado: '2026-10-26 00:00:00.000 → 2026-11-04 23:59:59.999',
    })
    expect(comparado('2026-11-05', '2026-11-14', 'previous_year')).toMatchObject({
      comparado: '2025-11-05 00:00:00.000 → 2025-11-14 23:59:59.999',
      matchedWeekday: false,
    })
  })

  it('🔴 el comparado nunca se encima con el actual: «Últimos 365 días» (366 fechas) contra el año pasado', () => {
    expect(comparado('2025-11-23', '2026-11-23', 'previous_year')).toMatchObject({
      comparado: '2024-11-23 00:00:00.000 → 2025-11-22 23:59:59.999',
    })
  })

  it('🔴 «Todo el tiempo» (más de 366 fechas) ⇒ tooLong; un periodo que no empieza ⇒ notStarted', () => {
    expect(comparado('2000-01-01', '2026-11-23', 'previous_period')).toEqual({ status: 'tooLong' })
    expect(comparado('2026-11-24', '2026-11-24', 'previous_year')).toEqual({ status: 'notStarted' })
  })

  it('🔴 un atajo con horas sueltas (14:00 → 14:00): el mismo largo justo antes, terminando 1 ms antes del inicio', () => {
    const inicio = dia('2026-11-09T14:00').toUTC().toISO()!
    const fin = dia('2026-11-23T14:00').toUTC().toISO()!
    const res = rangoComparado(inicio, fin, 'previous_period', MX, DateTime.fromISO('2026-11-23T14:00:05', { zone: MX }).toJSDate())
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(local(res.comparado.endDate)).toBe('2026-11-09 13:59:59.999')
    expect(local(res.comparado.startDate)).toBe('2026-10-26 13:59:59.999')
    expect(res.untilSameTime).toBe(false)
  })

  it('«GMT-6» guardado se calcula como la Ciudad de México', () => {
    const r = rango('2026-11-22', '2026-11-22')
    expect(rangoComparado(r.startDate, r.endDate, 'previous_period', 'GMT-6', T)).toEqual(
      rangoComparado(r.startDate, r.endDate, 'previous_period', MX, T),
    )
  })

  it('Tijuana el día que empieza el horario de verano: «ayer hasta la misma hora» en el reloj del negocio', () => {
    const tj = 'America/Tijuana'
    const ahora = DateTime.fromISO('2026-03-09T14:00', { zone: tj }).toJSDate()
    expect(comparado('2026-03-09', '2026-03-09', 'previous_period', ahora, tj)).toMatchObject({
      comparado: '2026-03-08 00:00:00.000 → 2026-03-08 14:00:00.000',
    })
    // 366 fechas del calendario con una hora de más (otoño en medio) no son «más de un año».
    expect(
      comparado('2025-11-02', '2026-11-02', 'previous_period', DateTime.fromISO('2027-01-01', { zone: tj }).toJSDate(), tj),
    ).toMatchObject({
      status: 'ok',
    })
  })
})

describe('cambioDe · la diferencia, el % y «nuevo»', () => {
  it('sube y baja con su %, de un decimal', () => {
    expect(cambioDe(1200, 1000)).toEqual({ difference: 200, percent: 20, isNew: false })
    expect(cambioDe(950, 1000)).toEqual({ difference: -50, percent: -5, isNew: false })
    expect(cambioDe(1001, 3000)).toEqual({ difference: -1999, percent: -66.6, isNew: false })
  })

  it('🔴 base $0: «nuevo», sin un % infinito', () => {
    expect(cambioDe(500, 0)).toEqual({ difference: 500, percent: null, isNew: true })
  })

  it('🔴 los dos en $0: sin cambio, nunca «−$0.00»', () => {
    const c = cambioDe(-0.004, 0)!
    expect(c).toEqual({ difference: 0, percent: null, isNew: false })
    expect(Object.is(c.difference, -0)).toBe(false)
  })

  it('🔴 redondea como el panel (Intl): 1.005 frente a 1.00 es un centavo, −0.005 frente a 0 también', () => {
    expect(cambioDe(1.005, 1)).toEqual({ difference: 0.01, percent: 1, isNew: false })
    expect(cambioDe(-0.005, 0)).toEqual({ difference: -0.01, percent: null, isNew: true })
    expect(cambioDe(0.285, 0)!.difference).toBe(0.29)
  })

  it('🔴 base negativa (una devolución de otro día dejó las ventas netas abajo de cero): sólo pesos, sin %', () => {
    expect(cambioDe(100, -50)).toEqual({ difference: 150, percent: null, isNew: false })
  })

  it('una comisión que pasa de $20 a un reverso de −$30 baja $50 (250 %)', () => {
    expect(cambioDe(-30, 20)).toEqual({ difference: -50, percent: -250, isNew: false })
  })

  it('🔴 null en cualquiera de los dos lados (vista de movimientos): no se mide', () => {
    expect(cambioDe(null, 100)).toBeNull()
    expect(cambioDe(100, undefined)).toBeNull()
  })

  it('conteos enteros', () => {
    expect(cambioDe(25, 20)).toEqual({ difference: 5, percent: 25, isNew: false })
  })
})

describe('cambiosDelResumen', () => {
  const s = (o: Partial<SalesSummaryMetrics>) => ({ grossSales: 0, totalCollected: 0, transactionCount: 0, ...o }) as SalesSummaryMetrics

  it('cada cifra del Resumen con su cambio; la que falta de un lado es null', () => {
    const c = cambiosDelResumen(
      s({ grossSales: 1100, totalCollected: 900, transactionCount: 12, chargedAmount: 10 }),
      s({ grossSales: 1000, totalCollected: 1000, transactionCount: 10 }),
    )
    expect(c.grossSales).toEqual({ difference: 100, percent: 10, isNew: false })
    expect(c.totalCollected).toEqual({ difference: -100, percent: -10, isNew: false })
    expect(c.transactionCount).toEqual({ difference: 2, percent: 20, isNew: false })
    expect(c.chargedAmount).toBeNull()
  })

  it('🔴 sin cambios (el negocio del QR anterior): todo null', () => {
    const c = cambiosDelResumen(s({ grossSales: 1100 }), s({ grossSales: 1000 }), { sinCambios: true })
    expect(Object.values(c).every(v => v === null)).toBe(true)
  })
})
