import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import {
  parseHttpOperation,
  manifestSchema,
  envelopeSchema,
  HTTP_MAX_BYTES,
  fingerprint,
  serializeEnvelope,
  isReceiptKeyCollision,
  type HttpEnvelope,
  type HttpManifest,
} from '@/services/mobile/http-operation.mobile.service'

const ID = '00000000-0000-4000-8000-000000000001'
const DEVICE = '00000000-0000-4000-8000-000000000002'
const token = { version: 1, id: ID, deviceId: DEVICE }
const manifest: HttpManifest = {
  action: 'removeServiceCharge',
  refs: { orderId: 'order-1', orderServiceChargeId: 'charge-1' },
  payload: {},
}
const receipt = (): Extract<HttpEnvelope, { action: 'removeServiceCharge' }> => ({
  protocol: 'HTTP_OP_V1',
  action: manifest.action,
  request: {
    originalActorId: 'staff-1',
    deviceId: DEVICE,
    refs: { ...manifest.refs },
    payloadHash: fingerprint(manifest),
  },
  outcome: 'APPLIED',
  originalResponse: {
    status: 200,
    body: {
      success: true,
      data: { subtotal: 100, discountAmount: 0, serviceChargeAmount: 0, total: 100, version: 2 },
    },
  },
  affectedRefs: [
    { kind: 'Order', id: 'order-1' },
    { kind: 'OrderServiceCharge', id: 'charge-1' },
  ],
})
const p2002 = (meta: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test', meta })

describe('HTTP operation boundary and receipt', () => {
  it('optional metadata alone is strict; legacy body is not', () => {
    expect(parseHttpOperation({ oldExtra: 1 })).toBeUndefined()
    expect(parseHttpOperation({ oldExtra: 1, httpOperation: token })).toEqual(token)
    for (const value of [
      null,
      undefined,
      {},
      [],
      'operation',
      { ...token, version: 2 },
      { ...token, version: '1' },
      { ...token, staffId: 'forged' },
      { ...token, actorId: 'forged' },
      { ...token, id: 'not-a-uuid' },
      { ...token, deviceId: '' },
      { version: 1, id: ID },
    ]) {
      expect(() => parseHttpOperation({ httpOperation: value })).toThrow()
    }
  })

  it('normalizes UUID case without rewriting unrelated legacy fields', () => {
    const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const body = { oldExtra: null, httpOperation: { version: 1, id: upper, deviceId: upper } }
    expect(parseHttpOperation(body)).toEqual({ version: 1, id: upper.toLowerCase(), deviceId: upper.toLowerCase() })
    expect(body).toEqual({ oldExtra: null, httpOperation: { version: 1, id: upper, deviceId: upper } })
  })

  it('fingerprint binds semantic refs and ignores object-key insertion order', () => {
    expect(fingerprint(manifest)).toMatch(/^[a-f0-9]{64}$/)
    expect(fingerprint(manifest)).toBe(
      fingerprint({ payload: {}, refs: { orderServiceChargeId: 'charge-1', orderId: 'order-1' }, action: 'removeServiceCharge' }),
    )
    for (const refs of [
      { ...manifest.refs, orderId: 'order-2' },
      { ...manifest.refs, orderServiceChargeId: 'charge-2' },
    ]) {
      expect(fingerprint({ ...manifest, refs })).not.toBe(fingerprint(manifest))
    }
  })

  it('fingerprint rejects unsupported domain manifests rather than dropping semantic fields', () => {
    for (const input of [
      { ...manifest, action: 'removeDiscount' },
      { ...manifest, payload: { reason: 'changed' } },
      { ...manifest, refs: { ...manifest.refs, orderId: '' } },
      { ...manifest, refs: { ...manifest.refs, tableId: 'table-1' } },
      { ...manifest, actorId: 'forged' },
    ]) {
      expect(() => fingerprint(input as HttpManifest)).toThrow()
    }
  })

  it('utf8Boundary: exact limit accepted; one byte above rejected including refs', () => {
    const e = receipt()
    e.affectedRefs[1].id = 'é'
    const base = Buffer.byteLength(JSON.stringify(e), 'utf8')
    e.affectedRefs[1].id += 'a'.repeat(1_048_576 - base)
    expect(Buffer.byteLength(JSON.stringify(serializeEnvelope(e)), 'utf8')).toBe(1_048_576)
    e.affectedRefs[1].id += 'a'
    expect(() => serializeEnvelope(e)).toThrow('RECEIPT_TOO_LARGE')
  })

  it('counts multibyte reference text instead of JavaScript character count', () => {
    const e = receipt()
    e.affectedRefs[1].id = 'é'.repeat(524_288)
    expect(JSON.stringify(e).length).toBeLessThan(1_048_576)
    expect(() => serializeEnvelope(e)).toThrow('RECEIPT_TOO_LARGE')
  })

  it('serializes the original HTTP result and every affected ref as a detached snapshot', () => {
    const e = receipt()
    const serialized = serializeEnvelope(e)
    expect(serialized).toEqual(e)
    expect(serialized).not.toBe(e)
    expect(serialized.affectedRefs).toHaveLength(2)
    e.affectedRefs[1].id = 'changed-after-snapshot'
    expect(serialized.affectedRefs[1].id).toBe('charge-1')
    expect(serialized.outcome === 'APPLIED' && serialized.originalResponse).toEqual({
      status: 200,
      body: { success: true, data: { subtotal: 100, discountAmount: 0, serviceChargeAmount: 0, total: 100, version: 2 } },
    })
  })

  it('rejects non-finite economic results instead of JSON coercion to null', () => {
    for (const total of [NaN, Infinity, -Infinity]) {
      const e = receipt()
      if (e.outcome !== 'APPLIED') throw new Error('Expected applied receipt fixture')
      e.originalResponse.body.data.total = total
      expect(() => serializeEnvelope(e)).toThrow()
    }
  })

  it('onlyReceiptUniqueIsRecovered', () => {
    expect(isReceiptKeyCollision(p2002({ constraint: 'PosSyncIntent_venueId_idempotencyKey_key' }))).toBe(true)
    expect(isReceiptKeyCollision(p2002({ target: ['PosSyncIntent_venueId_idempotencyKey_key'] }))).toBe(true)
    expect(isReceiptKeyCollision(p2002({ modelName: 'PosSyncIntent', target: ['venueId', 'idempotencyKey'] }))).toBe(true)
    expect(isReceiptKeyCollision(p2002({ modelName: 'PosSyncIntent', target: ['idempotencyKey', 'venueId'] }))).toBe(true)
    expect(isReceiptKeyCollision(p2002({ modelName: 'PosSyncIntent', target: ['venueId', 'deviceId', 'seq'] }))).toBe(false)
    expect(isReceiptKeyCollision(p2002({ modelName: 'OrderServiceCharge', target: ['orderId', 'serviceChargeId'] }))).toBe(false)
    expect(isReceiptKeyCollision(p2002({ modelName: 'Payment', target: ['venueId', 'idempotencyKey'] }))).toBe(false)
    expect(isReceiptKeyCollision(p2002({ target: ['venueId', 'idempotencyKey'] }))).toBe(false)
    expect(isReceiptKeyCollision(p2002({ modelName: 'PosSyncIntent', target: ['venueId', 'idempotencyKey', 'deviceId'] }))).toBe(false)
    expect(isReceiptKeyCollision(p2002({ constraint: 'Payment_venueId_idempotencyKey_key' }))).toBe(false)
    expect(isReceiptKeyCollision({ code: 'P2002', meta: { constraint: 'PosSyncIntent_venueId_idempotencyKey_key' } })).toBe(false)
    expect(isReceiptKeyCollision(new Error('unique'))).toBe(false)
    expect(isReceiptKeyCollision(new Prisma.PrismaClientKnownRequestError('timeout', { code: 'P2028', clientVersion: 'test' }))).toBe(false)
  })

  describe('legacy compatibility regressions', () => {
    it('does not require metadata on the existing empty or unrelated DELETE body', () => {
      for (const body of [undefined, null, {}, { oldExtra: 1, reason: null, staffId: 'legacy-field' }]) {
        expect(parseHttpOperation(body)).toBeUndefined()
      }
    })

    it('does not treat inherited metadata as a request opt-in', () => {
      expect(parseHttpOperation(Object.create({ httpOperation: token }))).toBeUndefined()
    })
  })
})

test('removeServiceCharge literal v1 fingerprint survives extension', () => {
  const m = { action: 'removeServiceCharge', refs: { orderId: 'o', orderServiceChargeId: 'c' }, payload: {} } as const
  const literal = '{"action":"removeServiceCharge","method":"DELETE","refs":{"orderId":"o","orderServiceChargeId":"c"},"payload":{}}'
  expect(fingerprint(m)).toBe('0eedf239b285d624041165356e43d20dbe852840bdb60f31e7329025e4ab5068')
  expect(fingerprint(m)).toBe(createHash('sha256').update(literal).digest('hex'))
  expect(fingerprint({ ...m, refs: { orderServiceChargeId: 'c', orderId: 'o' } })).toBe(fingerprint(m))
})
test('details distinguishes clear and omission, accepts decimal covers, preserves raw customer ID', () => {
  const parse = (payload: unknown) => manifestSchema.parse({ action: 'updateOrderDetails', refs: { orderId: 'o' }, payload })
  expect(parse({ name: null, notes: null, covers: null, customerId: null, orderType: '' })).toEqual(parse({}))
  expect(parse({ name: '  ', customerId: '', covers: 1.5 }).payload).toEqual({ name: '', covers: 1.5, customerId: '' })
  expect(fingerprint(parse({ name: '' }))).not.toBe(fingerprint(parse({})))
  expect(parse({ customerId: ' c ' }).payload).toEqual({ customerId: ' c ' })
})
test('cancel preserves whitespace; comp trims; split hash retains order and duplicates', () => {
  const m = (action: string, payload: unknown) => manifestSchema.parse({ action, refs: { orderId: 'o' }, payload })
  expect(fingerprint(m('cancelOrder', { reason: ' ' }))).not.toBe(fingerprint(m('cancelOrder', { reason: '' })))
  expect(fingerprint(m('compWholeOrder', { reason: ' ok ' }))).toBe(fingerprint(m('compWholeOrder', { reason: 'ok' })))
  expect(fingerprint(m('splitOrder', { itemIds: ['a', 'b'] }))).not.toBe(fingerprint(m('splitOrder', { itemIds: ['b', 'a'] })))
  expect(fingerprint(m('splitOrder', { itemIds: ['a', 'a'] }))).not.toBe(fingerprint(m('splitOrder', { itemIds: ['a'] })))
})

const totalData = { subtotal: 100, discountAmount: 0, serviceChargeAmount: 0, total: 100, version: 2 }
const checkData = { id: 'o', orderNumber: 'source', total: 40, version: 2 }
const childData = { id: 'child', orderNumber: 'child', total: 60, version: 2 }
const benefit = {
  orderDiscountId: 'discount-row',
  loyaltyRefund: { pointsRefunded: 10, customerId: 'customer', transactionId: 'refund' },
  stampRefund: { rewardId: 'reward', customerId: 'customer', rewardLabel: 'Reward' },
}
const contracts = [
  { action: 'moveOrder', refs: { orderId: 'o', targetTableId: 'table' }, payload: {}, body: { success: true } },
  { action: 'assignOrder', refs: { orderId: 'o', staffId: 'staff' }, payload: {}, body: { success: true, data: { staffName: 'Staff' } } },
  {
    action: 'applyServiceCharge',
    refs: { orderId: 'o', serviceChargeId: 'catalog' },
    payload: {},
    body: { success: true, data: totalData },
  },
  {
    action: 'mergeOrders',
    refs: { orderId: 'o', sourceOrderId: 'source' },
    payload: {},
    body: { success: true, data: { target: checkData, merged: { id: 'source', orderNumber: 'source', items: 2 }, tableFreed: true } },
  },
  {
    action: 'splitOrderBySeat',
    refs: { orderId: 'o' },
    payload: {},
    body: {
      success: true,
      data: {
        source: { id: 'o', orderNumber: 'source', total: 40, seat: 1 },
        created: [{ id: 'child', orderNumber: 'child', total: 60, seat: 2 }],
      },
    },
  },
  {
    action: 'applyOrderDiscount',
    refs: { orderId: 'o', discountId: 'catalog' },
    payload: {},
    body: { success: true, data: { ...totalData, orderDiscountId: 'row', name: 'Discount', amount: 10 } },
  },
  {
    action: 'compWholeOrder',
    refs: { orderId: 'o' },
    payload: { reason: 'ok' },
    body: { success: true, data: { ...totalData, itemsComped: 2, compedAmount: 100, reason: 'ok' } },
    effects: { discountBenefits: [benefit] },
  },
  {
    action: 'updateOrderDetails',
    refs: { orderId: 'o' },
    payload: {},
    body: { success: true, data: { name: null, notes: null, covers: 1.5, customerId: null, orderType: 'MANUAL_ENTRY' } },
  },
  {
    action: 'cancelOrder',
    refs: { orderId: 'o' },
    payload: { reason: null },
    body: { success: true, message: 'Orden cancelada exitosamente' },
  },
  { action: 'clearTable', refs: { tableId: 'table' }, payload: {}, body: { success: true, message: 'Mesa liberada' } },
  {
    action: 'splitOrder',
    refs: { orderId: 'o' },
    payload: { itemIds: ['a', 'a'] },
    body: { success: true, data: { source: checkData, created: childData } },
  },
  {
    action: 'removeServiceCharge',
    refs: { orderId: 'o', orderServiceChargeId: 'row' },
    payload: {},
    body: { success: true, data: totalData },
  },
  {
    action: 'redeemLoyaltyPoints',
    refs: { orderId: 'o', customerId: 'customer' },
    payload: { points: 10 },
    body: { success: true, data: { pointsRedeemed: 10, discountAmount: 10, newBalance: 90, order: totalData } },
  },
  {
    action: 'removeOrderDiscount',
    refs: { orderId: 'o', orderDiscountId: 'row' },
    payload: {},
    body: { success: true, data: totalData },
    effects: { loyaltyRefund: benefit.loyaltyRefund, stampRefund: benefit.stampRefund },
  },
  {
    action: 'compItem',
    refs: { orderId: 'o', itemId: 'item' },
    payload: { reason: 'ok' },
    body: { success: true, data: { ...totalData, itemId: 'item', reason: 'ok' } },
    effects: { discountBenefits: [benefit] },
  },
] as const
const contractReceipt = (contract: (typeof contracts)[number]) => ({
  protocol: 'HTTP_OP_V1',
  action: contract.action,
  request: { originalActorId: 'actor', deviceId: DEVICE, refs: contract.refs, payloadHash: 'a'.repeat(64) },
  outcome: 'APPLIED',
  originalResponse: { status: 200, body: contract.body },
  affectedRefs: [
    { kind: 'Order', id: 'o' },
    { kind: 'Order', id: 'child' },
  ],
  ...('effects' in contract ? { effects: contract.effects } : {}),
})
test.each(contracts)('$action manifest, response and required effects remain exact', contract => {
  const { action, refs, payload } = contract
  expect(manifestSchema.parse({ action, refs, payload })).toEqual({ action, refs, payload })
  const e = contractReceipt(contract)
  expect(serializeEnvelope(envelopeSchema.parse(e))).toEqual(e)
  expect(envelopeSchema.safeParse({ ...e, request: { ...e.request, refs: { ...refs, foreignRef: 'foreign' } } }).success).toBe(false)
  expect(manifestSchema.safeParse({ action, refs, payload, actorId: 'forged' }).success).toBe(false)
  const base = Object.fromEntries(Object.entries(e).filter(([key]) => key !== 'originalResponse' && key !== 'effects'))
  expect(
    envelopeSchema.safeParse({ ...base, outcome: 'REJECTED', rejection: { status: 409, code: 'NO', message: 'Rechazado' } }).success,
  ).toBe(true)
})
test('action response and removal effect mismatches fail closed', () => {
  const assign = contractReceipt(contracts[1])
  expect(envelopeSchema.safeParse({ ...assign, originalResponse: { status: 200, body: { success: true, data: totalData } } }).success).toBe(
    false,
  )
  const removal = contractReceipt(contracts[13])
  expect(envelopeSchema.safeParse({ ...removal, effects: { discountBenefits: [benefit] } }).success).toBe(false)
  expect(
    envelopeSchema.safeParse({ ...removal, effects: { loyaltyRefund: { pointsRefunded: 10, customerId: 'c' }, stampRefund: null } })
      .success,
  ).toBe(false)
  for (const c of [contracts[6], contracts[13], contracts[14]]) {
    expect(envelopeSchema.safeParse({ ...contractReceipt(c), effects: undefined }).success).toBe(false)
  }
})
test('split receipt exact whole UTF8 budget retains child and last ref detached', () => {
  const e = envelopeSchema.parse(contractReceipt(contracts[10]))
  e.affectedRefs.push({ kind: 'OrderItem', id: 'é' })
  const last = e.affectedRefs[e.affectedRefs.length - 1]
  last.id += 'x'.repeat(HTTP_MAX_BYTES - Buffer.byteLength(JSON.stringify(e), 'utf8'))
  expect(Buffer.byteLength(JSON.stringify(e), 'utf8')).toBe(HTTP_MAX_BYTES)
  const serialized = serializeEnvelope(e)
  expect(serialized).toEqual(e)
  expect(serialized).not.toBe(e)
  expect(serialized.affectedRefs[1].id).toBe('child')
  last.id += 'x'
  expect(serialized.affectedRefs[serialized.affectedRefs.length - 1].id).not.toBe(last.id)
  expect(() => serializeEnvelope(e)).toThrow('RECEIPT_TOO_LARGE')
})
test('finite payloads, strict refs, comp reason and split elements reject malformed input', () => {
  for (const covers of [NaN, Infinity, -Infinity, 0, 201, '2']) {
    expect(manifestSchema.safeParse({ action: 'updateOrderDetails', refs: { orderId: 'o' }, payload: { covers } }).success).toBe(false)
  }
  for (const points of [NaN, Infinity, 0, -1, 1.5, '10']) {
    expect(
      manifestSchema.safeParse({ action: 'redeemLoyaltyPoints', refs: { orderId: 'o', customerId: 'c' }, payload: { points } }).success,
    ).toBe(false)
  }
  for (const reason of ['', '  ', null, 3]) {
    expect(manifestSchema.safeParse({ action: 'compItem', refs: { orderId: 'o', itemId: 'item' }, payload: { reason } }).success).toBe(
      false,
    )
  }
  for (const itemIds of [[], [''], [1], null]) {
    expect(manifestSchema.safeParse({ action: 'splitOrder', refs: { orderId: 'o' }, payload: { itemIds } }).success).toBe(false)
  }
})
