/**
 * PRINT_STATIONS — /mobile service (POS iOS/Android + el gateway del venue).
 *
 * - getPrintConfig: lo que el POS cachea (mismo loader que el simulador del dashboard).
 * - syncPrintJobs: el gateway replica su OUTBOX DURABLE local al server (fuente de verdad
 *   del camino crítico = el gateway; esto es solo la RÉPLICA para visibilidad/auditoría/alertas).
 *   Dedupe idempotente por (eventId, reason, seq). NO escribe ActivityLog (alta frecuencia).
 * - gatewayHeartbeat: latido + estado de impresoras; alerta a ADMIN/MANAGER en fallos
 *   reusando el broadcaster de telemetría ya existente (broadcastPrinterStatus).
 */
import { Prisma, StaffRole } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import socketManager from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'
import { buildPrintConfig } from '../printing/printConfig.service'
import type { GatewayHeartbeatInput, SyncPrintJobsInput } from '../../schemas/mobile/print.mobile.schema'

// Rank de PrintJob.status por avance del ciclo de vida. La réplica SOLO avanza: un re-sync
// fuera de orden del outbox (el gateway bufferea) nunca regresa un estado terminal (DONE→QUEUED),
// así la vista de auditoría/alertas es fiable sin importar el orden de entrega.
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SENT: 1,
  UNCERTAIN: 1,
  FAILED: 2,
  DONE: 3,
  OPERATOR_CONFIRMED: 4,
}

export async function getPrintConfig(venueId: string) {
  // Venue sin estaciones ⇒ stations:[] ⇒ el POS se comporta idéntico a hoy.
  return buildPrintConfig(venueId)
}

export async function syncPrintJobs(venueId: string, input: SyncPrintJobsInput) {
  // Solo el gateway DESIGNADO del venue puede replicar su outbox (simetría con gatewayHeartbeat):
  // orders:update NO basta. Evita que un WAITER/KITCHEN/CASHIER contamine la réplica de auditoría o
  // dispare alertas PRINT_JOB_FAILED falsas desde un dispositivo que no es el gateway.
  const gateway = await prisma.printGateway.findUnique({ where: { venueId }, select: { terminalId: true } })
  const registered = !!gateway && gateway.terminalId === input.terminalId
  if (!registered) return { upserted: 0, errors: 0, newlyFailed: 0, registered: false }

  // Solo aceptar station/printer que pertenezcan a este venue (defensa multi-tenant;
  // el job SIEMPRE queda scoped al venueId autenticado, los ids ajenos se anulan).
  const [stations, printers] = await Promise.all([
    prisma.printStation.findMany({ where: { venueId }, select: { id: true } }),
    prisma.printer.findMany({ where: { venueId }, select: { id: true } }),
  ])
  const stationIds = new Set(stations.map(s => s.id))
  const printerIds = new Set(printers.map(p => p.id))

  let upserted = 0
  let errors = 0
  let newlyFailed = 0 // solo transiciones NUEVAS a FAILED → evita re-alertar en cada re-sync del outbox
  for (const job of input.jobs) {
    const stationId = job.stationId && stationIds.has(job.stationId) ? job.stationId : null
    const printerId = job.printerId && printerIds.has(job.printerId) ? job.printerId : null
    try {
      // Resolve SIEMPRE scoped por venueId (nunca toca el job de otro venue aunque el eventId colisione).
      const existing = await prisma.printJob.findFirst({
        where: { venueId, eventId: job.eventId, reason: job.reason, seq: job.seq },
        select: { id: true, status: true, attempts: true },
      })
      if (existing) {
        // La réplica SOLO avanza: ignora un status más viejo que el persistido (re-sync fuera de orden
        // del outbox no debe regresar DONE→QUEUED). attempts es monótono no-decreciente.
        const advancing = (STATUS_RANK[job.status] ?? 0) >= (STATUS_RANK[existing.status] ?? 0)
        await prisma.printJob.update({
          where: { id: existing.id },
          data: {
            status: advancing ? job.status : undefined,
            attempts: Math.max(existing.attempts ?? 0, job.attempts ?? 0),
            // Solo al avanzar: null explícito limpia un error viejo al recuperarse; undefined lo deja intacto.
            error: advancing ? (job.error === undefined ? undefined : job.error) : undefined,
            stationId,
            printerId,
          },
        })
        if (advancing && job.status === 'FAILED' && existing.status !== 'FAILED') newlyFailed++
      } else {
        await prisma.printJob.create({
          data: {
            id: job.id,
            venueId,
            eventId: job.eventId,
            reason: job.reason,
            seq: job.seq,
            type: job.type,
            status: job.status,
            stationId,
            printerId,
            gatewayTerminalId: job.gatewayTerminalId ?? null,
            originTerminalId: job.originTerminalId ?? null,
            orderId: job.orderId ?? null,
            orderItemIds: job.orderItemIds ?? [],
            attempts: job.attempts ?? 0,
            error: job.error ?? null,
            payload: job.payload === undefined ? undefined : (job.payload as Prisma.InputJsonValue),
          },
        })
        if (job.status === 'FAILED') newlyFailed++
      }
      upserted++
    } catch (e) {
      // Un job malo (p.ej. colisión de PK creada por el cliente) NO debe tumbar todo el lote.
      errors++
      logger.warn(`[print-jobs] sync fallo para job ${job.id} (venue ${venueId}): ${(e as Error).message}`)
    }
  }

  if (newlyFailed > 0) alertPrintJobsFailed(venueId, newlyFailed)
  return { upserted, errors, newlyFailed, registered: true }
}

