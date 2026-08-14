/**
 * Tests: inventory-posting-sweeper — el job de respaldo del outbox de
 * deducciones. Sin él, un posting que un crash dejó PENDING/APPLYING jamás se
 * reintenta y la venta pagada nunca deduce stock.
 */

import { prismaMock } from '../../__helpers__/setup'
import { InventoryPostingSweeperJob } from '../../../src/jobs/inventory-posting-sweeper.job'

const noopCron = { start: jest.fn(), stop: jest.fn() }

const makeJob = (overrides: Record<string, unknown> = {}) =>
  new InventoryPostingSweeperJob({
    cron: noopCron as any,
    prisma: prismaMock as any,
    retryEntry: ((fn: () => Promise<unknown>) => fn()) as any,
    apply: jest.fn() as any,
    ...overrides,
  })

describe('InventoryPostingSweeperJob.runNow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('barre PENDING/PARTIAL_FAILED rezagados Y APPLYING huérfanos, aplicando cada uno', async () => {
    const apply = jest
      .fn()
      .mockResolvedValueOnce({ postingId: 'post-1', applied: true, issues: [] })
      .mockResolvedValueOnce({ postingId: 'post-2', applied: false, issues: [{ reason: 'x' }] })
    prismaMock.inventoryPosting.findMany.mockResolvedValue([
      { id: 'post-1', venueId: 'v1', status: 'PENDING', attempts: 1 },
      { id: 'post-2', venueId: 'v1', status: 'APPLYING', attempts: 3 },
    ] as any)

    const job = makeJob({ apply })
    const result = await job.runNow()

    expect(result).toEqual({ scanned: 2, applied: 1, partial: 1, skipped: 0, errors: 0 })
    expect(apply).toHaveBeenCalledWith('post-1', null)
    expect(apply).toHaveBeenCalledWith('post-2', null)

    // El WHERE cubre los DOS caminos de recuperación y respeta el tope de intentos.
    const where = (prismaMock.inventoryPosting.findMany.mock.calls[0][0] as any).where
    expect(where.attempts.lt).toBe(15)
    const statuses = where.OR.map((c: any) => c.status)
    expect(statuses).toContainEqual({ in: ['PENDING', 'PARTIAL_FAILED'] })
    expect(statuses).toContain('APPLYING')
  })

  it('un claim perdido (apply devuelve null) cuenta como skipped, no como error', async () => {
    const apply = jest.fn().mockResolvedValue(null)
    prismaMock.inventoryPosting.findMany.mockResolvedValue([{ id: 'post-1', venueId: 'v1', status: 'PENDING', attempts: 0 }] as any)

    const result = await makeJob({ apply }).runNow()

    expect(result).toEqual({ scanned: 1, applied: 0, partial: 0, skipped: 1, errors: 0 })
  })

  it('un candidato que lanza no tumba el barrido de los demás', async () => {
    const apply = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ postingId: 'post-2', applied: true, issues: [] })
    prismaMock.inventoryPosting.findMany.mockResolvedValue([
      { id: 'post-1', venueId: 'v1', status: 'PENDING', attempts: 0 },
      { id: 'post-2', venueId: 'v2', status: 'PARTIAL_FAILED', attempts: 2 },
    ] as any)

    const result = await makeJob({ apply }).runNow()

    expect(result).toEqual({ scanned: 2, applied: 1, partial: 0, skipped: 0, errors: 1 })
  })

  it('no se encima consigo mismo (running guard)', async () => {
    const apply = jest.fn().mockResolvedValue({ postingId: 'post-1', applied: true, issues: [] })
    let release: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    prismaMock.inventoryPosting.findMany.mockImplementation(async () => {
      await gate
      return []
    })

    const job = makeJob({ apply })
    const first = job.runNow()
    const second = await job.runNow()
    expect(second.skipped).toBe(1)
    release!()
    await first
  })
})
