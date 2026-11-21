/**
 * Codex r4 #2 de «Anular producto»: la vista previa del MCP, el alta del cargo (y su bitácora), los cargos automáticos y los
 * recalculadores usan UNA fórmula. Con `Number`, el 10 % de 100 − 89.95 (10.049999…) daba $1.00 en la vista previa y en la
 * bitácora, y $1.01 en lo que se cobraba.
 */
import { Prisma } from '@prisma/client'
import { baseDeCargos, importeDeCargo } from '@/services/shared/serviceCharges'

describe('importeDeCargo', () => {
  it('10 % de $100 − $89.95 es $1.01 (no $1.00)', () => {
    expect(importeDeCargo('PERCENTAGE', 10, baseDeCargos(100, 89.95)).toNumber()).toBe(1.01)
    // La fórmula vieja de la vista previa daba otra cosa: así se ve el defecto.
    const base = Math.max(0, 100 - 89.95)
    expect(Math.round(((base * 10) / 100) * 100) / 100).toBe(1)
  })

  it('10 % de $25.02 + $25.33 es $5.04', () => {
    expect(importeDeCargo('PERCENTAGE', 10, 25.02 + 25.33).toNumber()).toBe(5.04)
  })

  it('un monto fijo se respeta, sin importar la base', () => {
    expect(importeDeCargo('FIXED_AMOUNT', new Prisma.Decimal(15), 0).toNumber()).toBe(15)
  })

  it('Codex r5 #1: un fijo del catálogo con 4 decimales ($1.0050) es $1.01 en la vista previa, el alta y la cuenta', () => {
    expect(importeDeCargo('FIXED_AMOUNT', new Prisma.Decimal('1.0050'), 100).toNumber()).toBe(1.01)
  })

  it('con base en cero (descuento mayor que el subtotal) el % es $0', () => {
    expect(importeDeCargo('PERCENTAGE', 10, baseDeCargos(50, 80)).toNumber()).toBe(0)
  })
})
