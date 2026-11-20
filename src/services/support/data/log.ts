import crypto from 'crypto'
import type { Prisma, SupportDataResult } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { DataLog } from './answer.service'
import type { DataRequest } from './catalog'

/**
 * El registro de consultas de la B: un renglón por consulta, sin cifras. Este archivo es su ÚNICO escritor (lo vigila
 * tests/unit/architecture/supportDataSingleWriter.test.ts); el worker lo llama en la transacción que guarda la respuesta.
 */

/** Las consultas que sí leyeron: sólo ésas gastan el tope del día. Un «no puedo» que no leyó nada no lo gasta. */
const READ_RESULTS: SupportDataResult[] = ['ANSWERED', 'QUERY_FAILED', 'CHECK_FAILED', 'OVER_CAP']

/**
 * HMAC-SHA256 hex de [day, amount, time]. Llave: HMAC-SHA256(SUPPORT_WHATSAPP_ENC_KEY, 'support-data-params-v1'), con la llave
 * del soporte leída como sus 32 bytes (igual que supportCipher). Ninguna llave nueva: «monto 850» no se revierte sin ella.
 */
export function paramsHmac(request: Pick<DataRequest, 'day' | 'amount' | 'time'>): string {
  const hex = process.env.SUPPORT_WHATSAPP_ENC_KEY ?? ''
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('SUPPORT_WHATSAPP_ENC_KEY missing or wrong length (expect 32-byte hex string)')
  const key = crypto.createHmac('sha256', Buffer.from(hex, 'hex')).update('support-data-params-v1').digest()
  return crypto
    .createHmac('sha256', key)
    .update(JSON.stringify([request.day, request.amount, request.time]))
    .digest('hex')
}

/** El único escritor de SupportDataQuery. */
export async function recordSupportDataQuery(tx: Prisma.TransactionClient, log: DataLog): Promise<void> {
  await tx.supportDataQuery.create({ data: log })
}

/** Las consultas de hoy que sí leyeron: result ∈ ANSWERED, QUERY_FAILED, CHECK_FAILED, OVER_CAP. Índice SupportDataQuery [staffId, day]. */
export async function countDataReadsToday(staffId: string, day: string, db: Prisma.TransactionClient = prisma): Promise<number> {
  return db.supportDataQuery.count({ where: { staffId, day, result: { in: READ_RESULTS } } })
}
