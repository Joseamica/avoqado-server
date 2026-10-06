import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '@tests/__helpers__/setup'

const applyReceive = jest.fn()
jest.mock('@/services/dashboard/purchaseOrder.service', () => ({
  applyItemReceiveStatusInTx: (...args: unknown[]) => applyReceive(...args),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { previewSupplierInvoiceInventory, confirmSupplierInvoiceInventory } from '@/services/dashboard/supplierInvoiceInventory.service'

const dec = (n: number) => new Decimal(n)
const invoice = () => ({
  id: 'inv',
  venueId: 'venue',
  uuid: 'UUID-1',
  supplierId: 'supplier',
  emisorRfc: 'AAA010101AAA',
  currency: 'MXN',
  cfdiType: 'I' as string | null,
  subtotalCents: 100000,
  descuentoCents: 10000,
  ivaCents: 14400,
  iepsCents: 0,
  totalCents: 104400,
  inventoryPreparedAt: null,
  inventoryReceivedAt: null,
  purchaseOrderId: null,
  purchaseOrder: null,
  supplier: { id: 'supplier', venueId: 'venue', name: 'Proveedor', taxId: 'AAA010101AAA', active: true, deletedAt: null },
  lines: [
    {
      id: 'line',
      cantidad: dec(3),
      importeCents: 100000,
      descuentoCents: 10000,
      iepsCents: 0,
      rawMaterialId: 'raw',
      productId: null,
      purchaseUnit: 'KILOGRAM',
      presentationName: null,
      claveUnidad: 'KGM',
      descripcion: 'Harina',
      rawMaterial: { id: 'raw', venueId: 'venue', name: 'Harina', unit: 'GRAM', active: true },
      product: null,
    },
  ],
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(invoice())
  prismaMock.purchaseOrderInvoice.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.purchaseOrder.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.rawMaterialPresentation.findMany.mockResolvedValue([])
  prismaMock.purchaseOrder.create.mockImplementation(async ({ data }: any) => ({
    id: 'po',
    ...data,
    items: [{ id: 'item', ...data.items.create[0] }],
  }))
  prismaMock.purchaseOrderInvoiceLine.update.mockResolvedValue({})
  applyReceive.mockResolvedValue(undefined)
})

describe('XML a inventario: nueva recepción', () => {
  it('convierte kilos a gramos y calcula el costo neto, descontando el descuento y dejando fuera IVA', async () => {
    const p = await previewSupplierInvoiceInventory('venue', 'inv')
    expect(p.action).toBe('PREPARE')
    expect(p.lines[0]).toMatchObject({ quantity: '3', baseQuantity: '3000', netAmount: '900', baseUnitCost: '0.3' })
    expect(p.total).toBe('1044')
  })

  it('usa el factor de la presentación, no toma una caja como un kilo', async () => {
    const inv = invoice()
    inv.lines[0].presentationName = 'caja' as any
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    prismaMock.rawMaterialPresentation.findMany.mockResolvedValue([{ rawMaterialId: 'raw', name: 'caja', factorToBase: dec(12000) }])
    const p = await previewSupplierInvoiceInventory('venue', 'inv')
    expect(p.lines[0].baseQuantity).toBe('36000')
    expect(p.lines[0].presentationFactor).toBe('12000')
  })

  it.each([
    [
      'sin identificar',
      (i: any) => {
        i.lines[0].rawMaterialId = null
        i.lines[0].rawMaterial = null
      },
    ],
    [
      'sin unidad',
      (i: any) => {
        i.lines[0].purchaseUnit = null
        i.lines[0].claveUnidad = 'XBX'
      },
    ],
    [
      'cantidad cero',
      (i: any) => {
        i.lines[0].cantidad = dec(0)
      },
    ],
    [
      'descuento excesivo',
      (i: any) => {
        i.lines[0].descuentoCents = 100001
      },
    ],
    [
      'moneda extranjera',
      (i: any) => {
        i.currency = 'USD'
      },
    ],
    [
      'renglones que no cuadran',
      (i: any) => {
        i.subtotalCents++
      },
    ],
  ])('bloquea %s antes de escribir', async (_name, mutate) => {
    const inv = invoice()
    mutate(inv)
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow()
    expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
  })

  it('prepara UNA orden pendiente de autorización, sin sumar inventario', async () => {
    const p = await previewSupplierInvoiceInventory('venue', 'inv')
    const result = await confirmSupplierInvoiceInventory('venue', 'inv', p.confirmationToken, 'staff')
    expect(result.status).toBe('PENDING_APPROVAL')
    expect(prismaMock.purchaseOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING_APPROVAL', subtotal: dec(900), taxAmount: dec(144), total: dec(1044) }),
      }),
    )
    expect(applyReceive).not.toHaveBeenCalled()
  })

  it('rechaza una confirmación obsoleta si alguien cambió la unidad o presentación', async () => {
    const p = await previewSupplierInvoiceInventory('venue', 'inv')
    const inv = invoice()
    inv.lines[0].purchaseUnit = 'GRAM'
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    await expect(confirmSupplierInvoiceInventory('venue', 'inv', p.confirmationToken, 'staff')).rejects.toThrow(/revis|unidad/i)
    expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
  })

  it('una confirmación concurrente que pierde el reclamo no crea otra orden', async () => {
    const p = await previewSupplierInvoiceInventory('venue', 'inv')
    prismaMock.purchaseOrderInvoice.updateMany.mockResolvedValue({ count: 0 })
    await expect(confirmSupplierInvoiceInventory('venue', 'inv', p.confirmationToken, 'staff')).rejects.toThrow()
    expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
  })
})

describe('regresiones: orden y recepción existentes', () => {
  const prepared = (status: string) => {
    const inv: any = invoice()
    inv.inventoryPreparedAt = new Date('2026-10-05T18:00:00Z')
    inv.purchaseOrderId = 'po'
    inv.purchaseOrder = {
      id: 'po',
      status,
      orderNumber: 'XML-UUID-1',
      supplierId: 'supplier',
      subtotal: dec(900),
      total: dec(1044),
      taxAmount: dec(144),
      items: [
        {
          id: 'item',
          rawMaterialId: 'raw',
          productId: null,
          quantityOrdered: dec(3),
          quantityReceived: dec(0),
          unit: 'KILOGRAM',
          unitPrice: dec(300),
          total: dec(900),
          presentationName: null,
          presentationFactor: null,
        },
      ],
    }
    inv.lines[0].purchaseOrderItemId = 'item'
    return inv
  }

  it('una factura de una orden ordinaria, incluso parcial, nunca crea una entrada adicional', async () => {
    const inv = prepared('PARTIAL')
    inv.inventoryPreparedAt = null
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/orden/i)
  })

  it('una orden pendiente no se recibe por tener un XML', async () => {
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(prepared('PENDING_APPROVAL'))
    await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/autoriz/i)
    expect(applyReceive).not.toHaveBeenCalled()
  })

  it('recibe una orden autorizada mediante el mismo núcleo de inventario y la misma transacción', async () => {
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(prepared('APPROVED'))
    const p = await previewSupplierInvoiceInventory('venue', 'inv')
    expect(p.action).toBe('RECEIVE')
    await confirmSupplierInvoiceInventory('venue', 'inv', p.confirmationToken, 'staff')
    expect(applyReceive).toHaveBeenCalledWith(
      prismaMock,
      'venue',
      'po',
      'item',
      expect.objectContaining({ receiveStatus: 'RECEIVED', quantityReceived: 3 }),
      'staff',
    )
    expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
  })

  it('una factura ya recibida nunca vuelve a sumar', async () => {
    const inv = prepared('RECEIVED')
    inv.inventoryReceivedAt = new Date()
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/recibid/i)
    expect(applyReceive).not.toHaveBeenCalled()
  })

  it('no recibe una orden modificada después de preparar el XML', async () => {
    const inv = prepared('APPROVED')
    inv.purchaseOrder.items[0].unitPrice = dec(301)
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/modific/i)
  })

  it.each([
    ['supplierId', 'otro-proveedor'],
    ['subtotal', dec(901)],
    ['total', dec(1045)],
    ['taxAmount', dec(145)],
  ])('bloquea una orden si cambió %s, incluso con un token de revisión anterior', async (field, value) => {
    const inv = prepared('APPROVED')
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    const review = await previewSupplierInvoiceInventory('venue', 'inv')
    inv.purchaseOrder[field as string] = value
    await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/modific/i)
    await expect(confirmSupplierInvoiceInventory('venue', 'inv', review.confirmationToken, 'staff')).rejects.toThrow(/modific/i)
    expect(applyReceive).not.toHaveBeenCalled()
    expect(prismaMock.purchaseOrderInvoice.updateMany).not.toHaveBeenCalled()
  })
})

