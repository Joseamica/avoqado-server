import { mandarCambiosARevisarEnTx } from '@/services/exchanges/exchangeTerminalRefund'

// Codex rM2 #1: si guardar la liga del recibo sube `resultRevision` entre la lectura y la escritura, el CAS fallaba y el cambio se
// quedaba COMPLETED, fuera de «Cambios por revisar». La fila del cambio se aparta ANTES de leerla.
describe('mandarCambiosARevisarEnTx', () => {
  const credito = { amount: -500, tipAmount: 0, status: 'COMPLETED', processorData: { exchange: { role: 'CREDIT', exchangeId: 'ex1' } } }

  it('aparta el cambio antes de leerlo y escribe con la versión leída bajo el candado', async () => {
    const orden: string[] = []
    const tx = {
      $queryRaw: jest.fn(async (q: unknown) => {
        orden.push('candado:' + (Array.isArray(q) ? q.join('?') : String((q as { sql?: string }).sql)).replace(/\s+/g, ' ').trim())
        return [{ id: 'ex1' }]
      }),
      exchange: {
        findFirst: jest.fn(async () => {
          orden.push('lee')
          return { status: 'COMPLETED', resultRevision: 2, result: { status: 'COMPLETED', receiptUrl: 'https://r' } }
        }),
        updateMany: jest.fn(async () => {
          orden.push('escribe')
          return { count: 1 }
        }),
      },
      activityLog: { create: jest.fn(async () => ({})) },
    }
    const ids = await mandarCambiosARevisarEnTx(tx as never, {
      venueId: 'v',
      filas: [credito],
      originalPaymentId: 'p',
      refundPaymentId: 'r',
      refundCents: 50000,
      staffId: 's',
    })
    expect(ids).toEqual(['ex1'])
    expect(orden[0]).toMatch(/^candado:SELECT id FROM "Exchange" WHERE id = \? AND "venueId" = \? FOR UPDATE$/)
    expect(orden.slice(1)).toEqual(['lee', 'escribe'])
    expect(tx.exchange.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ex1', venueId: 'v', status: 'COMPLETED', resultRevision: 2 },
        data: expect.objectContaining({
          status: 'NEEDS_REVIEW',
          result: { status: 'NEEDS_REVIEW', receiptUrl: 'https://r', reviewReason: 'TERMINAL_REFUND_AFTER_EXCHANGE' },
        }),
      }),
    )
  })
})
