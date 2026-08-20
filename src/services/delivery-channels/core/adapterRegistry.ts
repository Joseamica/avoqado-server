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
 * Tipado contra `DirectDeliveryAdapter` (`core/types.ts`), y eso es lo que hace útil al
 * registro: agregar Rappi es implementar una interface, no leer el código de Uber.
 *
 * Antes no se podía. La interface fusionaba el contrato viejo de Deliverect (5 métodos
 * obligatorios) con el nuevo (todos opcionales), así que `uberAdapter` NO la satisfacía y
 * este archivo tuvo que tipar con `typeof uberAdapter` — el tipo del objeto, no un contrato.
 * Se partió en dos interfaces ciertas y Uber ahora lo cumple, comprobado con `satisfies` en
 * `uber.adapter.ts`.
 */
import { DeliveryProvider } from '@prisma/client'

import { uberAdapter } from '../providers/uber-eats/uber.adapter'
import type { DirectDeliveryAdapter } from './types'

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
        `implementando DirectDeliveryAdapter (core/types.ts).`,
    )
  }
  return a
}
