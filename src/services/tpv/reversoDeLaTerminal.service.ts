/**
 * SDK propio, fase 1 (Tarea 7): la LÁPIDA del reverso de la terminal.
 *
 * Una fila de `ProviderEventLog` por intento (`eventId = EVENTO_REVERSO(attemptId)`, única por `@@unique([provider, eventId])`)
 * que anota que la terminal va a reversar (`reversing`) o ya reversó (`reversed`) el cobro con Blumon. Mientras diga eso, ningún
 * cobro de BLUMON del intento nace: los dos registradores la consultan bajo el candado del intento, el mismo que toma el permiso
 * del reverso (Tarea 9), así que permiso y registro quedan serializados. Un cobro de AngelPay la ignora siempre.
 *
 * Forma: `type TIPO_REVERSO`, `status PROCESSED`, `attemptId`, `venueId`, `terminalId` (FK a `Terminal.id`, o null) y
 * `payload { estado, status: estado, terminalKey, permisoEn?, resultado?, staffId?, resultadoEn?, paymentId? }`. El `status`
 * del payload nunca es `approved`: los lectores de evidencia la leen como no aprobada. La escriben los endpoints de las Tareas 9
 * y 10.
 */
import { EventStatus, Prisma, ProviderType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { terminalIdentityKey } from '@/utils/terminalSerial'
import { terminalPaymentService } from '../terminal-payment.service'
import { OPCIONES_DE_TRANSACCION_DEL_INTENTO, candadoDeIntento, llaveDeIntento } from './candadoDeIntento'
import { dineroConEstaLlaveSql, hayDineroConEstaLlaveSql } from './evidenciaPositivaSql'
import { tipoDeEvidencia } from './segundaCaptura'

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
): Promise<{
  id: string
  estado: EstadoDelReverso
  createdAt: Date
  venueId: string | null
  attemptId: string | null
  payload: Record<string, unknown>
} | null> {
  const fila = await db.providerEventLog.findUnique({
    where: { provider_eventId: { provider: ProviderType.PAYMENT_PROCESSOR, eventId: EVENTO_REVERSO(attemptId) } },
    select: { id: true, createdAt: true, payload: true, type: true, venueId: true, attemptId: true },
  })
  if (!fila || fila.type !== TIPO_REVERSO) return null
  const payload =
    fila.payload && typeof fila.payload === 'object' && !Array.isArray(fila.payload) ? (fila.payload as Record<string, unknown>) : {}
  const estado = ESTADOS.find(e => e === payload.estado)
  return estado ? { id: fila.id, estado, createdAt: fila.createdAt, venueId: fila.venueId, attemptId: fila.attemptId, payload } : null
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

/** Sin vínculo, de otro negocio o de otra terminal: indistinguibles (no se le dice a una terminal qué intentos tiene otra). */
const intentoNoEncontrado = () => new NotFoundError('El servidor no conoce ese intento para esta terminal.', 'ATTEMPT_NOT_FOUND')

/**
 * Tarea 9: ¿este intento es de ESTA terminal y se puede reversar con lápida? En este orden: vínculo S1 (un cobro LOCAL no tiene,
 * y no necesita lápida: el aviso nunca crea su cobro), mismo negocio, misma terminal (404 en los tres) y ningún aviso de AngelPay
 * del intento (409 `ATTEMPT_NOT_BLUMON`: la lápida sólo detiene cobros de Blumon, así que sobre AngelPay no tendría efecto). Los
 * dos procesadores comparten `provider PAYMENT_PROCESSOR`; los distingue el prefijo del `eventId`. No mira la marca del aparato
 * ni sus afiliaciones. Corre SIEMPRE antes de mirar una lápida existente. Lo reusa el resultado del reverso (Tarea 10).
 */
export async function exigirPertenencia(
  tx: Pick<Prisma.TransactionClient, 'terminalPaymentAttemptLink' | 'providerEventLog'>,
  entrada: { venueId: string; attemptId: string; terminalSerial: string },
): Promise<{ requestId: string; terminalKey: string }> {
  const llave = llaveDeIntento(entrada.attemptId)
  const terminalKey = terminalIdentityKey(entrada.terminalSerial)
  if (!llave || !terminalKey) throw intentoNoEncontrado()
  const vinculo = await tx.terminalPaymentAttemptLink.findUnique({
    where: { attemptId: llave },
    select: { requestId: true, venueId: true, terminalId: true },
  })
  if (!vinculo || vinculo.venueId !== entrada.venueId || terminalIdentityKey(vinculo.terminalId) !== terminalKey) {
    throw intentoNoEncontrado()
  }
  const avisoDeAngelPay = await tx.providerEventLog.findFirst({
    where: { provider: ProviderType.PAYMENT_PROCESSOR, attemptId: llave, eventId: { startsWith: 'angelpay-' } },
    select: { id: true },
  })
  if (avisoDeAngelPay) {
    throw new ConflictError('Este intento es de AngelPay: el reverso con permiso es sólo de Blumon.', 'ATTEMPT_NOT_BLUMON')
  }
  return { requestId: vinculo.requestId, terminalKey }
}

/** H12: la columna `terminalId` de la lápida es FK a `Terminal.id` (la del token, si se resuelve en este negocio). */
async function terminalDelToken(
  tx: Pick<Prisma.TransactionClient, 'terminal'>,
  entrada: { venueId: string; terminalSerial: string },
): Promise<string | null> {
  const terminal = await tx.terminal.findFirst({
    where: { venueId: entrada.venueId, serialNumber: entrada.terminalSerial },
    select: { id: true },
  })
  return terminal?.id ?? null
}

/** El cobro del intento ya está registrado: la terminal muestra «Aprobado» y NO reversa. */
export class CobroYaRegistradoDelIntento extends ConflictError {
  constructor(
    readonly payment: { paymentId: string; amountCents: number | null; tipCents: number | null; authorizationNumber: string | null },
  ) {
    super('El cobro de este intento ya está registrado: no se reversa.', 'ATTEMPT_ALREADY_RECORDED', { payment })
    this.name = 'CobroYaRegistradoDelIntento'
  }
}

/**
 * Hay dinero con la llave del intento que no es «el cobro registrado»: la terminal NO reversa y muestra «En duda». `tipo` y
 * `paymentStatus` sólo se publican si ese dinero es atribuible a esta terminal (S6); de otro negocio, solicitud o terminal van
 * en null — nada de un pago ajeno se publica, sólo que existe.
 */
export class EvidenciaPendienteDelIntento extends ConflictError {
  constructor(
    readonly evidencia: {
      paymentStatus: string | null
      tipo: 'POSSIBLE_SECOND_CAPTURE' | 'POSSIBLE_REFERENCE_COLLISION' | null
    },
  ) {
    super('Hay dinero con la llave de este intento que falta conciliar: no se reversa.', 'ATTEMPT_HAS_PENDING_EVIDENCE', { evidencia })
    this.name = 'EvidenciaPendienteDelIntento'
  }
}

/**
 * Tarea 9 · `POST …/attempts/:attemptId/reverso/intencion`: la terminal pide permiso ANTES de mandarle el reverso a Blumon
 * (spec §16.1). Bajo el candado del intento —el mismo de los dos registradores y del aviso, así que nada de dinero del intento
 * nace mientras se decide—: pertenencia → ¿S6 dice RECORDED? (409 «Aprobado») → ¿hay otro dinero con la llave? (409 «En duda»)
 * → la lápida existente (su estado, sin reescribirla: H21) o una nueva `reversing`. En los dos 409 no se escribe lápida.
 * H17: candado, lápida y consultas con la llave canónica (`llaveDeIntento`).
 */
export async function pedirPermisoDeReverso(entrada: {
  venueId: string
  attemptId: string
  terminalSerial: string
}): Promise<{ estado: EstadoDelReverso; eventLogId: string }> {
  const llave = llaveDeIntento(entrada.attemptId)
  if (!llave) throw intentoNoEncontrado()
  return prisma.$transaction(async tx => {
    await candadoDeIntento(tx, llave)
    const { terminalKey } = await exigirPertenencia(tx, { ...entrada, attemptId: llave })

    // S6 lee con su propia conexión: sigue siendo sano porque ningún registrador puede confirmar mientras este candado esté tomado.
    const s6 = await terminalPaymentService.consultarIntentoDeTerminal({ ...entrada, attemptId: llave })
    const propio = s6?.attempt.paymentId
      ? await tx.payment.findUnique({
          where: { id: s6.attempt.paymentId },
          select: { id: true, status: true, processorData: true, authorizationNumber: true },
        })
      : null
    if (s6?.attempt.outcome === 'RECORDED' && propio) {
      throw new CobroYaRegistradoDelIntento({
        paymentId: propio.id,
        amountCents: s6.attempt.amountCents,
        tipCents: s6.attempt.tipCents,
        authorizationNumber: propio.authorizationNumber,
      })
    }
    const [dinero] = await tx.$queryRaw<{ hay: boolean }[]>`SELECT ${hayDineroConEstaLlaveSql(llave)} AS "hay"`
    if (dinero?.hay) {
      throw new EvidenciaPendienteDelIntento({ paymentStatus: propio?.status ?? null, tipo: propio ? tipoDeEvidencia(propio) : null })
    }

    const lapida = await leerLapida(tx, llave)
    if (lapida) return { estado: lapida.estado, eventLogId: lapida.id }
    // H12: la columna es FK a `Terminal.id` (la del token, si se resuelve en este negocio); la identidad va en `terminalKey`.
    const terminal = await terminalDelToken(tx, entrada)
    const permisoEn = new Date()
    const creada = await tx.providerEventLog.create({
      data: {
        provider: ProviderType.PAYMENT_PROCESSOR,
        eventId: EVENTO_REVERSO(llave),
        type: TIPO_REVERSO,
        attemptId: llave,
        venueId: entrada.venueId,
        terminalId: terminal,
        status: EventStatus.PROCESSED,
        processedAt: permisoEn,
        payload: { estado: 'reversing', status: 'reversing', terminalKey, permisoEn: permisoEn.toISOString() },
      },
      select: { id: true },
    })
    logger.info('🔁 [Blumon reverso] La terminal pidió permiso para reversar — lápida reversing', {
      attemptId: llave,
      venueId: entrada.venueId,
      eventLogId: creada.id,
    })
    return { estado: 'reversing', eventLogId: creada.id }
  }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)
}

/** Lo que la terminal reporta del reverso (Tarea 10). */
export type ResultadoDelReverso = { descripcion?: string; codigo?: string; operationNumber?: number | string; reversadoEn: string }

/** Blumon confirmó el reverso: «REVERSADA» o los códigos de reverso hecho (`TX_014`, `TX_013`). Lo demás: no se reversó. */
export function esReversoConfirmado(r: ResultadoDelReverso): boolean {
  return r.descripcion?.trim().toUpperCase() === 'REVERSADA' || r.codigo === 'TX_014' || r.codigo === 'TX_013'
}

const ESTADOS_FINALES: readonly EstadoDelReverso[] = ['reversed', 'reverse_failed', 'contradiction']

/**
 * Tarea 10 · `POST …/attempts/:attemptId/reverso/resultado`: la terminal reporta cómo le fue al reverso. Bajo el candado del
 * intento (H17: llave canónica):
 *  · autoriza con la identidad GUARDADA en la lápida (negocio, intento y `terminalKey`), no con la configuración de ahora;
 *    sin lápida (la terminal no pudo pedir permiso), con `exigirPertenencia` (Tarea 9);
 *  · H16: un desenlace final no se reescribe — el mismo resultado (por clase: confirmado ≡ `reversed`/`contradiction`,
 *    no confirmado ≡ `reverse_failed`) contesta el estado guardado; uno distinto, 409 `REVERSAL_RESULT_CONFLICT`;
 *  · si no: confirmado sin dinero del intento ⇒ `reversed` (los avisos de venta de Blumon retenidos se sellan sin dinero);
 *    confirmado con dinero ⇒ `contradiction` (el dinero NO se toca: lo resuelve una persona); no confirmado ⇒ `reverse_failed`
 *    (los avisos retenidos quedan con turno ya y, después del commit, crean el cobro: el dinero sí existe).
 * Vale igual desde `reversing`, sin lápida o desde `reverse_unconfirmed` (H14: la cola durable de la terminal entrega tarde a
 * propósito). Nada de AngelPay (`angelpay-%`) se toca aquí: sigue en manos de su receptor y su worker.
 */
export async function registrarResultadoDelReverso(entrada: {
  venueId: string
  attemptId: string
  terminalSerial: string
  staffId?: string
  resultado: ResultadoDelReverso
}): Promise<{ estado: EstadoDelReverso; eventLogId: string; paymentId?: string }> {
  const llave = llaveDeIntento(entrada.attemptId)
  if (!llave) throw intentoNoEncontrado()
  const confirmado = esReversoConfirmado(entrada.resultado)

  const decision = await prisma.$transaction(async tx => {
    await candadoDeIntento(tx, llave)
    const lapida = await leerLapida(tx, llave)
    const terminalKey = terminalIdentityKey(entrada.terminalSerial)
    if (lapida) {
      if (lapida.venueId !== entrada.venueId || lapida.attemptId !== llave || !terminalKey || lapida.payload.terminalKey !== terminalKey) {
        throw intentoNoEncontrado()
      }
      if (ESTADOS_FINALES.includes(lapida.estado)) {
        if (confirmado === (lapida.estado === 'reverse_failed')) {
          throw new ConflictError('El reverso de este intento ya tiene otro desenlace.', 'REVERSAL_RESULT_CONFLICT', {
            estado: lapida.estado,
          })
        }
        const paymentId = typeof lapida.payload.paymentId === 'string' ? lapida.payload.paymentId : undefined
        return { estado: lapida.estado, eventLogId: lapida.id, paymentId, avisos: [], nuevo: false }
      }
    } else {
      await exigirPertenencia(tx, { ...entrada, attemptId: llave })
    }

    // «Dinero del intento» = la regla de la llave (cualquier estado, cualquier negocio). El COMPLETED primero.
    const pagos = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT p."id", p."status"::text AS "status" FROM "Payment" p
      WHERE p."id" IN (${dineroConEstaLlaveSql(llave)})
      ORDER BY (p."status" = 'COMPLETED') DESC, p."createdAt" ASC
      LIMIT 10`
    const estado: EstadoDelReverso = !confirmado ? 'reverse_failed' : pagos.length > 0 ? 'contradiction' : 'reversed'
    const paymentId = estado === 'contradiction' ? pagos[0].id : undefined
    const ahora = new Date()
    const { descripcion, codigo, operationNumber, reversadoEn } = entrada.resultado
    const payload = {
      ...(lapida?.payload ?? { terminalKey }),
      estado,
      status: estado,
      resultado: { descripcion, codigo, operationNumber, reversadoEn },
      ...(entrada.staffId ? { staffId: entrada.staffId } : {}),
      resultadoEn: ahora.toISOString(),
      ...(paymentId ? { paymentId } : {}),
    } as Prisma.InputJsonValue
    const eventLogId = lapida
      ? (await tx.providerEventLog.update({ where: { id: lapida.id }, data: { payload }, select: { id: true } })).id
      : (
          await tx.providerEventLog.create({
            data: {
              provider: ProviderType.PAYMENT_PROCESSOR,
              eventId: EVENTO_REVERSO(llave),
              type: TIPO_REVERSO,
              attemptId: llave,
              venueId: entrada.venueId,
              terminalId: await terminalDelToken(tx, entrada),
              status: EventStatus.PROCESSED,
              processedAt: ahora,
              payload,
            },
            select: { id: true },
          })
        ).id

    // Los avisos de VENTA de Blumon del intento (la lápida también empieza con `blumon-tpv-`, pero es de otro tipo).
    const avisosDeBlumon = {
      provider: ProviderType.PAYMENT_PROCESSOR,
      attemptId: llave,
      eventId: { startsWith: 'blumon-tpv-' },
      type: 'VENTA',
      status: EventStatus.PENDING,
    } satisfies Prisma.ProviderEventLogWhereInput
    let avisos: { id: string; payload: Prisma.JsonValue }[] = []
    if (estado === 'reversed') {
      await tx.providerEventLog.updateMany({
        where: avisosDeBlumon,
        data: { status: EventStatus.PROCESSED, errorReason: 'REVERSED_BY_TERMINAL', processedAt: ahora },
      })
      await tx.activityLog.create({
        data: {
          action: 'PAYMENT_REVERSED_BY_TERMINAL',
          entity: 'PaymentAttempt',
          entityId: llave,
          venueId: entrada.venueId,
          staffId: entrada.staffId,
          data: { attemptId: llave, eventLogId, resultado: { descripcion, codigo, operationNumber, reversadoEn } },
        },
      })
    } else if (estado === 'contradiction') {
      await tx.activityLog.create({
        data: {
          action: 'TERMINAL_REVERSAL_CONTRADICTION',
          entity: 'Payment',
          entityId: paymentId,
          venueId: entrada.venueId,
          staffId: entrada.staffId,
          data: {
            attemptId: llave,
            eventLogId,
            otrosPagos: pagos.slice(1).map(p => p.id),
            resultado: { descripcion, codigo, operationNumber, reversadoEn },
          },
        },
      })
    } else {
      // Con turno YA dentro de la transacción: si la llamada de después del commit falla, la red de 30 s lo toma.
      const retenidos = { ...avisosDeBlumon, errorReason: 'HELD_BY_REVERSAL' }
      // ponytail: se llaman ya hasta 10 (un intento trae uno, a lo más un par); el resto lo toma la red con el mismo turno.
      avisos = await tx.providerEventLog.findMany({
        where: retenidos,
        select: { id: true, payload: true },
        orderBy: { createdAt: 'asc' },
        take: 10,
      })
      await tx.providerEventLog.updateMany({ where: retenidos, data: { nextAttemptAt: ahora } })
    }
    return { estado, eventLogId, paymentId, avisos, nuevo: true }
  }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)

  const { estado, eventLogId, paymentId } = decision
  if (decision.nuevo) {
    const contexto = { attemptId: llave, venueId: entrada.venueId, eventLogId, codigo: entrada.resultado.codigo ?? null }
    if (estado === 'contradiction') {
      logger.error('🚨 [Reverso] La terminal dice que reversó, pero el cobro ya está registrado — no se toca: lo resuelve una persona', {
        ...contexto,
        paymentId,
      })
    } else {
      logger.info(`🔁 [Blumon reverso] Resultado del reverso — lápida ${estado}`, { ...contexto, avisosRetenidos: decision.avisos.length })
    }
  }
  if (decision.avisos.length > 0) {
    const { reconcileBlumonEvent } = await import('./blumon-webhook.service')
    for (const aviso of decision.avisos) {
      try {
        await reconcileBlumonEvent(aviso.id, aviso.payload as unknown as Parameters<typeof reconcileBlumonEvent>[1])
      } catch (error) {
        logger.error('❌ [Blumon reverso] El aviso retenido no pudo crear el cobro — la red de 30 s lo reintenta', {
          attemptId: llave,
          eventLogId: aviso.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return { estado, eventLogId, ...(paymentId ? { paymentId } : {}) }
}
