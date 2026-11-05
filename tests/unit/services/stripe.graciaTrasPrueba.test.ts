/**
 * D6 (5-nov-2026): la factura de $0 con la que Stripe abre una prueba contaba como «ya pagó», así que quien venía de una
 * prueba con tarjeta y fallaba su PRIMER cobro real recibía los 7 días de gracia de un cliente que ya pagaba. Decisión
 * del founder: quien viene de una prueba recibe 4 días; un cliente nuevo sin prueba se sigue suspendiendo al instante y
 * quien ya pagó antes sigue con 7.
 */
const mockInvoicesList = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    invoices: { list: (...a: unknown[]) => mockInvoicesList(...a) },
    subscriptions: { retrieve: jest.fn().mockResolvedValue({ status: 'past_due' }) },
    billingPortal: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://portal.test' }) } },
  })),
)
jest.mock('@/services/access/planNotification.service', () => ({
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: 'dueno@cafe.mx', locale: 'es' }),
}))
import emailService from '@/services/email.service'
import { prismaMock } from '../../__helpers__/setup'
import { handlePaymentFailure, historialDePago } from '@/services/stripe.service'

const DIA = 86400000
const factura = (amount_paid: number) => ({ id: `in_${amount_paid}`, amount_paid, status: 'paid' })
const fila = (over: Record<string, unknown> = {}) => ({
  id: 'vf1',
  venueId: 'v1',
  updatedAt: new Date('2026-12-05T18:00:00Z'),
  active: true,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  stripeSubscriptionId: 'sub_1',
  venue: { id: 'v1', name: 'Taqueria', slug: 'taqueria', stripeCustomerId: 'cus_1', organization: { email: 'org@x.mx' } },
  feature: { name: 'Plan Pro', code: 'PLAN_PRO' },
  ...over,
})

beforeEach(() => {
  mockInvoicesList.mockReset()
  prismaMock.venueFeature.findFirst.mockResolvedValue(fila() as never)
  prismaMock.venueFeature.updateMany.mockReset().mockResolvedValue({ count: 1 } as never)
  jest.spyOn(emailService, 'sendPaymentFailedEmail').mockResolvedValue(true)
  jest.spyOn(emailService, 'sendSubscriptionSuspendedEmail').mockResolvedValue(true)
})

describe('historialDePago', () => {
  it('busca las facturas pagadas de la suscripción', async () => {
    mockInvoicesList.mockResolvedValue({ data: [] })
    await historialDePago('sub_1')
    expect(mockInvoicesList).toHaveBeenCalledWith({ subscription: 'sub_1', status: 'paid', limit: 100 })
  })

  it.each([
    ['una factura pagada con dinero → ya pagó', [factura(0), factura(115884)], 'RECURRENTE'],
    ['🔴 sólo la factura de $0 de la prueba → viene de una prueba (NO «ya pagó»)', [factura(0)], 'TRAS_PRUEBA'],
    ['ninguna factura pagada → cliente nuevo', [], 'NUEVO'],
  ])('%s', async (_caso, facturas, esperado) => {
    mockInvoicesList.mockResolvedValue({ data: facturas })
    await expect(historialDePago('sub_1')).resolves.toBe(esperado)
  })

  it('🔴 Codex r1 #2: más facturas de las que se leen y ninguna con dinero → no se puede probar que nunca pagó: recurrente', async () => {
    mockInvoicesList.mockResolvedValue({ data: [factura(0), factura(0)], has_more: true })
    await expect(historialDePago('sub_1')).resolves.toBe('RECURRENTE')
  })

  it('si Stripe no contesta, lo seguro es tratarlo como quien ya pagó (con gracia), como antes', async () => {
    mockInvoicesList.mockRejectedValue(new Error('Stripe 503'))
    await expect(historialDePago('sub_1')).resolves.toBe('RECURRENTE')
  })
})

describe('handlePaymentFailure — primer intento fallido', () => {
  const datos = () => prismaMock.venueFeature.updateMany.mock.calls[0][0].data as Record<string, any>

  it('🔴 viene de una prueba → 4 días de gracia, sin suspender', async () => {
    mockInvoicesList.mockResolvedValue({ data: [factura(0)] })
    const antes = Date.now()
    await handlePaymentFailure('sub_1', 1)
    const d = datos()
    expect(d.suspendedAt).toBeUndefined()
    expect(d.active).toBeUndefined()
    const dias = (d.gracePeriodEndsAt.getTime() - antes) / DIA
    expect(dias).toBeGreaterThanOrEqual(3.99)
    expect(dias).toBeLessThan(4.01)
    // Codex r1 #1: el vencimiento (fin de la prueba, ya pasado) se recorre al fin de la gracia: acceso exacto 4 días.
    expect(d.endDate).toEqual(d.gracePeriodEndsAt)
  })

  it('REGRESIÓN: ya pagó antes → 7 días de gracia', async () => {
    mockInvoicesList.mockResolvedValue({ data: [factura(115884)] })
    const antes = Date.now()
    await handlePaymentFailure('sub_1', 1)
    expect((datos().gracePeriodEndsAt.getTime() - antes) / DIA).toBeGreaterThanOrEqual(6.99)
    expect(datos().suspendedAt).toBeUndefined()
    expect(datos().endDate).toBeUndefined()
  })

  it('REGRESIÓN: cliente nuevo sin prueba → se suspende al instante, sin gracia', async () => {
    mockInvoicesList.mockResolvedValue({ data: [] })
    await handlePaymentFailure('sub_1', 1)
    expect(datos()).toMatchObject({ gracePeriodEndsAt: null, active: false, suspendedAt: expect.any(Date) })
  })
})

describe('handlePaymentFailure — cuarto intento', () => {
  it('🔴 Codex r1 #5: el correo anuncia la baja 7 días después de que venció la gracia, no «hoy + 7»', async () => {
    const finDeGracia = new Date('2026-12-09T18:00:00Z')
    prismaMock.venueFeature.findFirst.mockResolvedValue(fila({ gracePeriodEndsAt: finDeGracia, endDate: finDeGracia }) as never)
    await handlePaymentFailure('sub_1', 4)
    expect(emailService.sendSubscriptionSuspendedEmail).toHaveBeenCalledWith(
      'dueno@cafe.mx',
      expect.objectContaining({ gracePeriodEndsAt: new Date(finDeGracia.getTime() + 7 * DIA) }),
    )
  })

  it('REGRESIÓN: un cliente nuevo suspendido al instante (sin gracia) recibe su correo de suspensión en el cuarto intento', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue(fila({ active: false, suspendedAt: new Date('2026-12-01T08:00:00Z') }) as never)
    await handlePaymentFailure('sub_1', 4)
    expect(emailService.sendSubscriptionSuspendedEmail).toHaveBeenCalledTimes(1)
  })
})
