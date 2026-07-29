import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DeviceFormFactor, TerminalPaymentRequestStatus, TerminalStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

/**
 * Un dispositivo cuenta como "en línea" si reportó en los últimos 5 minutos. Mismo
 * criterio que usa el dashboard (`avoqado-web-dashboard/src/lib/terminal-status.ts`),
 * para que el MCP y la pantalla nunca se contradigan.
 */
const ONLINE_WINDOW_MS = 5 * 60 * 1000

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
    'list_devices',
    'List the devices connected to your venues: PAX/NexGo payment terminals plus any phone, tablet or POS that installed Avoqado and signed in (Sunmi, iPhone, iPad, Android). Shows what kind of device it is, whether it is online right now, who used it last, and when it was first seen. Use it to answer "how many devices are running in my venue", "which device is offline", or to find the device behind a problem. Filter by formFactor (PHONE, TABLET, HANDHELD_POS, COUNTERTOP_POS, DESKTOP, UNKNOWN) or by onlyOnline. Retired devices are hidden unless includeRetired is true.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      formFactor: z
        .enum(['PHONE', 'TABLET', 'HANDHELD_POS', 'COUNTERTOP_POS', 'DESKTOP', 'UNKNOWN'])
        .optional()
        .describe('Only devices of this kind'),
      onlyOnline: z.boolean().optional().describe('Only devices that reported in the last 5 minutes'),
      selfRegisteredOnly: z
        .boolean()
        .optional()
        .describe('Only devices that registered themselves by signing in (excludes terminals an admin provisioned)'),
      includeRetired: z.boolean().optional().describe('Include devices that were retired (default false)'),
    },
    async ({ venueId, formFactor, onlyOnline, selfRegisteredOnly, includeRetired }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS)

      const rows = await prisma.terminal.findMany({
        where: {
          ...where,
          ...(formFactor ? { formFactor: formFactor as DeviceFormFactor } : {}),
          ...(selfRegisteredOnly ? { selfRegistered: true } : {}),
          ...(includeRetired ? {} : { status: { not: TerminalStatus.RETIRED } }),
          ...(onlyOnline ? { lastHeartbeat: { gte: onlineSince } } : {}),
        },
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          brand: true,
          model: true,
          modelIdentifier: true,
          formFactor: true,
          osVersion: true,
          version: true,
          serialNumber: true,
          deviceUid: true,
          selfRegistered: true,
          firstSeenAt: true,
          lastHeartbeat: true,
          lastStaffId: true,
          venue: { select: { name: true } },
        },
        orderBy: [{ lastHeartbeat: 'desc' }, { name: 'asc' }],
        take: 200,
      })

      // El nombre del último usuario se resuelve en un solo query, no uno por renglón.
      const staffIds = [...new Set(rows.map(r => r.lastStaffId).filter((id): id is string => Boolean(id)))]
      const staff = staffIds.length
        ? await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })
        : []
      const staffById = new Map(staff.map(s => [s.id, [s.firstName, s.lastName].filter(Boolean).join(' ').trim()]))

      const devices = rows.map(r => ({
        id: r.id,
        venue: r.venue?.name,
        name: r.name,
        kind: r.formFactor ?? DeviceFormFactor.UNKNOWN,
        type: r.type,
        brand: r.brand,
        model: r.model,
        modelIdentifier: r.modelIdentifier,
        osVersion: r.osVersion,
        appVersion: r.version,
        // `serialNumber` sólo existe donde el hardware lo expone (Sunmi, PAX). Un iPhone
        // nunca lo da — por eso Square marca su equivalente como "where available".
        serialNumber: r.serialNumber,
        // true = apareció solo al hacer login; false = lo dio de alta un admin.
        selfRegistered: r.selfRegistered,
        online: Boolean(r.lastHeartbeat && r.lastHeartbeat >= onlineSince),
        status: r.status,
        lastSeenAt: r.lastHeartbeat?.toISOString() ?? null,
        firstSeenAt: r.firstSeenAt?.toISOString() ?? null,
        lastUsedBy: r.lastStaffId ? (staffById.get(r.lastStaffId) ?? null) : null,
        // Misma identidad que usa el POS para su outbox offline y el hub LAN.
        deviceUid: r.deviceUid,
      }))

      const byKind: Record<string, number> = {}
      for (const d of devices) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1

      return text({
        count: devices.length,
        onlineCount: devices.filter(d => d.online).length,
        selfRegisteredCount: devices.filter(d => d.selfRegistered).length,
        byKind,
        devices,
      })
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
