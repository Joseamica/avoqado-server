import { resolveTerminalRefundTarget } from '@/services/tpv/terminalRefundTarget'

const completedCardPayment = {
  id: 'pay-1',
  venueId: 'venue-1',
  status: 'COMPLETED',
  method: 'CREDIT_CARD',
  amount: 100,
  tipAmount: 20,
  refundedAmount: 0,
}

describe('resolveTerminalRefundTarget — ¿se puede mandar este pago a la terminal?', () => {
  it('un cobro con tarjeta completado y sin reembolsar sí se manda', () => {
    const target = resolveTerminalRefundTarget(completedCardPayment, 'venue-1')
    expect(target).toEqual({ eligible: true, remainingRefundableCents: 12000 })
  })

  it('la propina cuenta como reembolsable: el cliente pagó el total', () => {
    // 🔴 Si sólo se ofreciera el subtotal, el local se quedaría con una propina
    // de una venta que se está devolviendo.
    const target = resolveTerminalRefundTarget({ ...completedCardPayment, amount: 280.5, tipAmount: 49.5 }, 'venue-1')
    expect(target).toEqual({ eligible: true, remainingRefundableCents: 33000 })
  })

  it('un pago de OTRO venue nunca es elegible, aunque exista', () => {
    // Aislamiento por tenant: mandar a la terminal el pago de otro negocio
    // movería dinero ajeno y sería invisible para ambos.
    const target = resolveTerminalRefundTarget(completedCardPayment, 'venue-2')
    expect(target).toEqual({
      eligible: false,
      reason: 'WRONG_VENUE',
      message: 'Ese cobro no pertenece a este establecimiento.',
    })
  })

  it('un pago que no existe no se manda', () => {
    const target = resolveTerminalRefundTarget(null, 'venue-1')
    expect(target).toEqual({
      eligible: false,
      reason: 'NOT_FOUND',
      message: 'No se encontró el cobro que quieres reembolsar.',
    })
  })

  it.each(['PENDING', 'FAILED', 'PROCESSING', 'REFUNDED'])('un pago %s no se manda a la terminal', status => {
    // 🔴 Sólo un cobro COMPLETED movió dinero. Abrir la devolución de un
    // PENDING invitaría al cajero a devolver algo que nunca se cobró.
    const target = resolveTerminalRefundTarget({ ...completedCardPayment, status }, 'venue-1')
    expect(target).toEqual({
      eligible: false,
      reason: 'NOT_COMPLETED',
      message: 'Ese cobro no está completado, así que no hay nada que devolver por la terminal.',
    })
  })

  it.each(['CASH', 'OTHER', 'MERCHANT_CREDIT'])('un pago en %s no se devuelve por terminal', method => {
    // La terminal sólo sabe devolver a la tarjeta que cobró.
    const target = resolveTerminalRefundTarget({ ...completedCardPayment, method }, 'venue-1')
    expect(target).toEqual({
      eligible: false,
      reason: 'NOT_A_CARD_PAYMENT',
      message: 'La terminal sólo puede devolver cobros con tarjeta.',
    })
  })

  it('DEBIT_CARD también se manda', () => {
    const target = resolveTerminalRefundTarget({ ...completedCardPayment, method: 'DEBIT_CARD' }, 'venue-1')
    expect(target).toEqual({ eligible: true, remainingRefundableCents: 12000 })
  })

  it('un pago ya reembolsado por completo no se manda', () => {
    const target = resolveTerminalRefundTarget({ ...completedCardPayment, refundedAmount: 120 }, 'venue-1')
    expect(target).toEqual({
      eligible: false,
      reason: 'ALREADY_REFUNDED',
      message: 'Ese cobro ya se devolvió completo.',
    })
  })

  it('un reembolso parcial previo deja el resto disponible', () => {
    const target = resolveTerminalRefundTarget({ ...completedCardPayment, refundedAmount: 50 }, 'venue-1')
    expect(target).toEqual({ eligible: true, remainingRefundableCents: 7000 })
  })

  it('un reembolso previo MAYOR al cobro no deja saldo negativo', () => {
    // Defensa: un dato sucio no puede convertirse en "hay
    // algo que devolver" ni en un monto negativo viajando a la terminal.
    const target = resolveTerminalRefundTarget({ ...completedCardPayment, refundedAmount: 999 }, 'venue-1')
    expect(target).toEqual({
      eligible: false,
      reason: 'ALREADY_REFUNDED',
      message: 'Ese cobro ya se devolvió completo.',
    })
  })

  it('los centavos no se pierden por aritmética de punto flotante', () => {
    // 0.1 + 0.2 en float da 0.30000000000000004: si se multiplicara el total
    // en pesos por 100 se colaría un centavo fantasma a la terminal.
    const target = resolveTerminalRefundTarget({ ...completedCardPayment, amount: 0.1, tipAmount: 0.2, refundedAmount: 0 }, 'venue-1')
    expect(target).toEqual({ eligible: true, remainingRefundableCents: 30 })
  })
})
