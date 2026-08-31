import { ActivityActorType, TerminalStatus, TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'

import {
  POS_REMEDIATION_BATCH_SIZE,
  POS_REMEDIATION_MAX_PRINTED_IDS,
  POS_REMEDIATION_SELECTOR,
  parseRemediationArgs,
  runPosTerminalStatusRemediation,
} from '../../../scripts/remediate-pos-terminal-status'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findMany: jest.fn() },
    $transaction: jest.fn(),
    $disconnect: jest.fn(),
  },
}))

type Candidate = { id: string; venueId: string | null }

function createDb(options?: { candidates?: Candidate[]; updateCount?: number; onUpdate?: (id: string) => void; auditError?: Error }) {
  const candidates = options?.candidates ?? []
  const findMany = jest.fn(async () => candidates)
  const updateMany = jest.fn(async (args: any) => {
    if ((options?.updateCount ?? 1) === 1) options?.onUpdate?.(args.where.id)
    return { count: options?.updateCount ?? 1 }
  })
  const createActivityLog = jest.fn(async () => {
    if (options?.auditError) throw options.auditError
    return { id: 'audit-1' }
  })
  const transaction = jest.fn(async (callback: any) =>
    callback({
      terminal: { updateMany },
      activityLog: { create: createActivityLog },
    }),
  )

  return {
    db: { terminal: { findMany }, $transaction: transaction },
    findMany,
    updateMany,
    createActivityLog,
    transaction,
  }
}

describe('POS terminal status remediation selector', () => {
  it('selects only self-registered, unactivated, inactive POS roles', () => {
    expect(POS_REMEDIATION_SELECTOR).toEqual({
      selfRegistered: true,
      type: { in: [TerminalType.POS_ANDROID, TerminalType.POS_IOS, TerminalType.POS_DESKTOP] },
      activatedAt: null,
      status: TerminalStatus.INACTIVE,
    })
  })

  it('queries deterministic bounded batches with only the fields needed to update and audit', async () => {
    const fake = createDb()

    await runPosTerminalStatusRemediation({ db: fake.db as any, log: jest.fn() })

    expect(fake.findMany).toHaveBeenCalledWith({
      where: POS_REMEDIATION_SELECTOR,
      select: { id: true, venueId: true },
      orderBy: { id: 'asc' },
      take: POS_REMEDIATION_BATCH_SIZE,
    })
    expect(POS_REMEDIATION_BATCH_SIZE).toBeGreaterThan(0)
    expect(POS_REMEDIATION_BATCH_SIZE).toBeLessThanOrEqual(200)
  })

  it('uses an id cursor to advance across more than one bounded batch', async () => {
    const firstBatch = Array.from({ length: POS_REMEDIATION_BATCH_SIZE }, (_, index) => ({
      id: `pos-${String(index + 1).padStart(3, '0')}`,
      venueId: 'venue-1',
    }))
    const last = { id: 'pos-last', venueId: 'venue-1' }
    const findMany = jest.fn().mockResolvedValueOnce(firstBatch).mockResolvedValueOnce([last])
    const db = { terminal: { findMany }, $transaction: jest.fn() }

    const result = await runPosTerminalStatusRemediation({ db: db as any, log: jest.fn() })

    expect(result.selected).toBe(POS_REMEDIATION_BATCH_SIZE + 1)
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: POS_REMEDIATION_SELECTOR,
      select: { id: true, venueId: true },
      orderBy: { id: 'asc' },
      take: POS_REMEDIATION_BATCH_SIZE,
      cursor: { id: firstBatch[firstBatch.length - 1].id },
      skip: 1,
    })
  })
})

describe('runPosTerminalStatusRemediation — dry run', () => {
  it('is the default and performs zero writes and zero ActivityLog rows', async () => {
    const fake = createDb({ candidates: [{ id: 'pos-1', venueId: 'venue-1' }] })
    const log = jest.fn()

    const result = await runPosTerminalStatusRemediation({ db: fake.db as any, log })

    expect(result).toEqual({ selected: 1, updated: 0, skipped: 1 })
    expect(fake.transaction).not.toHaveBeenCalled()
    expect(fake.updateMany).not.toHaveBeenCalled()
    expect(fake.createActivityLog).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join('\n')).toContain('DRY-RUN')
  })

  it('prints the selected count but bounds the list of non-PII ids', async () => {
    const candidates = Array.from({ length: POS_REMEDIATION_MAX_PRINTED_IDS + 3 }, (_, index) => ({
      id: `pos-${String(index + 1).padStart(2, '0')}`,
      venueId: `venue-${index + 1}`,
    }))
    const fake = createDb({ candidates })
    const log = jest.fn()

    await runPosTerminalStatusRemediation({ db: fake.db as any, log })

    const output = log.mock.calls.flat().join('\n')
    expect(output).toContain(`Seleccionadas: ${candidates.length}`)
    expect(output).toContain(candidates[POS_REMEDIATION_MAX_PRINTED_IDS - 1].id)
    expect(output).not.toContain(candidates[POS_REMEDIATION_MAX_PRINTED_IDS].id)
    expect(output).not.toContain('venue-')
  })
})

