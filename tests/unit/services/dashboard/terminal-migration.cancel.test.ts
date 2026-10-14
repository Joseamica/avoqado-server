import { migrateCancel } from '@/services/dashboard/terminal-migration.service'
import prisma from '@/utils/prismaClient'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { BadRequestError, ForbiddenError } from '@/errors/AppError'

// migrateCancel reverts the terminal DIRECTLY via prisma (bypassing updateTerminal
// so the "blindar" auto-wipe does NOT re-queue a FACTORY_RESET on the revert).
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    // G4: `lockTerminalRow` lee el negocio de la terminal bajo su candado, y la orden se relee ya bloqueada.
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'term-1', venueId: 'venue-new' }]),
    tpvCommandQueue: { findFirst: jest.fn(), findUnique: jest.fn().mockResolvedValue({ expiresAt: null }) },
    terminal: { update: jest.fn(), findUnique: jest.fn() },
    venue: { findFirst: jest.fn() },
    venuePaymentConfig: { deleteMany: jest.fn() },
  },
}))
jest.mock('@/services/tpv/command-queue.service', () => ({
  tpvCommandQueueService: { cancelCommand: jest.fn() },
}))
// logAction is best-effort; stub it so the test doesn't depend on prisma.activityLog.
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

const m = prisma as unknown as {
  $transaction: jest.Mock
  $queryRaw: jest.Mock
  tpvCommandQueue: { findFirst: jest.Mock; findUnique: jest.Mock }
  terminal: { update: jest.Mock; findUnique: jest.Mock }
  venue: { findFirst: jest.Mock }
  venuePaymentConfig: { deleteMany: jest.Mock }
}
const mockedCancelCommand = tpvCommandQueueService.cancelCommand as jest.Mock

