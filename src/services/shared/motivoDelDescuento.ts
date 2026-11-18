// src/services/shared/motivoDelDescuento.ts
//
// Encargo f998c8 (founder «A», 15-nov, como Toast «Discount reason required» / «Comment required»): el negocio puede exigir un motivo
// en los descuentos que se ponen a mano en el POS. Aquí viven las dos reglas puras:
//  - lo que llega de una venta (`motivoDelDescuento`): NUNCA rechaza. Una app vieja o la cola sin red no mandan motivo, y rechazar
//    dejaría efectivo cobrado sin venta. Lo que llegue se recorta y se copia como texto a la fila del descuento.
//  - lo que guarda el DASHBOARD (`validarAjusteDeMotivos`): ahí sí se valida, porque es el dueño escribiendo su lista.

export const MAX_MOTIVO = 60
export const MAX_COMENTARIO = 200
export const MAX_MOTIVOS = 30

/** D4 (Codex r3 #2, r4 #1): el nulo y los demás de control (C0, DEL y C1). PostgreSQL rechaza un texto con nulo: tumbaba la escritura. */
const CONTROLES = /[\u0000-\u001F\u007F-\u009F]/g // eslint-disable-line no-control-regex

function limpiar(raw: unknown, tope: number): string | null {
  if (typeof raw !== 'string') return null
  const texto = raw.replace(CONTROLES, ' ').replace(/\s+/g, ' ').trim()
  if (!texto) return null
  return texto.slice(0, tope).trim()
}

/** Los campos `reason` / `reasonComment` de un `OrderDiscount`. Sin motivo ni comentario, `{}` (la fila queda «Sin motivo»). */
export function motivoDelDescuento(reason: unknown, comment: unknown): { reason?: string; reasonComment?: string } {
  const motivo = limpiar(reason, MAX_MOTIVO)
  const comentario = limpiar(comment, MAX_COMENTARIO)
  return {
    ...(motivo ? { reason: motivo } : {}),
    ...(comentario ? { reasonComment: comentario } : {}),
  }
}

export type ResultadoDeMotivos =
  | { ok: true; cambios: { discountReasonRequired?: boolean; discountReasons?: string[] } }
  | { ok: false; mensaje: string }

/**
 * Valida un cambio de «Pedir motivo en los descuentos» contra lo guardado. `pedido` trae sólo lo que el DASHBOARD mandó;
 * `guardado` es la fila actual (o los defaults). No se prende con la lista vacía y, prendido, no se quita el último motivo.
 */
export function validarAjusteDeMotivos(
  pedido: { required?: boolean; reasons?: unknown[] },
  guardado: { required: boolean; reasons: string[] },
): ResultadoDeMotivos {
  const cambios: { discountReasonRequired?: boolean; discountReasons?: string[] } = {}
  let lista = guardado.reasons
  if (pedido.reasons !== undefined) {
    const limpia: string[] = []
    const vistos = new Set<string>()
    for (const crudo of pedido.reasons) {
      if (typeof crudo !== 'string') return { ok: false, mensaje: 'Cada motivo debe ser un texto.' }
      const texto = crudo.replace(/\s+/g, ' ').trim()
      if (!texto) continue
      if (texto.length > MAX_MOTIVO)
        return { ok: false, mensaje: `Cada motivo puede tener hasta ${MAX_MOTIVO} letras: «${texto.slice(0, 20)}…».` }
      const llave = texto.toLocaleLowerCase('es-MX')
      if (vistos.has(llave)) return { ok: false, mensaje: `El motivo «${texto}» está repetido.` }
      vistos.add(llave)
      limpia.push(texto)
    }
    if (limpia.length > MAX_MOTIVOS) return { ok: false, mensaje: `Puedes tener hasta ${MAX_MOTIVOS} motivos.` }
    cambios.discountReasons = limpia
    lista = limpia
  }
  const prendido = pedido.required ?? guardado.required
  if (pedido.required !== undefined) cambios.discountReasonRequired = pedido.required
  if (prendido && lista.length === 0) {
    return {
      ok: false,
      mensaje:
        pedido.required === true
          ? 'Agrega al menos un motivo antes de pedirlo en los descuentos.'
          : 'No puedes quitar el último motivo mientras se pide en los descuentos: apaga «Pedir motivo» primero.',
    }
  }
  return { ok: true, cambios }
}

export type MotivoDeDescuento = { reason?: string; reasonComment?: string }

/**
 * Parte los renglones ajustados (o con descuento) en grupos con el MISMO motivo y comentario, en el orden en que llegaron. Sin motivo
 * es un grupo más. Con un solo grupo, la venta queda con UNA fila como antes del motivo.
 */
export function agruparPorMotivo<T extends { itemId: string }>(
  renglones: T[],
  motivos: Map<string, MotivoDeDescuento>,
): Array<{ motivo: MotivoDeDescuento; renglones: T[] }> {
  const grupos = new Map<string, { motivo: MotivoDeDescuento; renglones: T[] }>()
  for (const r of renglones) {
    const motivo = motivos.get(r.itemId) ?? {}
    const llave = JSON.stringify([motivo.reason ?? null, motivo.reasonComment ?? null])
    const grupo = grupos.get(llave) ?? { motivo, renglones: [] }
    grupo.renglones.push(r)
    grupos.set(llave, grupo)
  }
  return [...grupos.values()]
}
