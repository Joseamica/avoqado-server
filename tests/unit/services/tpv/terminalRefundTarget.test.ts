import {
  resolveTerminalRefundTarget,
  seDevuelveEnTerminal,
  sePuedeEscogerComoDevolver,
  devolverConEfectivo,
} from '@/services/tpv/terminalRefundTarget'

const completedCardPayment = {
  id: 'pay-1',
  venueId: 'venue-1',
  status: 'COMPLETED',
  method: 'CREDIT_CARD',
  source: 'TPV',
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
      message: 'La terminal sólo puede devolver cobros con tarjeta hechos en la terminal.',
    })
  })

  it.each(['APP', 'POS', 'OTHER', 'WEB', 'QR', 'DASHBOARD_TEST', null])(
    'una tarjeta que NO pasó por la terminal (source %s) no se manda a la terminal',
    source => {
      // 🔴 Regla del founder (30-sep-2026): sólo la tarjeta presente en NUESTRA terminal se devuelve ahí.
      // Una «Tarjeta de crédito» registrada a mano, un historial importado o un cobro en línea dicen
      // CREDIT_CARD sin que la terminal tenga nada que devolver: se reembolsan como el efectivo.
      const target = resolveTerminalRefundTarget({ ...completedCardPayment, source }, 'venue-1')
      expect(target).toEqual({
        eligible: false,
        reason: 'NOT_A_CARD_PAYMENT',
        message: 'La terminal sólo puede devolver cobros con tarjeta hechos en la terminal.',
      })
    },
  )

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

describe('seDevuelveEnTerminal — ¿este cobro se devuelve en la terminal o como el efectivo?', () => {
  it.each(['CREDIT_CARD', 'DEBIT_CARD'])('%s cobrada en la terminal sí', method => {
    expect(seDevuelveEnTerminal({ method, source: 'TPV' })).toBe(true)
  })

  it.each([
    ['BANK_TRANSFER', 'OTHER'], // transferencia (Testarudo, 30-sep)
    ['OTHER', 'TPV'], // tipo de pago creado por el negocio, o «Tarjeta (terminal externa)»
    ['CASH', 'TPV'],
    ['DIGITAL_WALLET', 'APP'],
    ['CRYPTOCURRENCY', 'TPV'],
    ['CREDIT_CARD', 'APP'], // «Tarjeta de crédito» registrada a mano en el POS
    ['DEBIT_CARD', 'POS'], // historial importado
  ])('%s con source %s no: se reembolsa como el efectivo', (method, source) => {
    expect(seDevuelveEnTerminal({ method, source })).toBe(false)
  })
})

