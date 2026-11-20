import { getAcceptingStatus, proximaHoraLimite, storeView } from './presence.service'
import prisma from '@/utils/prismaClient'
import { cardMerchantStatus } from './card/merchant'
import { getSettings, getSettingsWithSaved, storeRequirements } from './settings.service'
import { NO_ONE_VENUE_TYPES } from './constants'

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
  const { settings, saved } = preloaded ? { settings: preloaded, saved: true } : await getSettingsWithSaved(venueId)
  const [state, requirements, merchantStatus, venue, siguiente] = await Promise.all([
    getAcceptingStatus(venueId, leidoEn, settings),
    storeRequirements(venueId),
    cardMerchantStatus(prisma, venueId),
    prisma.venue.findUnique({ where: { id: venueId }, select: { type: true } }),
    proximaHoraLimite(venueId, leidoEn).catch(() => null),
  ])
  // D662 parte 2: `autoPauseResumedAt` es interno de la pausa sola; lo que el panel ve es `store.autoPausedAt`.
  const { lastInboxPollAt, lastToPayPollAt, autoPauseResumedAt: _reanudada, updatedAt: guardadoEn, ...config } = settings
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
     * Campo nuevo y opcional (D662 v4, Codex p2v4-r2 #5): cuándo se guardaron los ajustes que se leyeron. El panel ordena sus lecturas
     * por (esto, `storeReadAt`): la que leyó un ajuste más nuevo gana aunque haya entrado antes.
     */
    storeVersion: guardadoEn ? guardadoEn.toISOString() : null,
    /** Campo nuevo y opcional (D662 v4): la hora límite más cercana de un pedido por aceptar; el panel vuelve a leer justo después. */
    storeNextDeadlineAt: siguiente ? siguiente.toISOString() : null,
    requirements,
    // Fase 2: el switch y el estado de la cuenta Stripe (el panel explica por qué no se puede prender).
    card: { enabled: !!settings.acceptsCardOnline, merchantStatus },
  }
}
