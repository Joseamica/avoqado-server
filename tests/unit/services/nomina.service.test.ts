/**
 * Unit tests para el cálculo de nómina (computePayrollLine, función pura).
 *  - ISR a retener = tarifa art-96 mensual − subsidio para el empleo (2026: $535.65 ≤ $11,492.66);
 *  - IMSS obrero = 2.375% del SBC;
 *  - subsidio ENTREGADO (sube el neto) cuando el subsidio excede al ISR (salario bajo);
 *  - escala por periodicidad (quincenal = mitad).
 */
import { computePayrollLine } from '../../../src/services/fiscal/nomina.service'

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
