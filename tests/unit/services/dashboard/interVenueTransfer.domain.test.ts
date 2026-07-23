import {
  allocateDispatchFIFO,
  allocateReceiptFIFO,
  calculateVarianceCostFIFO,
  assertTransferQuantities,
  assertTransferTransition,
  deriveTransferCompletionStatus,
} from '@/services/dashboard/interVenueTransfer.domain'

describe('interVenueTransfer.domain', () => {
  describe('assertTransferTransition', () => {
    it.each([
      ['REQUESTED', 'APPROVE'],
      ['REQUESTED', 'REJECT'],
      ['REQUESTED', 'CANCEL'],
      ['APPROVED', 'DISPATCH'],
      ['APPROVED', 'CANCEL'],
      ['IN_TRANSIT', 'RECEIVE'],
      ['IN_TRANSIT', 'RESOLVE_VARIANCE'],
      ['PARTIALLY_RECEIVED', 'RECEIVE'],
      ['PARTIALLY_RECEIVED', 'RESOLVE_VARIANCE'],
    ] as const)('permite %s -> %s', (status, action) => {
      expect(() => assertTransferTransition(status, action)).not.toThrow()
    })

    it.each([
      ['REQUESTED', 'DISPATCH'],
      ['APPROVED', 'RECEIVE'],
      ['COMPLETED', 'RECEIVE'],
      ['COMPLETED_WITH_VARIANCE', 'RESOLVE_VARIANCE'],
      ['REJECTED', 'APPROVE'],
      ['CANCELLED', 'DISPATCH'],
    ] as const)('rechaza %s -> %s', (status, action) => {
      expect(() => assertTransferTransition(status, action)).toThrow('Transición de traslado no permitida')
    })
  })

  describe('assertTransferQuantities', () => {
    it('acepta requested >= dispatched >= received y diferencias resueltas dentro del pendiente', () => {
      expect(() =>
        assertTransferQuantities({ requested: '10.000', dispatched: '8.000', received: '6.000', varianceResolved: '4.000' }),
      ).not.toThrow()
    })

    it.each([
      { requested: '0', dispatched: '0', received: '0', varianceResolved: '0' },
      { requested: '5', dispatched: '6', received: '0', varianceResolved: '0' },
      { requested: '5', dispatched: '4', received: '4.001', varianceResolved: '0' },
      { requested: '5', dispatched: '4', received: '3', varianceResolved: '2.001' },
    ])('rechaza cantidades inválidas: %j', quantities => {
      expect(() => assertTransferQuantities(quantities)).toThrow()
    })
  })

  describe('deriveTransferCompletionStatus', () => {
    it('queda en tránsito sin recepciones', () => {
      expect(deriveTransferCompletionStatus([{ requested: '10', dispatched: '10', received: '0', varianceResolved: '0' }])).toBe(
        'IN_TRANSIT',
      )
    })

    it('queda parcialmente recibido si todavía falta contabilizar cantidad', () => {
      expect(deriveTransferCompletionStatus([{ requested: '10', dispatched: '10', received: '4', varianceResolved: '0' }])).toBe(
        'PARTIALLY_RECEIVED',
      )
    })

    it('completa sin diferencia únicamente cuando todo lo solicitado fue recibido', () => {
      expect(deriveTransferCompletionStatus([{ requested: '10', dispatched: '10', received: '10', varianceResolved: '0' }])).toBe(
        'COMPLETED',
      )
    })

    it('completa con diferencia cuando cada faltante quedó resuelto explícitamente', () => {
      expect(
        deriveTransferCompletionStatus([
          { requested: '10', dispatched: '8', received: '7', varianceResolved: '3' },
          { requested: '4', dispatched: '4', received: '4', varianceResolved: '0' },
        ]),
      ).toBe('COMPLETED_WITH_VARIANCE')
    })
  })

  describe('FIFO de salida y recepción', () => {
    it('congela costo y caducidad tomando primero los lotes más antiguos', () => {
      const allocations = allocateDispatchFIFO(
        [
          { id: 'old', remainingQuantity: '3', costPerUnit: '2.50', receivedDate: new Date('2026-01-01'), expirationDate: null },
          {
            id: 'new',
            remainingQuantity: '10',
            costPerUnit: '3.75',
            receivedDate: new Date('2026-02-01'),
            expirationDate: new Date('2026-08-01'),
          },
        ],
        '5',
      )

      expect(allocations.map(a => ({ batchId: a.batchId, quantity: a.quantity.toString(), cost: a.costPerUnit.toString() }))).toEqual([
        { batchId: 'old', quantity: '3', cost: '2.5' },
        { batchId: 'new', quantity: '2', cost: '3.75' },
      ])
      expect(allocations[1].expirationDate).toEqual(new Date('2026-08-01'))
    })

    it('rechaza la salida si los lotes activos no alcanzan', () => {
      expect(() =>
        allocateDispatchFIFO(
          [{ id: 'only', remainingQuantity: '2', costPerUnit: '1', receivedDate: new Date(), expirationDate: null }],
          '3',
        ),
      ).toThrow('Stock insuficiente')
    })

    it('aplica cada recepción parcial contra las asignaciones FIFO pendientes', () => {
      const lines = allocateReceiptFIFO(
        [
          { id: 'a1', quantityDispatched: '3', quantityReceived: '1' },
          { id: 'a2', quantityDispatched: '4', quantityReceived: '0' },
        ],
        '5',
      )

      expect(lines.map(line => ({ allocationId: line.allocationId, quantity: line.quantity.toString() }))).toEqual([
        { allocationId: 'a1', quantity: '2' },
        { allocationId: 'a2', quantity: '3' },
      ])
    })

    it('no permite volver a recibir una cantidad ya resuelta como merma en tránsito', () => {
      const allocations = [
        { id: 'a1', quantityDispatched: 3, quantityReceived: 0 },
        { id: 'a2', quantityDispatched: 2, quantityReceived: 0 },
      ]

      expect(allocateReceiptFIFO(allocations, 3, 2).map(line => [line.allocationId, line.quantity.toString()])).toEqual([
        ['a1', '1'],
        ['a2', '2'],
      ])
      expect(() => allocateReceiptFIFO(allocations, 4, 2)).toThrow('La recepción supera la cantidad pendiente')
    })

    it('valúa una diferencia sólo una vez sobre las asignaciones en tránsito', () => {
      const allocations = [
        { id: 'a1', quantityDispatched: '3', quantityReceived: '1', costPerUnit: '2' },
        { id: 'a2', quantityDispatched: '4', quantityReceived: '0', costPerUnit: '5' },
      ]

      expect(calculateVarianceCostFIFO(allocations, '4').toString()).toBe('14')
      expect(calculateVarianceCostFIFO(allocations, '2', '2').toString()).toBe('10')
    })

    it('rechaza una diferencia mayor al tránsito pendiente', () => {
      expect(() =>
        calculateVarianceCostFIFO([{ id: 'a1', quantityDispatched: '3', quantityReceived: '2', costPerUnit: '2' }], '2'),
      ).toThrow('supera la cantidad pendiente en tránsito')
    })
  })
})
