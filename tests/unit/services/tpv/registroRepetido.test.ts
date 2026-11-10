import { Prisma, type Payment } from '@prisma/client'
import { planDeConsolidacion } from '@/services/tpv/registroRepetido'
import { classifyCardInternationality } from '@/services/payments/cardInternationality.service'

const existente = {
  id: 'p1',
  venueId: 'v1',
  orderId: 'o1',
  amount: new Prisma.Decimal('100'),
  tipAmount: new Prisma.Decimal('0'),
  merchantAccountId: 'm1',
  cardBrand: null,
  maskedPan: null,
  entryMode: null,
  authorizationNumber: 'AUTH-1',
  referenceNumber: 'REF-1',
  processedById: null,
  idempotencyKey: 'k1',
} as unknown as Payment

describe('S3 · plan de consolidación de un registro repetido', () => {
  it('rellena SÓLO lo vacío y nunca el dinero', () => {
    const plan = planDeConsolidacion(
      existente,
      {
        amount: 10000,
        tip: 0,
        cardBrand: 'visa',
        maskedPan: '4111******1111',
        entryMode: 'contactless',
        last4: '1111',
        authorizationNumber: 'AUTH-1',
        referenceNumber: 'REF-1',
      },
      'o1',
    )
    expect(plan.contradicciones).toEqual([])
    expect(plan.relleno).toMatchObject({
      cardBrand: 'VISA',
      maskedPan: '4111******1111',
      entryMode: 'CONTACTLESS',
      authorizationNumber: null,
      referenceNumber: null,
    })
    expect(plan.relleno.processorData).toMatchObject({ cardBrand: 'VISA', last4: '1111' })
    expect(plan.hayRelleno).toBe(true)
  })

  it('una marca o un modo que no existen en el catálogo se ignoran en vez de reventar', () => {
    const plan = planDeConsolidacion(existente, { amount: 10000, cardBrand: 'TARJETA RARA', entryMode: 'TELEPATIA' }, 'o1')
    expect(plan.contradicciones).toEqual([])
    expect(plan.relleno.cardBrand).toBeNull()
    expect(plan.relleno.entryMode).toBeNull()
  })

  it('dinero, orden y afiliación distintos son contradicciones (no se fusiona)', () => {
    const plan = planDeConsolidacion(existente, { amount: 12000, tip: 500, merchantAccountId: 'm2' }, 'o2')
    expect(plan.contradicciones.map(c => c.campo)).toEqual(['dinero', 'orderId', 'merchantAccountId'])
    expect(plan.contradicciones[0]).toEqual({ campo: 'dinero', existente: { amount: 100, tip: 0 }, entrante: { amount: 120, tip: 5 } })
  })

  it('lo ya acreditado no se pisa: una marca o un PAN distintos son contradicción, no relleno', () => {
    const acreditado = { ...existente, cardBrand: 'VISA', maskedPan: '4111******1111' } as unknown as Payment
    const plan = planDeConsolidacion(acreditado, { amount: 10000, cardBrand: 'MASTERCARD', maskedPan: '5555******4444' }, 'o1')
    expect(plan.contradicciones.map(c => c.campo)).toEqual(['cardBrand', 'maskedPan'])
    expect(plan.relleno.cardBrand).toBeNull()
  })

  it('la orden nula (venta rápida) y la afiliación ausente no descalifican', () => {
    const plan = planDeConsolidacion(existente, { amount: 10000 }, null)
    expect(plan.contradicciones).toEqual([])
    expect(plan.hayRelleno).toBe(false)
  })
})

describe('Codex R2 · N1: lo que el webhook no sabe nunca acredita', () => {
  const provisional = {
    ...existente,
    method: 'CREDIT_CARD',
    processorData: { methodProvisional: true, registradoVia: 'webhook' },
  } as unknown as Payment

  it('un entrante del WEBHOOK (método provisional inventado) no cierra la provisionalidad ni rellena el método', () => {
    const plan = planDeConsolidacion(provisional, { amount: 10000, tip: 0, method: 'CREDIT_CARD', registradoVia: 'webhook' }, 'o1')
    expect(plan.contradicciones).toEqual([])
    expect(plan.relleno.method).toBeNull()
    expect(plan.relleno.sobrescribir).toEqual({})
  })

  it('el REST de la terminal SÍ acredita el método real sobre el provisional (débito), sin contradicción', () => {
    const plan = planDeConsolidacion(provisional, { amount: 10000, tip: 0, method: 'DEBIT_CARD', isInternational: true }, 'o1')
    expect(plan.contradicciones).toEqual([])
    expect(plan.relleno.method).toBe('DEBIT_CARD')
    expect(plan.relleno.sobrescribir).toEqual({ methodProvisional: false })
    expect(plan.relleno.processorData).toMatchObject({ isInternational: true })
  })
})

