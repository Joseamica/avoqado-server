/**
 * El ÚNICO lugar del sistema donde un proveedor se menciona por nombre.
 *
 * 🔴 Si aparece un `if (provider === X)` o el nombre de un proveedor en cualquier otro
 * archivo de `core/`, es un bug de diseño: el núcleo debe trabajar contra el contrato.
 * Hay un test que recorre `core/` y falla si eso ocurre.
 *
 * Importación ESTÁTICA a propósito: cuatro adaptadores en el mismo repo no justifican
 * un cargador de plugins (spec §9, YAGNI).
 *
 * ⚠️ DIVERGENCIA con `core/types.ts` (encontrada al implementar este registro, plan
 * 2026-08-20 Tarea 5, no antes — verificada con `tsc`, no de memoria):
 * el spec (§5.1) documenta `DeliveryProviderAdapter` con sólo 3 métodos obligatorios
 * (`verifyWebhook`, `extractIdentity`, `normalizeOrder`). La interface REAL en
 * `core/types.ts` es una fusión: conserva `verifySignature`, `parseOrderWebhook`,
 * `sendStatusUpdate`, `pushMenu` y `setChannelPaused` como obligatorios — el contrato
 * VIEJO que sólo `deliverect.adapter.ts` implementa — con las capacidades nuevas
 * encima como opcionales. `uberAdapter` (primer adaptador del contrato NUEVO) no
 * implementa los 5 viejos (no los necesita — su único consumidor hoy,
 * `uber.eventProcessor.ts`, lo llama directo, sin pasar por `DeliveryProviderAdapter`),
 * Y ADEMÁS su `verifyWebhook` devuelve `boolean`, no el `WebhookVerdict` que esa misma
 * interface declara para el método opcional. Dos ejes de divergencia, no uno — por eso
 * este registro NO intenta ir parchando campo por campo un tipo derivado de
 * `DeliveryProviderAdapter`: usa el tipo REAL que Uber exporta (`typeof uberAdapter`),
 * honesto con lo que el objeto de verdad implementa. `core/types.ts` / `uber.adapter.ts`
 * quedan fuera de alcance en esta tarea; fusionar los dos contratos ahí es trabajo
 * aparte (mismo trabajo que migrar Deliverect al contrato nuevo).
 */
import { DeliveryProvider } from '@prisma/client'
import { uberAdapter } from '../providers/uber-eats/uber.adapter'

/**
 * El contrato que un adaptador de integración DIRECTA (Uber/Rappi/DiDi) implementa hoy.
 * Cuando se sume un segundo proveedor directo, amplía a una unión (`typeof uberAdapter |
 * typeof rappiAdapter`) o resuelve la divergencia de arriba en `core/types.ts` primero.
 */
type DirectDeliveryAdapter = typeof uberAdapter

const ADAPTERS: Partial<Record<DeliveryProvider, DirectDeliveryAdapter>> = {
  [DeliveryProvider.UBER_EATS]: uberAdapter,
  // RAPPI y DIDI_FOOD: cada uno con su plan. DELIVERECT migra en trabajo aparte.
}

export function hasAdapter(provider: DeliveryProvider): boolean {
  return ADAPTERS[provider] !== undefined
}

export function adapterFor(provider: DeliveryProvider): DirectDeliveryAdapter {
  const a = ADAPTERS[provider]
  if (!a) {
    throw new Error(
      `No hay adaptador para el proveedor "${provider}". Regístralo en core/adapterRegistry.ts ` +
        `implementando DeliveryProviderAdapter (core/types.ts).`,
    )
  }
  return a
}
