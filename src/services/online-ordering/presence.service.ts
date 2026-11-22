import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { closesAt, isWithinHours } from './hours'
import {
  FOLIO_LAST_CALL_MINUTES,
  MAX_PENDING_PER_VENUE,
  PRESENCE_WINDOW_MS,
  FOLIO_PRESENCE_WINDOW_MS,
  PRESENCE_WRITE_DEBOUNCE_MS,
  awaitingAcceptanceWhere,
  liveCardDraftsWhere,
} from './constants'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getSettings, preloadReservationHours } from './settings.service'
import { pausaSolaDesde } from './interruptorPausaSola'
import { emitStoreChanged } from './traySocket'
import type { AcceptingReason, AcceptingState, AcceptingStatus } from './types'

// En memoria a propósito (una sola instancia): amortigua la escritura; la verdad es la columna.
const lastWrite = new Map<string, number>()
// R11: llave propia del latido de folios; si compartiera mapa, la Bandeja abierta le «comería» el latido a la TPV.
const lastToPayWrite = new Map<string, number>()

export function __resetPresenceDebounceForTests(): void {
  lastWrite.clear()
  lastToPayWrite.clear()
}

/**
 * La bandeja abierta consultó ahora: eso demuestra que hay alguien mirando. Devuelve `true` si escribió.
 * R13: el debounce se mueve SÓLO si la escritura funcionó; un fallo no puede callar el siguiente latido.
 * Sin fila de ajustes no hay nada que actualizar (la tienda está apagada).
 */
export async function touchInboxPoll(venueId: string, now: Date = new Date()): Promise<boolean> {
  const last = lastWrite.get(venueId) ?? 0
  if (now.getTime() - last < PRESENCE_WRITE_DEBOUNCE_MS) return false
  await prisma.onlineOrderingSettings.updateMany({ where: { venueId }, data: { lastInboxPollAt: now } })
  lastWrite.set(venueId, now.getTime())
  return true
}

/**
 * Tienda híbrida: un aparato que PUEDE cobrar folios (TPV o POS) consultó ahora. Si aún no hay fila de ajustes, el primer latido la
 * crea apagada y en «Mi equipo» (R37), con el horario de reservas precargado, bajo el mismo candado de `updateSettings`.
 */
