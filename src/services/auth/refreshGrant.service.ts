import { Prisma, RefreshGrant } from '@prisma/client'
import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
import { ServiceUnavailableError } from '@/errors/AppError'
import { cifrarSucesor, descifrarSucesor, sucesorCifradoDisponible } from './successorCrypto'
import { revokeSession } from './session.service'
import { invalidateSession } from './sessionCache'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import socketManager from '@/communication/sockets/managers/socketManager'

/** SHA-256 en hex. El token en claro NUNCA se guarda. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function issueGrant(sessionId: string, familyId: string, token: string, expiresAt: Date) {
  return prisma.refreshGrant.create({
    data: { sessionId, familyId, tokenHash: hashToken(token), expiresAt },
  })
}

export type ResultadoRotacion =
  | {
      sucesor: string
      sessionId: string
      familyId: string
      retransmision?: true
      /** D19: el sucesor se acuñó por un eco tardío (la respuesta de la rotación anterior se perdió). Sólo para medir. */
      ecoTardio?: { minutosDesdeElConsumo: number }
    }
  | { reutilizado: true }

const REUTILIZADO: ResultadoRotacion = { reutilizado: true }

/** Ventana en la que un reintento del MISMO refresh consumido se trata como retransmisión
 * (red que se cae después de que el servidor ya rotó), no como robo. Task 9. */
const VENTANA_RETRANSMISION_MS = 60_000

/** D19: tope del eco tardío, contado desde el consumo ORIGINAL del grant presentado (ese `consumedAt` nunca se mueve). */
const TOPE_ECO_TARDIO_MS = 24 * 60 * 60 * 1000

/**
 * Presupuesto de cada transacción con el candado de la familia: los defaults de Prisma 6, escritos para que no cambien
 * sin que se note. Esperar el candado gasta del `timeout`; agotarlo es una falla operativa (ver `comoFallaOperativa`).
 */
const OPCIONES_DE_TRANSACCION = { maxWait: 2_000, timeout: 5_000 }

/**
 * Centinela INTERNO: una escritura condicional bajo el candado no afectó exactamente una fila. Se LANZA (nunca se
 * devuelve) para que Prisma revierta la transacción completa — devolver un valor confirmaría lo ya escrito (Codex r2).
 * Hoy no debería pasar: todo escritor de grants de una familia toma su candado. Es la defensa si un día uno no lo toma.
 * Nunca sale de este módulo.
 */
class EscrituraCondicionalSinFila extends Error {
  constructor() {
    super('refreshGrant: una escritura condicional bajo el candado no afectó exactamente una fila')
    this.name = 'EscrituraCondicionalSinFila'
  }
}

/**
 * Revoca TODOS los grants vivos de la familia Y la `Session` que los emitió.
 *
 * 🔴 Revocar sólo los grants dejaría vivo el access token robado durante los 10 minutos
 * que dura — por eso también se revoca la `Session` (lo que de verdad invalida un access
 * token ya emitido, vía `sid` + `isSessionAliveCached`) y se invalida su caché.
 */
