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
 * Lo que la nota NO lleva: caracteres de control (un NUL tumbaba el guardado de la venta en Postgres, Codex r1 #7) y cualquier
 * espacio o salto, también los de Unicode (U+0085, U+2028…). Lista EXPLÍCITA y la misma letra por letra que el POS
 * (`NotaDelExtra.kt`, Codex r2 #7): `\s` de JavaScript y de Java no cubren lo mismo, y la comanda del aparato y la del SERVIDOR deben
 * salir iguales.
 */
// eslint-disable-next-line no-control-regex -- a propósito: quitar los caracteres de control
const ESPACIOS_Y_CONTROLES = /[\u0000-\u001F\u007F-\u009F\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+/g
const sinEspaciosEnLasPuntas = (texto: string) => texto.replace(/^ +| +$/g, '')

/**
 * D40 (Flautas Coyoacán, como Fudo): la nota de UNA parte del paquete («sin cebolla» sólo al Consomé). Una línea, sin espacios de
 * sobra ni caracteres de control y con tope; lo que no es texto o queda vacío = sin nota. El POS la limpia igual.
 */
export function limpiarNotaDelExtra(texto: unknown): string | null {
  if (typeof texto !== 'string') return null
  const limpia = sinEspaciosEnLasPuntas(sinEspaciosEnLasPuntas(texto.replace(ESPACIOS_Y_CONTROLES, ' ')).slice(0, MAX_NOTA_DEL_EXTRA))
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

    const nombre = modificador?.name?.trim()
    // Sin nombre no hay nada que preparar: se descarta en vez de escribir "undefined" en la
    // comanda, que es ruido que el cocinero tiene que interpretar a media comida.
    if (!nombre) return etiquetas

    const cantidad = modificador?.quantity ?? 1
    // D40: la nota de la parte viaja DENTRO de su etiqueta, en una segunda línea («Consomé⏎Nota: sin cebolla»): así llega por todos
    // los caminos de cocina sin cambiar la forma de la columna (lista de textos), y una pantalla o una caja viejas la pintan ya debajo
    // de su parte. El POS la arma igual (`NotaDelExtra.kt`). Sólo ASCII en lo que se agrega (PC850). Sin nota, la etiqueta queda byte
    // a byte como antes (Codex r2 #2: el nombre no se toca). Riesgo cosmético aceptado (decisión A del founder, 21-nov): un extra cuyo
    // NOMBRE trae «⏎Nota: …» se pinta como si tuviera nota. Toast hace lo mismo: su «Special Request» es un extra más con texto.
    const nota = limpiarNotaDelExtra(modificador?.notes)
    const parte = cantidad > 1 ? `${cantidad}x ${nombre}` : nombre
    etiquetas.push(nota ? `${parte}\nNota: ${nota}` : parte)
    return etiquetas
  }, [])
}
