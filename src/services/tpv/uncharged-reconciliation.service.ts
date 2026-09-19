/**
 * La declaración del CAJERO: «ya revisé la terminal y este cobro NO se cobró» (plan 18-sep, Task 3).
 *
 * 🔴 Por qué existe, con el incidente enfrente: el 18-sep Testarudo estuvo 26 minutos sin poder cobrar con una
 * fila `UNKNOWN` que apartaba la terminal. La cerca hizo su trabajo —cero cobros dobles— pero el cajero no tenía
 * ninguna salida: la única fue cerrar la fila A MANO en Postgres de producción. Esto es esa salida, con nombre y
 * rastro.
 *
 * Hermana de `resolveNoInstrument` y SEPARADA a propósito (aquel archivo NO se toca: entró a producción el
 * 17-sep). Las diferencias son el encargo, no un descuido:
 *
 *  | | `resolveNoInstrument` (17-sep) | esto |
 *  |---|---|---|
 *  | quién declara | la TERMINAL, con su JWT | el POS, con la sesión del cajero |
 *  | sobre qué | un INTENTO ligado (`TerminalPaymentAttemptLink`) | una SOLICITUD — las filas legacy no tienen intento |
 *  | qué afirma | nadie presentó tarjeta | una persona MIRÓ la pantalla y no hubo cobro |
 *  | permiso | `payments:resolve-no-instrument` (gerencia) | `payments:reconcile-uncharged` (el cajero) |
 *
 * Escriben el MISMO desenlace —`FAILED` + `OPERATOR_RECONCILED_NO_CHARGE`— porque es el que sale de los tres
 * candados: el bloqueo heredado, el estricto (el código está en `CODIGOS_SIN_COBRO`) y el índice único parcial,
 * que sólo cubre PENDING/SENT/CANCEL_REQUESTED/UNKNOWN. Verificado contra los predicados, no supuesto.
 *
 * 🔴 La tensión que este diseño asume: la declaración de una persona OCUPA EL LUGAR de una prueba técnica de que
 * la ejecución cesó, que hoy el APK instalado no sabe emitir. Por eso la evidencia es de clase OPERADOR, queda
 * auditada con su nombre, se veta ante cualquier señal positiva y exige que la terminal haya vuelto. Si el dinero
 * aparece después, el cierre común lo registra y manda sobre la palabra del cajero.
 */
import { createHash } from 'crypto'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { evaluatePermissionList, hasPermission } from '../../lib/permissions'
import { candadoDeIntento, candadoDeSolicitud, llaveDeIntento, OPCIONES_DE_TRANSACCION_DEL_INTENTO } from './candadoDeIntento'
import { estadoBancarioSql } from './estadoBancario'
import { PATRON_SQL_TRIM_COMO_JS } from '../../utils/terminalSerial'
import { hayEvidenciaDeConciliacionSql, sinEvidenciaPositivaSql } from './evidenciaPositivaSql'
import { sondaReportoActiva } from './sondaActiva'

export const RECONCILE_UNCHARGED_PERMISSION = 'payments:reconcile-uncharged'

/** Estricto: la identidad NUNCA viene en el cuerpo. Un `staffId` de más es un rechazo, no un dato. */
const schema = z
  .object({
    requestId: z.string().min(1),
    resolutionId: z.string().uuid(),
    statement: z.literal('UNCHARGED_VERIFIED'),
    statementVersion: z.literal(1),
  })
  .strict()

export class UnchargedReconciliationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(
      code === 'POSITIVE_EVIDENCE_EXISTS'
        ? 'Este cobro sí tiene señales de haber pasado. No lo declares: consulta su resultado.'
        : code === 'EXECUTION_STILL_ACTIVE'
          ? 'La terminal dice que este cobro sigue en curso. Espera unos segundos y vuelve a consultar.'
          : code === 'TERMINAL_NOT_BACK'
            ? 'La terminal todavía no ha vuelto. Espera a que se reconecte para poder declararlo.'
            : code === 'NOT_ALLOWED'
              ? 'No tienes permiso para declarar que un cobro no pasó. Pídeselo a tu administrador.'
              : code === 'RESOLUTION_CONFLICT'
                ? 'Esta declaración ya se registró con otros datos. Vuelve a consultar el cobro.'
                : code === 'ATTEMPT_NOT_FOUND'
                  ? 'No encontré ese cobro en este negocio.'
                  : 'No se pudo declarar este cobro. Conserva el pendiente y consulta su resultado.',
    )
  }
}