export async function touchToPayPoll(venueId: string, now: Date = new Date()): Promise<boolean> {
  const last = lastToPayWrite.get(venueId) ?? 0
  if (now.getTime() - last < PRESENCE_WRITE_DEBOUNCE_MS) return false
  const { count } = await prisma.onlineOrderingSettings.updateMany({ where: { venueId }, data: { lastToPayPollAt: now } })
  if (count === 0) {
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'online-ordering-settings:' + venueId}))`
      const hours = await preloadReservationHours(tx, venueId)
      await tx.onlineOrderingSettings.upsert({
        where: { venueId },
        // D662 parte 2: una fila nueva nace con el corte de la pausa sola puesto (sin la gracia del despliegue; Codex p2-r5 #2).
        create: {
          venueId,
          enabled: false,
          requiresAcceptance: true,
          lastToPayPollAt: now,
          autoPauseResumedAt: now,
          ...(hours ? { hours } : {}),
        },
        update: { lastToPayPollAt: now },
      })
    })
  }
  lastToPayWrite.set(venueId, now.getTime())
  return true
}

/**
 * Lo que el panel, la bandeja y el MCP muestran del estado de la tienda: un solo armado. D662 parte 2 (aditivo): `autoPausedAt`, la
 * tienda se pausó sola por 2 pedidos sin atender; un cliente viejo no lo lee y dice «Pausada» por el `reason`.
 *
 * v4 (hueco 2, `pestanaVieja`): el DASHBOARD de antes de este cambio sólo enseña «Reanudar» con `PAUSED` + `MANUAL_PAUSE` + `pausedUntil`.
 * A quien no avisa que entiende la pausa sola (`?pausaSola=1`) se le manda, sólo con la pausa sola y sin otra pausa, `pausedUntil` =
 * la hora en que se pausó: su bandeja muestra «Pausada hasta <esa hora>» y «Reanudar» (que manda `pause(null)`, el mismo «Reanudar»).
 */
export function storeView(state: AcceptingState, opts: { pestanaVieja?: boolean } = {}) {
  const autoPausedAt = state.autoPausedAt ?? null
  // Una pausa de 15/30/60 YA VENCIDA cuenta como ausente (su `pausedUntil` se queda en la fila): si no, la pestaña vieja diría «Pausada
  // hasta <una hora que ya pasó>». Vencida con la misma regla y el mismo reloj con que se decidió el estado (`getAcceptingStatus`).
  const ahora = state.leidoEn ?? new Date()
  const pausaTemporalVigente = !!state.config.pausedUntil && new Date(state.config.pausedUntil) > ahora
  const comoPausaConHora = opts.pestanaVieja === true && !!autoPausedAt && !state.config.manualPause && !pausaTemporalVigente
  return {
    status: state.status,
    reason: state.reason,
    pausedUntil: comoPausaConHora ? autoPausedAt : state.config.pausedUntil,
    manualPause: state.config.manualPause,
    autoPausedAt,
  }
}

export const PAUSA_SOLA_TOPE = 1000
/**
 * Lo que pasó hace más de esto ya es definitivo: una escritura con su hora tomada se confirma, a lo más, al vencer la transacción
 * (`ORDER_LOCK_WAIT_BUDGET.timeout`, 15 s). Para subir el corte y para saber si una pausa ya no necesita esperar a nadie.
 */
export const MARGEN_DEFINITIVO_MS = 30_000
/** La lectura sube el corte (sin esperarlo) cuando puede avanzar al menos esto: una escritura cada pocos minutos por negocio activo. */
export const AVANCE_MINIMO_MS = 5 * 60_000
/** Cuántas cuentas, como mucho, se revisan con candado antes de decir «en pausa» (más que eso: se espera al margen definitivo). */
export const TOPE_CUENTAS_EN_ESPERA = 1000
/** Cuánto, como mucho, espera una lectura a lo que se está guardando (las transacciones que lo guardan duran 15 s como máximo). */
export const ESPERA_MAXIMA_MS = 20_000
const ESPERA_ENTRE_INTENTOS_MS = 25

/** Pausas recientes ya confirmadas (por negocio, el pedido que la pausó): las demás lecturas de esos 30 s no vuelven a esperar. */
const pausasConfirmadas = new Map<string, string>()
export function __resetPausasConfirmadasParaPruebas(): void {
  pausasConfirmadas.clear()
}

export interface LecturaPausaSola {
  /** La segunda falla de la primera pareja (hora límite y pedido), o `null` si no hay pausa. */
  pausa: { at: Date; onlineOrderId: string } | null
  /** Hasta dónde puede subir el corte sin cambiar ninguna lectura futura, o `null` (hay pausa o no se sabe). */
  corteSeguro: Date | null
  /** Si la lectura volvió a leer los ajustes tras esperar: su versión (`version`, la que de verdad usó). */
  versionReleida?: number | null
}

interface VueltaPausaSola {
  fallas: number
  ultimaFalla: Date | null
  /** La última falla si NO hubo una respuesta a tiempo después de ella (puede formar pareja con la siguiente); si no, `null`. */
  fallaSuelta: Date | null
  pausaId: string | null
  pausaAt: Date | null
  /** La hora límite de la PRIMERA falla de la pareja (la que se revisa con candado si la pausa es reciente). */
  pausaDesde: Date | null
}

/**
 * D662 parte 2 (founder, 19-nov, «a»; v4 «cero huecos», 20-nov «C»): la pausa sola se LEE de los pedidos, no se lleva. La decide
 * Postgres en UNA consulta exacta:
 * - FALLA: un pedido de «Mi equipo» llegó a su hora límite (ya pasó) sin que una persona lo contestara a más tardar en ella
 *   (`staffAnsweredAt` vacío o después). No se borra: un rechazo tardío, la clienta que cancela tarde o un cobro no la quitan.
 *   No cuenta lo que terminó solo ANTES de su hora límite (la clienta lo canceló; el sistema lo rechazó por pago sin persona). Lo que
 *   contestó el SERVIDOR anterior no trae la marca: no cuenta porque su hora límite es anterior al interruptor (`interruptorPausaSola.ts`).
 * - RESPUESTA: una persona contestó A TIEMPO un pedido (`staffAnsweredAt <= su hora límite`), a la hora en que lo hizo, aunque su
 *   hora límite sea mucho después. Se busca con `EXISTS` sobre `(venueId, staffAnsweredAt)`, sin tope.
 * - PAUSADA: hay dos fallas seguidas (por hora límite y `id`) sin una respuesta en `(primera, segunda]`: a la misma hora la respuesta
 *   va primero. Se queda así aunque después llegue una respuesta: sólo «Reanudar» sube el corte.
 * Techo aceptado: T1 (quien ya estaba pagando termina). T2 y la cancelación al filo ya no parpadean: ver `vueltaConfirmada` y `esperarLoQueSeGuarda`.
 */
const respondioATiempo = Prisma.raw(`(oo."staffAnsweredAt" IS NOT NULL AND oo."staffAnsweredAt" <= oo."acceptDeadlineAt")`)

/** ¿Una persona contestó a tiempo algún pedido en (desde, hasta]? `desdeSql`/`hastaSql` ya son SQL, nunca un `Date`. */
const hayRespuestaEntre = (venueId: string, desdeSql: Prisma.Sql, hastaSql: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "OnlineOrder" s
  WHERE s."venueId" = ${venueId} AND s."requiresAcceptance" = true
    AND s."staffAnsweredAt" > ${desdeSql} AND s."staffAnsweredAt" <= ${hastaSql} AND s."staffAnsweredAt" <= s."acceptDeadlineAt"
)`

