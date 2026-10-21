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
import { logAction } from '../dashboard/activity-log.service'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import type { GatewayHeartbeatInput, ImpresoraObservadaInput, SyncPrintJobsInput } from '../../schemas/mobile/print.mobile.schema'

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

// ── La impresora que se encuentra sola ──

export type MotivoImpresoraObservada = 'ACTUALIZADA' | 'SIN_CAMBIOS' | 'DIRECCION_YA_CAMBIO' | 'OTRA_IDENTIDAD'

/** "192.168.1.64:9100" → "192.168.1.64" (un host sin puerto se queda igual). */
function hostDe(direccion: string | null | undefined): string | null {
  if (!direccion) return null
  const limpia = direccion.trim()
  const separador = limpia.lastIndexOf(':')
  if (separador > 0 && /^\d+$/.test(limpia.slice(separador + 1))) return limpia.slice(0, separador)
  return limpia
}

/** El puerto de "192.168.1.64:9100", o null si no trae. */
function puertoDe(direccion: string | null | undefined): string | null {
  if (!direccion) return null
  const separador = direccion.lastIndexOf(':')
  const puerto = separador > 0 ? direccion.slice(separador + 1).trim() : ''
  return /^\d+$/.test(puerto) ? puerto : null
}

/** Sólo direcciones de red LOCAL (10/8, 172.16/12, 192.168/16): una ticketera nunca vive en internet. */
function esIpv4Privada(host: string): boolean {
  const partes = host.split('.')
  if (partes.length !== 4 || partes.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false
  const [a, b] = partes.map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * Una tablet encontró una impresora de red en otra dirección (o aprendió su identidad) y lo AVISA.
 *
 * 🔴 Existe por Testarudo (2-oct-2026): la ticketera de cocina tiene DHCP y el módem le cambió la IP. La tablet ya
 * la encuentra sola, pero el panel seguía mostrando la vieja y cada tablet tenía que descubrirla por su cuenta.
 *
 * Nunca pisa algo más nuevo: CAS sobre la dirección que la tablet vio (`previousAddress`). Si alguien ya la corrigió
 * en el panel, o llegó antes otra tablet, contesta `DIRECCION_YA_CAMBIO` y la tablet se queda con lo del servidor.
 * La identidad (`stableKey`: «mac:…» o «mdns:…») se aprende una vez y no se reemplaza; si la tablet trae OTRA, es
 * otra impresora y no se toca.
 */
export async function reportarImpresoraObservada(
  venueId: string,
  printerId: string,
  input: ImpresoraObservadaInput,
  staffId?: string,
): Promise<{ updated: boolean; motivo: MotivoImpresoraObservada; address: string | null; stableKey: string | null }> {
  const printer = await prisma.printer.findFirst({
    where: { id: printerId, venueId },
    select: { id: true, connectionType: true, address: true, stableKey: true },
  })
  if (!printer) throw new NotFoundError('Impresora no encontrada')
  if (printer.connectionType !== 'NETWORK') {
    throw new BadRequestError('Sólo una impresora de red puede cambiar de dirección sola')
  }
  const hostNuevo = hostDe(input.address)
  if (!hostNuevo || !esIpv4Privada(hostNuevo)) {
    throw new BadRequestError('La dirección nueva debe ser de la red local del negocio (ej. 192.168.1.67)')
  }

  const sinCambio = { updated: false, address: printer.address, stableKey: printer.stableKey }
  if (printer.stableKey && input.stableKey && printer.stableKey !== input.stableKey) {
    return { ...sinCambio, motivo: 'OTRA_IDENTIDAD' }
  }
  const hostActual = hostDe(printer.address)
  if (hostActual !== hostDe(input.previousAddress) && hostActual !== hostNuevo) {
    return { ...sinCambio, motivo: 'DIRECCION_YA_CAMBIO' }
  }

  const puerto = puertoDe(printer.address)
  const address = puerto ? `${hostNuevo}:${puerto}` : hostNuevo
  const stableKey = printer.stableKey ?? input.stableKey ?? null
  if (address === printer.address && stableKey === printer.stableKey) {
    return { ...sinCambio, motivo: 'SIN_CAMBIOS' }
  }

  const { count } = await prisma.printer.updateMany({
    where: { id: printer.id, venueId, address: printer.address },
    data: { address, stableKey },
  })
  if (count === 0) return { ...sinCambio, motivo: 'DIRECCION_YA_CAMBIO' }

  void logAction({
    staffId: staffId ?? null,
    venueId,
    action: 'PRINTER_ADDRESS_AUTO_UPDATED',
    entity: 'Printer',
    entityId: printer.id,
    data: {
      from: printer.address,
      to: address,
      stableKey,
      learnedStableKey: !printer.stableKey && !!stableKey,
    } as Prisma.InputJsonValue,
  })
  logger.info(`[impresora-movida] ${printer.id} ${printer.address} → ${address} (identidad ${stableKey ?? 'sin identidad'})`)
  return { updated: true, motivo: 'ACTUALIZADA', address, stableKey }
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
