// M1 (revisión final, pedidos en línea fase 2): el borrado de superadmin también cuenta los cobros de pedidos en línea (Restrict) y
// contesta su «tiene historial» de siempre, nunca un 500 de la llave foránea.
import { prismaMock } from '@tests/__helpers__/setup'
import { deleteEcommerceMerchant } from '@/controllers/superadmin/ecommerceMerchants.superadmin.controller'

jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))

const res = () => {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}
const merchant = (onlineOrderCharges: number) => ({
  id: 'm1',
  venueId: 'v1',
  providerId: 'p1',
  _count: { checkoutSessions: 0, paymentLinks: 0, payments: 0, reservations: 0, onlineOrderCharges },
})

beforeEach(() => jest.clearAllMocks())

it('con cobros de pedidos en línea → rechazo claro que los nombra, sin borrar', async () => {
  prismaMock.ecommerceMerchant.findUnique.mockResolvedValue(merchant(3) as any)
  const r = res()
  await deleteEcommerceMerchant({ params: { id: 'm1' }, headers: {} } as any, r)
  expect(prismaMock.ecommerceMerchant.findUnique.mock.calls[0][0].include._count.select).toMatchObject({ onlineOrderCharges: true })
  expect(r.status).toHaveBeenCalledWith(400)
  expect(r.json).toHaveBeenCalledWith(
    expect.objectContaining({ success: false, error: expect.stringContaining('3 cobro(s) de pedidos en línea') }),
  )
  expect(prismaMock.ecommerceMerchant.delete).not.toHaveBeenCalled()
})

it('sin historial se borra', async () => {
  prismaMock.ecommerceMerchant.findUnique.mockResolvedValue(merchant(0) as any)
  const r = res()
  await deleteEcommerceMerchant({ params: { id: 'm1' }, headers: {} } as any, r)
  expect(prismaMock.ecommerceMerchant.delete).toHaveBeenCalledWith({ where: { id: 'm1' } })
})
