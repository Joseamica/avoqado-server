/**
 * Liga por prenda (purpose ITEM + productGroupId, sin items): creación y edición desde el panel.
 * Reglas: plan Pro (PRODUCT_VARIANTS), sólo Stripe, familia viva del mismo venue, sin items ni descuento,
 * reutilizable forzada, sin importe fijo; editar no convierte una liga en otra clase.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('nanoid', () => ({ nanoid: jest.fn(() => 'abc12345') }))
jest.mock('@/services/access/basePlan.service', () => ({ __esModule: true, venueHasFeatureAccess: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))

import { createPaymentLink, updatePaymentLink, getPaymentLinks } from '../../../../src/services/dashboard/paymentLink.service'
import { venueHasFeatureAccess } from '../../../../src/services/access/basePlan.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-123'
const STAFF = 'staff-123'
const GROUP = 'cm00000000000000000000009'
const stripe = { id: 'merchant-stripe', chargesEnabled: true, providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } }
const blumon = { id: 'merchant-blumon', chargesEnabled: true, providerCredentials: {}, provider: { code: 'BLUMON' } }
const porPrenda = (o: Record<string, any> = {}) => ({
  title: 'Playera',
  amountType: 'FIXED' as const,
  purpose: 'ITEM' as const,
  productGroupId: GROUP,
  ...o,
})

beforeEach(() => {
  ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
  prismaMock.ecommerceMerchant.findMany.mockResolvedValue([stripe] as any)
  prismaMock.productGroup.findFirst.mockResolvedValue({ id: GROUP, name: 'Playera' } as any)
  prismaMock.paymentLink.create.mockResolvedValue({ id: 'pl-1', shortCode: 'abc12345' } as any)
})

describe('crear liga por prenda', () => {
  it('con familia válida: reutilizable forzada, sin importe, FIXED, y lo anota en la bitácora', async () => {
    await createPaymentLink(VENUE, porPrenda({ isReusable: false, amount: 99 }), STAFF)
    expect(venueHasFeatureAccess).toHaveBeenCalledWith(VENUE, 'PRODUCT_VARIANTS')
    expect(prismaMock.productGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: GROUP, venueId: VENUE, deletedAt: null } }),
    )
    const data = (prismaMock.paymentLink.create.mock.calls[0][0] as any).data
    expect(data).toMatchObject({
      productGroupId: GROUP,
      purpose: 'ITEM',
      isReusable: true,
      amountType: 'FIXED',
      ecommerceMerchantId: 'merchant-stripe',
    })
    expect(data.amount).toBeUndefined()
    expect(data.items).toBeUndefined()
    expect((logAction as jest.Mock).mock.calls[0][0].data).toMatchObject({ productGroupId: GROUP })
  })

  it('familia de otro venue o borrada → 400', async () => {
    prismaMock.productGroup.findFirst.mockResolvedValue(null)
    await expect(createPaymentLink(VENUE, porPrenda(), STAFF)).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.paymentLink.create).not.toHaveBeenCalled()
  })

  it('con items → 400', async () => {
    await expect(createPaymentLink(VENUE, porPrenda({ items: [{ productId: 'p1', quantity: 1 }] }), STAFF)).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('con descuento → 400', async () => {
    const discount = { mode: 'MANUAL', type: 'PERCENTAGE', value: 10 }
    await expect(createPaymentLink(VENUE, porPrenda({ discount }), STAFF)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('con otro propósito (PAYMENT) → 400', async () => {
    await expect(createPaymentLink(VENUE, porPrenda({ purpose: 'PAYMENT' }), STAFF)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('sin plan Pro → 403 PLAN_REQUIRED', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    await expect(createPaymentLink(VENUE, porPrenda(), STAFF)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PLAN_REQUIRED',
      message: 'Las ligas por prenda son del plan Pro',
    })
    expect(prismaMock.paymentLink.create).not.toHaveBeenCalled()
  })

  it('comercio que no es Stripe (auto) → 400', async () => {
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([blumon] as any)
    await expect(createPaymentLink(VENUE, porPrenda(), STAFF)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Las ligas por prenda sólo funcionan con Stripe',
    })
  })

  it('comercio Blumon elegido a mano → 400', async () => {
    prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(blumon as any)
    await expect(createPaymentLink(VENUE, porPrenda({ ecommerceMerchantId: 'merchant-blumon' }), STAFF)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Las ligas por prenda sólo funcionan con Stripe',
    })
  })
})

describe('regresión: las demás ligas se crean igual', () => {
  it('de importe: no pide plan ni familia y no escribe productGroupId', async () => {
    await createPaymentLink(VENUE, { title: 'Anticipo', amountType: 'FIXED', amount: 100, purpose: 'PAYMENT' }, STAFF)
    expect(venueHasFeatureAccess).not.toHaveBeenCalled()
    expect(prismaMock.productGroup.findFirst).not.toHaveBeenCalled()
    const data = (prismaMock.paymentLink.create.mock.calls[0][0] as any).data
    expect(data.productGroupId).toBeUndefined()
    expect(data).toMatchObject({ isReusable: false, purpose: 'PAYMENT', ecommerceMerchantId: 'merchant-stripe' })
    expect(Number(data.amount)).toBe(100)
  })

  it('donación abierta', async () => {
    await createPaymentLink(VENUE, { title: 'Dona', amountType: 'OPEN', purpose: 'DONATION', isReusable: true }, STAFF)
    const data = (prismaMock.paymentLink.create.mock.calls[0][0] as any).data
    expect(data).toMatchObject({ purpose: 'DONATION', amountType: 'OPEN', isReusable: true })
    expect(data.productGroupId).toBeUndefined()
  })

  it('de producto (items): sigue exigiendo items', async () => {
    await expect(createPaymentLink(VENUE, { title: 'Combo', amountType: 'FIXED', purpose: 'ITEM', items: [] }, STAFF)).rejects.toBeDefined()
    expect(prismaMock.paymentLink.create).not.toHaveBeenCalled()
  })
})

describe('editar', () => {
  const existente = (o: Record<string, any> = {}) => ({
    id: 'pl-1',
    venueId: VENUE,
    status: 'ACTIVE',
    customerId: null,
    purpose: 'ITEM',
    amountType: 'FIXED',
    amount: null,
    isReusable: true,
    discount: null,
    productGroupId: GROUP,
    ...o,
  })

  it('no convierte una liga de importe/talla fija en por prenda', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(existente({ productGroupId: null, purpose: 'PAYMENT' }) as any)
    await expect(updatePaymentLink(VENUE, 'pl-1', { productGroupId: GROUP }, STAFF)).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.paymentLink.update).not.toHaveBeenCalled()
  })

  it('no convierte una liga por prenda en otra clase (quitar familia, poner items, poner importe)', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(existente() as any)
    await expect(updatePaymentLink(VENUE, 'pl-1', { productGroupId: null }, STAFF)).rejects.toMatchObject({ statusCode: 400 })
    await expect(updatePaymentLink(VENUE, 'pl-1', { items: [{ productId: 'p1', quantity: 1 }] }, STAFF)).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(updatePaymentLink(VENUE, 'pl-1', { amount: 50 }, STAFF)).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.paymentLink.update).not.toHaveBeenCalled()
  })

  it('permite editar título y pausar una liga por prenda, y deja el productGroupId en la bitácora', async () => {
    prismaMock.paymentLink.findUnique.mockResolvedValue(existente() as any)
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
    prismaMock.paymentLink.update.mockResolvedValue({ id: 'pl-1' } as any)
    await updatePaymentLink(VENUE, 'pl-1', { title: 'Nuevo', status: 'PAUSED', productGroupId: GROUP }, STAFF)
    expect(prismaMock.paymentLink.update).toHaveBeenCalled()
    expect((logAction as jest.Mock).mock.calls.at(-1)![0].data).toMatchObject({ productGroupId: GROUP })
  })
})

describe('listar', () => {
  it('trae productGroup { id, name } en cada liga', async () => {
    prismaMock.paymentLink.findMany.mockResolvedValue([
      { id: 'pl-1', discount: null, amount: null, productGroup: { id: GROUP, name: 'Playera' } },
    ] as any)
    prismaMock.paymentLink.count.mockResolvedValue(1)
    prismaMock.checkoutSession.groupBy.mockResolvedValue([] as any)
    const r = await getPaymentLinks(VENUE)
    expect((prismaMock.paymentLink.findMany.mock.calls[0][0] as any).include.productGroup).toEqual({ select: { id: true, name: true } })
    expect((r.paymentLinks[0] as any).productGroup).toEqual({ id: GROUP, name: 'Playera' })
  })
})
