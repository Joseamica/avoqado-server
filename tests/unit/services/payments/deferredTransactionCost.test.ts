import { costoListoParaCalcular, esperaDeMarcaVencida } from '@/services/payments/deferredTransactionCost.service'

const ahora = new Date('2026-09-13T20:00:00Z')

/**
 * Codex R12-3: el costo está listo cuando el MÉTODO está acreditado — nunca por el paso del tiempo. El webhook inventa el método
 * (`methodProvisional: true`); sólo el REST de la terminal lo acredita (`methodProvisional: false`). Un Payment sin la marca (el
 * REST lo registró) está listo. El plazo sólo ESCALA la espera (`esperaDeMarcaVencida`), jamás acredita el tipo de tarjeta.
 */
describe('S2 · cuándo se calcula el costo diferido de un Payment nacido del webhook', () => {
  it('con el método provisional cerrado por el REST (`methodProvisional: false`), ya', () => {
    expect(
      costoListoParaCalcular(
        { cardBrand: null, processorData: { methodProvisional: false } },
        { deadlineAt: '2026-09-14T00:00:00Z' },
        ahora,
      ),
    ).toBe(true)
  })
  it('sin la marca (el REST registró el Payment: el método es el acreditado por la terminal), ya — con o sin plazo legible', () => {
    expect(costoListoParaCalcular({ cardBrand: 'VISA', processorData: {} }, { deadlineAt: '2026-09-14T00:00:00Z' }, ahora)).toBe(true)
    expect(costoListoParaCalcular({ cardBrand: null, processorData: {} }, { deadlineAt: 'mañana' }, ahora)).toBe(true)
    expect(costoListoParaCalcular({ cardBrand: null, processorData: null }, null, ahora)).toBe(true)
  })
  it('Codex R12-3 · una MARCA de tarjeta con el método todavía provisional NO acredita (el webhook no manda el método): todavía no', () => {
    expect(
      costoListoParaCalcular(
        { cardBrand: 'VISA', processorData: { methodProvisional: true } },
        { deadlineAt: '2026-09-14T00:00:00Z' },
        ahora,
      ),
    ).toBe(false)
  })
  it('método provisional y dentro del plazo, todavía no', () => {
    expect(
      costoListoParaCalcular(
        { cardBrand: null, processorData: { methodProvisional: true } },
        { deadlineAt: '2026-09-13T21:00:00Z' },
        ahora,
      ),
    ).toBe(false)
    expect(esperaDeMarcaVencida({ deadlineAt: '2026-09-13T21:00:00Z' }, ahora)).toBe(false)
  })
  it('Codex R12-3 · vencido el plazo TAMPOCO se calcula (el REST nunca volvió): el plazo sólo ESCALA la espera', () => {
    expect(
      costoListoParaCalcular(
        { cardBrand: null, processorData: { methodProvisional: true } },
        { deadlineAt: '2026-09-13T19:00:00Z' },
        ahora,
      ),
    ).toBe(false)
    expect(esperaDeMarcaVencida({ deadlineAt: '2026-09-13T19:00:00Z' }, ahora)).toBe(true)
  })
  it('un plazo ilegible nunca vence solo: con el método provisional se sigue esperando, sin escalar', () => {
    expect(costoListoParaCalcular({ cardBrand: null, processorData: { methodProvisional: true } }, { deadlineAt: 'mañana' }, ahora)).toBe(
      false,
    )
    expect(esperaDeMarcaVencida({ deadlineAt: 'mañana' }, ahora)).toBe(false)
    expect(esperaDeMarcaVencida(null, ahora)).toBe(false)
  })
})
