import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TerminalPaymentRequestStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const TPR_ACTIVE: TerminalPaymentRequestStatus[] = [
  TerminalPaymentRequestStatus.PENDING,
  TerminalPaymentRequestStatus.SENT,
  TerminalPaymentRequestStatus.CANCEL_REQUESTED,
  TerminalPaymentRequestStatus.UNKNOWN,
]

export interface TerminalInput {
  name: string
  serialNumber: string | null
  status: string
  config: unknown
  configOverrides: unknown
}

export interface TerminalConfigReport {
  name: string
  serialNumber: string | null
  status: string
  settings: { showCheckout?: boolean; showQuickPayment?: boolean; enableShifts?: boolean }
  flags: string[]
}

/** Pure: merge config.settings + configOverrides, surface key TPV flags, detect known gaps. */
export function auditTerminalConfig(t: TerminalInput): TerminalConfigReport {
  const cfg = t.config && typeof t.config === 'object' ? (t.config as Record<string, unknown>) : {}
  const base = (cfg.settings && typeof cfg.settings === 'object' ? (cfg.settings as Record<string, unknown>) : {}) ?? {}
  const overrides = t.configOverrides && typeof t.configOverrides === 'object' ? (t.configOverrides as Record<string, unknown>) : {}
  const merged = { ...base, ...overrides }

  const settings = {
    showCheckout: merged.showCheckout as boolean | undefined,
    showQuickPayment: merged.showQuickPayment as boolean | undefined,
    enableShifts: merged.enableShifts as boolean | undefined,
  }

  const flags: string[] = []
  if (settings.showCheckout === true && settings.showQuickPayment === false) {
    flags.push('checkout_on_quickpay_off')
  }

  return { name: t.name, serialNumber: t.serialNumber, status: t.status, settings, flags }
}

export function registerTerminalTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'audit_terminals',
    "Audit the TPV config of your venues' terminals: each terminal's effective showCheckout/showQuickPayment/enableShifts and flags known config gaps (e.g. checkout on while quick-pay off). Pass venueId to focus one venue.",
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
    },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      const terminals = await prisma.terminal.findMany({
        where,
        select: {
          name: true,
          serialNumber: true,
          status: true,
          config: true,
          configOverrides: true,
          venue: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
      })
      const reports = terminals.map(t => ({ venue: t.venue?.name, ...auditTerminalConfig(t as unknown as TerminalInput) }))
      return text({ count: reports.length, flaggedCount: reports.filter(r => r.flags.length > 0).length, terminals: reports })
    },
  )

  server.tool(
    'terminal_payment_requests',
    'See POS→terminal charge requests for your venues: which terminals are currently BUSY (an active charge in flight) and recent charges from the last 24h with their outcome (completed/failed/cancelled/timed_out/unknown). Use it to tell whether a terminal is stuck (status UNKNOWN holds the terminal until reconciled) or to check what happened to one charge. Amounts are in pesos.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      requestId: z.string().optional().describe('Look up one specific charge request by its requestId'),
    },
    async ({ venueId, requestId }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000) // rolling 24h (duration, not a calendar date)
      const rows = await prisma.terminalPaymentRequest.findMany({
        where: {
          ...where,
          ...(requestId ? { requestId } : { OR: [{ status: { in: TPR_ACTIVE } }, { createdAt: { gte: since } }] }),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
      const requests = rows.map(r => ({
        requestId: r.requestId,
        terminalId: r.terminalId,
        status: r.status,
        busy: TPR_ACTIVE.includes(r.status),
        amount: r.amountCents / 100, // PESOS
        tip: r.tipCents / 100,
        orderId: r.orderId,
        paymentId: r.paymentId,
        senderDevice: r.senderDevice,
        lateResult: r.lateResult,
        createdAt: r.createdAt.toISOString(),
      }))
      return text({
        count: requests.length,
        busyTerminals: [...new Set(rows.filter(r => TPR_ACTIVE.includes(r.status)).map(r => r.terminalId))],
        unknownCount: rows.filter(r => r.status === TerminalPaymentRequestStatus.UNKNOWN).length,
        requests,
      })
    },
  )
}
