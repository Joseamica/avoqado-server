/**
 * «Por cobrar» — una operación a la vez por cobro (spec 2026-11-02-por-cobrar-superadmin §3.4).
 *
 * Dos rondas de Codex encontraron cruces entre pestañas (facturar contra deshacer, editar contra pagar, generar contra pausar).
 * En vez de un arreglo por cruce hay UN candado: toda escritura de un cobro y de sus ocurrencias corre en una transacción corta
 * que antes toma `SELECT … FOR UPDATE` sobre la fila del cobro, y ahí adentro vuelve a leer lo que va a decidir.
 *
 * 🔴 Las llamadas a Facturapi y al correo NUNCA van dentro del candado: una transacción abierta mientras el PAC contesta
 * (hasta 30 s) retiene la fila y la conexión.
 */
import type { Prisma } from '@prisma/client'
import { NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

/** Toma la fila del cobro dentro de `tx`; la otra transacción que la pida espera aquí hasta que ésta termine. */
export async function lockCharge(tx: Prisma.TransactionClient, chargeId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PlatformCharge" WHERE id = ${chargeId} FOR UPDATE`
  if (rows.length === 0) throw new NotFoundError('Cobro no encontrado', 'PLATFORM_CHARGE_NOT_FOUND')
}

/** Abre una transacción corta, toma el candado del cobro y corre `fn` con ese mismo `tx`. Un error de `fn` hace rollback. */
export function withChargeLock<T>(chargeId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await lockCharge(tx, chargeId)
    return fn(tx)
  })
}
