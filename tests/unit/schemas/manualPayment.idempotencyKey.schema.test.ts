/**
 * D1 (12-nov): el pago manual del panel manda su llave para que el servidor reconozca el envío repetido (la persona toca otra
 * vez tras un error de red, o el panel lo repite solo). El servicio ya deduplica por `venueId_idempotencyKey`
 * (`createManualPayment`), pero el esquema no la declaraba y `validateRequest` la tiraba: sólo el MCP la podía usar.
 */
import { createManualPaymentSchema } from '@/schemas/dashboard/manualPayment.schema'

const cuerpo = (extra: Record<string, unknown> = {}) => ({
  body: { amount: '100.00', method: 'CASH', source: 'TPV', ...extra },
})

describe('createManualPaymentSchema — llave del pago manual (D1)', () => {
  it('🔴 conserva la llave: el servicio la necesita para no registrar dos veces el mismo pago', () => {
    const parsed = createManualPaymentSchema.safeParse(cuerpo({ idempotencyKey: 'panel-pago-1234_ab' }))

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.body.idempotencyKey).toBe('panel-pago-1234_ab')
  })

  it('sin llave sigue como siempre', () => {
    const parsed = createManualPaymentSchema.safeParse(cuerpo())

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.body.idempotencyKey).toBeUndefined()
  })

  it.each(['corta', 'con espacio 12345', 'x'.repeat(65), 'ñandú-12345'])('una llave mal formada (%s) se rechaza en español', llave => {
    const parsed = createManualPaymentSchema.safeParse(cuerpo({ idempotencyKey: llave }))

    expect(parsed.success).toBe(false)
    expect(parsed.success ? '' : parsed.error.issues.map(i => i.message).join(' ')).toMatch(/llave/i)
  })
})