describe('unidades y dinero inválidos', () => {
  it('una unidad conocida del XML no puede cambiarse sin presentación explícita', async () => {
    const inv = invoice()
    inv.lines[0].purchaseUnit = 'GRAM'
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/unidad/i)
  })
  it('valida el total del XML antes de crear una compra', async () => {
    const inv = invoice()
    inv.totalCents = -1
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/importe|total/i)
  })
  it('incluye IEPS sólo cuando se elige y exige el desglose completo', async () => {
    const inv = invoice()
    inv.iepsCents = 8000
    inv.lines[0].iepsCents = 8000
    inv.totalCents += 8000
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    expect((await previewSupplierInvoiceInventory('venue', 'inv')).subtotal).toBe('900')
    expect((await previewSupplierInvoiceInventory('venue', 'inv', true)).subtotal).toBe('980')
    inv.lines[0].iepsCents = 0
    await expect(previewSupplierInvoiceInventory('venue', 'inv', true)).rejects.toThrow(/IEPS/i)
  })
  it('no toma un artículo de otro negocio aunque la relación exista', async () => {
    const inv: any = invoice()
    inv.lines[0].rawMaterial.venueId = 'other'
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
    await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/negocio/i)
  })
})

it('cajas sin una presentación explícita nunca se convierten por una unidad elegida a mano', async () => {
  const inv = invoice()
  inv.lines[0].claveUnidad = 'XBX'
  inv.lines[0].purchaseUnit = 'GRAM'
  prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
  await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/presentación/i)
})

// Las notas de crédito también tienen cantidades positivas: eso no es una entrada de mercancía.
it.each(['E', 'P', 'T', 'N', '', null])('no prepara inventario para CFDI tipo %s', async cfdiType => {
  const inv = invoice()
  inv.cfdiType = cfdiType
  prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
  await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/tipo I|ingreso/i)
  expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
  expect(applyReceive).not.toHaveBeenCalled()
})

it('no prepara una compra con una relación de proveedor de otro negocio', async () => {
  const inv = invoice()
  inv.supplier.venueId = 'otro-negocio'
  prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(inv)
  await expect(previewSupplierInvoiceInventory('venue', 'inv')).rejects.toThrow(/proveedor/)
  expect(prismaMock.purchaseOrder.create).not.toHaveBeenCalled()
})
