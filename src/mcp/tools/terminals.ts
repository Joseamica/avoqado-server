import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

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
}
