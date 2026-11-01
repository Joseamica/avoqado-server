/**
 * El árbol de categorías (una categoría y las subcategorías que cuelgan de ella), para Mesas y para la regla de «qué menús
 * muestra cada aparato».
 *
 * Es PURO a propósito: sin Prisma ni logger. Quien lo usa lee las categorías (activas) y se las pasa; aquí sólo se recorren.
 */

/**
 * Las categorías dadas, más todas las que cuelgan de ellas (hijas, nietas…), sin repetir.
 *
 * - `categorias` ya viene filtrada a las ACTIVAS. Un id dado que no esté ahí (apagada, borrada o de otro negocio) se ignora y no
 *   arrastra nada. Como el árbol sólo se recorre por las categorías de la lista, una intermedia que falta (apagada) corta su rama:
 *   lo que cuelga de ella no se alcanza desde sus ancestros (sí se trae si se pide por su propio id, que sí está).
 * - Sin límite de profundidad: se recorre por niveles con una cola, sin recursión (una cadena larga no desborda la pila).
 * - Datos malos (un padre que cuelga de su propio hijo, o de sí mismo) no la ciclan: cada id se visita una sola vez.
 * - Regresa primero los ids dados que sí estén (en el orden en que llegaron) y luego los descendientes, por nivel y en el orden
 *   de `categorias`. Quien necesite un orden suyo (p. ej. «las directas primero, aunque estén apagadas») lo arma con esto.
 */
export function conDescendientes(ids: Iterable<string>, categorias: ReadonlyArray<{ id: string; parentId: string | null }>): Set<string> {
  const estan = new Set<string>()
  const hijasDe = new Map<string, string[]>()
  for (const { id, parentId } of categorias) {
    estan.add(id)
    if (!parentId) continue
    const hijas = hijasDe.get(parentId)
    if (hijas) hijas.push(id)
    else hijasDe.set(parentId, [id])
  }

  const resultado = new Set<string>()
  const porRecorrer: string[] = []
  for (const id of ids) {
    if (estan.has(id) && !resultado.has(id)) {
      resultado.add(id)
      porRecorrer.push(id)
    }
  }
  // La cola crece mientras se recorre: cada categoría entra una sola vez (`resultado` es también la lista de visitadas).
  for (let i = 0; i < porRecorrer.length; i++) {
    for (const hija of hijasDe.get(porRecorrer[i]) ?? []) {
      if (resultado.has(hija)) continue
      resultado.add(hija)
      porRecorrer.push(hija)
    }
  }
  return resultado
}
