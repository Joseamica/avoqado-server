import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DeviceFormFactor, Prisma, TerminalPaymentRequestStatus, TerminalStatus, TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { resolveTerminalRefundTarget } from '@/services/tpv/terminalRefundTarget'
import {
  SOLO_BLOQUEA_EN_ESTRICTO,
  UNRESOLVED_FINANCIAL_OUTCOME,
  desenlaceCanonico,
  proyectarEstado,
  terminalPaymentService,
} from '@/services/terminal-payment.service'
import { invalidarVenuesEstrictos } from '@/services/terminal-payment-strictness'
import { assertDeviceActionSupported, DEVICE_CAPABILITY_SELECT, toDeviceManagementDto } from '@/services/device-capabilities.service'

/**
 * Un dispositivo cuenta como "en línea" si reportó en los últimos 5 minutos. Mismo
 * criterio que usa el dashboard (`avoqado-web-dashboard/src/lib/terminal-status.ts`),
 * para que el MCP y la pantalla nunca se contradigan.
 */
const ONLINE_WINDOW_MS = 5 * 60 * 1000

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
    'See POS→terminal charge requests for your venues: which terminals are currently BUSY (an active charge in flight) and recent charges from the last 24h with their outcome (completed/failed/cancelled/timed_out/unknown). Use it to tell whether a terminal is stuck (an UNKNOWN result protects the sale until its outcome is confirmed; a reconnect or elapsed time does not prove no charge) or to check what happened to one charge. Read `outcome` to answer "was the card charged?": CHARGED (a Payment exists), NOT_CHARGED (the terminal or the server proved no charge — see `outcomeEvidence` and `evidenceClass`) or UNRESOLVED (nobody proved anything: the charge still reserves the terminal, which is what `busy` means). `status` is the same value the POS sees, so a failed/cancelled charge with no evidence is reported as UNKNOWN on purpose. Each row also carries the customer the POS attached to that charge (customerId, null when the sale was anonymous). A charge the server refused before it ever reached the terminal (terminal offline, busy or from another location; sale cancelled, already paid or missing) is listed as failed with rejectedAtAdmission:true and its reason in failureCode: nothing reached the terminal, so no card was charged. Amounts are in pesos. The processor webhook can confirm a charge before the terminal reports it: each row also says who confirmed it first (`closedVia`: terminal or webhook, keeping the same winning payment), lists the attempts the terminal opened for it (`attempts`, at most 25 per charge; `attemptsTruncated`/`attemptsTotal` say when there are more) and which one won (`winnerAttemptId`). To page through ALL the attempts of one charge, call again with `attemptsRequestId` (that requestId) and, from the second page on, `attemptsAfter` = the `attemptsNextCursor` returned by the previous page.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      requestId: z.string().optional().describe('Look up one specific charge request by its requestId'),
      attemptsRequestId: z
        .string()
        .optional()
        .describe('Page through ALL the attempts of ONE charge (its requestId): returns only `attempts` for it, 25 per page'),
      attemptsAfter: z
        .string()
        .max(64)
        .optional()
        .describe('With attemptsRequestId: the `attemptsNextCursor` of the previous page (an attemptId); omit for the first page'),
    },
    async ({ venueId, requestId, attemptsRequestId, attemptsAfter }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      // Codex R4 (P2): CONTINUACIÓN por solicitud — la ventana de 25 por solicitud dice que está recortada; esto es cómo se
      // llega al resto. Keyset sobre (createdAt, attemptId), sin tope global que otra solicitud pueda agotar.
      if (attemptsRequestId) {
        const fila = await prisma.terminalPaymentRequest.findFirst({
          where: { ...where, requestId: attemptsRequestId },
          select: { requestId: true },
        })
        if (!fila) return text({ ok: false, error: 'No existe ese cobro en tu alcance' })
        const TOPE = 25
        let despues: Prisma.TerminalPaymentAttemptLinkWhereInput = {}
        if (attemptsAfter) {
          const ancla = await prisma.terminalPaymentAttemptLink.findUnique({
            where: { attemptId: attemptsAfter },
            select: { requestId: true, attemptId: true, createdAt: true },
          })
          if (!ancla || ancla.requestId !== fila.requestId) {
            return text({ ok: false, error: 'El cursor de intentos no pertenece a ese cobro. Vuelve a consultar desde el inicio.' })
          }
          despues = { OR: [{ createdAt: { gt: ancla.createdAt } }, { createdAt: ancla.createdAt, attemptId: { gt: ancla.attemptId } }] }
        }
        const [lote, attemptsTotal] = await Promise.all([
          prisma.terminalPaymentAttemptLink.findMany({
            where: { requestId: fila.requestId, ...despues },
            orderBy: [{ createdAt: 'asc' }, { attemptId: 'asc' }],
            take: TOPE + 1,
            select: { attemptId: true, createdAt: true },
          }),
          prisma.terminalPaymentAttemptLink.count({ where: { requestId: fila.requestId } }),
        ])
        const hasMore = lote.length > TOPE
        const attempts = lote.slice(0, TOPE).map(v => ({ attemptId: v.attemptId, linkedAt: new Date(v.createdAt).toISOString() }))
        return text({
          requestId: fila.requestId,
          attempts,
          attemptsTotal,
          attemptsNextCursor: hasMore ? attempts[attempts.length - 1].attemptId : null,
        })
      }
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000) // rolling 24h (duration, not a calendar date)
      const rows = await prisma.terminalPaymentRequest.findMany({
        where: {
          ...where,
          // 🔴 El primer brazo es el PREDICADO DEL SERVICIO, no una lista de estados escrita aquí: una fila vieja que
          // sigue ocupando la terminal tiene que aparecer aunque tenga más de 24 h — es justo la que hay que ver.
          ...(requestId ? { requestId } : { OR: [UNRESOLVED_FINANCIAL_OUTCOME, { createdAt: { gte: since } }] }),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
      // S8 (webhook como primer confirmador): los intentos que la terminal abrió por solicitud y cuál ganó. `closedVia`
      // dice QUIÉN confirmó primero (terminal o webhook) y conserva al ganador: el `paymentId` de la fila no cambia.
      const requestIds = rows.map(r => r.requestId)
      const winnerIds = rows.map(r => r.paymentId).filter((id): id is string => !!id)
      const TOPE_POR_SOLICITUD = 25
      // Codex R3 (P2): la ventana es POR SOLICITUD (`ROW_NUMBER` sobre cada `requestId`), no un tope global que una
      // solicitud con muchos intentos podía agotar dejando a otra con `attempts: []` y «completa». El recorte se declara
      // por solicitud con su conteo real (`attemptsTotal`), que sale de un `groupBy` y no de la ventana.
      const [vinculos, conteos, ganadores] = await Promise.all([
        requestIds.length
          ? prisma.$queryRaw<{ requestId: string; attemptId: string; createdAt: Date }[]>`
              SELECT "requestId", "attemptId", "createdAt" FROM (
                SELECT "requestId", "attemptId", "createdAt",
                  ROW_NUMBER() OVER (PARTITION BY "requestId" ORDER BY "createdAt" ASC, "attemptId" ASC) AS rn
                FROM "TerminalPaymentAttemptLink"
                WHERE "requestId" IN (${Prisma.join(requestIds)})
              ) v WHERE rn <= ${TOPE_POR_SOLICITUD}
              ORDER BY "createdAt" ASC, "attemptId" ASC`
          : Promise.resolve([]),
        requestIds.length
          ? prisma.terminalPaymentAttemptLink.groupBy({
              by: ['requestId'],
              where: { requestId: { in: requestIds } },
              _count: { _all: true },
            })
          : Promise.resolve([]),
        winnerIds.length
          ? // Acotado por construcción: un ganador por fila listada (≤ 100); el `take` lo deja explícito para el candado estático.
            prisma.payment.findMany({
              where: { id: { in: winnerIds } },
              select: { id: true, idempotencyKey: true },
              take: winnerIds.length,
            })
          : Promise.resolve([]),
      ])
      const llaveDelGanador = new Map((ganadores ?? []).map(g => [g.id, g.idempotencyKey ?? null]))
      // Codex R2 (P2-7): el tope de vínculos por solicitud (25) no puede esconder al GANADOR — su vínculo se trae aparte
      // por llave y se funde con la lista; si la lista tocó el tope se dice (`attemptsTruncated`).
      const llavesGanadoras = [...new Set([...llaveDelGanador.values()].filter((k): k is string => !!k))]
      const vinculosDelGanador =
        llavesGanadoras.length > 0
          ? await prisma.terminalPaymentAttemptLink.findMany({
              where: { attemptId: { in: llavesGanadoras } },
              select: { requestId: true, attemptId: true, createdAt: true },
              take: llavesGanadoras.length,
            })
          : []
      const vinculosPorSolicitud = new Map<string, { attemptId: string; linkedAt: string }[]>()
      const totalPorSolicitud = new Map<string, number>()
      for (const c of (conteos ?? []) as { requestId: string; _count: { _all: number } }[]) {
        totalPorSolicitud.set(c.requestId, c._count._all)
      }
      for (const v of [...(vinculos ?? []), ...vinculosDelGanador]) {
        const lista = vinculosPorSolicitud.get(v.requestId) ?? []
        if (lista.some(x => x.attemptId === v.attemptId)) continue
        lista.push({ attemptId: v.attemptId, linkedAt: new Date(v.createdAt).toISOString() })
        vinculosPorSolicitud.set(v.requestId, lista)
      }
      const truncadas = new Set<string>()
      for (const [requestId, total] of totalPorSolicitud) {
        if (total > (vinculosPorSolicitud.get(requestId)?.length ?? 0)) truncadas.add(requestId)
      }
      // La MISMA proyección que lee el POS (§8 C.1): el operador y el cajero no pueden ver dos verdades distintas.
      const requests = rows.map(r => {
        const estado = proyectarEstado(r)
        const attempts = vinculosPorSolicitud.get(r.requestId) ?? []
        const llaveGanadora = r.paymentId ? (llaveDelGanador.get(r.paymentId) ?? null) : null
        return {
          requestId: estado.requestId,
          terminalId: estado.terminalId,
          // Traducido igual que para el POS: un FAILED/CANCELLED sin desenlace acreditado se ve UNKNOWN.
          status: estado.status,
          // El desenlace canónico: «se cobró / no se cobró / no se sabe», con QUIÉN lo acredita.
          outcome: estado.outcome,
          outcomeEvidence: estado.outcomeEvidence,
          evidenceClass: estado.evidenceClass,
          ...(estado.reconciliationRequired ? { reconciliationRequired: true } : {}),
          busy: estado.outcome === 'UNRESOLVED',
          amount: estado.amount, // PESOS
          tip: estado.tip,
          orderId: estado.orderId,
          paymentId: estado.paymentId,
          // El cliente que el POS adjuntó al cobro (null en una venta anónima). Sin esto,
          // "¿a qué cliente iba este cobro?" no es contestable desde el MCP.
          customerId: r.customerId,
          senderDevice: estado.senderDevice,
          lateResult: estado.lateResult,
          cancelDisposition: estado.cancelDisposition,
          // Una LÁPIDA de admisión (FAILED con `REJECTED_…`): el servidor rechazó el cobro ANTES de que llegara a la
          // terminal. No es un «rechazo del banco»: ninguna tarjeta se tocó. Sin esto el operador lo leería como declinada.
          failureCode: estado.failureCode,
          rejectedAtAdmission: estado.outcomeEvidence === 'REJECTED_AT_ADMISSION',
          // S8: quién confirmó primero (terminal | webhook | null si sigue abierta o es anterior al webhook), los intentos
          // que la terminal abrió para esta solicitud y cuál de ellos ganó (sólo si su llave es uno de esos intentos).
          closedVia: (r as { closedVia?: string | null }).closedVia ?? null,
          attempts,
          winnerAttemptId: llaveGanadora && attempts.some(a => a.attemptId === llaveGanadora) ? llaveGanadora : null,
          attemptsTruncated: truncadas.has(r.requestId),
          attemptsTotal: totalPorSolicitud.get(r.requestId) ?? attempts.length,
          createdAt: r.createdAt.toISOString(),
        }
      })
      return text({
        count: requests.length,
        busyTerminals: [...new Set(requests.filter(r => r.busy).map(r => r.terminalId))],
        // Cuenta lo que el operador VE como UNKNOWN (el status ya traducido), no el valor crudo de la columna.
        unknownCount: requests.filter(r => r.status === TerminalPaymentRequestStatus.UNKNOWN).length,
        requests,
      })
    },
  )

  server.tool(
    'release_terminal_payment',
    'Review a terminal charge that has an UNKNOWN result and reconcile it with its exact recorded payment when available. A reconnect, elapsed time, or missing payment does not establish that the card was not charged. Without confirmed completion the terminal remains protected. By DEFAULT only PREVIEWS amount, age and order; confirm:true requests reconciliation. Requires tpv:update and a write-capable connection.',
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
      requireWriteScopeAlways(scope, 'tpv:update', 'cierra las sesiones abiertas de una terminal')

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
          // 🔴 Los cuatro que `desenlaceCanonico` necesita. Sin ellos COMPILA igual (son opcionales en su tipo) y
          // clasifica MAL: una lápida se leería como «sin desenlace». Hay prueba de la FORMA de esta consulta.
          failureCode: true,
          cancelDisposition: true,
          paymentId: true,
          resultJson: true,
        },
      })
      if (!row) return text({ ok: false, error: 'No encontré ese cobro en tus locales.' })
      if (row.status !== TerminalPaymentRequestStatus.UNKNOWN) {
        // Se informa TAMBIÉN el desenlace canónico: `terminal_payment_requests` muestra el status ya traducido, así
        // que sin esto una fila que ahí se ve «UNKNOWN» rebotaría aquí con «su estado es FAILED» y nadie entendería.
        const desenlace = desenlaceCanonico(row)
        return text({
          ok: false,
          status: row.status,
          outcome: desenlace.outcome,
          outcomeEvidence: desenlace.outcomeEvidence,
          error: `Ese cobro no está atorado: su estado es ${row.status} (${desenlace.outcome}). Sólo se libera un cobro en UNKNOWN.`,
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
            `La terminal ${row.terminalId} tiene un cobro de $${(row.amountCents / 100).toFixed(2)} sin confirmar desde hace ${ageMinutes} min. ` +
            'Se buscará el pago exacto de esta solicitud. Si su resultado sigue pendiente, la terminal conservará la protección. Confirma para consultar y conciliar; no vuelvas a pasar la tarjeta.',
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
        message:
          'No se liberó: todavía falta confirmar el resultado y que la terminal haya terminado. Consulta el cobro en la terminal o solicita su conciliación.',
      })
    },
  )

  server.tool(
    'set_terminal_payment_strict_mode',
    'Enciende o apaga, en UN local, el régimen estricto de desenlaces del cobro remoto (la tablet manda el cobro a la terminal). Apagado —el valor de fábrica— una terminal sólo queda reservada mientras el cobro está en vuelo o su resultado es desconocido. Encendido, además queda reservada cuando la terminal contestó algo que NO acredita si cobró o no. Se enciende SÓLO cuando todas las terminales de ese local ya tienen la versión que manda esa evidencia: encenderlo antes deja terminales reservadas sin forma de liberarlas. Las solicitudes anteriores al momento de encenderlo NUNCA se ven afectadas. Apagar revierte al instante. Por DEFECTO sólo muestra una vista previa; confirm:true aplica. Requiere tpv:update y una conexión con permiso de escritura.',
    {
      venueId: z.string().describe('Local a encender o apagar (debe estar en tu alcance)'),
      enabled: z.boolean().describe('true = encender el régimen estricto desde ahora; false = apagarlo'),
      reason: z.string().min(3).max(300).optional().describe('Por qué (p. ej. "las 3 terminales ya están en 2.9.3")'),
      confirm: z.boolean().optional().describe('Debe ser true para aplicarlo; sin esto sólo obtienes una vista previa'),
    },
    async ({ venueId, enabled, reason, confirm }) => {
      // 🔴 `venueFilter` se llama por su EFECTO (lanza `ScopeError` si el venue no es tuyo), NO por su valor:
      // devuelve `{ venueId: { in: [...] } }`, que sirve para las tablas que tienen columna `venueId` — y `Venue`
      // no la tiene, su llave es `id`. Pasárselo a `prisma.venue.findFirst` lanzaba un error de validación de
      // Prisma SIEMPRE: la tool no habría funcionado ni una vez. Lo encontró el QA end-to-end del 11-sep, no las
      // pruebas, porque esta tool no tenía ninguna. Mismo patrón que el resto del MCP (`venues.ts:64`).
      guard.venueFilter(venueId)
      // 🔴 SUPERADMIN, no `tpv:update` (P2 de la auditoría de Codex, 11-sep). `tpv:update` lo tiene MANAGER
      // (`permissions.ts:1019`), y esto NO es una operación del venue: es la palanca con la que Avoqado migra
      // terminal por terminal. La comparación con `release_terminal_payment` era mía y era mala — aquélla exige
      // EVIDENCIA de un cobro concreto; apagar el interruptor no exige ninguna y retira protección de golpe.
      if (!scope.isSuperAdmin) {
        return text({
          ok: false,
          error:
            'Sólo Avoqado puede cambiar el régimen de desenlaces del cobro remoto. Es parte de la migración de las terminales, no un ajuste del negocio.',
        })
      }
      guard.requirePermission('tpv:update', venueId)
      // 🔴 Cambia si una terminal puede cobrar: un token de sólo lectura no puede tocarlo.
      requireWriteScopeAlways(scope, 'tpv:update', 'cambia el régimen de desenlaces del cobro remoto')

      const venue = await prisma.venue.findFirst({
        where: { id: venueId },
        select: { id: true, name: true, terminalPaymentStrictSince: true, terminalPaymentStrictEnabled: true },
      })
      if (!venue) return text({ ok: false, error: 'No encontré ese local en tu alcance.' })

      const estabaEncendido = venue.terminalPaymentStrictEnabled
      if (estabaEncendido === enabled) {
        return text({
          ok: true,
          changed: false,
          enabled: estabaEncendido,
          since: venue.terminalPaymentStrictSince?.toISOString() ?? null,
          message: enabled
            ? `${venue.name} ya está en régimen estricto desde ${venue.terminalPaymentStrictSince?.toISOString()}. No cambié nada.`
            : `${venue.name} ya está en el régimen de fábrica. No cambié nada.`,
        })
      }

      // 🔴 El corte se CONSERVA al apagar, así que reencender no desplaza la frontera ni deja descubierto el
      // periodo que ya estaba protegido (P1-3 de Codex). Sólo la PRIMERA vez se fija en `ahora`.
      // 🔴 `esPrimeraVez` importa para no MENTIR en la vista previa (P3-5 de la auditoría de Fable, 11-sep):
      // cuando no hay corte previo, el de verdad es el instante del `confirm`, no el de la vista previa. Anunciar
      // una fecha concreta que luego cambia es la misma familia de defecto que la vista previa que contaba mal.
      const esPrimeraVez = venue.terminalPaymentStrictSince === null
      const corte = venue.terminalPaymentStrictSince ?? new Date()

      // 🔴 La vista previa dice la verdad, que no es la que yo había escrito (P2-6 de Codex). Mi versión contaba
      // la diferencia entre regímenes SIN aplicar el corte, así que anunciaba cientos de reservas nuevas que el
      // propio corte excluye. Los dos números que de verdad importan:
      //  · `quedaranReservadas`  — las que SÍ van a bloquear: sin desenlace Y nacidas desde el corte.
      //  · `sinCubrirPorElCorte` — las que NO va a cubrir por ser anteriores; encender no protege el pasado, y
      //    ésas siguen necesitando conciliación (B). Callarlo daba una sensación falsa de «ya está protegido».
      const [quedaranReservadas, sinCubrirPorElCorte] = enabled
        ? await Promise.all([
            prisma.terminalPaymentRequest.count({ where: { venueId, createdAt: { gte: corte }, ...SOLO_BLOQUEA_EN_ESTRICTO } }),
            prisma.terminalPaymentRequest.count({ where: { venueId, createdAt: { lt: corte }, ...SOLO_BLOQUEA_EN_ESTRICTO } }),
          ])
        : [0, 0]
      // Al APAGAR, el número honesto es cuántas protecciones se RETIRAN (mi versión forzaba 0 y no decía nada).
      const protegidasQueSeRetiran =
        !enabled && venue.terminalPaymentStrictSince
          ? await prisma.terminalPaymentRequest.count({
              where: { venueId, createdAt: { gte: venue.terminalPaymentStrictSince }, ...SOLO_BLOQUEA_EN_ESTRICTO },
            })
          : 0

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          venue: venue.name,
          current: estabaEncendido ? 'estricto' : 'de fábrica',
          next: enabled ? 'estricto' : 'de fábrica',
          ...(esPrimeraVez ? { corte: 'se fija al confirmar' } : { corte: corte.toISOString() }),
          message: enabled
            ? `Vas a encender el régimen estricto en ${venue.name}, con corte ${esPrimeraVez ? 'en el momento en que confirmes' : `en ${corte.toISOString()} (el que ya tenía)`}. Desde ese momento, un cobro cuya terminal conteste algo que no acredite si cobró dejará esa terminal reservada hasta conciliarlo. Enciéndelo sólo si TODAS las terminales del local ya tienen la versión que manda esa evidencia. Confirma para aplicar.`
            : `Vas a apagar el régimen estricto en ${venue.name} y volver al de fábrica (reserva sólo en vuelo o resultado desconocido). El corte ${venue.terminalPaymentStrictSince?.toISOString()} se conserva, así que reencender no moverá la frontera. Confirma para aplicar.`,
          ...(enabled ? { quedaranReservadas, sinCubrirPorElCorte } : { protegidasQueSeRetiran }),
        })
      }

      // El corte de una PRIMERA activación se fija AQUÍ, al confirmar — es lo que la vista previa anunció.
      const since = enabled ? (esPrimeraVez ? new Date() : corte) : venue.terminalPaymentStrictSince
      await prisma.venue.update({
        where: { id: venueId },
        data: { terminalPaymentStrictEnabled: enabled, terminalPaymentStrictSince: since },
      })
      // Que surta efecto YA, sin esperar el refresco: apagar es la marcha atrás, y una marcha atrás
      // que tarda un minuto no sirve cuando hay terminales bloqueadas.
      await invalidarVenuesEstrictos()

      await auditMcpWrite(scope, {
        action: enabled ? 'TERMINAL_PAYMENT_STRICT_MODE_ON' : 'TERMINAL_PAYMENT_STRICT_MODE_OFF',
        entity: 'Venue',
        entityId: venueId,
        venueId,
        data: {
          since: since?.toISOString() ?? null,
          previous: venue.terminalPaymentStrictSince?.toISOString() ?? null,
          reason: reason ?? null,
        },
      })

      return text({
        ok: true,
        changed: true,
        enabled,
        since: since?.toISOString() ?? null,
        message: enabled
          ? `Régimen estricto ENCENDIDO en ${venue.name}, con corte en ${since?.toISOString()}. Los cobros anteriores a ese corte siguen rigiéndose por el de fábrica y necesitan conciliación aparte.`
          : `Régimen estricto APAGADO en ${venue.name}. Vuelve a reservar sólo en vuelo o con resultado desconocido; el corte se conserva para cuando lo reenciendas.`,
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