describe('D3 · la terminal completa un pago nacido del aviso del banco: entra el país de la tarjeta', () => {
  const nacidoDelAviso = {
    ...existente,
    method: 'CREDIT_CARD',
    internationalityStatus: 'UNKNOWN',
    internationalitySource: 'NONE',
    issuerCountryCode: null,
    processorData: { methodProvisional: true, registradoVia: 'webhook' },
  } as unknown as Payment
  const extranjera = classifyCardInternationality({
    issuerCountryCode: '0840',
    issuerCountrySource: 'EMV_5F28',
    legacyIsInternational: false,
  })
  // Lo que llega a la consolidación: `paymentData` ya con el dato DEFINITIVO (lo fija el registrador al entrar).
  const restDeLaTerminal = {
    amount: 10000,
    tip: 0,
    method: 'CREDIT_CARD',
    isInternational: true,
    isInternationalFromTerminal: false,
    issuerCountryCode: '0840',
    issuerCountrySource: 'EMV_5F28',
    internacionalidad: extranjera,
  }

  it('rellena el dato definitivo, lo que dijo la terminal, la evidencia del país y la clasificación', () => {
    const plan = planDeConsolidacion(nacidoDelAviso, restDeLaTerminal, 'o1')
    expect(plan.contradicciones).toEqual([])
    expect(plan.relleno.processorData).toMatchObject({
      isInternational: true,
      isInternationalFromTerminal: false,
      issuerCountryEvidence: { code: '0840', source: 'EMV_5F28' },
    })
    expect(plan.relleno.internacionalidad).toMatchObject({ status: 'INTERNATIONAL', source: 'EMV_5F28', issuerCountryCode: '840' })
    expect(plan.hayRelleno).toBe(true)
    // Codex r3-4: el cobro APRENDE que es internacional ⇒ sus devoluciones de tarjeta ya registradas aprenden lo mismo.
    expect(plan.relleno.aprendeQueEsInternacional).toBe(true)
  })

  it('una terminal vieja sin país deja constancia de lo que dijo, sin inventar evidencia', () => {
    const sinPais = classifyCardInternationality({ legacyIsInternational: false })
    const plan = planDeConsolidacion(
      nacidoDelAviso,
      { amount: 10000, tip: 0, method: 'CREDIT_CARD', isInternational: false, internacionalidad: sinPais },
      'o1',
    )
    expect(plan.relleno.processorData).toMatchObject({ isInternational: false })
    expect(plan.relleno.processorData).not.toHaveProperty('issuerCountryEvidence')
    expect(plan.relleno.processorData).not.toHaveProperty('isInternationalFromTerminal')
    expect(plan.relleno.internacionalidad).toMatchObject({ status: 'UNKNOWN', source: 'LEGACY' })
  })

  it('🔴 un aviso del banco repetido (sin evidencia) nunca escribe clasificación ni el dato', () => {
    const delAviso = classifyCardInternationality({})
    const plan = planDeConsolidacion(
      nacidoDelAviso,
      { amount: 10000, tip: 0, method: 'CREDIT_CARD', registradoVia: 'webhook', internacionalidad: delAviso },
      'o1',
    )
    expect(plan.relleno.internacionalidad).toBeNull()
    expect(plan.relleno.processorData).not.toHaveProperty('isInternational')
  })

  it('una clasificación ya guardada por la terminal no se pisa (reintento del mismo registro)', () => {
    const yaClasificado = {
      ...existente,
      method: 'CREDIT_CARD',
      internationalityStatus: 'DOMESTIC',
      internationalitySource: 'EMV_5F28',
      issuerCountryCode: '484',
      processorData: { isInternational: false },
    } as unknown as Payment
    const plan = planDeConsolidacion(yaClasificado, restDeLaTerminal, 'o1')
    expect(plan.relleno.internacionalidad).toBeNull()
  })

  it('sólo se «aprende» una vez y sólo si es internacional: nacional, terminal vieja, aviso repetido o reintento no tocan las devoluciones', () => {
    const mexicana = classifyCardInternationality({
      issuerCountryCode: '0484',
      issuerCountrySource: 'EMV_5F28',
      legacyIsInternational: true,
    })
    const nacional = {
      ...restDeLaTerminal,
      isInternational: false,
      isInternationalFromTerminal: true,
      issuerCountryCode: '0484',
      internacionalidad: mexicana,
    }
    expect(planDeConsolidacion(nacidoDelAviso, nacional, 'o1').relleno.aprendeQueEsInternacional).toBe(false)
    expect(
      planDeConsolidacion(nacidoDelAviso, { amount: 10000, tip: 0, method: 'CREDIT_CARD', registradoVia: 'webhook' }, 'o1').relleno
        .aprendeQueEsInternacional,
    ).toBe(false)
    // Reintento: el cobro YA tiene el dato (aunque sea `false`): el existente gana y nada se aprende.
    for (const yaSabe of [true, false]) {
      const acreditado = { ...nacidoDelAviso, processorData: { isInternational: yaSabe } } as unknown as Payment
      expect(planDeConsolidacion(acreditado, restDeLaTerminal, 'o1').relleno.aprendeQueEsInternacional).toBe(false)
    }
  })
})
