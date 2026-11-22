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
export type KdsModifierInput = string | { name?: string | null; quantity?: number | null; notes?: string | null } | null | undefined

/** D40: tope de la nota de una parte, el mismo que la nota del artículo en el POS. */
export const MAX_NOTA_DEL_EXTRA = 200

/**
 * D40 (Flautas Coyoacán, como Fudo): la nota de UNA parte del paquete («sin cebolla» sólo al Consomé). Una línea, sin espacios de
 * sobra y con tope; lo que no es texto o queda vacío = sin nota. El POS (`NotaDelExtra.kt`) la limpia igual.
 */
export function limpiarNotaDelExtra(texto: unknown): string | null {
  if (typeof texto !== 'string') return null
  // Sin caracteres de control: un NUL tumbaba el guardado de la venta en Postgres (Codex r1 #7).
  const limpia = texto
    // eslint-disable-next-line no-control-regex -- a propósito: quitar los caracteres de control
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim()
    .slice(0, MAX_NOTA_DEL_EXTRA)
    .trim()
  return limpia || null
}

/**
 * D40: las notas que mandó el POS para las partes de UN renglón (`modifierNotes: { modifierId: nota }`), sólo de las opciones que
 * el renglón sí trae. Basura (no es objeto, id ajeno, nota que no es texto) se ignora: una nota nunca rechaza una venta.
 */
export function notasDeLasPartes(modifierNotes: unknown, modifierIds: readonly string[]): Map<string, string> {
  const notas = new Map<string, string>()
  if (!modifierNotes || typeof modifierNotes !== 'object' || Array.isArray(modifierNotes)) return notas
  const delRenglon = new Set(modifierIds)
  for (const [id, texto] of Object.entries(modifierNotes as Record<string, unknown>)) {
    const nota = limpiarNotaDelExtra(texto)
    if (nota && delRenglon.has(id)) notas.set(id, nota)
  }
  return notas
}

export function toKdsModifierLabels(modifiers: KdsModifierInput[] | null | undefined): string[] {
  if (!Array.isArray(modifiers)) return []

  return modifiers.reduce<string[]>((etiquetas, modificador) => {
    if (typeof modificador === 'string') {
      const texto = modificador.trim()
      if (texto) etiquetas.push(texto)
      return etiquetas
    }

    // D40 (Codex r1 #5): un nombre nunca lleva salto de línea, así que «⏎Nota: » sólo puede ser la nota de la parte.
    const nombre = modificador?.name?.replace(/[\r\n]+/g, ' ').trim()
    // Sin nombre no hay nada que preparar: se descarta en vez de escribir "undefined" en la
    // comanda, que es ruido que el cocinero tiene que interpretar a media comida.
    if (!nombre) return etiquetas

    const cantidad = modificador?.quantity ?? 1
    // D40: la nota de la parte viaja DENTRO de su etiqueta, en una segunda línea («Consomé⏎Nota: sin cebolla»): así llega por todos
    // los caminos de cocina sin cambiar la forma de la columna (lista de textos), y una pantalla o una caja viejas la pintan ya debajo
    // de su parte. El POS la arma igual (`NotaDelExtra.kt`). Sólo ASCII en lo que se agrega (PC850).
    const nota = limpiarNotaDelExtra(modificador?.notes)
    const parte = cantidad > 1 ? `${cantidad}x ${nombre}` : nombre
    etiquetas.push(nota ? `${parte}\nNota: ${nota}` : parte)
    return etiquetas
  }, [])
}
