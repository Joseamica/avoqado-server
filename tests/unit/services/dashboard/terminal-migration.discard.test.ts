/**
 * migrateDiscard — the "way out" of a MIGRATION_IN_PROGRESS the operator cannot cancel.
 *
 * Founder decision (2026-09-01, Asana 1218069201250971): an org OWNER may discard a pending
 * FACTORY_RESET the device has NOT executed, but only after the device has been silent for
 * 24 h since the wipe was queued. Rationale: a wipe still PENDING/QUEUED is cancellable (the
 * safer path, forced here); one the device received minutes ago is probably executing; one
 * the device has ignored for a day is not going to execute on its own, and leaving it blocks
 * every future migration of that terminal (the 7-day TTL case) or blocks it forever (the
 * hand-inserted rows with no expiresAt that started this).
 */
import { migrateDiscard, DISCARD_AFTER_MS } from '@/services/dashboard/terminal-migration.service'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    terminal: { findUnique: jest.fn(), update: jest.fn() },
    venue: { findUnique: jest.fn() },
    tpvCommandQueue: { findMany: jest.fn(), updateMany: jest.fn() },
    venuePaymentConfig: { deleteMany: jest.fn() },
  }
  // Interactive transaction: the callback receives the same mocked client, so the
  // assertions below see every write the transaction performs.
  client.$transaction = jest.fn((fn: any) => fn(client))
  return { __esModule: true, default: client }
})
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

const m = prisma as unknown as {
  terminal: { findUnique: jest.Mock; update: jest.Mock }
  venue: { findUnique: jest.Mock }
  tpvCommandQueue: { findMany: jest.Mock; updateMany: jest.Mock }
  venuePaymentConfig: { deleteMany: jest.Mock }
  $transaction: jest.Mock
}
const mockedLogAction = logAction as jest.Mock

const HOUR = 60 * 60 * 1000
const actor = { staffId: 'owner-1', ipAddress: '1.2.3.4' }
const terminal = (lastActivationStatusCheckAt: Date | null = null) => ({
  id: 'term-1',
  venueId: 'venue-a',
  lastActivationStatusCheckAt,
})
const wipe = (over: Partial<{ id: string; createdAt: Date; status: string; payload: unknown }>) => ({
  id: 'cmd-1',
  createdAt: new Date(Date.now() - 30 * HOUR),
  status: 'SENT',
  payload: null,
  venueId: 'venue-a',
  ...over,
})
/** Wipe queued BY a migration: carries the origin venue + the merchants it displaced. */
const migrationWipe = (over: Partial<{ id: string; createdAt: Date; status: string }> = {}) =>
  wipe({
    payload: {
      migration: {
        fromVenueId: 'venue-origen',
        toVenueId: 'venue-a',
        previousMerchantIds: ['ma-1'],
        createdVenuePaymentConfigId: 'vpc-nueva',
      },
    },
    ...over,
  })

