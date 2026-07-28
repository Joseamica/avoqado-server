import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn(),
}))
jest.mock('@/services/email.service', () => ({ __esModule: true }))

import { createPurchaseOrder } from '@/services/dashboard/purchaseOrder.service'

/**
 * Congelado de la presentación de compra al CREAR la orden ("50 cajas de huevo").
 *
 * Esta es la mitad que faltaba: la aritmética de conversión ya existía y estaba
 * probada, pero nadie escribía `presentationFactor`, así que la rama era
 * inalcanzable y comprar en cajas era imposible. Estos tests fijan el contrato
 * de escritura.
 */
describe('createPurchaseOrder — snapshot de la presentación de compra', () => {
  const VENUE = 'venue-1'
  const RM = 'rm-huevo'
  const SUPPLIER = 'sup-1'

  const baseData = {
    supplierId: SUPPLIER,
    orderDate: '2026-07-27T00:00:00.000Z',
  } as any

  /** Devuelve los renglones que se le pasaron a `purchaseOrder.create`. */
  const createdItems = () => prismaMock.purchaseOrder.create.mock.calls[0][0].data.items.create

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.supplier.findFirst.mockResolvedValue({ id: SUPPLIER, minimumOrder: null })
    prismaMock.rawMaterial.findMany.mockResolvedValue([{ id: RM, unit: 'PIECE' }])
    prismaMock.purchaseOrder.findFirst.mockResolvedValue(null)
    prismaMock.purchaseOrder.count.mockResolvedValue(0)
    prismaMock.purchaseOrder.create.mockResolvedValue({
      id: 'po-1',
      orderNumber: 'OC-001',
      supplierId: SUPPLIER,
      items: [],
    })
  })

  it('congela nombre y factor de la presentación en el renglón', async () => {
    prismaMock.rawMaterialPresentation.findMany.mockResolvedValue([
      { rawMaterialId: RM, name: 'caja', factorToBase: new Decimal(360), rawMaterial: { name: 'Huevo', unit: 'PIECE' } },
    ])

    await createPurchaseOrder(
      VENUE,
      { ...baseData, items: [{ rawMaterialId: RM, quantityOrdered: 50, unit: 'PIECE', unitPrice: 360, presentationName: 'caja' }] },
      'staff-1',
    )

    const item = createdItems()[0]
    expect(item.presentationName).toBe('caja')
    expect(new Decimal(item.presentationFactor).toNumber()).toBe(360)
  })

  it('la unidad del renglón queda en la BASE del insumo (el enum no puede decir "caja")', async () => {
    prismaMock.rawMaterialPresentation.findMany.mockResolvedValue([
      { rawMaterialId: RM, name: 'caja', factorToBase: new Decimal(360), rawMaterial: { name: 'Huevo', unit: 'PIECE' } },
    ])

    await createPurchaseOrder(
      VENUE,
      { ...baseData, items: [{ rawMaterialId: RM, quantityOrdered: 50, unit: 'KILOGRAM', unitPrice: 360, presentationName: 'caja' }] },
      'staff-1',
    )

    expect(createdItems()[0].unit).toBe('PIECE')
  })

  it('REGRESIÓN: sin presentación, el renglón queda con factor null y su unidad original', async () => {
    prismaMock.rawMaterialPresentation.findMany.mockResolvedValue([])

    await createPurchaseOrder(
      VENUE,
      { ...baseData, items: [{ rawMaterialId: RM, quantityOrdered: 8, unit: 'KILOGRAM', unitPrice: 25 }] },
      'staff-1',
    )

    const item = createdItems()[0]
    expect(item.presentationName).toBeNull()
    expect(item.presentationFactor).toBeNull()
    expect(item.unit).toBe('KILOGRAM')
  })

  it('no consulta presentaciones si ningún renglón las usa', async () => {
    await createPurchaseOrder(
      VENUE,
      { ...baseData, items: [{ rawMaterialId: RM, quantityOrdered: 8, unit: 'KILOGRAM', unitPrice: 25 }] },
      'staff-1',
    )
    expect(prismaMock.rawMaterialPresentation.findMany).not.toHaveBeenCalled()
  })

  it('una presentación inexistente ABORTA la orden y lista las disponibles', async () => {
    prismaMock.rawMaterialPresentation.findMany.mockResolvedValue([
      { rawMaterialId: RM, name: 'caja', factorToBase: new Decimal(360), rawMaterial: { name: 'Huevo', unit: 'PIECE' } },
      { rawMaterialId: RM, name: 'cono', factorToBase: new Decimal(30), rawMaterial: { name: 'Huevo', unit: 'PIECE' } },
    ])

    await expect(
      createPurchaseOrder(
        VENUE,
        { ...baseData, items: [{ rawMaterialId: RM, quantityOrdered: 1, unit: 'PIECE', unitPrice: 10, presentationName: 'barril' }] },
        'staff-1',
      ),
    ).rejects.toThrow(/barril.*no existe.*caja, cono/is)

    expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
  })

  it('un factor corrupto en la configuración no se congela en la orden', async () => {
    prismaMock.rawMaterialPresentation.findMany.mockResolvedValue([
      { rawMaterialId: RM, name: 'caja', factorToBase: new Decimal(0), rawMaterial: { name: 'Huevo', unit: 'PIECE' } },
    ])

    await expect(
      createPurchaseOrder(
        VENUE,
        { ...baseData, items: [{ rawMaterialId: RM, quantityOrdered: 1, unit: 'PIECE', unitPrice: 10, presentationName: 'caja' }] },
        'staff-1',
      ),
    ).rejects.toThrow(/factor inválido/i)
    expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
  })

  it('TENANT: sólo busca presentaciones del venue del request', async () => {
    prismaMock.rawMaterialPresentation.findMany.mockResolvedValue([
      { rawMaterialId: RM, name: 'caja', factorToBase: new Decimal(360), rawMaterial: { name: 'Huevo', unit: 'PIECE' } },
    ])

    await createPurchaseOrder(
      VENUE,
      { ...baseData, items: [{ rawMaterialId: RM, quantityOrdered: 1, unit: 'PIECE', unitPrice: 10, presentationName: 'caja' }] },
      'staff-1',
    )

    expect(prismaMock.rawMaterialPresentation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE }) }),
    )
  })
})
