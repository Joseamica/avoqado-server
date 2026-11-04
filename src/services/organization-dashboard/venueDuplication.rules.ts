// Reglas puras del nombre de una tienda duplicada (sin base de datos).

/** Recorta, colapsa espacios, pasa a mayúsculas y quita acentos. */
export function normalizarNombreTienda(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/** Último paréntesis numérico del nombre: «BAE X (3952)» → '3952'. */
export function numeroDeTienda(nombre: string): string | null {
  const todos = [...nombre.matchAll(/\((\d+)\)/g)]
  return todos.length ? todos[todos.length - 1][1] : null
}

/** ¿El nombre nuevo choca con alguno existente, por nombre normalizado o por número de tienda? */
export function nombreChoca(nuevo: string, existentes: string[]): { choca: false } | { choca: true; numero: string | null } {
  const norm = normalizarNombreTienda(nuevo)
  const numero = numeroDeTienda(nuevo)
  const choca = existentes.some(e => normalizarNombreTienda(e) === norm || (numero !== null && numeroDeTienda(e) === numero))
  return choca ? { choca: true, numero } : { choca: false }
}