async function vueltaPausaSola(venueId: string, now: Date, corte: Date): Promise<VueltaPausaSola> {
  const [fila] = await prisma.$queryRaw<VueltaPausaSola[]>`
    WITH f AS (
      SELECT oo.id, oo."acceptDeadlineAt" AS t
      FROM "OnlineOrder" oo
      WHERE oo."venueId" = ${venueId}
        AND oo."requiresAcceptance" = true
        AND oo."acceptDeadlineAt" > ${utcTs(corte)}
        AND oo."acceptDeadlineAt" <= ${utcTs(now)}
        AND NOT ${respondioATiempo}
        AND NOT COALESCE(oo."cancelledBy" = 'CUSTOMER' AND oo."cancelledAt" <= oo."acceptDeadlineAt", false)
        AND NOT COALESCE(
          oo."rejectReason" = 'PAYMENT_FAILED' AND oo."staffAnsweredAt" IS NULL AND oo."rejectedAt" <= oo."acceptDeadlineAt",
          false
        )
      ORDER BY oo."acceptDeadlineAt" ASC, oo.id ASC
      LIMIT ${PAUSA_SOLA_TOPE}
    ),
    p AS (SELECT f.id, f.t, LAG(f.t) OVER (ORDER BY f.t ASC, f.id ASC) AS prev FROM f)
    SELECT
      (SELECT count(*)::int FROM f) AS "fallas",
      (SELECT max(f.t) FROM f) AS "ultimaFalla",
      CASE
        WHEN (SELECT max(f.t) FROM f) IS NULL THEN NULL
        WHEN ${hayRespuestaEntre(venueId, Prisma.sql`(SELECT max(f.t) FROM f)`, utcTs(now))} THEN NULL
        ELSE (SELECT max(f.t) FROM f)
      END AS "fallaSuelta",
      par.id AS "pausaId",
      par.t AS "pausaAt",
      par.prev AS "pausaDesde"
    FROM (SELECT 1) AS uno
    LEFT JOIN LATERAL (
      SELECT p.id, p.t, p.prev
      FROM p
      WHERE p.prev IS NOT NULL
        AND NOT ${hayRespuestaEntre(venueId, Prisma.sql`p.prev`, Prisma.sql`p.t`)}
      ORDER BY p.t ASC, p.id ASC
      LIMIT 1
    ) AS par ON true`
  return fila ?? { fallas: 0, ultimaFalla: null, fallaSuelta: null, pausaId: null, pausaAt: null, pausaDesde: null }
}

