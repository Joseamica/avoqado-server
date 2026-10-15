/**
 * /full-testing I-5 (variantes, 14-oct): renombrar una variante desde Android responde 409 («Este dato se edita en el producto…»).
 * Es un rechazo esperado: va al log como `warn`, no como `error` (cada intento disparaba una alerta falsa). Un fallo real sigue en `error`.
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import { updateProduct } from '@/controllers/mobile/product.mobile.controller'

const prismaMock = prisma as any
const req = () => ({ params: { venueId: 'v1', productId: 'p1' }, body: { name: 'Otro' }, authContext: { userId: 's1' } }) as any

it('un rechazo esperado (AppError 4xx) se registra como warn y sigue al manejador de errores', async () => {
  const conflicto = new ConflictError('Este dato se edita en el producto «Playera», no en cada variante.', 'PRODUCT_FIELD_OWNED_BY_GROUP')
  prismaMock.product.findFirst.mockRejectedValueOnce(conflicto)
  const next = jest.fn()
  await updateProduct(req(), {} as any, next)
  expect(next).toHaveBeenCalledWith(conflicto)
  expect(logger.error).not.toHaveBeenCalled()
  expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ productId: 'p1', venueId: 'v1' }))
})

it('un fallo inesperado sigue registrándose como error', async () => {
  const falla = new Error('connection reset')
  prismaMock.product.findFirst.mockRejectedValueOnce(falla)
  const next = jest.fn()
  await updateProduct(req(), {} as any, next)
  expect(next).toHaveBeenCalledWith(falla)
  expect(logger.error).toHaveBeenCalledWith('Error updating product (mobile)', expect.objectContaining({ error: 'connection reset' }))
})
