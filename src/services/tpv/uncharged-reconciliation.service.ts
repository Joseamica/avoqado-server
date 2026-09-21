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
        : code === 'TERMINAL_NEVER_ANSWERED'
          ? 'Esta terminal nunca confirmó haber recibido el cobro. No se puede declarar: consulta su resultado.'
        : code === 'EXECUTION_STILL_ACTIVE'
          ? 'La terminal dice que este cobro sigue en curso. Espera unos segundos y vuelve a consultar.'
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

/**
 * 🔴 AQUÍ VIVÍA `terminalVolvio()`, y se BORRÓ a propósito (decisión del founder, 19-sep, con las tres
 * auditorías de Codex enfrente).
 *
 * Comprobaba que la terminal «hubiera vuelto» mirando `terminalReturnedAt` o un latido reciente. Tres rondas
 * seguidas produjeron defectos NUEVOS exactamente ahí —relojes de aparato adelantados, marcas selladas a
 * partir de esos relojes, tolerancias que volvían «posterior» un latido anterior— y dos de ellos los
 * introdujeron los propios arreglos de la ronda anterior.
 *
 * 🔑 Y lo que decidió quitarlo: **nunca fue una garantía**. Lo dijo Codex desde la ronda 1 — un latido
 * acredita CONECTIVIDAD, jamás que la ejecución del cobro terminara. Era ceremonia que parecía seguridad, y
 * su única consecuencia real era abrir huecos en cada intento de afinarla.
 *
 * Lo que SÍ protege el dinero se queda intacto y es lo que siempre lo protegió: que no exista NINGÚN rastro
 * de cobro —`Payment` por cualquiera de sus identidades, aprobación del banco, contradicción de procedencia,
 * afirmación de la terminal en el sobre, o una sonda diciendo que el cobro sigue corriendo—. Y sobre todo:
 * una PERSONA que miró la pantalla del aparato, que es la premisa de esta declaración y no necesita que un
 * reloj se lo confirme.
 */

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
function contradiccionDeProcedenciaSql(attemptIds: string[], venueId: string, terminalId: string): Prisma.Sql {
  if (attemptIds.length === 0) return Prisma.sql`FALSE`
  return Prisma.sql`EXISTS (
    SELECT e."id" FROM "ProviderEventLog" e
    WHERE e."attemptId" IN (${Prisma.join(attemptIds)}) AND e."provider" = 'PAYMENT_PROCESSOR'
      AND (e."venueId" IS DISTINCT FROM ${venueId}
        OR e."errorReason" IN ('LINK_TERMINAL_MISMATCH', 'LINK_VENUE_MISMATCH')
        OR (nullif(regexp_replace(coalesce(e."payload"->'payload'->>'terminalSerial', ''), ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '') IS NOT NULL
          AND lower(regexp_replace(regexp_replace(e."payload"->'payload'->>'terminalSerial', ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '^AVQD-', '', 'i')) <> ${terminalId})
        OR ${estadoBancarioSql(Prisma.sql`coalesce(e."payload"->'payload'->'status', e."payload"->'status')`)} = 'APROBADO')
  )`
}

