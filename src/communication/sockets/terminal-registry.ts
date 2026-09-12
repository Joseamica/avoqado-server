/**
 * Terminal Registry
 *
 * In-memory mapping of terminalId (serial number) → socketId
 * Updated when terminals send heartbeats or connect, cleared on disconnect.
 *
 * Used by terminal-payment.service.ts to target specific terminals
 * for Socket.IO payment requests from iOS.
 */

import logger from '../../config/logger'
import { terminalIdentityKey } from '../../utils/terminalSerial'

interface TerminalEntry {
  socketId: string | null // null if registered via HTTP heartbeat (no socket known yet)
  venueId: string
  terminalId: string
  name?: string
  registeredAt: Date
  lastHeartbeat: Date
  /** v1 = persiste/deduplica el request antes de confirmar entrega. */
  identityVerified?: boolean
  terminalPaymentAckVersion?: number
  terminalPaymentCancelDispositionVersion?: number
  /** v1 = responde `terminal:payment_probe` desde su bandeja durable sin entregar. */
  terminalPaymentProbeVersion?: number
}

/**
 * Normalize terminalId: strip AVQD- prefix and lowercase.
 * Single normalization point — all lookups and registrations go through this.
 * Exported so the terminal-payment lock keys its per-terminal slot by the
 * exact same normalized id the registry uses (AVQD-ABC and abc = one slot).
 */
export function normalizeTerminalId(terminalId: string): string {
  return terminalIdentityKey(terminalId)
}

class TerminalRegistry {
  // normalizedTerminalId → TerminalEntry
  private terminals = new Map<string, TerminalEntry>()
  // socketId → normalizedTerminalId (reverse lookup for disconnect cleanup)
  private socketToTerminal = new Map<string, string>()

  /**
   * Register or update a terminal's socket mapping.
   * Called on heartbeat or explicit registration.
   */
  register(
    terminalId: string,
    socketId: string | null,
    venueId: string,
    name?: string,
    terminalPaymentAckVersion?: number,
    terminalPaymentCancelDispositionVersion?: number,
    verifiedSerial?: string,
    terminalPaymentProbeVersion?: number,
  ): void {
    terminalId = normalizeTerminalId(terminalId)
    // Clean up old socket mapping if terminal reconnected with new socket
    const existing = this.terminals.get(terminalId)
    const verified = !!verifiedSerial && normalizeTerminalId(verifiedSerial) === terminalId
    const previousKey = socketId ? this.socketToTerminal.get(socketId) : undefined
    const previousBinding = previousKey ? this.terminals.get(previousKey) : undefined
    if (previousBinding?.identityVerified && (previousKey !== terminalId || previousBinding.venueId !== venueId)) return
    if (existing?.identityVerified && socketId && socketId !== existing.socketId && !verified) return
    const sameBinding = existing?.venueId === venueId && (!socketId || socketId === existing.socketId)
    const identityVerified = verified || (sameBinding && existing?.identityVerified === true)
    const now = new Date()
    // Keep existing socketId if new one is null (HTTP heartbeat update)
    const effectiveSocketId = socketId || (sameBinding ? existing?.socketId : null) || null
    // 🔴 El mapping inverso muere con el socket que lo creó — incluido el caso en que la
    // entrada se queda SIN socket (heartbeat HTTP que cambia de venue). Antes la limpieza
    // exigía un `socketId` nuevo no nulo, así que ese heartbeat dejaba vivo el inverso del
    // socket viejo: cuando después llegaba un socket FIRMADO para la misma terminal, el viejo
    // seguía resolviendo a esa entrada y heredaba su identidad verificada — y con ella el
    // permiso de aceptar o cancelar el cobro vivo de otro.
    if (existing?.socketId && existing.socketId !== effectiveSocketId) {
      this.socketToTerminal.delete(existing.socketId)
    }
    this.terminals.set(terminalId, {
      socketId: effectiveSocketId,
      venueId,
      terminalId,
      name: name || existing?.name,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeat: now,
      identityVerified,
      terminalPaymentAckVersion: identityVerified
        ? (terminalPaymentAckVersion ?? (sameBinding ? existing?.terminalPaymentAckVersion : undefined))
        : undefined,
      terminalPaymentCancelDispositionVersion: identityVerified
        ? (terminalPaymentCancelDispositionVersion ?? (sameBinding ? existing?.terminalPaymentCancelDispositionVersion : undefined))
        : undefined,
      // La sonda sólo se le manda a una terminal IDENTIFICADA que anunció la capacidad.
      terminalPaymentProbeVersion: identityVerified
        ? (terminalPaymentProbeVersion ?? (sameBinding ? existing?.terminalPaymentProbeVersion : undefined))
        : undefined,
    })
    if (effectiveSocketId) {
      this.socketToTerminal.set(effectiveSocketId, terminalId)
    }

    logger.debug(`📡 Terminal registered: ${terminalId} → ${socketId} (venue: ${venueId}). Total: ${this.terminals.size}`, {
      terminalId,
      socketId,
      venueId,
    })
  }

  /**
   * Remove terminal mapping when socket disconnects.
   */
  unregisterBySocketId(socketId: string): void {
    const terminalId = this.socketToTerminal.get(socketId)
    if (terminalId) {
      this.terminals.delete(terminalId)
      this.socketToTerminal.delete(socketId)
      logger.debug(`📡 Terminal unregistered: ${terminalId} (socket ${socketId} disconnected)`)
    }
  }

  /**
   * Get the socket ID for a terminal.
   */
  getSocketId(terminalId: string): string | null {
    return this.terminals.get(normalizeTerminalId(terminalId))?.socketId ?? null
  }

  /**
   * Get terminal entry by terminalId.
   */
  getTerminal(terminalId: string): TerminalEntry | null {
    return this.terminals.get(normalizeTerminalId(terminalId)) ?? null
  }

  /** Identidad de terminal derivada del socket autenticado; el payload no decide esto. */
  getTerminalBySocketId(socketId: string): TerminalEntry | null {
    const terminalId = this.socketToTerminal.get(socketId)
    if (!terminalId) return null
    const entry = this.terminals.get(terminalId) ?? null
    // 🔴 Defensa en profundidad, independiente de la limpieza de arriba: la entrada devuelta
    // tiene que pertenecer AL socket que pregunta. Un mapping inverso que sobreviva por
    // cualquier vía no puede volver a conceder la identidad de quien ocupa la terminal ahora.
    return entry && entry.socketId === socketId ? entry : null
  }

  /**
   * Get all online terminals for a venue (includes terminals without socket).
   */
  getOnlineTerminals(venueId: string): TerminalEntry[] {
    return Array.from(this.terminals.values()).filter(t => t.venueId === venueId)
  }

  /**
   * Get terminals that are ready to receive payments (have active socket connection).
   * Use this for the iOS "online terminals" endpoint — only show terminals that can actually process payments.
   */
  getPaymentReadyTerminals(venueId: string): TerminalEntry[] {
    return Array.from(this.terminals.values()).filter(t => t.venueId === venueId && t.socketId !== null)
  }

  /**
   * Check if a terminal is online.
   */
  isOnline(terminalId: string): boolean {
    return this.terminals.has(normalizeTerminalId(terminalId))
  }

  /**
   * Get all terminal IDs (for debugging).
   */
  getAllTerminalIds(): string[] {
    return Array.from(this.terminals.keys())
  }
}

// Singleton
export const terminalRegistry = new TerminalRegistry()
