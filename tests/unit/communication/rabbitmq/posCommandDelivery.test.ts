jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))

import { CommandListener } from '@/communication/rabbitmq/commandListener'
import { CommandRetryService } from '@/communication/rabbitmq/commandRetryService'
import { publishCommand } from '@/communication/rabbitmq/publisher'
import prisma from '@/utils/prismaClient'

const m = prisma as any
const ESTABLE = {
  tempShiftId: 'SHIFT_estable_1',
  posStaffId: 'SR-7',
  startingCash: 2000,
  stationId: 'CAJA1',
}

const openCommand = (over: Record<string, unknown> = {}) => ({
  id: 'cmd-open-1',
  venueId: 'venue-1',
  entityType: 'Shift',
  entityId: 'shift-1',
  commandType: 'CREATE',
  action: 'OPEN',
  dedupeKey: 'shift-open:shift-1',
  payload: ESTABLE,
  status: 'PENDING',
  attempts: 0,
  lastAttemptAt: null,
  nextAttemptAt: null,
  venue: { id: 'venue-1', posType: 'SOFTRESTAURANT' },
  ...over,
})

async function process(commandId = 'cmd-open-1') {
  const listener = new CommandListener('postgresql://unused')
  await (listener as any).processCommand(commandId)
}

beforeEach(() => {
  m.posCommand.findUnique.mockResolvedValue(openCommand())
  m.posCommand.updateMany.mockResolvedValue({ count: 1 })
  m.posCommand.update.mockResolvedValue(openCommand())
  m.posCommand.findMany.mockResolvedValue([])
  ;(publishCommand as jest.Mock).mockResolvedValue(undefined)
})

describe('entrega durable de PosCommand OPEN', () => {
  it('reclama PENDING con CAS, publica action OPEN y confirma COMPLETED', async () => {
    await process()

    expect(m.posCommand.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: 'cmd-open-1',
          status: 'PENDING',
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: expect.any(Date) } }],
        },
        data: expect.objectContaining({ status: 'PROCESSING' }),
      }),
    )
    expect(publishCommand).toHaveBeenCalledWith('command.softrestaurant.venue-1', {
      entity: 'Shift',
      action: 'OPEN',
      payload: ESTABLE,
    })
    expect(m.posCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cmd-open-1', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'COMPLETED', completedAt: expect.any(Date), errorMessage: null }),
      }),
    )
  })

  it('si otro servidor gana el CAS no duplica la entrega', async () => {
    m.posCommand.updateMany.mockResolvedValueOnce({ count: 0 })

    await process()

    expect(publishCommand).not.toHaveBeenCalled()
  })

  it('Rabbit caido deja el OPEN durable PENDING con backoff sin cambiar payload ni identidad', async () => {
    const attemptedAt = new Date('2026-09-03T10:10:00.000Z')
    ;(publishCommand as jest.Mock).mockRejectedValueOnce(new Error('rabbit caido'))

    const listener = new CommandListener('postgresql://unused')
    await (listener as any).processCommand('cmd-open-1', attemptedAt)

    expect(publishCommand).toHaveBeenCalledWith(
      'command.softrestaurant.venue-1',
      expect.objectContaining({ action: 'OPEN', payload: ESTABLE }),
    )
    expect(m.posCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cmd-open-1', status: 'PROCESSING' },
        data: expect.objectContaining({
          status: 'PENDING',
          attempts: { increment: 1 },
          errorMessage: 'rabbit caido',
          nextAttemptAt: new Date('2026-09-03T10:11:00.000Z'),
        }),
      }),
    )
  })

  it('un comando legacy conserva FAILED y no entra al retry infinito de OPEN', async () => {
    m.posCommand.findUnique.mockResolvedValue(
      openCommand({
        entityType: 'Order',
        entityId: 'order-1',
        commandType: 'UPDATE',
        action: null,
        dedupeKey: null,
        attempts: 4,
      }),
    )
    ;(publishCommand as jest.Mock).mockRejectedValueOnce(new Error('rabbit caido'))

    await process()

    expect(m.posCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cmd-open-1', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'FAILED', attempts: { increment: 1 }, errorMessage: 'rabbit caido' }),
      }),
    )
  })

  it('el backoff exponencial de OPEN queda acotado a quince minutos aun con muchos intentos', async () => {
    const attemptedAt = new Date('2026-09-03T10:10:00.000Z')
    m.posCommand.findUnique.mockResolvedValue(openCommand({ attempts: 9 }))
    ;(publishCommand as jest.Mock).mockRejectedValueOnce(new Error('rabbit sigue caido'))

    const listener = new CommandListener('postgresql://unused')
    await (listener as any).processCommand('cmd-open-1', attemptedAt)

    expect(m.posCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cmd-open-1', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'PENDING', nextAttemptAt: new Date('2026-09-03T10:25:00.000Z') }),
      }),
    )
  })
})

