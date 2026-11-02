import { conDescendientes } from '@/services/menus/categoryTree'

/**
 * Una categoría como la lee Mesas: su id y de quién cuelga (null = de primer nivel).
 * Va congelada a propósito: la función es pura y no debe tocar lo que recibe (si lo hiciera, aquí truena).
 */
const cat = (id: string, parentId: string | null = null) => Object.freeze({ id, parentId })

/**
 * Bebidas
 *  ├─ Cafés ─ Fríos ─ Con leche      (cuatro niveles)
 *  └─ Tés
 * Postres ─ Pasteles                  (otra rama)
 */
const ARBOL = Object.freeze([
  cat('bebidas'),
  cat('cafes', 'bebidas'),
  cat('frios', 'cafes'),
  cat('conLeche', 'frios'),
  cat('tes', 'bebidas'),
  cat('postres'),
  cat('pasteles', 'postres'),
])

const ordenados = (ids: Iterable<string>) => [...ids].sort()

describe('conDescendientes', () => {
  it('variosNiveles: trae las hijas, las nietas y las bisnietas de cada categoría, y nada de otras ramas', () => {
    expect(ordenados(conDescendientes(['bebidas'], ARBOL))).toEqual(['bebidas', 'cafes', 'conLeche', 'frios', 'tes'])
    // Desde una de en medio sólo baja: no sube a su padre ni toca a sus hermanas.
    expect(ordenados(conDescendientes(['cafes'], ARBOL))).toEqual(['cafes', 'conLeche', 'frios'])
    // Varias categorías de ramas distintas suman sus árboles, y vale cualquier Iterable (aquí un Set).
    expect(ordenados(conDescendientes(new Set(['frios', 'postres']), ARBOL))).toEqual(['conLeche', 'frios', 'pasteles', 'postres'])
    // Una hoja sólo se trae a sí misma.
    expect(ordenados(conDescendientes(['tes'], ARBOL))).toEqual(['tes'])
  })

  it('sinRepetir: un id repetido, o una categoría junto con su descendiente, cuenta una sola vez', () => {
    const r = conDescendientes(['bebidas', 'cafes', 'bebidas', 'conLeche'], ARBOL)
    expect(r).toBeInstanceOf(Set)
    expect(r.size).toBe(5)
    expect(ordenados(r)).toEqual(['bebidas', 'cafes', 'conLeche', 'frios', 'tes'])
  })

  it('ignoraIdsQueNoEstan: un id que no está en la lista (apagada, borrada o de otro negocio) no entra ni arrastra nada', () => {
    expect(conDescendientes(['fantasma'], ARBOL).size).toBe(0)
    expect(ordenados(conDescendientes(['fantasma', 'postres'], ARBOL))).toEqual(['pasteles', 'postres'])
    expect(conDescendientes([], ARBOL).size).toBe(0)
    expect(conDescendientes(['bebidas'], []).size).toBe(0)
    // Con «Postres» apagada ya no está en la lista: pedirla no trae nada, y su hija no se alcanza desde ella...
    const sinPostres = ARBOL.filter(c => c.id !== 'postres')
    expect(conDescendientes(['postres'], sinPostres).size).toBe(0)
    // ...pero la hija sí se trae cuando se pide ella misma, que sí está.
    expect(ordenados(conDescendientes(['pasteles'], sinPostres))).toEqual(['pasteles'])
  })

  it('unaIntermediaQueNoEstaCortaSuRama: lo que cuelga de una hija apagada no se alcanza desde la abuela', () => {
    const sinCafes = ARBOL.filter(c => c.id !== 'cafes')
    expect(ordenados(conDescendientes(['bebidas'], sinCafes))).toEqual(['bebidas', 'tes'])
    // Pero si se piden ellas mismas, su propia rama sigue entera.
    expect(ordenados(conDescendientes(['frios'], sinCafes))).toEqual(['conLeche', 'frios'])
  })

  it('noSeCicla: datos malos (un padre que cuelga de su hijo, o de sí mismo) se recorren una sola vez', () => {
    const malos = [cat('a', 'b'), cat('b', 'a'), cat('c', 'c'), cat('d', 'c')]
    expect(ordenados(conDescendientes(['a'], malos))).toEqual(['a', 'b'])
    expect(ordenados(conDescendientes(['b'], malos))).toEqual(['a', 'b'])
    expect(ordenados(conDescendientes(['c'], malos))).toEqual(['c', 'd'])
  })

  it('sinLimiteDeProfundidad: una cadena larguísima no desborda la pila (se recorre sin recursión)', () => {
    const N = 30_000
    const cadena = Array.from({ length: N }, (_, i) => cat(`n${i}`, i === 0 ? null : `n${i - 1}`))
    expect(conDescendientes(['n0'], cadena).size).toBe(N)
  })
})
