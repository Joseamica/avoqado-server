/**
 * Reglas puras del cambio de producto (spec `docs/superpowers/specs/2026-10-20-cambio-de-producto-design.md` §4, §5.2 y §6.3):
 * el interruptor por giro, qué renglón se puede cambiar y de qué cobro sale el dinero cuando la venta tiene varios.
 */
import {
  allocateAcrossPayments,
  effectiveExchangesEnabled,
  lineBlockReason,
  modesForExchangeCreditRoot,
  payoutModesFor,
  payoutOptionsOf,
  saleBlockReason,
  type AllocationResult,
  type MoneyShape,
  type PaymentCapacity,
  type PayoutMethod,
  type PayoutMode,
  type PayoutModes,
} from '../../../../src/services/exchanges/exchangeRules'

/** Un cobro con lo que le queda por devolver y sus medios de devolución. */
const cap = (paymentId: string, saleRemainingCents: number, modes: PaymentCapacity['modes']): PaymentCapacity => ({
  paymentId,
  saleRemainingCents,
  modes,
})

/** Un cobro en efectivo del cajón; cada prueba cambia sólo lo que lo distingue. */
const money = (over: Partial<MoneyShape> = {}): MoneyShape => ({
  method: 'CASH',
  source: 'POS',
  externalSource: null,
  fundsFlow: 'CASH_DRAWER',
  tenderTypeId: null,
  tenderCountsAsCash: null,
  tenderSatFormaPago: null,
  tenderSystemKind: null,
  ...over,
})

describe('effectiveExchangesEnabled', () => {
  // Sin ajuste explícito decide el giro (spec §4): tiendas, belleza y servicios prendido; restaurantes, bares, hoteles y
  // entretenimiento apagado. Un giro desconocido queda apagado.
  it.each<[boolean | null | undefined, string | null, boolean]>([
    [null, 'CLOTHING', true],
    [null, 'SALON', true],
    [null, 'PHARMACY', true],
    [undefined, 'SPA', true],
    [null, 'RESTAURANT', false],
    [null, 'NIGHTCLUB', false],
    [null, 'HOTEL', false],
    [null, 'OTHER', false],
    [null, 'FOO', false],
    [null, null, false],
    [false, 'CLOTHING', false],
    [true, 'RESTAURANT', true],
  ])('%p + %s → %p', (setting, venueType, expected) => expect(effectiveExchangesEnabled(setting, venueType)).toBe(expected))
})

describe('lineBlockReason', () => {
  /** Un renglón de mercancía con una pieza por devolver. */
  const line = (over: Partial<Parameters<typeof lineBlockReason>[0]> = {}): Parameters<typeof lineBlockReason>[0] => ({
    productId: 'prod-1',
    productType: 'REGULAR',
    giftCardId: null,
    soldByWeight: false,
    remainingQtyOrder: 1,
    serialized: false,
    ...over,
  })

  it.each(['APPOINTMENTS_SERVICE', 'CLASS', 'EVENT', 'DIGITAL', 'DONATION', 'SERVICE'])('blocks %s as NOT_MERCHANDISE', productType =>
    expect(lineBlockReason(line({ productType }))).toBe('NOT_MERCHANDISE'),
  )

  it.each(['REGULAR', 'RETAIL', 'FOOD_AND_BEV'])('allows %s', productType => expect(lineBlockReason(line({ productType }))).toBeNull())

  it('blocks a custom line without product as NOT_MERCHANDISE', () =>
    expect(lineBlockReason(line({ productId: null, productType: null }))).toBe('NOT_MERCHANDISE'))

  it('blocks a serialized line, which has no product, as SERIALIZED_ITEM', () =>
    // Un renglón lleva producto O pieza serializada, nunca los dos: sin revisar esto antes, caería como NOT_MERCHANDISE.
    expect(lineBlockReason(line({ productId: null, productType: null, serialized: true }))).toBe('SERIALIZED_ITEM'))

  it('blocks a gift card sale line as GIFT_CARD_SALE, with or without product', () => {
    expect(lineBlockReason(line({ giftCardId: 'gc-1' }))).toBe('GIFT_CARD_SALE')
    expect(lineBlockReason(line({ giftCardId: 'gc-1', productId: null, productType: null }))).toBe('GIFT_CARD_SALE')
  })

  it('blocks a sold-by-weight line as SOLD_BY_WEIGHT', () => expect(lineBlockReason(line({ soldByWeight: true }))).toBe('SOLD_BY_WEIGHT'))

  it('blocks a line with nothing left by order as ALREADY_RETURNED', () =>
    expect(lineBlockReason(line({ remainingQtyOrder: 0 }))).toBe('ALREADY_RETURNED'))
})

