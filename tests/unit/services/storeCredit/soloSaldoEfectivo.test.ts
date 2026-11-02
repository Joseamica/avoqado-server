/**
 * D-1 (full-testing del DASHBOARD, ruling del controlador): «Sólo saldo a favor» EFECTIVO = el interruptor guardado Y que el SERVIDOR
 * sepa dar saldo a favor (las dos llaves). Sin llaves el interruptor no restringe nada; con llaves, todo igual que antes. Una sola regla
 * para el Reembolso del POS, el Cambio, la terminal y lo que la app recibe en sus ajustes.
 */
import { soloSaldoEfectivo } from '@/services/storeCredit/soloSaldoEfectivo'

const guardadas = { code: process.env.GIFT_CARD_CODE_KEY, hmac: process.env.GIFT_CARD_HMAC_KEY }
afterEach(() => {
  process.env.GIFT_CARD_CODE_KEY = guardadas.code
  process.env.GIFT_CARD_HMAC_KEY = guardadas.hmac
})

it.each([
  [true, true, true],
  [true, false, false],
  [false, true, false],
  [null, true, false],
  [undefined, true, false],
] as const)('guardado %s, con llaves %s → %s', (guardado, conLlaves, esperado) => {
  if (!conLlaves) delete process.env.GIFT_CARD_HMAC_KEY
  expect(soloSaldoEfectivo(guardado)).toBe(esperado)
})
