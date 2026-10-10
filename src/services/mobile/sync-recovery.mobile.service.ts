import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'

const MAX_RECOVERY = 100

function identities(value: unknown, maxLength: number): string[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > MAX_RECOVERY ||
    value.some(id => typeof id !== 'string' || !id.trim() || id.length > maxLength)
  ) {
    throw new BadRequestError('Las identidades de recuperación deben ser cadenas no vacías dentro del límite')
  }
  return value
}

// Recuperar evidencia no ejecuta el reducer: hasta PROCESSING debe permanecer sin cambios.
export async function lookupSyncRecovery(venueId: string, input: unknown) {
  if (typeof venueId !== 'string' || !venueId.trim()) throw new BadRequestError('Sucursal original requerida para recuperar')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestError('Body de recuperación inválido')
  const body = input as Record<string, unknown>
  const intentIds = identities(body.intentIds, 64)
  const externalOrderIds = identities(body.externalOrderIds, 256)
  if (!intentIds.length && !externalOrderIds.length) throw new BadRequestError('Envía al menos una identidad de recuperación')
  if (intentIds.length + externalOrderIds.length > MAX_RECOVERY) throw new BadRequestError('Máximo 100 identidades por recuperación')
  let deviceId: string | undefined
  if (body.deviceId !== undefined) {
    if (typeof body.deviceId !== 'string' || !body.deviceId.trim() || body.deviceId.length > 64)
      throw new BadRequestError('deviceId inválido')
    deviceId = body.deviceId
  }
  if (intentIds.length && !deviceId) throw new BadRequestError('deviceId original requerido para recuperar intents')

  const [intents, orders] = await Promise.all([
    intentIds.length
      ? prisma.posSyncIntent.findMany({
          where: { venueId, deviceId, idempotencyKey: { in: intentIds }, type: { in: ['OPEN_TABLE', 'ADD_ITEMS', 'PAY_CASH'] } },
          take: MAX_RECOVERY,
          select: {
            idempotencyKey: true,
            type: true,
            deviceId: true,
            seq: true,
            localRef: true,
            status: true,
            errorCode: true,
            resultJson: true,
          },
        })
      : [],
    externalOrderIds.length
      ? prisma.order.findMany({
          where: { venueId, externalId: { in: externalOrderIds } },
          take: MAX_RECOVERY,
          select: { id: true, externalId: true },
        })
      : [],
  ])
  return {
    intents: intents.map(row => ({
      id: row.idempotencyKey,
      type: row.type,
      deviceId: row.deviceId,
      seq: row.seq,
      localRef: row.localRef,
      status: row.status,
      errorCode: row.errorCode,
      result: row.resultJson,
    })),
    orders: orders.map(row => ({ externalId: row.externalId, orderId: row.id })),
  }
}
