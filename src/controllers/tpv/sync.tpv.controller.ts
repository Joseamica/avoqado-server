/**
 * Replay del outbox offline para el TPV.
 *
 * Es LITERALMENTE el mismo reducer que usa `/mobile`, reexportado. El controller no
 * está acoplado al namespace: solo lee `req.params.venueId`, `authContext.userId`, y
 * `deviceId`/`intents` del body (ver `src/controllers/mobile/sync.mobile.controller.ts`).
 * Duplicar la lógica haría que los dos namespaces divergieran en silencio — y el reducer
 * (`src/services/mobile/sync.mobile.service.ts`) es quien evalúa el gating de TABLE_SERVICE
 * y la propiedad de mesa POR INTENT (sincronizar no es puerta trasera).
 *
 * El TPV está aislado a `/api/v1/tpv/*` por decisión del founder: nunca llama a
 * `/mobile`. Por eso la ruta se monta aquí en vez de que el cliente cruce de namespace.
 */
export { syncIntents } from '../mobile/sync.mobile.controller'