const esperar = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** El error de `FOR SHARE NOWAIT` cuando alguien tiene tomada una cuenta (55P03, `lock_not_available`). */
function esCandadoOcupado(error: unknown): boolean {
  const texto = error instanceof Error ? `${error.message} ${JSON.stringify((error as { meta?: unknown }).meta ?? {})}` : String(error)
  return texto.includes('55P03') || texto.includes('could not obtain lock')
}

/**
 * Los únicos pedidos cuya escritura en curso puede cambiar el veredicto: sin marca y todavía por aceptar en lo que esta lectura ve (lo
 * que se está guardando aún no se ve), con hora límite ≥ la primera falla. Una marca nunca se pisa, y lo ya contestado, vencido o
 * cancelado no vuelve a «por aceptar»: lo demás ya es definitivo. Así el conjunto es a lo más el tope de pedidos por aceptar
 * (Codex p2v4-r1 #6: no se cuentan las cancelaciones viejas).
 */
const pendientesQuePuedenCambiarlo = (venueId: string, desde: Date) => Prisma.sql`
  oo."venueId" = ${venueId} AND oo."requiresAcceptance" = true AND oo."acceptDeadlineAt" >= ${utcTs(desde)}
  AND oo."staffAnsweredAt" IS NULL AND oo.status = 'PENDING_ACCEPTANCE'`

/**
 * v4 (founder 20-nov, «C»: sin parpadeo). Todo escritor que puede quitar una falla (aceptar, rechazar, anular la cuenta, pasar la tarjeta a
 * cobrarse, la clienta que cancela, el rechazo por pago) toma el candado de la CUENTA (`Order`, `lockExistingOrderForPayment`) ANTES de
 * leer su reloj. Antes de decir «en pausa» por una pareja reciente, la lectura toma en modo compartido, sin hacer fila (`NOWAIT`), las
 * cuentas de todos los pedidos de «Mi equipo» con hora límite ≥ la de la primera falla: las únicas cuyas escrituras pueden cambiar el
 * veredicto. Si alguna está tomada, espera y reintenta; al tenerlas todas, todo escritor con reloj anterior ya guardó y cualquiera que
 * venga después toma su reloj después de la hora límite (su respuesta llega tarde). Sin fila no hay abrazo mortal con quien toma dos
 * cuentas. Más de `TOPE_CUENTAS_EN_ESPERA` cuentas: se espera al margen definitivo (ninguna transacción dura más de 15 s).
 */
