/**
 * 🔴 DINERO — Task 5l: el cierre unificado son DOS commits, y este barrido completa el que falta.
 *
 * Si el proceso muere entre los dos, lo que queda NO «degrada a lo de hoy»: con la apertura ya
 * unificada, un turno que sobrevive a su gaveta lo REUSA la cajera de la tarde y acaba firmando dos
 * arqueos (mezcla jornadas), y una gaveta que sobrevive a su turno sigue recibiendo `CASH_SALE` de
 * cobros que ya nacen sin turno.
 *
 * No hay tabla de outbox porque no hace falta: la mitad que SÍ commiteó es el registro durable, y
 * de ella salen el conteo, el esperado, el actor y el instante. Reparar = llamar al MISMO
 * `cerrarTurnoDeCaja` con esos números, que es idempotente por sus CAS.
 */

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { CashClosePairReconcilerJob } from '@/jobs/cash-close-pair-reconciler.job'

const VENUE = 'venue-1'
const TURNO = 'shift-1'
const CAJA = 'caja-1'
const AHORA = new Date('2026-09-03T21:00:00.000Z')
const FIRMADO_A_LAS = new Date('2026-09-03T20:05:00.000Z')

const faltaElTurno = {
  reparable: true as const,
  venueId: VENUE,
  shiftId: TURNO,
  cashDrawerSessionId: CAJA,
  falta: 'TURNO' as const,
  conteo: new Prisma.Decimal('2950.00'),
  esperado: new Prisma.Decimal('3000.00'),
  actorStaffId: 'staff-1',
  momento: FIRMADO_A_LAS,
}

const faltaLaGaveta = { ...faltaElTurno, falta: 'GAVETA' as const, actorStaffId: 'staff-2' }

function job(over: Partial<{ parejas: unknown[]; bloqueadas: unknown[]; cerrar: jest.Mock }> = {}) {
  const buscar = jest.fn().mockResolvedValue({ parejas: over.parejas ?? [], bloqueadas: over.bloqueadas ?? [] })
  const cerrar = over.cerrar ?? jest.fn().mockResolvedValue({ conConteo: true, shiftCerradoId: TURNO })
  const j = new CashClosePairReconcilerJob({
    cron: { start: jest.fn(), stop: jest.fn() },
    now: () => AHORA,
    retryEntry: (fn: any) => fn(),
    buscar,
    cerrar,
  } as never)
  return { j, buscar, cerrar }
}

beforeEach(() => jest.clearAllMocks())

describe('reparar la mitad que falta', () => {
  it('🔴 cierra el TURNO con el conteo y el esperado que la GAVETA ya firmó, y nunca los recalcula', async () => {
    const { j, cerrar } = job({ parejas: [faltaElTurno] })

    const r = await j.runNow()

    expect(r.repaired).toBe(1)
    expect(cerrar).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE,
        staffId: 'staff-1',
        source: 'CAJA_MOVIL',
        yaCerrado: { cashDrawerSessionId: CAJA },
        // 🔴 La pertenencia viaja: sin ella, un turno abierto DESPUÉS podría recibir el conteo de
        // esta gaveta — que es exactamente mezclar jornadas.
        shiftIdDeLaGaveta: TURNO,
      }),
    )
    expect(Number(cerrar.mock.calls[0][0].conteo)).toBe(2950)
    expect(Number(cerrar.mock.calls[0][0].esperadoDelCajon)).toBe(3000)
  })

  it('🔴 cierra la GAVETA con lo que el TURNO firmó, y en el instante en que lo firmó', async () => {
    const { j, cerrar } = job({ parejas: [faltaLaGaveta] })

    await j.runNow()

    const p = cerrar.mock.calls[0][0]
    expect(p).toMatchObject({ source: 'TURNO_TPV', yaCerrado: { shiftId: TURNO }, staffId: 'staff-2' })
    // El instante es el del cierre del turno, NO el del barrido: así la gaveta no absorbe hacia
    // atrás las ventas que entraron después, y su diferencia coincide con la que el turno firmó.
    expect(p.now()).toEqual(FIRMADO_A_LAS)
  })

  it('🔴 sin conteo se cierra SIN conteo: el barrido jamás inventa uno', async () => {
    const { j, cerrar } = job({ parejas: [{ ...faltaLaGaveta, conteo: null, esperado: null }] })

    await j.runNow()

    expect(cerrar.mock.calls[0][0].conteo).toBeNull()
    expect(cerrar.mock.calls[0][0].esperadoDelCajon).toBeNull()
  })

  it('deja rastro con los importes en PESOS, y dice que lo hizo el barrido', async () => {
    const { j } = job({ parejas: [faltaElTurno] })

    await j.runNow()

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE,
        action: 'CASH_CLOSE_PAIR_RECONCILED',
        entity: 'Shift',
        entityId: TURNO,
        data: expect.objectContaining({ falta: 'TURNO', conteo: 2950, esperado: 3000, sweep: 'cash-close-pair-reconciler' }),
      }),
    )
  })

  it('🔴 una pareja que falla no detiene a las demás: cada una es independiente', async () => {
    const cerrar = jest.fn().mockRejectedValueOnce(new Error('el turno está en CLOSING')).mockResolvedValueOnce({ conConteo: true })
    const { j } = job({ parejas: [faltaElTurno, { ...faltaLaGaveta, shiftId: 'shift-2' }], cerrar })

    const r = await j.runNow()

    expect(r.failed).toBe(1)
    expect(r.repaired).toBe(1)
  })

  it('`dryRun` lista sin tocar nada: es lo que hace seguro correrlo contra producción', async () => {
    const { j, cerrar } = job({ parejas: [faltaElTurno] })

    const r = await j.runNow({ dryRun: true })

    expect(r.scanned).toBe(1)
    expect(r.repaired).toBe(0)
    expect(cerrar).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('un tic que se solapa con el anterior no se encima', async () => {
    let soltar: (v: unknown) => void = () => {}
    const cerrar = jest.fn().mockImplementation(() => new Promise(res => (soltar = res)))
    const { j } = job({ parejas: [faltaElTurno], cerrar })

    const enVuelo = j.runNow()
    const segundo = await j.runNow()
    soltar({ conConteo: true })
    await enVuelo

    expect(segundo.skipped).toBe(1)
    expect(cerrar).toHaveBeenCalledTimes(1)
  })
})

describe('lo que NO se repara se DICE', () => {
  const bloqueada = { venueId: VENUE, shiftId: TURNO, cashDrawerSessionId: CAJA, motivo: 'EL_NEGOCIO_SIGUIO' as const }

  it('🔴 una gaveta con el turno de otro mientras alguien vende encima se reporta, no se cierra', async () => {
    const { j, cerrar } = job({ bloqueadas: [bloqueada] })

    const r = await j.runNow()

    expect(cerrar).not.toHaveBeenCalled()
    expect(r.blocked).toEqual([bloqueada])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no se pudieron cerrar solas'),
      expect.objectContaining({ bloqueadas: [bloqueada] }),
    )
  })

  it('🔴 el aviso se limita en el tiempo: una pareja atorada un día no puede escribir un renglón por minuto', async () => {
    const { j } = job({ bloqueadas: [bloqueada] })

    await j.runNow()
    await j.runNow()

    expect((logger.warn as jest.Mock).mock.calls.filter(c => String(c[0]).includes('no se pudieron cerrar solas'))).toHaveLength(1)
  })
})