describe('saleBlockReason', () => {
  /** Una venta de mostrador cobrada. */
  const sale = (over: Partial<Parameters<typeof saleBlockReason>[0]> = {}): Parameters<typeof saleBlockReason>[0] => ({
    source: 'POS',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    paymentSources: ['POS'],
    ...over,
  })

  it('UBER_EATS order or a DELIVERY_PLATFORM payment → DELIVERY_PLATFORM', () => {
    for (const source of ['UBER_EATS', 'RAPPI', 'DIDI_FOOD', 'DELIVERY_PLATFORM']) {
      expect([source, saleBlockReason(sale({ source }))]).toEqual([source, 'DELIVERY_PLATFORM'])
    }
    expect(saleBlockReason(sale({ paymentSources: ['POS', 'DELIVERY_PLATFORM'] }))).toBe('DELIVERY_PLATFORM')
  })

  it('paymentStatus PARTIAL or status CANCELLED → NOT_PAID', () => {
    expect(saleBlockReason(sale({ paymentStatus: 'PARTIAL' }))).toBe('NOT_PAID')
    expect(saleBlockReason(sale({ paymentStatus: 'PENDING' }))).toBe('NOT_PAID')
    expect(saleBlockReason(sale({ status: 'CANCELLED' }))).toBe('NOT_PAID')
    expect(saleBlockReason(sale({ status: 'DELETED' }))).toBe('NOT_PAID')
  })

  it('a paid sale has no sale-level block, even if already refunded: its lines decide', () => {
    expect(saleBlockReason(sale())).toBeNull()
    expect(saleBlockReason(sale({ paymentStatus: 'REFUNDED' }))).toBeNull()
  })
})