async function contradiccionDeProcedencia(
  tx: Prisma.TransactionClient,
  attemptIds: string[],
  venueId: string,
  terminalId: string,
): Promise<boolean> {
  if (attemptIds.length === 0) return false
  const [fila] = await tx.$queryRaw<{ hay: boolean }[]>`
    SELECT ${contradiccionDeProcedenciaSql(attemptIds, venueId, terminalId)} AS "hay"`
  return Boolean(fila?.hay)
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
    // 🔴 RONDA 4 de Codex, y corrige la decisión de la ronda 3. Al borrar la elegibilidad por reloj se
    // llevó por delante una barrera que no era un reloj: «que el latido no pruebe el cese no significa que
    // quitar TODAS esas condiciones conserve las mismas barreras». El caso que quedó abierto: un ACK perdido
    // deja la fila en `UNKNOWN/ACK_TIMEOUT` a los CINCO SEGUNDOS —con el cobro quizá corriendo y minutos por
    // delante hasta vencer— y la declaración se aceptaba ahí mismo.
    //
    // La barrera es EVIDENCIA DEL APARATO, no tiempo. Lo que hay que descartar es que el cobro siga EN
    // TRÁNSITO hacia una terminal: ahí la mirada del cajero no revoca nada, porque el aparato todavía
    // puede encenderse y pedir la tarjeta. Una vez que CONSTA QUE SALIÓ, lo que el cajero ve en la
    // pantalla es la mejor evidencia disponible.
    //
    // 🔴 CORREGIDA el 19-sep por el QA en la Sunmi, y el hueco lo había abierto esta misma barrera al
    // exigir ACUSE. Con una terminal de APK anterior a la 2.9.0 (3-sep, la que estrenó el acuse) la
    // entrega es LEGACY: el servidor deja `lastDeliveredAt` y NUNCA `acknowledgedAt`. Medido en
    // hardware: esa fila no la libera la SONDA —su NOT_FOUND sólo suelta procedencia `[]`— ni la
    // liberaba esta declaración, así que el cajero quedaba en el MISMO callejón sin salida del 18-sep
    // que esta función existe para quitar. El «camino de siempre» que yo había declarado como salida
    // no existía.
    //
    // Se declara si consta CUALQUIERA de estas cuatro, en orden de fuerza:
    //   1. la terminal ACUSÓ recibo                  (`acknowledgedAt`)
    //   2. la terminal CONTESTÓ algo                 (`resultJson` no vacío)
    //   3. se entregó a una terminal que NO SABE ACUSAR (procedencia con `ackVersion` 0/ausente): esperar
    //      su acuse es esperar algo que no va a llegar nunca
    //   4. la procedencia es DESCONOCIDA (`null`) — fila anterior a la columna; por regla del repo `null`
    //      nunca se lee como «no entregada» (ver `.claude/rules/cobro-remoto-pos-a-tpv.md`)
    //
    // 🔴 Y sigue BLOQUEADA, que es lo que Codex hizo cerrar en la ronda 4 y NO se reabre:
    //   · la fila que consta NUNCA entregada (procedencia exactamente `[]`) — el cobro puede ir en camino;
    //   · la entregada a una terminal que SÍ SABE ACUSAR (`ackVersion >= 1`) y aun así no acusó. Ahí el
    //     silencio ES información: o no le llegó, o está ocupada con la tarjeta. Es el caso del ACK
    //     perdido que deja `UNKNOWN/ACK_TIMEOUT` a los CINCO SEGUNDOS, con minutos por delante.
    const sobreConRespuesta =
      row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson)
        ? Object.keys(row.resultJson as Record<string, unknown>).length > 0
        : false
    const entregas = (row.deliveryProvenance as { deliveries?: { ackVersion?: number }[] } | null)?.deliveries
    const procedenciaDesconocida = !Array.isArray(entregas)
    const entregadaASordo = Array.isArray(entregas) && entregas.length > 0 && entregas.every(e => !Number(e?.ackVersion))
    const constaQueSalio = Boolean(row.acknowledgedAt) || sobreConRespuesta || entregadaASordo || procedenciaDesconocida
    if (!constaQueSalio) throw new UnchargedReconciliationError('TERMINAL_NEVER_ANSWERED')

    if (sondaReportoActiva(row)) throw new UnchargedReconciliationError('EXECUTION_STILL_ACTIVE')

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
    // 🔴 Ronda 2 de Codex (19-sep): el veto de procedencia va TAMBIÉN en la escritura. `sinEvidenciaPositivaSql`
    // exige que el evento sea de ESTE venue, así que un aprobado del MISMO intento recibido por OTRO venue
    // —que entra por un INSERT sin ningún candado— pasaba el CAS aunque la lectura sí lo habría vetado. Ése era
    // exactamente el camino que permitía declarar «no cobrado» con un aprobado durable ya guardado.
    const cas = await tx.$executeRaw`
      UPDATE "TerminalPaymentRequest"
      SET "status" = 'FAILED', "failureCode" = 'OPERATOR_RECONCILED_NO_CHARGE', "cancelDisposition" = NULL,
          "resultJson" = ${JSON.stringify(sobreDeclarado)}::jsonb,
          "operatorReconciliation" = ${JSON.stringify(saved)}::jsonb,
          "updatedAt" = (NOW() AT TIME ZONE 'UTC')
      WHERE "id" = ${row.id} AND "status" = ${row.status}::"TerminalPaymentRequestStatus" AND "paymentId" IS NULL
        AND ${sinEvidenciaPositivaSql(declaration.requestId, identity.venueId)}
        AND NOT ${hayEvidenciaDeConciliacionSql(declaration.requestId, identity.venueId)}
        AND NOT ${contradiccionDeProcedenciaSql(attemptIds, identity.venueId, row.terminalId)}`
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
