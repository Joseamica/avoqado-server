/**
 * Fase 2 de la factura — el código del proveedor APRENDE, y la factura puede llegar sin orden.
 *
 * Tres reglas que esta suite fija:
 * - El mapeo es del PROVEEDOR (código → insumo/producto), no de una orden: por eso sirve para
 *   órdenes nuevas. La fase 1 guardaba código → renglón de una orden vieja, que no servía.
 * - NUNCA se adivina por texto: o el código ya se conoce, o lo confirma una persona (y al
 *   confirmarlo, se aprende).
 * - Una entrega parcial NO es descuadre: el veredicto suma las facturas previas de la orden.
 */
import { prismaMock } from '@tests/__helpers__/setup'

const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))
const mockResolveScope = jest.fn()
jest.mock('@/services/fiscal/chartOfAccounts.service', () => ({
  ...jest.requireActual('@/services/fiscal/chartOfAccounts.service'),
  resolveScopeOrNull: (...a: unknown[]) => mockResolveScope(...(a as [])),
}))

import { attachInvoiceToPurchaseOrder, identifyInvoiceLine, registerSupplierInvoice } from '@/services/dashboard/purchaseOrderInvoice.service'

const VENUE_ID = 'venue-1'
const OUR_RFC = 'EKU9003173C9'
const SUPPLIER_RFC = 'CACO850101AB1'

