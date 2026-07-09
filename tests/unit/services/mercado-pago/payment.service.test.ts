import nock from 'nock'
import { createPayment, getPayment, refundPayment } from '@/services/mercado-pago/payment.service'

// Prevent real network calls leaking from these tests
beforeAll(() => {
  // A prior nock suite in this Jest worker may have called nock.restore(); re-arm.
  if (!nock.isActive()) nock.activate()
  nock.disableNetConnect()
})
afterAll(() => {
  nock.cleanAll()
  nock.enableNetConnect()
  // Fully unpatch nock's global http interceptor so it can't leak into later
  // suites in the same Jest worker (flaky 501 / socket hang up in route tests).
  nock.restore()
})

const SELLER_TOKEN = 'APP_USR-test-seller-token'

describe('createPayment', () => {
  beforeEach(() => nock.cleanAll())

  it('POSTs /v1/payments with all required fields and application_fee in MXN', async () => {
    nock('https://api.mercadopago.com', {
      reqheaders: {
        authorization: `Bearer ${SELLER_TOKEN}`,
        'x-idempotency-key': 'idem-abc-123',
      },
    })
      .post('/v1/payments', body => {
        expect(body.token).toBe('card-token-xyz')
        expect(body.payment_method_id).toBe('visa')
        expect(body.installments).toBe(1)
        expect(body.transaction_amount).toBe(1000)
        expect(body.application_fee).toBe(50)
        expect(body.external_reference).toBe('order_42')
        expect(body.description).toBe('Sesión yoga')
        expect(body.payer.email).toBe('buyer@example.com')
        expect(body.binary_mode).toBe(false)
        return true
      })
      .reply(201, {
        id: 9999,
        status: 'approved',
        status_detail: 'accredited',
      })

    const result = await createPayment({
      accessToken: SELLER_TOKEN,
      token: 'card-token-xyz',
      paymentMethodId: 'visa',
      installments: 1,
      orderId: 'order_42',
      amountMxn: 1000,
      applicationFeeMxn: 50,
      description: 'Sesión yoga',
      payerEmail: 'buyer@example.com',
      idempotencyKey: 'idem-abc-123',
    })

    expect(result.id).toBe(9999)
    expect(result.status).toBe('approved')
    expect(result.status_detail).toBe('accredited')
  })

  it('includes issuer_id when provided', async () => {
    nock('https://api.mercadopago.com')
      .post('/v1/payments', body => {
        expect(body.issuer_id).toBe('310')
        return true
      })
      .reply(201, { id: 1, status: 'approved', status_detail: 'accredited' })

    await createPayment({
      accessToken: SELLER_TOKEN,
      token: 't',
      paymentMethodId: 'visa',
      installments: 1,
      issuerId: '310',
      orderId: 'o',
      amountMxn: 100,
      applicationFeeMxn: 5,
      description: 'x',
      payerEmail: 'b@x.com',
      idempotencyKey: 'idem-2',
    })
  })

  it('includes payer identification when provided', async () => {
    nock('https://api.mercadopago.com')
      .post('/v1/payments', body => {
        expect(body.payer.identification).toEqual({ type: 'CURP', number: 'CURP123' })
        expect(body.payer.first_name).toBe('Juan')
        expect(body.payer.last_name).toBe('Pérez')
        return true
      })
      .reply(201, { id: 2, status: 'approved', status_detail: 'accredited' })

    await createPayment({
      accessToken: SELLER_TOKEN,
      token: 't',
      paymentMethodId: 'visa',
      installments: 1,
      orderId: 'o',
      amountMxn: 100,
      applicationFeeMxn: 5,
      description: 'x',
      payerEmail: 'b@x.com',
      payerFirstName: 'Juan',
      payerLastName: 'Pérez',
      payerIdentificationType: 'CURP',
      payerIdentificationNumber: 'CURP123',
      idempotencyKey: 'idem-3',
    })
  })

  it('omits identification when payerIdentificationType is undefined', async () => {
    nock('https://api.mercadopago.com')
      .post('/v1/payments', body => {
        expect(body.payer.identification).toBeUndefined()
        return true
      })
      .reply(201, { id: 3, status: 'approved', status_detail: 'accredited' })

    await createPayment({
      accessToken: SELLER_TOKEN,
      token: 't',
      paymentMethodId: 'visa',
      installments: 1,
      orderId: 'o',
      amountMxn: 100,
      applicationFeeMxn: 5,
      description: 'x',
      payerEmail: 'b@x.com',
      idempotencyKey: 'idem-4',
    })
  })

  it('passes notification_url when provided', async () => {
    nock('https://api.mercadopago.com')
      .post('/v1/payments', body => {
        expect(body.notification_url).toBe('https://api.avoqado.io/api/v1/webhooks/mercadopago')
        return true
      })
      .reply(201, { id: 4, status: 'approved', status_detail: 'accredited' })

    await createPayment({
      accessToken: SELLER_TOKEN,
      token: 't',
      paymentMethodId: 'visa',
      installments: 1,
      orderId: 'o',
      amountMxn: 100,
      applicationFeeMxn: 5,
      description: 'x',
      payerEmail: 'b@x.com',
      idempotencyKey: 'idem-5',
      notificationUrl: 'https://api.avoqado.io/api/v1/webhooks/mercadopago',
    })
  })

  it('surfaces MP error response with status code and body', async () => {
    nock('https://api.mercadopago.com').post('/v1/payments').reply(400, { error: 'invalid_card_token', message: 'token expired' })

    await expect(
      createPayment({
        accessToken: SELLER_TOKEN,
        token: 'expired-token',
        paymentMethodId: 'visa',
        installments: 1,
        orderId: 'o',
        amountMxn: 100,
        applicationFeeMxn: 5,
        description: 'x',
        payerEmail: 'b@x.com',
        idempotencyKey: 'idem-err',
      }),
    ).rejects.toThrow(/createPayment failed: 400/i)
  })

  it('returns three_ds_redirect_url when 3DS challenge is required', async () => {
    nock('https://api.mercadopago.com').post('/v1/payments').reply(201, {
      id: 7,
      status: 'pending',
      status_detail: 'pending_challenge',
      three_ds_redirect_url: 'https://acs.bank.com/3ds-challenge?txn=abc',
    })

    const result = await createPayment({
      accessToken: SELLER_TOKEN,
      token: 't',
      paymentMethodId: 'visa',
      installments: 1,
      orderId: 'o',
      amountMxn: 100,
      applicationFeeMxn: 5,
      description: 'x',
      payerEmail: 'b@x.com',
      idempotencyKey: 'idem-3ds',
    })

    expect(result.status).toBe('pending')
    expect(result.three_ds_redirect_url).toBe('https://acs.bank.com/3ds-challenge?txn=abc')
  })
})

