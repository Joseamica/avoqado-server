// Ronda QA (hermanos): la regla del timbre EN DUDA, en predicado (`timbreEnDuda`) y en filtro (`DONDE_TIMBRE_EN_DUDA`), atadas.
import { DONDE_TIMBRE_EN_DUDA, textoDeTimbreEnDuda, timbreEnDuda } from '../../../../src/services/fiscal/timbreEnDuda'

const enDuda = { status: 'STAMP_FAILED', protocoloIva: 1, enviadoAt: new Date(), falloDefinitivo: false }

describe('timbreEnDuda — el predicado y el filtro dicen lo mismo', () => {
  it('control — una fila con las condiciones del filtro es «en duda»', () => {
    expect(DONDE_TIMBRE_EN_DUDA).toEqual({ status: 'STAMP_FAILED', protocoloIva: 1, enviadoAt: { not: null }, falloDefinitivo: false })
    expect(timbreEnDuda(enDuda)).toBe(true)
  })
  it.each([
    ['otro estado', { status: 'STAMPED' }],
    ['heredada (sin protocolo)', { protocoloIva: null }],
    ['nunca enviada', { enviadoAt: null }],
    ['rechazo definitivo', { falloDefinitivo: true }],
  ])('control — romper una condición (%s) la saca', (_n, cambio) => {
    expect(timbreEnDuda({ ...enDuda, ...cambio })).toBe(false)
  })
  it('🔴 el texto no dice «rechazó», dice que no hubo respuesta clara, que no se re-emita y que se consulte', () => {
    const t = textoDeTimbreEnDuda('la nota de crédito')
    expect(t).not.toMatch(/rechaz/i)
    expect(t).toMatch(/^No hubo respuesta clara del PAC: la nota de crédito/)
    expect(t).toMatch(/No la vuelvas a emitir/)
    expect(t).toMatch(/consulta su estado/i)
  })
})