describe('runPosTerminalStatusRemediation — apply implementation', () => {
  it('revalidates the exact selector plus id and writes the audit atomically', async () => {
    const fake = createDb({ candidates: [{ id: 'pos-1', venueId: 'venue-1' }] })

    const result = await runPosTerminalStatusRemediation({ db: fake.db as any, apply: true, log: jest.fn() })

    expect(result).toEqual({ selected: 1, updated: 1, skipped: 0 })
    expect(fake.transaction).toHaveBeenCalledTimes(1)
    expect(fake.updateMany).toHaveBeenCalledWith({
      where: { ...POS_REMEDIATION_SELECTOR, id: 'pos-1', venueId: 'venue-1' },
      data: { status: TerminalStatus.ACTIVE },
    })
    expect(fake.createActivityLog).toHaveBeenCalledWith({
      data: {
        action: 'POS_TERMINAL_STATUS_REMEDIATED',
        entity: 'Terminal',
        entityId: 'pos-1',
        venueId: 'venue-1',
        actorType: ActivityActorType.SERVICE,
        servicePrincipalId: 'POS_TERMINAL_STATUS_REMEDIATION',
        data: {
          oldStatus: TerminalStatus.INACTIVE,
          newStatus: TerminalStatus.ACTIVE,
          reason: expect.any(String),
        },
      },
    })
  })

  it('skips a row that no longer matches during transactional revalidation and emits no audit', async () => {
    const fake = createDb({
      candidates: [{ id: 'pos-raced', venueId: 'venue-1' }],
      updateCount: 0,
    })

    const result = await runPosTerminalStatusRemediation({ db: fake.db as any, apply: true, log: jest.fn() })

    expect(result).toEqual({ selected: 1, updated: 0, skipped: 1 })
    expect(fake.createActivityLog).not.toHaveBeenCalled()
  })

  it('skips a row moved to another venue after selection and never writes a stale-venue audit', async () => {
    const selectedCandidate = { id: 'pos-moved', venueId: 'venue-a' }
    const currentVenueId = 'venue-b'
    const updateMany = jest.fn(async (args: any) => ({
      count: args.where.venueId === undefined || args.where.venueId === currentVenueId ? 1 : 0,
    }))
    const createActivityLog = jest.fn(async () => ({ id: 'audit-1' }))
    const transaction = jest.fn(async (callback: any) => callback({ terminal: { updateMany }, activityLog: { create: createActivityLog } }))
    const db = {
      terminal: { findMany: jest.fn(async () => [selectedCandidate]) },
      $transaction: transaction,
    }

    const result = await runPosTerminalStatusRemediation({ db: db as any, apply: true, log: jest.fn() })

    expect(result).toEqual({ selected: 1, updated: 0, skipped: 1 })
    expect(updateMany).toHaveBeenCalledWith({
      where: { ...POS_REMEDIATION_SELECTOR, id: 'pos-moved', venueId: 'venue-a' },
      data: { status: TerminalStatus.ACTIVE },
    })
    expect(createActivityLog).not.toHaveBeenCalled()
  })

  it('keeps status update and ActivityLog in the same failing transaction', async () => {
    const fake = createDb({
      candidates: [{ id: 'pos-1', venueId: 'venue-1' }],
      auditError: new Error('audit unavailable'),
    })

    await expect(runPosTerminalStatusRemediation({ db: fake.db as any, apply: true, log: jest.fn() })).rejects.toThrow('audit unavailable')
    expect(fake.transaction).toHaveBeenCalledTimes(1)
    expect(fake.updateMany).toHaveBeenCalledTimes(1)
    expect(fake.createActivityLog).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a second apply selects and updates zero rows', async () => {
    let status: TerminalStatus = TerminalStatus.INACTIVE
    const findMany = jest.fn(async () => (status === TerminalStatus.INACTIVE ? [{ id: 'pos-1', venueId: 'venue-1' }] : []))
    const updateMany = jest.fn(async () => {
      if (status !== TerminalStatus.INACTIVE) return { count: 0 }
      status = TerminalStatus.ACTIVE
      return { count: 1 }
    })
    const createActivityLog = jest.fn(async () => ({ id: 'audit-1' }))
    const db = {
      terminal: { findMany },
      $transaction: async (callback: any) => callback({ terminal: { updateMany }, activityLog: { create: createActivityLog } }),
    }

    const first = await runPosTerminalStatusRemediation({ db: db as any, apply: true, log: jest.fn() })
    const second = await runPosTerminalStatusRemediation({ db: db as any, apply: true, log: jest.fn() })

    expect(first).toEqual({ selected: 1, updated: 1, skipped: 0 })
    expect(second).toEqual({ selected: 0, updated: 0, skipped: 0 })
    expect(createActivityLog).toHaveBeenCalledTimes(1)
  })
})

describe('remediation CLI safety', () => {
  it('accepts no arguments as dry-run and --apply as the only write switch', () => {
    expect(parseRemediationArgs([])).toEqual({ apply: false })
    expect(parseRemediationArgs(['--apply'])).toEqual({ apply: true })
  })

  it('rejects unknown flags and positional arguments', () => {
    expect(() => parseRemediationArgs(['--force'])).toThrow('Bandera o argumento no reconocido')
    expect(() => parseRemediationArgs(['apply'])).toThrow('Bandera o argumento no reconocido')
  })

  it('never echoes a rejected argument that may contain credentials or a URL', () => {
    const secretArgument = 'postgresql://operator:SUPER_SECRET@example.internal/avoqado'

    let message = ''
    try {
      parseRemediationArgs([secretArgument])
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('La única bandera válida es --apply')
    expect(message).not.toContain(secretArgument)
    expect(message).not.toContain('SUPER_SECRET')
    expect(message).not.toContain('example.internal')
  })

  it('does not query, write, log or disconnect merely by being imported', () => {
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      jest.isolateModules(() => {
        require('../../../scripts/remediate-pos-terminal-status')
      })

      expect(consoleLog).not.toHaveBeenCalled()
      expect(consoleError).not.toHaveBeenCalled()
      expect(prisma.terminal.findMany).not.toHaveBeenCalled()
      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(prisma.$disconnect).not.toHaveBeenCalled()
    } finally {
      consoleLog.mockRestore()
      consoleError.mockRestore()
    }
  })
})