export type UnchargedReconciliation = {
  id: string
  kind: 'UNCHARGED_VERIFIED'
  acceptedAt: string
  bodyHash: string
  staffId: string
  staffVenueId: string
  statementVersion: number
  source: string
  previousRequest: { status: string; failureCode: string | null }
}

export function readUnchargedReconciliation(value: unknown): UnchargedReconciliation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as UnchargedReconciliation
  return r.kind === 'UNCHARGED_VERIFIED' && typeof r.id === 'string' ? r : null
}

/**
 * ¿Esta persona, en este local, tiene el permiso EFECTIVO? La MISMA regla de `checkPermission.middleware.ts`:
 * con conjunto asignado se evalúa ESA lista (reemplaza al rol); si no, rol + extras del venue − negados.
 * Copiada del precedente a propósito y no compartida: son dos archivos que evolucionan aparte, y una
 * abstracción común haría que cambiar el permiso de uno moviera el del otro en silencio.
 */
async function miembroConPermiso(
  tx: Prisma.TransactionClient,
  venueId: string,
  staffId: string,
): Promise<{ id: string; staffId: string; permitido: boolean } | null> {
  const sv = await tx.staffVenue.findFirst({
    where: { venueId, staffId, active: true, staff: { active: true } },
    select: { id: true, staffId: true, role: true, permissionSetId: true, permissionSet: true },
  })
  if (!sv) return null
  let permitido: boolean
  if (sv.permissionSetId && sv.permissionSet) {
    permitido = evaluatePermissionList((sv.permissionSet as { permissions: string[] }).permissions, RECONCILE_UNCHARGED_PERMISSION)
  } else {
    const custom = await tx.venueRolePermission.findUnique({
      where: { venueId_role: { venueId, role: sv.role } },
      select: { permissions: true, deniedPermissions: true },
    })
    permitido = hasPermission(sv.role, custom?.permissions ?? null, RECONCILE_UNCHARGED_PERMISSION, custom?.deniedPermissions ?? null)
  }
  return { id: sv.id, staffId: sv.staffId, permitido }
}

/** Igual que `TERMINAL_ALIVE_WINDOW_MS` del servicio: un latido de hace más de 5 min ya no dice nada del ahora. */
const VENTANA_LATIDO_VIVO_MS = 5 * 60_000

/**
 * ¿La terminal VOLVIÓ? Dos caminos, y el segundo es el encargo de Codex («definir cómo se observa el retorno
 * para todos los estados admitidos»):
 *
 *  1. `terminalReturnedAt` sellado — pero el barrido SÓLO lo sella sobre filas `UNKNOWN`, así que una `TIMED_OUT`
 *     legacy nunca lo tendría y quedaría inelegible PARA SIEMPRE: justo las que hay que poder limpiar hoy.
 *  2. La terminal está VIVA ahora (latido de los últimos 5 min) y ese latido es posterior al vencimiento de la
 *     solicitud. Es la misma señal que usa el barrido, leída en vivo en vez de diferida.
 *
 * 🔴 Y como allá: esto acredita CONECTIVIDAD, nunca que la ejecución terminó. Es un requisito NECESARIO de la
 * declaración, no la prueba — la prueba la pone la persona que miró la pantalla, y por eso se audita con su nombre.
 * Ampliar el barrido para sellar también TIMED_OUT habría tocado el camino que ya corre en producción.
 */
async function terminalVolvio(
  tx: Prisma.TransactionClient,
  row: { terminalId: string; terminalReturnedAt: Date | null; expiresAt: Date },
  ahora: Date,
): Promise<boolean> {
  if (row.terminalReturnedAt) return true
  const terminal = await tx.terminal.findFirst({
    where: {
      OR: [
        { serialNumber: { equals: row.terminalId, mode: 'insensitive' } },
        { serialNumber: { equals: `AVQD-${row.terminalId}`, mode: 'insensitive' } },
      ],
    },
    select: { lastHeartbeat: true },
  })
  const latido = terminal?.lastHeartbeat
  if (!latido) return false
  // 🔴 P1 de Codex (18-sep): el latido lo reporta el APARATO y no tenía límite superior — un reloj adelantado
  // una hora satisfacía las dos comparaciones y destrabab un cobro en vuelo. Ahora se exige que caiga DENTRO de
  // la ventana por los dos lados: ni viejo ni del futuro.
  const edadMs = ahora.getTime() - latido.getTime()
  if (edadMs < 0 || edadMs >= VENTANA_LATIDO_VIVO_MS) return false
  return latido.getTime() > row.expiresAt.getTime()
}

