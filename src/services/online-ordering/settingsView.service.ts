import { getAcceptingStatus, storeView } from './presence.service'
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
export async function settingsView(venueId: string, preloaded?: Awaited<ReturnType<typeof getSettings>>) {
  // R66: con `preloaded` (lo que acaba de escribir el PUT) siempre hay fila; si no, la misma lectura dice si existe.
  const read = preloaded ? null : await getSettingsWithSaved(venueId)
  const settings = preloaded ?? read!.settings
  const saved = preloaded ? true : read!.saved
  const [state, requirements, merchantStatus, venue, beats, offeredNow] = await Promise.all([
    getAcceptingStatus(venueId, new Date(), settings),
    storeRequirements(venueId),
    cardMerchantStatus(prisma, venueId),
    prisma.venue.findUnique({ where: { id: venueId }, select: { type: true } }),
    read?.cardAlerts ?? readCardAlertBeats(venueId),
    // D661 (D2): la MISMA regla de `/info` y del borrador (una sola definición), sólo en «Nadie».
    settings.requiresAcceptance === false ? cardOnlineAvailable(settings, prisma, venueId) : Promise.resolve(false),
  ])
  const { lastInboxPollAt, lastToPayPollAt, ...config } = settings
  return {
    ...config,
    lastInboxPollAt: lastInboxPollAt ? lastInboxPollAt.toISOString() : null,
    lastToPayPollAt: lastToPayPollAt ? lastToPayPollAt.toISOString() : null,
    // R37: sólo una sugerencia para que el panel preseleccione; el servidor nunca elige «Nadie» solo.
    suggestedRequiresAcceptance: !(venue && NO_ONE_VENUE_TYPES.includes(venue.type)),
    // Campo nuevo y opcional: el panel preselecciona la sugerencia por giro sólo si el negocio nunca guardó.
    hasSavedSettings: saved,
    store: storeView(state),
    requirements,
    // Fase 2: el switch y el estado de la cuenta Stripe (el panel explica por qué no se puede prender).
    card: { enabled: !!settings.acceptsCardOnline, merchantStatus },
    // D661 (D2, nuevo y opcional): ¿la tarjeta de «No, entran solos» se ofrece AHORA? Sólo si una caja capaz recibió una respuesta
    // rápida en los últimos 90 s (Ruling 7); prendida y sin esa caja, la tienda no la ofrece.
    cardNadie: {
      enabled: settings.cardOnlineNadie === true,
      lastAlertAt: beats.lastCardAlertPollAt?.toISOString() ?? null,
      fastAlertAt: beats.cardAlertFastPollAt?.toISOString() ?? null,
      offeredNow,
    },
  }
}
