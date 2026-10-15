/**
 * `issueCfdiForOrder` con una venta de tarjetas: responde con el motivo ANTES de cualquier otra cosa (el panel lo enseña tal cual) y
 * sin filtrar a otro negocio que esa orden existe.
 */
import prisma from '@/utils/prismaClient'
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

  // B3 r1 (fix 4): el default REAL de `cuentaDeTarjetasFuera` (no un doble de la dep): la forma de su consulta y lo que decide.
  describe('r1 fix 4 · el default real de cuentaDeTarjetasFuera', () => {
    const findFirst = prisma.order.findFirst as jest.Mock
    const consultaEsperada = {
      where: { id: 'o1', items: { some: { giftCardId: { not: null } } } },
      select: { venueId: true, items: { where: { giftCardId: { not: null } }, select: { id: true }, take: 1 } },
    }
    beforeEach(() => findFirst.mockReset())

    it('🔴 consulta UNA orden por id con la marca de tarjetas, y un renglón como máximo; con renglón ⇒ el motivo', async () => {
      findFirst.mockResolvedValueOnce({ venueId: 'v1', items: [{ id: 'i1' }] })
      const deps: Partial<IssueCfdiDeps> = { findOrderInvoices: jest.fn(), loadOrderForCfdi: jest.fn() }
      await expect(issueCfdiForOrder(params, deps)).resolves.toEqual({
        status: 'VALIDATION_FAILED',
        cfdi: null,
        reasons: [MOTIVO_TARJETA_DE_REGALO],
      })
      expect(findFirst).toHaveBeenCalledTimes(1)
      expect(findFirst).toHaveBeenCalledWith(consultaEsperada)
      expect(deps.findOrderInvoices).not.toHaveBeenCalled()
    })

    it('sin orden de tarjetas (null) o con una sin renglones ⇒ sigue su camino normal', async () => {
      const vigente = { id: 'c1', status: 'STAMPED', venueId: 'v1', isGlobal: false, type: 'INGRESO' }
      for (const respuesta of [null, { venueId: 'v1', items: [] }, { venueId: 'v1' }]) {
        findFirst.mockResolvedValueOnce(respuesta)
        const deps: Partial<IssueCfdiDeps> = { findOrderInvoices: jest.fn().mockResolvedValue([vigente]), loadOrderForCfdi: jest.fn() }
        await expect(issueCfdiForOrder(params, deps)).resolves.toMatchObject({ status: 'STAMPED', alreadyIssued: true })
      }
      expect(findFirst).toHaveBeenCalledTimes(3)
    })
  })
})
