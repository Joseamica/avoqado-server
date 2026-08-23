/**
 * "No puedo prepararlo" → el motivo que Rappi acepta.
 *
 * 🔴 EL HALLAZGO QUE IMPORTA: el catálogo de rechazo de Rappi es sobre el PEDIDO estando mal,
 * no sobre la tienda no pudiendo. Sus seis motivos válidos son:
 *
 *   ITEM_WRONG_PRICE · ITEM_NOT_FOUND · ITEM_OUT_OF_STOCK
 *   ORDER_MISSING_INFORMATION · ORDER_MISSING_ADDRESS_INFORMATION · ORDER_TOTAL_INCORRECT
 *
 * **No existe "estoy saturado" ni "la tienda está cerrada".** Y no es un olvido suyo: es una
 * postura de producto. Si te saturaste, lo que Rappi espera es que PAUSES la tienda —para que
 * deje de mandarte pedidos— en vez de aceptarlos y rechazarlos uno por uno. Rechazar te cuenta
 * en contra de la tasa de éxito del 98% que exigen; pausar no.
 *
 * Por eso este módulo NO fuerza una traducción para esos dos casos. Devuelve "esto no se
 * rechaza, se pausa", y quien llama muestra ese camino. Mapearlos a la fuerza a
 * `ORDER_MISSING_INFORMATION` sería mentirle a Rappi sobre por qué rechazamos, y ensuciaría
 * justo la métrica con la que deciden si nos dejan seguir conectados.
 */
import type { DenyReason } from '../../core/types'

/** Los seis motivos que Rappi acepta, tal cual los nombra. */
export type RappiCancelType =
  | 'ITEM_WRONG_PRICE'
  | 'ITEM_NOT_FOUND'
  | 'ITEM_OUT_OF_STOCK'
  | 'ORDER_MISSING_INFORMATION'
  | 'ORDER_MISSING_ADDRESS_INFORMATION'
  | 'ORDER_TOTAL_INCORRECT'

/**
 * Los tres que EXIGEN señalar cuáles renglones son el problema. Mandarlos sin items da 400,
 * y un 400 cuenta contra la tasa de éxito del 98%.
 */
const EXIGEN_ITEMS: ReadonlySet<RappiCancelType> = new Set<RappiCancelType>(['ITEM_WRONG_PRICE', 'ITEM_NOT_FOUND', 'ITEM_OUT_OF_STOCK'])

export interface CuerpoRechazo {
  reason: string
  cancel_type: RappiCancelType
  items_ids?: string[]
  items_skus?: string[]
}

/** Rappi no admite este motivo: la salida correcta es pausar la tienda, no rechazar. */
export interface PausarEnVezDeRechazar {
  rechazable: false
  motivo: 'PAUSAR_EN_VEZ_DE_RECHAZAR'
  explicacion: string
}

export type ResultadoRechazo = { rechazable: true; cuerpo: CuerpoRechazo } | PausarEnVezDeRechazar

const NO_ES_RECHAZO: PausarEnVezDeRechazar = {
  rechazable: false,
  motivo: 'PAUSAR_EN_VEZ_DE_RECHAZAR',
  explicacion:
    'Rappi no acepta "no doy abasto" ni "estoy cerrado" como motivo de rechazo — sus motivos son sobre el pedido, no sobre la tienda. ' +
    'Para dejar de recibir pedidos, pausa el canal: rechazar cuenta contra la tasa de éxito que Rappi exige, pausar no.',
}

/**
 * Traduce nuestro motivo al de Rappi.
 *
 * `itemIds` / `itemSkus` sólo se usan cuando el motivo los EXIGE. Si el motivo los pide y no
 * llegan, se degrada a `ORDER_MISSING_INFORMATION` en vez de mandar una llamada que Rappi va a
 * rechazar: un rechazo que falla deja el pedido vivo, corriendo su reloj, mientras la cocina
 * cree que ya lo soltó.
 */
export function aMotivoRappi(
  reason: DenyReason | undefined,
  opts: { itemIds?: string[]; itemSkus?: string[]; texto?: string } = {},
): ResultadoRechazo {
  // Los dos que Rappi NO admite. Se contestan ANTES de cualquier traducción.
  if (reason === 'TOO_BUSY' || reason === 'STORE_CLOSED') return NO_ES_RECHAZO

  const cancelType: RappiCancelType = reason === 'OUT_OF_ITEMS' ? 'ITEM_OUT_OF_STOCK' : 'ORDER_MISSING_INFORMATION'

  const ids = (opts.itemIds ?? []).filter(Boolean)
  const skus = (opts.itemSkus ?? []).filter(Boolean)
  const faltanItems = EXIGEN_ITEMS.has(cancelType) && ids.length === 0 && skus.length === 0

  if (faltanItems) {
    // Degradar, no fallar: el pedido igual queda rechazado y la cocina se libera. Perder
    // precisión en el motivo es infinitamente mejor que un 400 que deja el pedido colgado.
    return {
      rechazable: true,
      cuerpo: {
        reason: opts.texto?.trim() || 'El comercio no puede preparar este pedido',
        cancel_type: 'ORDER_MISSING_INFORMATION',
      },
    }
  }

  return {
    rechazable: true,
    cuerpo: {
      // `reason` es texto libre y lo lee una persona del otro lado. Se manda algo que
      // signifique algo, no el nombre del enum.
      reason: opts.texto?.trim() || (cancelType === 'ITEM_OUT_OF_STOCK' ? 'Producto agotado' : 'El comercio no puede preparar este pedido'),
      cancel_type: cancelType,
      ...(EXIGEN_ITEMS.has(cancelType) && ids.length ? { items_ids: ids } : {}),
      ...(EXIGEN_ITEMS.has(cancelType) && skus.length ? { items_skus: skus } : {}),
    },
  }
}
