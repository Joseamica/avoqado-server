import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import { Prisma } from '@prisma/client'

const MAX_RECOVERY = 100

type RecoveredOrder = { id: string; externalId: string | null }
type RecoveredOrderWithEvidence = RecoveredOrder & {
  venueId: string
  orderStatus: string
  hasPayments: boolean
  hasTerminalRequests: boolean
  verifiedAt: Date
}

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
  if (body.includeCancelledPaymentEvidence !== undefined && typeof body.includeCancelledPaymentEvidence !== 'boolean') {
    throw new BadRequestError('includeCancelledPaymentEvidence debe ser un booleano')
  }
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
      ? body.includeCancelledPaymentEvidence === true
        ? // Estado y existencia de dinero/solicitudes salen del MISMO snapshot; leerlos por separado podría acreditar un falso vacío.
          prisma.$queryRaw<RecoveredOrderWithEvidence[]>(
            Prisma.sql`SELECT o.id, o."externalId", o."venueId", o.status AS "orderStatus",
              EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId" = o.id AND p."venueId" = o."venueId") AS "hasPayments",
              EXISTS (SELECT 1 FROM "TerminalPaymentRequest" t WHERE t."orderId" = o.id AND t."venueId" = o."venueId") AS "hasTerminalRequests",
              (statement_timestamp() AT TIME ZONE 'UTC') AS "verifiedAt"
              FROM "Order" o WHERE o."venueId" = ${venueId} AND o."externalId" IN (${Prisma.join(externalOrderIds)})
              ORDER BY o.id LIMIT ${MAX_RECOVERY}`,
          )
        : prisma.order.findMany({
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
      // Una reserva PROCESSING guarda su marca/huella interna (plan 2026-10-13-sync-retoma-por-llave); hacia afuera
      // sigue siendo «sin resultado», como antes.
      result: row.status === 'PROCESSING' ? null : row.resultJson,
    })),
    orders: orders.map((row: RecoveredOrder | RecoveredOrderWithEvidence) => ({
      externalId: row.externalId,
      orderId: row.id,
      ...('orderStatus' in row
        ? {
            cancelledPaymentEvidence: {
              version: 1,
              venueId: row.venueId,
              orderId: row.id,
              externalId: row.externalId,
              orderStatus: row.orderStatus,
              hasPayments: row.hasPayments,
              hasTerminalRequests: row.hasTerminalRequests,
              verifiedAt: row.verifiedAt.toISOString(),
            },
          }
        : {}),
    })),
  }
}
