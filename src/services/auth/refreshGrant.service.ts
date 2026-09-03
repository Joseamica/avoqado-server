import { Prisma } from '@prisma/client'
import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
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

export type ResultadoRotacion = { sucesor: string; sessionId: string; familyId: string; retransmision?: true } | { reutilizado: true }

const REUTILIZADO: ResultadoRotacion = { reutilizado: true }

/**
 * Marcador INTERNO: la transacción encontró el grant ya consumido por otra petición.
 * No es un veredicto — sólo dice "alguien llegó antes"; quién fue se decide fuera de la
 * transacción, donde ya se puede leer el sucesor que ese ganador acaba de dejar.
 * Nunca sale de este módulo.
 */
const CARRERA_PERDIDA = Symbol('carrera-perdida')

/** Ventana en la que un reintento del MISMO refresh consumido se trata como retransmisión
 * (red que se cae después de que el servidor ya rotó), no como robo. Task 9. */
const VENTANA_RETRANSMISION_MS = 60_000

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
 * 🔴 Vive aparte porque el MISMO criterio hace falta en DOS puntos de entrada, y tenerlo
 * en uno solo fue el defecto: ver el bloque "carrera perdida" en `rotateGrant`.
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
 * Consume el grant y crea su sucesor en UNA transacción.
 *
 * 🔴 El consumo es un UPDATE CONDICIONAL (`consumedAt: null` en el `where`) y se exige
 * exactamente una fila: es lo único que impide que dos refresh concurrentes consuman
 * el mismo grant y acuñen dos sucesores distintos.
 *
 * Orden deliberado — CONSUME primero, CREA después (al revés del snippet de referencia
 * del brief, que creaba el sucesor antes de consumir):
 *
 *   1. findUnique de sólo lectura, para validar existencia/estado/vigencia.
 *   2. updateMany condicional que consume el grant viejo — aquí se decide la carrera.
 *   3. Sólo si esa fila fue nuestra (count === 1) se crea el sucesor y se enlaza
 *      `rotatedToId` de vuelta al original.
 *
 * Si se creara el sucesor ANTES del updateMany (como en la referencia) y el updateMany
 * devolviera 0 porque otro refresh concurrente ganó la carrera, ese sucesor quedaría
 * huérfano: nadie puede llegar a él (el `rotatedToId` del original nunca se escribe,
 * porque el original ya no es nuestro para actualizarlo) y nadie lo va a consumir jamás.
 * Revertir la transacción entera con un throw evitaría el huérfano en la base de datos
 * real, pero un `create` que ya se ejecutó (aunque luego se revierta) sigue siendo un
 * `create` que se intentó — y el requisito duro es que un refresh perdedor no acuñe
 * sucesor. Consumir primero hace que esa fila jamás llegue a intentarse: no hay nada que
 * revertir porque no hay nada que crear hasta que ya ganamos la carrera.
 *
 * 🔴 Task 9 — pre-chequeo de retransmisión, ANTES de la transacción de arriba:
 *
 * Un grant que YA está `consumedAt` no siempre es un robo. Puede ser el propio cliente
 * reintentando porque la respuesta de la rotación anterior se perdió (red intermitente en
 * el mostrador) — el servidor sí rotó, sólo que nadie se enteró. Por eso, antes de tocar
 * la transacción de la Task 8, se lee el grant por fuera (lectura simple, sin lock: el
 * peor caso de una carrera aquí es tratar una retransmisión legítima como reutilización,
 * nunca al revés — la mutación real sigue protegida por el `updateMany` condicional de
 * abajo) y se decide entre dos caminos:
 *
 * - **Retransmisión legítima** (`successorEnc` vigente, `successorEncExpiresAt > ahora`, Y la
 *   familia SIGUE VIVA — `!previo.revokedAt`): se descifra y se devuelve **el mismo** sucesor
 *   que ya se acuñó la primera vez. Nunca se acuña uno distinto ni se toca la `Session` — no
 *   es robo, es un eco.
 * - **Reutilización real** (fuera de la ventana, sin sucesor guardado — p.ej. la llave de
 *   cifrado no estaba configurada cuando se rotó — el descifrado falla por un motivo
 *   operativo, o **la familia ya fue revocada por OTRO grant de la cadena**): se revoca la
 *   familia entera y la `Session` en UNA transacción, y se invalida su caché. Éste es el
 *   camino caro, y es el correcto: un refresh consumido que reaparece pasados los 60 s, o
 *   cuya familia ya está muerta, ya no tiene forma honesta de existir.
 *
 * 🔴 [Auditoría Task 9] `previo.revokedAt` importa aunque ESTE grant no haya sido el que
 * disparó la reutilización: `revocarFamilia` revoca TODOS los grants vivos de la familia de
 * un jalón, así que un HERMANO de `previo` puede haber sido el que detectó el robo. Sin este
 * chequeo, un reintento legítimo —dentro de SU PROPIA ventana de 60s— de un grant cuya
 * familia ya murió se devolvía como retransmisión: el llamador nunca se entera de que la
 * familia está muerta, y ninguna alerta atada a `reutilizado` se dispara.
 *
 * 🔴 [Auditoría Task 9] `revocarFamilia` + `revokeSession` viajan en UNA transacción: sin
 * esto, si el proceso muere entre las dos, la familia queda revocada pero la `Session` sigue
 * viva con su access token hasta 10 minutos — justo el escenario que esta tarea existe para
 * cerrar. `invalidateSession` (Redis) va DESPUÉS del commit: es best-effort y jamás debe
 * poder hacer fallar o revertir la transacción de la base de datos.
 */
