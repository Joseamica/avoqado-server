// tests/unit/services/fiscal/cogs.service.test.ts
// Póliza de costo de ventas (COGS): recetas (USAGE, costImpact negativo) + productos QUANTITY (SALE).
import { Prisma } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    rawMaterialMovement: { aggregate: jest.fn() },
    inventoryMovement: { findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    journalEntry: { findUnique: jest.fn() },
    journalLine: { aggregate: jest.fn() },
  },
}))
jest.mock('../../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../../src/services/fiscal/accountMapping.service', () => ({ getMappings: jest.fn() }))
jest.mock('../../../../src/services/fiscal/journalEntry.service', () => ({ postJournalEntry: jest.fn() }))
jest.mock('../../../../src/utils/datetime', () => ({
  parseDbDateRange: () => ({ from: new Date('2026-06-01T06:00:00Z'), to: new Date('2026-07-01T05:59:59Z') }),
}))

import prisma from '../../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../../src/services/fiscal/chartOfAccounts.service'
import { getMappings } from '../../../../src/services/fiscal/accountMapping.service'
import { postJournalEntry } from '../../../../src/services/fiscal/journalEntry.service'
import { computePeriodCogsCents, generateCogsPolicyForVenue } from '../../../../src/services/fiscal/cogs.service'

const p = prisma as unknown as {
  rawMaterialMovement: { aggregate: jest.Mock }
  inventoryMovement: { findMany: jest.Mock }
  venue: { findUnique: jest.Mock }
  journalEntry: { findUnique: jest.Mock }
  journalLine: { aggregate: jest.Mock }
}
const mScope = resolveScopeOrNull as jest.Mock
const mMappings = getMappings as jest.Mock
const mPost = postJournalEntry as jest.Mock
const D = (n: number) => new Prisma.Decimal(n)

const mappings = (omit: string[] = []) => ({
  mappings: [
    { movementType: 'COST_OF_GOODS_SOLD', account: omit.includes('COST_OF_GOODS_SOLD') ? null : { id: 'acc:COGS' } },
    { movementType: 'INVENTORY', account: omit.includes('INVENTORY') ? null : { id: 'acc:INV' } },
  ],
})

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'o1', rfc: 'RFC' })
  mMappings.mockResolvedValue(mappings())
  p.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  p.journalEntry.findUnique.mockResolvedValue(null) // el target acumulado aún no se posteó
  p.journalLine.aggregate.mockResolvedValue({ _sum: { debitCents: 0, creditCents: 0 } }) // sin COGS previo
  p.rawMaterialMovement.aggregate.mockResolvedValue({ _sum: { costImpact: D(0) } })
  p.inventoryMovement.findMany.mockResolvedValue([])
  mPost.mockResolvedValue({ id: 'je1' })
})

describe('computePeriodCogsCents', () => {
  it('recetas: costImpact NEGATIVO (salida) → costo POSITIVO', async () => {
    p.rawMaterialMovement.aggregate.mockResolvedValue({ _sum: { costImpact: D(-125.5) } })
    const c = await computePeriodCogsCents('v1', new Date(), new Date())
    expect(c).toBe(12550) // 125.50 en centavos
  })

  it('productos QUANTITY: |quantity| × unitCost', async () => {
    p.inventoryMovement.findMany.mockResolvedValue([
      { quantity: D(-3), unitCost: D(10) }, // 3 × 10 = 30
      { quantity: D(-2), unitCost: D(5.5) }, // 2 × 5.5 = 11
    ])
    const c = await computePeriodCogsCents('v1', new Date(), new Date())
    expect(c).toBe(4100) // 41.00
  })

  it('suma recetas + QUANTITY', async () => {
    p.rawMaterialMovement.aggregate.mockResolvedValue({ _sum: { costImpact: D(-100) } })
    p.inventoryMovement.findMany.mockResolvedValue([{ quantity: D(-4), unitCost: D(25) }]) // 100
    const c = await computePeriodCogsCents('v1', new Date(), new Date())
    expect(c).toBe(20000) // 200.00
  })

  it('sin consumo → 0', async () => {
    expect(await computePeriodCogsCents('v1', new Date(), new Date())).toBe(0)
  })
})