describe('migrateCancel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    m.$transaction.mockImplementation(async callback => callback(m))
    m.terminal.update.mockResolvedValue({ id: 'term-1', venueId: 'venue-old' })
    mockedCancelCommand.mockResolvedValue(undefined)
  })

  // ---- NEW FEATURE ----
  it('cancels a QUEUED wipe and reverts the terminal venue + merchants to the payload values', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      commandType: 'FACTORY_RESET',
      status: 'QUEUED',
      payload: { migration: { fromVenueId: 'venue-old', previousMerchantIds: ['ma-1', 'ma-2'], toVenueId: 'venue-new' } },
    })

    const r = await migrateCancel('term-1', { staffId: 'admin-1' })

    // only PENDING/QUEUED + not-expired wipes are cancellable
    expect(m.tpvCommandQueue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          terminalId: 'term-1',
          commandType: 'FACTORY_RESET',
          OR: expect.arrayContaining([
            { status: { in: ['PENDING', 'QUEUED'] } },
            { status: { in: ['SENT', 'RECEIVED'] }, payload: { path: ['_deliveryProtocol'], equals: 2 } },
          ]),
        }),
      }),
    )
    // queued wipe cancelled so it never reaches the device
    expect(mockedCancelCommand).toHaveBeenCalledWith('cmd-1', 'admin-1', expect.stringContaining('cancelada'), m)
    // terminal reverted directly (bypassing updateTerminal → blindar does NOT re-wipe)
    expect(m.terminal.update).toHaveBeenCalledWith({
      where: { id: 'term-1' },
      data: { venueId: 'venue-old', assignedMerchantIds: ['ma-1', 'ma-2'] },
    })
    expect(r).toEqual({ cancelled: true, restoredVenueId: 'venue-old' })
  })

  it('refuses an org-scoped cancel when the migration origin belongs to another organization', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-cross-org',
      terminalId: 'term-1',
      commandType: 'FACTORY_RESET',
      status: 'QUEUED',
      payload: { migration: { fromVenueId: 'venue-foreign', previousMerchantIds: ['ma-foreign'] } },
    })
    m.venue.findFirst.mockResolvedValue(null)

    await expect(migrateCancel('term-1', { staffId: 'owner-1' }, 'org-1')).rejects.toBeInstanceOf(ForbiddenError)

    expect(m.venue.findFirst).toHaveBeenCalledWith({
      where: { id: 'venue-foreign', organizationId: 'org-1' },
      select: { id: true },
    })
    expect(mockedCancelCommand).not.toHaveBeenCalled()
    expect(m.terminal.update).not.toHaveBeenCalled()
  })

  it('reverts to an empty merchant list when previousMerchantIds is absent in the payload', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      commandType: 'FACTORY_RESET',
      status: 'PENDING',
      payload: { migration: { fromVenueId: 'venue-old', toVenueId: 'venue-new' } },
    })

    await migrateCancel('term-1', { staffId: 'admin-1' })

    expect(m.terminal.update).toHaveBeenCalledWith({
      where: { id: 'term-1' },
      data: { venueId: 'venue-old', assignedMerchantIds: [] },
    })
  })

  // ---- ERROR / GUARD CASES ----
  it('throws when no cancellable wipe exists (e.g. status already SENT → device may have wiped)', async () => {
    // The query filters status to PENDING/QUEUED, so a SENT command is simply not
    // returned by findFirst → null.
    m.tpvCommandQueue.findFirst.mockResolvedValue(null)

    await expect(migrateCancel('term-1', { staffId: 'admin-1' })).rejects.toThrow(BadRequestError)
    await expect(migrateCancel('term-1', { staffId: 'admin-1' })).rejects.toThrow('cancelable')
    expect(mockedCancelCommand).not.toHaveBeenCalled()
    expect(m.terminal.update).not.toHaveBeenCalled()
  })

  // Asana 1218069201250971 (2026-09-01): a MANUAL wipe (queued from the superadmin, no
  // `migration` payload) also blocks the wizard. Before, this path threw "cannot revert"
  // and left the operator with no way out. There is nothing to revert — the terminal never
  // moved — so cancelling is just dropping the queued command.
  it('cancels a MANUAL wipe (no migration payload) by dropping the command, without touching the venue', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      commandType: 'FACTORY_RESET',
      status: 'QUEUED',
      payload: {}, // no .migration
    })
    m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-current' })

    const r = await migrateCancel('term-1', { staffId: 'admin-1' })

    expect(mockedCancelCommand).toHaveBeenCalledWith('cmd-1', 'admin-1', expect.any(String), m)
    // nothing to revert: the terminal stays exactly where it is
    expect(m.terminal.update).not.toHaveBeenCalled()
    expect(r).toEqual({ cancelled: true, restoredVenueId: 'venue-current' })
  })
})

describe('migrateCancel — config de pagos creada por la migración', () => {
  const actor = { staffId: 'admin-1' }

  beforeEach(() => {
    jest.clearAllMocks()
    m.$transaction.mockImplementation(async callback => callback(m))
    m.terminal.update.mockResolvedValue({ id: 'term-1', venueId: 'venue-old' })
    mockedCancelCommand.mockResolvedValue(undefined)
  })

  it('I5: borra la VenuePaymentConfig que creó la migración', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      payload: {
        migration: {
          fromVenueId: 'venue-old',
          toVenueId: 'venue-new',
          previousMerchantIds: ['merch-p'],
          createdVenuePaymentConfigId: 'vpc-nueva',
        },
      },
    })
    await migrateCancel('term-1', actor)
    expect(m.venuePaymentConfig.deleteMany).toHaveBeenCalledWith({ where: { id: 'vpc-nueva' } })
  })

  it('I1+I5: NO borra nada si la migración no creó config', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      payload: { migration: { fromVenueId: 'venue-old', toVenueId: 'venue-new', previousMerchantIds: ['merch-p'] } },
    })
    await migrateCancel('term-1', actor)
    expect(m.venuePaymentConfig.deleteMany).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: sigue revirtiendo venue y merchants del origen', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      payload: { migration: { fromVenueId: 'venue-old', toVenueId: 'venue-new', previousMerchantIds: ['merch-p'] } },
    })
    const r = await migrateCancel('term-1', actor)
    expect(r).toEqual({ cancelled: true, restoredVenueId: 'venue-old' })
    expect(m.terminal.update).toHaveBeenCalledWith({
      where: { id: 'term-1' },
      data: { venueId: 'venue-old', assignedMerchantIds: ['merch-p'] },
    })
  })
})

