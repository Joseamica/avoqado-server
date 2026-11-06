/** D6/D7: la regla de cuántos puntos se pierden (la de Square), sin base de datos. La escritura se prueba contra Postgres real. */
import { readFileSync } from 'fs'
import { join } from 'path'
import { Prisma } from '@prisma/client'
import { puntosPerdidos } from '@/services/shared/puntosAlReembolsar'

const D = (n: number) => new Prisma.Decimal(n)
const perdidos = (ganados: number, bono: number, cobrado: number, devuelto: number) =>
  puntosPerdidos({ ganados, bono, cobrado: D(cobrado), devuelto: D(devuelto) })

describe('puntosPerdidos', () => {
  it('nada devuelto: no se pierde nada', () => {
    expect(perdidos(100, 0, 100, 0)).toBe(0)
  })

  it('completo: todo, bono incluido', () => {
    expect(perdidos(110, 10, 100, 100)).toBe(110)
  })

  it('devuelto de más por redondeo: nunca más que lo ganado', () => {
    expect(perdidos(110, 10, 100, 100.01)).toBe(110)
  })

  it('parcial: redondea hacia abajo lo que se conserva', () => {
    expect(perdidos(100, 0, 100, 33.33)).toBe(34) // conserva 66.67 → 66
    expect(perdidos(100, 0, 100, 0.01)).toBe(1) // conserva 99.99 → 99
  })

  it('parcial: el bono no se toca', () => {
    expect(perdidos(110, 10, 100, 50)).toBe(50)
    expect(perdidos(10, 10, 100, 99.99)).toBe(0) // sólo bono: un parcial no baja nada
  })

  it('es exacto en múltiplos (sin el error de los flotantes)', () => {
    expect(perdidos(99, 0, 99.99, 33.33)).toBe(33)
    expect(perdidos(3, 0, 0.03, 0.01)).toBe(1)
  })

  it('crece con lo devuelto y nunca pasa de lo ganado (tres parciales)', () => {
    const pasos = [10, 20.5, 33.33, 66.67, 99.99].map(d => perdidos(100, 0, 100, d))
    expect(pasos).toEqual([...pasos].sort((a, b) => a - b))
    expect(Math.max(...pasos)).toBeLessThanOrEqual(100)
  })

  it('una venta sin cobros legibles no inventa una proporción', () => {
    expect(perdidos(100, 0, 0, 50)).toBe(0)
  })
})

/** Estructural, igual que `refundReversesStamp.test.ts`: cada escritor de reembolsos con venta encola la reversa en SU transacción. */
describe.each([
  ['la terminal (recordRefund)', 'src/services/tpv/refund.tpv.service.ts', 'enqueueRefundPaymentEffectsInTx(tx,'],
  ['el POS, el panel y el MCP (issueRefund)', 'src/services/dashboard/refund.dashboard.service.ts', 'enqueueRefundPaymentEffectsInTx(tx,'],
  ['la diferencia de un cambio', 'src/services/exchanges/exchangeTx.ts', 'enqueueRefundPaymentEffectsInTx(tx,'],
  ['la devolución de Uber', 'src/services/delivery-channels/core/applyDeliveryRefund.service.ts', 'enqueueLoyaltyPointsReversalInTx(tx,'],
  [
    'la compensación de Uber',
    'src/services/delivery-channels/core/deliveryReconciliation.service.ts',
    'enqueueLoyaltyPointsReversalInTx(tx,',
  ],
])('%s', (_quien, ruta, llamada) => {
  it('encola la reversa de puntos', () => {
    expect(readFileSync(join(__dirname, '../../../../', ruta), 'utf8')).toContain(llamada)
  })
})

it('el gancho común encola la reversa de puntos', () => {
  const fuente = readFileSync(join(__dirname, '../../../../src/services/tpv/paymentEffects.service.ts'), 'utf8')
  const gancho = fuente.slice(fuente.indexOf('export async function enqueueRefundPaymentEffectsInTx'))
  expect(gancho).toContain('enqueueLoyaltyPointsReversalInTx(tx,')
})
