import { initialPreparation, parsePreparation, preparationPermissions, transitionPreparation } from '@/services/kds/kitchenPreparation'

// The urgency request identifies a product, not a quantity transition. One represents
// the explicit priority operation; held units are released as part of that operation.
const change = (before: unknown, action: string, requestId = 'urgent-request-a', quantity = 1) =>
  (transitionPreparation as any)(before, action, quantity, undefined, undefined, requestId)

describe('urgent kitchen priority, independent from service course and progress', () => {
  it('releases the selected held product while preserving the total and its untouched sibling', () => {
    const selected = initialPreparation(2, 'STANDARD')
    const sibling = initialPreparation(1, 'STANDARD')
    expect(change(selected, 'URGENT')).toEqual({
      ...selected,
      HELD: 0,
      PENDING: 2,
      urgency: { requestId: 'urgent-request-a', acknowledged: false },
    })
    expect(selected.HELD).toBe(2)
    expect(sibling.HELD).toBe(1)
  })

  it('does not restart preparation or alter already ready/delivered quantities', () => {
    const before = { HELD: 0, PENDING: 1, PREPARING: 1, READY: 1, DELIVERED: 1, CANCELLED: 0 }
    const after = change(before, 'URGENT')
    expect(after).toMatchObject(before)
    expect(after.urgency).toEqual({ requestId: 'urgent-request-a', acknowledged: false })
  })

  it.each(['READY', 'DELIVERED', 'CANCELLED'])('does not make a finished product urgent: %s', state => {
    const before = { ...initialPreparation(1, 'IMMEDIATE'), PENDING: 0, [state]: 1 }
    expect(() => change(before, 'URGENT')).toThrow()
  })

  it('acknowledges the current request without removing priority or changing preparation', () => {
    const before = {
      ...initialPreparation(2, 'IMMEDIATE'),
      urgency: { requestId: 'urgent-request-a', acknowledged: false },
    }
    expect(change(before, 'ACK_URGENT')).toEqual({ ...before, urgency: { ...before.urgency, acknowledged: true } })
    expect(() => change(initialPreparation(1, 'IMMEDIATE'), 'ACK_URGENT')).toThrow()
  })

  it('removes only priority after kitchen started; it cannot hide work by holding it again', () => {
    const before = {
      HELD: 0,
      PENDING: 0,
      PREPARING: 2,
      READY: 0,
      DELIVERED: 0,
      CANCELLED: 0,
      urgency: { requestId: 'urgent-request-a', acknowledged: true },
    }
    expect(change(before, 'CLEAR_URGENT')).toEqual({ ...before, urgency: null })
  })

  it('finishes the active priority when the last unfinished unit becomes ready', () => {
    const before = {
      HELD: 0,
      PENDING: 0,
      PREPARING: 1,
      READY: 0,
      DELIVERED: 0,
      CANCELLED: 0,
      urgency: { requestId: 'urgent-request-a', acknowledged: true },
    }
    expect(transitionPreparation(before, 'READY', 1)).toMatchObject({ PREPARING: 0, READY: 1, urgency: null })
  })

  it.each([0, 2, -1, 0.5])('rejects priority requests expressed as a quantity change: %s', quantity => {
    expect(() => change(initialPreparation(3, 'STANDARD'), 'URGENT', 'urgent-request-a', quantity)).toThrow()
  })

  it('validates durable priority without preventing legacy progress from being read', () => {
    const legacy = initialPreparation(1, 'IMMEDIATE')
    expect(parsePreparation(legacy, 1)).toEqual(legacy)
    expect(() => parsePreparation({ ...legacy, urgency: { requestId: '', acknowledged: false } }, 1)).toThrow()
    expect(() => parsePreparation({ ...legacy, urgency: { requestId: 'request', acknowledged: 'yes' } }, 1)).toThrow()
  })

  it('mirrors floor authorization for sending/removing urgency and kitchen authorization for acknowledgement', () => {
    expect(preparationPermissions('URGENT' as any)).toEqual(['orders:update', 'orders:create'])
    expect(preparationPermissions('CLEAR_URGENT' as any)).toEqual(['orders:update', 'orders:create'])
    expect(preparationPermissions('ACK_URGENT' as any)).toEqual(['orders:update'])
    expect(preparationPermissions('RELEASE')).toEqual(['orders:update', 'orders:create'])
    expect(preparationPermissions('START')).toEqual(['orders:update'])
  })
})
