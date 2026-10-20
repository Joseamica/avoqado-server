const mockCreate = jest.fn()
jest.mock('@/services/product-variants/productGroup.service', () => ({ createProductWithVariants: (...a: unknown[]) => mockCreate(...a) }))
jest.mock('@/services/product-variants/groupExisting.service', () => ({}))
const mockOptions = { createProductOption: jest.fn(), updateProductOption: jest.fn(), deleteProductOption: jest.fn() }
jest.mock('@/services/mobile/product-option.mobile.service', () => ({
  createProductOption: (...a: unknown[]) => mockOptions.createProductOption(...a),
  updateProductOption: (...a: unknown[]) => mockOptions.updateProductOption(...a),
  deleteProductOption: (...a: unknown[]) => mockOptions.deleteProductOption(...a),
}))
import { createGroup, createOption, deleteOption, updateOption } from '@/controllers/dashboard/productGroup.controller'

it('POST / responde 201 con el padre creado y pasa el actor del token', async () => {
  mockCreate.mockResolvedValue({ groupId: 'g1', productIds: ['p1'], categoryId: 'c1' })
  const req: any = { params: { venueId: 'v1' }, body: { name: 'Playera' }, authContext: { userId: 's1', isImpersonating: false } }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  const next = jest.fn()
  await createGroup(req, res, next)
  expect(mockCreate).toHaveBeenCalledWith('v1', { name: 'Playera' }, { type: 'HUMAN', staffId: 's1', impersonating: false })
  expect(res.status).toHaveBeenCalledWith(201)
  expect(res.json).toHaveBeenCalledWith({ success: true, data: { groupId: 'g1', productIds: ['p1'], categoryId: 'c1' } })
  expect(next).not.toHaveBeenCalled()
})

it('🔴 I-6: la biblioteca de opciones desde el dashboard audita con source DASHBOARD (el POS sigue en MOBILE)', async () => {
  const req: any = { params: { venueId: 'v1', optionId: 'o1' }, body: { name: 'Talla', values: ['S'] }, authContext: { userId: 's1' } }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  await createOption(req, res, jest.fn())
  await updateOption(req, res, jest.fn())
  await deleteOption(req, res, jest.fn())
  expect(mockOptions.createProductOption).toHaveBeenCalledWith(expect.objectContaining({ source: 'DASHBOARD' }))
  expect(mockOptions.updateProductOption).toHaveBeenCalledWith(expect.objectContaining({ source: 'DASHBOARD' }))
  expect(mockOptions.deleteProductOption).toHaveBeenCalledWith('o1', 'v1', 's1', 'DASHBOARD')
})
