/**
 * Regression tests — validación de cantidad en ajustes de stock.
 *
 * Bug (auditoría FIFO 2026-06-11): AdjustStockSchema y
 * AdjustProductInventoryStockSchema aceptaban `quantity: Infinity`
 * (z.number() sin .finite()), que aritmética abajo convierte en stock
 * corrupto. Además los mensajes deben estar en español (los ve el usuario
 * tal cual vía validation.ts).
 */

import { AdjustStockSchema, AdjustProductInventoryStockSchema } from '@/schemas/dashboard/inventory.schema'

const CUID = 'cjld2cjxh0000qzrmn831i7rn'

describe('AdjustStockSchema — quantity', () => {
  const base = {
    params: { venueId: CUID, rawMaterialId: CUID },
    body: { quantity: 5, type: 'ADJUSTMENT' },
  }

  it('acepta cantidades finitas normales', () => {
    expect(AdjustStockSchema.safeParse(base).success).toBe(true)
  })

  it('rechaza Infinity con mensaje en español', () => {
    const result = AdjustStockSchema.safeParse({ ...base, body: { ...base.body, quantity: Infinity } })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msg = result.error.issues.map(i => i.message).join(' ')
      expect(msg).toMatch(/finito/i)
    }
  })

  it('rechaza -Infinity', () => {
    const result = AdjustStockSchema.safeParse({ ...base, body: { ...base.body, quantity: -Infinity } })
    expect(result.success).toBe(false)
  })

  it.each(['TRANSFER_OUT', 'TRANSFER_IN'])('rechaza %s en el endpoint de ajuste manual', type => {
    const result = AdjustStockSchema.safeParse({ ...base, body: { ...base.body, type } })
    expect(result.success).toBe(false)
  })
})

describe('AdjustProductInventoryStockSchema — quantity', () => {
  const base = {
    params: { venueId: CUID, productId: CUID },
    body: { quantity: 5, type: 'ADJUSTMENT' },
  }

  it('acepta cantidades finitas normales', () => {
    expect(AdjustProductInventoryStockSchema.safeParse(base).success).toBe(true)
  })

  it('rechaza Infinity', () => {
    const result = AdjustProductInventoryStockSchema.safeParse({ ...base, body: { ...base.body, quantity: Infinity } })
    expect(result.success).toBe(false)
  })
})
