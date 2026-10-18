/**
 * IVA por producto, plan 6b (spec §5.4): la exclusión INVERSA. Con el IVA por producto encendido, el POS externo (SoftRestaurant, que
 * calcula su propio IVA) no escribe nada. El rechazo se registra FUERA de toda transacción (warn siempre; ActivityLog una vez por negocio
 * por hora: el latido llega cada minuto) y el despachador termina sin lanzar ⇒ ACK, sin reintentos infinitos ni cola muerta.
 */
import type { Prisma } from '@prisma/client'

import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { tomarAdmisionCompartida } from '@/services/fiscal/admisionIva'
import { negocioCambioDeOrganizacionError } from '@/services/fiscal/exclusionContable'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { PresupuestoDeEspera, tomarCandado } from '@/utils/esperaDeCandados'
import prisma from '@/utils/prismaClient'

/**
 * Revisión final, I-1 (paso 3): la admisión que espera un evento del POS vence ANTES que su transacción (15 s): un encendido en curso en la
 * organización la retiene. El consumidor de RabbitMQ lo trata como transitorio y lo reencola; el P2028 de antes iba a la cola muerta.
 */
export const IVA_ADMISION_OCUPADA = 'IVA_ADMISION_OCUPADA'

export const RECHAZO_POS_REGISTRO_MS = 60 * 60 * 1000
// ponytail: memoria por instancia (sin Redis); con N instancias, hasta N filas por hora. Basta para no inundar el ActivityLog.
const registrados = new Map<string, number>()
export const olvidarRechazos = (): void => registrados.clear()

export class PosRechazadoPorIva extends Error {
  constructor(public venueId: string) {
    super(`POS_RECHAZADO_POR_IVA venue=${venueId}`)
  }
}

const encendido = async (db: Pick<Prisma.TransactionClient, 'venueIvaPorProducto'>, venueId: string) =>
  (await db.venueIvaPorProducto.findUnique({ where: { venueId }, select: { venueId: true } })) != null

export async function registrarRechazo(venueId: string, evento: string): Promise<void> {
  logger.warn(`[POS SYNC] Evento ${evento} rechazado: el negocio tiene el IVA por producto encendido | venue=${venueId}`)
  const ahora = Date.now()
  if ((registrados.get(venueId) ?? 0) > ahora) return
  registrados.set(venueId, ahora + RECHAZO_POS_REGISTRO_MS)
  // El rastro nunca convierte el ACK en cola muerta. try/await y no `.catch`: las integraciones dejan `logAction` como `jest.fn()`.
  try {
    await logAction({ venueId, action: 'POS_EXTERNO_RECHAZADO_POR_IVA', entity: 'Venue', entityId: venueId, data: { evento } })
  } catch {
    // ya quedó el warn
  }
}

/** Antes del PRIMER efecto de cualquier evento del POS. `true` = rechazado (ya registrado): no escribir nada. */
export async function rechazarSiIvaEncendido(venueId: unknown, evento: string): Promise<boolean> {
  if (typeof venueId !== 'string' || !venueId || !(await encendido(prisma, venueId))) return false
  await registrarRechazo(venueId, evento)
  return true
}

/**
 * PRIMERA sentencia de TODA transacción que escribe algo del POS externo (spec §5.4): admisión compartida de la organización del negocio
 * (D10); la fila de ESA organización `FOR SHARE` hasta el commit (Codex r2 N1: el traslado de sede la toma `FOR NO KEY UPDATE` sin pasar
 * por la admisión fiscal, así que sin este candado la sede podía irse a otra organización y encenderse allá mientras escribimos); releer
 * que la sede sigue en ella; y la bandera. Con el encendido en curso, espera; con el negocio encendido, lanza.
 */
export async function exigirIvaApagadoTx(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
  const organizacion = async () =>
    (await tx.$queryRaw<Array<{ organizationId: string }>>`SELECT "organizationId" FROM "Venue" WHERE id = ${venueId}`)[0]?.organizationId
  const admitida = await organizacion()
  if (!admitida) return // el negocio no existe: el escritor responde como hoy
  // Todos los llamadores entran aquí al abrir su transacción (de 15 s, `ORDER_LOCK_WAIT_BUDGET`): el presupuesto nace con ella.
  // Codex código r1 #2 y r2 N1 (Rulings CX-2, CX-11): UN presupuesto y DOS esperas que lo comparten: la admisión y la fila de la
  // organización (una publicación de catálogo la retiene hasta 90 s). `lock_timeout` vale por cada adquisición: con un solo `tomarCandado`
  // para las dos, cada una podía esperar 9 s (15 s ⇒ P2028 y cola muerta); así la fila sólo espera lo que QUEDA.
  const espera = {
    presupuesto: PresupuestoDeEspera.para(ORDER_LOCK_WAIT_BUDGET.timeout),
    codigo: IVA_ADMISION_OCUPADA,
    mensaje: 'La organización está ocupada (encendido del IVA u otro cambio); el evento del POS se reintenta en un momento.',
  }
  await tomarCandado(tx, () => tomarAdmisionCompartida(tx, admitida), espera)
  await tomarCandado(tx, () => tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${admitida} FOR SHARE`, espera)
  if ((await organizacion()) !== admitida) throw negocioCambioDeOrganizacionError()
  if (await encendido(tx, venueId)) throw new PosRechazadoPorIva(venueId)
}

/**
 * Para los escritores que hoy escriben SIN transacción (personal, mesa, área, latido): su escritura, bajo el mismo guardia. Con el
 * presupuesto de la orden (PF-M5): la espera de la admisión cuenta contra el timeout, y un encendido lento de una sede hermana no debe
 * mandar a la cola muerta los mensajes de ésta por los 5 s de Prisma.
 */
export function conIvaApagado<T>(venueId: string, escribir: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await exigirIvaApagadoTx(tx, venueId)
    return escribir(tx)
  }, ORDER_LOCK_WAIT_BUDGET)
}
