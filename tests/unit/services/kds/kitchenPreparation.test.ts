import {
  initialPreparation,
  transitionPreparation,
  preparationTicketStatus,
  deliverableQuantity,
  preparationPermissions,
} from '@/services/kds/kitchenPreparation'

describe('kitchen preparation by product and station', () => {
  it('holds a standard course and sends immediate products to pending', () => {
    expect(initialPreparation(2, 'STANDARD').HELD).toBe(2)
    expect(initialPreparation(2, 'IMMEDIATE').PENDING).toBe(2)
    expect(() => transitionPreparation(initialPreparation(1, 'STANDARD'), 'START', 1)).toThrow()
  })

  it('releases only the selected quantities, without changing another product or future round', () => {
    const held = initialPreparation(3, 'STANDARD')
    const released = transitionPreparation(held, 'RELEASE', 1)
    expect(released).toMatchObject({ HELD: 2, PENDING: 1 })
    expect(held.HELD).toBe(3)
    expect(initialPreparation(1, 'STANDARD').HELD).toBe(1)
  })

  it('tracks partial preparation, readiness and delivery independently', () => {
    const started = transitionPreparation(initialPreparation(3, 'IMMEDIATE'), 'START', 2)
    const ready = transitionPreparation(started, 'READY', 1)
    const delivered = transitionPreparation(ready, 'DELIVER', 1)
    expect(delivered).toMatchObject({ PENDING: 1, PREPARING: 1, READY: 0, DELIVERED: 1 })
    expect(preparationTicketStatus([delivered, initialPreparation(1, 'STANDARD')])).toBe('PREPARING')
  })

  it('cannot deliver more than is ready in every station', () => {
    const ready = transitionPreparation(transitionPreparation(initialPreparation(2, 'IMMEDIATE'), 'START', 2), 'READY', 2)
    const halfReady = transitionPreparation(transitionPreparation(initialPreparation(2, 'IMMEDIATE'), 'START', 2), 'READY', 1)
    expect(deliverableQuantity([ready, halfReady])).toBe(1)
    expect(deliverableQuantity([ready, initialPreparation(2, 'IMMEDIATE')])).toBe(0)
  })

  it('requires a reason to cancel preparation or reopen completed quantities', () => {
    const preparing = transitionPreparation(initialPreparation(2, 'IMMEDIATE'), 'START', 2)
    expect(() => transitionPreparation(preparing, 'CANCEL', 1, 'PREPARING')).toThrow()
    const canceled = transitionPreparation(preparing, 'CANCEL', 1, 'PREPARING', 'Producto caído')
    const reopened = transitionPreparation(canceled, 'REOPEN', 1, 'CANCELLED', 'Reposición autorizada')
    expect(reopened).toMatchObject({ PREPARING: 1, PENDING: 1, CANCELLED: 0 })
  })
  it('corrects one product whose stations are at different preparation stages', () => {
    const mixed = { HELD: 1, PENDING: 1, PREPARING: 1, READY: 1, DELIVERED: 1, CANCELLED: 0 }
    const canceled = transitionPreparation(mixed, 'CANCEL', 2, undefined, 'Faltan insumos')
    expect(canceled).toEqual({ HELD: 0, PENDING: 0, PREPARING: 1, READY: 1, DELIVERED: 1, CANCELLED: 2 })
    const reopened = transitionPreparation(canceled, 'REOPEN', 2, undefined, 'Reposición')
    expect(reopened).toMatchObject({ PENDING: 2, CANCELLED: 0, DELIVERED: 1, READY: 1 })
    expect(mixed).toMatchObject({ HELD: 1, PENDING: 1 })
  })

  it.each([0, -1, 0.5, NaN, Infinity])('rejects invalid quantities: %s', quantity => {
    expect(() => transitionPreparation(initialPreparation(2, 'IMMEDIATE'), 'START', quantity)).toThrow()
  })

  it('rejects overproduction and illegal transitions', () => {
    const pending = initialPreparation(2, 'IMMEDIATE')
    expect(() => transitionPreparation(pending, 'START', 3)).toThrow()
    expect(() => transitionPreparation(pending, 'DELIVER', 1)).toThrow()
    expect(() => transitionPreparation(pending, 'CANCEL', 1, 'DELIVERED', 'Motivo')).toThrow()
    expect(() => transitionPreparation(pending, 'REOPEN', 1, 'HELD', 'Motivo')).toThrow()
  })

  it('derives completion only after all quantities are delivered or canceled', () => {
    const complete = { ...initialPreparation(1, 'IMMEDIATE'), PENDING: 0, DELIVERED: 1 }
    expect(preparationTicketStatus([complete, initialPreparation(1, 'STANDARD')])).toBe('NEW')
    expect(preparationTicketStatus([complete])).toBe('COMPLETED')
    expect(preparationTicketStatus([])).toBe('NEW')
  })

  it('uses the canonical actor permissions for floor, kitchen and exceptional actions', () => {
    expect(preparationPermissions('RELEASE')).toEqual(['orders:update', 'orders:create'])
    expect(preparationPermissions('DELIVER')).toEqual(['orders:update', 'orders:create'])
    expect(preparationPermissions('START')).toEqual(['orders:update'])
    expect(preparationPermissions('REOPEN')).toEqual(['orders:update', 'orders:cancel'])
    expect(preparationPermissions('CANCEL')).toEqual(['orders:update', 'orders:cancel'])
  })

  // Legacy ticket state remains a distinct contract: new work never implies delivery.
  it('ready still remains active, and held products prevent global readiness', () => {
    const ready = { ...initialPreparation(1, 'IMMEDIATE'), PENDING: 0, READY: 1 }
    expect(preparationTicketStatus([ready])).toBe('READY')
    expect(preparationTicketStatus([ready, initialPreparation(1, 'STANDARD')])).toBe('NEW')
  })
})
