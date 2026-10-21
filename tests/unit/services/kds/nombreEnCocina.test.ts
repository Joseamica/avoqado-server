/**
 * Codex 3.6 (S6): la comanda perdía el peso de lo que se vende por kilo — «Arrachera ×1» en vez de 0.750 kg. La cocina
 * no tiene otra forma de saber cuánto servir: el peso viaja en el nombre del renglón (papel y pantalla dicen lo mismo).
 */
import { Prisma } from '@prisma/client'
import { nombreEnCocina } from '@/services/kds/nombreEnCocina'

describe('nombreEnCocina', () => {
  it('un renglón por peso lleva el peso con 3 decimales y la unidad', () => {
    expect(nombreEnCocina('Arrachera', new Prisma.Decimal('0.75'), 'KILOGRAM')).toBe('Arrachera (0.750 kg)')
  })

  it('sin unidad guardada se lee como kilos (la venta por peso siempre es por kilo)', () => {
    expect(nombreEnCocina('Queso Oaxaca', new Prisma.Decimal('1.2'), null)).toBe('Queso Oaxaca (1.200 kg)')
  })

  it('respeta otra unidad de peso', () => {
    expect(nombreEnCocina('Café', new Prisma.Decimal('250'), 'GRAM')).toBe('Café (250.000 g)')
  })

  it('regresión: un renglón normal sale con su nombre tal cual', () => {
    expect(nombreEnCocina('Taco', null, null)).toBe('Taco')
  })
})
