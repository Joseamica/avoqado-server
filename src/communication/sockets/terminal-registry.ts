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

interface TerminalEntry {
  socketId: string | null // null if registered via HTTP heartbeat (no socket known yet)
  venueId: string
  terminalId: string
  name?: string
  registeredAt: Date
  lastHeartbeat: Date
}

/**
 * Normalize terminalId: strip AVQD- prefix and lowercase.
 * Single normalization point — all lookups and registrations go through this.
 */
function normalizeTerminalId(terminalId: string): string {
  return terminalId.replace(/^AVQD-/i, '').toLowerCase()
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
  register(terminalId: string, socketId: string | null, venueId: string, name?: string): void {
    terminalId = normalizeTerminalId(terminalId)
    // Clean up old socket mapping if terminal reconnected with new socket
    const existing = this.terminals.get(terminalId)
    if (existing && existing.socketId && socketId && existing.socketId !== socketId) {
      this.socketToTerminal.delete(existing.socketId)
    }

    const now = new Date()
    // Keep existing socketId if new one is null (HTTP heartbeat update)
    const effectiveSocketId = socketId || existing?.socketId || null
    this.terminals.set(terminalId, {
      socketId: effectiveSocketId,
      venueId,
      terminalId,
      name: name || existing?.name,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeat: now,
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