async function esperarLoQueSeGuarda(venueId: string, desde: Date, pausaAt: Date): Promise<void> {
  // Después de `L(B) + 30 s` toda escritura con reloj anterior a `L(B)` ya terminó (las transacciones duran 15 s como máximo): una cuenta
  // tomada después ya no puede cambiar el veredicto y no se le espera (Codex p2v4-r2 #2: una fusión larga no detiene la pausa).
  // Con el reloj de AHORA (no el de la entrada: Codex p2v4-r3 #3), nunca más allá de L(B) + 30 s.
  const limite = Math.min(Date.now() + ESPERA_MAXIMA_MS, pausaAt.getTime() + MARGEN_DEFINITIVO_MS)
  for (;;) {
    try {
      const desenlace = await prisma.$transaction(async tx => {
        const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM "OnlineOrder" oo WHERE ${pendientesQuePuedenCambiarlo(venueId, desde)}`
        if (n > TOPE_CUENTAS_EN_ESPERA) return 'MUCHAS' as const
        // v5: aquí se probó NO esperar a transacciones que empezaron después de L(B) (por `xmax` y `pg_stat_activity`), y se quitó: mezcla
        // el reloj del SERVIDOR con el de Postgres y, con un desfase, puede saltarse una aceptación a tiempo y dar una pausa falsa (Codex
        // p2v5-r2 #5). Se espera a quien tenga la cuenta tomada, con el tope de `L(B) + 30 s` (decisión pendiente del founder, r4 #3).
        await tx.$queryRaw`
          SELECT o.id FROM "Order" o
          WHERE o."venueId" = ${venueId}
            AND o.id IN (SELECT oo."orderId" FROM "OnlineOrder" oo WHERE ${pendientesQuePuedenCambiarlo(venueId, desde)})
          FOR SHARE OF o NOWAIT`
        return 'LISTO' as const
      })
      if (desenlace === 'MUCHAS') {
        const falta = limite - Date.now()
        if (falta > 0) await esperar(falta)
      }
      return
    } catch (error) {
      if (!esCandadoOcupado(error) || Date.now() >= limite) {
        if (esCandadoOcupado(error)) {
          logger.warn('[OnlineOrdering] la pausa sola dejó de esperar una cuenta tomada (ya no puede cambiar el veredicto)', { venueId })
          return
        }
        throw error
      }
      await esperar(ESPERA_ENTRE_INTENTOS_MS)
    }
  }
}

/**
 * Una vuelta de la lectura y, si dio una pareja reciente sin confirmar, la espera y la relectura (hasta 3 veces). Después de esperar se
 * vuelve a leer el corte propio (Codex p2v4-r1 #4: un «Reanudar» guardado durante la espera ya cuenta).
 */
async function vueltaConfirmada(
  venueId: string,
  now: Date,
  corte: Date,
): Promise<{ v: VueltaPausaSola; corte: Date; releido: number | null }> {
  let releido: number | null = null
  let v = await vueltaPausaSola(venueId, now, corte)
  for (let intento = 0; intento < 3; intento++) {
    if (!v.pausaId || !v.pausaAt || !v.pausaDesde) return { v, corte, releido }
    if (now.getTime() - v.pausaAt.getTime() >= MARGEN_DEFINITIVO_MS) return { v, corte, releido }
    if (pausasConfirmadas.get(venueId) === v.pausaId) return { v, corte, releido }
    await esperarLoQueSeGuarda(venueId, v.pausaDesde, v.pausaAt)
    const fila = await prisma.onlineOrderingSettings.findUnique({
      where: { venueId },
      select: { autoPauseResumedAt: true, version: true },
    })
    // Codex p2v4-r3 #5: la respuesta lleva la versión de los ajustes que de verdad usó (la de esta relectura).
    releido = fila?.version ?? null
    const propio = fila?.autoPauseResumedAt ?? null
    if (propio && propio.getTime() > corte.getTime()) corte = propio
    const antes = v.pausaId
    v = await vueltaPausaSola(venueId, now, corte)
    if (v.pausaId && v.pausaId === antes) {
      pausasConfirmadas.set(venueId, v.pausaId)
      return { v, corte, releido }
    }
  }
  return { v, corte, releido }
}

/**
 * Hasta dónde puede subir el corte tras una vuelta sin pareja: lo de hace más de 30 s es definitivo, y una falla que sigue sin
 * respuesta detrás se queda (puede formar pareja con la siguiente). Con la vuelta llena (tope de fallas), además, no pasa de la última
 * falla leída: las que siguen no se han visto.
 */
function corteTrasVuelta(v: VueltaPausaSola, now: Date, completa: boolean): Date {
  let corte = now.getTime() - MARGEN_DEFINITIVO_MS
  const retiene = completa ? v.fallaSuelta : v.ultimaFalla
  if (retiene) corte = Math.min(corte, retiene.getTime() - 1)
  return new Date(corte)
}

/** Sube el corte propio a [nuevo] sólo si eso lo sube (nunca lo baja; vacío = sin corte propio, cualquier valor lo sube). */
async function subirCorte(venueId: string, nuevo: Date): Promise<boolean> {
  const r = await prisma.onlineOrderingSettings.updateMany({
    where: { venueId, OR: [{ autoPauseResumedAt: null }, { autoPauseResumedAt: { lt: nuevo } }] },
    data: { autoPauseResumedAt: nuevo },
  })
  return r.count === 1
}

/** Lo mismo, sin esperar ni lanzar: la lectura nunca se frena ni falla por esto. */
function subirCorteSinEsperar(venueId: string, nuevo: Date): void {
  void Promise.resolve()
    .then(() => subirCorte(venueId, nuevo))
    .catch(error =>
      logger.warn('[OnlineOrdering] no se pudo subir el corte de la pausa sola (la lectura sigue exacta)', {
        venueId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
}

/**
 * La pausa sola de un negocio. v5: cuenta desde el corte efectivo `max(corte propio, interruptor)`; sin interruptor
 * o antes de su hora, no existe. Si una vuelta trae el tope de fallas sin pareja, sube el corte y da otra,
 * las que hagan falta (Codex p2-r8 #5: sin tope de vueltas; cada vuelta llena sube el corte al menos una falla). Sin pausa y si el corte
 * puede subir bastante, lo sube sin esperar: así la lectura de mañana es corta.
 */
async function leerPausaSola(venueId: string, now: Date, corteGuardado: Date | null, avance = AVANCE_MINIMO_MS): Promise<LecturaPausaSola> {
  // v5: sin interruptor (o antes de su hora) la pausa sola no existe. Cuentan las horas límite ≥ la del interruptor (la consulta usa `>`).
  const desde = await pausaSolaDesde()
  if (!desde || now.getTime() < desde.getTime()) return { pausa: null, corteSeguro: null }
  const inicio = new Date(desde.getTime() - 1)
  const base = corteGuardado && corteGuardado.getTime() > inicio.getTime() ? corteGuardado : inicio
  let corte = base
  let versionReleida: number | null = null
  for (;;) {
    const confirmada = await vueltaConfirmada(venueId, now, corte)
    const v = confirmada.v
    corte = confirmada.corte
    if (confirmada.releido !== null && (versionReleida === null || confirmada.releido > versionReleida)) versionReleida = confirmada.releido
    if (v.pausaId && v.pausaAt) return { pausa: { at: v.pausaAt, onlineOrderId: v.pausaId }, corteSeguro: null, versionReleida }
    const completa = v.fallas < PAUSA_SOLA_TOPE
    const seguro = corteTrasVuelta(v, now, completa)
    const sube = seguro.getTime() > corte.getTime() ? seguro : null
    if (completa) {
      if (sube && sube.getTime() - base.getTime() >= avance) subirCorteSinEsperar(venueId, sube)
      return { pausa: null, corteSeguro: seguro, versionReleida }
    }
    if (!sube) {
      // No puede pasar (una vuelta llena retiene su última falla, posterior al corte); si pasara, no se queda en un ciclo.
      logger.warn('[OnlineOrdering] la lectura de la pausa sola no pudo avanzar el corte', { venueId, tope: PAUSA_SOLA_TOPE })
      return { pausa: null, corteSeguro: null }
    }
    await subirCorte(venueId, sube)
    corte = sube
  }
}

/**
 * D662 parte 2: sube el corte (`autoPauseResumedAt`) hasta donde la lectura lo permite (`corteSeguro`), SÓLO si la tienda no está
 * pausada sola. Nunca lo baja, nunca lanza: si falla, la lectura sólo sale más larga. La llaman, después del commit, las respuestas de
 * una persona (aceptar, rechazar, aceptar con tarjeta); la lectura de la tienda también lo sube sola cada pocos minutos.
 */
export async function avanzarCortePausaSola(venueId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const fila = await prisma.onlineOrderingSettings.findUnique({
      where: { venueId },
      select: { enabled: true, requiresAcceptance: true, autoPauseResumedAt: true },
    })
    if (!fila || fila.requiresAcceptance === false) return false
    const lectura = await leerPausaSola(venueId, now, fila.autoPauseResumedAt ?? null, Infinity)
    if (lectura.pausa || !lectura.corteSeguro) return false
    if (fila.autoPauseResumedAt && lectura.corteSeguro.getTime() <= fila.autoPauseResumedAt.getTime()) return false
    return await subirCorte(venueId, lectura.corteSeguro)
  } catch (error) {
    logger.warn('[OnlineOrdering] no se pudo avanzar el corte de la pausa sola (la lectura sigue exacta)', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * v4 (hueco 5): la hora límite más cercana (aún por llegar) de un pedido de «Mi equipo», en cualquier estado. El DASHBOARD vuelve a leer el estado justo
 * después de ella (con la espera de arriba, esa lectura ya trae el veredicto definitivo). `null` si no hay ninguno.
 */
export async function proximaHoraLimite(venueId: string, now: Date = new Date()): Promise<Date | null> {
  const fila = await prisma.onlineOrder.findFirst({
    // Sin filtrar por estado (Codex p2v4-r2 #3): un pedido que la clienta cancela justo DESPUÉS de su hora límite sigue siendo falla;
    // si esta lectura ya lo ve cancelado, su hora límite igual tiene que programar la relectura.
    where: { venueId, requiresAcceptance: true, acceptDeadlineAt: { gt: now } },
    orderBy: { acceptDeadlineAt: 'asc' },
    select: { acceptDeadlineAt: true },
  })
  return fila?.acceptDeadlineAt ?? null
}

/** Los ajustes sin la marca interna de la relectura (nunca viaja en una respuesta). */
function sinMarcaDeRelectura<T extends object>(ajustes: T): Omit<T, '__releido'> {
  const { __releido: _marca, ...resto } = ajustes as T & { __releido?: true }
  return resto
}

/** `preloaded`: los ajustes que quien llama ya leyó (p. ej. `GET /settings`), para no leerlos dos veces. */
export async function getAcceptingStatus(
  venueId: string,
  now: Date = new Date(),
  preloaded?: Awaited<ReturnType<typeof getSettings>> & { __releido?: true },
): Promise<AcceptingState> {
  const [settings, venue] = await Promise.all([
    preloaded ?? getSettings(venueId),
    prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }),
  ])
  const {
    lastInboxPollAt,
    lastToPayPollAt,
    autoPauseResumedAt,
    updatedAt: _guardadoEn,
    version,
    __releido: _releido,
    ...config
  } = settings as typeof settings & {
    __releido?: true
  }
  // Codex p2v5-r4 #5: la versión la sube la base bajo el candado de la fila (no la hora de Prisma, que se fija antes de esperarlo).
  const versionDeAjustes = version ?? null
  const timezone = venue?.timezone || 'America/Mexico_City'
  let autoPausedAt: string | null = null
  const done = (status: AcceptingStatus, reason: AcceptingReason): AcceptingState => ({
    status,
    reason,
    config,
    autoPausedAt,
    versionDeAjustes,
    ajustesUsados: sinMarcaDeRelectura(settings),
    leidoEn: now,
  })

  if (!config.enabled) return done('DISABLED', 'NOT_ENABLED')
  // La pausa del gerente gana con su forma de hoy: el «Reanudar» del piso no la quita (M-8), así que no se anuncia la sola.
  if (config.manualPause) return done('PAUSED', 'MANUAL_PAUSE')
  // D662 parte 2: sólo en «Mi equipo» (`=== false` es «Nadie»). Mismo motivo que la pausa a mano para las apps viejas. Va antes del
  // horario y de la presencia: sólo «Reanudar» la abre. Con una pausa de 15/30/60 vigente también se lee: al vencer, sigue pausada.
  let pausaSola: LecturaPausaSola['pausa'] = null
  if (config.requiresAcceptance !== false) {
    const lectura = await leerPausaSola(venueId, now, autoPauseResumedAt ?? null)
    pausaSola = lectura.pausa
    // Codex p2v4-r4 #5: si los ajustes cambiaron mientras la lectura esperaba (un «Reanudar», una pausa de 15 min quitada), se relee TODO
    // el estado con los ajustes nuevos: la respuesta nunca mezcla una versión con campos de otra. Una sola vez.
    const releida = lectura.versionReleida ?? null
    if (releida !== null && (versionDeAjustes === null || releida > versionDeAjustes) && !preloaded?.__releido) {
      return getAcceptingStatus(venueId, now, { ...(await getSettings(venueId)), __releido: true })
    }
  }
  autoPausedAt = pausaSola?.at.toISOString() ?? null
  if (config.pausedUntil && new Date(config.pausedUntil) > now) return done('PAUSED', 'MANUAL_PAUSE')
  if (autoPausedAt) return done('PAUSED', 'MANUAL_PAUSE')
  if (!isWithinHours(config.hours, now, timezone)) return done('CLOSED', 'OUTSIDE_HOURS')
  // R56: en «Nadie» (`=== false`), el último pedido para pagar en caja es FOLIO_LAST_CALL_MINUTES antes del cierre REAL de la franja
  // (`closesAt` junta las contiguas). Se dice igual que fuera de horario; `/info` sigue anunciando el cierre real.
  if (config.requiresAcceptance === false) {
    const cierre = closesAt(config.hours, now, timezone)
    if (cierre && cierre.getTime() - now.getTime() < FOLIO_LAST_CALL_MINUTES * 60_000) return done('CLOSED', 'OUTSIDE_HOURS')
  }
  // «Nadie» (`=== false`: una fila sin el campo no lo es) cuenta a quien puede cobrar folios; «Mi equipo», al POS a la vista (D662).
  const latido = config.requiresAcceptance === false ? lastToPayPollAt : lastInboxPollAt
  // D659/D660: la caja que cobra folios duerme con la pantalla apagada y late cada 2–11 min; la Bandeja abierta, cada ~10 s.
  const ventana = config.requiresAcceptance === false ? FOLIO_PRESENCE_WINDOW_MS : PRESENCE_WINDOW_MS
  if (!latido || now.getTime() - latido.getTime() > ventana) return done('OFFLINE', 'NO_DEVICE')

  // Fase 2: los borradores de tarjeta vigentes también ocupan lugar (el tope de admisión los cuenta igual).
  const pending =
    (await prisma.onlineOrder.count({ where: awaitingAcceptanceWhere(venueId) })) +
    (await prisma.onlineOrderCharge.count({ where: liveCardDraftsWhere(venueId, now) }))
  if (pending >= MAX_PENDING_PER_VENUE) return done('PAUSED', 'TOO_BUSY')

  return done('OPEN', null)
}

/**
 * D662 parte 2: bitácora `ONLINE_ORDERING_AUTO_PAUSED`, SÓLO como registro (la verdad es la lectura de `getAcceptingStatus`). La llama
 * el vencimiento de un pedido después de su commit: si la tienda quedó pausada sola y ESTE pedido es la segunda falla de la pareja
 * (por `id`, no por hora: dos pedidos pueden vencer en el mismo milisegundo; Codex p2-r2 #8), escribe una fila. El CAS de vencer gana
 * una sola vez por pedido. Si el pedido que la pausó no vence (la clienta lo canceló tarde, un rechazo tardío), no hay fila: aceptado.
 * Nunca lanza.
 */
export async function registrarSiLaPausoSola(venueId: string, onlineOrderId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const fila = await prisma.onlineOrderingSettings.findUnique({
      where: { venueId },
      select: { enabled: true, manualPause: true, requiresAcceptance: true, autoPauseResumedAt: true },
    })
    if (!fila || !fila.enabled || fila.manualPause || fila.requiresAcceptance === false) return false
    const { pausa } = await leerPausaSola(venueId, now, fila.autoPauseResumedAt ?? null)
    if (!pausa || pausa.onlineOrderId !== onlineOrderId) return false
    const pedido = await prisma.onlineOrder.findFirst({
      where: { id: onlineOrderId, venueId },
      select: { order: { select: { orderNumber: true } } },
    })
    void logAction({
      staffId: null,
      venueId,
      action: 'ONLINE_ORDERING_AUTO_PAUSED',
      entity: 'OnlineOrderingSettings',
      entityId: venueId,
      data: {
        autoPausedAt: pausa.at.toISOString(),
        orderNumber: pedido?.order.orderNumber ?? null,
        reason: '2 pedidos seguidos sin aceptar',
      },
    })
    emitStoreChanged(venueId, now)
    return true
  } catch {
    return false
  }
}
