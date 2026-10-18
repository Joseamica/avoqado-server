import { getAcceptingStatus, storeView } from './presence.service'
import { getSettings, storeRequirements } from './settings.service'

/**
 * La vista de ajustes de la tienda en línea: ajustes + estado de la tienda (el mismo cálculo que `/info`) + qué falta para
 * encenderla (R18). Es UN solo armado para `GET` y `PUT /settings` del panel y para el MCP: el panel mete la respuesta del PUT en la
 * caché del GET, así que las dos tienen que verse igual (ronda final, C1).
 *
 * `preloaded`: los ajustes que quien llama ya tiene (lo que acaba de escribir el PUT, o lo que ya leyó el MCP), para no leerlos
 * dos veces y para que el estado salga de ESOS ajustes.
 */
export async function settingsView(venueId: string, preloaded?: Awaited<ReturnType<typeof getSettings>>, now: Date = new Date()) {
  const settings = preloaded ?? (await getSettings(venueId))
  const [state, requirements] = await Promise.all([getAcceptingStatus(venueId, now, settings), storeRequirements(venueId)])
  const { lastInboxPollAt, ...config } = settings
  return {
    ...config,
    lastInboxPollAt: lastInboxPollAt ? lastInboxPollAt.toISOString() : null,
    store: storeView(state),
    requirements,
  }
}
