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
import logger from '../../config/logger'

export const RECONCILE_UNCHARGED_PERMISSION = 'payments:reconcile-uncharged'

/** Estricto: la identidad NUNCA viene en el cuerpo. Un `staffId` de más es un rechazo, no un dato. */
const schema = z
  .object({
    requestId: z.string().min(1),
    resolutionId: z.string().uuid(),
    // 🔴 DOS procedencias por el MISMO núcleo (21-sep-2026, decisión del founder tras el 2º rechazo de Codex):
    // `UNCHARGED_VERIFIED` la firma un cajero; `BANK_DECLINED` la firma el SERVIDOR con el webhook del
    // procesador como evidencia. Antes el rechazo del banco tenía su propia función, y Codex demostró en dos
    // pasadas que le faltaban las guardas de ésta: los candados por intento, el veto de contradicción de
    // procedencia, la orden bloqueada y el replay idempotente. Duplicar el camino era el defecto.
    statement: z.union([z.literal('UNCHARGED_VERIFIED'), z.literal('BANK_DECLINED')]),
    statementVersion: z.literal(1),
    /** Sólo para `BANK_DECLINED`: qué dijo el procesador. El texto libre NUNCA llega a la pantalla. */
    bank: z
      .object({
        origen: z.enum(['ANGELPAY', 'BLUMON']),
        eventLogId: z.string().max(64),
        /** El intento QUE TRAE el rechazo: su veredicto es el del payload, no hace falta buscarlo en la base. */
        attemptId: z.string().max(64).optional(),
        descripcion: z.string().max(300).optional(),
      })
      .strict()
      .optional(),
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
  kind: 'UNCHARGED_VERIFIED' | 'BANK_DECLINED'
  acceptedAt: string
  bodyHash: string
  staffId: string | null
  staffVenueId: string | null
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

/** El texto EXACTO que redacta el servidor en `failUndelivered`. Ninguna terminal lo manda. */
const MENSAJE_DEL_SOBRE_SINTETICO = 'La entrega no pudo confirmarse. Consulta el resultado en la terminal antes de volver a cobrar'

/**
 * ¿Este sobre lo escribió el SERVIDOR y no la terminal?
 *
 * 🔴 P1 de Codex (21-sep): marcar los sobres nuevos con `origin: 'SERVER'` no alcanza, porque las filas
 * que la versión ANTERIOR ya persistió llevan el mismo sobre SIN esa marca — y `origin !== 'SERVER'` las
 * acredita como «la terminal contestó». Se reconocen además por su firma: el `status: 'timeout'` con el
 * texto que redacta `failUndelivered`, que ningún aparato produce.
 */
function sobreEscritoPorElServidor(sobre: Record<string, unknown>): boolean {
  if (sobre.origin === 'SERVER') return true
  return sobre.status === 'timeout' && sobre.errorMessage === MENSAJE_DEL_SOBRE_SINTETICO
}

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

/**
 * La misma contradicción de procedencia, para quien la necesita FUERA de la transacción de la declaración.
 *
 * 🔴 P1 de Codex (20-sep): el REPLAY revalidaba con `hayAprobadoVinculadoSql`, que filtra por
 * `e."venueId" = venueId`. Un aprobado del MISMO intento que aterriza en OTRO negocio queda
 * `LINK_VENUE_MISMATCH`, NO crea `Payment` y no mueve ni el estado ni el puntero de la fila: el replay
 * respondía `released: true` y le decía al cajero «vuelve a cobrar» con el cargo ya hecho, cuando una
 * declaración NUEVA sí lo habría vetado. Enumera sus propios intentos: quien llama sólo tiene la llave.
 */
export async function hayContradiccionDeProcedencia(
  client: Prisma.TransactionClient,
  requestId: string,
  venueId: string,
): Promise<boolean> {
  const row = await client.terminalPaymentRequest.findFirst({ where: { requestId, venueId }, select: { terminalId: true } })
  if (!row) return false
  const vinculos = await client.terminalPaymentAttemptLink.findMany({ where: { requestId, venueId }, select: { attemptId: true } })
  const attemptIds = vinculos
    .map(v => llaveDeIntento(v.attemptId))
    .filter((a): a is string => Boolean(a))
    .sort()
  return contradiccionDeProcedencia(client, attemptIds, venueId, row.terminalId)
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
    // El rechazo del BANCO no tiene humano que autorizar — su credencial es la firma del webhook, que el
    // controlador ya verificó (HMAC-SHA256 contra el secreto del comercio) antes de llegar aquí. Sigue siendo
    // una puerta cerrada: `source: 'WEBHOOK'` sólo lo pone `reconcileBankDeclined`, nunca una petición HTTP.
    // 🔴 La procedencia la decide la FUENTE, jamás el cuerpo. `identity.source` lo pone el servidor
    // (`'WEBHOOK'` sólo lo escribe `reconcileBankDeclined`); `declaration.statement` viene del cliente. Si el
    // guard mirara el cuerpo —como lo escribí primero—, cualquiera que alcance el endpoint del POS podría
    // mandar `"statement":"BANK_DECLINED"` y SALTARSE el permiso del cajero. Se exigen los DOS, y que
    // coincidan: un cuerpo que se declare del banco por un camino humano es un rechazo, no un dato.
    const porElBanco = identity.source === 'WEBHOOK'
    if (porElBanco !== (declaration.statement === 'BANK_DECLINED'))
      throw new UnchargedReconciliationError('NOT_ALLOWED', 403)
    const actor = identity.actorStaffId ? await miembroConPermiso(tx, identity.venueId, identity.actorStaffId) : null
    if (!porElBanco && (!actor || !actor.permitido)) throw new UnchargedReconciliationError('NOT_ALLOWED', 403)

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
    //
    // 🔴 P1 de Codex (20-sep): el sobre tiene que venir de LA TERMINAL. `failUndelivered` escribe uno
    // SINTÉTICO —`UNKNOWN/SOCKET_NOT_FOUND` con un `timeout` que redacta el servidor— cuando el envío
    // original no encuentra su socket. Sin distinguirlo, la declaración lo leía como «la terminal
    // contestó algo» y aceptaba con todas las entregas DURABLE y sin un solo ACK del aparato. El
    // servidor marca ese sobre con `origin: 'SERVER'`; aquí se descuenta.
    const sobreCrudo =
      row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson)
        ? (row.resultJson as Record<string, unknown>)
        : null
    const sobreConRespuesta = !!sobreCrudo && Object.keys(sobreCrudo).length > 0 && !sobreEscritoPorElServidor(sobreCrudo)
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

    // 🔴 EL WEBHOOK CONFIRMA EL INTENTO, NO LA VENTA — decisión del founder (21-sep), y es la regla que
    // sostiene todo este carril.
    //
    // Codex lo demostró en dos pasadas: el rechazo del intento A no acredita el desenlace del intento B. El
    // cajero reintenta conservando la venta, A se rechaza, nace B, B autoriza mientras la fila está `SENT`, la
    // fila vence a `UNKNOWN` y ENTONCES llega el webhook demorado de A. Liberar ahí es el cobro doble, y los
    // candados no lo impiden: «serializan escrituras, NO detienen al procesador».
    //
    // 🔑 La regla, medida contra producción: **con UN solo intento el webhook es toda la verdad** — el 97,4 %
    // de las ventas (450 de 462 en 30 días) están ahí, y se liberan solas. **Con reintento el servidor no
    // puede estar seguro**, así que no toca nada: la evidencia del banco queda guardada y el cajero confirma
    // con un toque, que es lo que él sí puede hacer — tiene la pantalla de la terminal enfrente.
    //
    // ⚠️ **Residuo declarado, medido el 21-sep:** el 0,8 % de los intentos (3 de 374 desde el 19-sep) cobran
    // sin anunciarse (`DecisionDelVinculo.Legacy` de la TPV deja seguir al procesador si S1 falla), así que un
    // B invisible no aparece aquí. Es irreducible desde el servidor: si B está cobrando AHORA todavía no dejó
    // rastro. Cerrarlo de raíz es que la TPV no pueda cobrar sin anunciar — trabajo de terminal, días de
    // viaje. Mientras tanto el riesgo exige las TRES cosas a la vez: reintento, sin anunciar, y justo en la
    // ventana en que llega el rechazo del primero.
    if (porElBanco) {
      const elDelRechazo = declaration.bank?.attemptId ? llaveDeIntento(declaration.bank.attemptId) : null
      // 🔴 Sin NINGÚN vínculo tampoco se libera. Codex (5ª pasada): «el array vacío sí pasa `some()`» —
      // llamar directamente sin vínculos liberaba, y la seguridad dependía de que el llamador exigiera uno
      // antes. Una precondición externa no es una guarda: si mañana entra otro llamador, el hueco vuelve.
      if (attemptIds.length === 0 || attemptIds.some(a => a !== elDelRechazo))
        throw new UnchargedReconciliationError('ATTEMPT_NOT_ELIGIBLE')
    }

    // 🔴 P1 de Codex: lista EXPLÍCITA de estados. `SENT` y `CANCEL_REQUESTED` también son UNRESOLVED y son
    // cobros que pueden seguir corriendo: declarar sobre ellos es el camino del cobro doble.
    if (!ESTADOS_DECLARABLES.has(row.status)) throw new UnchargedReconciliationError('ATTEMPT_NOT_ELIGIBLE')
    const { desenlaceCanonico } = await import('../terminal-payment.service')
    if (desenlaceCanonico(row).outcome !== 'UNRESOLVED') throw new UnchargedReconciliationError('ATTEMPT_NOT_ELIGIBLE')

    const saved: UnchargedReconciliation = {
      id: declaration.resolutionId,
      kind: declaration.statement,
      acceptedAt: new Date().toISOString(),
      bodyHash,
      staffId: actor?.staffId ?? null,
      staffVenueId: actor?.id ?? null,
      statementVersion: declaration.statementVersion,
      source: identity.source,
      previousRequest: { status: row.status, failureCode: row.failureCode },
    }

    // CAS sobre el estado LEÍDO y sin Payment, revalidando la evidencia EN LA PROPIA ESCRITURA: si un aprobado o
    // un pago entran entre el veto y este UPDATE, devuelve 0 y no se declara nada.
    // 🔴 El motivo, con NUESTRAS palabras. Para el banco se traduce su código (lista blanca); su texto libre
    // NUNCA entra aquí — el destructive pass del 21-sep coló por ahí un «APROBADA, COBRO EXITOSO» dentro de un
    // mensaje de rechazo, y un byte nulo suyo reventaba el jsonb y tumbaba la liberación entera.
    const motivo = porElBanco ? motivoDelBanco(declaration.bank?.descripcion) : ''
    const sobreDeclarado = {
      ...sobre,
      requestId: declaration.requestId,
      status: 'failed',
      outcomeEvidence: porElBanco ? 'BANK_DECLINED' : 'OPERATOR_RECONCILED',
      // 🔴 Mensaje PROPIO: el de gerencia dice «no se presentó tarjeta», que aquí sería falso — el cliente sí
      // presentó la tarjeta; lo que no hubo fue cobro. Los POS pintan ESTE texto, no uno hardcodeado.
      errorMessage: porElBanco
        ? `El banco rechazó este cobro.${motivo ? ` ${motivo}` : ''} No se cobró nada: puedes volver a cobrar.`
        : 'El cajero revisó la terminal y confirmó que este cobro no pasó. Se puede volver a cobrar.',
      ...(porElBanco && declaration.bank
        ? {
            bankDeclined: {
              origen: declaration.bank.origen,
              eventLogId: declaration.bank.eventLogId,
              descripcion: declaration.bank.descripcion ?? null,
              at: new Date().toISOString(),
            },
          }
        : {}),
      operatorReconciliation: saved,
    }
    // 🔴 Ronda 2 de Codex (19-sep): el veto de procedencia va TAMBIÉN en la escritura. `sinEvidenciaPositivaSql`
    // exige que el evento sea de ESTE venue, así que un aprobado del MISMO intento recibido por OTRO venue
    // —que entra por un INSERT sin ningún candado— pasaba el CAS aunque la lectura sí lo habría vetado. Ése era
    // exactamente el camino que permitía declarar «no cobrado» con un aprobado durable ya guardado.
    const cas = await tx.$executeRaw`
      UPDATE "TerminalPaymentRequest"
      SET "status" = 'FAILED', "failureCode" = ${porElBanco ? 'BANK_DECLINED' : 'OPERATOR_RECONCILED_NO_CHARGE'}, "cancelDisposition" = NULL,
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
        action: porElBanco ? 'TERMINAL_PAYMENT_BANK_DECLINED_RELEASED' : 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        venueId: identity.venueId,
        staffId: actor?.staffId ?? null,
        data: {
          ...(porElBanco && declaration.bank ? { origen: declaration.bank.origen, eventLogId: declaration.bank.eventLogId } : {}),
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

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 EL RECHAZO DEL BANCO — la misma liberación, con evidencia del PROCESADOR
// ══════════════════════════════════════════════════════════════════════════════════════════════
/**
 * Cierra una solicitud atorada cuando el webhook del procesador dice que el banco **rechazó** el cobro.
 *
 * 🔑 **Por qué existe, y es una corrección de rumbo del founder (21-sep-2026):** *«todo lo que hicimos fue
 * hacer lo de webhook first. ¿Por qué seguimos con lo de "si no cobró"? eso lo podemos verificar en el
 * webhook»*. Tenía razón. El carril webhook-first se había construido **sólo en su mitad feliz**: el
 * aprobado confirma y crea dinero, y el rechazado se tiraba — `confirmarPorVinculo` hacía `return null`
 * para todo lo que no fuera `APROBADO`, y el servicio de Blumon ni siquiera menciona
 * `TerminalPaymentRequest`. Mientras tanto le pedíamos al CAJERO que declarara a mano lo que el banco ya
 * nos había contestado.
 *
 * **Medido en producción ese día (30 días, sólo lectura): 187 rechazos** — 68 de AngelPay y 119 de Blumon —
 * el 100 % con referencia, y ninguno liberaba nada.
 *
 * 🔑 **Un rechazo NUNCA crea dinero**, pero eso NO quiere decir que su único riesgo sea «cerrar la fila
 * equivocada» — así lo afirmé y Codex lo refutó: el rechazo del intento A y el cobro del intento B pertenecen
 * correctamente a la MISMA fila, y ahí el peligro no es la correlación sino dar por terminada una venta que
 * sigue ejecutándose. Por eso, además de los vetos de la declaración del cajero, este carril **sólo libera
 * cuando la venta tiene UN SOLO intento vinculado** — el 97,4 % de los casos, medido. Con reintento el
 * servidor no puede estar seguro y no toca nada: confirma el cajero, que sí ve la pantalla de la terminal.
 *
 * **Diferencias deliberadas con la declaración del cajero, y cada una tiene su motivo:**
 *
 *  | | cajero (`reconcileUncharged`) | banco (esto) |
 *  |---|---|---|
 *  | evidencia | una persona miró la pantalla | el webhook del procesador (AngelPay lo FIRMA; Blumon no, por eso Blumon no libera) |
 *  | permiso | `payments:reconcile-uncharged` | ninguno: no hay actor humano |
 *  | ¿exige que la terminal contestara? | **sí** (`constaQueSalio`) | **también sí**: al entrar por el núcleo se hereda. ⚠️ P2 abierto de Codex — con el ACK perdido un rechazo legítimo queda sin liberar, y **la declaración del cajero TAMPOCO lo salva: comparte la misma guarda**. Se deja a propósito: relajarla toca el camino que ya está en producción |
 *  | lanza | sí (`UnchargedReconciliationError`) | **nunca**: un webhook que lanza provoca reintentos del procesador. Devuelve `{closed:false, reason}` |
 *
 * 🔴 **Sólo se cierra desde `ESTADOS_DECLARABLES`** (`UNKNOWN`/`TIMED_OUT`), el mismo conjunto que la
 * declaración del cajero. ⚠️ Codex (21-sep) corrigió aquí una afirmación mía FALSA: yo decía «si el cajero está
 * reintentando, la fila está PENDING». No es cierto — con el ACK perdido el servidor escribe `UNKNOWN`
 * precisamente porque la terminal PUDO recibir y ejecutar. Por eso la correlación tiene que ser exacta (nuestra
 * llave) y no basta con el estado: es lo que dejó a Blumon fuera de la liberación automática.
 *
 * @param requestId la solicitud a cerrar. **La correlación la resuelve el llamador**, y no es igual en los dos:
 *   AngelPay devuelve NUESTRA llave (`integratorReference` → `findAttemptLink`). **Blumon NO llega aquí**: no
 *   manda nuestra llave, y su rechazo sólo guarda evidencia para que la confirme el cajero (medido: el 12,3 %
 *   de sus transacciones tienen otra del mismo importe en la misma terminal dentro de 15 min).
 */

/**
 * 🔴 Lo que el procesador manda NO se pinta tal cual: el mensaje que lee el cajero lo escribe el SERVIDOR.
 *
 * Los tres defectos que esto cierra salieron del destructive pass del 21-sep-2026, y los tres eran míos:
 *  1. una `descripcion` de 10 000 caracteres producía un mensaje de **10 078** en la pantalla del POS;
 *  2. un procesador que mandara `"APROBADA, COBRO EXITOSO"` hacía que el cajero leyera *«El banco rechazó este
 *     cobro (declined · APROBADA, COBRO EXITOSO). No se cobró nada»* — contradictorio, y en la pantalla del dinero;
 *  3. 🔴 un **byte nulo** en ese texto reventaba el jsonb de Postgres y la liberación entera moría con
 *     `reason: 'ERROR'` — o sea que el procesador podía dejar la terminal trabada, justo lo que esto evita.
 *
 * Y el tercero casi se escapa: la prueba «pasaba» porque el mensaje salía VACÍO. Sólo cayó al añadirle el
 * control positivo de que la fila quedara `FAILED`.
 */
function textoSeguro(valor: string | null | undefined, tope: number): string {
  if (typeof valor !== 'string') return ''
  // Sin caracteres de control (el NUL incluido: Postgres lo rechaza dentro de jsonb).
  const limpio = valor.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  // 🔴 Cortar por CODE POINTS, no por unidades UTF-16 (P2 de Codex, 2ª pasada, reproducido el 21-sep):
  // `.slice()` parte un par sustituto y deja un `\ud83d` suelto. Postgres exige pares válidos dentro de
  // `jsonb`, así que la transacción revienta y la liberación muere con `reason: 'ERROR'` — medido: la fila se
  // quedaba `UNKNOWN`. O sea que un emoji del procesador, al filo exacto del tope, dejaba la terminal trabada.
  // 🔑 Y el tope se mide en UNIDADES UTF-16, que es como lo cuentan `.length` y el `.max()` de Zod: cortar a
  // N code points puede dar N+1 unidades si hay un emoji, y entonces el esquema lo rechaza y la liberación
  // muere igual, sólo que con otro nombre (`NOT_ELIGIBLE` en vez de `ERROR`). Medido también el 21-sep.
  let salida = ''
  for (const caracter of limpio) {
    if (salida.length + caracter.length > tope) break
    salida += caracter
  }
  return salida
}


/**
 * 🔴 El motivo del rechazo, con NUESTRAS palabras — lista blanca de códigos, nunca la prosa del banco.
 *
 * Mismo patrón que `textoDeRechazo(declineCode)` del dashboard para Stripe, y por el mismo motivo: el texto
 * libre del procesador no puede llegar a la pantalla (el destructive pass del 21-sep metió por ahí un
 * «APROBADA, COBRO EXITOSO» dentro de un mensaje de rechazo).
 *
 * Los códigos salen de PRODUCCIÓN, no de un catálogo: 68 rechazos de AngelPay en 30 días, medidos ese día.
 * AngelPay manda `description` con el formato `<CÓDIGO> <TEXTO ES>` — `51 FONDOS INSUFICIENTES` (18),
 * `1A SE REQUIERE AUTENTICACION…` (8), `05 DECLINADA` (7), `U0 LLAMAR AL EMISOR` (6),
 * `87 DATOS DE PISTA INCORRECTOS` (5) — y `status` vale siempre `rejected`, que en la pantalla sólo sería
 * una palabra en inglés sin información.
 *
 * Un código que no esté en la lista NO inventa motivo: el mensaje queda limpio y accionable. Preferir el
 * genérico ante lo desconocido es la misma decisión que se tomó con los rechazos de Stripe.
 */
const MOTIVOS_DEL_BANCO: Record<string, string> = {
  '51': 'No tiene fondos suficientes.',
  '05': 'El banco la declinó.',
  '1A': 'La tarjeta pide autenticación: cóbrala con chip y NIP.',
  'U0': 'El banco pide que el cliente lo llame.',
  '87': 'No se leyó bien la tarjeta: vuelve a pasarla.',
  '91': 'El banco no pudo procesarla en este momento.',
  '57': 'El banco no acepta esta operación con esa tarjeta.',
  '06': 'El banco no pudo procesarla.',
  '12': 'El banco no pudo procesarla.',
  '30': 'El banco no pudo procesarla.',
  'N2': 'El banco no pudo procesarla en este momento.',
  '54': 'La tarjeta está vencida.',
  '14': 'El número de tarjeta no es válido.',
  '55': 'El NIP es incorrecto.',
  '38': 'Se agotaron los intentos de NIP.',
  '75': 'Se agotaron los intentos de NIP.',
  '65': 'La tarjeta superó su límite de operaciones.',
}

/** Sólo el CÓDIGO del inicio de la descripción (`51 FONDOS…` → `51`), y sólo si lo conocemos. */
function motivoDelBanco(descripcion: string | null | undefined): string {
  const limpio = textoSeguro(descripcion, 64)
  const codigo = /^([0-9A-Z]{2})(\s|$)/.exec(limpio)?.[1]
  return codigo ? (MOTIVOS_DEL_BANCO[codigo] ?? '') : ''
}
/**
 * El banco dijo que NO: suelta la venta y la ranura, **por el MISMO núcleo que la declaración del cajero**.
 *
 * 🔴 Esto era una función paralela de ~130 líneas, y Codex la rechazó DOS veces (21-sep-2026). Sus 4 P1 de la
 * segunda pasada decían todos lo mismo con distinta cara: **le faltaban las guardas de `reconcileUncharged`**.
 *
 *  - liberaba la venta desde UN intento sin mirar los demás ⇒ el rechazo del intento A soltaba la venta
 *    mientras el intento B seguía cobrando (cobro doble, y sin ninguna correlación equivocada);
 *  - no tomaba `candadoDeIntento`, así que un aprobado concurrente podía quedar desatendido;
 *  - no consultaba `contradiccionDeProcedencia` (un aprobado del mismo intento recibido por OTRO venue);
 *  - su CAS revalidaba menos señales que su propia lectura.
 *
 * Decisión del founder tras el segundo rechazo: **no parchar los nueve defectos, entrar por el núcleo.** Ahora
 * el rechazo del banco es una declaración más —`statement: 'BANK_DECLINED'`— cuyo autor es el SERVIDOR, con la
 * firma del webhook como credencial, y hereda entero el camino ya auditado: candado de solicitud, candados de
 * TODOS los intentos en orden estable, orden bloqueada, replay idempotente, los vetos de evidencia positiva y
 * de procedencia, el CAS que los revalida en la escritura y el asiento en la bitácora.
 *
 * 🔑 **El `resolutionId` se deriva del `eventLogId`**: un procesador que reenvíe el mismo webhook produce la
 * MISMA declaración, así que nunca puede chocar con `RESOLUTION_CONFLICT` sobre su propia liberación.
 *
 * ⚠️ Medido, no supuesto (21-sep): el reenvío **no** entra al replay idempotente del núcleo —
 * `readUnchargedReconciliation` sólo reconoce `kind: 'UNCHARGED_VERIFIED'`—, sino que cae en el veto de
 * estados y devuelve `NOT_ELIGIBLE`, porque la fila ya quedó `FAILED`. Es seguro (no reescribe ni re-audita) y
 * por eso se deja así: ampliar ese lector tocaría a todos sus consumidores sin ganar nada aquí.
 *
 * Nunca lanza: un webhook que lanza provoca reintentos en bucle del procesador.
 */
export async function reconcileBankDeclined(input: {
  venueId: string
  requestId: string
  origen: 'ANGELPAY' | 'BLUMON'
  evidencia: { eventLogId: string; attemptId?: string | null; codigo?: string | null; descripcion?: string | null }
}): Promise<{ closed: boolean; reason?: 'NOT_FOUND' | 'NOT_ELIGIBLE' | 'POSITIVE_EVIDENCE_EXISTS' | 'ERROR' }> {
  const { venueId, requestId, origen, evidencia } = input
  try {
    await reconcileUncharged(
      { venueId, requestId, actorStaffId: null, source: 'WEBHOOK' },
      {
        requestId,
        resolutionId: resolucionDelEvento(evidencia.eventLogId),
        statement: 'BANK_DECLINED',
        statementVersion: 1,
        bank: {
          origen,
          eventLogId: textoSeguro(evidencia.eventLogId, 64),
          // 🔴 P1 de Codex (4ª pasada): el `attemptId` es una IDENTIDAD, no texto para pintar. `textoSeguro`
          // sustituye controles internos por espacios, así que `"x\ty"` se convertía en `"x y"` — y podía
          // COINCIDIR con otro intento, excluyendo del veto al equivocado. La identidad se canonicaliza con
          // `llaveDeIntento`, la misma de S1 y de los candados, en todo el recorrido; lo que no sea una
          // identidad válida simplemente no se manda, y entonces no se excluye a nadie.
          ...(llaveDeIntento(evidencia.attemptId ?? '') ? { attemptId: llaveDeIntento(evidencia.attemptId ?? '') as string } : {}),
          ...(evidencia.descripcion ? { descripcion: textoSeguro(evidencia.descripcion, 300) } : {}),
        },
      },
    )
    // 🔴 P2 de Codex (2ª pasada): liberar no basta — el POS puede estar esperando el resultado en su long-poll
    // y quedarse hasta CINCO MINUTOS aunque el desenlace ya sea durable. `resolverEsperaDelPos` sólo despierta
    // si `desenlaceCanonico` ya dice algo (con `BANK_DECLINED` en `CODIGOS_SIN_COBRO`, sí), y nunca toca la
    // espera de otro venue. Va POST-COMMIT y best-effort: la liberación ya está escrita y no puede depender de
    // despertar a nadie. Mismo patrón que la resolución por no-instrumento.
    try {
      const { terminalPaymentService } = await import('../terminal-payment.service')
      await terminalPaymentService.resolverEsperaDelPos(requestId, venueId)
    } catch (err) {
      logger.warn('⚠️ [BankDeclined] liberada, pero no se pudo despertar la espera del POS', {
        requestId,
        venueId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return { closed: true }
  } catch (error) {
    const reason =
      error instanceof UnchargedReconciliationError
        ? error.code === 'ATTEMPT_NOT_FOUND'
          ? ('NOT_FOUND' as const)
          : error.code === 'POSITIVE_EVIDENCE_EXISTS'
            ? ('POSITIVE_EVIDENCE_EXISTS' as const)
            : ('NOT_ELIGIBLE' as const)
        : ('ERROR' as const)
    // 🔴 Sólo se alarma lo que NO es un desenlace esperado: que la fila no exista, no sea elegible o tenga
    // evidencia positiva es el sistema haciendo su trabajo, no un fallo.
    if (reason === 'ERROR')
      logger.error('🚨 [BankDeclined] no se pudo liberar la solicitud por el rechazo del banco', {
        requestId,
        venueId,
        origen,
        error: error instanceof Error ? error.message : String(error),
      })
    return { closed: false, reason }
  }
}

/**
 * UUID determinista del evento: un reenvío produce la MISMA declaración y nunca choca con `RESOLUTION_CONFLICT`
 * sobre su propia liberación. ⚠️ NO entra al replay idempotente del núcleo — `readUnchargedReconciliation` no
 * reconoce `kind: 'BANK_DECLINED'`—: cae en el veto de estados, como dice la nota de arriba.
 */
function resolucionDelEvento(eventLogId: string): string {
  const h = createHash('sha256').update(`bank-declined:${eventLogId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}
