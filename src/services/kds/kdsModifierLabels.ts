// MARK: - Modificadores: UNA sola forma para TODOS los productores

/**
 * 🔴 `KdsOrderItem.modifiers` la escriben TRES productores: el POS (POST de las apps viejas), la ingesta de
 * marketplace y, desde la etapa 3, el armado del servidor. Hasta el 2026-08-20 cada uno guardaba una forma
 * distinta: el POS `["Sin cebolla"]`, la ingesta de marketplace
 * `[{"name":"Extra queso","quantity":1}]`. El lector sólo hacía `JSON.parse`, así que la
 * diferencia llegaba entera a la cocina — verificado en una Sunmi D3 con un pedido real de
 * Uber: Android pintó el JSON crudo y iOS falló el cast a `[String]` y **perdió el
 * modificador sin dejar rastro**. Un modificador perdido es un platillo mal servido.
 *
 * El esquema no protege la FORMA de un valor serializado; sólo una función compartida lo
 * hace. Por eso los productores normalizan con ÉSTA antes de escribir y el lector la vuelve a aplicar
 * para sanar las filas que ya se escribieron mal. Vive aparte de `kds.mobile.service` para que el armado
 * (`kitchenTicketAuthoring.service`) la use sin crear un ciclo de imports.
 */
export type KdsModifierInput = string | { name?: string | null; quantity?: number | null } | null | undefined

export function toKdsModifierLabels(modifiers: KdsModifierInput[] | null | undefined): string[] {
  if (!Array.isArray(modifiers)) return []

  return modifiers.reduce<string[]>((etiquetas, modificador) => {
    if (typeof modificador === 'string') {
      const texto = modificador.trim()
      if (texto) etiquetas.push(texto)
      return etiquetas
    }

    const nombre = modificador?.name?.trim()
    // Sin nombre no hay nada que preparar: se descarta en vez de escribir "undefined" en la
    // comanda, que es ruido que el cocinero tiene que interpretar a media comida.
    if (!nombre) return etiquetas

    const cantidad = modificador?.quantity ?? 1
    etiquetas.push(cantidad > 1 ? `${cantidad}x ${nombre}` : nombre)
    return etiquetas
  }, [])
}
