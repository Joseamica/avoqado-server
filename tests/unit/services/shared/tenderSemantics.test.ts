import { paymentCountsAsDrawerCash, paymentIsAvoqadoSettled } from '@/services/shared/tenderSemantics'

/**
 * The two predicates every closeout/settlement path must share (audit v4).
 * The legacy-equivalence cases are REGRESSION tests: rows without fundsFlow and
 * without tender snapshots must classify exactly like the historical code did,
 * or every venue's existing numbers shift the day this ships.
 */
describe('tenderSemantics', () => {
  describe('paymentCountsAsDrawerCash', () => {
    it('legacy equivalence: method CASH is drawer cash, everything else is not', () => {
      expect(paymentCountsAsDrawerCash({ method: 'CASH' })).toBe(true)
      expect(paymentCountsAsDrawerCash({ method: 'CREDIT_CARD' })).toBe(false)
      expect(paymentCountsAsDrawerCash({ method: 'BANK_TRANSFER' })).toBe(false)
      expect(paymentCountsAsDrawerCash({ method: 'OTHER' })).toBe(false)
    })

    it('tender snapshot wins over method: a cash-counting voucher (method OTHER) IS drawer cash', () => {
      expect(paymentCountsAsDrawerCash({ method: 'OTHER', tenderCountsAsCash: true })).toBe(true)
      // And an Uber Eats tender explicitly does NOT enter the drawer.
      expect(paymentCountsAsDrawerCash({ method: 'OTHER', tenderCountsAsCash: false })).toBe(false)
    })

    it('fundsFlow is the top authority when stamped', () => {
      expect(paymentCountsAsDrawerCash({ method: 'OTHER', fundsFlow: 'CASH_DRAWER' })).toBe(true)
      // Stamped flow beats a contradictory snapshot (server stamped both; flow is later authority).
      expect(paymentCountsAsDrawerCash({ method: 'CASH', fundsFlow: 'EXTERNAL_RECORDED', tenderCountsAsCash: true })).toBe(false)
    })
  })

  describe('paymentIsAvoqadoSettled', () => {
    it('legacy equivalence: everything except CASH counts as settled (incl. the known manual-transfer falsehood)', () => {
      expect(paymentIsAvoqadoSettled({ method: 'CREDIT_CARD' })).toBe(true)
      expect(paymentIsAvoqadoSettled({ method: 'BANK_TRANSFER' })).toBe(true) // falsedad histórica, preservada a propósito
      expect(paymentIsAvoqadoSettled({ method: 'CASH' })).toBe(false)
    })

    it('a custom tender (method OTHER + tenderTypeId) is NEVER Avoqado-settled, even unstamped', () => {
      expect(paymentIsAvoqadoSettled({ method: 'OTHER', tenderTypeId: 'tt-1' })).toBe(false)
    })

    it('fundsFlow is authoritative when stamped', () => {
      expect(paymentIsAvoqadoSettled({ method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' })).toBe(false)
      expect(paymentIsAvoqadoSettled({ method: 'CREDIT_CARD', fundsFlow: 'AVOQADO_PROCESSED' })).toBe(true)
      expect(paymentIsAvoqadoSettled({ method: 'OTHER', fundsFlow: 'CASH_DRAWER' })).toBe(false)
    })
  })

  describe('caso real: terminal ajena (BBVA) — Avoqado centraliza la VENTA, no el depósito', () => {
    // El negocio cobró con su terminal BBVA y lo registra en Avoqado para que la venta
    // exista (corte, inventario, reportes). Ese dinero lo deposita BBVA, no Avoqado.
    const bbva = { method: 'CREDIT_CARD', fundsFlow: 'EXTERNAL_RECORDED' as const }

    it('NO entra al saldo por depositar', () => {
      expect(paymentIsAvoqadoSettled(bbva)).toBe(false)
    })

    it('tampoco entra al cajón de efectivo (no es efectivo)', () => {
      expect(paymentCountsAsDrawerCash(bbva)).toBe(false)
    })

    it('un cobro con NUESTRA terminal sí entra al saldo', () => {
      expect(paymentIsAvoqadoSettled({ method: 'CREDIT_CARD', fundsFlow: 'AVOQADO_PROCESSED' })).toBe(true)
    })

    it('efectivo capturado a mano entra al cajón, no al saldo por depositar', () => {
      const efectivoManual = { method: 'CASH', fundsFlow: 'CASH_DRAWER' as const }
      expect(paymentCountsAsDrawerCash(efectivoManual)).toBe(true)
      expect(paymentIsAvoqadoSettled(efectivoManual)).toBe(false)
    })
  })
})
