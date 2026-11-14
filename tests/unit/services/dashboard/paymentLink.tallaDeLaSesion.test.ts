/**
 * Encargo e61f52 (tarjeta hz:644dc242:D4, 14-nov): tras pagar una liga por prenda, la página de éxito decía «Pago exitoso ·
 * Playera básica · $299.00» sin la talla ni el color que compró la clienta. El estado de la sesión ahora trae la talla
 * (`variant`): el nombre de la pieza que se cobró y sus valores por eje, en el orden de los ejes de la familia.
 */
import { Decimal } from '@prisma/client/runtime/library'
import { getSessionStatus } from '../../../../src/services/dashboard/paymentLink.service'
import { prismaMock } from '../../../__helpers__/setup'

const sesionPorPrenda = {
  sessionId: 'pi_talla',
  paymentId: null,
  status: 'COMPLETED',
  amount: new Decimal(299),
  currency: 'MXN',
  completedAt: new Date(),
  errorMessage: null,
  metadata: {
    items: [{ productId: 'prod-m-negro', productName: 'Playera básica · M · Negro', quantity: 1, unitPrice: 299, modifiers: [] }],
  },
  paymentLink: { shortCode: 'abc12345', redirectUrl: null, venueId: 'venue-1', productGroupId: 'grupo-1' },
}

const pagoStripe = {
  id: 'pay-1',
  receiptUrl: 'https://pay.stripe.com/receipts/x',
  cardBrand: 'VISA',
  maskedPan: '************4242',
}

describe('ligas por prenda — la talla en el estado de la sesión (e61f52)', () => {
  it('por prenda y cobrada: trae la talla con sus ejes en orden, buscada dentro del negocio y de la familia', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesionPorPrenda as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce(pagoStripe as any)
    prismaMock.product.findFirst.mockResolvedValueOnce({
      name: 'Playera básica · M · Negro',
      variantValues: [
        { option: { name: 'Color', position: 1 }, optionValue: { value: 'Negro' } },
        { option: { name: 'Talla', position: 0 }, optionValue: { value: 'M' } },
      ],
    } as any)

    const r = await getSessionStatus('abc12345', 'pi_talla')

    expect(prismaMock.product.findFirst.mock.calls[0][0]?.where).toEqual({
      id: 'prod-m-negro',
      venueId: 'venue-1',
      productGroupId: 'grupo-1',
    })
    expect(r.variant).toEqual({
      productName: 'Playera básica · M · Negro',
      values: [
        { option: 'Talla', value: 'M' },
        { option: 'Color', value: 'Negro' },
      ],
    })
    // Regresión: lo de siempre sigue igual.
    expect(r.payment).toEqual({ receiptUrl: 'https://pay.stripe.com/receipts/x', cardBrand: 'VISA', last4: '4242' })
    expect(r.amount).toEqual(new Decimal(299))
  })

  it('pendiente también la trae: la clienta ve qué talla está pagando mientras se confirma', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({ ...sesionPorPrenda, status: 'PROCESSING' } as any)
    prismaMock.product.findFirst.mockResolvedValueOnce({
      name: 'Playera básica · M · Negro',
      variantValues: [{ option: { name: 'Talla', position: 0 }, optionValue: { value: 'M' } }],
    } as any)

    const r = await getSessionStatus('abc12345', 'pi_talla')

    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled()
    expect(r.payment).toBeNull()
    expect(r.variant).toEqual({ productName: 'Playera básica · M · Negro', values: [{ option: 'Talla', value: 'M' }] })
  })

  it('si la pieza ya no existe, se queda con el nombre que se cobró (sin ejes)', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesionPorPrenda as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce(pagoStripe as any)
    prismaMock.product.findFirst.mockResolvedValueOnce(null)

    const r = await getSessionStatus('abc12345', 'pi_talla')

    expect(r.variant).toEqual({ productName: 'Playera básica · M · Negro', values: [] })
  })

  it('si leer la talla falla, el estado del pago no falla: sólo sale sin talla', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesionPorPrenda as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce(pagoStripe as any)
    prismaMock.product.findFirst.mockRejectedValueOnce(new Error('se cayó la base'))

    const r = await getSessionStatus('abc12345', 'pi_talla')

    expect(r.status).toBe('COMPLETED')
    expect(r.variant).toBeNull()
  })

  it('liga de siempre (sin familia): no busca talla y `variant` es null', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({
      ...sesionPorPrenda,
      paymentLink: { ...sesionPorPrenda.paymentLink, productGroupId: null },
    } as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce(pagoStripe as any)

    const r = await getSessionStatus('abc12345', 'pi_talla')

    expect(prismaMock.product.findFirst).not.toHaveBeenCalled()
    expect(r.variant).toBeNull()
  })

  it('por prenda pero la sesión no guardó artículo: `variant` es null', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({ ...sesionPorPrenda, metadata: {} } as any)
    prismaMock.payment.findFirst.mockResolvedValueOnce(pagoStripe as any)

    const r = await getSessionStatus('abc12345', 'pi_talla')

    expect(prismaMock.product.findFirst).not.toHaveBeenCalled()
    expect(r.variant).toBeNull()
  })

  it('una sesión de otra liga sigue rechazándose', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesionPorPrenda as any)

    await expect(getSessionStatus('otra-liga', 'pi_talla')).rejects.toThrow('Sesión no pertenece a esta liga de pago')
    expect(prismaMock.product.findFirst).not.toHaveBeenCalled()
  })
})