async function revocarFamilia(familyId: string, client: Prisma.TransactionClient = prisma): Promise<void> {
  await client.refreshGrant.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/**
 * Borra FÍSICAMENTE el ciphertext del sucesor una vez vencida su ventana de retransmisión
 * — no basta con que `successorEncExpiresAt` haya quedado en el pasado, un ciphertext que
 * ya no se puede usar no debe seguir viviendo en la base (condición 4 de la auditoría).
 * Enganchada a un job periódico existente, ver `src/jobs/venueChatInactivityCleanup.job.ts`.
 *
 * `retry` en la lectura/escritura de entrada por `.claude/rules/cron-jobs.md`: este job
 * corre en el minuto `:00`, exactamente donde se apilan todos los demás crons de la hora.
 * Seguro de reintentar: el `where` excluye las filas que ya quedaron en null.
 *
 * D19: NO toma el candado de la familia, y no le hace falta: sólo borra cifrados vencidos y nunca toca `consumedAt`,
 * `revokedAt` ni `rotatedToId`. Si espera la fila que un eco tardío acaba de re-cifrar, Postgres reevalúa su `where`
 * sobre la versión nueva (vence en 60 s) y la deja en paz (Codex r3).
 */
export async function limpiarSucesoresVencidos(): Promise<number> {
  const { count } = await retry(
    () =>
      prisma.refreshGrant.updateMany({
        where: { successorEncExpiresAt: { lt: new Date() } },
        data: { successorEnc: null, successorEncExpiresAt: null },
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'refreshGrant.limpiarSucesoresVencidos' },
  )
  return count
}

/**
 * ¿Este grant ya consumido es un ECO del mismo cliente, o una reutilización?
 *
 * Devuelve el sucesor que ya se acuñó (misma respuesta que la primera vez) cuando el
 * ciphertext sigue vigente y la familia sigue viva; `null` cuando no hay forma honesta
 * de responder eso — fuera de la ventana, familia ya revocada por otro grant de la
 * cadena, sucesor nunca guardado (p. ej. SESSION_SUCCESSOR_ENC_KEY ausente al rotar), o
 * el descifrado falla por un motivo operativo (llave rotada a media ventana, ciphertext
 * corrupto). Ese `null` es la salida segura por defecto: nunca "no se puede saber, así
 * que dejamos pasar".
 *
 * 🔴 Vive aparte porque el MISMO criterio hace falta en VARIOS puntos de entrada (la lectura sin candado y la relectura
 * con candado de `rotateGrant`), y tenerlo en uno solo fue el defecto del 2026-09-02.
 */
function retransmisionDe(previo: {
  id: string
  familyId: string
  sessionId: string
  successorEnc: string | null
  successorEncExpiresAt: Date | null
  revokedAt: Date | null
}): ResultadoRotacion | null {
  if (!previo.successorEnc || !previo.successorEncExpiresAt || previo.successorEncExpiresAt <= new Date() || previo.revokedAt) {
    return null
  }
  try {
    const sucesor = descifrarSucesor(previo.successorEnc, {
      grantId: previo.id,
      familyId: previo.familyId,
      sessionId: previo.sessionId,
    })
    return { sucesor, sessionId: previo.sessionId, familyId: previo.familyId, retransmision: true }
  } catch {
    return null
  }
}

/**
 * El candado de la familia (D19, Codex r2 y r3). La rotación normal, el eco tardío y la revocación por reuso lo toman
 * ANTES de leer o escribir nada, y lo conservan hasta el commit o el rollback: para una misma sesión esas operaciones van
 * en fila, sin ciclo de bloqueos posible (r2 encontró que el eco tardío, que bloquea S y luego R0, y la revocación, que
 * bloquea la familia en el orden que toque, podían interbloquearse y que Postgres abortara la REVOCACIÓN).
 * Sin Redis, como manda la casa: `pg_advisory_xact_lock`. Devuelve `void`, que Prisma no sabe deserializar: de ahí el
 * `::text`.
 */
async function tomarCandadoDeFamilia(tx: Prisma.TransactionClient, familyId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('refreshGrant:' || ${familyId}, 0))::text`
}

/**
 * Lo que vio la lectura SIN candado. Sólo escoge el camino: la decisión se toma con la relectura bajo el candado.
 * - `vigente`: el grant no estaba consumido (renovación normal, o la carrera contra otra petición del mismo cliente).
 * - `consumido`: ya estaba consumido y sin eco de 60 s legible (eco tardío o reuso).
 */
type Camino = 'vigente' | 'consumido'

interface Decision {
  resultado: ResultadoRotacion
  /** Se revocaron familia y sesión en ESTA transacción: hay que invalidar la caché y cerrar sockets tras el commit. */
  revocadaLaSesion?: string
}

/** Renovación normal, ya con el candado: consume el grant (condicional) y crea su sucesor, en ESE orden. */
async function rotarConCandado(tx: Prisma.TransactionClient, grant: RefreshGrant, nuevoToken: string, nuevoExpiresAt: Date) {
  // El sucesor cifrado viaja en el MISMO updateMany que consume — así, si esta escritura
  // gana, el sucesor ya quedó persistido antes de que la respuesta pueda perderse camino
  // al cliente. Sólo se calcula si hay llave configurada (`sucesorCifradoDisponible`): sin
  // ella, `successorEnc` se queda null y la retransmisión simplemente no aplica para este
  // grant — nunca rompe la rotación.
  const datosSucesor = sucesorCifradoDisponible()
    ? {
        successorEnc: cifrarSucesor(nuevoToken, { grantId: grant.id, familyId: grant.familyId, sessionId: grant.sessionId }),
        successorEncExpiresAt: new Date(Date.now() + VENTANA_RETRANSMISION_MS),
      }
    : {}

  // 🔴 Consume primero, crea después: si se creara el sucesor antes y este consumo no fuera nuestro, quedaría un grant
  // huérfano sin enlace. Con el candado no debería perderse nunca; si se pierde, se lanza y se decide otra vez.
  const consumo = await tx.refreshGrant.updateMany({
    where: { tokenHash: grant.tokenHash, consumedAt: null, revokedAt: null },
    data: { consumedAt: new Date(), ...datosSucesor },
  })
  if (consumo.count !== 1) throw new EscrituraCondicionalSinFila()

  const sucesor = await tx.refreshGrant.create({
    data: { sessionId: grant.sessionId, familyId: grant.familyId, tokenHash: hashToken(nuevoToken), expiresAt: nuevoExpiresAt },
  })

  // Enlaza el original con su sucesor, en la MISMA transacción que el consumo: nadie ve jamás un grant consumido por una
  // rotación normal sin su sucesor (ese estado es la marca de «anulado», ver abajo).
  await tx.refreshGrant.updateMany({
    where: { id: grant.id },
    data: { rotatedToId: sucesor.id },
  })

  return { sucesor: nuevoToken, sessionId: grant.sessionId, familyId: grant.familyId }
}

/**
 * D19 · eco tardío, ya con el candado. El aparato vuelve con R0 (consumido, sin eco de 60 s) porque la respuesta con su
 * sucesor S se perdió. Si S NUNCA se usó, sin revocar y sin vencer, R0 sigue vigente, no está revocado y no han pasado
 * 24 h desde su consumo: se anula S (consumido SIN sucesor), se acuña N (el `nuevoToken` del llamador) y R0 pasa a
 * apuntar a N con su eco de 60 s (para que un reintento inmediato reciba el MISMO N). Devuelve `null` si no aplica.
 *
 * Diferencia con Shopify (que devuelve el MISMO reemplazo): aquí S muere, para que dos poseedores de la misma llave vieja
 * no puedan compartir la cadena sin que se note — quien presente S después revoca todo.
 */
async function ecoTardioConCandado(
  tx: Prisma.TransactionClient,
  r0: RefreshGrant,
  nuevoToken: string,
  nuevoExpiresAt: Date,
  ahora: Date,
): Promise<ResultadoRotacion | null> {
  if (!r0.consumedAt || !r0.rotatedToId || r0.revokedAt) return null
  // 🔴 R0 tiene que SEGUIR vigente con el candado puesto (Codex, código r1 #1): pudo pasar la validación del JWT con un
  // segundo de vida y vencer mientras esperaba en la fila del candado. Vencido, cae a la ruta de hoy (revoca).
  if (r0.expiresAt <= ahora) return null
  // Sin llave no se puede dejar el eco de 60 s de N: un segundo R0 concurrente acabaría revocando. Se queda como hoy.
  if (!sucesorCifradoDisponible()) return null
  // «Fuera de los 60 s»: si la ventana sigue abierta y aun así no hubo eco legible (cifrado que no descifra), no es esto.
  if (r0.successorEncExpiresAt && r0.successorEncExpiresAt > ahora) return null
  const transcurrido = ahora.getTime() - r0.consumedAt.getTime()
  if (transcurrido > TOPE_ECO_TARDIO_MS) return null

  const s = await tx.refreshGrant.findUnique({ where: { id: r0.rotatedToId } })
  if (!s || s.consumedAt || s.revokedAt || s.expiresAt <= ahora) return null

  // 1. S queda «anulado»: consumido y SIN sucesor. Condicional, y debe ser exactamente esta fila.
  const anulacion = await tx.refreshGrant.updateMany({
    where: { id: s.id, consumedAt: null, revokedAt: null },
    data: { consumedAt: ahora },
  })
  if (anulacion.count !== 1) throw new EscrituraCondicionalSinFila()

  // 2. N nace en la misma familia y sesión.
  const n = await tx.refreshGrant.create({
    data: { sessionId: r0.sessionId, familyId: r0.familyId, tokenHash: hashToken(nuevoToken), expiresAt: nuevoExpiresAt },
  })

  // 3. R0 pasa de S a N, sólo si seguía apuntando a S, con N cifrado (atado a la fila de R0) y 60 s de eco.
  const reenlace = await tx.refreshGrant.updateMany({
    where: { id: r0.id, rotatedToId: s.id },
    data: {
      rotatedToId: n.id,
      successorEnc: cifrarSucesor(nuevoToken, { grantId: r0.id, familyId: r0.familyId, sessionId: r0.sessionId }),
      successorEncExpiresAt: new Date(Date.now() + VENTANA_RETRANSMISION_MS),
    },
  })
  if (reenlace.count !== 1) throw new EscrituraCondicionalSinFila()

  return {
    sucesor: nuevoToken,
    sessionId: r0.sessionId,
    familyId: r0.familyId,
    ecoTardio: { minutosDesdeElConsumo: Math.round(transcurrido / 60_000) },
  }
}

/**
 * UNA transacción con el candado de la familia: relee el grant presentado y decide con ESA lectura.
 * Con `escribir: false` (después de perder una escritura condicional) sólo devuelve un eco, rechaza o revoca: nunca
 * vuelve a rotar ni a intentar el eco tardío.
 */
function decidirConCandado(p: {
  tokenHash: string
  familyId: string
  camino: Camino
  nuevoToken: string
  nuevoExpiresAt: Date
  escribir: boolean
}): Promise<Decision> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<Decision> => {
    await tomarCandadoDeFamilia(tx, p.familyId)

    const grant = await tx.refreshGrant.findUnique({ where: { tokenHash: p.tokenHash } })
    if (!grant) return { resultado: REUTILIZADO }
    const ahora = new Date()

    if (!grant.consumedAt) {
      if (!p.escribir || grant.revokedAt || grant.expiresAt <= ahora) return { resultado: REUTILIZADO }
      return { resultado: await rotarConCandado(tx, grant, p.nuevoToken, p.nuevoExpiresAt) }
    }

    // Consumido. ¿Otra petición del mismo cliente ya dejó el eco (rotación o eco tardío ganador)? Mismo sucesor.
    const eco = retransmisionDe(grant)
    if (eco) return { resultado: eco }

    const revocar = async (): Promise<Decision> => {
      await revocarFamilia(grant.familyId, tx)
      await revokeSession(grant.sessionId, 'refresh_reuse_detected', tx)
      return { resultado: REUTILIZADO, revocadaLaSesion: grant.sessionId }
    }

    // 🔴 D19 · «consumido sin sucesor» = ANULADO por un eco tardío. Una rotación normal nunca deja ese estado a la vista
    // (consume y enlaza en la misma transacción), así que quien lo presente, por CUALQUIER camino, tiene la llave que el
    // eco tardío retiró: hay dos poseedores de la misma cadena. Se revoca todo, también en la carrera perdida (Codex r1
    // #2: el dueño con S perdía contra el R0 del ladrón y quedaba fuera solo, con el ladrón adentro).
    if (!grant.rotatedToId) return revocar()

    // 🔴 CARRERA PERDIDA — dos peticiones del MISMO cliente pidiendo refresco a la vez.
    //
    // Medido en producción local el 2026-09-02 16:07 (Sunmi D3, sesión
    // cmtkmm7sv0001q0t1z0ogtsgz): el POS despertó del background, seis peticiones con el
    // access ya vencido salieron juntas y dos refrescos se SOLAPARON 915 ms. Uno rotó bien;
    // el otro recibía `reutilizado` → 401 → el cajero fuera, a media venta. Por eso el eco de arriba se mira también
    // aquí. Sin sucesor legible (llave ausente al rotar, ciphertext corrupto) no se puede afirmar de quién es este
    // token: se rechaza este refresco y punto — y NO se revoca, a propósito: convertiría una carrera perdida del cliente
    // legítimo en la muerte de su sesión.
    if (p.camino === 'vigente') return { resultado: REUTILIZADO }

    if (p.escribir) {
      const tardio = await ecoTardioConCandado(tx, grant, p.nuevoToken, p.nuevoExpiresAt, ahora)
      if (tardio) return { resultado: tardio }
    }

    // Reutilización real: el sucesor ya se usó, pasaron más de 24 h, la familia ya estaba revocada, nunca se guardó
    // sucesor o el descifrado falló. revocarFamilia + revokeSession en ESTA transacción (Task 9): si el proceso muriera
    // entre las dos, la familia quedaría revocada con la Session viva y su access token hasta 10 minutos.
    return revocar()
  }, OPCIONES_DE_TRANSACCION)
}

/**
 * P2028 (no se pudo empezar a tiempo, o se agotó el `timeout` — esperando el candado, por ejemplo) o P2034 (conflicto o
 * interbloqueo): la transacción no decidió nada y se revirtió. Es una FALLA OPERATIVA: 503, que ANDROID e iOS ya tratan
 * como «reintenta, no cierres la sesión». Nunca `{ reutilizado }` (401: cajero fuera) ni un éxito (Codex r3).
 */
async function comoFallaOperativa<T>(trabajo: () => Promise<T>): Promise<T> {
  try {
    return await trabajo()
  } catch (err) {
    const code =
      err instanceof Prisma.PrismaClientKnownRequestError
        ? err.code
        : typeof err === 'object' && err !== null
          ? (err as { code?: unknown }).code
          : undefined
    if (code === 'P2028' || code === 'P2034') {
      throw new ServiceUnavailableError('No pudimos renovar tu sesión en este momento. Intenta de nuevo.', 'SESSION_REFRESH_RETRY')
    }
    throw err
  }
}

/**
 * Rota un refresh token: consume su grant y acuña el sucesor, o reconoce un eco del mismo cliente, o detecta reutilización.
 *
 * 1. **Lectura SIN candado** del grant presentado: escoge el camino y la llave del candado (la familia de un grant nunca
 *    cambia). Si ya está consumido y su eco de 60 s es legible, se devuelve ese MISMO sucesor sin transacción (Task 9:
 *    la red se cayó después de que el servidor rotó; el cliente reintenta). Esta lectura nunca decide una escritura.
 * 2. **Una transacción con el candado de la familia** (`decidirConCandado`), que relee y decide:
 *    - vigente → renovación normal (consumo condicional + sucesor + enlace, en ese orden);
 *    - consumido con eco legible → ese mismo sucesor (el ganador de una carrera ya lo dejó);
 *    - consumido SIN sucesor → anulado: revoca familia y sesión;
 *    - carrera perdida (vigente al leer, consumido al releer) sin eco → rechaza SIN revocar, como desde el 2026-09-02;
 *    - consumido, fuera de los 60 s, S sin usar y dentro de 24 h → **eco tardío** (D19): anula S, acuña N;
 *    - cualquier otro consumido → reutilización: revoca familia y sesión en esa misma transacción.
 * 3. Si una escritura condicional no afectó su fila, la transacción LANZA y se revierte completa; se decide otra vez con
 *    el candado y sin escribir (el eco del ganador, el rechazo o el reuso).
 * 4. Tras el commit de una revocación: caché de la sesión y sockets (best-effort; jamás revierten la base).
 *
 * D19 (3-nov-2026), Sunmi OrderPAD 3, sesión cmw10ct72006jwalgs3inxnyv: el servidor rotó R0 → S a las 12:25:20, el WiFi
 * se apagó antes de que llegara la respuesta y a las 12:54:09 el aparato volvió con R0: fuera de los 60 s se revocaron
 * familia y sesión y el cajero quedó fuera. Diseño auditado por Codex en 3 rondas (bloqueantes 3 → 1 → 0):
 * `Avoqado/docs/audit/2026-11-03-d19-sesion-respuesta-perdida/`. El tope de 24 h acota la recuperación con una llave
 * VIEJA, no cuánto dura quien obtuvo N: eso se corta cuando el aparato legítimo vuelve a renovar (presenta S anulado, o
 * R0 cuyo sucesor ya se usó) y se revoca todo.
 */
export async function rotateGrant(token: string, nuevoToken: string, nuevoExpiresAt: Date): Promise<ResultadoRotacion> {
  const tokenHash = hashToken(token)

  const previo = await prisma.refreshGrant.findUnique({ where: { tokenHash } })
  if (!previo) return REUTILIZADO

  if (previo.consumedAt) {
    const eco = retransmisionDe(previo)
    if (eco) return eco
  }

  const parametros = {
    tokenHash,
    familyId: previo.familyId,
    camino: (previo.consumedAt ? 'consumido' : 'vigente') as Camino,
    nuevoToken,
    nuevoExpiresAt,
  }

  let decision: Decision
  try {
    decision = await comoFallaOperativa(() => decidirConCandado({ ...parametros, escribir: true }))
  } catch (err) {
    if (!(err instanceof EscrituraCondicionalSinFila)) throw err
    decision = await comoFallaOperativa(() => decidirConCandado({ ...parametros, escribir: false }))
  }

  if (decision.revocadaLaSesion) {
    await invalidateSession(decision.revocadaLaSesion) // después del commit, best-effort
    // Sesiones revocables (Task 11): cierra, best-effort, cualquier socket que ya estuviera abierto con esta Session —
    // el access token robado que disparó la reutilización puede tener uno abierto ahora mismo. Nunca truena.
    socketManager.disconnectBySession(decision.revocadaLaSesion)
  }
  return decision.resultado
}
