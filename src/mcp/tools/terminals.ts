import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DeviceFormFactor, TerminalPaymentRequestStatus, TerminalStatus, TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { resolveTerminalRefundTarget } from '@/services/tpv/terminalRefundTarget'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { assertDeviceActionSupported, DEVICE_CAPABILITY_SELECT, toDeviceManagementDto } from '@/services/device-capabilities.service'

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
          ...DEVICE_CAPABILITY_SELECT,
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

      const projectionNow = new Date()
      const devices = rows.map(row => {
        const r = toDeviceManagementDto(row, { now: projectionNow })

        return {
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
          customerDisplayInverted: r.customerDisplayInverted,
          customerDisplayRequest: r.customerDisplayRequest,
          customerDisplayRequestVersion: r.customerDisplayRequestVersion,
          capabilities: r.capabilities,
          // Misma identidad que usa el POS para su outbox offline y el hub LAN.
          deviceUid: r.deviceUid,
        }
      })

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
    'See POS→terminal charge requests for your venues: which terminals are currently BUSY (an active charge in flight) and recent charges from the last 24h with their outcome (completed/failed/cancelled/timed_out/unknown). Use it to tell whether a terminal is stuck (status UNKNOWN holds the terminal; the server frees it on its own once the terminal is back and 2 minutes pass with no card payment, and `release_terminal_payment` frees it earlier) or to check what happened to one charge. Each row also carries the customer the POS attached to that charge (customerId, null when the sale was anonymous). Amounts are in pesos.',
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
    'release_terminal_payment',
    'Free a payment terminal that is stuck BUSY because a POS→terminal charge never got an answer (status UNKNOWN in terminal_payment_requests). The server already frees it on its own once the terminal reports again and 20 minutes pass with no card payment (the time its offline queue needs to upload); use this when the business cannot wait AND someone confirmed on the terminal that the charge did not go through. It is money-safe on the server side: if a card payment for that charge exists, the request is closed as COMPLETED instead and NOT released. By DEFAULT it only PREVIEWS (amount, age, order); call again with confirm:true to release. Leaves an audit trail with your identity and reason. Requires tpv:update (manager and above) and a write-capable connection.',
    {
      venueId: z.string().describe('Venue that owns the terminal (must be in your scope)'),
      requestId: z.string().min(1).describe('The stuck charge (status UNKNOWN) from terminal_payment_requests'),
      reason: z.string().min(3).max(300).optional().describe('Why you are releasing it (e.g. "la PAX se reinició y no cobró")'),
      confirm: z.boolean().optional().describe('Must be true to actually release; without it you get a preview'),
    },
    async ({ venueId, requestId, reason, confirm }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // Same bar as the tablet's manager button: `tpv:update` (MANAGER+). NOT `payments:create`,
      // which every cashier holds — a cashier must not be able to free a slot through the MCP
      // that they cannot free from the POS.
      guard.requirePermission('tpv:update', venueId)
      // 🔴 Freeing a terminal lets the cashier charge again on it: a read-only token must never do it.
      requireWriteScopeAlways(scope, 'tpv:update')

      const row = await prisma.terminalPaymentRequest.findFirst({
        where: { requestId, ...where },
        select: {
          id: true,
          status: true,
          terminalId: true,
          amountCents: true,
          tipCents: true,
          orderId: true,
          senderDevice: true,
          createdAt: true,
          terminalReturnedAt: true,
        },
      })
      if (!row) return text({ ok: false, error: 'No encontré ese cobro en tus locales.' })
      if (row.status !== TerminalPaymentRequestStatus.UNKNOWN) {
        return text({
          ok: false,
          status: row.status,
          error: `Ese cobro no está atorado: su estado es ${row.status}. Sólo se libera un cobro en UNKNOWN.`,
        })
      }

      const ageMinutes = Math.floor((Date.now() - row.createdAt.getTime()) / 60_000)
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          terminalId: row.terminalId,
          amount: row.amountCents / 100, // PESOS
          tip: row.tipCents / 100,
          orderId: row.orderId,
          senderDevice: row.senderDevice,
          ageMinutes,
          terminalReturnedAt: row.terminalReturnedAt?.toISOString() ?? null,
          message:
            `Vas a liberar la terminal ${row.terminalId}, reservada por un cobro de $${(row.amountCents / 100).toFixed(2)} sin respuesta desde hace ${ageMinutes} min` +
            (row.terminalReturnedAt
              ? ' (la terminal ya volvió a reportar; el servidor la liberará sola en breve).'
              : ' (la terminal todavía no vuelve a reportar).') +
            '\nSi existe un pago con tarjeta de ese cobro NO se libera: se cierra como cobrado. Confirma con el operador que la terminal no está a media venta; luego vuelve a llamar con confirm:true.',
        })
      }

      const r = await terminalPaymentService.releaseUnknownRequest({
        requestId,
        venueId,
        actor: { staffId: scope.staffId, source: 'MCP' },
        reason: reason ?? 'Liberada desde el MCP',
      })
      // The service writes its own ActivityLog; this adds the trace that it came through the MCP.
      await auditMcpWrite(scope, {
        action: 'TERMINAL_PAYMENT_RELEASE_MCP',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        venueId,
        data: { requestId, released: r.released, status: r.status, reason: reason ?? null },
      })
      if (r.released) {
        return text({
          ok: true,
          released: true,
          status: r.status,
          message: `Terminal ${row.terminalId} liberada. La tablet ya puede volver a mandarle cobros.`,
        })
      }
      if (r.status === TerminalPaymentRequestStatus.COMPLETED) {
        return text({
          ok: false,
          released: false,
          status: r.status,
          paymentId: r.paymentId,
          message:
            'No se liberó: sí existe un pago con tarjeta de ese cobro, así que se cerró como COBRADO. Revisa que la orden no quede pagada dos veces.',
        })
      }
      return text({
        ok: false,
        released: false,
        status: r.status,
        message: 'No se liberó: el cobro cambió de estado antes de que pudiéramos liberarlo. Vuelve a consultar terminal_payment_requests.',
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

      const targetIdentity = terminalId.trim()
      const targetDevice = await prisma.terminal.findFirst({
        where: {
          ...base,
          OR: [
            { id: targetIdentity },
            { serialNumber: { equals: targetIdentity, mode: 'insensitive' } },
            ...(!targetIdentity.toUpperCase().startsWith('AVQD-')
              ? [
                  {
                    type: TerminalType.TPV_ANDROID,
                    serialNumber: { equals: `AVQD-${targetIdentity}`, mode: 'insensitive' as const },
                  },
                ]
              : []),
          ],
        },
        select: {
          id: true,
          serialNumber: true,
          type: true,
          customerDisplayPresent: true,
          customerDisplayInvertible: true,
          displayModeProtocolVersion: true,
          capabilitiesObservedAt: true,
        },
      })
      if (!targetDevice) {
        return text({ ok: false, code: 'DEVICE_NOT_FOUND', error: 'No encontré ese dispositivo en tu local.' })
      }

      try {
        assertDeviceActionSupported(targetDevice, { kind: 'TERMINAL_PAYMENT_REQUEST' })
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as Error & { code?: string }).code === 'DEVICE_ACTION_UNSUPPORTED') {
          return text({ ok: false, code: 'DEVICE_ACTION_UNSUPPORTED', error: error.message })
        }
        throw error
      }

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
