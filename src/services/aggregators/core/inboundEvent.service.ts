import { AggregatorConnection, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { tokensEqual } from './credentials'
import { Provider } from './types'

/**
 * Busca la conexión dueña del secreto de la URL del webhook. Se confirma el proveedor y se vuelve a comparar
 * el token en tiempo constante (la búsqueda por índice no lo es).
 */
export async function resolveConnectionByToken(provider: Provider, token: string): Promise<AggregatorConnection | null> {
  if (!token) return null
  const conn = await prisma.aggregatorConnection.findUnique({ where: { webhookToken: token } })
  if (!conn || conn.provider !== provider || !tokensEqual(conn.webhookToken, token)) return null
  return conn
}

/**
 * Guarda el webhook crudo ANTES de contestarle al proveedor. `dedupKey` es única: si el proveedor repite el
 * mismo evento, se devuelve el que ya estaba con `duplicate: true` y no se crea otro.
 */
export async function persistInboundEvent(p: {
  provider: Provider
  connectionId: string
  venueId: string
  kind: 'BOOKING' | 'CHECKIN'
  dedupKey: string
  payload: unknown
}): Promise<{ event: { id: string }; duplicate: boolean }> {
  try {
    const event = await prisma.aggregatorInboundEvent.create({
      data: {
        provider: p.provider,
        connectionId: p.connectionId,
        venueId: p.venueId,
        kind: p.kind,
        dedupKey: p.dedupKey,
        payload: p.payload as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    return { event, duplicate: false }
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e
    const existing = await prisma.aggregatorInboundEvent.findUnique({ where: { dedupKey: p.dedupKey }, select: { id: true } })
    if (!existing) throw e
    return { event: existing, duplicate: true }
  }
}