describe('payoutModesFor', () => {
  it('cash drawer → { CASH: SAME, BANK_TRANSFER: CHOSEN }', () =>
    expect(payoutModesFor(money())).toEqual({ CASH: 'SAME', BANK_TRANSFER: 'CHOSEN' }))

  it('card on our terminal (CREDIT_CARD, source TPV) → {}', () =>
    expect(payoutModesFor(money({ method: 'CREDIT_CARD', source: 'TPV', fundsFlow: 'AVOQADO_PROCESSED' }))).toEqual({}))

  it('manual card (CREDIT_CARD, source POS) → {}', () =>
    expect(payoutModesFor(money({ method: 'CREDIT_CARD', source: 'POS', fundsFlow: 'EXTERNAL_RECORDED' }))).toEqual({}))

  it('BANK_TRANSFER → { BANK_TRANSFER: SAME, CASH: CHOSEN }', () =>
    expect(payoutModesFor(money({ method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' }))).toEqual({
      BANK_TRANSFER: 'SAME',
      CASH: 'CHOSEN',
    }))

  it('gift card balance → { GIFT_CARD_BALANCE: SAME }', () =>
    expect(
      payoutModesFor(money({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: 'tt-gc', tenderSystemKind: 'GIFT_CARD' })),
    ).toEqual({ GIFT_CARD_BALANCE: 'SAME' }))

  it('delivery platform → {}', () =>
    expect(payoutModesFor(money({ method: 'OTHER', source: 'DELIVERY_PLATFORM', fundsFlow: 'EXTERNAL_RECORDED' }))).toEqual({}))

  it('a voucher that counts as drawer cash pays out as cash, like cash', () =>
    expect(payoutModesFor(money({ method: 'OTHER', tenderTypeId: 'tt-vale', tenderCountsAsCash: true, tenderSatFormaPago: '08' }))).toEqual(
      { CASH: 'SAME', BANK_TRANSFER: 'CHOSEN' },
    ))

  it('a venue tender recorded as card (SAT 04) → {}: never card → cash', () =>
    expect(
      payoutModesFor(money({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: 'tt-ext', tenderSatFormaPago: '04' })),
    ).toEqual({}))

  it('another venue tender that is not card → { CASH: CHOSEN, BANK_TRANSFER: CHOSEN }', () =>
    expect(
      payoutModesFor(money({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: 'tt-otro', tenderSatFormaPago: '99' })),
    ).toEqual({ CASH: 'CHOSEN', BANK_TRANSFER: 'CHOSEN' }))

  it('an EXCHANGE_CREDIT payment chooses nothing: its money leaves by the method of its root', () =>
    expect(
      payoutModesFor(
        money({
          method: 'OTHER',
          fundsFlow: 'EXTERNAL_RECORDED',
          tenderTypeId: 'tt-ec',
          tenderSatFormaPago: '17',
          tenderSystemKind: 'EXCHANGE_CREDIT',
        }),
      ),
    ).toEqual({}))
})

describe('modesForExchangeCreditRoot', () => {
  // Lo pagado con crédito de cambio sale SÓLO por el método de su cobro raíz, por Reembolso o por otro Cambio (spec §6.7):
  // nunca «Devolver con» otro medio, aunque la raíz sí lo admita.
  it.each<[string, MoneyShape, PayoutModes]>([
    ['a cash root → { CASH: SAME }', money(), { CASH: 'SAME' }],
    [
      'a transfer root → { BANK_TRANSFER: SAME }, never CASH',
      money({ method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' }),
      { BANK_TRANSFER: 'SAME' },
    ],
    [
      'a choosable «other» root → {}',
      money({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: 'tt-otro', tenderSatFormaPago: '99' }),
      {},
    ],
    [
      'a card root from our terminal keeps only its SAME entry, which today is none → {}',
      money({ method: 'CREDIT_CARD', source: 'TPV', fundsFlow: 'AVOQADO_PROCESSED' }),
      {},
    ],
    [
      'a gift card balance root → {}: that chain is not open yet',
      money({ method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: 'tt-gc', tenderSystemKind: 'GIFT_CARD' }),
      {},
    ],
  ])('%s', (_name, root, expected) => expect(modesForExchangeCreditRoot(root)).toEqual(expected))
})

describe('payoutOptionsOf', () => {
  it('adds up what each method can return and flags cash that comes from a payment of another method', () =>
    expect(
      payoutOptionsOf([
        cap('cash', 20000, { CASH: 'SAME', BANK_TRANSFER: 'CHOSEN' }),
        cap('transfer', 80000, { BANK_TRANSFER: 'SAME', CASH: 'CHOSEN' }),
        cap('gift', 5000, { GIFT_CARD_BALANCE: 'SAME' }),
        cap('card', 60000, {}),
      ]),
    ).toEqual([
      { method: 'CASH', maxCents: 100000, maxSameCents: 20000, needsRefundToCash: true },
      { method: 'BANK_TRANSFER', maxCents: 100000, maxSameCents: 80000, needsRefundToCash: false },
      { method: 'GIFT_CARD_BALANCE', maxCents: 5000, maxSameCents: 5000, needsRefundToCash: false },
    ]))

  it('maxSameCents tells the POS whether a cash difference needs refund-to-cash', () => {
    // Efectivo 200 + transferencia 800: hasta 200 sale del cajón por el mismo medio; un centavo más ya es efectivo sobre la
    // transferencia y necesita `payments:refund-to-cash`.
    const caps = [
      cap('cash', 20000, { CASH: 'SAME', BANK_TRANSFER: 'CHOSEN' }),
      cap('transfer', 80000, { BANK_TRANSFER: 'SAME', CASH: 'CHOSEN' }),
    ]
    expect(payoutOptionsOf(caps)[0]).toEqual({ method: 'CASH', maxCents: 100000, maxSameCents: 20000, needsRefundToCash: true })
    expect(allocateAcrossPayments(caps, 0, { method: 'CASH', cents: 20000 })).toMatchObject({ ok: true, needsRefundToCash: false })
    expect(allocateAcrossPayments(caps, 0, { method: 'CASH', cents: 20001 })).toMatchObject({ ok: true, needsRefundToCash: true })
  })

  it('a method whose payments have nothing left is not offered', () =>
    expect(payoutOptionsOf([cap('card', 60000, {}), cap('cash', 0, { CASH: 'SAME' })])).toEqual([]))
})

describe('allocateAcrossPayments (RF2)', () => {
  const cash = cap('cash', 40000, { CASH: 'SAME', BANK_TRANSFER: 'CHOSEN' })
  const card = cap('card', 60000, {})

  it('cash 400 + card 600, payout CASH 700 → INSUFFICIENT_FOR_METHOD with CASH max 40000', () => {
    expect(allocateAcrossPayments([cash, card], 30000, { method: 'CASH', cents: 70000 })).toEqual({
      ok: false,
      reason: 'INSUFFICIENT_FOR_METHOD',
      payoutOptions: [
        { method: 'CASH', maxCents: 40000, maxSameCents: 40000, needsRefundToCash: false },
        { method: 'BANK_TRANSFER', maxCents: 40000, maxSameCents: 0, needsRefundToCash: false },
      ],
    })
  })

  it('cash 400 + card 600, credit 700 + payout CASH 300 → payout from cash, credit from cash 100 + card 600', () => {
    expect(allocateAcrossPayments([cash, card], 70000, { method: 'CASH', cents: 30000 })).toEqual({
      ok: true,
      needsRefundToCash: false,
      slices: [
        { paymentId: 'cash', cents: 30000, role: 'PAYOUT', mode: 'SAME' },
        { paymentId: 'cash', cents: 10000, role: 'CREDIT', mode: null },
        { paymentId: 'card', cents: 60000, role: 'CREDIT', mode: null },
      ],
    })
  })

  it('no slice ever exceeds its payment remaining (property over random inputs)', () => {
    // mulberry32 con semilla fija (como `libroDeLaOrden.test.ts`): un fallo se reproduce igual y se imprime el caso.
    let state = 20261021
    const rand = (n: number) => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
    }
    const methods: PayoutMethod[] = ['CASH', 'BANK_TRANSFER', 'GIFT_CARD_BALANCE']
    const modes: Array<PayoutMode | null> = [null, 'SAME', 'CHOSEN']
    const failures: string[] = []
    for (let i = 0; i < 5000 && failures.length < 5; i++) {
      const caps = Array.from({ length: 1 + rand(4) }, (_, j) => {
        const byMethod: PaymentCapacity['modes'] = {}
        for (const method of methods) {
          const mode = modes[rand(3)]
          if (mode) byMethod[method] = mode
        }
        // Alguno sin nada por devolver y alguno devuelto de más (dato viejo), además de los normales.
        const kind = rand(10)
        return cap(`p${j}`, kind === 0 ? 0 : kind === 1 ? -300 : rand(60001), byMethod)
      })
      const credit = rand(3) === 0 ? 0 : rand(120001)
      const payout = rand(3) === 0 ? null : { method: methods[rand(3)], cents: rand(80001) }
      const result = allocateAcrossPayments(caps, credit, payout)
      const problem = allocationViolation(caps, credit, payout, result)
      if (problem) failures.push(`${problem} ← ${JSON.stringify({ caps, credit, payout, result })}`)
    }
    expect(failures).toEqual([])
  })

  it('cash 200 + transfer 800, payout CASH 500 → SAME 200 first, then CHOSEN 300, needsRefundToCash true', () => {
    const cash200 = cap('cash', 20000, { CASH: 'SAME', BANK_TRANSFER: 'CHOSEN' })
    const transfer = cap('transfer', 80000, { BANK_TRANSFER: 'SAME', CASH: 'CHOSEN' })
    const expected: AllocationResult = {
      ok: true,
      needsRefundToCash: true,
      slices: [
        { paymentId: 'cash', cents: 20000, role: 'PAYOUT', mode: 'SAME' },
        { paymentId: 'transfer', cents: 30000, role: 'PAYOUT', mode: 'CHOSEN' },
      ],
    }
    expect(allocateAcrossPayments([cash200, transfer], 0, { method: 'CASH', cents: 50000 })).toEqual(expected)
    // El mismo medio va primero aunque el otro cobro venga antes en la lista.
    expect(allocateAcrossPayments([transfer, cash200], 0, { method: 'CASH', cents: 50000 })).toEqual(expected)
  })

  it('a tie within SAME keeps the input order: [cash1 300, cash2 300], payout CASH 400 → cash1 300, cash2 100', () => {
    const cash1 = cap('cash1', 30000, { CASH: 'SAME' })
    const cash2 = cap('cash2', 30000, { CASH: 'SAME' })
    expect(allocateAcrossPayments([cash1, cash2], 0, { method: 'CASH', cents: 40000 })).toEqual({
      ok: true,
      needsRefundToCash: false,
      slices: [
        { paymentId: 'cash1', cents: 30000, role: 'PAYOUT', mode: 'SAME' },
        { paymentId: 'cash2', cents: 10000, role: 'PAYOUT', mode: 'SAME' },
      ],
    })
    // Al revés en la lista, al revés en el reparto: manda el orden de entrada, no el id.
    expect(allocateAcrossPayments([cash2, cash1], 0, { method: 'CASH', cents: 40000 })).toEqual({
      ok: true,
      needsRefundToCash: false,
      slices: [
        { paymentId: 'cash2', cents: 30000, role: 'PAYOUT', mode: 'SAME' },
        { paymentId: 'cash1', cents: 10000, role: 'PAYOUT', mode: 'SAME' },
      ],
    })
  })

  it('a tie within CHOSEN keeps the input order: [transfer1 300, transfer2 300], payout CASH 400 → transfer1 300, transfer2 100', () => {
    const transfer1 = cap('transfer1', 30000, { BANK_TRANSFER: 'SAME', CASH: 'CHOSEN' })
    const transfer2 = cap('transfer2', 30000, { BANK_TRANSFER: 'SAME', CASH: 'CHOSEN' })
    expect(allocateAcrossPayments([transfer1, transfer2], 0, { method: 'CASH', cents: 40000 })).toEqual({
      ok: true,
      needsRefundToCash: true,
      slices: [
        { paymentId: 'transfer1', cents: 30000, role: 'PAYOUT', mode: 'CHOSEN' },
        { paymentId: 'transfer2', cents: 10000, role: 'PAYOUT', mode: 'CHOSEN' },
      ],
    })
    expect(allocateAcrossPayments([transfer2, transfer1], 0, { method: 'CASH', cents: 40000 })).toEqual({
      ok: true,
      needsRefundToCash: true,
      slices: [
        { paymentId: 'transfer2', cents: 30000, role: 'PAYOUT', mode: 'CHOSEN' },
        { paymentId: 'transfer1', cents: 10000, role: 'PAYOUT', mode: 'CHOSEN' },
      ],
    })
  })

  it('credit larger than everything left → NOTHING_LEFT_TO_REFUND', () => {
    const options = [
      { method: 'CASH', maxCents: 40000, maxSameCents: 40000, needsRefundToCash: false },
      { method: 'BANK_TRANSFER', maxCents: 40000, maxSameCents: 0, needsRefundToCash: false },
    ]
    expect(allocateAcrossPayments([cash, card], 100001, null)).toEqual({
      ok: false,
      reason: 'NOTHING_LEFT_TO_REFUND',
      payoutOptions: options,
    })
    // La diferencia sí cabe en el efectivo, pero diferencia + crédito pasan de lo que le queda a la venta.
    expect(allocateAcrossPayments([cash, card], 60001, { method: 'CASH', cents: 40000 })).toEqual({
      ok: false,
      reason: 'NOTHING_LEFT_TO_REFUND',
      payoutOptions: options,
    })
  })

  it('keeps the input order: the opened payment first', () => {
    // Quien llama ordena: el cobro desde el que se abrió y luego los demás por createdAt e id.
    expect(allocateAcrossPayments([card, cash], 70000, null)).toEqual({
      ok: true,
      needsRefundToCash: false,
      slices: [
        { paymentId: 'card', cents: 60000, role: 'CREDIT', mode: null },
        { paymentId: 'cash', cents: 10000, role: 'CREDIT', mode: null },
      ],
    })
    expect(allocateAcrossPayments([cash, card], 70000, null)).toEqual({
      ok: true,
      needsRefundToCash: false,
      slices: [
        { paymentId: 'cash', cents: 40000, role: 'CREDIT', mode: null },
        { paymentId: 'card', cents: 30000, role: 'CREDIT', mode: null },
      ],
    })
  })

  it('a payment refunded beyond its amount (old data) lends nothing', () =>
    expect(allocateAcrossPayments([cap('old', -500, { CASH: 'SAME' }), cash], 100, null)).toEqual({
      ok: true,
      needsRefundToCash: false,
      slices: [{ paymentId: 'cash', cents: 100, role: 'CREDIT', mode: null }],
    }))

  it('rejects cents that are not safe integers ≥ 0', () => {
    expect(() => allocateAcrossPayments([cash], -1, null)).toThrow('EXCHANGE_INVALID_CENTS')
    expect(() => allocateAcrossPayments([cash], 0, { method: 'CASH', cents: 0.5 })).toThrow('EXCHANGE_INVALID_CENTS')
    expect(() => allocateAcrossPayments([cap('x', 100.5, {})], 0, null)).toThrow('EXCHANGE_INVALID_CENTS')
  })
})

/**
 * La primera regla del reparto entre cobros (spec §6.3) que rompe un resultado, o null: el oráculo de la prueba con datos al azar.
 * Se acepta sólo lo que cabe (diferencia ≤ lo de los cobros que admiten ese medio y diferencia + crédito ≤ lo que le queda a la
 * venta); ningún cobro da más de lo que le queda; el mismo medio se agota antes de escoger otro; el aviso de efectivo sale de un
 * pedazo CHOSEN; y `maxSameCents` del detalle predice ese aviso, para que el POS sepa antes si pedirá el permiso.
 */
function allocationViolation(
  caps: PaymentCapacity[],
  credit: number,
  payout: { method: PayoutMethod; cents: number } | null,
  result: AllocationResult,
): string | null {
  const left = new Map(caps.map(c => [c.paymentId, Math.max(0, c.saleRemainingCents)]))
  const total = [...left.values()].reduce((sum, cents) => sum + cents, 0)
  const payoutCents = payout?.cents ?? 0
  const eligible = caps.filter(c => payout && c.modes[payout.method]).reduce((sum, c) => sum + left.get(c.paymentId)!, 0)
  const feasible = credit + payoutCents <= total && payoutCents <= eligible
  if (!result.ok) {
    if (feasible) return 'rejected a request that fits'
    const reason = credit + payoutCents > total ? 'NOTHING_LEFT_TO_REFUND' : 'INSUFFICIENT_FOR_METHOD'
    if (result.reason !== reason) return `reason ${result.reason}, expected ${reason}`
    return JSON.stringify(result.payoutOptions) === JSON.stringify(payoutOptionsOf(caps)) ? null : 'payoutOptions differ'
  }
  if (!feasible) return 'accepted a request that does not fit'
  const byRole = (role: 'PAYOUT' | 'CREDIT') => result.slices.filter(s => s.role === role).reduce((sum, s) => sum + s.cents, 0)
  if (byRole('PAYOUT') !== payoutCents || byRole('CREDIT') !== credit) return 'slices do not add up'
  const paidOutBy = new Map<string, number>()
  for (const s of result.slices) {
    if (!Number.isSafeInteger(s.cents) || s.cents <= 0) return `a slice of ${s.cents} cents`
    left.set(s.paymentId, left.get(s.paymentId)! - s.cents)
    if (left.get(s.paymentId)! < 0) return `${s.paymentId} gives more than it has left`
    const mode = s.role === 'PAYOUT' && payout ? caps.find(c => c.paymentId === s.paymentId)!.modes[payout.method] : undefined
    if (s.role === 'PAYOUT' ? !mode || s.mode !== mode : s.mode !== null) return `slice mode ${s.mode} on ${s.paymentId}`
    if (s.role === 'PAYOUT') paidOutBy.set(s.paymentId, (paidOutBy.get(s.paymentId) ?? 0) + s.cents)
  }
  const choseOther = result.slices.some(s => s.role === 'PAYOUT' && s.mode === 'CHOSEN')
  const sameLeft = caps.some(
    c => payout && c.modes[payout.method] === 'SAME' && (paidOutBy.get(c.paymentId) ?? 0) < Math.max(0, c.saleRemainingCents),
  )
  if (choseOther && sameLeft) return 'chose another method before using up the same method'
  if (result.needsRefundToCash !== (payout?.method === 'CASH' && choseOther)) return 'needsRefundToCash is wrong'
  const maxSameCash = payoutOptionsOf(caps).find(o => o.method === 'CASH')?.maxSameCents ?? 0
  if (payout?.method === 'CASH' && result.needsRefundToCash !== payout.cents > maxSameCash) {
    return 'maxSameCents does not predict needsRefundToCash'
  }
  return null
}
