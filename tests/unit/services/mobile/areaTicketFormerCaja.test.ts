/**
 * D3 (2-nov-2026): quitarle la caja a un aparato le impide EMPEZAR cobros de vales, no CERRAR los que ya tenía.
 *
 * Codex r1 #3 y r2 (#3, nuevos #1 y #2): si el panel o el propio aparato le quitan la caja con un cobro en curso —una
 * sesión a medio pagar, o una ya PAID con un intento hermano UNKNOWN—, el servidor dejaba de dejarle consultar ese cobro y
 * nadie más podía. Un candado en `updateTerminal` no lo cerraba (carrera con la creación del cobro, y sesiones vencidas que
 * bloqueaban para siempre). La raíz: la propia terminal de la sesión puede consultarla, consultar sus intentos, soltar vales
 * y cancelarla aunque ya no sea caja; agregar vales, mantenerla viva, armar la venta y preparar un pago siguen pidiendo caja.
 */
jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))

import { checkoutTerminalMismatch, getAreaTicketCheckout, getAreaTicketPaymentAttempt } from '@/services/mobile/areaTicketV7.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const CAJA_ANTIGUA = { id: 'terminal-caja', canCheckoutAreaTickets: false }
const SESION = { terminalId: 'terminal-caja' }

describe('checkoutTerminalMismatch', () => {
  it('una caja que dejó de serlo todavía cierra su propio cobro', () => {
    expect(checkoutTerminalMismatch(CAJA_ANTIGUA, SESION, 'close')).toBe(false)
  })

  it('pero ya no lo continúa', () => {
    expect(checkoutTerminalMismatch(CAJA_ANTIGUA, SESION, 'continue')).toBe(true)
  })

  it('otra terminal no cierra ni continúa un cobro ajeno, aunque sea caja', () => {
    const otra = { id: 'terminal-otra', canCheckoutAreaTickets: true }
    expect(checkoutTerminalMismatch(otra, SESION, 'close')).toBe(true)
    expect(checkoutTerminalMismatch(otra, SESION, 'continue')).toBe(true)
  })

  it('la caja de la sesión continúa como siempre', () => {
    expect(checkoutTerminalMismatch({ id: 'terminal-caja', canCheckoutAreaTickets: true }, SESION, 'continue')).toBe(false)
  })
})

describe('consultas de una caja que dejó de serlo', () => {
  const session = {
    id: 'sesion-1',
    venueId: 'venue-tienda',
    terminalId: 'terminal-caja',
    status: 'PAID',
    paymentAttempts: [{ id: 'intento-1', status: 'UNKNOWN', amount: '120.50' }],
    tickets: [],
    order: null,
  }

  beforeEach(() => {
    prismaMock.areaTicketCheckoutSession.findFirst.mockResolvedValue(session)
    prismaMock.terminal.findFirst.mockResolvedValue({ ...CAJA_ANTIGUA, fulfillmentArea: null, scaleProfile: null })
  })

  it('consulta el intento por conciliar de su cobro ya pagado', async () => {
    const attempt = await getAreaTicketPaymentAttempt('venue-tienda', 'sesion-1', 'intento-1', 'device-caja')

    expect(attempt).toMatchObject({ id: 'intento-1', status: 'UNKNOWN', checkoutStatus: 'PAID' })
  })

  it('consulta su cobro', async () => {
    await expect(getAreaTicketCheckout('venue-tienda', 'sesion-1', 'device-caja')).resolves.toBeDefined()
  })

  it('otro aparato sigue sin poder consultarlo', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: 'terminal-otra',
      canCheckoutAreaTickets: true,
      fulfillmentArea: null,
      scaleProfile: null,
    })

    await expect(getAreaTicketCheckout('venue-tienda', 'sesion-1', 'device-otra')).rejects.toMatchObject({
      code: 'CHECKOUT_TERMINAL_MISMATCH',
    })
  })
})
