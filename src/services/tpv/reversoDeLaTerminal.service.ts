/**
 * SDK propio, fase 1 (Tarea 7): la LÁPIDA del reverso de la terminal.
 *
 * Una fila de `ProviderEventLog` por intento (`eventId = EVENTO_REVERSO(attemptId)`, única por `@@unique([provider, eventId])`)
 * que anota que la terminal va a reversar (`reversing`) o ya reversó (`reversed`) el cobro con Blumon. Mientras diga eso, ningún
 * cobro de BLUMON del intento nace: los dos registradores la consultan bajo el candado del intento, el mismo que toma el permiso
 * del reverso (Tarea 9), así que permiso y registro quedan serializados. Un cobro de AngelPay la ignora siempre.
 *
 * Forma: `type TIPO_REVERSO`, `status PROCESSED`, `attemptId`, `venueId`, `terminalId` (FK a `Terminal.id`, o null) y
 * `payload { estado, status: estado, terminalKey, permisoEn?, resultado?, paymentId? }`. El `status` del payload nunca es
 * `approved`: los lectores de evidencia la leen como no aprobada. La escriben los endpoints de las Tareas 9 y 10.
 */
import { EventStatus, Prisma, ProviderType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import { OPCIONES_DE_TRANSACCION_DEL_INTENTO, candadoDeIntento, llaveDeIntento } from './candadoDeIntento'

export const EVENTO_REVERSO = (attemptId: string) => `blumon-tpv-reverso-${attemptId}`
export const TIPO_REVERSO = 'REVERSO_TERMINAL'
/**
 * Blumon sólo acepta el reverso antes de ~60 s desde la venta (medido: 11 y ~25 s entran, 63 s da TX_007). Pasado este
 * margen, una lápida que sigue `reversing` se vence a `reverse_unconfirmed` y el aviso retenido se libera: crea el cobro con
 * `reversoIncierto` y alarma. H14: no impide que la lápida pase DESPUÉS a `reversed` — un REVERSADA hecho dentro del minuto
 * puede llegar tarde por la cola durable de la terminal (lo decide la Tarea 10).
 */
export const VENTANA_DEL_REVERSO_MS = 5 * 60_000
export type EstadoDelReverso = 'reversing' | 'reversed' | 'reverse_failed' | 'reverse_unconfirmed' | 'contradiction'
const ESTADOS: readonly EstadoDelReverso[] = ['reversing', 'reversed', 'reverse_failed', 'reverse_unconfirmed', 'contradiction']
/** Estados en que el intento NO puede tener dinero nuevo. */
export const ESTADOS_QUE_BLOQUEAN: EstadoDelReverso[] = ['reversing', 'reversed']
/** Cuántas lápidas vence la red de 30 s por pase. */
const LOTE_DE_VENCIMIENTO = 100

export class IntentoConReverso extends ConflictError {
  constructor(
    readonly estado: 'reversing' | 'reversed',
    readonly lapidaCreadaEn: Date,
  ) {
    super(
      estado === 'reversing'
        ? 'La terminal está reversando este cobro: no se registra mientras el banco confirma el reverso.'
        : 'La terminal reversó este cobro con el banco: no hay dinero que registrar.',
      estado === 'reversing' ? 'ATTEMPT_REVERSAL_IN_PROGRESS' : 'ATTEMPT_REVERSED',
      { estado },
    )
    this.name = 'IntentoConReverso'
  }
}

/** La lápida del intento, o null. Un `estado` que no es de la lista se lee como «sin lápida» (sólo la escribe este servidor). */
export async function leerLapida(
  db: Pick<Prisma.TransactionClient, 'providerEventLog'>,
  attemptId: string,
): Promise<{ id: string; estado: EstadoDelReverso; createdAt: Date; payload: Record<string, unknown> } | null> {
  const fila = await db.providerEventLog.findUnique({
    where: { provider_eventId: { provider: ProviderType.PAYMENT_PROCESSOR, eventId: EVENTO_REVERSO(attemptId) } },
    select: { id: true, createdAt: true, payload: true, type: true },
  })
  if (!fila || fila.type !== TIPO_REVERSO) return null
  const payload =
    fila.payload && typeof fila.payload === 'object' && !Array.isArray(fila.payload) ? (fila.payload as Record<string, unknown>) : {}
  const estado = ESTADOS.find(e => e === payload.estado)
  return estado ? { id: fila.id, estado, createdAt: fila.createdAt, payload } : null
}

/** Dentro de la transacción que YA tomó candadoDeIntento(llave). */
export async function exigirIntentoSinReverso(tx: Pick<Prisma.TransactionClient, 'providerEventLog'>, llave: string): Promise<void> {
  const lapida = await leerLapida(tx, llave)
  if (lapida && ESTADOS_QUE_BLOQUEAN.includes(lapida.estado)) {
    throw new IntentoConReverso(lapida.estado as 'reversing' | 'reversed', lapida.createdAt)
  }
}

/**
 * Bajo su propio candadoDeIntento: una lápida `reversing` más vieja que VENTANA_DEL_REVERSO_MS pasa a `reverse_unconfirmed`.
 * Devuelve true si la lápida del intento quedó (o ya estaba) en `reverse_unconfirmed`.
 */
export async function vencerReversoSinRespuesta(attemptId: string, ahora: Date = new Date()): Promise<boolean> {
  const llave = llaveDeIntento(attemptId) // H17: la misma llave del candado de los registradores
  if (!llave) return false
  return prisma.$transaction(async tx => {
    await candadoDeIntento(tx, llave)
    const lapida = await leerLapida(tx, llave)
    if (!lapida) return false
    if (lapida.estado === 'reverse_unconfirmed') return true
    if (lapida.estado !== 'reversing' || ahora.getTime() - lapida.createdAt.getTime() < VENTANA_DEL_REVERSO_MS) return false
    await tx.providerEventLog.update({
      where: { id: lapida.id },
      data: { payload: { ...lapida.payload, estado: 'reverse_unconfirmed', status: 'reverse_unconfirmed' } as Prisma.InputJsonValue },
    })
    logger.warn('⚠️ [Blumon reverso] La terminal no confirmó el reverso dentro de la ventana — la lápida queda reverse_unconfirmed', {
      attemptId: llave,
      lapidaCreadaEn: lapida.createdAt.toISOString(),
    })
    return true
  }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)
}

/**
 * Dentro de la transacción que YA tomó candadoDeIntento: ¿el cobro que entra es de Blumon? Decide con lo que el registrador
 * resolvió del COBRO (nunca con la marca del aparato): trae `blumonOperationNumber` (sólo lo produce Blumon), o su afiliación
 * definitiva es de un `PaymentProvider` con `code = 'BLUMON'`. Sin ninguno de los dos no mira la lápida (límite conocido).
 */
export async function esCobroDeBlumon(
  tx: Pick<Prisma.TransactionClient, 'merchantAccount'>,
  cobro: { merchantAccountId?: string; blumonOperationNumber?: number },
): Promise<boolean> {
  if (cobro.blumonOperationNumber) return true
  if (!cobro.merchantAccountId) return false
  const afiliacion = await tx.merchantAccount.findUnique({
    where: { id: cobro.merchantAccountId },
    select: { provider: { select: { code: true } } },
  })
  return afiliacion?.provider.code === 'BLUMON'
}

/**
 * Para la red de 30 s: hasta 100 lápidas `type = TIPO_REVERSO` con `payload.estado = 'reversing'` y `createdAt` más vieja que
 * la ventana (índice `[type, createdAt]`); a cada una le aplica `vencerReversoSinRespuesta`. Devuelve cuántas venció.
 */
export async function vencerLapidasSinRespuesta(ahora: Date = new Date()): Promise<number> {
  // ponytail: rango sobre TODAS las lápidas viejas del índice [type, createdAt] filtrando el JSON; los reversos son raros.
  // Si un día son muchos, acotar por abajo (p. ej. 24 h) o mover el estado a una columna.
  const vencibles = await prisma.providerEventLog.findMany({
    where: {
      provider: ProviderType.PAYMENT_PROCESSOR,
      type: TIPO_REVERSO,
      status: EventStatus.PROCESSED,
      createdAt: { lt: new Date(ahora.getTime() - VENTANA_DEL_REVERSO_MS) },
      payload: { path: ['estado'], equals: 'reversing' },
    },
    orderBy: { createdAt: 'asc' },
    take: LOTE_DE_VENCIMIENTO,
    select: { id: true, attemptId: true },
  })
  let vencidas = 0
  for (const lapida of vencibles) {
    try {
      if (lapida.attemptId && (await vencerReversoSinRespuesta(lapida.attemptId, ahora))) vencidas++
    } catch (error) {
      logger.error('❌ [Blumon reverso] No se pudo vencer la lápida — se reintenta en el siguiente pase', {
        lapidaId: lapida.id,
        attemptId: lapida.attemptId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return vencidas
}