describe('generateCogsPolicyForVenue', () => {
  it('sin RFC → needsFiscalSetup, no postea', async () => {
    mScope.mockResolvedValue(null)
    const r = await generateCogsPolicyForVenue('v1', '2026-06')
    expect(r.posted).toBe(false)
    expect(r.reason).toBe('needsFiscalSetup')
    expect(mPost).not.toHaveBeenCalled()
  })

  it('falta el mapeo COGS o INVENTARIO → missingMappings, no postea', async () => {
    mMappings.mockResolvedValue(mappings(['COST_OF_GOODS_SOLD']))
    const r = await generateCogsPolicyForVenue('v1', '2026-06')
    expect(r.reason).toBe('missingMappings')
    expect(mPost).not.toHaveBeenCalled()
  })

  it('sin consumo → noCogs, no postea', async () => {
    const r = await generateCogsPolicyForVenue('v1', '2026-06')
    expect(r.reason).toBe('noCogs')
    expect(mPost).not.toHaveBeenCalled()
  })

  it('sin COGS previo → póliza BALANCEADA por el total: DEBE Costo de ventas / HABER Inventario', async () => {
    p.rawMaterialMovement.aggregate.mockResolvedValue({ _sum: { costImpact: D(-300) } }) // total 30000
    const r = await generateCogsPolicyForVenue('v1', '2026-06')
    expect(r.posted).toBe(true)
    expect(r.cogsCents).toBe(30000) // total del periodo
    const entry = mPost.mock.calls[0][1]
    expect(entry.source).toBe('COGS')
    expect(entry.type).toBe('DIARIO')
    expect(entry.idempotencyKey).toBe('cogs:v1:2026-06:t30000') // clave por target acumulado
    const debe = entry.lines.find((l: any) => l.debitCents > 0)
    const haber = entry.lines.find((l: any) => l.creditCents > 0)
    expect(debe.ledgerAccountId).toBe('acc:COGS')
    expect(debe.debitCents).toBe(30000)
    expect(haber.ledgerAccountId).toBe('acc:INV')
    expect(haber.creditCents).toBe(30000)
    expect(entry.lines.reduce((s: number, l: any) => s + l.debitCents, 0)).toBe(
      entry.lines.reduce((s: number, l: any) => s + l.creditCents, 0),
    ) // cuadra
  })

  it('DELTA incremental: ya había COGS parcial → postea SOLO lo nuevo (no se congela a media semana)', async () => {
    p.rawMaterialMovement.aggregate.mockResolvedValue({ _sum: { costImpact: D(-300) } }) // total 30000
    p.journalLine.aggregate.mockResolvedValue({ _sum: { debitCents: 20000, creditCents: 0 } }) // ya posteado 20000
    const r = await generateCogsPolicyForVenue('v1', '2026-06')
    expect(r.posted).toBe(true)
    expect(r.cogsCents).toBe(30000) // reporta el total del periodo
    const entry = mPost.mock.calls[0][1]
    expect(entry.lines.find((l: any) => l.debitCents > 0).debitCents).toBe(10000) // solo el delta 30000−20000
    expect(entry.idempotencyKey).toBe('cogs:v1:2026-06:t30000')
  })

  it('idempotencia: el total del periodo ya fue posteado → upToDate, NO re-postea', async () => {
    p.rawMaterialMovement.aggregate.mockResolvedValue({ _sum: { costImpact: D(-300) } })
    p.journalEntry.findUnique.mockResolvedValue({ id: 'existing' }) // la clave t30000 ya existe
    const r = await generateCogsPolicyForVenue('v1', '2026-06')
    expect(r.posted).toBe(false)
    expect(r.reason).toBe('upToDate')
    expect(mPost).not.toHaveBeenCalled()
  })
})
