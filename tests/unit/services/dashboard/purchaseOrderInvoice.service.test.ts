/**
 * Subir el CFDI del proveedor a una orden de compra.
 *
 * 🔴 El invariante que más importa: esto NUNCA toca inventario ni costos. El costo se
 * congeló al RECIBIR desde `PurchaseOrderItem.unitPrice`; una diferencia con lo facturado
 * se AVISA vía `matchStatus`. Hay una prueba dedicada a que no se escriba un solo lote.
 */
import { prismaMock } from '@tests/__helpers__/setup'

const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))

const mockResolveScope = jest.fn()
jest.mock('@/services/fiscal/chartOfAccounts.service', () => ({
  ...jest.requireActual('@/services/fiscal/chartOfAccounts.service'),
  resolveScopeOrNull: (...a: unknown[]) => mockResolveScope(...(a as [])),
}))

import { attachInvoiceToPurchaseOrder } from '@/services/dashboard/purchaseOrderInvoice.service'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'

const VENUE_ID = 'venue-1'
const ORDER_ID = 'po-1'
const OUR_RFC = 'EKU9003173C9'
const SUPPLIER_RFC = 'CACO850101AB1'

const cfdi = (over: { emisor?: string; total?: string; tipo?: string; uuid?: string } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Fecha="2026-06-10T14:30:00" Serie="A" Folio="123" SubTotal="1000.00" Descuento="0.00"
  Moneda="MXN" Total="${over.total ?? '1160.00'}" TipoDeComprobante="${over.tipo ?? 'I'}" MetodoPago="PUE" FormaPago="03">
  <cfdi:Emisor Rfc="${over.emisor ?? SUPPLIER_RFC}" Nombre="Café del Centro SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${OUR_RFC}" Nombre="Mi Negocio" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="50201706" NoIdentificacion="CAF-001" Cantidad="10" ClaveUnidad="KGM" Descripcion="Café" ValorUnitario="116.00" Importe="1160.00"/>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.00">
    <cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${over.uuid ?? 'A1B2C3D4-0001-0002-0003-ABCDEF123456'}"/></cfdi:Complemento>
</cfdi:Comprobante>`

const order = (over: Partial<any> = {}) => ({
  id: ORDER_ID,
  total: 1160,
  supplierId: 'sup-1',
  supplier: { id: 'sup-1', name: 'Café del Centro', taxId: SUPPLIER_RFC },
  items: [{ id: 'item-cafe', total: 1160, quantityOrdered: 10 }],
  ...over,
})

const run = (xml = cfdi()) => attachInvoiceToPurchaseOrder({ venueId: VENUE_ID, purchaseOrderId: ORDER_ID, xml, uploadedById: 'staff-1' })

describe('attachInvoiceToPurchaseOrder', () => {
  beforeEach(() => {
    mockResolveScope.mockReset().mockResolvedValue({ organizationId: 'org-1', rfc: OUR_RFC })
    prismaMock.purchaseOrder.findFirst.mockReset().mockResolvedValue(order() as any)
    prismaMock.purchaseOrderInvoice.findFirst.mockReset().mockResolvedValue(null)
    prismaMock.purchaseOrderInvoiceLine.findMany.mockReset().mockResolvedValue([])
    prismaMock.purchaseOrderInvoice.create.mockReset().mockResolvedValue({ id: 'inv-1', uuid: 'u', lines: [] } as any)
    prismaMock.stockBatch.create.mockReset()
    prismaMock.stockBatch.update.mockReset()
    prismaMock.inventoryMovement.create.mockReset()
    mockLogAction.mockReset()
  })

  it('🔴 no escribe un solo lote ni movimiento de inventario', async () => {
    await run(cfdi({ total: '9999.00' })) // aunque el importe no cuadre

    expect(prismaMock.stockBatch.create).not.toHaveBeenCalled()
    expect(prismaMock.stockBatch.update).not.toHaveBeenCalled()
    expect(prismaMock.inventoryMovement.create).not.toHaveBeenCalled()
  })

  it('cuando todo cuadra, guarda MATCHED', async () => {
    await run()

    expect(prismaMock.purchaseOrderInvoice.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ matchStatus: 'MATCHED' }) }),
    )
  })

  it('si el emisor no es el proveedor de la orden → SUPPLIER_MISMATCH', async () => {
    await run(cfdi({ emisor: 'XAXX010101000' }))

    expect(prismaMock.purchaseOrderInvoice.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ matchStatus: 'SUPPLIER_MISMATCH' }) }),
    )
  })

  it('si el total difiere → AMOUNT_MISMATCH', async () => {
    await run(cfdi({ total: '1500.00' }))

    expect(prismaMock.purchaseOrderInvoice.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ matchStatus: 'AMOUNT_MISMATCH' }) }),
    )
  })

  it('rechaza una nota de crédito en vez de conciliarla mal', async () => {
    // Una nota de crédito REDUCE lo que debes; tratarla como factura sumaría dos veces.
    await expect(run(cfdi({ tipo: 'E' }))).rejects.toThrow(BadRequestError)
    expect(prismaMock.purchaseOrderInvoice.create).not.toHaveBeenCalled()
  })

  it('rechaza subir dos veces la misma factura', async () => {
    prismaMock.purchaseOrderInvoice.findFirst.mockResolvedValue({ id: 'inv-0', purchaseOrderId: ORDER_ID } as any)

    await expect(run()).rejects.toThrow(ConflictError)
    expect(prismaMock.purchaseOrderInvoice.create).not.toHaveBeenCalled()
  })

  it('busca la orden acotada al negocio, nunca por id suelto', async () => {
    await run()

    expect(prismaMock.purchaseOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: ORDER_ID, venueId: VENUE_ID }) }),
    )
  })

  it('una orden de otro negocio no existe para este', async () => {
    prismaMock.purchaseOrder.findFirst.mockResolvedValue(null)

    await expect(run()).rejects.toThrow(NotFoundError)
  })

  it('sin RFC configurado, lo dice claro en vez de fallar raro', async () => {
    mockResolveScope.mockResolvedValue(null)

    await expect(run()).rejects.toThrow(/RFC/i)
  })

  it('un proveedor sin RFC capturado NO se marca como equivocado', async () => {
    // El dato falta de nuestro lado, no es culpa del proveedor. Acusarlo mandaría al
    // usuario a reclamar algo inexistente.
    prismaMock.purchaseOrder.findFirst.mockResolvedValue(order({ supplier: { id: 'sup-1', name: 'Café del Centro', taxId: null } }) as any)

    await run(cfdi({ emisor: 'XAXX010101000' }))

    expect(prismaMock.purchaseOrderInvoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          matchStatus: 'MATCHED',
          matchNotes: expect.objectContaining({ supplierUnverified: true }),
        }),
      }),
    )
  })

  it('deja rastro en la bitácora con el veredicto', async () => {
    await run()

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: VENUE_ID, action: 'PURCHASE_INVOICE_MATCHED', entity: 'PurchaseOrderInvoice' }),
    )
  })
})
