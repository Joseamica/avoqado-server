/**
 * Unit tests para el cálculo de nómina (computePayrollLine, función pura) y la orquestación
 * runPayroll (atomicidad corrida+líneas, recuperación de corridas DRAFT atascadas, idempotencia).
 *  - ISR a retener = tarifa art-96 mensual − subsidio para el empleo (2026: $535.65 ≤ $11,492.66);
 *  - IMSS obrero = 2.375% del SBC;
 *  - subsidio ENTREGADO (sube el neto) cuando el subsidio excede al ISR (salario bajo);
 *  - escala por periodicidad (quincenal = mitad).
 */
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    employee: { findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    payrollRun: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    payrollLine: { createMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('../../../src/services/fiscal/journalEntry.service', () => ({ postJournalEntry: jest.fn() }))
jest.mock('../../../src/services/fiscal/accountMapping.service', () => ({ getMappings: jest.fn() }))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { computePayrollLine, computePayrollPreview, runPayroll } from '../../../src/services/fiscal/nomina.service'
import prisma from '../../../src/utils/prismaClient'
import { postJournalEntry } from '../../../src/services/fiscal/journalEntry.service'
import { getMappings } from '../../../src/services/fiscal/accountMapping.service'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'

describe('computePayrollLine', () => {
  it('$20,000/mes (sin subsidio): ISR retenido = tarifa art-96, IMSS 2.375%, neto', () => {
    const r = computePayrollLine({ salarioMensualBrutoCents: 20_000_00, periodicidad: 'MENSUAL' })
    expect(r.totalPercepcionesCents).toBe(20_000_00)
    expect(r.subsidioCents).toBe(0) // > $11,492.66 → sin subsidio
    expect(r.isrRetenidoCents).toBe(2_604_00) // applyTariff($20k) verificado
    expect(r.imssObreroCents).toBe(475_00) // 20,000 × 2.375%
    expect(r.subsidioEntregadoCents).toBe(0)
    expect(r.netoCents).toBe(16_921_00) // 20,000 − 2,604 − 475
  })

  it('$5,000/mes (subsidio > ISR): isrRetenido 0 + subsidio ENTREGADO sube el neto', () => {
    const r = computePayrollLine({ salarioMensualBrutoCents: 5_000_00, periodicidad: 'MENSUAL' })
    expect(r.subsidioCents).toBe(535_65)
    expect(r.isrRetenidoCents).toBe(0) // ISR ($286.57) < subsidio ($535.65)
    expect(r.subsidioEntregadoCents).toBe(535_65 - 286_57) // 249.08
    expect(r.imssObreroCents).toBe(118_75) // 5,000 × 2.375%
    // neto = 5000 − 0 − 118.75 + 249.08 = 5,130.33
    expect(r.netoCents).toBe(5_130_33)
  })

  it('el asiento cuadra: percepciones + subsidioEntregado == isrRet + imss + neto', () => {
    for (const salario of [3_000_00, 8_000_00, 12_000_00, 20_000_00, 50_000_00]) {
      const r = computePayrollLine({ salarioMensualBrutoCents: salario, periodicidad: 'MENSUAL' })
      const debe = r.totalPercepcionesCents + r.subsidioEntregadoCents
      const haber = r.isrRetenidoCents + r.imssObreroCents + r.netoCents
      expect(debe).toBe(haber)
    }
  })

  it('usa el SBC para IMSS si se provee (distinto del bruto)', () => {
    const r = computePayrollLine({ salarioMensualBrutoCents: 20_000_00, sbcMensualCents: 21_000_00, periodicidad: 'MENSUAL' })
    expect(r.imssObreroCents).toBe(498_75) // 21,000 × 2.375%
  })

  it('quincenal = mitad de la percepción mensual', () => {
    const mensual = computePayrollLine({ salarioMensualBrutoCents: 20_000_00, periodicidad: 'MENSUAL' })
    const quincenal = computePayrollLine({ salarioMensualBrutoCents: 20_000_00, periodicidad: 'QUINCENAL' })
    expect(quincenal.totalPercepcionesCents).toBe(mensual.totalPercepcionesCents / 2)
  })
})

const p = prisma as unknown as {
  employee: { findMany: jest.Mock }
  venue: { findUnique: jest.Mock }
  payrollRun: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock }
  payrollLine: { createMany: jest.Mock }
  $transaction: jest.Mock
}
const mPost = postJournalEntry as jest.Mock
const mMappings = getMappings as jest.Mock
const mScope = resolveScopeOrNull as jest.Mock

const PAYROLL_MAP = {
  mappings: ['PAYROLL_SALARIES', 'ISR_PAYROLL_WITHHELD', 'IMSS_PAYABLE', 'SALARIES_PAYABLE'].map(m => ({
    movementType: m,
    account: { id: 'acc-' + m },
  })),
}

// Totales persistidos de una corrida de 1 empleado $20k MENSUAL (verificados arriba en computePayrollLine).
const existingRun = (over: Record<string, unknown> = {}) => ({
  id: 'run1',
  organizationId: 'org1',
  rfc: 'EKU9003173C9',
  venueId: 'v1',
  period: '2026-06',
  periodicidad: 'MENSUAL',
  fechaPago: new Date('2026-06-28T12:00:00.000Z'),
  empleados: 1,
  posted: false,
  journalEntryId: null,
  status: 'DRAFT',
  totalPercepcionesCents: 20_000_00,
  totalIsrCents: 2_604_00,
  totalSubsidioCents: 0,
  totalImssObreroCents: 475_00,
  totalNetoCents: 16_921_00,
  ...over,
})

describe('computePayrollPreview — filtra por periodicidad del empleado', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'AUTO_SERVICE' })
    p.employee.findMany.mockResolvedValue([])
  })

  it('una corrida SEMANAL sólo considera empleados con periodicidadPago SEMANAL (no barre a los mensuales)', async () => {
    await computePayrollPreview('v1', '2026-06', 'SEMANAL')
    expect(p.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ periodicidadPago: 'SEMANAL', activo: true }) }),
    )
  })

  it('una corrida MENSUAL sólo considera empleados MENSUAL', async () => {
    await computePayrollPreview('v1', '2026-06', 'MENSUAL')
    expect(p.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ periodicidadPago: 'MENSUAL' }) }),
    )
  })
})

