import { resolveModifierSelections, type ModifierSelectionInput } from '@/services/reservation/resolveModifierSelections'
import type { PrismaClient } from '@prisma/client'

// Minimal mock of the Prisma queries the helper makes
function makePrisma(groups: any[]): PrismaClient {
  return {
    productModifierGroup: {
      findMany: jest.fn().mockResolvedValue(groups),
    },
  } as unknown as PrismaClient
}

const PROD = 'cprod000000000000000000001'
const G1 = 'cgrp000000000000000000001'
const M1A = 'cmod000000000000000000001'
const M1B = 'cmod000000000000000000002'

const productGroupsFixture = [
  {
    productId: PROD,
    group: {
      id: G1,
      required: true,
      allowMultiple: false,
      minSelections: 0,
      maxSelections: null,
      active: true,
      modifiers: [
        { id: M1A, name: 'Vitral', price: '10.00', active: true },
        { id: M1B, name: 'Aurora', price: '10.00', active: true },
      ],
    },
  },
]

describe('resolveModifierSelections', () => {
  it('returns empty when no selections and no required groups', async () => {
    const prisma = makePrisma([{ ...productGroupsFixture[0], group: { ...productGroupsFixture[0].group, required: false } }])
    const result = await resolveModifierSelections(prisma, [PROD], [])
    expect(result.totalDelta.toString()).toBe('0')
    expect(result.persistRows).toEqual([])
  })

  it('throws when a required group has no selection', async () => {
    const prisma = makePrisma(productGroupsFixture)
    await expect(resolveModifierSelections(prisma, [PROD], [])).rejects.toThrow(/requerido/i)
  })

  it('accepts one selection for a required single-select group and computes delta', async () => {
    const prisma = makePrisma(productGroupsFixture)
    const selections: ModifierSelectionInput[] = [{ productId: PROD, modifierId: M1A, quantity: 1 }]
    const result = await resolveModifierSelections(prisma, [PROD], selections)
    expect(result.totalDelta.toString()).toBe('10')
    expect(result.persistRows).toHaveLength(1)
    expect(result.persistRows[0]).toMatchObject({ productId: PROD, modifierId: M1A, name: 'Vitral', quantity: 1 })
  })

  it('rejects multiple selections for a single-select group', async () => {
    const prisma = makePrisma(productGroupsFixture)
    const selections: ModifierSelectionInput[] = [
      { productId: PROD, modifierId: M1A, quantity: 1 },
      { productId: PROD, modifierId: M1B, quantity: 1 },
    ]
    await expect(resolveModifierSelections(prisma, [PROD], selections)).rejects.toThrow(/solo puedes elegir/i)
  })

  it('rejects a modifier whose group is not assigned to the product', async () => {
    const prisma = makePrisma(productGroupsFixture)
    const selections: ModifierSelectionInput[] = [{ productId: PROD, modifierId: 'cmodOTHER0000000000000000', quantity: 1 }]
    await expect(resolveModifierSelections(prisma, [PROD], selections)).rejects.toThrow(/no válido/i)
  })

  it('applies quantity to per-unit modifiers', async () => {
    const prisma = makePrisma([
      {
        productId: PROD,
        group: {
          id: G1,
          required: false,
          allowMultiple: true,
          minSelections: 0,
          maxSelections: 5,
          active: true,
          modifiers: [{ id: M1A, name: 'Por uña', price: '10.00', active: true }],
        },
      },
    ])
    const selections: ModifierSelectionInput[] = [{ productId: PROD, modifierId: M1A, quantity: 3 }]
    const result = await resolveModifierSelections(prisma, [PROD], selections)
    expect(result.totalDelta.toString()).toBe('30')
    expect(result.persistRows[0].quantity).toBe(3)
  })

  it('rejects quantity > maxSelections on multi-select group', async () => {
    const prisma = makePrisma([
      {
        productId: PROD,
        group: {
          id: G1,
          required: false,
          allowMultiple: true,
          minSelections: 0,
          maxSelections: 5,
          active: true,
          modifiers: [{ id: M1A, name: 'Por uña', price: '10.00', active: true }],
        },
      },
    ])
    const selections: ModifierSelectionInput[] = [{ productId: PROD, modifierId: M1A, quantity: 6 }]
    await expect(resolveModifierSelections(prisma, [PROD], selections)).rejects.toThrow(/máximo/i)
  })
})