describe('migrateDiscard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    m.terminal.findUnique.mockResolvedValue(terminal())
    m.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    m.tpvCommandQueue.updateMany.mockResolvedValue({ count: 1 })
    m.$transaction.mockImplementation((fn: any) => fn(prisma))
  })

  it('the threshold is 24 hours (founder decision, not a tunable)', () => {
    expect(DISCARD_AFTER_MS).toBe(24 * HOUR)
  })

  // ---- NEW FEATURE ----
  it('expires a SENT wipe the device has ignored for more than 24 h, and audits it', async () => {
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ id: 'cmd-1' })])

    const r = await migrateDiscard('term-1', actor)

    expect(m.tpvCommandQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'cmd-1' }),
        data: expect.objectContaining({ status: 'EXPIRED' }),
      }),
    )
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TERMINAL_PENDING_WIPE_DISCARDED',
        entity: 'Terminal',
        entityId: 'term-1',
        venueId: 'venue-a',
        staffId: 'owner-1',
        data: expect.objectContaining({ commandIds: ['cmd-1'] }),
      }),
    )
    expect(r).toEqual({ discarded: 1, commandIds: ['cmd-1'], restoredVenueId: 'venue-a' })
  })

  it('only touches the wipes that are still pending — never a blanket update on the terminal', async () => {
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ id: 'a' }), wipe({ id: 'b', createdAt: new Date(Date.now() - 50 * HOUR) })])

    await migrateDiscard('term-1', actor)

    // Una por id: `updateMany` no dice CUÁLES filas tocó, y el reporte no puede
    // afirmar que descartó una fila que otro proceso ya había movido (P3 de Codex).
    expect(m.tpvCommandQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'a', status: expect.anything() }) }),
    )
    expect(m.tpvCommandQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'b', status: expect.anything() }) }),
    )
  })

  // P3 #1 de Codex: `updateMany` puede tocar MENOS filas de las pedidas (el barrendero o
  // el propio aparato movieron una entre la lectura y la escritura). Reportar y auditar
  // ids que no se movieron es una afirmación falsa.
  it('reporta y audita SÓLO los comandos que realmente quedaron expirados', async () => {
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ id: 'a' }), wipe({ id: 'b', createdAt: new Date(Date.now() - 50 * HOUR) })])
    m.tpvCommandQueue.updateMany.mockImplementation(({ where }: any) => Promise.resolve({ count: where.id === 'a' ? 1 : 0 }))

    const r = await migrateDiscard('term-1', actor)

    expect(r).toEqual({ discarded: 1, commandIds: ['a'], restoredVenueId: 'venue-a' })
    expect(mockedLogAction).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ commandIds: ['a'] }) }))
  })

  // ---- P1 de Codex: el borrado de una MIGRACIÓN no puede dejar la terminal a medias ----
  //
  // Un FACTORY_RESET es el ÚNICO camino que resincroniza las credenciales del comercio en
  // el aparato (viven en memoria; ver terminals.superadmin.service.ts). Descartarlo dejando
  // la terminal ya re-parentada al destino abre la misma ventana de "cobra con el comercio
  // viejo y el servidor lo apunta al nuevo" que la migración existe para evitar — sólo que
  // a las 24 h en vez de a los 7 días. Como la terminal PROBADAMENTE no rebotó, el borrado
  // nunca se ejecutó: devolverla a su sucursal de origen la deja consistente otra vez.
  describe('borrado que dejó una MIGRACIÓN', () => {
    it('devuelve la terminal a su sucursal de origen con sus comercios', async () => {
      m.tpvCommandQueue.findMany.mockResolvedValue([migrationWipe()])

      const r = await migrateDiscard('term-1', actor)

      expect(m.terminal.update).toHaveBeenCalledWith({
        where: { id: 'term-1' },
        data: { venueId: 'venue-origen', assignedMerchantIds: ['ma-1'] },
      })
      expect(r.restoredVenueId).toBe('venue-origen')
    })

    it('borra la config de cobro que ESA migración creó en el destino', async () => {
      m.tpvCommandQueue.findMany.mockResolvedValue([migrationWipe()])

      await migrateDiscard('term-1', actor)

      expect(m.venuePaymentConfig.deleteMany).toHaveBeenCalledWith({ where: { id: 'vpc-nueva' } })
    })

    it('un borrado MANUAL no mueve la terminal: no hay nada que revertir', async () => {
      m.tpvCommandQueue.findMany.mockResolvedValue([wipe({})])

      const r = await migrateDiscard('term-1', actor)

      expect(m.terminal.update).not.toHaveBeenCalled()
      expect(m.venuePaymentConfig.deleteMany).not.toHaveBeenCalled()
      expect(r.restoredVenueId).toBe('venue-a')
    })

    it('todo ocurre en UNA transacción: expirar y revertir no pueden quedar a medias', async () => {
      m.tpvCommandQueue.findMany.mockResolvedValue([migrationWipe()])

      await migrateDiscard('term-1', actor)

      expect(m.$transaction).toHaveBeenCalledTimes(1)
    })
  })

  // P2 #2 de Codex: entre leer la elegibilidad y escribir, el aparato puede rebotar
  // (ejecutó el borrado). Expirar entonces marcaría como descartado algo que SÍ ocurrió,
  // y —peor— revertiría el venue de una migración que ya se completó.
  it('aborta si el aparato rebotó entre la lectura y la escritura', async () => {
    m.tpvCommandQueue.findMany.mockResolvedValue([migrationWipe()])
    m.terminal.findUnique
      .mockResolvedValueOnce(terminal(null)) // lectura inicial: no rebotó
      .mockResolvedValueOnce(terminal(new Date())) // dentro de la transacción: YA rebotó

    await expect(migrateDiscard('term-1', actor)).rejects.toBeInstanceOf(ConflictError)

    expect(m.tpvCommandQueue.updateMany).not.toHaveBeenCalled()
    expect(m.terminal.update).not.toHaveBeenCalled()
  })

  // ---- GUARDS ----
  it('throws when nothing is pending', async () => {
    m.tpvCommandQueue.findMany.mockResolvedValue([])
    await expect(migrateDiscard('term-1', actor)).rejects.toThrow(BadRequestError)
    expect(m.tpvCommandQueue.updateMany).not.toHaveBeenCalled()
  })

  it('a wipe the device already rebound after is NOT pending (same proof-of-wipe rule as preflight)', async () => {
    m.terminal.findUnique.mockResolvedValue(terminal(new Date(Date.now() - 1 * HOUR)))
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ createdAt: new Date(Date.now() - 48 * HOUR) })])
    await expect(migrateDiscard('term-1', actor)).rejects.toThrow(BadRequestError)
    expect(m.tpvCommandQueue.updateMany).not.toHaveBeenCalled()
  })

  it('refuses while a wipe is still cancellable (PENDING/QUEUED): cancelling is the safer path', async () => {
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ status: 'QUEUED' })])
    await expect(migrateDiscard('term-1', actor)).rejects.toThrow(/canc[eé]lalo/i)
    expect(m.tpvCommandQueue.updateMany).not.toHaveBeenCalled()
  })

  it('refuses while the newest wipe is younger than 24 h — the device may still execute it', async () => {
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ createdAt: new Date(Date.now() - 2 * HOUR) })])
    await expect(migrateDiscard('term-1', actor)).rejects.toThrow(/24/)
    expect(m.tpvCommandQueue.updateMany).not.toHaveBeenCalled()
  })

  // P3 #2 de Codex: el "podrás descartarlo a partir de…" depende de 24 horas EXACTAS, así
  // que una fecha sin hora deja al operador adivinando; y la zona horaria es la del NEGOCIO,
  // no una constante (un venue de Tijuana leía la hora de CDMX).
  it('el mensaje de las 24 h trae la HORA y la zona del negocio', async () => {
    m.venue.findUnique.mockResolvedValue({ timezone: 'America/Tijuana' })
    // 2026-09-01 20:00Z + 24 h = 2026-09-02 20:00Z = 13:00 en Tijuana (UTC-7).
    const queuedAt = new Date('2026-09-01T20:00:00.000Z')
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-02T00:00:00.000Z').getTime())
    m.tpvCommandQueue.findMany.mockResolvedValue([wipe({ createdAt: queuedAt })])

    await expect(migrateDiscard('term-1', actor)).rejects.toThrow(/13:00/)

    jest.spyOn(Date, 'now').mockRestore()
  })

  it('throws NotFoundError for an unknown terminal', async () => {
    m.terminal.findUnique.mockResolvedValue(null)
    await expect(migrateDiscard('nope', actor)).rejects.toThrow(NotFoundError)
  })
})