describe('runPayroll — atomicidad y recuperación', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'AUTO_SERVICE' })
    mMappings.mockResolvedValue(PAYROLL_MAP)
    p.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    p.employee.findMany.mockResolvedValue([
      { id: 'e1', nombre: 'Ana', rfcEmpleado: 'XAXX010101000', salarioMensualBrutoCents: 20_000_00, sbcMensualCents: null, activo: true },
    ])
    p.payrollRun.create.mockResolvedValue(existingRun({ posted: false }))
    p.payrollRun.update.mockResolvedValue({})
    p.payrollLine.createMany.mockResolvedValue({})
    p.$transaction.mockImplementation(async (cb: any) => cb(p)) // tx interactiva → ejecuta con el mismo mock
    mPost.mockResolvedValue({ id: 'je-pay' })
  })

  it('corrida previa SIN postear (DRAFT) → re-postea la póliza y la marca POSTED (no la deja atascada)', async () => {
    p.payrollRun.findUnique.mockResolvedValue(existingRun({ posted: false }))
    const r = await runPayroll('v1', '2026-06', 'MENSUAL', '2026-06-28', { staffId: 's' })
    expect(mPost).toHaveBeenCalledTimes(1)
    expect(mPost.mock.calls[0][1].idempotencyKey).toBe('payroll:run1:v1')
    // la póliza reconstruida SÓLO desde los totales persistidos cuadra (Σdebe == Σhaber)
    const lines = mPost.mock.calls[0][1].lines
    const debe = lines.reduce((n: number, l: any) => n + l.debitCents, 0)
    const haber = lines.reduce((n: number, l: any) => n + l.creditCents, 0)
    expect(debe).toBe(haber)
    expect(p.payrollRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run1' },
        data: expect.objectContaining({ posted: true, status: 'POSTED', journalEntryId: 'je-pay' }),
      }),
    )
    expect(p.payrollRun.create).not.toHaveBeenCalled() // NO crea una segunda corrida
    expect(r.posted).toBe(true)
    expect(r.alreadyExists).toBe(true)
  })

  it('corrida previa YA posteada → no re-postea (idempotente)', async () => {
    p.payrollRun.findUnique.mockResolvedValue(existingRun({ posted: true, journalEntryId: 'je-old', status: 'POSTED' }))
    const r = await runPayroll('v1', '2026-06', 'MENSUAL', '2026-06-28', { staffId: 's' })
    expect(mPost).not.toHaveBeenCalled()
    expect(p.payrollRun.update).not.toHaveBeenCalled()
    expect(p.payrollRun.create).not.toHaveBeenCalled()
    expect(r.alreadyExists).toBe(true)
    expect(r.posted).toBe(true)
  })

  it('corrida nueva → crea corrida + líneas en UNA transacción, postea y marca POSTED', async () => {
    p.payrollRun.findUnique.mockResolvedValue(null)
    const r = await runPayroll('v1', '2026-06', 'MENSUAL', '2026-06-28', { staffId: 's' })
    expect(p.$transaction).toHaveBeenCalledTimes(1) // create + createMany atómicos (nunca corrida sin líneas)
    expect(p.payrollRun.create).toHaveBeenCalled()
    expect(p.payrollLine.createMany).toHaveBeenCalled()
    expect(mPost).toHaveBeenCalledTimes(1)
    const lines = mPost.mock.calls[0][1].lines
    expect(lines.reduce((n: number, l: any) => n + l.debitCents, 0)).toBe(lines.reduce((n: number, l: any) => n + l.creditCents, 0))
    expect(p.payrollRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ posted: true, status: 'POSTED' }) }),
    )
    expect(r.posted).toBe(true)
  })

  it('corrida nueva: si la póliza FALLA, la corrida NO se marca POSTED (queda DRAFT, recuperable)', async () => {
    p.payrollRun.findUnique.mockResolvedValue(null)
    mPost.mockRejectedValueOnce(new Error('serialization failure'))
    await expect(runPayroll('v1', '2026-06', 'MENSUAL', '2026-06-28', { staffId: 's' })).rejects.toThrow()
    expect(p.payrollRun.update).not.toHaveBeenCalled() // nunca POSTED sin póliza
  })
})
