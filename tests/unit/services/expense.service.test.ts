/**
 * Unit tests (mock-first) for Gastos / CFDIs recibidos (Expense) service — Buzón, Capa B.
 *  - createExpense: valida cuadre al centavo, normaliza RFC, deriva tipoTercero, estado de pago
 *    (PUE pagado / PPD pendiente / override `paid`), dedupe por folio fiscal.
 *  - listExpenses: scope (org, rfc), filtro por periodo (rango UTC), resumen agregado.
 */
import { Prisma } from '@prisma/client'

import { BadRequestError } from '../../../src/errors/AppError'

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    expense: { create: jest.fn(), findMany: jest.fn(), aggregate: jest.fn() },
  },
}))

import prisma from '../../../src/utils/prismaClient'
import { createExpense, listExpenses, deriveTipoTercero, getAcreditablePagado } from '../../../src/services/fiscal/expense.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  expense: { create: jest.Mock; findMany: jest.Mock; aggregate: jest.Mock }
}

// Echo del create que rellena los defaults que pone la DB (status/posted) y un id/createdAt.
const echoCreate = async ({ data }: any) => ({
  id: 'exp1',
  status: 'REGISTERED',
  posted: false,
  createdAt: new Date('2026-06-10T12:00:00.000Z'),
  ...data,
})

const BASE = {
  proveedorRfc: 'aaa010101aaa',
  proveedorNombre: 'Proveedor SA',
  fechaEmision: '2026-06-10',
  subtotalCents: 100_00,
  ivaCents: 16_00,
  totalCents: 116_00,
}

beforeEach(() => {
  jest.clearAllMocks()
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', type: 'AUTO_SERVICE' })
  p.fiscalEmisor.findFirst.mockResolvedValue(null)
  p.expense.create.mockImplementation(echoCreate)
  p.expense.findMany.mockResolvedValue([])
})

describe('deriveTipoTercero', () => {
  it('nacional / extranjero / global', () => {
    expect(deriveTipoTercero('AAA010101AAA')).toBe('NACIONAL')
    expect(deriveTipoTercero('xexx010101000')).toBe('EXTRANJERO')
    expect(deriveTipoTercero('XAXX010101000')).toBe('GLOBAL')
  })
})