describe('recuperacion acotada del outbox OPEN', () => {
  it('un OPEN PENDING que no entro al batch de arranque se recoge en un barrido recurrente y acotado', async () => {
    const due = openCommand({ status: 'PENDING', nextAttemptAt: new Date('2026-09-03T10:09:00.000Z') })
    m.posCommand.findMany.mockImplementation(({ where }: any) => {
      if (where.status?.in?.includes('PENDING')) return Promise.resolve([due])
      return Promise.resolve([])
    })
    m.posCommand.findUnique.mockResolvedValue(due)

    const service = new CommandRetryService()
    await (service as any).retryFailedCommands(new Date('2026-09-03T10:10:00.000Z'))

    expect(m.posCommand.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['PENDING', 'FAILED'] },
          entityType: 'Shift',
          action: 'OPEN',
          dedupeKey: { not: null },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: expect.any(Date) } }],
        }),
        take: 5,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    )
    expect(publishCommand).toHaveBeenCalledTimes(1)
    expect(m.posCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', nextAttemptAt: null }) }),
    )
  })

  it('un OPEN durable con attempts >= MAX_ATTEMPTS sigue entregandose cuando Rabbit se recupera', async () => {
    const exhausted = openCommand({
      status: 'FAILED',
      attempts: 9,
      nextAttemptAt: new Date('2026-09-03T10:09:00.000Z'),
    })
    m.posCommand.findMany.mockImplementation(({ where }: any) => {
      if (where.status?.in?.includes('PENDING')) return Promise.resolve([exhausted])
      return Promise.resolve([])
    })
    m.posCommand.findUnique.mockResolvedValue(exhausted)

    const service = new CommandRetryService()
    await (service as any).retryFailedCommands(new Date('2026-09-03T10:10:00.000Z'))

    expect(publishCommand).toHaveBeenCalledWith(
      'command.softrestaurant.venue-1',
      expect.objectContaining({ action: 'OPEN', payload: ESTABLE }),
    )
    expect(m.posCommand.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'cmd-open-1',
        status: 'FAILED',
        attempts: 9,
        entityType: 'Shift',
        action: 'OPEN',
        dedupeKey: { not: null },
      },
      data: { status: 'PENDING' },
    })
    expect(m.posCommand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', nextAttemptAt: null }) }),
    )
  })

  it('solo recupera PROCESSING stale de OPEN con dedupe; nunca los comandos historicos', async () => {
    const stale = openCommand({ status: 'PROCESSING', lastAttemptAt: new Date('2026-09-03T10:00:00.000Z') })
    m.posCommand.findMany.mockImplementation(({ where }: any) => {
      if (where.status === 'PROCESSING') return Promise.resolve([stale])
      return Promise.resolve([])
    })

    const service = new CommandRetryService()
    await (service as any).retryFailedCommands(new Date('2026-09-03T10:10:00.000Z'))

    expect(m.posCommand.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PROCESSING',
          entityType: 'Shift',
          action: 'OPEN',
          dedupeKey: { not: null },
          lastAttemptAt: { lt: expect.any(Date) },
        }),
        take: 5,
        orderBy: [{ lastAttemptAt: 'asc' }, { id: 'asc' }],
      }),
    )
    expect(m.posCommand.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'cmd-open-1',
        status: 'PROCESSING',
        lastAttemptAt: stale.lastAttemptAt,
        entityType: 'Shift',
        action: 'OPEN',
        dedupeKey: { not: null },
      },
      data: { status: 'PENDING', nextAttemptAt: null, errorMessage: 'Recovered stale OPEN delivery' },
    })
  })

  it('un FAILED durable vuelve por la ruta OPEN acotada y conserva el id SoftRestaurant en cada entrega', async () => {
    const failed = openCommand({ status: 'FAILED', attempts: 1 })
    m.posCommand.findMany.mockImplementation(({ where }: any) => {
      if (where.status?.in?.includes('FAILED')) return Promise.resolve([failed])
      return Promise.resolve([])
    })

    const service = new CommandRetryService()
    await (service as any).retryFailedCommands(new Date('2026-09-03T10:10:00.000Z'))

    expect(m.posCommand.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'cmd-open-1',
        status: 'FAILED',
        attempts: 1,
        entityType: 'Shift',
        action: 'OPEN',
        dedupeKey: { not: null },
      },
      data: { status: 'PENDING' },
    })

    m.posCommand.findUnique.mockResolvedValue(openCommand())
    await process()
    await process()

    const delivered = (publishCommand as jest.Mock).mock.calls.map(call => call[1].payload.tempShiftId)
    expect(delivered.every(id => id === 'SHIFT_estable_1')).toBe(true)
  })

  it('el barrido legacy conserva MAX_ATTEMPTS y excluye explicitamente los OPEN durables', async () => {
    m.posCommand.findMany.mockResolvedValue([])

    const service = new CommandRetryService()
    await (service as any).retryFailedCommands(new Date('2026-09-03T10:10:00.000Z'))

    expect(m.posCommand.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'FAILED',
          attempts: { lt: 5 },
          NOT: { entityType: 'Shift', action: 'OPEN', dedupeKey: { not: null } },
        },
        take: 5,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    )
    expect(publishCommand).not.toHaveBeenCalled()
  })

  it('dos ticks solapados no abren dos barridos concurrentes', async () => {
    let release!: (rows: unknown[]) => void
    m.posCommand.findMany.mockReturnValueOnce(
      new Promise(resolve => {
        release = resolve
      }),
    )
    const service = new CommandRetryService()

    const first = (service as any).retryFailedCommands(new Date('2026-09-03T10:10:00.000Z'))
    const overlapping = (service as any).retryFailedCommands(new Date('2026-09-03T10:11:00.000Z'))
    await overlapping

    expect(m.posCommand.findMany).toHaveBeenCalledTimes(1)
    release([])
    await first
  })
})
