import { bulkManualSalesSchema, manualSaleRowSchema } from '@/schemas/dashboard/manualSale.schema'

describe('manualSaleRowSchema', () => {
  it('accepts a valid row', () => {
    const r = {
      iccid: '8952140063677014972F',
      promoterCode: 'BSCLOXH0405',
      storeName: 'BAE MUÑOZ SLP (898)',
      saleDate: '2026-06-24',
      saleType: 'Línea nueva',
      paymentForm: 'No aplica',
      amount: 'No aplica',
      simType: 'SIM de intercambio',
    }
    expect(manualSaleRowSchema.parse(r).iccid).toBe('8952140063677014972F')
  })

  // Regression: the sheet routinely leaves "Forma de Pago" blank for free SIM swaps,
  // and the parser drops empty cells (so paymentForm arrives undefined). It must be
  // OPTIONAL — otherwise one blank cell fails the whole batch's validation middleware
  // and the upload silently 400s (the prod bug). mapPaymentForm treats it as "No aplica".
  it('accepts a row with a missing paymentForm (blank cell)', () => {
    const r = {
      iccid: '8952140063677014972F',
      storeName: 'BAE MUÑOZ SLP (898)',
      saleDate: '2026-06-24',
      saleType: 'Línea nueva',
      amount: 'No aplica',
      // paymentForm intentionally omitted
    }
    expect(() => manualSaleRowSchema.parse(r)).not.toThrow()
    expect(manualSaleRowSchema.parse(r).paymentForm).toBeUndefined()
  })

  it('rejects an empty iccid with a Spanish message', () => {
    expect(() =>
      manualSaleRowSchema.parse({
        iccid: '',
        storeName: 'X',
        saleDate: '2026-06-24',
        saleType: 'Línea nueva',
        paymentForm: 'No aplica',
        amount: '0',
      }),
    ).toThrow(/ICCID/i)
  })
})

describe('bulkManualSalesSchema', () => {
  // Sólo forma: una fila con una celda vacía NO puede tumbar el lote entero en el
  // middleware; el servicio la marca como error de esa fila (Isaac, 8-oct-2026).
  it('acepta un lote aunque una fila no traiga storeName', () => {
    const r = bulkManualSalesSchema.safeParse({ rows: [{ iccid: '8952140063677014972F', amount: 1 }] })
    expect(r.success).toBe(true)
  })

  it('sigue rechazando un lote vacío en español', () => {
    const r = bulkManualSalesSchema.safeParse({ rows: [] })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0].message).toBe('Sube al menos una venta')
  })
})
