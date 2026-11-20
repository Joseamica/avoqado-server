import { esLlaveDeRonda, llaveDeRondaEnLinea, llavesDeLaRonda } from '../../../../src/services/mobile/llaveDeRonda'

/**
 * D7 «Anular producto», decisión 1 = A acotada (founder por delegación, 20-nov): en el camino de RONDAS la llave de cada renglón sólo
 * puede ser `sync:<llave de la ronda>:<n>`. Las apps vivas (TPV ≥ 2.7.1, ANDROID ≥ 2.19.1, iOS ≥ 1.12) ya la mandan así: pasa intacta.
 * Cualquier otra forma se reemplaza por la que arma el servidor con la llave de la ronda y la posición.
 */
describe('llavesDeLaRonda (decisión 1 de D7)', () => {
  it('la llave de las apps de Avoqado pasa intacta, aunque el índice no sea la posición', () => {
    const r = llavesDeLaRonda([{ externalId: 'sync:K:0' }, { externalId: 'sync:K:5' }, { externalId: 'sync:K:1' }], 'K')
    expect(r.map(i => i.externalId)).toEqual(['sync:K:0', 'sync:K:5', 'sync:K:1'])
  })

  it('sin llave, vacía, con espacios o de otra forma: la arma el servidor con la ronda y la posición', () => {
    const r = llavesDeLaRonda(
      [{}, { externalId: '' }, { externalId: '   ' }, { externalId: ' cafe-1 ' }, { externalId: 'cafe-1' }, { externalId: 42 as any }],
      'K',
    )
    expect(r.map(i => i.externalId)).toEqual(['sync:K:0', 'sync:K:1', 'sync:K:2', 'sync:K:3', 'sync:K:4', 'sync:K:5'])
  })

  it('una llave sync: de OTRA ronda no se acepta (sería la misma etiqueta en otra mesa)', () => {
    const r = llavesDeLaRonda([{ externalId: 'sync:OTRA:0' }, { externalId: ' sync:K:1' }, { externalId: 'sync:K:1:g:x' }], 'K')
    expect(r.map(i => i.externalId)).toEqual(['sync:K:0', 'sync:K:1', 'sync:K:2'])
  })

  it('nunca repite una llave dentro de la ronda: la segunda copia y el reemplazo que chocaría toman una libre', () => {
    // La 0 y la 1 reclaman `sync:K:1`; la 2 no trae llave y su posición choca con la `sync:K:2` que reclama la 3.
    const r = llavesDeLaRonda([{ externalId: 'sync:K:1' }, { externalId: 'sync:K:1' }, {}, { externalId: 'sync:K:2' }], 'K')
    const llaves = r.map(i => i.externalId)
    expect(llaves[0]).toBe('sync:K:1')
    expect(llaves[3]).toBe('sync:K:2')
    expect(new Set(llaves).size).toBe(4)
    expect(llaves.every(l => /^sync:K:\d+$/.test(l))).toBe(true)
  })

  it('es determinista: el mismo envío da las mismas llaves (el reenvío deduplica)', () => {
    const items = [{ externalId: 'x' }, { externalId: 'sync:K:0' }, {}]
    expect(llavesDeLaRonda(items, 'K')).toEqual(llavesDeLaRonda(items, 'K'))
  })

  it('un id de intent con «:» o espacios no rompe la forma: se usa un resumen fijo del id', () => {
    const a = llavesDeLaRonda([{}, { externalId: 'sync:a:b:0' }], 'a:b')
    expect(a.map(i => i.externalId)).toEqual([
      expect.stringMatching(/^sync:h[0-9a-f]{32}:0$/),
      expect.stringMatching(/^sync:h[0-9a-f]{32}:1$/),
    ])
    expect(llavesDeLaRonda([{}], 'a:b')).toEqual([a[0]])
    expect(esLlaveDeRonda(a[0].externalId)).toBe(true)
  })

  it('conserva los demás campos y no muta la entrada', () => {
    const items = [{ productId: 'p', quantity: 2, externalId: ' a ' }]
    const r = llavesDeLaRonda(items, 'K')
    expect(r[0]).toEqual({ productId: 'p', quantity: 2, externalId: 'sync:K:0' })
    expect(items[0].externalId).toBe(' a ')
  })
})

describe('llaveDeRondaEnLinea (la ronda con red, que no trae id de intent)', () => {
  it('toma la ronda de la primera llave con la forma de Avoqado', () => {
    expect(llaveDeRondaEnLinea([{ externalId: 'cafe' }, { externalId: 'sync:abc-1:1' }, { externalId: 'sync:otra:0' }])).toBe('abc-1')
  })

  it('sin ninguna, inventa una nueva (un sistema externo sin la forma de Avoqado pierde la protección contra duplicados)', () => {
    const a = llaveDeRondaEnLinea([{ externalId: ' ' }, {}])
    const b = llaveDeRondaEnLinea([{ externalId: ' ' }, {}])
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })
})
