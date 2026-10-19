import { assertGroupNameFree } from '@/services/product-variants/productGroup.service'

// Codex, ronda 4: el chequeo de nombre único miraba sólo los primeros 1,000 candidatos del mismo largo; ahora recorre todos.
const fila = (i: number) => ({ id: `c${String(i).padStart(24, '0')}`, name: `Otra ${String(i).padStart(4, '0')}` })

function txCon(paginas: Array<Array<{ id: string; name: string }>>) {
  const $queryRaw = jest.fn()
  for (const p of paginas) $queryRaw.mockResolvedValueOnce(p)
  return { tx: { $queryRaw } as any, $queryRaw }
}

describe('assertGroupNameFree', () => {
  it('🔴 encuentra el duplicado aunque esté después de los primeros 1,000 candidatos', async () => {
    const primera = Array.from({ length: 1000 }, (_, i) => fila(i))
    const { tx, $queryRaw } = txCon([primera, [{ id: 'cz', name: ' playera ' }]])
    await expect(assertGroupNameFree(tx, 'v1', 'Playera')).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_GROUP_NAME_TAKEN' })
    expect($queryRaw).toHaveBeenCalledTimes(2)
  })

  it('deja pasar cuando se agotan los candidatos sin duplicado (una página corta termina)', async () => {
    const { tx, $queryRaw } = txCon([[fila(1), fila(2)]])
    await expect(assertGroupNameFree(tx, 'v1', 'Playera')).resolves.toBeUndefined()
    expect($queryRaw).toHaveBeenCalledTimes(1)
  })
})