describe('createExpense', () => {
  it('sin RFC del contribuyente → BadRequestError', async () => {
    p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: null, type: 'AUTO_SERVICE' })
    await expect(createExpense('v1', BASE, { staffId: 's' })).rejects.toThrow(BadRequestError)
  })

  it('PUE: paga al emitir → PAID, paidPeriod del mes, paidCents = total, normaliza RFC, default iva16', async () => {
    const dto = await createExpense('v1', BASE, { staffId: 's' })
    const data = p.expense.create.mock.calls[0][0].data
    expect(data.proveedorRfc).toBe('AAA010101AAA') // normalizado a mayúsculas
    expect(data.tipoTercero).toBe('NACIONAL')
    expect(data.metodoPago).toBe('PUE')
    expect(data.iva16Cents).toBe(16_00) // IVA sin desglose → asume 16%
    expect(data.paymentStatus).toBe('PAID')
    expect(data.paidCents).toBe(116_00)
    expect(data.paidPeriod).toBe('2026-06')
    expect(dto.paymentStatus).toBe('PAID')
  })

  it('PPD → UNPAID, sin paidPeriod ni paidCents', async () => {
    const data = (await createExpense('v1', { ...BASE, metodoPago: 'PPD' }, { staffId: 's' }), p.expense.create.mock.calls[0][0].data)
    expect(data.paymentStatus).toBe('UNPAID')
    expect(data.paidPeriod).toBeNull()
    expect(data.paidCents).toBe(0)
    expect(data.fechaPago).toBeNull()
  })

  it('paid:false fuerza UNPAID aun siendo PUE (no asumir pago a ciegas)', async () => {
    await createExpense('v1', { ...BASE, metodoPago: 'PUE', paid: false }, { staffId: 's' })
    expect(p.expense.create.mock.calls[0][0].data.paymentStatus).toBe('UNPAID')
  })

  describe('deducibilidad por forma de pago, importe y tipo de gasto (LISR 27-III)', () => {
    const deduc = () => p.expense.create.mock.calls[0][0].data
    const BIG = { subtotalCents: 2500_00, ivaCents: 400_00, totalCents: 2900_00 } // > $2,000

    it('efectivo ≤ $2,000 → SÍ deducible (no es un no-deducible plano)', async () => {
      await createExpense('v1', { ...BASE, formaPago: '01' }, { staffId: 's' }) // total 116
      expect(deduc().deducible).toBe(true)
      expect(deduc().ivaAcreditable).toBe(true)
    })

    it('efectivo > $2,000 → NO deducible', async () => {
      await createExpense('v1', { ...BASE, ...BIG, formaPago: '01' }, { staffId: 's' })
      expect(deduc().deducible).toBe(false)
      expect(deduc().ivaAcreditable).toBe(false)
    })

    it('combustible en efectivo (cualquier monto) → NO deducible', async () => {
      await createExpense('v1', { ...BASE, formaPago: '01', categoria: 'COMBUSTIBLE' }, { staffId: 's' }) // total 116
      expect(deduc().deducible).toBe(false)
    })

    it('pago electrónico > $2,000 → SÍ deducible', async () => {
      await createExpense('v1', { ...BASE, ...BIG, formaPago: '03' }, { staffId: 's' }) // transferencia
      expect(deduc().deducible).toBe(true)
    })

    it('override explícito gana sobre el default (efectivo > $2,000 marcado deducible)', async () => {
      await createExpense('v1', { ...BASE, ...BIG, formaPago: '01', deducible: true }, { staffId: 's' })
      expect(deduc().deducible).toBe(true)
    })
  })

  it('invariante: el comprobante que no cuadra → BadRequestError', async () => {
    await expect(createExpense('v1', { ...BASE, totalCents: 120_00 }, { staffId: 's' })).rejects.toThrow(/no cuadra/i)
  })

  it('tolera 1¢ de diferencia de redondeo', async () => {
    await expect(createExpense('v1', { ...BASE, totalCents: 116_01 }, { staffId: 's' })).resolves.toBeDefined()
  })

  it('respeta retenciones en el cuadre (servicios profesionales)', async () => {
    // subtotal 1000 + IVA 160 − IVA ret 106.67 − ISR ret 100 = 953.33
    const input = {
      ...BASE,
      subtotalCents: 1000_00,
      ivaCents: 160_00,
      ivaRetenidoCents: 106_67,
      isrRetenidoCents: 100_00,
      totalCents: 953_33,
    }
    await expect(createExpense('v1', input, { staffId: 's' })).resolves.toBeDefined()
  })

  it('subtotal <= 0 y montos negativos → BadRequestError', async () => {
    await expect(createExpense('v1', { ...BASE, subtotalCents: 0 }, { staffId: 's' })).rejects.toThrow(BadRequestError)
    await expect(createExpense('v1', { ...BASE, descuentoCents: -1 }, { staffId: 's' })).rejects.toThrow(/negativ/i)
  })

  it('dedupeKey = UUID si existe; si no, composición estable', async () => {
    await createExpense('v1', { ...BASE, uuid: 'abcd-1234' }, { staffId: 's' })
    expect(p.expense.create.mock.calls[0][0].data.dedupeKey).toBe('ABCD-1234')
    jest.clearAllMocks()
    p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', type: 'AUTO_SERVICE' })
    p.fiscalEmisor.findFirst.mockResolvedValue(null)
    p.expense.create.mockImplementation(echoCreate)
    await createExpense('v1', { ...BASE, folio: 'F-9' }, { staffId: 's' })
    expect(p.expense.create.mock.calls[0][0].data.dedupeKey).toBe('AAA010101AAA|2026-06-10|11600|F-9')
  })

  it('duplicado (P2002) → BadRequestError legible', async () => {
    p.expense.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }))
    await expect(createExpense('v1', BASE, { staffId: 's' })).rejects.toThrow(/ya fue registrado/i)
  })
})

describe('listExpenses', () => {
  it('sin RFC → needsFiscalSetup, sin consultar', async () => {
    p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: null, type: 'AUTO_SERVICE' })
    const r = await listExpenses('v1')
    expect(r.needsFiscalSetup).toBe(true)
    expect(p.expense.findMany).not.toHaveBeenCalled()
  })

  // Fila completa de Expense (lo que devuelve la DB) para que mapExpense no truene.
  const row = (over: Record<string, unknown>) => ({
    id: 'exp1',
    proveedorRfc: 'AAA010101AAA',
    proveedorNombre: 'Prov',
    tipoTercero: 'NACIONAL',
    comprobanteTipo: 'INGRESO',
    metodoPago: 'PUE',
    categoria: 'GASTO_GENERAL',
    fechaEmision: new Date('2026-06-10T12:00:00.000Z'),
    fechaPago: null,
    subtotalCents: 100_00,
    descuentoCents: 0,
    ivaCents: 16_00,
    iva16Cents: 16_00,
    iva8Cents: 0,
    iepsCents: 0,
    isrRetenidoCents: 0,
    ivaRetenidoCents: 0,
    totalCents: 116_00,
    deducible: true,
    ivaAcreditable: true,
    paymentStatus: 'PAID',
    paidCents: 116_00,
    paidPeriod: '2026-06',
    posted: false,
    uuid: null,
    serie: null,
    folio: null,
    source: 'MANUAL',
    status: 'REGISTERED',
    createdAt: new Date('2026-06-10T12:00:00.000Z'),
    ...over,
  })

  it('resume count/total/iva/deducible (excluye no-deducible del base)', async () => {
    p.expense.findMany.mockResolvedValue([
      row({ totalCents: 116_00, ivaCents: 16_00, subtotalCents: 100_00, deducible: true }),
      row({ totalCents: 58_00, ivaCents: 8_00, subtotalCents: 50_00, deducible: false }),
    ])
    const r = await listExpenses('v1')
    expect(r.summary.count).toBe(2)
    expect(r.summary.totalCents).toBe(174_00)
    expect(r.summary.ivaCents).toBe(24_00)
    expect(r.summary.deducibleCents).toBe(100_00) // el no-deducible no suma a la base
  })

  it('filtro por periodo arma rango UTC [mes, mes+1) sobre fechaEmision', async () => {
    await listExpenses('v1', { period: '2026-06' })
    const where = p.expense.findMany.mock.calls[0][0].where
    expect(where.fechaEmision.gte.toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(where.fechaEmision.lt.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(where.status).toBe('REGISTERED') // por defecto solo no-cancelados
  })

  it('periodo inválido → BadRequestError', async () => {
    await expect(listExpenses('v1', { period: '2026/06' })).rejects.toThrow(BadRequestError)
  })
})

