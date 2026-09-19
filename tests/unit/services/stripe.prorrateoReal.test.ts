/**
 * 🔴 AUDITORÍA DE CODEX (2026-09-18, hallazgo #10): la vista previa de prorrateo NO calcula lo que
 * Stripe va a cobrar.
 *
 * El cálculo era a mano: `(precioNuevo − precioViejo) × fracción de periodo restante`. Ignora
 * **el cupón**, el saldo del cliente, las facturas impagadas, los cambios de intervalo y los
 * impuestos. Y la ejecución real (`updateSubscriptionPrice`, con `always_invoice`) usa otro
 * instante y la aritmética completa de Stripe.
 *
 * Ejemplo del auditor: pasar de PRO con POS22 a un producto de $500 a mitad de mes estimaría
 * ~**$329.42 de crédito** aunque ese mes el cliente pagó **$22**. La pantalla que decide un cambio
 * de plan estaría enseñando un número que nadie va a cobrar ni acreditar.
 *
 * Stripe tiene la respuesta exacta (`invoices.createPreview` con `subscription_details`): se le
 * pregunta a él. Y si no puede contestar, **se dice** — un número inventado en una pantalla de
 * dinero es peor que «no pudimos calcularlo».
 */
const mockSubRetrieve = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockInvoiceCreatePreview = jest.fn()

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: mockSubRetrieve },
    prices: { retrieve: mockPriceRetrieve },
    invoices: { createPreview: mockInvoiceCreatePreview },
  })),
)
jest.mock('../../../src/utils/prismaClient', () => ({ __esModule: true, default: {} }))

import { previewSubscriptionProration } from '@/services/stripe.service'

const AHORA = Math.floor(Date.now() / 1000)

beforeEach(() => {
  jest.clearAllMocks()
  mockSubRetrieve.mockResolvedValue({
    id: 'sub_1',
    customer: 'cus_1',
    items: { data: [{ id: 'si_1', price: { id: 'price_pro' } }] },
    current_period_start: AHORA - 15 * 86400,
    current_period_end: AHORA + 15 * 86400,
  })
  mockPriceRetrieve.mockResolvedValue({ id: 'price_pro', unit_amount: 115884, currency: 'mxn' })
})

describe('la vista previa del cambio de plan sale de Stripe, no de una resta local', () => {
  it('🔴 le PREGUNTA a Stripe cuánto va a cobrar', async () => {
    mockInvoiceCreatePreview.mockResolvedValue({ amount_due: 4200, currency: 'mxn', total: 4200 })

    await previewSubscriptionProration('sub_1', 'price_premium')

    expect(mockInvoiceCreatePreview).toHaveBeenCalled()
  })

  it('🔴 devuelve el importe de Stripe, no el de la resta de precios de lista', async () => {
    // Con el cupón vivo Stripe dice 42.00; la resta local habría dicho otra cosa completamente.
    mockInvoiceCreatePreview.mockResolvedValue({ amount_due: 4200, currency: 'mxn', total: 4200 })

    const r = await previewSubscriptionProration('sub_1', 'price_premium')

    expect(r.prorationAmount).toBe(4200)
  })

  // ⚠️ RETIRADA (19-sep). Aquí vivía una prueba que fijaba que un fallo de Stripe se DEVOLVIERA
  // como un objeto con `prorationAmount: 0`. La auditoría de riesgo de despliegue demostró que eso
  // es peor que el problema que arreglaba: para quien lee los NÚMEROS es una cotización válida de
  // cero, y confirmar el cambio sí puede cobrar. Lo correcto lo fija el último describe.
})

/**
 * 🔴 SEGUNDA AUDITORÍA DE CODEX (2026-09-18): el crédito de una BAJADA de plan se reporta como CERO.
 *
 * `amount_due` de Stripe nunca es negativo: cuando el cambio genera saldo a favor, Stripe lo clampa
 * a 0 y el crédito viaja en `total`. El código leía `amount_due ?? total ?? 0`, así que el 0 ganaba
 * siempre y la rama «Se te acredita…» era código muerto: quien baja de plan veía «Sin cargo hoy».
 */