describe('sePuedeEscogerComoDevolver — ¿el cajero puede escoger con qué devolver?', () => {
  const base = {
    method: 'CASH',
    source: 'APP',
    externalSource: null,
    tenderSatFormaPago: null,
    fundsFlow: 'CASH_DRAWER',
    tenderTypeId: null,
    tenderCountsAsCash: null,
  }

  it.each([
    ['efectivo', { ...base }],
    [
      'transferencia registrada a mano (Testarudo, 30-sep)',
      {
        ...base,
        method: 'BANK_TRANSFER',
        source: 'OTHER',
        fundsFlow: 'EXTERNAL_RECORDED',
        tenderTypeId: 't-transf',
        tenderSatFormaPago: '03',
      },
    ],
    [
      'vale / método propio del negocio',
      { ...base, method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: 't-vale', tenderSatFormaPago: '08' },
    ],
    ['«Otro» del POS', { ...base, method: 'OTHER', externalSource: 'Otro', fundsFlow: 'EXTERNAL_RECORDED' }],
    // 🔴 QA en la CPad (1-oct): el cobro rápido con la «Transferencia» de fábrica no estampa `fundsFlow`, y el
    // fallback de `paymentIsAvoqadoSettled` lo contaba como dinero de Avoqado ⇒ el cajero no podía escoger.
    [
      'transferencia del cobro rápido sin fundsFlow (app)',
      { ...base, method: 'BANK_TRANSFER', source: 'OTHER', externalSource: 'Transferencia', fundsFlow: null },
    ],
    ['transferencia vieja sin fundsFlow del mostrador', { ...base, method: 'BANK_TRANSFER', source: 'POS', fundsFlow: null }],
    ['transferencia registrada en la terminal sin fundsFlow', { ...base, method: 'BANK_TRANSFER', source: 'TPV', fundsFlow: null }],
  ])('%s: sí', (_n, payment) => {
    expect(sePuedeEscogerComoDevolver(payment)).toBe(true)
  })

  it.each([
    ['tarjeta de nuestra terminal', { ...base, method: 'CREDIT_CARD', source: 'TPV', fundsFlow: 'AVOQADO_PROCESSED' }],
    [
      '«Tarjeta de crédito» registrada a mano',
      { ...base, method: 'CREDIT_CARD', source: 'APP', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: 't-tc' },
    ],
    ['débito importado', { ...base, method: 'DEBIT_CARD', source: 'POS', fundsFlow: null }],
    [
      'tarjeta escrita en minúsculas en el pago manual',
      { ...base, method: 'OTHER', externalSource: 'tarjeta bbva', fundsFlow: 'EXTERNAL_RECORDED' },
    ],
    [
      '«Tarjeta (terminal externa)» declarada en el POS',
      { ...base, method: 'OTHER', externalSource: 'Tarjeta (terminal externa)', fundsFlow: 'EXTERNAL_RECORDED' },
    ],
    [
      'método propio que es tarjeta (forma SAT 04)',
      { ...base, method: 'OTHER', tenderTypeId: 't-bbva', tenderSatFormaPago: '04', fundsFlow: 'EXTERNAL_RECORDED' },
    ],
    [
      'método propio que es débito (forma SAT 28)',
      { ...base, method: 'OTHER', tenderTypeId: 't-deb', tenderSatFormaPago: '28', fundsFlow: 'EXTERNAL_RECORDED' },
    ],
    ['cartera digital', { ...base, method: 'DIGITAL_WALLET', fundsFlow: 'AVOQADO_PROCESSED' }],
    ['cripto por la terminal', { ...base, method: 'CRYPTOCURRENCY', source: 'TPV', fundsFlow: null }],
    ['transferencia liquidada por Stripe', { ...base, method: 'BANK_TRANSFER', source: 'WEB', fundsFlow: 'AVOQADO_PROCESSED' }],
    ['SPEI viejo de liga de pago sin fundsFlow', { ...base, method: 'BANK_TRANSFER', source: 'WEB', fundsFlow: null }],
    ['cobro viejo por QR sin fundsFlow', { ...base, method: 'BANK_TRANSFER', source: 'QR', fundsFlow: null }],
    ['cobro viejo por SDK sin fundsFlow', { ...base, method: 'OTHER', source: 'SDK', fundsFlow: null }],
    [
      'pedido de plataforma de reparto',
      { ...base, method: 'OTHER', source: 'DELIVERY_PLATFORM', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: 't-uber' },
    ],
    ['cripto declarada a mano', { ...base, method: 'CRYPTOCURRENCY', source: 'DASHBOARD_TEST', fundsFlow: 'EXTERNAL_RECORDED' }],
    ['cartera digital declarada a mano', { ...base, method: 'DIGITAL_WALLET', fundsFlow: 'EXTERNAL_RECORDED' }],
  ])('%s: no', (_n, payment) => {
    expect(sePuedeEscogerComoDevolver(payment)).toBe(false)
  })
})

describe('devolverConEfectivo — lo escogido, normalizado', () => {
  const transf = {
    method: 'BANK_TRANSFER',
    source: 'OTHER',
    externalSource: null,
    tenderSatFormaPago: '03',
    fundsFlow: 'EXTERNAL_RECORDED',
    tenderTypeId: 't',
    tenderCountsAsCash: false,
  }
  it('ausente ⇒ undefined (como hoy)', () => expect(devolverConEfectivo(transf, undefined)).toBeUndefined())
  it('igual al método del cobro ⇒ undefined (por el mismo medio)', () =>
    expect(devolverConEfectivo(transf, 'BANK_TRANSFER')).toBeUndefined())
  it('otro método ⇒ ese método', () => expect(devolverConEfectivo(transf, 'CASH')).toBe('CASH'))
  it('🔴 un vale que YA cuenta como efectivo + CASH ⇒ undefined (Codex P1 #3: si no, el saldo disponible restaría $100 que nunca sumó)', () => {
    expect(devolverConEfectivo({ ...transf, method: 'OTHER', fundsFlow: 'CASH_DRAWER', tenderCountsAsCash: true }, 'CASH')).toBeUndefined()
  })
  it('una tarjeta + CASH sigue siendo CASH: la valida y la rechaza quien llama', () => {
    expect(devolverConEfectivo({ ...transf, method: 'CREDIT_CARD', fundsFlow: 'AVOQADO_PROCESSED' }, 'CASH')).toBe('CASH')
  })
})