describe('getAcreditablePagado', () => {
  it('sin RFC → null', async () => {
    p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: null, type: 'AUTO_SERVICE' })
    expect(await getAcreditablePagado('v1', '2026-06')).toBeNull()
  })

  it('suma ivaCents + retenciones de gastos PAGADOS/acreditables del periodo (filtro por RFC)', async () => {
    p.expense.aggregate.mockResolvedValue({
      _sum: { ivaCents: 32_00, ivaRetenidoCents: 5_00, isrRetenidoCents: 10_00 },
      _count: { _all: 3 },
    })
    const r = await getAcreditablePagado('v1', '2026-06')
    expect(r!.acreditablePagadoCents).toBe(32_00)
    expect(r!.ivaRetenidoTercerosCents).toBe(5_00)
    expect(r!.isrRetenidoTercerosCents).toBe(10_00)
    expect(r!.expenseCount).toBe(3)
    // el filtro: PAID + acreditable + deducible + INGRESO + paidPeriod + no cancelado
    const where = p.expense.aggregate.mock.calls[0][0].where
    expect(where).toMatchObject({
      rfc: 'EKU9003173C9',
      paymentStatus: 'PAID',
      deducible: true,
      ivaAcreditable: true,
      comprobanteTipo: 'INGRESO',
      paidPeriod: '2026-06',
      status: 'REGISTERED',
    })
  })

  it('sin gastos → 0 (no null) cuando hay RFC', async () => {
    p.expense.aggregate.mockResolvedValue({ _sum: { ivaCents: null, ivaRetenidoCents: null, isrRetenidoCents: null }, _count: { _all: 0 } })
    const r = await getAcreditablePagado('v1', '2026-06')
    expect(r!.acreditablePagadoCents).toBe(0)
    expect(r!.expenseCount).toBe(0)
  })

  it('periodo inválido → BadRequestError', async () => {
    await expect(getAcreditablePagado('v1', '2026')).rejects.toThrow(BadRequestError)
  })
})

describe('sugerencia de activo fijo por monto (sugerir + confirmar a mano)', () => {
  // Por su importe, un gasto GENERAL/OTRO ≥ $5,000 (subtotal) SUGIERE registrarse como activo fijo.
  // Solo sugiere — nada se deprecia sin que el usuario lo confirme en Activos fijos.
  const ASSETY = { subtotalCents: 6_000_00, ivaCents: 960_00, totalCents: 6_960_00 }

  it('gasto general ≥ $5,000 → sugiere activo fijo', async () => {
    const e = await createExpense('v1', { ...BASE, ...ASSETY }, { staffId: 's' })
    expect(e.fixedAssetSuggestion).toBe(true)
  })

  it('categoría OTRO ≥ $5,000 → también sugiere', async () => {
    const e = await createExpense('v1', { ...BASE, ...ASSETY, categoria: 'OTRO' }, { staffId: 's' })
    expect(e.fixedAssetSuggestion).toBe(true)
  })

  it('combustible / arrendamiento grandes → NO sugiere (no son bienes)', async () => {
    const c = await createExpense('v1', { ...BASE, ...ASSETY, categoria: 'COMBUSTIBLE' }, { staffId: 's' })
    expect(c.fixedAssetSuggestion).toBe(false)
    const r = await createExpense('v1', { ...BASE, ...ASSETY, categoria: 'ARRENDAMIENTO', folio: 'F2' }, { staffId: 's' })
    expect(r.fixedAssetSuggestion).toBe(false)
  })

  it('gasto chico → NO sugiere', async () => {
    const e = await createExpense('v1', BASE, { staffId: 's' })
    expect(e.fixedAssetSuggestion).toBe(false)
  })
})