describe('getPayment', () => {
  beforeEach(() => nock.cleanAll())

  it('GETs /v1/payments/:id with Bearer token', async () => {
    nock('https://api.mercadopago.com', {
      reqheaders: { authorization: `Bearer ${SELLER_TOKEN}` },
    })
      .get('/v1/payments/9999')
      .reply(200, {
        id: 9999,
        status: 'approved',
        status_detail: 'accredited',
        external_reference: 'order_42',
        transaction_amount: 1000,
        currency_id: 'MXN',
        date_approved: '2026-05-20T18:00:00.000Z',
        date_created: '2026-05-20T17:55:00.000Z',
        fee_details: [{ type: 'mercadopago_fee', amount: 29, fee_payer: 'collector' }],
        application_fee: 50,
        order: { id: 7777 },
      })

    const result = await getPayment(SELLER_TOKEN, '9999')
    expect(result.id).toBe(9999)
    expect(result.status).toBe('approved')
    expect(result.external_reference).toBe('order_42')
    expect(result.transaction_amount).toBe(1000)
    expect(result.application_fee).toBe(50)
    expect(result.order?.id).toBe(7777)
  })

  it('surfaces 404 when payment does not exist', async () => {
    nock('https://api.mercadopago.com').get('/v1/payments/nope').reply(404, { error: 'not_found', message: 'Payment not found' })

    await expect(getPayment(SELLER_TOKEN, 'nope')).rejects.toThrow(/getPayment failed: 404/i)
  })
})

describe('refundPayment', () => {
  beforeEach(() => nock.cleanAll())

  it('POSTs partial refund with amount in MXN', async () => {
    nock('https://api.mercadopago.com', {
      reqheaders: {
        authorization: `Bearer ${SELLER_TOKEN}`,
        'x-idempotency-key': 'idem-refund-1',
      },
    })
      .post('/v1/payments/9999/refunds', body => {
        expect(body.amount).toBe(250)
        return true
      })
      .reply(201, {
        id: 11111,
        payment_id: 9999,
        amount: 250,
        status: 'approved',
      })

    const result = await refundPayment({
      accessToken: SELLER_TOKEN,
      paymentId: '9999',
      amount: 250,
      idempotencyKey: 'idem-refund-1',
    })

    expect(result.id).toBe(11111)
    expect(result.amount).toBe(250)
    expect(result.status).toBe('approved')
  })

  it('POSTs full refund (no amount in body) when amount is omitted', async () => {
    nock('https://api.mercadopago.com', {
      reqheaders: { 'x-idempotency-key': 'idem-refund-2' },
    })
      .post('/v1/payments/9999/refunds', body => {
        // Either empty object {} or no amount key
        expect(body.amount).toBeUndefined()
        return true
      })
      .reply(201, {
        id: 22222,
        payment_id: 9999,
        amount: 1000,
        status: 'approved',
      })

    const result = await refundPayment({
      accessToken: SELLER_TOKEN,
      paymentId: '9999',
      idempotencyKey: 'idem-refund-2',
    })

    expect(result.amount).toBe(1000)
    expect(result.status).toBe('approved')
  })

  it('surfaces MP error on refund failure', async () => {
    nock('https://api.mercadopago.com')
      .post('/v1/payments/9999/refunds')
      .reply(400, { error: 'amount_exceeds', message: 'Refund amount exceeds payment' })

    await expect(
      refundPayment({
        accessToken: SELLER_TOKEN,
        paymentId: '9999',
        amount: 999999,
        idempotencyKey: 'idem-refund-err',
      }),
    ).rejects.toThrow(/refundPayment failed: 400/i)
  })
})