const cfdi = (over: { total?: string; importe?: string; codigo?: string; uuid?: string } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Fecha="2026-06-10T14:30:00" Serie="A" Folio="123" SubTotal="1000.00" Descuento="0.00"
  Moneda="MXN" Total="${over.total ?? '1160.00'}" TipoDeComprobante="I" MetodoPago="PUE" FormaPago="03">
  <cfdi:Emisor Rfc="${SUPPLIER_RFC}" Nombre="Café del Centro SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${OUR_RFC}" Nombre="Mi Negocio" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="50201706" NoIdentificacion="${over.codigo ?? 'CAF-001'}" Cantidad="10" ClaveUnidad="KGM" Descripcion="Café tostado" ValorUnitario="116.00" Importe="${over.importe ?? '1160.00'}"/>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.00">
    <cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${over.uuid ?? 'A1B2C3D4-0001-0002-0003-ABCDEF123456'}"/></cfdi:Complemento>
</cfdi:Comprobante>`

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveScope.mockResolvedValue({ organizationId: 'org-1', rfc: OUR_RFC })
  prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue(null)
  prismaMock.purchaseOrderInvoice.aggregate.mockResolvedValue({ _sum: { totalCents: null } } as any)
  prismaMock.purchaseOrderInvoice.create.mockImplementation(async (args: any) => ({ id: 'inv-1', uuid: 'u', lines: [], ...args.data }))
  prismaMock.supplierItemCode.findMany.mockResolvedValue([])
  prismaMock.supplierItemCode.upsert.mockResolvedValue({} as any)
})

describe('attach — el código aprendido casa aunque el importe sea otro (traducción por material)', () => {
  it('código → insumo → renglón de ESTA orden, y gana sobre el importe', async () => {
    prismaMock.purchaseOrder.findFirst.mockResolvedValue({
      id: 'po-1',
      total: 1160,
      supplierId: 'sup-1',
      supplier: { id: 'sup-1', name: 'Café', taxId: SUPPLIER_RFC },
      items: [
        // El importe del concepto (1160.00) coincide con el renglón de azúcar A PROPÓSITO:
        // sin la traducción por código, casaría con el renglón equivocado.
        { id: 'item-azucar', total: 1160, quantityOrdered: 5, rawMaterialId: 'rm-azucar', productId: null },
        { id: 'item-cafe', total: 1160, quantityOrdered: 10, rawMaterialId: 'rm-cafe', productId: null },
      ],
    } as any)
    prismaMock.supplierItemCode.findMany.mockResolvedValue([{ code: 'CAF-001', rawMaterialId: 'rm-cafe', productId: null }] as any)

    await attachInvoiceToPurchaseOrder({ venueId: VENUE_ID, purchaseOrderId: 'po-1', xml: cfdi({ total: '2320.00' }), uploadedById: 's1' })

    const lines = prismaMock.purchaseOrderInvoice.create.mock.calls[0][0].data.lines.create
    expect(lines[0]).toEqual(expect.objectContaining({ purchaseOrderItemId: 'item-cafe', rawMaterialId: 'rm-cafe' }))
  })

  it('al casar, APRENDE: upsert de SupplierItemCode con el insumo del renglón', async () => {
    prismaMock.purchaseOrder.findFirst.mockResolvedValue({
      id: 'po-1',
      total: 1160,
      supplierId: 'sup-1',
      supplier: { id: 'sup-1', name: 'Café', taxId: SUPPLIER_RFC },
      items: [{ id: 'item-cafe', total: 1160, quantityOrdered: 10, rawMaterialId: 'rm-cafe', productId: null }],
    } as any)

    await attachInvoiceToPurchaseOrder({ venueId: VENUE_ID, purchaseOrderId: 'po-1', xml: cfdi(), uploadedById: 's1' })

    expect(prismaMock.supplierItemCode.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_supplierId_code: { venueId: VENUE_ID, supplierId: 'sup-1', code: 'CAF-001' } },
        create: expect.objectContaining({ rawMaterialId: 'rm-cafe', productId: null, lastDescription: 'Café tostado' }),
      }),
    )
  })

  it('entrega parcial: con una factura previa de la orden, el veredicto SUMA — la segunda mitad queda MATCHED', async () => {
    // En una parcial, el importe del renglón (media orden) NUNCA casa por importe contra el
    // renglón completo: ahí es donde el código aprendido salva — casa por código, no por importe.
    prismaMock.purchaseOrder.findFirst.mockResolvedValue({
      id: 'po-1',
      total: 2320, // la orden completa
      supplierId: 'sup-1',
      supplier: { id: 'sup-1', name: 'Café', taxId: SUPPLIER_RFC },
      items: [{ id: 'item-cafe', total: 2320, quantityOrdered: 20, rawMaterialId: 'rm-cafe', productId: null }],
    } as any)
    prismaMock.supplierItemCode.findMany.mockResolvedValue([{ code: 'CAF-001', rawMaterialId: 'rm-cafe', productId: null }] as any)
    prismaMock.purchaseOrderInvoice.aggregate.mockResolvedValue({ _sum: { totalCents: 116000 } } as any)

    await attachInvoiceToPurchaseOrder({ venueId: VENUE_ID, purchaseOrderId: 'po-1', xml: cfdi(), uploadedById: 's1' })

    const data = prismaMock.purchaseOrderInvoice.create.mock.calls[0][0].data
    expect(data.matchStatus).toBe('MATCHED')
    expect((data.matchNotes as any).accumulatedDifferenceCents).toBe(0)
  })
})

describe('registerSupplierInvoice — la factura sin orden', () => {
  beforeEach(() => {
    prismaMock.supplier.findFirst.mockResolvedValue({ id: 'sup-1' } as any)
  })

  it('reconoce al proveedor por RFC y a los renglones por código aprendido → NO_ORDER sin pendientes', async () => {
    prismaMock.supplierItemCode.findMany.mockResolvedValue([{ code: 'CAF-001', rawMaterialId: 'rm-cafe', productId: null }] as any)

    await registerSupplierInvoice({ venueId: VENUE_ID, xml: cfdi(), uploadedById: 's1' })

    const data = prismaMock.purchaseOrderInvoice.create.mock.calls[0][0].data
    expect(data).toEqual(expect.objectContaining({ purchaseOrderId: null, supplierId: 'sup-1', matchStatus: 'NO_ORDER' }))
    expect(data.lines.create[0]).toEqual(expect.objectContaining({ rawMaterialId: 'rm-cafe', purchaseOrderItemId: null }))
    expect((data.matchNotes as any).unidentifiedLines).toBe(0)
  })

  it('proveedor no dado de alta: la factura igual se guarda, con el aviso — no se pierde evidencia fiscal', async () => {
    prismaMock.supplier.findFirst.mockResolvedValue(null)

    await registerSupplierInvoice({ venueId: VENUE_ID, xml: cfdi() })

    const data = prismaMock.purchaseOrderInvoice.create.mock.calls[0][0].data
    expect(data.supplierId).toBeNull()
    expect((data.matchNotes as any).supplierUnknown).toBe(true)
    expect((data.matchNotes as any).unidentifiedLines).toBe(1)
  })

  it('el mismo UUID no se registra dos veces', async () => {
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue({ id: 'inv-existente' } as any)
    await expect(registerSupplierInvoice({ venueId: VENUE_ID, xml: cfdi() })).rejects.toThrow(/ya está registrada/)
  })
})

describe('identifyInvoiceLine — una persona confirma, el sistema aprende', () => {
  beforeEach(() => {
    prismaMock.purchaseOrderInvoiceLine.findFirst.mockResolvedValue({
      id: 'line-1',
      supplierItemCode: 'CAF-001',
      descripcion: 'Café tostado',
      invoice: { id: 'inv-1', supplierId: 'sup-1' },
    } as any)
    prismaMock.rawMaterial.findFirst.mockResolvedValue({ id: 'rm-cafe' } as any)
    prismaMock.purchaseOrderInvoiceLine.update.mockResolvedValue({ id: 'line-1' } as any)
  })

  it('XOR estricto: ni ambos, ni ninguno', async () => {
    await expect(identifyInvoiceLine({ venueId: VENUE_ID, invoiceId: 'inv-1', lineId: 'line-1' })).rejects.toThrow(/exactamente uno/)
    await expect(
      identifyInvoiceLine({ venueId: VENUE_ID, invoiceId: 'inv-1', lineId: 'line-1', rawMaterialId: 'rm-1', productId: 'p-1' }),
    ).rejects.toThrow(/exactamente uno/)
  })

  it('el insumo debe existir EN ESTE negocio: un id ajeno no identifica nada', async () => {
    prismaMock.rawMaterial.findFirst.mockResolvedValue(null)
    await expect(identifyInvoiceLine({ venueId: VENUE_ID, invoiceId: 'inv-1', lineId: 'line-1', rawMaterialId: 'rm-ajeno' })).rejects.toThrow(
      /no existe/,
    )
    expect(prismaMock.purchaseOrderInvoiceLine.update).not.toHaveBeenCalled()
  })

  it('confirma el renglón Y aprende el código para la próxima factura', async () => {
    await identifyInvoiceLine({ venueId: VENUE_ID, invoiceId: 'inv-1', lineId: 'line-1', rawMaterialId: 'rm-cafe', actorId: 's1' })

    expect(prismaMock.purchaseOrderInvoiceLine.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { rawMaterialId: 'rm-cafe', productId: null } }),
    )
    expect(prismaMock.supplierItemCode.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_supplierId_code: { venueId: VENUE_ID, supplierId: 'sup-1', code: 'CAF-001' } },
      }),
    )
    expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'SUPPLIER_ITEM_CODE_LEARNED', staffId: 's1' }))
  })

  it('sin código del proveedor en el renglón: identifica pero NO puede aprender (nada que mapear)', async () => {
    prismaMock.purchaseOrderInvoiceLine.findFirst.mockResolvedValue({
      id: 'line-1',
      supplierItemCode: null,
      descripcion: 'Café',
      invoice: { id: 'inv-1', supplierId: 'sup-1' },
    } as any)
    await identifyInvoiceLine({ venueId: VENUE_ID, invoiceId: 'inv-1', lineId: 'line-1', rawMaterialId: 'rm-cafe' })
    expect(prismaMock.supplierItemCode.upsert).not.toHaveBeenCalled()
  })
})
