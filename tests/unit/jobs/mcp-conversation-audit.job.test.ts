import { prismaMock } from '../../__helpers__/setup'
import { McpConversationAuditJob } from '../../../src/jobs/mcp-conversation-audit.job'

const row = (o: Partial<Record<string, unknown>> = {}) => ({
  toolName: 'daily_sales',
  staffId: 's1',
  orgId: 'o1',
  venueId: 'v1',
  outcome: 'ok',
  detail: null,
  durationMs: 12,
  createdAt: new Date(),
  ...o,
})

describe('McpConversationAuditJob.runNow', () => {
  it('reads the window and returns a clean report when all calls are ok', async () => {
    prismaMock.mcpToolCall.findMany.mockResolvedValue([row(), row()])
    const report = await new McpConversationAuditJob().runNow(12)

    expect(prismaMock.mcpToolCall.findMany).toHaveBeenCalledTimes(1)
    expect(report.totalCalls).toBe(2)
    expect(report.hasSignal).toBe(false)
    expect(report.windowHours).toBe(12)
  })

  it('flags failures pulled from the window (permission denied surfaced)', async () => {
    prismaMock.mcpToolCall.findMany.mockResolvedValue([
      row({ toolName: 'issue_refund', outcome: 'error', detail: 'permission denied: refunds:create' }),
      row(),
    ])
    const report = await new McpConversationAuditJob().runNow(12)

    expect(report.failedCalls).toBe(1)
    expect(report.hasSignal).toBe(true)
    expect(report.permissionDenied[0].toolName).toBe('issue_refund')
  })
})
