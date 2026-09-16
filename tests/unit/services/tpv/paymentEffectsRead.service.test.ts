/**
 * Codex R4 (P2): los motivos por los que un costo de transacción sigue pendiente son OBLIGACIONES del negocio y se muestran
 * tal cual en la cola; un motivo interno desconocido sigue saliendo como «requiere revisión». Y `TRANSACTION_COST` es un
 * tipo consultable.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { listPaymentEffects } from '@/services/tpv/paymentEffectsRead.service'

const fila = (over: Record<string, unknown>) => ({
  id: 'e1',
  venueId: 'v1',
  paymentId: 'p1',
  orderId: 'o1',
  kind: 'TRANSACTION_COST',
  status: 'PENDING',
  attempts: 1,
  nextAttemptAt: new Date(),
  leaseUntil: null,
  completedAt: null,
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
})

beforeEach(() => {
  ;(prismaMock as any).paymentEffect.findMany.mockReset()
  ;(prismaMock as any).paymentEffect.count.mockReset().mockResolvedValue(1)
})

it.each([
  'AWAITING_SETTLEMENT_CONFIGURATION',
  'AFFILIATION_PRICING_UNRESOLVED',
  'REFUND_COSTS_CONTINUE_NEXT_RUN',
  'TRANSACTION_COST_FAILED',
  // Codex R6 (i) / R7 (P2-d): sin fila financiera y snapshot de tarifa ilegible también son obligaciones con nombre.
  'VENUE_TRANSACTION_MISSING',
  'INVALID_PRICING_SNAPSHOT',
  // Codex R10-1: la captura fallida de la tarifa al cobrar también es una obligación con nombre.
  'PRICING_CAPTURE_FAILED',
])('%s se muestra tal cual: es una obligación que el negocio puede resolver', async motivo => {
  ;(prismaMock as any).paymentEffect.findMany.mockResolvedValue([fila({ lastError: motivo })])
  const r = await listPaymentEffects({ venueId: 'v1', kind: 'TRANSACTION_COST' })
  expect(r.items[0].lastError).toBe(motivo)
  expect((prismaMock as any).paymentEffect.findMany.mock.calls[0][0].where).toMatchObject({ venueId: 'v1', kind: 'TRANSACTION_COST' })
})

it('un motivo interno desconocido sigue saliendo como PAYMENT_EFFECT_REQUIRES_REVIEW', async () => {
  ;(prismaMock as any).paymentEffect.findMany.mockResolvedValue([fila({ lastError: 'TypeError: cannot read properties' })])
  const r = await listPaymentEffects({ venueId: 'v1' })
  expect(r.items[0].lastError).toBe('PAYMENT_EFFECT_REQUIRES_REVIEW')
})
