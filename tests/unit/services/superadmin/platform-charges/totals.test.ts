import { computeChargeTotals, conceptToCfdiLine, hasSatKeys } from '@/services/superadmin/platform-charges/totals'
import type { ChargeConcept } from '@/services/superadmin/platform-charges/types'

/**
 * «Por cobrar» — totales al centavo (spec 2026-11-02-por-cobrar-superadmin §3.2).
 * Se suman las partes SIN redondear y se redondea al final, como lo hace el PAC (guarda cada concepto con 6 decimales y
 * redondea los totales). Con A = suma de montos sin IVA y B = suma de montos con IVA, en centavos:
 *   subtotal = redondear(A + B·100/116) · iva = redondear(A·16/100 + B·16/116) · total = subtotal + iva
 * Esta MISMA tabla de casos vive en la prueba del espejo de SUPERADMIN (`charge-totals`): si cambia aquí, cambia allá.
 */

const sinIva = (amountCents: number): ChargeConcept => ({
  description: 'Renta de terminal',
  amountCents,
  ivaMode: 'WITHOUT_IVA',
  satProductKey: '81112401',
  satUnitKey: 'E48',
})
const conIva = (amountCents: number): ChargeConcept => ({
  description: 'Licencia',
  amountCents,
  ivaMode: 'WITH_IVA',
  satProductKey: '43232611',
  satUnitKey: 'E48',
})

describe('platform-charges/totals — computeChargeTotals (NEW)', () => {
  // A = sin IVA, B = con IVA. Esperado: { subtotalCents, taxCents, totalCents }.
  it.each([
    { nombre: 'A 50000 (se le suma el 16 %: deposita $580)', conceptos: [sinIva(50000)], esperado: [50000, 8000, 58000] },
    {
      nombre: 'B 50000 (ya trae el IVA: deposita $500 = base 431.03 + IVA 68.97)',
      conceptos: [conIva(50000)],
      esperado: [43103, 6897, 50000],
    },
    {
      nombre: 'B 49900 + B 50000 (se suma sin redondear y se redondea al final)',
      conceptos: [conIva(49900), conIva(50000)],
      esperado: [86121, 13779, 99900],
    },
    { nombre: 'A 50000 + B 99900 (mezcla)', conceptos: [sinIva(50000), conIva(99900)], esperado: [136121, 21779, 157900] },
    {
      nombre: 'A 3333 + A 3333 (la suma que delata el redondeo renglón por renglón)',
      conceptos: [sinIva(3333), sinIva(3333)],
      esperado: [6666, 1067, 7733],
    },
    { nombre: 'B 3333 + B 3333', conceptos: [conIva(3333), conIva(3333)], esperado: [5747, 919, 6666] },
    { nombre: 'A 1 (un centavo: el IVA se redondea a 0)', conceptos: [sinIva(1)], esperado: [1, 0, 1] },
    {
      nombre: 'A 999999999 (el monto más grande de un concepto)',
      conceptos: [sinIva(999999999)],
      esperado: [999999999, 160000000, 1159999999],
    },
  ])('$nombre', ({ conceptos, esperado }) => {
    expect(computeChargeTotals(conceptos)).toEqual({ subtotalCents: esperado[0], taxCents: esperado[1], totalCents: esperado[2] })
  })

  it('el orden de los conceptos no cambia el total', () => {
    const uno = computeChargeTotals([sinIva(3333), conIva(49900), sinIva(1), conIva(50000)])
    const otro = computeChargeTotals([conIva(50000), sinIva(1), conIva(49900), sinIva(3333)])
    expect(otro).toEqual(uno)
  })

  it('redondea al centavo más cercano: el IVA de 4.48 baja a 4, el de 4.96 sube a 5 y el de 4.00 se queda', () => {
    expect(computeChargeTotals([sinIva(28)]).taxCents).toBe(4)
    expect(computeChargeTotals([sinIva(31)]).taxCents).toBe(5)
    expect(computeChargeTotals([sinIva(25)]).taxCents).toBe(4)
    expect(computeChargeTotals([sinIva(3125)])).toEqual({ subtotalCents: 3125, taxCents: 500, totalCents: 3625 })
    expect(computeChargeTotals([sinIva(3)])).toEqual({ subtotalCents: 3, taxCents: 0, totalCents: 3 })
  })

  it('rechaza un cobro sin conceptos (sin concepto no hay cobro)', () => {
    expect(() => computeChargeTotals([])).toThrow(/al menos un concepto/)
  })

  it.each<[string, number]>([
    ['cero', 0],
    ['negativo', -500],
    ['con decimales (pesos tecleados donde van centavos)', 33.33],
    ['NaN', Number.NaN],
    ['infinito', Number.POSITIVE_INFINITY],
    ['un texto', '50000' as unknown as number],
  ])('rechaza un monto %s en vez de firmar un total que miente', (_nombre, monto) => {
    expect(() => computeChargeTotals([sinIva(monto)])).toThrow(/entero positivo de centavos/)
  })

  it('rechaza un modo de IVA que no conoce (el JSON de la base puede traer cualquier cosa)', () => {
    const raro = { ...sinIva(50000), ivaMode: 'WITHOUT-IVA' } as unknown as ChargeConcept
    expect(() => computeChargeTotals([raro])).toThrow(/modo de IVA/)
  })

  it('rechaza una suma tan grande que los enteros de JavaScript dejarían de ser exactos', () => {
    expect(() => computeChargeTotals([sinIva(100_000_000_001)])).toThrow(/demasiado grande/)
    expect(() => computeChargeTotals([conIva(100_000_000_001)])).toThrow(/demasiado grande/)
    // el tope mismo sí se calcula, y exacto
    expect(computeChargeTotals([sinIva(100_000_000_000)])).toEqual({
      subtotalCents: 100_000_000_000,
      taxCents: 16_000_000_000,
      totalCents: 116_000_000_000,
    })
  })
})

