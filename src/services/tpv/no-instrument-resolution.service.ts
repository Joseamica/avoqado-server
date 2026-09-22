/**
 * La declaración del cajero «no se presentó tarjeta» (plan 16-sep, Task 4).
 *
 * UN paso en la terminal: la SESIÓN con la que el cajero entró (el `sub` del JWT de la terminal) declara que nadie presentó
 * tarjeta, teléfono ni reloj, y la fila del cobro remoto queda `FAILED / OPERATOR_RECONCILED_NO_CHARGE` — evidencia de
 * clase OPERADOR, en la lista blanca (`CODIGOS_SIN_COBRO`): la orden y la ranura se liberan y el POS puede volver a cobrar.
 * Es TESTIMONIO de una persona, nunca evidencia del procesador: si el dinero aparece después (Payment tardío), el cierre
 * común (`closeRowFromPaymentTx`) reabre la fila a COMPLETED y grita 🚨 — el dinero manda sobre la palabra del cajero, y la
 * declaración se conserva intacta en el vínculo (trigger `preserve_no_instrument_resolution`).
 *
 * Portado del worktree de Codex (`no-card-recovery-20260916`) SIN la valla del reinicio ni el `/ack`: allá se exigía PIN
 * siempre y el aparato quedaba bloqueado hasta un segundo paso; aquí la AUTORIDAD la valida el servidor con la identidad de
 * la sesión —nunca con el cuerpo— y el PIN de otra persona sólo ELEVA a un miembro válido del venue que no tiene el permiso.
 *
 * Lo que veta la declaración (la elegibilidad de Codex, sin la valla): un solo intento por solicitud; ningún Payment por las
 * cuatro identidades (llave del intento, solicitud, etiqueta legacy en `processorData` —Codex r1, P1-E—, puntero de la fila);
 * ninguna señal positiva en el sobre de la terminal (incluida la afirmación conservada de un `success` degradado —P1-D—);
 * ninguna evidencia bancaria o de procedencia que contradiga; y un desenlace todavía UNRESOLVED que no esté PENDING ni
 * retenido por el banco (`BANK_APPROVED_AWAITING_PAYMENT`). El CAS final revalida el veto en la escritura (P1-C).
 */
import { createHash } from 'crypto'
import { z } from 'zod'
import { Prisma, TerminalPaymentRequestStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { normalizeTerminalId } from '../../communication/sockets/terminal-registry'
import { evaluatePermissionList, hasPermission } from '../../lib/permissions'
import { PIN_REGEX } from '../../schemas/common/pin.schema'
import { candadoDeIntento, llaveDeIntento, OPCIONES_DE_TRANSACCION_DEL_INTENTO } from './candadoDeIntento'
import { estadoBancarioSql } from './estadoBancario'
import { sinEvidenciaPositivaSql } from './evidenciaPositivaSql'
import { PATRON_SQL_TRIM_COMO_JS } from '../../utils/terminalSerial'

export const NO_INSTRUMENT_PERMISSION = 'payments:resolve-no-instrument'

/** Estricto: la identidad NUNCA viene en el cuerpo (un `staffId`/`role` extra es un 409, no un dato). */
const schema = z
  .object({
    // 🔴 OPCIONAL desde el 22-sep («ninguna terminal muerta»): un **Pago rápido** —cobro iniciado EN la terminal— no tiene
    // solicitud del POS, y exigirla dejaba al cajero sin salida con el aparato entero apartado. Ausente ⇒ camino LOCAL.
    // Los APK de la calle siguen mandándola y no cambian de comportamiento.
    requestId: z.string().min(1).optional(),
    resolutionId: z.string().uuid(),
    statement: z.literal('NO_INSTRUMENT_PRESENTED'),
    statementVersion: z.literal(1),
    // La MISMA regla de PIN del resto del repo (4-10 dígitos): un PIN legítimo de 9 dígitos no puede rebotar como cuerpo inválido.
    // `nullish`, no `optional`: el DTO de la terminal es `String?` y un serializador con nulls mandaría `"supervisorPin": null` en
    // TODA declaración — leído como inválido sería un 409 en cada una (la lección de `vieneAusente()` en los reembolsos, 11-12 sep).
    supervisorPin: z.string().regex(PIN_REGEX).nullish(),
  })
  .strict()

export class NoInstrumentResolutionError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(
      code === 'SUPERVISOR_AUTHORIZATION_REQUIRED'
        ? 'Se requiere el código de alguien con permiso para confirmar que no se presentó tarjeta.'
        : code === 'SESSION_NOT_IN_VENUE'
          ? 'La sesión de esta terminal no pertenece a este negocio. Vuelve a iniciar sesión.'
          : 'No se pudo cerrar este intento. Conserva el cobro pendiente y consulta su resultado.',
    )
  }
}

