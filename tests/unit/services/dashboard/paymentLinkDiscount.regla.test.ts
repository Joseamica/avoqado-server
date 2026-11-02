import { cargarRegla, esCompatibleConLigas, DescuentoDeLiga } from '../../../../src/services/dashboard/paymentLinkDiscount'

const base = {
  scope: 'ORDER',
  type: 'PERCENTAGE',
  requiresApproval: false,
  isAutomatic: false,
  buyQuantity: null,
  getQuantity: null,
  getDiscountPercent: null,
  buyItemIds: [],
  getItemIds: [],
  maxTotalUses: null,
  maxUsesPerCustomer: null,
  customerGroupId: null,
}

describe('esCompatibleConLigas', () => {
  it('acepta un descuento sin reglas de uso ni de cliente', () => {
    expect(esCompatibleConLigas(base as any)).toEqual({ ok: true })
  })

  it.each([
    [{ maxTotalUses: 10 }, 'Tiene límite de usos: escríbelo a mano'],
    [{ maxUsesPerCustomer: 1 }, 'Tiene límite por cliente: escríbelo a mano'],
    [{ customerGroupId: 'cgrupo' }, 'Es solo para un grupo de clientes'],
    [{ requiresApproval: true }, 'Pide autorización de un gerente'],
    [{ type: 'COMP' }, 'Es una cortesía'],
    [{ isAutomatic: true }, 'Se aplica solo en el POS'],
    [{ buyQuantity: 2 }, 'Es una promoción de tipo 2×1'],
    [{ getQuantity: 1 }, 'Es una promoción de tipo 2×1'],
    [{ getDiscountPercent: 100 }, 'Es una promoción de tipo 2×1'],
    [{ buyItemIds: ['p1'] }, 'Es una promoción de tipo 2×1'],
    [{ getItemIds: ['p1'] }, 'Es una promoción de tipo 2×1'],
    [{ scope: 'ITEM' }, 'Es solo para ciertos productos o categorías'],
    [{ scope: 'CATEGORY' }, 'Es solo para ciertos productos o categorías'],
  ])('rechaza %j', (cambio, razon) => {
    expect(esCompatibleConLigas({ ...base, ...cambio } as any)).toEqual({ ok: false, razon })
  })
})

describe('cargarRegla', () => {
  const foto: DescuentoDeLiga = { v: 1, origen: 'CATALOGO', discountId: 'cabcdefghijklmnopqrstuvwx', type: 'PERCENTAGE', value: 10, name: 'X' }
  const txCon = (row: unknown) => ({ discount: { findUnique: jest.fn().mockResolvedValue(row) } }) as any

  it('MANUAL o sin foto → null, sin consultar', async () => {
    const tx = txCon(null)
    expect(await cargarRegla(tx, null)).toBeNull()
    expect(await cargarRegla(tx, { ...foto, origen: 'MANUAL', discountId: null })).toBeNull()
    expect(tx.discount.findUnique).not.toHaveBeenCalled()
  })

  it('descuento borrado → existe:false y no compatible', async () => {
    const r = await cargarRegla(txCon(null), foto)
    expect(r).toMatchObject({ existe: false, compatible: false, active: false, validFrom: null, minPurchaseAmount: null })
  })

  it('mapea Decimals a number y marca compatible', async () => {
    const tx = txCon({
      ...base,
      active: true,
      validFrom: null,
      validUntil: new Date('2027-01-01T00:00:00Z'),
      daysOfWeek: [5],
      timeFrom: '09:00',
      timeUntil: '17:00',
      minPurchaseAmount: { toNumber: () => 200 },
      maxDiscountAmount: { toNumber: () => 50 },
    })
    const r = await cargarRegla(tx, foto)
    expect(tx.discount.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: foto.discountId } }))
    expect(r).toMatchObject({ existe: true, compatible: true, active: true, daysOfWeek: [5], minPurchaseAmount: 200, maxDiscountAmount: 50 })
  })

  it('existente pero con límite de usos → compatible:false', async () => {
    const r = await cargarRegla(txCon({ ...base, maxTotalUses: 5, active: true, validFrom: null, validUntil: null, daysOfWeek: [], timeFrom: null, timeUntil: null, minPurchaseAmount: null, maxDiscountAmount: null }), foto)
    expect(r).toMatchObject({ existe: true, compatible: false })
  })
})