/** Las señales del sobre de la terminal que, solas, ya afirman un cobro. */
const SENALES_POSITIVAS_DEL_SOBRE = ['paymentId', 'authorizationCode', 'transactionId', 'reference', 'readMode'] as const

/**
 * 🔴 P1 de la auditoría de Codex (18-sep): esto FALTABA, y el precedente sí lo tiene.
 *
 * Un `success` que el cierre no pudo acreditar queda UNKNOWN con su afirmación guardada en
 * `resultJson.claimedSuccess` — exactamente el sobre de una terminal que dijo «cobré» y cuyo pago todavía no
 * se pudo ligar. Sin esta comprobación la declaración pasaba por encima de esa afirmación. Un objeto con
 * todos los campos vacíos no afirma nada.
 */
function afirmaCobro(claimedSuccess: unknown): boolean {
  if (!claimedSuccess || typeof claimedSuccess !== 'object' || Array.isArray(claimedSuccess)) return false
  return Object.values(claimedSuccess as Record<string, unknown>).some(v => v !== undefined && v !== null && v !== '' && v !== false)
}

/**
 * 🔴 P1 de Codex (18-sep): los ESTADOS admitidos van en lista explícita.
 *
 * Antes sólo se excluía `PENDING` y se confiaba en `desenlaceCanonico`, pero `SENT` y `CANCEL_REQUESTED`
 * también son UNRESOLVED — y son cobros que la terminal puede estar ejecutando AHORA. Declarar sobre ellos
 * es exactamente el camino del cobro doble.
 */
const ESTADOS_DECLARABLES = new Set<string>(['UNKNOWN', 'TIMED_OUT'])

/**
 * 🔴 P1 de Codex (18-sep): las contradicciones de PROCEDENCIA también vetan.
 *
 * Un evento del procesador para un intento de esta solicitud que llegó a OTRO venue, que contradice el
 * vínculo, que trae el serial de OTRA terminal, o que el banco APROBÓ aunque no naciera `Payment`. Copiado
 * del precedente (`evidenciaQueVetaLaDeclaracion`) y ampliado a TODOS los intentos ligados, no a uno.
 */
async function contradiccionDeProcedencia(
  tx: Prisma.TransactionClient,
  attemptIds: string[],
  venueId: string,
  terminalId: string,
): Promise<boolean> {
  if (attemptIds.length === 0) return false
  const filas = await tx.$queryRaw<{ id: string }[]>`
    SELECT e."id" FROM "ProviderEventLog" e
    WHERE e."attemptId" IN (${Prisma.join(attemptIds)}) AND e."provider" = 'PAYMENT_PROCESSOR'
      AND (e."venueId" IS DISTINCT FROM ${venueId}
        OR e."errorReason" IN ('LINK_TERMINAL_MISMATCH', 'LINK_VENUE_MISMATCH')
        OR (nullif(regexp_replace(coalesce(e."payload"->'payload'->>'terminalSerial', ''), ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '') IS NOT NULL
          AND lower(regexp_replace(regexp_replace(e."payload"->'payload'->>'terminalSerial', ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '^AVQD-', '', 'i')) <> ${terminalId})
        OR ${estadoBancarioSql(Prisma.sql`coalesce(e."payload"->'payload'->'status', e."payload"->'status')`)} = 'APROBADO')
    LIMIT 1`
  return filas.length > 0
}

