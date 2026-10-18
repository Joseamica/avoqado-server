import prisma from '@/utils/prismaClient'
import { updateProductGroup } from '@/services/product-variants/productGroup.service'

// Codex (publicación, r1 #2): un bloqueo mutuo de Postgres (40P01) al editar la familia sale como 409 «vuelve a intentarlo», nunca 500.
describe('updateProductGroup ante un bloqueo mutuo', () => {
  const actor = { type: 'HUMAN', staffId: 'cstaff00000000000000000001', impersonating: false } as const

  it('🔴 un 40P01 de Postgres responde 409 en español', async () => {
    ;(prisma.$transaction as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
    await expect(
      updateProductGroup('cvenue0000000000000000001', 'cgroup0000000000000000001', { name: 'Gorra' }, actor),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Otro cambio tocó este producto al mismo tiempo. Vuelve a intentarlo.',
    })
  })

  it('cualquier otro error sigue saliendo tal cual', async () => {
    const otro = new Error('se cayó la base')
    ;(prisma.$transaction as jest.Mock).mockRejectedValueOnce(otro)
    await expect(updateProductGroup('cvenue0000000000000000001', 'cgroup0000000000000000001', { name: 'Gorra' }, actor)).rejects.toBe(otro)
  })
})
