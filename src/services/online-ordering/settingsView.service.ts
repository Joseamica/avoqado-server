import { getAcceptingStatus, storeView } from './presence.service'
import prisma from '@/utils/prismaClient'
import { cardMerchantStatus } from './card/merchant'
import { getSettings, storeRequirements } from './settings.service'
import { NO_ONE_VENUE_TYPES } from './constants'

/**
 * La vista de ajustes de la tienda en línea: ajustes + estado de la tienda (el mismo cálculo que `/info`) + qué falta para
 * encenderla (R18). Es UN solo armado para `GET` y `PUT /settings` del panel y para el MCP: el panel mete la respuesta del PUT en la
 * caché del GET, así que las dos tienen que verse igual (ronda final, C1).
 *
 * `preloaded`: los ajustes que quien llama ya tiene (lo que acaba de escribir el PUT, o lo que ya leyó el MCP), para no leerlos
 * dos veces y para que el estado salga de ESOS ajustes.
 */
export async function settingsView(venueId: string, preloaded?: Awaited<ReturnType<typeof getSettings>>) {
  const settings = preloaded ?? (await getSettings(venueId))
  const [state, requirements, merchantStatus, venue] = await Promise.all([
    getAcceptingStatus(venueId, new Date(), settings),
    storeRequirements(venueId),
    cardMerchantStatus(prisma, venueId),
    prisma.venue.findUnique({ where: { id: venueId }, select: { type: true } }),
  ])
  const { lastInboxPollAt, lastToPayPollAt, ...config } = settings
  return {
    ...config,
    lastInboxPollAt: lastInboxPollAt ? lastInboxPollAt.toISOString() : null,
    lastToPayPollAt: lastToPayPollAt ? lastToPayPollAt.toISOString() : null,
    // R37: sólo una sugerencia para que el panel preseleccione; el servidor nunca elige «Nadie» solo.
    suggestedRequiresAcceptance: !(venue && NO_ONE_VENUE_TYPES.includes(venue.type)),
    store: storeView(state),
    requirements,
    // Fase 2: el switch y el estado de la cuenta Stripe (el panel explica por qué no se puede prender).
    card: { enabled: !!settings.acceptsCardOnline, merchantStatus },
  }
}