describe('platform-charges/totals — invariantes (REGRESSION)', () => {
  it('con IVA: el total es SIEMPRE el monto tecleado, al centavo (1 a 5000 centavos)', () => {
    for (let monto = 1; monto <= 5000; monto++) {
      const { subtotalCents, taxCents, totalCents } = computeChargeTotals([conIva(monto)])
      expect(totalCents).toBe(monto)
      expect(subtotalCents + taxCents).toBe(totalCents)
    }
  })

  it('sin IVA: el subtotal es el monto y el IVA es el 16 % redondeado (1 a 5000 centavos)', () => {
    for (let monto = 1; monto <= 5000; monto++) {
      const { subtotalCents, taxCents, totalCents } = computeChargeTotals([sinIva(monto)])
      expect(subtotalCents).toBe(monto)
      expect(taxCents).toBe(Math.floor((monto * 32 + 100) / 200)) // oráculo entero con OTRO denominador: redondear(monto·16/100)
      expect(totalCents).toBe(subtotalCents + taxCents)
    }
  })

  it('siempre devuelve enteros, y el total es subtotal + IVA (mezclas con montos feos)', () => {
    const montos = [1, 7, 99, 333, 3333, 4999, 12345, 99999, 123456789]
    for (const a of montos) {
      for (const b of montos) {
        const totales = computeChargeTotals([sinIva(a), conIva(b)])
        for (const valor of Object.values(totales)) expect(Number.isInteger(valor)).toBe(true)
        expect(totales.totalCents).toBe(totales.subtotalCents + totales.taxCents)
      }
    }
  })

  it('no modifica los conceptos que recibe', () => {
    const conceptos = [sinIva(50000), conIva(99900)]
    const copia = JSON.parse(JSON.stringify(conceptos))
    computeChargeTotals(conceptos)
    expect(conceptos).toEqual(copia)
  })
})

describe('platform-charges/totals — conceptToCfdiLine (NEW)', () => {
  it('sin IVA: una unidad, 16 %, el precio es la base (taxIncluded false)', () => {
    expect(conceptToCfdiLine(sinIva(50000))).toEqual({
      description: 'Renta de terminal',
      satProductKey: '81112401',
      satUnitKey: 'E48',
      quantity: 1,
      unitPriceCents: 50000,
      taxRate: 0.16,
      taxIncluded: false,
    })
  })

  it('con IVA: el mismo monto, pero el precio ya trae el IVA (taxIncluded true)', () => {
    expect(conceptToCfdiLine(conIva(99900))).toEqual({
      description: 'Licencia',
      satProductKey: '43232611',
      satUnitKey: 'E48',
      quantity: 1,
      unitPriceCents: 99900,
      taxRate: 0.16,
      taxIncluded: true,
    })
  })
})

describe('platform-charges/totals — hasSatKeys (NEW)', () => {
  it('con las dos claves, sí', () => {
    expect(hasSatKeys({ satProductKey: '81112401', satUnitKey: 'E48' })).toBe(true)
  })

  it.each([
    ['las dos vacías', '', ''],
    ['sin clave de producto', '', 'E48'],
    ['sin unidad', '81112401', ''],
    ['una clave de puros espacios no es una clave', '   ', 'E48'],
    ['una unidad de puros espacios tampoco', '81112401', '  '],
  ])('%s: no', (_caso, satProductKey, satUnitKey) => {
    expect(hasSatKeys({ satProductKey, satUnitKey })).toBe(false)
  })

  it('un concepto viejo de la base sin esas llaves tampoco truena', () => {
    expect(hasSatKeys({} as never)).toBe(false)
  })
})
