/**
 * `issueCfdiForOrder` con una venta de tarjetas: responde con el motivo ANTES de cualquier otra cosa (el panel lo enseña tal cual) y
 * sin filtrar a otro negocio que esa orden existe.
 */
import { issueCfdiForOrder, MOTIVO_TARJETA_DE_REGALO, type IssueCfdiDeps } from '@/services/fiscal/cfdi.service'

const receptor = {
  rfc: 'EKU9003173C9',
  razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
  regimenFiscal: '601',
  codigoPostal: '64000',
  usoCfdi: 'G03',
}
const params = { orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }

describe('issueCfdiForOrder · tarjetas de regalo', () => {
  it('🔴 una venta de tarjetas ⇒ VALIDATION_FAILED con su motivo, sin buscar facturas ni cargar la orden', async () => {
    const deps: Partial<IssueCfdiDeps> = {
      cuentaDeTarjetasFuera: jest.fn().mockResolvedValue({ venueId: 'v1' }),
      findOrderInvoices: jest.fn(),
      findExistingCfdi: jest.fn(),
      loadOrderForCfdi: jest.fn(),
    }
    await expect(issueCfdiForOrder(params, deps)).resolves.toEqual({
      status: 'VALIDATION_FAILED',
      cfdi: null,
      reasons: [MOTIVO_TARJETA_DE_REGALO],
    })
    expect(deps.findOrderInvoices).not.toHaveBeenCalled()
    expect(deps.loadOrderForCfdi).not.toHaveBeenCalled()
  })

  it('🔴 de otro negocio ⇒ «no encontrada», sin decir que es de tarjetas', async () => {
    const deps: Partial<IssueCfdiDeps> = { cuentaDeTarjetasFuera: jest.fn().mockResolvedValue({ venueId: 'otro' }) }
    await expect(issueCfdiForOrder(params, deps)).rejects.toThrow('Order o1 not found')
  })

  it('regresión: una venta normal sigue su camino (su factura vigente se devuelve tal cual)', async () => {
    const vigente = { id: 'c1', status: 'STAMPED', venueId: 'v1', isGlobal: false, type: 'INGRESO' }
    const deps: Partial<IssueCfdiDeps> = {
      cuentaDeTarjetasFuera: jest.fn().mockResolvedValue(null),
      findOrderInvoices: jest.fn().mockResolvedValue([vigente]),
      findExistingCfdi: jest.fn(),
      loadOrderForCfdi: jest.fn(),
    }
    await expect(issueCfdiForOrder(params, deps)).resolves.toMatchObject({ status: 'STAMPED', alreadyIssued: true })
  })
})
