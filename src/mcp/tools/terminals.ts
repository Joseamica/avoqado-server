import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DeviceFormFactor, TerminalPaymentRequestStatus, TerminalStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { resolveTerminalRefundTarget } from '@/services/tpv/terminalRefundTarget'
import { terminalPaymentService } from '@/services/terminal-payment.service'

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
  customerDisplayInverted: boolean
}

export interface TerminalConfigReport {
  name: string
  serialNumber: string | null
  status: string
  settings: { showCheckout?: boolean; showQuickPayment?: boolean; enableShifts?: boolean }
  flags: string[]
  // Mostrador invertido: el cliente ve la pantalla grande y el cajero la chica. Por DISPOSITIVO.
  customerDisplayInverted: boolean
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

  return {
    name: t.name,
    serialNumber: t.serialNumber,
    status: t.status,
    settings,
    flags,
    customerDisplayInverted: t.customerDisplayInverted,
  }
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
          customerDisplayInverted: true,
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
    'See POS→terminal charge requests for your venues: which terminals are currently BUSY (an active charge in flight) and recent charges from the last 24h with their outcome (completed/failed/cancelled/timed_out/unknown). Use it to tell whether a terminal is stuck (status UNKNOWN holds the terminal until reconciled) or to check what happened to one charge. Each row also carries the customer the POS attached to that charge (customerId, null when the sale was anonymous). Amounts are in pesos.',
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
        // El cliente que el POS adjuntó al cobro (null en una venta anónima). Sin esto,
        // "¿a qué cliente iba este cobro?" no es contestable desde el MCP.
        customerId: r.customerId,
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

  server.tool(
    'refund_card_on_terminal',
    'Abre en una terminal física la devolución de un cobro con TARJETA, para que alguien la confirme ahí. Es la salida cuando `issue_refund` rechaza un pago con tarjeta: esta herramienta NO devuelve el dinero — sólo deja la pantalla lista en el aparato con ese cobro cargado, y una persona pone la tarjeta y confirma. Cuando el dinero se mueve, la TPV registra el reembolso sola. La terminal debe estar conectada y NO estar a media venta. Identifica el cobro por su paymentId (de list_payments) y la terminal por su id/serie (de list_devices). Requiere payments:refund.',
    {
      venueId: z.string().describe('Venue dueño del cobro y de la terminal (debe estar en tu alcance)'),
      paymentId: z.string().min(1).describe('El id del cobro con tarjeta a devolver (de list_payments)'),
      terminalId: z.string().min(1).describe('Serie o id de la terminal donde se abrirá la devolución (de list_devices)'),
      reason: z.string().optional().describe('Motivo, para que el cajero vea en la terminal por qué se le pidió'),
      confirm: z.boolean().optional().describe('Debe ser true para mandarlo de verdad; sin esto sólo obtienes una vista previa'),
    },
    async ({ venueId, paymentId, terminalId, reason, confirm }) => {
      const base = guard.venueFilter(venueId) // lanza ScopeError si el venue no es tuyo
      guard.requirePermission('payments:refund', venueId)

      const payment = await prisma.payment.findFirst({
        where: { id: paymentId, ...base },
        select: { id: true, venueId: true, status: true, method: true, amount: true, tipAmount: true, processorData: true },
      })
      if (!payment) return text({ ok: false, error: 'No encontré ese cobro en tus locales.' })

      const processorData = (payment.processorData ?? {}) as { refundedAmount?: number | string }
      const target = resolveTerminalRefundTarget(
        {
          id: payment.id,
          venueId: payment.venueId,
          status: payment.status,
          method: payment.method,
          amount: Number(payment.amount),
          tipAmount: Number(payment.tipAmount),
          refundedAmount: Number(processorData.refundedAmount ?? 0),
        },
        venueId,
      )
      if (!target.eligible) return text({ ok: false, reason: target.reason, error: target.message })

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { paymentId, terminalId, maxRefundable: target.remainingRefundableCents / 100, reason: reason ?? null },
          message: `Esto ABRIRÁ en la terminal ${terminalId} la devolución de hasta $${
            target.remainingRefundableCents / 100
          }. Nadie devuelve nada hasta que una persona lo confirme en el aparato. Vuelve a llamar con confirm:true para mandarlo.`,
        })
      }

      try {
        const result = await terminalPaymentService.requestRefundOnTerminal({
          terminalId,
          venueId,
          paymentId,
          requestedBy: scope.staffId,
          reason,
        })
        return text({
          ok: result.status === 'opened',
          status: result.status,
          requestId: result.requestId,
          error: result.errorMessage,
          message:
            result.status === 'opened'
              ? `Listo: la terminal ${terminalId} tiene abierta la devolución. Falta que alguien la confirme ahí — hasta entonces NO se ha devuelto nada.`
              : `No se pudo abrir la devolución en la terminal ${terminalId}.`,
        })
      } catch (error) {
        return text({ ok: false, error: error instanceof Error ? error.message : 'Error desconocido' })
      }
    },
  )
}
