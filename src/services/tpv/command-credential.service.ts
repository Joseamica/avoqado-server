import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { Request } from 'express'
import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import { sameTerminalSerial } from '../../utils/terminalSerial'

export function newCommandCredential() {
  const token = randomBytes(32).toString('hex')
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}

/** ¿El encabezado X-TPV-Command-Token es la llave cuyo SHA-256 guardó el SERVIDOR? Nunca lanza. */
export function llaveCoincide(hashHex: string | null | undefined, encabezado: unknown): boolean {
  if (!hashHex || typeof encabezado !== 'string' || !/^[a-f0-9]{64}$/.test(encabezado)) return false
  const digest = createHash('sha256').update(encabezado).digest()
  const stored = Buffer.from(hashHex, 'hex')
  return stored.length === digest.length && timingSafeEqual(stored, digest)
}

export type VeredictoPuerta = 'CON_LLAVE' | 'LLAVE_EQUIVOCADA' | 'SIN_LLAVE' | 'SIN_ALTA'

/**
 * D32 etapa 1 (sombra): ¿habría negado la puerta pública /config este pedido por no traer la llave del aparato?
 * Sólo se anota en el log; NO niega nada. Una terminal sin llave guardada (SIN_ALTA) no se puede cerrar hasta la etapa 4.
 */
export function veredictoPuerta(hashHex: string | null | undefined, encabezado: unknown) {
  const veredicto: VeredictoPuerta = !hashHex
    ? 'SIN_ALTA'
    : encabezado === undefined
      ? 'SIN_LLAVE'
      : llaveCoincide(hashHex, encabezado)
        ? 'CON_LLAVE'
        : 'LLAVE_EQUIVOCADA'
  return {
    veredicto,
    habriaNegado: veredicto === 'SIN_LLAVE' || veredicto === 'LLAVE_EQUIVOCADA',
    llaveSinAlta: veredicto === 'SIN_ALTA' && encabezado !== undefined,
  }
}

// Only call after proving possession of an activation code or a signed TPV session.
export async function issueCommandCredential(terminalId: string, candidate?: string): Promise<string> {
  if (candidate !== undefined && !/^[a-f0-9]{64}$/.test(candidate)) throw new BadRequestError('Credencial de terminal inválida')
  const { token, hash } = candidate
    ? { token: candidate, hash: createHash('sha256').update(candidate).digest('hex') }
    : newCommandCredential()
  await prisma.terminal.update({ where: { id: terminalId }, data: { commandTokenHash: hash } })
  return token
}

export async function resolveCommandTerminal(req: Request, identifier: string, signedSessionOnly = false) {
  const token = signedSessionOnly ? undefined : req.headers['x-tpv-command-token']
  const identity = req.authContext
  if (!token && !identity?.terminalSerialNumber) return null
  const serial = identifier.toUpperCase().startsWith('AVQD-') ? identifier.slice(5) : `AVQD-${identifier}`
  const terminal = await prisma.terminal.findFirst({
    where: {
      OR: [
        { id: identifier },
        { serialNumber: { equals: identifier, mode: 'insensitive' } },
        { serialNumber: { equals: serial, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      venueId: true,
      serialNumber: true,
      type: true,
      commandTokenHash: true,
      commandProtocolVersion: true,
      commandSessionId: true,
    },
  })
  if (!terminal || terminal.type !== 'TPV_ANDROID') return null
  if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && terminal.commandTokenHash) {
    return llaveCoincide(terminal.commandTokenHash, token) ? terminal : null
  }
  if (!identity?.venueId || !sameTerminalSerial(identity.terminalSerialNumber, terminal.serialNumber)) return null
  if (identity.venueId === terminal.venueId) return terminal
  // Legacy signed device sessions remain usable only across an actual pending venue move.
  const migration = await prisma.tpvCommandQueue.findFirst({
    where: {
      terminalId: terminal.id,
      venueId: terminal.venueId,
      commandType: 'FACTORY_RESET',
      status: { in: ['PENDING', 'QUEUED', 'SENT', 'RECEIVED', 'EXECUTING'] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      AND: [
        { payload: { path: ['migration', 'fromVenueId'], equals: identity.venueId } },
        { payload: { path: ['migration', 'toVenueId'], equals: terminal.venueId } },
      ],
    },
    select: { id: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  return migration ? terminal : null
}
