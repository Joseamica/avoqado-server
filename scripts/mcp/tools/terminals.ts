import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma, text } from '../context'

export interface TerminalInput {
  name: string
  serialNumber: string | null
  status: string
  config: any
  configOverrides: any
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
  const base = (t.config && typeof t.config === 'object' ? t.config.settings : null) ?? {}
  const overrides = (t.configOverrides && typeof t.configOverrides === 'object' ? t.configOverrides : null) ?? {}
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

export function registerTerminalTools(server: McpServer) {
  server.tool(
    'audit_terminals',
    "Audit the TPV config of a venue's (or org's) terminals. Returns each terminal's effective showCheckout/showQuickPayment/enableShifts settings and flags known config gaps (e.g. checkout enabled while quick-pay disabled).",
    {
      venueId: z.string().optional().describe('Audit terminals of one venue'),
      organizationId: z.string().optional().describe('Audit terminals across an org (all its venues)'),
    },
    async ({ venueId, organizationId }) => {
      if (!venueId && !organizationId) return text({ error: 'Provide venueId or organizationId' })
      const terminals = await prisma.terminal.findMany({
        where: venueId ? { venueId } : { venue: { organizationId } },
        select: {
          name: true,
          serialNumber: true,
          status: true,
          config: true,
          configOverrides: true,
          venue: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
      })
      const reports = terminals.map(t => ({
        venue: t.venue?.name,
        ...auditTerminalConfig(t as unknown as TerminalInput),
      }))
      const flagged = reports.filter(r => r.flags.length > 0)
      return text({ count: reports.length, flaggedCount: flagged.length, terminals: reports })
    },
  )
}
