import { getAcceptingStatus, proximaHoraLimite, storeView } from './presence.service'
import prisma from '@/utils/prismaClient'
import { cardMerchantStatus, cardOnlineAvailable } from './card/merchant'
import { getSettings, getSettingsWithSaved, storeRequirements, type CardAlertBeats } from './settings.service'
import { NO_ONE_VENUE_TYPES } from './constants'

/** D661 (D2): los latidos de la caja que avisa, cuando quien llama no los trae (el PUT). Una lectura chica de dos columnas. */
async function readCardAlertBeats(venueId: string): Promise<CardAlertBeats> {
  const row = await prisma.onlineOrderingSettings.findUnique({
    where: { venueId },
    select: { lastCardAlertPollAt: true, cardAlertFastPollAt: true },
  })
  return { lastCardAlertPollAt: row?.lastCardAlertPollAt ?? null, cardAlertFastPollAt: row?.cardAlertFastPollAt ?? null }
}

/**
 * La vista de ajustes de la tienda en línea: ajustes + estado de la tienda (el mismo cálculo que `/info`) + qué falta para
 * encenderla (R18). Es UN solo armado para `GET` y `PUT /settings` del panel y para el MCP: el panel mete la respuesta del PUT en la
 * caché del GET, así que las dos tienen que verse igual (ronda final, C1).
 *
 * `preloaded`: los ajustes que quien llama ya tiene (lo que acaba de escribir el PUT, o lo que ya leyó el MCP), para no leerlos
 * dos veces y para que el estado salga de ESOS ajustes.
 */
export async function settingsView(
  venueId: string,
  preloaded?: Awaited<ReturnType<typeof getSettings>>,
  opts: { pestanaVieja?: boolean } = {},
) {
  // D662 (Codex p2-r7 #2, p2-r8 #4, p2v4-r1 #11): la hora en que se leyó el estado de la tienda viaja con él y se toma ANTES de leer nada:
  // toda respuesta con hora posterior a un cambio guardado ya lo trae (su lectura fue después). El panel se queda con la más nueva.
  const leidoEn = new Date()
  // R66: con `preloaded` (lo que acaba de escribir el PUT) siempre hay fila; si no, la misma lectura dice si existe.
  const read = preloaded ? null : await getSettingsWithSaved(venueId)
  const settings = preloaded ?? read!.settings
  const saved = preloaded ? true : read!.saved
  const [state, requirements, merchantStatus, venue, siguiente, beats, offeredAtRead] = await Promise.all([
    getAcceptingStatus(venueId, leidoEn, settings),
    storeRequirements(venueId),
    cardMerchantStatus(prisma, venueId),
    prisma.venue.findUnique({ where: { id: venueId }, select: { type: true } }),
    proximaHoraLimite(venueId, leidoEn).catch(() => null),
    read?.cardAlerts ?? readCardAlertBeats(venueId),
    // D661 (D2): la MISMA regla de `/info` y del borrador (una sola definición), sólo en «Nadie».
    settings.requiresAcceptance === false ? cardOnlineAvailable(settings, prisma, venueId) : Promise.resolve(false),
  ])
  // D662 v5 (Codex p2v4-r5 #2): UNA sola foto por respuesta. Si el estado se armó con ajustes releídos (la lectura esperó y alguien
  // apagó, pausó o reanudó mientras tanto), el interruptor, la pausa temporal, la tarjeta y la versión salen de ESOS mismos ajustes.
  const usados = (state.ajustesUsados as typeof settings | undefined) ?? settings
  // D661 + D662 v5 (una sola foto): la tarjeta de «Nadie» sale de los MISMOS ajustes que el estado. La relectura de la pausa sola sólo
  // pasa en «Mi equipo»; si mientras esperaba el negocio cambió de modo o su tarjeta de «Nadie», se vuelve a medir con esos ajustes.
  const offeredNow =
    usados.requiresAcceptance === settings.requiresAcceptance && usados.cardOnlineNadie === settings.cardOnlineNadie
      ? offeredAtRead
      : usados.requiresAcceptance === false
        ? await cardOnlineAvailable(usados, prisma, venueId)
        : false
  // D662 parte 2: `autoPauseResumedAt` es interno de la pausa sola; lo que el panel ve es `store.autoPausedAt`.
  const { lastInboxPollAt, lastToPayPollAt, autoPauseResumedAt: _reanudada, updatedAt: _guardadoEn, version, ...config } = usados
  return {
    ...config,
    lastInboxPollAt: lastInboxPollAt ? lastInboxPollAt.toISOString() : null,
    lastToPayPollAt: lastToPayPollAt ? lastToPayPollAt.toISOString() : null,
    // R37: sólo una sugerencia para que el panel preseleccione; el servidor nunca elige «Nadie» solo.
    suggestedRequiresAcceptance: !(venue && NO_ONE_VENUE_TYPES.includes(venue.type)),
    // Campo nuevo y opcional: el panel preselecciona la sugerencia por giro sólo si el negocio nunca guardó.
    hasSavedSettings: saved,
    store: storeView(state, opts),
    /** Campo nuevo y opcional (D662): cuándo se leyó `store` (antes de leer nada). */
    storeReadAt: leidoEn.toISOString(),
    /**
     * Campo nuevo y opcional (D662 v4, Codex p2v4-r2 #5): la versión de los ajustes que se leyeron, un entero que la base sube en cada
     * guardado en el orden en que se confirman (Codex p2v5-r4 #5). El panel ordena sus lecturas por (esto, `storeReadAt`): la que leyó
     * una versión mayor gana aunque haya entrado antes.
     */
    // La versión de los ajustes que de verdad usó el estado (si los releyó tras esperar, la releída; Codex p2v4-r4 #5).
    storeVersion: state.versionDeAjustes ?? version ?? null,
    /** Campo nuevo y opcional (D662 v4): la hora límite más cercana de un pedido por aceptar; el panel vuelve a leer justo después. */
    storeNextDeadlineAt: siguiente ? siguiente.toISOString() : null,
    requirements,
    // Fase 2: el switch y el estado de la cuenta Stripe (el panel explica por qué no se puede prender).
    card: { enabled: !!usados.acceptsCardOnline, merchantStatus },
    // D661 (D2, nuevo y opcional): ¿la tarjeta de «No, entran solos» se ofrece AHORA? Sólo si una caja capaz recibió una respuesta
    // rápida en los últimos 90 s (Ruling 7); prendida y sin esa caja, la tienda no la ofrece.
    cardNadie: {
      enabled: usados.cardOnlineNadie === true,
      lastAlertAt: beats.lastCardAlertPollAt?.toISOString() ?? null,
      fastAlertAt: beats.cardAlertFastPollAt?.toISOString() ?? null,
      offeredNow,
    },
  }
}