export async function rotateGrant(token: string, nuevoToken: string, nuevoExpiresAt: Date): Promise<ResultadoRotacion> {
  const tokenHash = hashToken(token)

  const previo = await prisma.refreshGrant.findUnique({ where: { tokenHash } })
  if (previo && previo.consumedAt) {
    const eco = retransmisionDe(previo)
    if (eco) return eco

    // Reutilización real: fuera de la ventana de retransmisión, la familia ya estaba
    // revocada por otro grant de la cadena, nunca se guardó sucesor (p. ej.
    // SESSION_SUCCESSOR_ENC_KEY no estaba configurada al rotar), o el descifrado falló.
    //
    // 🔴 [Auditoría Task 9] revocarFamilia + revokeSession comparten UNA transacción — ver el
    // docstring de arriba. invalidateSession (Redis) va DESPUÉS del commit, best-effort.
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await revocarFamilia(previo.familyId, tx)
      await revokeSession(previo.sessionId, 'refresh_reuse_detected', tx)
    })
    await invalidateSession(previo.sessionId) // después del commit de arriba
    // Sesiones revocables (Task 11): cierra, best-effort, cualquier socket que ya
    // estuviera abierto con esta Session — el access token robado que disparó la
    // reutilización puede tener uno abierto ahora mismo. Nunca truena (ver docstring de
    // `disconnectBySession`), así que no hace falta su propio try/catch aquí.
    socketManager.disconnectBySession(previo.sessionId)
    return REUTILIZADO
  }

  const resultado = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const grant = await tx.refreshGrant.findUnique({ where: { tokenHash } })
    if (!grant) return REUTILIZADO
    // Un grant CONSUMIDO entre el pre-chequeo de arriba y este instante es una carrera
    // contra otra petición del MISMO cliente, no un grant inválido: se resuelve fuera de
    // la transacción (ver abajo). Revocado o vencido sí son rechazos definitivos.
    if (grant.consumedAt) return CARRERA_PERDIDA
    if (grant.revokedAt || grant.expiresAt <= new Date()) {
      return REUTILIZADO
    }

    // El sucesor cifrado viaja en el MISMO updateMany que consume — así, si esta escritura
    // gana la carrera de abajo, el sucesor ya quedó persistido antes de que la respuesta
    // pueda perderse camino al cliente. Sólo se calcula si hay llave configurada
    // (`sucesorCifradoDisponible`): sin ella, `successorEnc` se queda null y la
    // retransmisión simplemente no aplica para este grant — nunca rompe la rotación.
    const datosSucesor = sucesorCifradoDisponible()
      ? {
          successorEnc: cifrarSucesor(nuevoToken, { grantId: grant.id, familyId: grant.familyId, sessionId: grant.sessionId }),
          successorEncExpiresAt: new Date(Date.now() + VENTANA_RETRANSMISION_MS),
        }
      : {}

    const consumo = await tx.refreshGrant.updateMany({
      where: { tokenHash, consumedAt: null, revokedAt: null },
      data: { consumedAt: new Date(), ...datosSucesor },
    })
    if (consumo.count !== 1) {
      // Otro refresh concurrente (o un reintento) ganó la carrera entre el findUnique y
      // aquí. No se acuña sucesor: sería un grant sin dueño, porque el original ya no es
      // nuestro para enlazarlo con `rotatedToId`. Quién es ese "otro" se decide fuera de
      // la transacción — ver el bloque de carrera perdida.
      return CARRERA_PERDIDA
    }

    const sucesor = await tx.refreshGrant.create({
      data: { sessionId: grant.sessionId, familyId: grant.familyId, tokenHash: hashToken(nuevoToken), expiresAt: nuevoExpiresAt },
    })

    // Enlaza el original con su sucesor. Seguro por `id` (clave única): ya ganamos la
    // única carrera que importaba en el paso anterior, así que esta escritura no compite
    // con nadie — es contabilidad, no concurrencia.
    await tx.refreshGrant.updateMany({
      where: { id: grant.id },
      data: { rotatedToId: sucesor.id },
    })

    return { sucesor: nuevoToken, sessionId: grant.sessionId, familyId: grant.familyId }
  })

  if (resultado !== CARRERA_PERDIDA) return resultado

  // 🔴 CARRERA PERDIDA — dos peticiones del MISMO cliente pidiendo refresco a la vez.
  //
  // Medido en producción local el 2026-09-02 16:07 (Sunmi D3, sesión
  // cmtkmm7sv0001q0t1z0ogtsgz): el POS despertó del background, seis peticiones con el
  // access ya vencido salieron juntas y dos refrescos se SOLAPARON 915 ms. Uno rotó bien;
  // el otro perdió este `updateMany` y recibía `reutilizado` → 401 «Tu sesión ya no es
  // válida» → el cajero fuera, a media venta. La base lo desmiente: NADA quedó revocado —
  // ni la `Session` ni un solo grant de la familia. No hubo robo; hubo concurrencia.
  //
  // El criterio para contestarle bien ya existía y estaba a un `if` de distancia: el
  // ganador acaba de dejar su sucesor cifrado en la MISMA fila, vigente 60 s. La ventana
  // de retransmisión cubría "el cliente reintenta DESPUÉS" y dejaba fuera "las dos
  // peticiones se SOLAPAN" — que es justo lo que produce el wifi del mostrador. Se relee
  // FUERA de la transacción: para entonces el ganador ya commiteó, así que su sucesor es
  // legible; releer dentro dependería del nivel de aislamiento.
  const ganador = await prisma.refreshGrant.findUnique({ where: { tokenHash } })
  if (ganador) {
    const eco = retransmisionDe(ganador)
    if (eco) return eco
  }

  // Sin sucesor legible (llave ausente al rotar, ciphertext corrupto, ventana vencida) no
  // se puede afirmar de quién es este token: se rechaza este refresco y punto.
  //
  // 🔴 Y NO se revoca la familia, a propósito — es el comportamiento que ya tenía esta
  // rama. Revocar aquí convertiría una carrera perdida del cliente legítimo en la muerte
  // de su sesión, que es exactamente el daño que este bloque existe para evitar. La
  // reutilización de verdad —un token consumido que reaparece pasada la ventana— sigue
  // entrando por el pre-chequeo de arriba, que sí revoca.
  return REUTILIZADO
}