describe('una BAJADA de plan enseña el crédito, no «sin cargo»', () => {
  it('🔴 reporta el saldo a favor cuando Stripe lo devuelve en `total` con `amount_due` en 0', async () => {
    mockInvoiceCreatePreview.mockResolvedValue({ amount_due: 0, total: -32942, currency: 'mxn' })

    const r = await previewSubscriptionProration('sub_1', 'price_barato')

    expect(r.prorationAmount).toBe(-32942)
    expect(r.description).toMatch(/acredita|favor/i)
  })

  it('🔴 y NO lo llama «sin cargo hoy», que es lo que el cliente leía', async () => {
    mockInvoiceCreatePreview.mockResolvedValue({ amount_due: 0, total: -32942, currency: 'mxn' })

    const r = await previewSubscriptionProration('sub_1', 'price_barato')

    expect(r.description).not.toMatch(/sin cargo/i)
  })
})

/**
 * 🔴 AUDITORÍA DE RIESGO DE DESPLIEGUE (Codex, 19-sep, hallazgo P2): un fallo de cotización se
 * presenta como CERO CARGO.
 *
 * Al fallar `invoices.createPreview` se devolvía un objeto **válido** con `prorationAmount: 0` e
 * `immediateCharge: false`, y el controlador responde 200. El aviso viajaba sólo en `description`,
 * que es texto: quien lee los NÚMEROS entiende «este cambio no te cuesta nada». Y no es cierto:
 * confirmar ejecuta igual `updateSubscriptionPrice` con `always_invoice`, que sí puede cobrar.
 */
describe('un fallo de Stripe NO puede parecer una cotización de cero', () => {
  it('🔴 lanza un error recuperable en vez de devolver prorationAmount 0', async () => {
    mockInvoiceCreatePreview.mockRejectedValue(new Error('Stripe caído'))

    await expect(previewSubscriptionProration('sub_1', 'price_premium')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('🔴 y el error DICE que se puede reintentar', async () => {
    mockInvoiceCreatePreview.mockRejectedValue(new Error('Stripe caído'))

    await expect(previewSubscriptionProration('sub_1', 'price_premium')).rejects.toThrow(/inténtalo|intentalo|unos minutos/i)
  })

  it('una cotización real de cero SÍ se devuelve como cero (no todo cero es un fallo)', async () => {
    mockInvoiceCreatePreview.mockResolvedValue({ amount_due: 0, total: 0, currency: 'mxn' })

    const r = await previewSubscriptionProration('sub_1', 'price_igual')

    expect(r.prorationAmount).toBe(0)
    expect(r.description).toMatch(/sin cargo/i)
  })
})

/**
 * 🔴 CUARTA AUDITORÍA (Codex xhigh, 19-sep): el espejo del defecto de ayer. Preferir `total` cuando
 * `amount_due` es 0 anuncia un CARGO QUE NO SE VA A HACER.
 *
 * Caso real: el cambio de plan genera $42.00 de ajuste (`total: 4200`) pero el cliente tiene saldo
 * a favor suficiente, así que Stripe deja `amount_due: 0` — no se le cobra nada. El código decía
 * «Hoy pagas 42.00 MXN» con `immediateCharge: true`.
 *
 * La regla correcta separa las dos cosas: **lo que se COBRA hoy es `amount_due`**; `total` sólo
 * manda cuando es un CRÉDITO (negativo), porque ahí Stripe clampa `amount_due` a 0 y el saldo a
 * favor viaja en `total`.
 */
describe('un ajuste cubierto por saldo a favor no es un cargo', () => {
  it('🔴 `amount_due: 0` con `total` POSITIVO no cobra nada hoy', async () => {
    mockInvoiceCreatePreview.mockResolvedValue({ amount_due: 0, total: 4200, currency: 'mxn' })

    const r = await previewSubscriptionProration('sub_1', 'price_premium')

    expect(r.immediateCharge).toBe(false)
    expect(r.prorationAmount).toBe(0)
  })

  it('🔴 y lo DICE: nada de «Hoy pagas 42.00»', async () => {
    mockInvoiceCreatePreview.mockResolvedValue({ amount_due: 0, total: 4200, currency: 'mxn' })

    const r = await previewSubscriptionProration('sub_1', 'price_premium')

    expect(r.description).not.toMatch(/hoy pagas/i)
    expect(r.description).toMatch(/sin cargo/i)
  })

  it('un cargo REAL sigue siendo un cargo (no se rompió el caso bueno)', async () => {
    mockInvoiceCreatePreview.mockResolvedValue({ amount_due: 4200, total: 4200, currency: 'mxn' })

    const r = await previewSubscriptionProration('sub_1', 'price_premium')

    expect(r.immediateCharge).toBe(true)
    expect(r.prorationAmount).toBe(4200)
  })
})
