/**
 * Unit tests para el builder del CFDI de nómina (buildPayrollReceiptParams, función pura).
 *  - mapea el cálculo a claves SAT: percepción 001, deducciones ISR(002)+IMSS(001), subsidio→otrosPagos(002);
 *  - periodicidad → c_PeriodicidadPago + días pagados; fechas del periodo; SDI fallback del SBC.
 */
import { buildPayrollReceiptParams } from '../../../src/services/fiscal/nominaCfdi.service'

const emp = (over: Record<string, unknown> = {}) =>
  ({
    id: 'emp-12345678abcdef',
    rfcEmpleado: 'JUAP900101AB1',
    nombre: 'Juan Pérez',
    curp: 'JUAP900101HDFXXX01',
    nss: '12345678901',
    puesto: 'Cajero',
    tipoContrato: '01',
    tipoRegimen: '02',
    claveEntFed: 'CMX',
    numEmpleado: null,
    registroPatronal: 'B5510768108',
    sbcMensualCents: 21_000_00,
    salarioDiarioIntegradoCents: null,
    fechaIngreso: new Date('2024-01-15T12:00:00Z'),
    ...over,
  }) as any

const line = (over: Record<string, unknown> = {}) =>
  ({
    id: 'line-1',
    percepcionGravadaCents: 20_000_00,
    percepcionExentaCents: 0,
    isrCents: 2_604_00,
    imssObreroCents: 475_00,
    subsidioCents: 0,
    otrasDeduccionesCents: 0,
    ...over,
  }) as any

const run = (over: Record<string, unknown> = {}) =>
  ({ period: '2026-06', periodicidad: 'MENSUAL', fechaPago: new Date('2026-06-30T12:00:00Z'), ...over }) as any

describe('buildPayrollReceiptParams', () => {
  it('mapea percepción 001, deducciones ISR(002)+IMSS(001), periodicidad y fechas', () => {
    const p = buildPayrollReceiptParams(emp(), line(), run(), '06700')
    expect(p.percepciones).toEqual([
      { clave: '001', concepto: 'Sueldos, Salarios Rayas y Jornales', gravadoCents: 20_000_00, exentoCents: 0 },
    ])
    expect(p.deducciones).toEqual([
      { clave: '002', concepto: 'ISR', importeCents: 2_604_00 },
      { clave: '001', concepto: 'Seguridad social (IMSS)', importeCents: 475_00 },
    ])
    expect(p.receptor.periodicidadPago).toBe('04') // MENSUAL
    expect(p.numDiasPagados).toBe(30)
    expect(p.fechaInicialPago).toBe('2026-06-01')
    expect(p.fechaFinalPago).toBe('2026-06-30')
    expect(p.fechaPago).toBe('2026-06-30')
    expect(p.tipoNomina).toBe('O')
    expect(p.idempotencyKey).toBe('payroll-cfdi:line-1:v1')
  })

  it('omite deducciones en cero (no emite ISR=0)', () => {
    const p = buildPayrollReceiptParams(emp(), line({ isrCents: 0, imssObreroCents: 118_75 }), run(), '06700')
    expect(p.deducciones).toEqual([{ clave: '001', concepto: 'Seguridad social (IMSS)', importeCents: 118_75 }])
  })

  it('subsidio > 0 → otrosPagos clave 002 con subsidio causado', () => {
    const p = buildPayrollReceiptParams(emp(), line({ isrCents: 0, subsidioCents: 535_65 }), run(), '06700')
    expect(p.otrosPagos).toEqual([
      { clave: '002', concepto: 'Subsidio para el empleo', importeCents: 535_65, subsidioCausadoCents: 535_65 },
    ])
  })

  it('sin subsidio → otrosPagos vacío', () => {
    expect(buildPayrollReceiptParams(emp(), line(), run(), '06700').otrosPagos).toEqual([])
  })

  it('numEmpleado fallback = últimos 8 chars del id; receptor + registro patronal', () => {
    const p = buildPayrollReceiptParams(emp({ numEmpleado: null }), line(), run(), '06700')
    expect(p.receptor.numEmpleado).toBe('5678abcdef'.slice(-8))
    expect(p.receptor.claveEntFed).toBe('CMX')
    expect(p.receptor.codigoPostal).toBe('06700')
    expect(p.registroPatronal).toBe('B5510768108')
    expect(p.receptor.fechaInicioRelLaboral).toBe('2024-01-15')
  })

  it('SDI fallback = SBC/30 cuando no se captura', () => {
    const p = buildPayrollReceiptParams(emp({ salarioDiarioIntegradoCents: null, sbcMensualCents: 21_000_00 }), line(), run(), '06700')
    expect(p.receptor.salarioDiarioIntegradoCents).toBe(Math.round(21_000_00 / 30))
  })

  it('quincenal → c_PeriodicidadPago 03, 15 días', () => {
    const p = buildPayrollReceiptParams(emp(), line(), run({ periodicidad: 'QUINCENAL' }), '06700')
    expect(p.receptor.periodicidadPago).toBe('03')
    expect(p.numDiasPagados).toBe(15)
  })
})
