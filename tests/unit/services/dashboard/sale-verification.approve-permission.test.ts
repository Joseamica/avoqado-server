/** `sale-verifications:approve` se revisa en el servicio contra la tienda de la VENTA (tienda, org y MCP pasan por aquí). */
import { reviewSaleVerification } from '@/services/dashboard/sale-verification.dashboard.service'
import { editOrgSaleVerification, reviewOrgSaleVerification } from '@/services/dashboard/sale-verification.org.dashboard.service'
import prisma from '@/utils/prismaClient'
import { staffHasPermissionInVenue } from '@/middlewares/checkPermission.middleware'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { saleVerification: { findUnique: jest.fn(), update: jest.fn() }, $transaction: jest.fn() },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({ __esModule: true, staffHasPermissionInVenue: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { broadcastToUser: jest.fn() } }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))

const findUnique = prisma.saleVerification.findUnique as jest.Mock
const update = prisma.saleVerification.update as jest.Mock
const tx = prisma.$transaction as jest.Mock
const can = staffHasPermissionInVenue as jest.Mock

const sale = (status = 'PENDING') => ({
  id: 'sv-1',
  venueId: 'tienda-1',
  staffId: 'promotor',
  paymentId: null,
  status,
  isPortabilidad: false,
  reviewNotes: null,
  rejectionReasons: [],
  payment: null,
  venue: { organizationId: 'org-1' },
})

beforeEach(() => {
  jest.clearAllMocks()
  can.mockResolvedValue(false)
})

describe('reviewSaleVerification', () => {
  it('sin approve en la tienda de la venta: SALE_APPROVE_FORBIDDEN y no toca la fila', async () => {
    findUnique.mockResolvedValue(sale())
    await expect(
      reviewSaleVerification('tienda-1', { saleVerificationId: 'sv-1', reviewedById: 'gerente', decision: 'APPROVE' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'SALE_APPROVE_FORBIDDEN' })
    expect(can).toHaveBeenCalledWith({ staffId: 'gerente', venueId: 'tienda-1', permission: 'sale-verifications:approve' })
    expect(update).not.toHaveBeenCalled()
  })
})

describe('editOrgSaleVerification', () => {
  const base = { saleVerificationId: 'sv-1', editedById: 'dueno', reason: 'corrección de prueba' }

  it.each(['COMPLETED', 'REJECTED'] as const)('cambiar a %s sin approve: SALE_APPROVE_FORBIDDEN', async status => {
    findUnique.mockResolvedValue(sale())
    await expect(editOrgSaleVerification('org-1', { ...base, status })).rejects.toMatchObject({ code: 'SALE_APPROVE_FORBIDDEN' })
    expect(can).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'tienda-1', permission: 'sale-verifications:approve' }))
    expect(tx).not.toHaveBeenCalled()
  })

  it('FAILED sin approve también se niega', async () => {
    findUnique.mockResolvedValue(sale())
    await expect(editOrgSaleVerification('org-1', { ...base, status: 'FAILED', reviewNotes: 'falta la foto' })).rejects.toMatchObject({
      code: 'SALE_APPROVE_FORBIDDEN',
    })
  })

  it('un cambio de monto sin estado no pide approve', async () => {
    findUnique.mockResolvedValue(sale())
    tx.mockRejectedValue(new Error('llegó a la transacción'))
    await expect(editOrgSaleVerification('org-1', { ...base, amount: 100 })).rejects.toThrow('llegó a la transacción')
    expect(can).not.toHaveBeenCalled()
  })

  it('el mismo estado de hoy no pide approve', async () => {
    findUnique.mockResolvedValue(sale('COMPLETED'))
    tx.mockRejectedValue(new Error('llegó a la transacción'))
    await expect(editOrgSaleVerification('org-1', { ...base, status: 'COMPLETED' })).rejects.toThrow('llegó a la transacción')
    expect(can).not.toHaveBeenCalled()
  })

  it('PENDING (reabrir) no pide approve', async () => {
    findUnique.mockResolvedValue(sale('COMPLETED'))
    tx.mockRejectedValue(new Error('llegó a la transacción'))
    await expect(editOrgSaleVerification('org-1', { ...base, status: 'PENDING' })).rejects.toThrow('llegó a la transacción')
    expect(can).not.toHaveBeenCalled()
  })
})

describe('reviewOrgSaleVerification (ruta de organización y tool MCP review_sale_verification)', () => {
  it('delega con la tienda de la venta y se niega sin approve ahí', async () => {
    findUnique.mockResolvedValue(sale())
    await expect(
      reviewOrgSaleVerification('org-1', { saleVerificationId: 'sv-1', reviewedById: 'gerente', decision: 'REJECT_FINAL' }),
    ).rejects.toMatchObject({ code: 'SALE_APPROVE_FORBIDDEN' })
    expect(can).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'tienda-1' }))
    expect(update).not.toHaveBeenCalled()
  })
})
