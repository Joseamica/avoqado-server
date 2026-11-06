/**
 * D4 + D6 (5-nov-2026) — la gracia de cobranza, v4.
 *
 * Founder (5-nov): primer cobro fallido después de una prueba = 4 días; quien ya pagó antes = 7; nuevo sin prueba =
 * suspensión al instante. Antes: la factura de $0 de la prueba contaba como «ya pagó» (7 días), la fecha salía del reloj
 * (reprocesar el aviso la movía) y, tras una prueba, la gracia no daba acceso porque la prueba ya había vencido. v4: el corte
 * exacto por fecha es SÓLO para los 4 días tras una prueba (`endDate` = fin de la gracia); a quien ya pagaba lo sigue cortando
 * el 4.º intento, como siempre.
 * Diseño y rondas de Codex: docs/audit/2026-11-05-acceso-durante-la-cobranza/.
 */
const mockInvoicesList = jest.fn()
const mockInvoicesRetrieve = jest.fn()
const mockSubRetrieve = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    invoices: { list: (...a: unknown[]) => mockInvoicesList(...a), retrieve: (...a: unknown[]) => mockInvoicesRetrieve(...a) },
    subscriptions: { retrieve: (...a: unknown[]) => mockSubRetrieve(...a) },
    billingPortal: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://portal.test' }) } },
  })),
)
jest.mock('@/services/access/planNotification.service', () => ({
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: 'dueno@cafe.mx', locale: 'es' }),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
import emailService from '@/services/email.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '../../__helpers__/setup'
import { handlePaymentFailure, historialDePago } from '@/services/stripe.service'

const DIA = 86_400_000
const FINALIZADA = new Date('2026-11-18T04:40:00Z') // la factura del primer cobro real se finalizó aquí
const factura = (over: Record<string, unknown> = {}) => ({
  id: 'in_1',
  status: 'open',
  created: Math.floor((FINALIZADA.getTime() - 3600_000) / 1000),
  status_transitions: { finalized_at: Math.floor(FINALIZADA.getTime() / 1000) },
  ...over,
})
const pagada = (amount_paid: number) => ({ id: `in_p${amount_paid}`, amount_paid, status: 'paid' })
const fila = (over: Record<string, unknown> = {}) => ({
  id: 'vf1',
  venueId: 'v1',
  updatedAt: new Date('2026-11-18T04:41:00Z'),
  active: true,
  suspendedAt: null,
  endDate: new Date('2026-11-18T03:38:51Z'),
  gracePeriodEndsAt: null,
  paymentFailureCount: 0,
  stripeSubscriptionId: 'sub_1',
  venue: { id: 'v1', name: 'FriedBros', slug: 'friedbros', stripeCustomerId: 'cus_1', organization: { email: 'org@x.mx' } },
  feature: { name: 'Plan Premium', code: 'PLAN_PREMIUM' },
  ...over,
})
/** `invoices.list` contesta según lo que se pide: las pagadas (historial) o las abiertas (la deuda del periodo). */
let pagadas: any[] = []
let abiertas: any[] = []
const listar = (q: any) => Promise.resolve({ data: q.status === 'paid' ? pagadas : abiertas, has_more: false })
const datos = (i = 0) => prismaMock.venueFeature.updateMany.mock.calls[i]?.[0]?.data as Record<string, any> | undefined
const INVOICE = { invoiceId: 'in_1', amountDue: 169900, currency: 'mxn' }

beforeEach(() => {
  jest.clearAllMocks()
  pagadas = []
  abiertas = [factura()]
  mockInvoicesList.mockReset().mockImplementation(listar)
  mockInvoicesRetrieve.mockReset().mockResolvedValue(factura())
  mockSubRetrieve.mockReset().mockResolvedValue({ id: 'sub_1', status: 'past_due', items: { data: [] } })
  prismaMock.venueFeature.findFirst.mockResolvedValue(fila() as never)
  prismaMock.venueFeature.updateMany.mockReset().mockResolvedValue({ count: 1 } as never)
  jest.spyOn(emailService, 'sendPaymentFailedEmail').mockResolvedValue(true)
  jest.spyOn(emailService, 'sendSubscriptionSuspendedEmail').mockResolvedValue(true)
})

describe('historialDePago — de dónde viene el negocio', () => {
  it.each([
    ['ya pagó con dinero alguna vez → RECURRENTE', [pagada(0), pagada(115884)], undefined, 'RECURRENTE'],
    ['🔴 sólo la factura de $0 de la prueba → TRAS_PRUEBA (antes contaba como «ya pagó»)', [pagada(0)], undefined, 'TRAS_PRUEBA'],
    ['ninguna factura pagada → NUEVO', [], undefined, 'NUEVO'],
    [
      'más facturas de las que se leen y ninguna con dinero → RECURRENTE (no se puede probar que nunca pagó)',
      [pagada(0)],
      true,
      'RECURRENTE',
    ],
  ])('%s', async (_c, data, has_more, esperado) => {
    mockInvoicesList.mockResolvedValue({ data, has_more })
    await expect(historialDePago('sub_1')).resolves.toBe(esperado)
    expect(mockInvoicesList).toHaveBeenCalledWith({ subscription: 'sub_1', status: 'paid', limit: 100 })
  })

  it('🔴 codex r4 #3: si Stripe no contesta, LANZA (antes daba 7 días a quien venía de una prueba; el reproceso clasifica bien)', async () => {
    mockInvoicesList.mockRejectedValue(new Error('Stripe 503'))
    await expect(historialDePago('sub_1')).rejects.toThrow('Stripe 503')
  })
})

describe('primer fallo: la gracia se ancla a la factura que falló', () => {
  it('🔴 D6: tras una prueba → 4 días desde que se FINALIZÓ la factura, y el vencimiento pasa al fin de la gracia', async () => {
    pagadas = [pagada(0)]
    await handlePaymentFailure('sub_1', 1, INVOICE)
    const fin = new Date(FINALIZADA.getTime() + 4 * DIA)
    expect(datos()).toMatchObject({ gracePeriodEndsAt: fin, endDate: fin, paymentFailureCount: 1 })
    expect(datos()?.suspendedAt).toBeUndefined()
    expect(datos()?.active).toBeUndefined()
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'PLAN_PAYMENT_GRACE_STARTED', venueId: 'v1' }))
  })

  it('REGRESIÓN: ya pagó antes → 7 días desde la finalización; su vencimiento NO se toca (lo corta el 4.º intento)', async () => {
    pagadas = [pagada(169900)]
    prismaMock.venueFeature.findFirst.mockResolvedValue(fila({ endDate: null }) as never)
    await handlePaymentFailure('sub_1', 1, INVOICE)
    expect(datos()).toMatchObject({ gracePeriodEndsAt: new Date(FINALIZADA.getTime() + 7 * DIA) })
    expect(datos()).not.toHaveProperty('endDate')
  })

  it('REGRESIÓN: nuevo sin prueba → suspensión al instante, sin gracia', async () => {
    pagadas = []
    await handlePaymentFailure('sub_1', 1, INVOICE)
    expect(datos()).toMatchObject({ gracePeriodEndsAt: null, active: false, suspendedAt: expect.any(Date) })
  })

  it('sin `finalized_at` se ancla a la creación de la factura', async () => {
    pagadas = [pagada(0)]
    mockInvoicesRetrieve.mockResolvedValue(factura({ status_transitions: {} }))
    await handlePaymentFailure('sub_1', 1, INVOICE)
    expect(datos()?.gracePeriodEndsAt).toEqual(new Date(FINALIZADA.getTime() - 3600_000 + 4 * DIA))
  })

  it('🔴 Codex D6 r2 #1: reprocesar el MISMO aviso escribe la MISMA fecha (no la recorre)', async () => {
    pagadas = [pagada(0)]
    await handlePaymentFailure('sub_1', 1, INVOICE)
    await handlePaymentFailure('sub_1', 1, INVOICE)
    expect(datos(1)?.gracePeriodEndsAt).toEqual(datos(0)?.gracePeriodEndsAt)
  })

  it.each(['paid', 'void'])(
    '🔴 aviso ATRASADO: la factura ya está «%s» y la fila no trae marcas suyas → no escribe ni manda correo',
    async status => {
      mockInvoicesRetrieve.mockResolvedValue(factura({ status }))
      await handlePaymentFailure('sub_1', 1, INVOICE)
      expect(prismaMock.venueFeature.updateMany).not.toHaveBeenCalled()
      expect(emailService.sendPaymentFailedEmail).not.toHaveBeenCalled()
    },
  )

  it('🔴 codex r5 #1: reproceso de una factura YA PAGADA que dejó su corte de 4 días → lo quita (convergente, sin «deshacer»)', async () => {
    const fin = new Date(FINALIZADA.getTime() + 4 * DIA)
    prismaMock.venueFeature.findFirst.mockResolvedValue(fila({ endDate: fin, gracePeriodEndsAt: fin, paymentFailureCount: 1 }) as never)
    mockInvoicesRetrieve.mockResolvedValue(factura({ status: 'paid' }))
    await handlePaymentFailure('sub_1', 1, INVOICE)
    expect(prismaMock.venueFeature.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'vf1', gracePeriodEndsAt: fin, endDate: fin },
      data: { gracePeriodEndsAt: null, paymentFailureCount: 0, endDate: null },
    })
    expect(emailService.sendPaymentFailedEmail).not.toHaveBeenCalled()
  })

  it('reproceso de una factura pagada con la gracia de 7 días de quien ya pagaba → quita la gracia; el vencimiento no se toca', async () => {
    const fin = new Date(FINALIZADA.getTime() + 7 * DIA)
    prismaMock.venueFeature.findFirst.mockResolvedValue(fila({ endDate: null, gracePeriodEndsAt: fin }) as never)
    mockInvoicesRetrieve.mockResolvedValue(factura({ status: 'paid' }))
    await handlePaymentFailure('sub_1', 1, INVOICE)
    const w = prismaMock.venueFeature.updateMany.mock.calls[0]?.[0] as any
    expect(w).toMatchObject({ where: { id: 'vf1', gracePeriodEndsAt: fin }, data: { gracePeriodEndsAt: null, paymentFailureCount: 0 } })
    expect(w.data).not.toHaveProperty('endDate')
  })

  it('una factura ANULADA no quita el corte (no hubo pago): no escribe', async () => {
    const fin = new Date(FINALIZADA.getTime() + 4 * DIA)
    prismaMock.venueFeature.findFirst.mockResolvedValue(fila({ endDate: fin, gracePeriodEndsAt: fin }) as never)
    mockInvoicesRetrieve.mockResolvedValue(factura({ status: 'void' }))
    await handlePaymentFailure('sub_1', 1, INVOICE)
    expect(prismaMock.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 codex r1 #7: `uncollectible` sigue siendo deuda → sí abre la gracia', async () => {
    mockInvoicesRetrieve.mockResolvedValue(factura({ status: 'uncollectible' }))
    pagadas = [pagada(169900)]
    await handlePaymentFailure('sub_1', 1, INVOICE)
    expect(datos()?.gracePeriodEndsAt).toEqual(new Date(FINALIZADA.getTime() + 7 * DIA))
  })

  it('🔴 codex r1 #1: si la factura se pagó MIENTRAS se escribía, quita su propia marca (CAS) y no manda correo', async () => {
    pagadas = [pagada(0)]
    mockInvoicesRetrieve.mockResolvedValueOnce(factura()).mockResolvedValueOnce(factura({ status: 'paid' }))
    await handlePaymentFailure('sub_1', 1, INVOICE)
    const fin = new Date(FINALIZADA.getTime() + 4 * DIA)
    const limpiar = prismaMock.venueFeature.updateMany.mock.calls[1]?.[0] as any
    expect(limpiar).toMatchObject({
      where: { id: 'vf1', gracePeriodEndsAt: fin, endDate: fin },
      data: { gracePeriodEndsAt: null, paymentFailureCount: 0, endDate: null },
    })
    expect(emailService.sendPaymentFailedEmail).not.toHaveBeenCalled()
  })

  it('si Stripe no contesta la factura, lanza (el aviso queda FAILED y se reintenta) sin escribir', async () => {
    mockInvoicesRetrieve.mockRejectedValue(new Error('Stripe 503'))
    await expect(handlePaymentFailure('sub_1', 1, INVOICE)).rejects.toThrow('Stripe 503')
    expect(prismaMock.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 codex r4 #3: si falla el historial, no escribe nada (el aviso queda FAILED y se reintenta)', async () => {
    mockInvoicesList.mockRejectedValue(new Error('Stripe 503'))
    await expect(handlePaymentFailure('sub_1', 1, INVOICE)).rejects.toThrow('Stripe 503')
    expect(prismaMock.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 codex r4 #2 / r5 #2: si falla la consulta POSTERIOR, lanza SIN deshacer (no pisa a otro reproceso); el reintento converge', async () => {
    pagadas = [pagada(0)]
    mockInvoicesRetrieve.mockResolvedValueOnce(factura()).mockRejectedValueOnce(new Error('Stripe 503'))
    await expect(handlePaymentFailure('sub_1', 1, INVOICE)).rejects.toThrow('Stripe 503')
    expect(prismaMock.venueFeature.updateMany).toHaveBeenCalledTimes(1)
    expect(emailService.sendPaymentFailedEmail).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: los intentos 2 y 3 sólo llevan el contador', async () => {
    await handlePaymentFailure('sub_1', 2, INVOICE)
    expect(datos()).toEqual({ lastPaymentAttempt: expect.any(Date), paymentFailureCount: 2 })
    expect(mockInvoicesRetrieve).not.toHaveBeenCalled()
  })
})

describe('4.º intento: como hoy, con la fecha de baja correcta', () => {
  it('🔴 codex D6 r1 #5: tras una prueba suspende y el correo dice «bloqueado desde» el fin de sus 4 días y la baja a gracia + 7', async () => {
    const fin = new Date(Date.now() - 3 * DIA)
    prismaMock.venueFeature.findFirst.mockResolvedValue(fila({ endDate: fin, gracePeriodEndsAt: fin }) as never)
    await handlePaymentFailure('sub_1', 4, INVOICE)
    expect(datos()).toMatchObject({ active: false, suspendedAt: expect.any(Date) })
    expect(emailService.sendSubscriptionSuspendedEmail).toHaveBeenCalledWith(
      'dueno@cafe.mx',
      expect.objectContaining({ suspendedAt: fin, gracePeriodEndsAt: new Date(fin.getTime() + 7 * DIA) }),
    )
  })

  it('🔴 codex r4 #4: si la gracia todavía daba acceso, el correo dice «bloqueado desde» HOY, no desde la prueba vencida', async () => {
    const prueba = new Date(Date.now() - 5 * DIA)
    prismaMock.venueFeature.findFirst.mockResolvedValue(
      fila({ endDate: prueba, gracePeriodEndsAt: new Date(Date.now() + 2 * DIA) }) as never,
    )
    const antes = Date.now()
    await handlePaymentFailure('sub_1', 4, INVOICE)
    const enviado = (emailService.sendSubscriptionSuspendedEmail as jest.Mock).mock.calls[0][1]
    expect(enviado.suspendedAt.getTime()).toBeGreaterThanOrEqual(antes)
  })

  it('REGRESIÓN: quien ya pagaba se suspende en el 4.º intento aunque le queden días de gracia (como hoy)', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue(fila({ endDate: null, gracePeriodEndsAt: new Date(Date.now() + DIA) }) as never)
    await handlePaymentFailure('sub_1', 4, INVOICE)
    expect(datos()).toMatchObject({ active: false, suspendedAt: expect.any(Date) })
  })

  it('REGRESIÓN: no suspende si Stripe ya está al corriente', async () => {
    mockSubRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active', items: { data: [] } })
    await handlePaymentFailure('sub_1', 4, INVOICE)
    expect(datos()?.suspendedAt).toBeUndefined()
  })
})
