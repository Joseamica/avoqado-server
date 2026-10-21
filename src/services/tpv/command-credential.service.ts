import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { Request } from 'express'
import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import { sameTerminalSerial } from '../../utils/terminalSerial'

export function newCommandCredential() {
  const token = randomBytes(32).toString('hex')
  return { token, hash: createHash('sha256').update(token).digest('hex') }
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
    const digest = createHash('sha256').update(token).digest()
    const stored = Buffer.from(terminal.commandTokenHash, 'hex')
    if (stored.length === digest.length && timingSafeEqual(stored, digest)) return terminal
    return null
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