export type OperatorResolution = {
  id: string
  kind: 'NO_INSTRUMENT_PRESENTED'
  acceptedAt: string
  bodyHash: string
  staffId: string
  staffVenueId: string
  by: 'SESSION' | 'SUPERVISOR_PIN'
  statementVersion: number
  /**
   * El estado de la solicitud ANTES de declarar. Ausente en el camino LOCAL (22-sep): un Pago rápido no tiene solicitud,
   * así que no hay estado previo que congelar — inventarle uno sería escribir un dato falso en un testimonio.
   */
  previousRequest?: { status: string; failureCode: string | null }
}

export function readOperatorResolution(value: unknown): OperatorResolution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as OperatorResolution
  return r.kind === 'NO_INSTRUMENT_PRESENTED' && typeof r.id === 'string' ? r : null
}

/**
 * ¿Esta persona, en este local, tiene el permiso EFECTIVO? EXACTAMENTE la regla de `checkPermission.middleware.ts:360-389`:
 * con conjunto de permisos asignado se evalúa ESA lista (reemplaza al rol); si no, rol + extras del venue − negados.
 * Devuelve TRES cosas distintas (Codex, Task 0, P4): no es miembro válido del venue (`null`) ≠ miembro sin permiso
 * (`{ …, permitido: false }`) ≠ miembro con permiso. Sólo el segundo puede elevarse con el PIN de otra persona.
 */
async function miembroDelVenue(
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
    permitido = evaluatePermissionList(sv.permissionSet.permissions, NO_INSTRUMENT_PERMISSION)
  } else {
    const custom = await tx.venueRolePermission.findUnique({
      where: { venueId_role: { venueId, role: sv.role } },
      select: { permissions: true, deniedPermissions: true },
    })
    permitido = hasPermission(sv.role, custom?.permissions ?? null, NO_INSTRUMENT_PERMISSION, custom?.deniedPermissions ?? null)
  }
  return { id: sv.id, staffId: sv.staffId, permitido }
}

/**
 * Evidencia que VETA la declaración (portado tal cual del worktree de Codex): un evento del intento de OTRO venue, con
 * contradicción de vínculo, con un serial de terminal que no es éste, o APROBADO por el banco (aunque no exista Payment).
 * Consulta acotada al intento exacto. Misma clasificación bancaria que el receptor (`estadoBancarioSql`).
 */
async function evidenciaQueVetaLaDeclaracion(
  tx: Prisma.TransactionClient,
  attemptId: string,
  venueId: string,
  terminalId: string,
  hayVinculo = false,
) {
  return tx.$queryRaw<{ id: string }[]>`
    SELECT e."id" FROM "ProviderEventLog" e
    WHERE e."attemptId" = ${attemptId} AND e."provider" = 'PAYMENT_PROCESSOR'
      AND (e."venueId" IS DISTINCT FROM ${venueId}
        OR e."errorReason" IN ('LINK_TERMINAL_MISMATCH', 'LINK_VENUE_MISMATCH')
        OR (nullif(regexp_replace(coalesce(e."payload"->'payload'->>'terminalSerial', ''), ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '') IS NOT NULL
          AND lower(regexp_replace(regexp_replace(e."payload"->'payload'->>'terminalSerial', ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '^AVQD-', '', 'i')) <> ${terminalId})
        OR ${estadoBancarioSql(Prisma.sql`coalesce(e."payload"->'payload'->'status', e."payload"->'status')`)} = 'APROBADO'
        -- 🔴 Codex r5-6 (22-sep): un evento de este intento que no se puede atribuir a nadie —sin vínculo y sin
        -- serial— y cuyo estado NO es un rechazo acreditado también veta. Antes el POST lo dejaba pasar y S6 lo
        -- contaba como evidencia sin dueño: la declaración se guardaba y quedaba INSERVIBLE al instante. Aceptar
        -- una declaración y poder usarla tienen que decir lo mismo, y esta es la regla que los iguala.
        OR (${!hayVinculo}
          AND nullif(regexp_replace(coalesce(e."payload"->'payload'->>'terminalSerial', ''), ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '') IS NULL
          AND ${estadoBancarioSql(Prisma.sql`coalesce(e."payload"->'payload'->'status', e."payload"->'status')`)} IS DISTINCT FROM 'RECHAZADO'))
    LIMIT 1`
}

