/**
 * La cerca del vale de inventario (bloque 0 de la liga con talla, Codex r3 #1).
 *
 * `assertPostingFence` corre DENTRO de la transacción que escribe un movimiento con `postingLineId`: bloquea la fila
 * del vale y aborta si otro trabajador ya la re-reclamó (su sello `updatedAt` cambió). Sin `fence` no hace nada, así
 * los llamadores sin vale (dashboard, merma, conteos) no cambian. La carrera real va en
 * tests/integration/inventory/postingFence.integration.test.ts.
 */
import { assertPostingFence, PostingFenceLostError } from '@/services/inventory/postingFence'

const SELLO = new Date('2026-11-12T18:00:00.123Z')
const txQueDevuelve = (filas: Array<{ updatedAt: Date }>) => ({ $queryRaw: jest.fn().mockResolvedValue(filas) }) as any

describe('assertPostingFence', () => {
  it('sin fence no toca la transacción (los llamadores sin vale no cambian)', async () => {
    const tx = txQueDevuelve([])
    await expect(assertPostingFence(tx, undefined)).resolves.toBeUndefined()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it('con el mismo sello pasa, y bloquea la fila del vale con FOR UPDATE', async () => {
    const tx = txQueDevuelve([{ updatedAt: new Date(SELLO.getTime()) }])
    await expect(assertPostingFence(tx, { postingId: 'p1', claimStamp: SELLO })).resolves.toBeUndefined()
    const [sql, ...valores] = tx.$queryRaw.mock.calls[0]
    expect(sql.join('?')).toMatch(/FROM "InventoryPosting"[\s\S]*FOR UPDATE/)
    expect(valores).toEqual(['p1'])
  })

  it('con un sello distinto (otro trabajador re-reclamó) lanza PostingFenceLostError', async () => {
    const tx = txQueDevuelve([{ updatedAt: new Date(SELLO.getTime() + 1) }])
    await expect(assertPostingFence(tx, { postingId: 'p1', claimStamp: SELLO })).rejects.toBeInstanceOf(PostingFenceLostError)
  })

  it('si el vale ya no existe también se retira', async () => {
    const tx = txQueDevuelve([])
    await expect(assertPostingFence(tx, { postingId: 'p1', claimStamp: SELLO })).rejects.toBeInstanceOf(PostingFenceLostError)
  })
})
