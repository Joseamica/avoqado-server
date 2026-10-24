import { desgloseDeLiga, DescuentoDeLiga, ReglaDelCatalogo } from '../../../../src/services/dashboard/paymentLinkDiscount'

const ZONA = 'America/Mexico_City'
// Viernes 2026-10-23 12:00 hora de CDMX (UTC-6)
const AHORA = new Date('2026-10-23T18:00:00Z')

const manual = (type: DescuentoDeLiga['type'], value: number): DescuentoDeLiga => ({
  v: 1,
  origen: 'MANUAL',
  discountId: null,
  type,
  value,
  name: 'Descuento',
})
const catalogo = (type: DescuentoDeLiga['type'], value: number): DescuentoDeLiga => ({
  v: 1,
  origen: 'CATALOGO',
  discountId: 'cabcdefghijklmnopqrstuvwx',
  type,
  value,
  name: 'Promo',
})
const regla = (o: Partial<ReglaDelCatalogo> = {}): ReglaDelCatalogo => ({
  active: true,
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  existe: true,
  compatible: true,
  ...o,
})

describe('desgloseDeLiga', () => {
  it('sin foto no hay descuento', () => {
    expect(desgloseDeLiga(1000, null, null, AHORA, ZONA)).toEqual({
      base: 1000,
      descuento: 0,
      neto: 1000,
      aplica: false,
      motivo: null,
      nombre: null,
    })
  })

  it('MANUAL 15 % sobre 1000', () => {
    const d = desgloseDeLiga(1000, manual('PERCENTAGE', 15), null, AHORA, ZONA)
    expect([d.descuento, d.neto, d.aplica, d.motivo, d.nombre]).toEqual([150, 850, true, null, 'Descuento'])
  })

  it('MANUAL $150 sobre 1000', () => {
    const d = desgloseDeLiga(1000, manual('FIXED_AMOUNT', 150), null, AHORA, ZONA)
    expect([d.descuento, d.neto]).toEqual([150, 850])
  })

  it('MANUAL 15 % sobre 333.33 → 50.00 / 283.33', () => {
    const d = desgloseDeLiga(333.33, manual('PERCENTAGE', 15), null, AHORA, ZONA)
    expect([d.descuento, d.neto]).toEqual([50, 283.33])
  })

  it('MANUAL 1 % sobre 100.50 → 1.01 / 99.49 (mitad hacia arriba)', () => {
    const d = desgloseDeLiga(100.5, manual('PERCENTAGE', 1), null, AHORA, ZONA)
    expect([d.descuento, d.neto]).toEqual([1.01, 99.49])
  })

  it('MANUAL $150 sobre 100 no aplica (MINIMO)', () => {
    const d = desgloseDeLiga(100, manual('FIXED_AMOUNT', 150), null, AHORA, ZONA)
    expect([d.aplica, d.motivo, d.descuento, d.neto]).toEqual([false, 'MINIMO', 0, 100])
  })

  it('un descuento igual a la base tampoco aplica (neto 0)', () => {
    const d = desgloseDeLiga(100, manual('FIXED_AMOUNT', 100), null, AHORA, ZONA)
    expect([d.aplica, d.motivo, d.neto]).toEqual([false, 'MINIMO', 100])
  })

  it('CATALOGO vigente aplica', () => {
    const d = desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), regla(), AHORA, ZONA)
    expect([d.aplica, d.descuento, d.neto]).toEqual([true, 100, 900])
  })

  it('CATALOGO vencido (validUntil ayer) → VENCIDO', () => {
    const r = regla({ validUntil: new Date('2026-10-22T18:00:00Z') })
    const d = desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), r, AHORA, ZONA)
    expect([d.aplica, d.motivo, d.descuento, d.neto]).toEqual([false, 'VENCIDO', 0, 1000])
  })

  it('CATALOGO que aún no inicia → NO_INICIA', () => {
    const r = regla({ validFrom: new Date('2026-10-24T00:00:00Z') })
    expect(desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), r, AHORA, ZONA).motivo).toBe('NO_INICIA')
  })

  it('CATALOGO ya no compatible → INACTIVO', () => {
    const d = desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), regla({ compatible: false }), AHORA, ZONA)
    expect([d.aplica, d.motivo]).toEqual([false, 'INACTIVO'])
  })

  it('CATALOGO desactivado → INACTIVO', () => {
    expect(desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), regla({ active: false }), AHORA, ZONA).motivo).toBe('INACTIVO')
  })

  it('CATALOGO borrado (existe:false) → INACTIVO', () => {
    expect(desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), regla({ existe: false }), AHORA, ZONA).motivo).toBe('INACTIVO')
  })

  it('CATALOGO sin regla (null) → INACTIVO', () => {
    expect(desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), null, AHORA, ZONA).motivo).toBe('INACTIVO')
  })

  it('CATALOGO minPurchaseAmount 500 sobre 400 → MINIMO', () => {
    const d = desgloseDeLiga(400, catalogo('PERCENTAGE', 10), regla({ minPurchaseAmount: 500 }), AHORA, ZONA)
    expect([d.aplica, d.motivo, d.neto]).toEqual([false, 'MINIMO', 400])
  })

  it('CATALOGO maxDiscountAmount 100, 20 % sobre 1000 → 100', () => {
    const d = desgloseDeLiga(1000, catalogo('PERCENTAGE', 20), regla({ maxDiscountAmount: 100 }), AHORA, ZONA)
    expect([d.descuento, d.neto]).toEqual([100, 900])
  })

  it('CATALOGO lunes a viernes en sábado (CDMX) → FUERA_DE_HORARIO', () => {
    // viernes 23:00 CDMX = sábado 05:00Z
    const viernesNocheCdmx = new Date('2026-10-24T05:00:00Z')
    const r = regla({ daysOfWeek: [1, 2, 3, 4, 5] })
    expect(desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), r, viernesNocheCdmx, ZONA).aplica).toBe(true) // sigue siendo viernes allá
    const sabado = new Date('2026-10-24T18:00:00Z')
    expect(desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), r, sabado, ZONA).motivo).toBe('FUERA_DE_HORARIO')
  })

  it('CATALOGO con ventana horaria 18:00-22:00 a las 12:00 → FUERA_DE_HORARIO; a las 19:00 aplica', () => {
    const r = regla({ timeFrom: '18:00', timeUntil: '22:00' })
    expect(desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), r, AHORA, ZONA).motivo).toBe('FUERA_DE_HORARIO')
    const tarde = new Date('2026-10-24T01:00:00Z') // 19:00 CDMX
    expect(desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), r, tarde, ZONA).aplica).toBe(true)
  })

  it('CATALOGO FIXED mayor que la base no aplica (MINIMO)', () => {
    const d = desgloseDeLiga(100, catalogo('FIXED_AMOUNT', 150), regla(), AHORA, ZONA)
    expect([d.aplica, d.motivo, d.neto]).toEqual([false, 'MINIMO', 100])
  })

  it('tope 0 significa sin tope (como el POS): 20 % de 1000 → 200', () => {
    const d = desgloseDeLiga(1000, catalogo('PERCENTAGE', 20), regla({ maxDiscountAmount: 0 }), AHORA, ZONA)
    expect([d.aplica, d.descuento, d.neto]).toEqual([true, 200, 800])
  })

  it('descuento de valor 0 no aplica (MINIMO)', () => {
    const d = desgloseDeLiga(1000, catalogo('PERCENTAGE', 0), regla(), AHORA, ZONA)
    expect([d.aplica, d.motivo, d.descuento, d.neto]).toEqual([false, 'MINIMO', 0, 1000])
  })

  it('validUntil más tarde hoy, evaluado más temprano hoy → aplica', () => {
    const r = regla({ validUntil: new Date('2026-10-24T05:59:59Z') })
    expect(desgloseDeLiga(1000, catalogo('PERCENTAGE', 10), r, AHORA, ZONA).aplica).toBe(true)
  })
})