/**
 * ¿Existe un `Payment` con la llave de ESTE intento, en CUALQUIER negocio, recortada con la MISMA regla que la llave
 * canónica? (Codex P1-1 y r4-2.) Sólo devuelve si existe: nada del pago ajeno sale de aquí.
 *
 * 🔴 `btrim` NO equivale a `String.trim()`: sólo quita el espacio ASCII, mientras `llaveDeIntento` —que es quien define
 * la llave canónica— quita además tabulador, salto de línea, NBSP y los separadores Unicode. Un Payment guardado con
 * `"\tA\n"` (el esquema del registro lo admite y se almacena sin recortar) se escapaba de las dos capas del veto y
 * dejaba declarar «no se cobró» con el dinero ya registrado. La regla correcta ya estaba escrita en este repo —
 * `PATRON_SQL_TRIM_COMO_JS`, que usa el serial de la terminal por exactamente el mismo motivo— y es la que se usa aquí.
 *
 * La igualdad exacta va primero en el OR: es la que puede aprovechar el índice cuando la llave está limpia, que es el
 * caso normal. ⬜ Declarado: con llave sucia el predicado funcional no usa índice; el coste no está medido con volumen
 * representativo, y la corrección de raíz es normalizar también al ESCRIBIR (`recordFastPayment`), que es otro carril.
 */