// The wipe cancellation and venue restoration must commit together.
it('P1 cancelling a migration restores the venue inside the same transaction as the queue change', async () => {
  m.$transaction.mockImplementation(async callback => callback(m))
  m.tpvCommandQueue.findFirst.mockResolvedValue({ id: 'cmd-tx', payload: { migration: { fromVenueId: 'old', toVenueId: 'venue-new' } } })
  m.terminal.update.mockRejectedValueOnce(new Error('restore failed'))
  await expect(migrateCancel('term-1', { staffId: 'admin-1' })).rejects.toThrow('restore failed')
  expect(m.$transaction).toHaveBeenCalledTimes(1)
  expect(mockedCancelCommand).toHaveBeenCalledWith('cmd-tx', 'admin-1', expect.any(String), m)
})

// 🔴 G4 (auditoría de Codex del plan, 14-oct; ronda 2): cancelar deshace la migración sólo si sigue siendo la vigente.
// Con los DOS candados tomados —la orden por el CAS de `cancelCommand` y la terminal por `lockTerminalRow`, cola →
// terminal— un reloj NUEVO decide si la orden había vencido, y el negocio leído bajo el candado decide si la terminal
// sigue donde la dejó esa migración.
describe('migrateCancel — G4: la reversión sigue vigente', () => {
  const T0 = Date.parse('2026-10-14T18:00:00.000Z')
  const actor = { staffId: 'admin-1' }
  const ordenVieja = (migration: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    id: 'cmd-1',
    terminalId: 'term-1',
    commandType: 'FACTORY_RESET',
    status: 'QUEUED',
    expiresAt: new Date(T0 + 1_000),
    payload: { migration },
    ...over,
  })

  beforeEach(() => {
    jest.clearAllMocks()
    // Sólo se finge el reloj: las promesas y los temporizadores siguen siendo los reales.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] })
    jest.setSystemTime(T0)
    m.$transaction.mockImplementation(async callback => callback(m))
    m.$queryRaw.mockResolvedValue([{ id: 'term-1', venueId: 'venue-new' }])
    m.tpvCommandQueue.findUnique.mockResolvedValue({ expiresAt: null })
    m.terminal.update.mockResolvedValue({ id: 'term-1', venueId: 'venue-old' })
    mockedCancelCommand.mockResolvedValue(undefined)
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('5. el reloj de la vigencia se lee DESPUÉS de los dos candados, no en la lectura ni antes del CAS', async () => {
    const orden = ordenVieja({ fromVenueId: 'venue-old', toVenueId: 'venue-new', previousMerchantIds: ['ma-1'] })
    m.tpvCommandQueue.findFirst.mockResolvedValue(orden)
    m.tpvCommandQueue.findUnique.mockResolvedValue({ expiresAt: new Date(T0 + 1_000) }) // la relectura bajo candado
    m.$queryRaw.mockImplementation(async () => {
      jest.setSystemTime(T0 + 5_000) // el candado de la terminal tardó: la orden venció mientras se esperaba
      return [{ id: 'term-1', venueId: 'venue-new' }]
    })

    await expect(migrateCancel('term-1', actor)).rejects.toMatchObject({ statusCode: 409, code: 'MIGRATION_NOT_CURRENT' })
    expect(m.terminal.update).not.toHaveBeenCalled()

    // Control: el MISMO caso con el candado rápido (el reloj sigue antes del vencimiento) sí cancela y revierte. El único
    // reloj que ve el vencimiento es el que se lee después de `lockTerminalRow`.
    jest.clearAllMocks()
    jest.setSystemTime(T0)
    m.tpvCommandQueue.findFirst.mockResolvedValue(orden)
    m.tpvCommandQueue.findUnique.mockResolvedValue({ expiresAt: new Date(T0 + 1_000) })
    m.$queryRaw.mockImplementation(async () => {
      jest.setSystemTime(T0 + 500)
      return [{ id: 'term-1', venueId: 'venue-new' }]
    })

    await expect(migrateCancel('term-1', actor)).resolves.toEqual({ cancelled: true, restoredVenueId: 'venue-old' })
    expect(m.terminal.update).toHaveBeenCalledWith({
      where: { id: 'term-1' },
      data: { venueId: 'venue-old', assignedMerchantIds: ['ma-1'] },
    })
  })

  it('6. 🔴 A→B→A con comercios distintos: los comercios nuevos sobreviven', async () => {
    // La orden vieja (A→B) venció; una migración nueva B→A, válida, ya regresó la terminal a A con ['m-nuevo']. (a) pasa
    // —A es el origen de la vieja—, así que sólo el reloj posterior a los candados la detiene.
    m.tpvCommandQueue.findFirst.mockResolvedValue(
      ordenVieja({
        fromVenueId: 'venue-a',
        toVenueId: 'venue-b',
        previousMerchantIds: ['m-viejo'],
        createdVenuePaymentConfigId: 'vpc-de-b',
      }),
    )
    m.tpvCommandQueue.findUnique.mockResolvedValue({ expiresAt: new Date(T0 + 1_000) })
    m.$queryRaw.mockImplementation(async () => {
      jest.setSystemTime(T0 + 5_000)
      return [{ id: 'term-1', venueId: 'venue-a' }]
    })

    await expect(migrateCancel('term-1', actor)).rejects.toMatchObject({ statusCode: 409, code: 'MIGRATION_NOT_CURRENT' })

    // Nunca se escribe `assignedMerchantIds: ['m-viejo']` encima de los comercios de la migración nueva.
    expect(m.terminal.update).not.toHaveBeenCalled()
    expect(m.venuePaymentConfig.deleteMany).not.toHaveBeenCalled()
  })

  it('7. cola → terminal: el CAS de la orden, luego el candado de la terminal, luego la relectura de la orden', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue(ordenVieja({ fromVenueId: 'venue-old', toVenueId: 'venue-new' }))

    await migrateCancel('term-1', actor)

    const cas = mockedCancelCommand.mock.invocationCallOrder[0]
    const candado = m.$queryRaw.mock.invocationCallOrder[0]
    const relectura = m.tpvCommandQueue.findUnique.mock.invocationCallOrder[0]
    expect(cas).toBeLessThan(candado)
    expect(candado).toBeLessThan(relectura)
  })

  it('8. B→C mientras cancelaba: 409, y la terminal no se toca', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue(
      ordenVieja({ fromVenueId: 'venue-old', toVenueId: 'venue-new' }, { expiresAt: new Date(T0 + 60 * 60 * 1000) }),
    )
    m.tpvCommandQueue.findUnique.mockResolvedValue({ expiresAt: new Date(T0 + 60 * 60 * 1000) })
    m.$queryRaw.mockResolvedValue([{ id: 'term-1', venueId: 'venue-c' }])

    await expect(migrateCancel('term-1', actor)).rejects.toMatchObject({ statusCode: 409, code: 'MIGRATION_NOT_CURRENT' })
    expect(m.terminal.update).not.toHaveBeenCalled()
  })

  it('9. control: protocolo 2 todavía en el origen se cancela y escribe el origen', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue(
      ordenVieja(
        { fromVenueId: 'venue-old', toVenueId: 'venue-new' },
        {
          status: 'SENT',
          expiresAt: null,
          payload: { _deliveryProtocol: 2, migration: { fromVenueId: 'venue-old', toVenueId: 'venue-new' } },
        },
      ),
    )
    m.tpvCommandQueue.findUnique.mockResolvedValue({ expiresAt: null })
    m.$queryRaw.mockResolvedValue([{ id: 'term-1', venueId: 'venue-old' }])

    await expect(migrateCancel('term-1', actor)).resolves.toEqual({ cancelled: true, restoredVenueId: 'venue-old' })
    expect(m.terminal.update).toHaveBeenCalledWith({
      where: { id: 'term-1' },
      data: { venueId: 'venue-old', assignedMerchantIds: [] },
    })
  })
})
