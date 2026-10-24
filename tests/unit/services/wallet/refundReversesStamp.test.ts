/**
 * 🔴 El camino del REEMBOLSO tiene que revertir el sello que la venta otorgó.
 *
 * Esta prueba es ESTRUCTURAL y no de comportamiento, a propósito: `recordRefund` mueve
 * dinero real contra el procesador y montarla entera en un test unitario costaría más
 * de lo que protege. Lo que aquí importa no es el cálculo —eso ya lo cubre
 * `reverseStamp.test.ts`— sino que **el enganche exista y no pueda tumbar un
 * reembolso**. Es el mismo patrón que `attendance-shift-independence.test.ts`.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const RUTA = join(__dirname, '../../../../src/services/tpv/refund.tpv.service.ts')

describe('el reembolso revierte el sello', () => {
  const fuente = readFileSync(RUTA, 'utf8')

  it('🔴 `recordRefund` invoca la reversión del sello', () => {
    // Sin esto el cliente avanza en su cartilla por una compra que devolvió, y acaba
    // cobrando un premio que no se ganó.
    expect(fuente).toMatch(/reverseStampForOrder\s*\(/)
  })

  it('🔴 la reversión NO puede tumbar el reembolso', () => {
    // El dinero ya se devolvió al cliente cuando esto corre. Si un fallo al revertir
    // el sello propagara, el reembolso se vería fallido con el dinero ya fuera — que
    // es infinitamente peor que un sello de más.
    const idx = fuente.indexOf('reverseStampForOrder(')
    expect(idx).toBeGreaterThan(-1)

    // Los 700 caracteres previos deben contener un `try` sin un `}` de cierre de
    // bloque intermedio: la llamada vive dentro de una protección.
    const contexto = fuente.slice(Math.max(0, idx - 700), idx)
    expect(contexto).toMatch(/try\s*\{/)
    expect(fuente.slice(idx, idx + 600)).toMatch(/catch\s*\(/)
  })
})

/**
 * D1 y D4 (24-oct): los OTROS escritores de devoluciones también quitan el sello. Sin `await`: la reversa espera el candado
 * del cliente (hasta 3 × 15 s) y la devolución no puede quedarse esperándola; su error se registra y no tumba nada.
 */
describe.each([
  ['el POS, el panel y el MCP (issueRefund)', 'src/services/dashboard/refund.dashboard.service.ts'],
  ['la devolución de Uber (applyDeliveryRefund)', 'src/services/delivery-channels/core/applyDeliveryRefund.service.ts'],
  ['la compensación de Uber (reconciliación)', 'src/services/delivery-channels/core/deliveryReconciliation.service.ts'],
])('%s revierte el sello', (_quien, ruta) => {
  const fuente = readFileSync(join(__dirname, '../../../../', ruta), 'utf8')

  it('🔴 llama la reversión del sello en segundo plano, con su error atrapado', () => {
    const idx = fuente.indexOf('reverseStampForOrder(')
    expect(idx).toBeGreaterThan(-1)
    expect(fuente.slice(Math.max(0, idx - 20), idx)).not.toMatch(/await\s*$/)
    expect(fuente.slice(idx, idx + 200)).toMatch(/\.catch\(/)
  })
})