export async function gatewayHeartbeat(venueId: string, input: GatewayHeartbeatInput) {
  const gateway = await prisma.printGateway.findUnique({ where: { venueId } })
  // Solo el gateway designado (dashboard) reporta latido — evita auto-registro no autorizado.
  const registered = !!gateway && gateway.terminalId === input.terminalId

  let printersUpdated = 0
  // SOLO el gateway designado puede reportar latido + estado de impresoras. Así ningún otro
  // dispositivo autenticado del venue puede falsear alertas de estado de impresora.
  if (registered) {
    await prisma.printGateway.update({
      where: { venueId },
      data: { lastHeartbeat: new Date(), address: input.address === undefined ? undefined : input.address },
    })
    if (input.printers?.length) {
      for (const p of input.printers) {
        const r = await prisma.printer.updateMany({
          where: { id: p.printerId, venueId },
          data: { lastStatus: p.status, lastSeenAt: new Date() },
        })
        if (r.count > 0) {
          printersUpdated += r.count
          // Reusa la telemetría existente: alerta ADMIN/MANAGER en ERROR/OFFLINE/PAPER_OUT.
          broadcastPrinterStatus(venueId, p.printerId, p.status)
        }
      }
    }
  }

  return { registered, printersUpdated }
}

// ── Alerts (best-effort; un fallo de socket nunca rompe la request) ──
function alertPrintJobsFailed(venueId: string, failedCount: number): void {
  try {
    const bs = socketManager.getBroadcastingService()
    if (!bs) return
    const payload = { venueId, failedCount, message: `${failedCount} comanda(s) no se imprimieron` }
    bs.broadcastToVenue(venueId, SocketEventType.PRINT_JOB_FAILED, payload)
    bs.broadcastToRole(StaffRole.ADMIN, SocketEventType.PRINT_JOB_FAILED, payload, venueId)
    bs.broadcastToRole(StaffRole.MANAGER, SocketEventType.PRINT_JOB_FAILED, payload, venueId)
  } catch {
    // swallow — alerting must never break the sync
  }
}

function broadcastPrinterStatus(venueId: string, printerId: string, status: string): void {
  try {
    const bs = socketManager.getBroadcastingService()
    if (!bs) return
    bs.broadcastPrinterStatus(venueId, { terminalId: printerId, printerType: 'KITCHEN', status: status as any })
  } catch {
    // swallow
  }
}
