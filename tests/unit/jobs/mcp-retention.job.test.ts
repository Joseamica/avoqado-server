import { prismaMock } from '../../__helpers__/setup'
import { McpRetentionJob } from '../../../src/jobs/mcp-retention.job'

describe('MCP technical audit retention', () => {
  const now = new Date('2026-10-01T12:00:00Z')
  const cutoff = new Date(now.getTime() - 90 * 86400_000)

  it('deletes only selected audit rows strictly older than 90 days, in bounded stable pages', async () => {
    prismaMock.mcpToolCall.findMany.mockResolvedValueOnce([{ id: 'old-a' }, { id: 'old-b' }]).mockResolvedValueOnce([])
    prismaMock.mcpToolCall.deleteMany.mockResolvedValue({ count: 2 })

    expect(await new McpRetentionJob().runNow(now)).toEqual({ deleted: 2, backlog: false })
    expect(prismaMock.mcpToolCall.findMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    })
    expect(prismaMock.mcpToolCall.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-a', 'old-b'] }, createdAt: { lt: cutoff } },
    })
    expect(prismaMock.payment.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.order.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.deleteMany).not.toHaveBeenCalled()
  })

  it('does no writes when there is nothing expired', async () => {
    prismaMock.mcpToolCall.findMany.mockResolvedValue([])
    expect(await new McpRetentionJob().runNow(now)).toEqual({ deleted: 0, backlog: false })
    expect(prismaMock.mcpToolCall.deleteMany).not.toHaveBeenCalled()
  })

  it('stops after 50 pages and explicitly reports remaining work', async () => {
    prismaMock.mcpToolCall.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ id: `old-${i}` })))
    prismaMock.mcpToolCall.deleteMany.mockResolvedValue({ count: 100 })
    prismaMock.mcpToolCall.findFirst.mockResolvedValue({ id: 'more' })
    expect(await new McpRetentionJob().runNow(now)).toEqual({ deleted: 5000, backlog: true })
    expect(prismaMock.mcpToolCall.findMany).toHaveBeenCalledTimes(50)
    expect(prismaMock.mcpToolCall.findFirst).toHaveBeenCalledWith({ where: { createdAt: { lt: cutoff } }, select: { id: true } })
  })

  it('propagates a failed deletion without retrying it and allows the next run', async () => {
    prismaMock.mcpToolCall.findMany.mockResolvedValue([{ id: 'old-a' }])
    prismaMock.mcpToolCall.deleteMany.mockRejectedValue(new Error('database write failed'))
    const job = new McpRetentionJob()
    await expect(job.runNow(now)).rejects.toThrow('database write failed')
    expect(prismaMock.mcpToolCall.deleteMany).toHaveBeenCalledTimes(1)
    prismaMock.mcpToolCall.findMany.mockResolvedValue([])
    await expect(job.runNow(now)).resolves.toEqual({ deleted: 0, backlog: false })
  })

  it('does not start a concurrent cleanup on the same instance', async () => {
    let finish!: (rows: never[]) => void
    prismaMock.mcpToolCall.findMany.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    const job = new McpRetentionJob()
    const first = job.runNow(now)
    expect(await job.runNow(now)).toEqual({ deleted: 0, backlog: false, skipped: true })
    finish([])
    await first
    expect(prismaMock.mcpToolCall.findMany).toHaveBeenCalledTimes(1)
  })
})
