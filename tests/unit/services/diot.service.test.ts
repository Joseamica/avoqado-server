/**
 * Unit tests (mock-first) para la DIOT (Declaración Informativa de Operaciones con Terceros).
 *  - agrupa los gastos PAGADOS/acreditables del periodo por proveedor + tipo de tercero;
 *  - mapea tipoTercero → código DIOT (04/05/15) y deriva la base por tasa;
 *  - cuadraConIvaFlujo: Σ IVA acreditable de la DIOT == Σ ivaCents de la misma población.
 */
import { BadRequestError } from '../../../src/errors/AppError'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn() }, fiscalEmisor: { findFirst: jest.fn() }, expense: { findMany: jest.fn() } },
}))

import prisma from '../../../src/utils/prismaClient'
import { getDiot } from '../../../src/services/fiscal/diot.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  expense: { findMany: jest.Mock }
}

// Fila de gasto (lo que selecciona getDiot).
const g = (over: Record<string, unknown> = {}) => ({
  proveedorRfc: 'AAA010101AAA',
  proveedorNombre: 'Proveedor SA',
  tipoTercero: 'NACIONAL',
  ivaCents: 16_00,
  iva16Cents: 16_00,
  iva8Cents: 0,
  iva0BaseCents: 0,
  exentoBaseCents: 0,
  ivaRetenidoCents: 0,
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', type: 'AUTO_SERVICE' })
  p.fiscalEmisor.findFirst.mockResolvedValue(null)
  p.expense.findMany.mockResolvedValue([])
})

it('sin RFC → needsFiscalSetup', async () => {
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', rfc: null, type: 'AUTO_SERVICE' })
  const r = await getDiot('v1', '2026-06')
  expect(r.needsFiscalSetup).toBe(true)
  expect(p.expense.findMany).not.toHaveBeenCalled()
})

it('periodo inválido → BadRequestError', async () => {
  await expect(getDiot('v1', '2026-13')).rejects.toThrow(BadRequestError)
})

it('agrupa por proveedor, deriva base 16% y mapea código de tercero', async () => {
  p.expense.findMany.mockResolvedValue([
    g({ proveedorRfc: 'AAA010101AAA', ivaCents: 16_00, iva16Cents: 16_00 }),
    g({ proveedorRfc: 'AAA010101AAA', ivaCents: 32_00, iva16Cents: 32_00 }), // mismo proveedor → se suma
    g({ proveedorRfc: 'BBB020202BB2', proveedorNombre: 'Otro', tipoTercero: 'EXTRANJERO', ivaCents: 8_00, iva16Cents: 8_00 }),
  ])
  const r = await getDiot('v1', '2026-06')
  expect(r.rows).toHaveLength(2)
  const aaa = r.rows.find(x => x.proveedorRfc === 'AAA010101AAA')!
  expect(aaa.iva16Cents).toBe(48_00) // 16 + 32
  expect(aaa.base16Cents).toBe(300_00) // round(4800/0.16)=30000
  expect(aaa.tipoTerceroCodigo).toBe('04') // NACIONAL
  expect(aaa.comprobantes).toBe(2)
  const bbb = r.rows.find(x => x.proveedorRfc === 'BBB020202BB2')!
  expect(bbb.tipoTerceroCodigo).toBe('05') // EXTRANJERO
  expect(r.totals.proveedores).toBe(2)
  expect(r.totals.ivaAcreditableCents).toBe(56_00)
})

it('cross-check cuadraConIvaFlujo: Σ IVA acreditable == Σ ivaCents', async () => {
  p.expense.findMany.mockResolvedValue([
    g({ ivaCents: 16_00, iva16Cents: 16_00 }),
    g({ ivaCents: 8_00, iva16Cents: 8_00, proveedorRfc: 'CCC030303CC3' }),
  ])
  const r = await getDiot('v1', '2026-06')
  expect(r.cuadraConIvaFlujo).toBe(true)
  expect(r.totals.ivaAcreditableCents).toBe(24_00)
})

it('tasa mixta 16% + 8% en un mismo CFDI: reparte ambas bases', async () => {
  p.expense.findMany.mockResolvedValue([g({ ivaCents: 24_00, iva16Cents: 16_00, iva8Cents: 8_00 })])
  const r = await getDiot('v1', '2026-06')
  const row = r.rows[0]
  expect(row.iva16Cents).toBe(16_00)
  expect(row.base16Cents).toBe(100_00) // 1600/0.16
  expect(row.iva8Cents).toBe(8_00)
  expect(row.base8Cents).toBe(100_00) // 800/0.08
  expect(row.ivaAcreditableCents).toBe(24_00)
})

it('IVA sin desglose 16/8 → todo se asume 16%', async () => {
  p.expense.findMany.mockResolvedValue([g({ ivaCents: 16_00, iva16Cents: 0, iva8Cents: 0 })])
  const r = await getDiot('v1', '2026-06')
  expect(r.rows[0].iva16Cents).toBe(16_00)
})

it('retenciones, tasa 0 y exento se acumulan', async () => {
  p.expense.findMany.mockResolvedValue([g({ ivaRetenidoCents: 5_00, iva0BaseCents: 100_00, exentoBaseCents: 50_00 })])
  const r = await getDiot('v1', '2026-06')
  expect(r.rows[0].ivaRetenidoCents).toBe(5_00)
  expect(r.rows[0].base0Cents).toBe(100_00)
  expect(r.rows[0].exentoCents).toBe(50_00)
})

it('el filtro es PAID + acreditable + deducible + INGRESO + paidPeriod (por RFC)', async () => {
  await getDiot('v1', '2026-06')
  const where = p.expense.findMany.mock.calls[0][0].where
  expect(where).toMatchObject({
    rfc: 'EKU9003173C9',
    status: 'REGISTERED',
    comprobanteTipo: 'INGRESO',
    deducible: true,
    ivaAcreditable: true,
    paymentStatus: 'PAID',
    paidPeriod: '2026-06',
  })
})