async function hayDineroConEstaLlave(tx: Prisma.TransactionClient, attemptId: string): Promise<boolean> {
  const filas = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Payment"
    WHERE "idempotencyKey" = ${attemptId}
       OR regexp_replace("idempotencyKey", ${PATRON_SQL_TRIM_COMO_JS}, '', 'g') = ${attemptId}
    LIMIT 1`
  return filas.length > 0
}

const SENALES_POSITIVAS_DEL_SOBRE = ['paymentId', 'authorizationCode', 'transactionId', 'reference', 'readMode'] as const

/**
 * Codex r1 (P1-D): un `success` que `closeRow` no pudo acreditar queda UNKNOWN con su afirmación en `resultJson.claimedSuccess`
 * (sólo las llaves que la terminal mandó). Cualquier campo NO vacío veta: la terminal dijo «cobré» y nadie lo ha desmentido.
 * Un objeto con todos los campos vacíos no afirma nada. (Un negativo posterior de la terminal reemplaza el sobre entero y
 * pierde `claimedSuccess`: coherente con el ruling (c) de la Task 2 — ese negativo entra en la ventana, no en la declaración.)
 */
function afirmaCobro(claimedSuccess: unknown): boolean {
  if (!claimedSuccess || typeof claimedSuccess !== 'object' || Array.isArray(claimedSuccess)) return false
  return Object.values(claimedSuccess as Record<string, unknown>).some(v => v !== undefined && v !== null && v !== '' && v !== false)
}

/**
 * AUTORIZACIÓN de la declaración, COMPARTIDA por el camino con solicitud y el local (22-sep). Extraída tal cual, sin
 * cambiarle una regla: la persona de la SESIÓN (el PIN con el que entró a la terminal) tiene que ser miembro VÁLIDO de
 * este venue — si no lo es, nadie la rescata con un PIN —; y si lo es pero no tiene el permiso, hace falta el PIN de
 * otra persona que sí lo tenga. Duplicarla habría sido la forma más fácil de que los dos caminos divergieran.
 */
async function autorizarDeclaracion(
  tx: Prisma.TransactionClient,
  identity: { venueId: string; actorStaffId: string | null },
  supervisorPin: string | undefined,
): Promise<{ actor: { id: string; staffId: string }; by: OperatorResolution['by'] }> {
  const sesion = identity.actorStaffId ? await miembroDelVenue(tx, identity.venueId, identity.actorStaffId) : null
  if (!sesion) throw new NoInstrumentResolutionError('SESSION_NOT_IN_VENUE', 403)
  if (sesion.permitido) return { actor: sesion, by: 'SESSION' }
  if (!supervisorPin) throw new NoInstrumentResolutionError('SUPERVISOR_AUTHORIZATION_REQUIRED', 403)
  const porPin = await tx.staffVenue.findFirst({
    where: { venueId: identity.venueId, pin: supervisorPin, active: true, staff: { active: true } },
    select: { staffId: true },
  })
  const supervisor = porPin ? await miembroDelVenue(tx, identity.venueId, porPin.staffId) : null
  if (!supervisor?.permitido) throw new NoInstrumentResolutionError('SUPERVISOR_AUTHORIZATION_REQUIRED', 403)
  return { actor: supervisor, by: 'SUPERVISOR_PIN' }
}

export async function resolveNoInstrument(
  identity: { venueId: string; terminalSerial: string; attemptId: string; actorStaffId: string | null },
  raw: unknown,
) {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new NoInstrumentResolutionError('ATTEMPT_NOT_ELIGIBLE')
  const { supervisorPin: pinCrudo, ...declaration } = parsed.data
  const supervisorPin = pinCrudo ?? undefined // JSON `null` = ausente
  const bodyHash = createHash('sha256').update(JSON.stringify(declaration)).digest('hex')
  const terminalId = normalizeTerminalId(identity.terminalSerial)
  // La MISMA normalización de la llave que el registrador y la publicación del vínculo (recortada, ≤ 64): el candado, la lectura
  // del vínculo y lo que se escribe hablan del mismo intento aunque el param llegue con espacios. Una llave inaceptable es un
  // intento que no existe.
  const attemptId = llaveDeIntento(identity.attemptId)
  if (!attemptId) throw new NoInstrumentResolutionError('ATTEMPT_NOT_FOUND', 404)

  const resolution = await prisma.$transaction(async tx => {
    // MISMO orden de candados que el registrador y la referencia de Codex: intento → orden → solicitud.
    await candadoDeIntento(tx, attemptId)

    // 🔴 Codex P1-4 (22-sep): el CAMINO lo decide la BASE, NUNCA el cuerpo. Antes bastaba omitir `requestId` para entrar
    // al camino local —dos vetos— sobre un intento VINCULADO, que debe pasar por las diez guardas de su solicitud; y eso
    // además dejaba DOS testimonios del mismo intento, uno en cada tabla (los índices únicos, al ser de tablas distintas,
    // no lo impiden). La pertenencia se lee bajo el candado que ya se tomó, y un `requestId` del cuerpo que CONTRADIGA al
    // vínculo es un intento que no existe para esa solicitud. Es la misma regla que ya rige la identidad en este archivo:
    // lo que decide nunca viene del cliente.
    const vinculo = await tx.terminalPaymentAttemptLink.findUnique({ where: { attemptId }, select: { requestId: true } })
    if (declaration.requestId && vinculo && declaration.requestId !== vinculo.requestId)
      throw new NoInstrumentResolutionError('ATTEMPT_NOT_FOUND', 404)
    const requestId = vinculo?.requestId ?? declaration.requestId ?? null

    // 🔴 Codex r4-1 (22-sep): el arreglo anterior cerró el vínculo PREEXISTENTE, pero no el que aparece DESPUÉS de una
    // declaración local — secuencia perfectamente serial: se declara sin vínculo, el POS manda su cobro, se vincula ese
    // mismo intento, y una segunda declaración entraba por el camino con solicitud y escribía OTRO testimonio en la otra
    // tabla. Dos testimonios del mismo intento, que los índices únicos no pueden impedir por estar en tablas distintas.
    // La regla es la del testimonio, no la del camino: **un intento se declara UNA vez**. Si ya hay uno local, ése manda
    // —se replica si es el mismo cuerpo, se rechaza si es otro— y no se abre un segundo.
    const declaracionLocalPrevia = requestId ? await tx.terminalAttemptResolution.findUnique({ where: { attemptId } }) : null
    if (declaracionLocalPrevia) {
      if (declaracionLocalPrevia.venueId !== identity.venueId || normalizeTerminalId(declaracionLocalPrevia.terminalId) !== terminalId)
        throw new NoInstrumentResolutionError('ATTEMPT_NOT_FOUND', 404)
      const existenteLocal = readOperatorResolution(declaracionLocalPrevia.resolution)
      if (!existenteLocal || existenteLocal.id !== declaration.resolutionId || existenteLocal.bodyHash !== bodyHash)
        throw new NoInstrumentResolutionError('RESOLUTION_CONFLICT')
      return { resolution: existenteLocal, requestId: null }
    }

    // ─── Camino LOCAL (22-sep, «ninguna terminal muerta»): un Pago rápido, sin solicitud del POS ───
    // No hay fila que cerrar, orden que bloquear ni POS que despertar; el testimonio vive en su propia tabla. Lo que SÍ se
    // conserva, porque es lo que protege el dinero: la MISMA autorización (sesión o PIN de supervisor) y el MISMO veto por
    // evidencia. De las cuatro identidades que vetan con solicitud, aquí sobrevive la única que existe —el Payment con la
    // llave del intento— y juntas son TODA la evidencia que el servidor tiene de un cobro local.
    if (!requestId) {
      const yaDeclarado = await tx.terminalAttemptResolution.findUnique({ where: { attemptId } })
      if (yaDeclarado) {
        // 🔴 Codex P2-5: la lectura es por `attemptId` (único global), así que ANTES de responder hay que comprobar que
        // ese testimonio es de ESTA terminal y de ESTE negocio. Sin esto, quien conociera el intento, el `resolutionId`
        // y el cuerpo recibía como respuesta la declaración de otra terminal — la misma pertenencia que el camino con
        // solicitud exige a su vínculo.
        if (yaDeclarado.venueId !== identity.venueId || normalizeTerminalId(yaDeclarado.terminalId) !== terminalId)
          throw new NoInstrumentResolutionError('ATTEMPT_NOT_FOUND', 404)
        const existente = readOperatorResolution(yaDeclarado.resolution)
        // Replay idempotente sólo si es LA MISMA declaración; otra es un conflicto, nunca un segundo testimonio.
        if (!existente || existente.id !== declaration.resolutionId || existente.bodyHash !== bodyHash)
          throw new NoInstrumentResolutionError('RESOLUTION_CONFLICT')
        return { resolution: existente, requestId: null }
      }

      const actorLocal = await autorizarDeclaracion(tx, identity, supervisorPin)

      // 🔴 Codex P1-1: el veto por dinero es GLOBAL y tolerante a la llave sin recortar. Dos huecos medidos: un
      // `Payment` cuya `idempotencyKey` se guardó CON espacios (el registro de la terminal los admite) no casaba con la
      // llave normalizada; y un `Payment` de OTRO negocio quedaba oculto por el filtro de venue, cuando el camino con
      // solicitud sí lo ve —busca la llave globalmente— y lo trata como contradicción. El local no puede ser más débil:
      // dinero con esta llave, esté donde esté, prohíbe declarar. No se devuelve ningún dato de ese pago ajeno.
      // (Coste: `btrim` no usa el índice, pero esta consulta corre una vez por declaración —un caso raro— y no en el
      // camino de una venta.)
      if (await hayDineroConEstaLlave(tx, attemptId)) throw new NoInstrumentResolutionError('POSITIVE_EVIDENCE_EXISTS')
      if ((await evidenciaQueVetaLaDeclaracion(tx, attemptId, identity.venueId, terminalId)).length)
        throw new NoInstrumentResolutionError('POSITIVE_EVIDENCE_EXISTS')

      const savedLocal: OperatorResolution = {
        id: declaration.resolutionId,
        kind: 'NO_INSTRUMENT_PRESENTED',
        acceptedAt: new Date().toISOString(),
        bodyHash,
        staffId: actorLocal.actor.staffId,
        staffVenueId: actorLocal.actor.id,
        by: actorLocal.by,
        statementVersion: declaration.statementVersion,
      }
      // La INMUTABILIDAD la da el índice único sobre `attemptId`, no un trigger: una carrera pierde con P2002, que es
      // «ya declarado» — se relee y se resuelve como replay o conflicto, nunca se sobrescribe un testimonio.
      try {
        await tx.terminalAttemptResolution.create({
          data: {
            attemptId,
            venueId: identity.venueId,
            terminalId,
            resolution: savedLocal as unknown as Prisma.InputJsonValue,
          },
        })
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new NoInstrumentResolutionError('RESOLUTION_CONFLICT')
        throw e
      }
      // 🔴 Codex P1-2: el candado de intento es CONSULTIVO — serializa a quien toma la MISMA llave, pero no bloquea las
      // escrituras en `Payment` ni en `ProviderEventLog`, y el fallback del webhook escribe sin tomarlo. Entre el veto y
      // esta escritura cabía, por tanto, una aprobación del banco. Se revalida AQUÍ, ya escrito: un `throw` revierte la
      // transacción entera y el testimonio no queda. Es el equivalente al CAS que revalida en el UPDATE del camino con
      // solicitud. ⚠️ Residual declarado, idéntico al de aquel: algo que se confirme entre esta comprobación y el COMMIT
      // no se ve; lo recoge después la contradicción que publica S6.
      if (await hayDineroConEstaLlave(tx, attemptId)) throw new NoInstrumentResolutionError('POSITIVE_EVIDENCE_EXISTS')
      if ((await evidenciaQueVetaLaDeclaracion(tx, attemptId, identity.venueId, terminalId)).length)
        throw new NoInstrumentResolutionError('POSITIVE_EVIDENCE_EXISTS')
      await tx.activityLog.create({
        data: {
          action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED',
          entity: 'TerminalAttemptResolution',
          entityId: attemptId,
          venueId: identity.venueId,
          staffId: actorLocal.actor.staffId,
          // 🔴 Codex P2-6: con PIN de supervisor, `staffId` es el AUTORIZANTE; sin `sessionStaffId` se perdía quién
          // operaba la terminal. El camino con solicitud ya lo conserva; aquí faltaba, y sin él el dueño no puede
          // saber en qué caja ocurrió. También el `resolutionId`, para poder atar el asiento al testimonio.
          data: {
            attemptId,
            terminalId,
            by: actorLocal.by,
            sinSolicitud: true,
            sessionStaffId: identity.actorStaffId,
            resolutionId: savedLocal.id,
          },
        },
      })
      return { resolution: savedLocal, requestId: null }
    }

    const inicial = await tx.terminalPaymentRequest.findFirst({
      where: { requestId: requestId, venueId: identity.venueId, terminalId },
    })
    if (!inicial) throw new NoInstrumentResolutionError('ATTEMPT_NOT_FOUND', 404)
    // El candado de la orden va acotado al venue y su resultado decide la pertenencia: una orden de OTRO venue no se bloquea ni se
    // acepta (una sola sentencia, sin segunda lectura sin candado).
    const ordenBloqueada = inicial.orderId
      ? await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "Order" WHERE "id" = ${inicial.orderId} AND "venueId" = ${identity.venueId} FOR UPDATE`
      : null
    await tx.$queryRaw`SELECT "id" FROM "TerminalPaymentRequest" WHERE "requestId" = ${requestId} AND "venueId" = ${identity.venueId} FOR UPDATE`
    const row = await tx.terminalPaymentRequest.findFirst({
      where: { requestId: requestId, venueId: identity.venueId, terminalId },
    })
    const link = await tx.terminalPaymentAttemptLink.findUnique({ where: { attemptId } })
    if (
      !row ||
      !link ||
      link.requestId !== requestId ||
      link.venueId !== identity.venueId ||
      normalizeTerminalId(link.terminalId) !== terminalId
    )
      throw new NoInstrumentResolutionError('ATTEMPT_NOT_FOUND', 404)
    if (row.orderId && (row.orderId !== inicial.orderId || ordenBloqueada?.length !== 1))
      throw new NoInstrumentResolutionError('ATTEMPT_NOT_ELIGIBLE')

    const existing = readOperatorResolution(link.operatorResolution)
    if (existing) {
      if (existing.id !== declaration.resolutionId || existing.bodyHash !== bodyHash)
        throw new NoInstrumentResolutionError('RESOLUTION_CONFLICT')
      return { resolution: existing, requestId } // replay idempotente: nada se reescribe
    }

    // AUTORIZACIÓN: la persona de la SESIÓN (el PIN con el que entró a la terminal) tiene que ser miembro VÁLIDO de este venue —
    // si no lo es, nadie la rescata con un PIN—; y si lo es pero no tiene el permiso, el PIN de otra persona que sí lo tenga.
    const { actor, by } = await autorizarDeclaracion(tx, identity, supervisorPin)

    // ELEGIBILIDAD (la de Codex, sin la valla): un solo intento por solicitud; sin Payment por ninguna de las tres identidades;
    // sin señal positiva en el sobre; sin evidencia bancaria/de procedencia que vete; desenlace no acreditado y no PENDING.
    if ((await tx.terminalPaymentAttemptLink.count({ where: { requestId: requestId } })) !== 1)
      throw new NoInstrumentResolutionError('OTHER_ATTEMPT_UNRESOLVED')
    // Codex r1 (P1-E): la CUARTA identidad es la legacy — la etiqueta `processorData.terminalPaymentRequestId` que deja la cola
    // vieja (sin puntero ni llave de intento); acotada al venue. Es la misma que retiene G1 en la ventana.
    const positivo = await tx.payment.findFirst({
      where: {
        OR: [
          { idempotencyKey: attemptId },
          { terminalPaymentRequestId: requestId },
          { venueId: identity.venueId, processorData: { path: ['terminalPaymentRequestId'], equals: requestId } },
          ...(row.paymentId ? [{ id: row.paymentId }] : []),
        ],
      },
      select: { id: true },
    })
    const sobre =
      row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson)
        ? (row.resultJson as Record<string, unknown>)
        : {}
    const senalPositiva =
      sobre.status === 'success' ||
      sobre.approved === true ||
      SENALES_POSITIVAS_DEL_SOBRE.some(f => typeof sobre[f] === 'string' && sobre[f] !== '') ||
      afirmaCobro(sobre.claimedSuccess)
    // 🔴 Codex r5-1 (22-sep): la regla de dinero es UNA, y aquí faltaba. Este camino comparaba la llave EXACTA, así que
    // un pago de ESTE intento guardado con espacios (o en otro negocio) se le escapaba —y entonces escribía
    // `FAILED / OPERATOR_RECONCILED_NO_CHARGE`, que el POS lee como «no se cobró». `hayDineroConEstaLlave` es la MISMA
    // función que usa el camino local: una sola definición de «¿existe dinero de este intento?» para los dos.
    if (
      positivo ||
      row.paymentId ||
      senalPositiva ||
      (await hayDineroConEstaLlave(tx, attemptId)) ||
      (await evidenciaQueVetaLaDeclaracion(tx, attemptId, identity.venueId, terminalId, true)).length
    )
      throw new NoInstrumentResolutionError('POSITIVE_EVIDENCE_EXISTS')
    const { desenlaceCanonico } = await import('../terminal-payment.service')
    // Una fila RETENIDA por la ventana (el banco aprobó, o hay un Payment ligado que no se pudo ligar — Codex r2, P2-N1) es
    // evidencia positiva: el cajero no declara encima.
    const retenidaPorLaVentana =
      row.failureCode === 'BANK_APPROVED_AWAITING_PAYMENT' || row.failureCode === 'PAYMENT_UNBOUND_AWAITING_REVIEW'
    if (desenlaceCanonico(row).outcome !== 'UNRESOLVED' || row.status === TerminalPaymentRequestStatus.PENDING || retenidaPorLaVentana)
      throw new NoInstrumentResolutionError(retenidaPorLaVentana ? 'POSITIVE_EVIDENCE_EXISTS' : 'ATTEMPT_NOT_ELIGIBLE')

    const saved: OperatorResolution = {
      id: declaration.resolutionId,
      kind: 'NO_INSTRUMENT_PRESENTED',
      acceptedAt: new Date().toISOString(),
      bodyHash,
      staffId: actor.staffId,
      staffVenueId: actor.id,
      by,
      statementVersion: declaration.statementVersion,
      previousRequest: { status: row.status, failureCode: row.failureCode },
    }
    // CAS sobre el estado LEÍDO y sin Payment: si otro escritor movió la fila entre la lectura y aquí, no se declara nada.
    // Codex r1 (P1-C d): y REVALIDADO en la propia escritura con los dos `NOT EXISTS` (`sinEvidenciaPositivaSql`): un APROBADO
    // del fallback o un Payment etiquetado que entren entre el veto y este UPDATE lo dejan en 0 — un 0 es ATTEMPT_NOT_ELIGIBLE
    // (el CAS no distingue «la fila cambió» de «apareció evidencia»; el mensaje le dice al cajero que conserve el cobro y
    // consulte, y la siguiente declaración ya lo ve como POSITIVE_EVIDENCE_EXISTS por el veto). `updatedAt` explícito: un UPDATE
    // crudo no pasa por `@updatedAt`.
    const sobreDeclarado = {
      ...sobre,
      requestId: requestId,
      status: 'failed',
      outcomeEvidence: 'OPERATOR_RECONCILED',
      errorMessage: 'La terminal confirmó que no se presentó tarjeta. Se puede volver a cobrar.',
      operatorResolution: saved,
    }
    const cas = await tx.$executeRaw`
      UPDATE "TerminalPaymentRequest"
      SET "status" = 'FAILED', "failureCode" = 'OPERATOR_RECONCILED_NO_CHARGE', "cancelDisposition" = NULL,
          "resultJson" = ${JSON.stringify(sobreDeclarado)}::jsonb, "updatedAt" = (NOW() AT TIME ZONE 'UTC')
      WHERE "id" = ${row.id} AND "status" = ${row.status}::"TerminalPaymentRequestStatus" AND "paymentId" IS NULL
        AND ${sinEvidenciaPositivaSql(requestId, identity.venueId)}`
    if (cas !== 1) throw new NoInstrumentResolutionError('ATTEMPT_NOT_ELIGIBLE')
    await tx.terminalPaymentAttemptLink.update({
      where: { attemptId },
      data: { operatorResolution: saved as unknown as Prisma.InputJsonValue },
    })
    // Asiento DENTRO de la transacción (`logAction` abre su propia conexión): una declaración = un asiento.
    await tx.activityLog.create({
      data: {
        action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        venueId: identity.venueId,
        staffId: actor.staffId,
        data: {
          requestId: requestId,
          attemptId,
          terminalId,
          by,
          sessionStaffId: identity.actorStaffId,
          resolutionId: saved.id,
        },
      },
    })
    return { resolution: saved, requestId }
  }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)

  // La respuesta es la MISMA proyección durable de S6 (contrato con las apps publicadas: nada se quita) más la resolución.
  const { terminalPaymentService } = await import('../terminal-payment.service')
  // Revisión final (17-sep, A): DESPUÉS del commit, el POS que sigue esperando ese cobro (su long-poll quedó vivo al entrar la
  // fila a la ventana) recibe el desenlace durable — FAILED / OPERATOR_RECONCILED — sin tener que volver a consultar. También en
  // el replay idempotente: si el primer aviso se perdió, el reintento del cajero lo repite. Un fallo aquí no deshace ni oculta la
  // declaración ya confirmada: el POS la lee por el GET. (El log lleva nombre y código, nunca el mensaje: misma regla que el
  // controlador de esta ruta, cuyo cuerpo puede traer un PIN.)
  // 🔴 En el camino LOCAL no hay POS esperando: no hay solicitud, no hay long-poll y no hay a quién despertar. Llamar aquí
  // con `undefined` sería, en el mejor caso, ruido; en el peor, tocar una fila ajena. La respuesta sigue siendo la MISMA
  // forma (proyección de S6 + `resolution`), para que el cliente use un solo parser en los dos caminos.
  try {
    if (resolution.requestId) await terminalPaymentService.resolverEsperaDelPos(resolution.requestId, identity.venueId)
  } catch (err) {
    logger.warn('⚠️ [NoInstrument] could not answer the waiting POS after the declaration — it reads the result by GET', {
      requestId: resolution.requestId,
      venueId: identity.venueId,
      errorName: err instanceof Error ? err.name : typeof err,
      ...(err instanceof Prisma.PrismaClientKnownRequestError ? { errorCode: err.code } : {}),
    })
  }
  const current = await terminalPaymentService.consultarIntentoDeTerminal({
    attemptId,
    venueId: identity.venueId,
    terminalSerial: identity.terminalSerial,
  })
  if (!current) throw new NoInstrumentResolutionError('RESOLUTION_UNAVAILABLE', 503)
  const declarada = resolution.resolution
  return { ...current, resolution: { id: declarada.id, acceptedAt: declarada.acceptedAt, by: declarada.by } }
}