export async function reconcileUncharged(
  identity: { venueId: string; requestId: string; actorStaffId: string | null; source: string },
  raw: unknown,
): Promise<UnchargedReconciliation> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new UnchargedReconciliationError('ATTEMPT_NOT_ELIGIBLE')
  const declaration = parsed.data
  if (declaration.requestId !== identity.requestId) throw new UnchargedReconciliationError('ATTEMPT_NOT_ELIGIBLE')
  const bodyHash = createHash('sha256').update(JSON.stringify(declaration)).digest('hex')

  return prisma.$transaction(async tx => {
    // Candado por SOLICITUD (no sólo por intento): una fila legacy sin intento ligado también se concilia.
    await candadoDeSolicitud(tx, declaration.requestId)

    // 🔴 P1 de Codex (18-sep): el candado de solicitud NO serializa contra el ingreso del webhook, que toma
    // `candadoDeIntento`. Se enumeran los intentos DENTRO de la transacción y se toma su candado en orden
    // estable — el mismo orden que el registrador, para no invertir la jerarquía y crear un abrazo mortal.
    const vinculos = await tx.terminalPaymentAttemptLink.findMany({
      where: { requestId: declaration.requestId, venueId: identity.venueId },
      select: { attemptId: true },
    })
    const attemptIds = vinculos
      .map(v => llaveDeIntento(v.attemptId))
      .filter((a): a is string => Boolean(a))
      .sort()
    for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)

    const inicial = await tx.terminalPaymentRequest.findFirst({
      where: { requestId: declaration.requestId, venueId: identity.venueId },
    })
    if (!inicial) throw new UnchargedReconciliationError('ATTEMPT_NOT_FOUND', 404)

    // El candado de la orden va acotado al venue: una orden de otro negocio no se bloquea ni se acepta.
    // 🔴 P2 de Codex (18-sep): y su RESULTADO decide la pertenencia. `orderId` es una referencia BLANDA (sin
    // FK), así que puede apuntar a una orden inexistente o de otro negocio; antes se lanzaba el FOR UPDATE y
    // se seguía adelante aunque devolviera cero filas. El precedente sí lo comprueba.
    const ordenBloqueada = inicial.orderId
      ? await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "Order" WHERE "id" = ${inicial.orderId} AND "venueId" = ${identity.venueId} FOR UPDATE`
      : null
    await tx.$queryRaw`SELECT "id" FROM "TerminalPaymentRequest" WHERE "requestId" = ${declaration.requestId} AND "venueId" = ${identity.venueId} FOR UPDATE`

    const row = await tx.terminalPaymentRequest.findFirst({
      where: { requestId: declaration.requestId, venueId: identity.venueId },
    })
    if (!row) throw new UnchargedReconciliationError('ATTEMPT_NOT_FOUND', 404)
    // La orden tiene que seguir siendo la MISMA y tiene que existir en este negocio.
    if (row.orderId && (row.orderId !== inicial.orderId || ordenBloqueada?.length !== 1))
      throw new UnchargedReconciliationError('ATTEMPT_NOT_ELIGIBLE')

    // Replay idempotente ANTES de todo lo demás: repetir la misma declaración no re-audita ni reescribe.
    const existente = readUnchargedReconciliation(row.operatorReconciliation)
    if (existente) {
      if (existente.id !== declaration.resolutionId || existente.bodyHash !== bodyHash)
        throw new UnchargedReconciliationError('RESOLUTION_CONFLICT')
      return existente
    }

    // 🔴 AUTORIZACIÓN ANTES QUE ELEGIBILIDAD: quien no puede declarar recibe 403 sin enterarse del estado del cobro.
    const actor = identity.actorStaffId ? await miembroConPermiso(tx, identity.venueId, identity.actorStaffId) : null
    if (!actor || !actor.permitido) throw new UnchargedReconciliationError('NOT_ALLOWED', 403)

    // ELEGIBILIDAD
    const ahora = new Date()
    if (!(await terminalVolvio(tx, row, ahora))) throw new UnchargedReconciliationError('TERMINAL_NOT_BACK')
    if (sondaReportoActiva(row, ahora)) throw new UnchargedReconciliationError('EXECUTION_STILL_ACTIVE')

    const sobre =
      row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson)
        ? (row.resultJson as Record<string, unknown>)
        : {}
    const senalPositiva =
      sobre.status === 'success' ||
      sobre.approved === true ||
      SENALES_POSITIVAS_DEL_SOBRE.some(f => typeof sobre[f] === 'string' && sobre[f] !== '') ||
      // 🔴 P1 de Codex: la afirmación conservada de un `success` degradado. El precedente ya lo comprobaba.
      afirmaCobro(sobre.claimedSuccess)
    const retenidaPorLaVentana =
      row.failureCode === 'BANK_APPROVED_AWAITING_PAYMENT' || row.failureCode === 'PAYMENT_UNBOUND_AWAITING_REVIEW'

    // Las identidades del pago POR SOLICITUD: puntero, etiqueta legacy y fila.
    const pago = await tx.payment.findFirst({
      where: {
        OR: [
          { terminalPaymentRequestId: declaration.requestId },
          { venueId: identity.venueId, processorData: { path: ['terminalPaymentRequestId'], equals: declaration.requestId } },
          ...(row.paymentId ? [{ id: row.paymentId }] : []),
        ],
      },
      select: { id: true },
    })
    // 🔴 P1 de Codex: y POR INTENTO, sin limitar a COMPLETED. Un `Payment` PENDING con evidencia de colisión
    // vive con la llave del intento y sin columna de solicitud: por ahí se colaba la declaración.
    const pagoPorIntento =
      !pago && attemptIds.length > 0
        ? await tx.payment.findFirst({ where: { idempotencyKey: { in: attemptIds } }, select: { id: true } })
        : null
    if (pago || pagoPorIntento || row.paymentId || senalPositiva || retenidaPorLaVentana)
      throw new UnchargedReconciliationError('POSITIVE_EVIDENCE_EXISTS')

    // 🔴 P1 de Codex: contradicciones de procedencia del procesador (otro venue, otra terminal, aprobado sin Payment).
    if (await contradiccionDeProcedencia(tx, attemptIds, identity.venueId, row.terminalId))
      throw new UnchargedReconciliationError('POSITIVE_EVIDENCE_EXISTS')

    // 🔴 P1 de Codex: lista EXPLÍCITA de estados. `SENT` y `CANCEL_REQUESTED` también son UNRESOLVED y son
    // cobros que pueden seguir corriendo: declarar sobre ellos es el camino del cobro doble.
    if (!ESTADOS_DECLARABLES.has(row.status)) throw new UnchargedReconciliationError('ATTEMPT_NOT_ELIGIBLE')
    const { desenlaceCanonico } = await import('../terminal-payment.service')
    if (desenlaceCanonico(row).outcome !== 'UNRESOLVED') throw new UnchargedReconciliationError('ATTEMPT_NOT_ELIGIBLE')

    const saved: UnchargedReconciliation = {
      id: declaration.resolutionId,
      kind: 'UNCHARGED_VERIFIED',
      acceptedAt: new Date().toISOString(),
      bodyHash,
      staffId: actor.staffId,
      staffVenueId: actor.id,
      statementVersion: declaration.statementVersion,
      source: identity.source,
      previousRequest: { status: row.status, failureCode: row.failureCode },
    }

    // CAS sobre el estado LEÍDO y sin Payment, revalidando la evidencia EN LA PROPIA ESCRITURA: si un aprobado o
    // un pago entran entre el veto y este UPDATE, devuelve 0 y no se declara nada.
    const sobreDeclarado = {
      ...sobre,
      requestId: declaration.requestId,
      status: 'failed',
      outcomeEvidence: 'OPERATOR_RECONCILED',
      // 🔴 Mensaje PROPIO: el de gerencia dice «no se presentó tarjeta», que aquí sería falso — el cliente sí
      // presentó la tarjeta; lo que no hubo fue cobro. Los POS pintan ESTE texto, no uno hardcodeado.
      errorMessage: 'El cajero revisó la terminal y confirmó que este cobro no pasó. Se puede volver a cobrar.',
      operatorReconciliation: saved,
    }
    const cas = await tx.$executeRaw`
      UPDATE "TerminalPaymentRequest"
      SET "status" = 'FAILED', "failureCode" = 'OPERATOR_RECONCILED_NO_CHARGE', "cancelDisposition" = NULL,
          "resultJson" = ${JSON.stringify(sobreDeclarado)}::jsonb,
          "operatorReconciliation" = ${JSON.stringify(saved)}::jsonb,
          "updatedAt" = (NOW() AT TIME ZONE 'UTC')
      WHERE "id" = ${row.id} AND "status" = ${row.status}::"TerminalPaymentRequestStatus" AND "paymentId" IS NULL
        AND ${sinEvidenciaPositivaSql(declaration.requestId, identity.venueId)}
        AND NOT ${hayEvidenciaDeConciliacionSql(declaration.requestId, identity.venueId)}`
    if (cas !== 1) throw new UnchargedReconciliationError('ATTEMPT_NOT_ELIGIBLE')

    // Asiento DENTRO de la transacción: una declaración = un asiento.
    await tx.activityLog.create({
      data: {
        action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        venueId: identity.venueId,
        staffId: actor.staffId,
        data: {
          requestId: declaration.requestId,
          terminalId: row.terminalId,
          orderId: row.orderId,
          resolutionId: saved.id,
          source: identity.source,
          previousStatus: row.status,
        },
      },
    })
    return saved
  }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)
}
