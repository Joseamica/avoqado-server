/**
 * Revisión nocturna de tarjetas de regalo (spec §6). Cada diferencia deja un MoneyAnomaly con llave determinista (R6) y una línea de
 * log con el nombre del negocio; una cuenta pagada con sobres PENDING además se ACTIVA con la misma función que el cobro.
 * Notas del coordinador (B7): dos barridos más —dinero conservado sin sobres vivos que lo respalden (`PAID_WITH_DEACTIVATED`, la
 * MISMA llave que A6) y la cuenta en $0 que se quedó abierta con sobres PENDING (`OPEN_AT_ZERO_WITH_PENDING`)—, sólo avisan.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))

import { scheduleJob } from '@/observability/jobContext'
import { GiftCardReconciliationJob, hallazgosPorPaginas } from '@/jobs/giftCardReconciliation.job'
import { DATABASE_JOB_SCHEDULES } from '@/jobs/jobSchedules'
import { shouldRetryDbConnectionError } from '@/utils/retry'

const noopCron = { start: jest.fn(), stop: jest.fn() }
const AHORA = new Date('2026-10-15T09:37:27Z')

function job(over: Partial<ConstructorParameters<typeof GiftCardReconciliationJob>[0]> = {}) {
  return new GiftCardReconciliationJob({
    cron: noopCron,
    now: () => AHORA,
    retryEntry: ((fn: () => Promise<unknown>) => fn()) as never,
    buscarSaldosDescuadrados: jest.fn().mockResolvedValue([{ giftCardId: 'gc1', venueId: 'v1', balance: '300.00', libreta: '500.00' }]),
    buscarCuentasPagadasConPendientes: jest.fn().mockResolvedValue([{ orderId: 'o1', venueId: 'v1' }]),
    activarCuenta: jest.fn().mockResolvedValue({ activated: ['gc9'] }),
    buscarCobrosConSaldoSinCanje: jest.fn().mockResolvedValue([{ paymentId: 'pay1', venueId: 'v1', orderId: 'o2' }]),
    buscarReembolsosSinReverso: jest.fn().mockResolvedValue([{ refundPaymentId: 'ref1', venueId: 'v1', originalPaymentId: 'pay1' }]),
    buscarCancelacionesAtoradas: jest
      .fn()
      .mockResolvedValue([{ giftCardId: 'gc7', venueId: 'v1', bloqueadoEn: new Date('2026-10-13T20:00:00Z') }]),
    buscarCuentasConDineroSinRespaldo: jest.fn().mockResolvedValue([
      {
        orderId: 'o3',
        venueId: 'v1',
        cobrado: '350.00',
        reembolsado: '200.00',
        conservado: '150.00',
        respaldo: '0.00',
        sobres: [{ id: 'gc3', status: 'DEACTIVATED' }],
      },
    ]),
    buscarCuentasEnCeroAbiertas: jest
      .fn()
      .mockResolvedValue([{ orderId: 'o4', venueId: 'v1', cobrado: '200.00', reembolsado: '200.00', conservado: '0.00' }]),
    registrarAnomalia: jest.fn().mockResolvedValue(undefined),
    nombresDeNegocios: jest.fn().mockResolvedValue(new Map([['v1', 'IQ Collection']])),
    ...over,
  })
}

describe('GiftCardReconciliationJob', () => {
  it('🔴 cada hallazgo deja su anomalía con su check e id', async () => {
    const registrar = jest.fn().mockResolvedValue(undefined)
    const r = await job({ registrarAnomalia: registrar }).runNow()
    expect(registrar.mock.calls.map(c => [c[0].check, c[0].id])).toEqual([
      ['BALANCE_MISMATCH', 'gc1'],
      ['PAID_WITH_PENDING', 'o1'],
      ['TENDER_WITHOUT_REDEEM', 'pay1'],
      ['REFUND_WITHOUT_REVERSAL', 'ref1'],
      ['CANCEL_STUCK', 'gc7'],
      ['PAID_WITH_DEACTIVATED', 'o3'],
      ['OPEN_AT_ZERO_WITH_PENDING', 'o4'],
    ])
    expect(r).toMatchObject({
      saldosDescuadrados: 1,
      cuentasPagadasConPendientes: 1,
      cuentasActivadas: 1,
      cobrosSinCanje: 1,
      reembolsosSinReverso: 1,
      cancelacionesAtoradas: 1,
      cuentasCanceladasConDinero: 1,
      cuentasEnCeroAbiertas: 1,
      fallidas: 0,
    })
  })

  it('🔴 nota 1: el dinero sin respaldo usa la llave de A6 (orderId) y dice lo cobrado, lo devuelto, lo conservado y cada sobre', async () => {
    const registrar = jest.fn().mockResolvedValue(undefined)
    await job({ registrarAnomalia: registrar }).runNow()
    const fila = registrar.mock.calls.map(c => c[0]).find(a => a.check === 'PAID_WITH_DEACTIVATED')
    expect(fila).toEqual({
      check: 'PAID_WITH_DEACTIVATED',
      id: 'o3',
      venueId: 'v1',
      detail: {
        motivo: 'REVISION_NOCTURNA',
        orderId: 'o3',
        cobrado: '350.00',
        reembolsado: '200.00',
        conservado: '150.00',
        respaldo: '0.00',
        sobres: [{ id: 'gc3', status: 'DEACTIVATED' }],
      },
    })
  })

  it('🔴 Review Focus 3: una cuenta pagada con sobres PENDING se activa con la función del cobro', async () => {
    const activar = jest.fn().mockResolvedValue({ activated: ['gc9'] })
    await job({ activarCuenta: activar }).runNow()
    expect(activar).toHaveBeenCalledWith({ orderId: 'o1', venueId: 'v1' })
  })

  it('si la activación no activa nada (lo cobrado no cuadra: la función deja su propia anomalía), no se reporta como activada', async () => {
    const registrar = jest.fn().mockResolvedValue(undefined)
    const r = await job({ activarCuenta: jest.fn().mockResolvedValue({ activated: [] }), registrarAnomalia: registrar }).runNow()
    expect(r.cuentasActivadas).toBe(0)
    expect(registrar.mock.calls.map(c => c[0].check)).not.toContain('PAID_WITH_PENDING')
  })

  it('una activación que falla no detiene al resto', async () => {
    const r = await job({ activarCuenta: jest.fn().mockRejectedValue(new Error('candado')) }).runNow()
    expect(r.fallidas).toBe(1)
    expect(r.cobrosSinCanje).toBe(1)
    expect(r.cuentasEnCeroAbiertas).toBe(1)
  })

  it('una anomalía que no se puede escribir cuenta como fallida y no frena a las siguientes', async () => {
    const registrar = jest.fn(async (a: { check: string }) => {
      if (a.check === 'PAID_WITH_DEACTIVATED') throw new Error('base caída')
    })
    const r = await job({ registrarAnomalia: registrar }).runNow()
    expect(r.fallidas).toBe(1)
    expect(registrar.mock.calls.map(c => c[0].check)).toContain('OPEN_AT_ZERO_WITH_PENDING')
  })

  it('🔴 r1 B-6: recorre TODAS las páginas en la misma corrida; 200 hallazgos que persisten no esconden al 201', async () => {
    // 450 saldos descuadrados. Registrar la anomalía NO quita la condición: la base los sigue devolviendo en cada corrida.
    const todos = Array.from({ length: 450 }, (_, i) => ({
      giftCardId: `gc-${String(i).padStart(3, '0')}`,
      venueId: 'v1',
      balance: '1.00',
      libreta: '2.00',
    }))
    const buscar = jest.fn(async ({ despuesDe, limite }: { despuesDe: string | null; limite: number }) =>
      todos.filter(x => despuesDe === null || x.giftCardId > despuesDe).slice(0, limite),
    )
    const registrar = jest.fn().mockResolvedValue(undefined)
    const r = await job({ buscarSaldosDescuadrados: buscar, registrarAnomalia: registrar }).runNow()
    expect(buscar.mock.calls.map(c => c[0].despuesDe)).toEqual([null, 'gc-199', 'gc-399'])
    const ids = registrar.mock.calls.filter(c => c[0].check === 'BALANCE_MISMATCH').map(c => c[0].id)
    expect(ids).toHaveLength(450)
    expect(ids).toEqual(expect.arrayContaining(['gc-000', 'gc-200', 'gc-449']))
    expect(r.saldosDescuadrados).toBe(450)
  })

  it('🔴 r1 B-6: cuentas que fallan en cada corrida no frenan a las siguientes; los contadores son lo recorrido', async () => {
    const cuentas = Array.from({ length: 250 }, (_, i) => ({ orderId: `o-${String(i).padStart(3, '0')}`, venueId: 'v1' }))
    const buscar = jest.fn(async ({ despuesDe, limite }: { antesDe: Date; despuesDe: string | null; limite: number }) =>
      cuentas.filter(c => despuesDe === null || c.orderId > despuesDe).slice(0, limite),
    )
    // Las primeras 200 truenan siempre (un candado, un dato raro); las 50 de después sí se activan.
    const activar = jest.fn(async (c: { orderId: string }) => {
      if (c.orderId < 'o-200') throw new Error('candado')
      return { activated: [`gc-${c.orderId}`] }
    })
    const r = await job({ buscarCuentasPagadasConPendientes: buscar, activarCuenta: activar }).runNow()
    expect(activar).toHaveBeenCalledTimes(250)
    expect(r).toMatchObject({ cuentasPagadasConPendientes: 250, cuentasActivadas: 50, fallidas: 200 })
  })

  it('🔴 notas 1-2: las búsquedas con filtro de dinero regresan una página de HALLAZGOS y retoman justo después del último', async () => {
    // 10 candidatas por keyset en páginas de 3; sólo las pares son hallazgo (la cifra la decide la fórmula de la libreta).
    const ids = Array.from({ length: 10 }, (_, i) => ({ orderId: `o-${i}` }))
    const candidatas = jest.fn(async ({ despuesDe, limite }: { despuesDe: string | null; limite: number }) =>
      ids.filter(c => despuesDe === null || c.orderId > despuesDe).slice(0, limite),
    )
    const esHallazgo = async (c: { orderId: string }) => (Number(c.orderId.slice(2)) % 2 === 0 ? c.orderId : null)
    // Se llena a media página: regresa 3 y el cursor del job (el último hallazgo) retoma sin saltarse ninguna.
    expect(await hallazgosPorPaginas({ despuesDe: null, limite: 3 }, candidatas, esHallazgo)).toEqual(['o-0', 'o-2', 'o-4'])
    expect(await hallazgosPorPaginas({ despuesDe: 'o-4', limite: 3 }, candidatas, esHallazgo)).toEqual(['o-6', 'o-8'])
    expect(candidatas.mock.calls.map(c => c[0].despuesDe)).toEqual([null, 'o-2', 'o-4', 'o-7'])
  })

  it('dryRun sólo cuenta: no activa ni registra', async () => {
    const activar = jest.fn()
    const registrar = jest.fn()
    const r = await job({ activarCuenta: activar, registrarAnomalia: registrar }).runNow({ dryRun: true })
    expect(r).toMatchObject({
      dryRun: true,
      saldosDescuadrados: 1,
      cuentasPagadasConPendientes: 1,
      cuentasCanceladasConDinero: 1,
      cuentasEnCeroAbiertas: 1,
    })
    expect(activar).not.toHaveBeenCalled()
    expect(registrar).not.toHaveBeenCalled()
  })

  it('cada lectura de entrada va con el reintento de conexión (regla de cron)', async () => {
    const retryEntry = jest.fn((fn: () => Promise<unknown>) => fn())
    await job({ retryEntry: retryEntry as never }).runNow()
    expect(retryEntry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ shouldRetry: shouldRetryDbConnectionError, retries: 2 }),
    )
  })

  it('no se encima consigo mismo', async () => {
    let soltar!: () => void
    const lenta = new Promise<never[]>(resolve => {
      soltar = () => resolve([])
    })
    const j = job({ buscarSaldosDescuadrados: jest.fn().mockReturnValue(lenta) })
    const primera = j.runNow()
    const segunda = await j.runNow()
    expect(segunda.skipped).toBe(true)
    soltar()
    await primera
  })

  it('se agenda a las 03:37:27 de la CDMX con scheduleJob', () => {
    expect(DATABASE_JOB_SCHEDULES.giftCardReconciliation).toBe('27 37 3 * * *')
    new GiftCardReconciliationJob()
    expect(scheduleJob).toHaveBeenCalledWith(
      'gift-card-reconciliation',
      '27 37 3 * * *',
      expect.any(Function),
      null,
      false,
      'America/Mexico_City',
    )
  })
})
