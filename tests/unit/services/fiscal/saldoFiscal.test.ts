/**
 * 🔴 DINERO FISCAL — C2 Tarea 4: lo fiscal de un documento se REPARTE con la regla del PAC (`asignacionFiscal`), por tratamiento y por
 * clave, del payload o del XML; el cotejo concepto por concepto; lo que queda; si una nota cabe (redondeo por componente y ámbito); y el
 * reparto de una devolución por modalidad sobre lo que queda (Codex C2-3/C2-4/C2-8/C2-9/C2-10/C2-12/C2-14/C2-15/C2-17/C2-18/C2-19/C2-23).
 */
import {
  asignacionFiscal,
  cabeEnElSaldo,
  cotejarConElXml,
  documentoDeConceptos as documentoDeConceptosOInvalido,
  documentoDelXml,
  leerXmlConceptos,
  repartirPorTasa,
  repartirSobreLoQueQueda,
  repartoDeLaDevolucion,
  resumenDeConceptos as resumenDeConceptosOInvalido,
  resumenDelXml,
  restar,
  unidadesDeConceptos as unidadesDeConceptosOInvalido,
  unidadesDelXml,
  MAX_AJUSTE_DOCUMENTO_CENTS,
  MOTIVO_CONCEPTO_REGALADO,
  MOTIVO_IMPORTE_DEVUELTO_INVALIDO,
  MOTIVO_SALDO_DEL_DOCUMENTO,
  MOTIVO_TASA_NO_SOPORTADA,
  MOTIVO_XML_NO_CUADRA,
  type Asignacion,
  type ResumenFiscal,
  type ConceptoDelXml,
  type DocumentoFiscal,
  type Unidad,
  type XmlConceptos,
} from '../../../../src/services/fiscal/saldoFiscal'

// Ronda 1 (M-5): los lectores del payload ya no lanzan con una tasa fuera de 16/8/0: devuelven `{ invalido }`. Aquí se ven con el tipo
// de antes para que las pruebas del plan queden tal cual; en tiempo de ejecución es la MISMA función (sólo cambia el tipo).
const unidadesDeConceptos = (items: any[], claveDe: (i: number) => string) => unidadesDeConceptosOInvalido(items, claveDe) as Unidad[]
const resumenDeConceptos = (items: any[]) => resumenDeConceptosOInvalido(items) as ResumenFiscal
const documentoDeConceptos = (items: any[]) => documentoDeConceptosOInvalido(items) as DocumentoFiscal // ronda 2 (M-B2)

const incluido = (cents: number, factor: 'Tasa' | 'Exento' | null, rate = 0, discountCents = 0) => ({
  satProductKey: '84111506',
  satUnitKey: 'ACT',
  description: 'x',
  quantity: 1,
  unitPriceCents: cents,
  discountCents,
  taxIncluded: true,
  objetoImp: factor ? '02' : '01',
  taxes: factor ? [{ type: 'IVA' as const, factor, rate, withholding: false }] : [],
})
const asig = (items: any[], claveDe = (i: number) => `a${i}`) =>
  asignacionFiscal(unidadesDeConceptos(items, claveDe), documentoDeConceptos(items), resumenDeConceptos(items)) as Asignacion
const totalDe = (a: Asignacion) => [...a.porClave.values()].flatMap(m => Object.values(m)).reduce((s, c) => s + c!.totalCents, 0)
const sumaDe = (a: Asignacion, t: string, k: 'baseCents' | 'ivaCents') =>
  [...a.porClave.values()].reduce((s, m) => s + ((m as any)[t]?.[k] ?? 0), 0)

describe('C2 · asignacionFiscal — el documento se reparte, no se recalcula (Codex C2-10)', () => {
  it('🔴 $65 IVA incluido con $2.49 de descuento ⇒ el total del documento (62.50), no la suma neta (62.51); con $2.50 ⇒ 62.49', () => {
    const items = [incluido(6500, 'Tasa', 0.16, 249)]
    expect(documentoDeConceptos(items).totalCents).toBe(6250) // medido por Codex con el calculador real
    const a = asig(items)
    expect(a.porTratamiento.IVA_16).toEqual({
      baseCents: resumenDeConceptos(items).IVA_16!.baseCents,
      ivaCents: resumenDeConceptos(items).IVA_16!.ivaCents,
      totalCents: 6250,
    })
    expect(a.ajustePorTratamiento).toEqual({ IVA_16: -1 }) // el ajuste necesario del caso $62.50 se conserva (C2-23 no lo quita)
    expect(asig([incluido(6500, 'Tasa', 0.16, 250)]).porTratamiento.IVA_16!.totalCents).toBe(6249)
  })
  it('🔴 C2-23 (Codex): A $65 − $2.48 al 16 % (el descuento que dejó la 6b) + B $100 al 0 %, documento $162.51 ⇒ el centavo se queda en el 16 %, de donde sale; el 0 % conserva sus $100 y devolverlos cabe', () => {
    const items = [incluido(6500, 'Tasa', 0.16, 248), incluido(10000, 'Tasa', 0)]
    const a = asig(items, i => (i === 0 ? 'A' : 'B'))
    expect(documentoDeConceptos(items).totalCents).toBe(16251)
    expect(a.porTratamiento.IVA_0).toEqual({ baseCents: 10000, ivaCents: 0, totalCents: 10000 })
    expect(a.porTratamiento.IVA_16).toMatchObject({
      baseCents: resumenDeConceptos(items).IVA_16!.baseCents,
      ivaCents: resumenDeConceptos(items).IVA_16!.ivaCents,
      totalCents: 6251,
    })
    expect(a.ajustePorTratamiento).toEqual({ IVA_16: -1 }) // v4 decía { IVA_0: -1 }: el 0 % quedaba en $99.99
    expect(a.porClave.get('B')).toEqual({ IVA_0: { baseCents: 10000, ivaCents: 0, totalCents: 10000 } })
    expect(cabeEnElSaldo(asig([incluido(10000, 'Tasa', 0)]).porTratamiento, a.porTratamiento, 'FACTURA')).toEqual({
      ok: true,
      redondeo: [],
    })
  })
  it('🔴 propiedad: en cientos de documentos (una tasa, dos artículos, mezclado y un artículo con un extra a otra tasa) la suma de las asignaciones ES el documento y la base/IVA de cada tasa ES el resumen', () => {
    const mezclas = [
      (p: number, d: number) => [incluido(p, 'Tasa', 0.16, d)],
      (p: number, d: number) => [incluido(p, 'Tasa', 0.16, d), incluido(p + 37, 'Tasa', 0.16)],
      (p: number, d: number) => [
        incluido(p, 'Tasa', 0.16, d),
        incluido(p + 11, 'Tasa', 0),
        incluido(p + 23, 'Exento'),
        incluido(p + 5, null),
      ],
      (p: number, d: number) => [incluido(p, 'Tasa', 0.16, d), incluido(p + 3, 'Tasa', 0)],
    ]
    for (let p = 100; p <= 30000; p += 997)
      for (const d of [0, 1, 49, 99])
        for (const [k, m] of mezclas.entries()) {
          const items = m(p, d)
          const a = asig(items, k === 3 ? () => 'A' : i => `a${i}`) // el 4.º: los dos conceptos son del MISMO artículo
          expect(totalDe(a)).toBe(documentoDeConceptos(items).totalCents)
          for (const [t, r] of Object.entries(resumenDeConceptos(items))) {
            expect(sumaDe(a, t, 'baseCents')).toBe(r!.baseCents)
            expect(sumaDe(a, t, 'ivaCents')).toBe(r!.ivaCents)
          }
          expect(Object.values(a.ajustePorTratamiento).every(c => Math.abs(c!) <= MAX_AJUSTE_DOCUMENTO_CENTS)).toBe(true)
        }
  })
  it('🔴 6b corregida, rama D = 0 con r6(Bq·t) < T − Bq (160 × 1 y 50 × 2 al 16 % IVA incluido): la asignación sigue siendo el documento', () => {
    for (const items of [[incluido(16000, 'Tasa', 0.16)], [{ ...incluido(5000, 'Tasa', 0.16), quantity: 2 }]]) {
      const a = asig(items)
      expect(documentoDeConceptos(items).totalCents).toBe(items[0].unitPriceCents * items[0].quantity) // el PAC da T exacto en esta rama
      expect(totalDe(a)).toBe(documentoDeConceptos(items).totalCents)
      expect(a.porTratamiento.IVA_16).toMatchObject({
        baseCents: resumenDeConceptos(items).IVA_16!.baseCents,
        ivaCents: resumenDeConceptos(items).IVA_16!.ivaCents,
      })
    }
  })
  it('$0.08 al 16 % ⇒ base 0.07, IVA 0.01, total 0.08; mezclado 16/0/exento/no objeto ⇒ cada uno el suyo', () => {
    expect(asig([incluido(8, 'Tasa', 0.16)]).porTratamiento).toEqual({ IVA_16: { baseCents: 7, ivaCents: 1, totalCents: 8 } })
    expect(
      asig([incluido(10000, 'Tasa', 0.16), incluido(5000, 'Tasa', 0), incluido(3000, 'Exento'), incluido(2000, null)]).porTratamiento,
    ).toEqual({
      IVA_16: { baseCents: 8621, ivaCents: 1379, totalCents: 10000 },
      IVA_0: { baseCents: 5000, ivaCents: 0, totalCents: 5000 },
      EXENTO: { baseCents: 3000, ivaCents: 0, totalCents: 3000 },
      NO_OBJETO: { baseCents: 2000, ivaCents: 0, totalCents: 2000 },
    })
  })
  it('un concepto de la global con varias bases se cuenta por parte (C1)', () => {
    const mezclado = {
      satProductKey: '01010101',
      satUnitKey: 'ACT',
      description: 'Venta',
      quantity: 1,
      unitPriceCents: 25000,
      discountCents: 0,
      taxIncluded: false,
      objetoImp: '02',
      taxes: [
        { type: 'IVA' as const, factor: 'Tasa' as const, rate: 0.16, withholding: false, base: '50.000000' },
        { type: 'IVA' as const, factor: 'Tasa' as const, rate: 0, withholding: false, base: '200.000000' },
      ],
    }
    expect(asig([mezclado]).porTratamiento).toEqual({
      IVA_16: { baseCents: 5000, ivaCents: 800, totalCents: 5800 },
      IVA_0: { baseCents: 20000, ivaCents: 0, totalCents: 20000 },
    })
  })
  it('un resumen que no es el de esas unidades ⇒ inválido (no se reparte a ciegas)', () => {
    const items = [incluido(10000, 'Tasa', 0.16)]
    expect(
      asignacionFiscal(
        unidadesDeConceptos(items, () => 'a'),
        documentoDeConceptos(items),
        { IVA_16: { baseCents: 8622, ivaCents: 1379 } },
      ),
    ).toMatchObject({ invalido: expect.any(String) })
    expect(
      asignacionFiscal(
        unidadesDeConceptos(items, () => 'a'),
        documentoDeConceptos(items),
        {
          ...resumenDeConceptos(items),
          IVA_0: { baseCents: 1, ivaCents: 0 },
        },
      ),
    ).toMatchObject({ invalido: expect.any(String) })
  })
})

describe('C2-17 · base e IVA salen de UN solo reparto: cada ticket conserva lo que cobró', () => {
  it('🔴 dos tickets de $100 al 16 % IVA incluido ⇒ $100.00 y $100.00 (86.20/13.80 y 86.21/13.79), no 100.01/99.99', () => {
    const a = asig([incluido(10000, 'Tasa', 0.16), incluido(10000, 'Tasa', 0.16)], i => (i === 0 ? 'A' : 'B'))
    expect(a.porTratamiento.IVA_16).toEqual({ baseCents: 17241, ivaCents: 2759, totalCents: 20000 })
    expect(a.porClave.get('A')).toEqual({ IVA_16: { baseCents: 8620, ivaCents: 1380, totalCents: 10000 } })
    expect(a.porClave.get('B')).toEqual({ IVA_16: { baseCents: 8621, ivaCents: 1379, totalCents: 10000 } })
  })
  it('🔴 devolver el total de cada ticket cabe en su ticket y en el documento (la segunda agota con su centavo declarado)', () => {
    const a = asig([incluido(10000, 'Tasa', 0.16), incluido(10000, 'Tasa', 0.16)], i => (i === 0 ? 'A' : 'B'))
    const nota = asig([incluido(10000, 'Tasa', 0.16)]).porTratamiento // la nota de $100 sola: 86.21/13.79
    for (const t of ['A', 'B']) expect(cabeEnElSaldo(nota, a.porClave.get(t)!, 'TICKET')).toMatchObject({ ok: true })
    expect(cabeEnElSaldo(nota, a.porTratamiento, 'DOCUMENTO_GLOBAL')).toEqual({ ok: true, redondeo: [] })
    expect(cabeEnElSaldo(nota, restar(a.porTratamiento, [nota], 0), 'DOCUMENTO_GLOBAL')).toMatchObject({
      ok: true,
      redondeo: [{ componente: 'BASE', cents: 1 }],
    })
  })
  it('🔴 propiedad: el total de cada clave es lo que cobró (su `totalMicros` en centavos) salvo ≤ 1 ¢, y sólo se mueve ≤ 1 clave por tasa más la que absorbe el ajuste declarado', () => {
    for (let p = 100; p <= 30000; p += 997)
      for (const d of [0, 1, 49, 99]) {
        const items = [incluido(p, 'Tasa', 0.16, d), incluido(p + 37, 'Tasa', 0.16), incluido(p + 11, 'Tasa', 0)]
        const us = unidadesDeConceptos(items, i => `a${i}`)
        const a = asig(items)
        const desvio = items.map((_, i) => {
          const cobro = Math.round(us.filter(u => u.clave === `a${i}`).reduce((s, u) => s + u.totalMicros, 0) / 10_000)
          return Object.values(a.porClave.get(`a${i}`)!).reduce((s, c) => s + c!.totalCents, 0) - cobro
        })
        expect(desvio.every(x => Math.abs(x) <= 1)).toBe(true)
        expect(desvio.filter(x => x !== 0).length).toBeLessThanOrEqual(
          Object.keys(resumenDeConceptos(items)).length + Object.keys(a.ajustePorTratamiento).length,
        )
      }
  })
  it('🔴 C2-17, propiedad (añadida): dos tickets IGUALES nunca quedan a más de 1 ¢ entre sí, en total, base e IVA (v3 los separaba 2 ¢)', () => {
    for (let p = 100; p <= 30000; p += 997)
      for (const d of [0, 1, 49, 99]) {
        const a = asig([incluido(p, 'Tasa', 0.16, d), incluido(p, 'Tasa', 0.16, d)], i => (i === 0 ? 'A' : 'B'))
        const [x, y] = [a.porClave.get('A')!.IVA_16!, a.porClave.get('B')!.IVA_16!]
        for (const k of ['totalCents', 'baseCents', 'ivaCents'] as const) expect(Math.abs(x[k] - y[k])).toBeLessThanOrEqual(1)
      }
  })
})

describe('C2 · del XML — la histórica; el no objeto sale del ObjetoImp de sus conceptos (Codex C2-14)', () => {
  const xml = (
    conceptos: XmlConceptos['conceptos'],
    doc: { subTotal: string; descuento?: string; total: string; iva: string | null },
  ): XmlConceptos => ({
    version: 1,
    subTotal: doc.subTotal,
    descuento: doc.descuento ?? '0.00',
    total: doc.total,
    totalImpuestosTrasladados: doc.iva,
    conceptos,
  })
  const c16 = (base: string, iva: string) => ({
    noIdentificacion: null,
    objetoImp: '02',
    importe: base,
    descuento: '0',
    traslados: [{ impuesto: '002', tipoFactor: 'Tasa' as const, tasa: '0.160000', base, importe: iva }],
  })
  const nobj = (importe: string) => ({ noIdentificacion: null, objetoImp: '01', importe, descuento: '0', traslados: [] })
  const tb = (base: string, iva: string) => [{ impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base, importe: iva }]
  const deXml = (x: XmlConceptos, t: unknown) =>
    asignacionFiscal(unidadesDelXml(x) as any, documentoDelXml(x), resumenDelXml(t) as any) as Asignacion
  it('🔴 $116 al 16 % + $0.01 no objeto ⇒ el centavo es NO_OBJETO por su concepto 01 (v2 lo sumaba al 16 %)', () => {
    const x = xml([c16('100.000000', '16.000000'), nobj('0.010000')], { subTotal: '100.01', total: '116.01', iva: '16.00' })
    expect(deXml(x, tb('100.00', '16.00')).porTratamiento).toEqual({
      IVA_16: { baseCents: 10000, ivaCents: 1600, totalCents: 11600 },
      NO_OBJETO: { baseCents: 1, ivaCents: 0, totalCents: 1 },
    })
  })
  it('🔴 una histórica de $0.01 toda no objeto (sin traslados en el resumen) se puede asignar', () => {
    expect(deXml(xml([nobj('0.010000')], { subTotal: '0.01', total: '0.01', iva: null }), []).porTratamiento).toEqual({
      NO_OBJETO: { baseCents: 1, ivaCents: 0, totalCents: 1 },
    })
  })
  it('al 0 % ⇒ IVA_0; exento ⇒ EXENTO; un ObjetoImp que no es 01/02 ⇒ inválido con su motivo', () => {
    const c0 = {
      noIdentificacion: null,
      objetoImp: '02',
      importe: '50.000000',
      descuento: '0',
      traslados: [{ impuesto: '002', tipoFactor: 'Tasa' as const, tasa: '0.000000', base: '50.000000', importe: '0.000000' }],
    }
    expect(
      deXml(xml([c0], { subTotal: '50.00', total: '50.00', iva: '0.00' }), [
        { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.000000', base: '50.00', importe: '0.00' },
      ]).porTratamiento,
    ).toEqual({ IVA_0: { baseCents: 5000, ivaCents: 0, totalCents: 5000 } })
    expect(unidadesDelXml(xml([{ ...nobj('1.000000'), objetoImp: '03' }], { subTotal: '1.00', total: '1.00', iva: null }))).toMatchObject({
      invalido: expect.stringMatching(/objeto/i),
    })
  })
  it('cotejarConElXml: el modelo coincide con el XML ⇒ true; un ObjetoImp o un total distinto ⇒ inválido', () => {
    const items = [incluido(11600, 'Tasa', 0.16)]
    const x = xml([c16('100.000000', '16.000000')], { subTotal: '100.00', total: '116.00', iva: '16.00' })
    expect(cotejarConElXml(items, tb('100.00', '16.00'), x)).toBe(true)
    expect(cotejarConElXml(items, tb('100.00', '16.00'), { ...x, conceptos: [{ ...x.conceptos[0], objetoImp: '01' }] })).toMatchObject({
      invalido: expect.any(String),
    })
    expect(cotejarConElXml(items, tb('100.00', '16.00'), { ...x, total: '116.01' })).toMatchObject({ invalido: expect.any(String) })
  })
  it('🔴 C2-18: dos conceptos INTERCAMBIADOS ($116 al 16 % y $100 al 0 %, los dos ObjetoImp 02) conservan totales y resumen, y el cotejo los rechaza', () => {
    const items = [incluido(11600, 'Tasa', 0.16), incluido(10000, 'Tasa', 0)]
    const c0 = {
      noIdentificacion: null,
      objetoImp: '02',
      importe: '100.000000',
      descuento: '0',
      traslados: [{ impuesto: '002', tipoFactor: 'Tasa' as const, tasa: '0.000000', base: '100.000000', importe: '0.000000' }],
    }
    const resumen = [
      { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '100.00', importe: '16.00' },
      { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.000000', base: '100.00', importe: '0.00' },
    ]
    const doc = { subTotal: '200.00', total: '216.00', iva: '16.00' }
    expect(cotejarConElXml(items, resumen, xml([c16('100.000000', '16.000000'), c0], doc))).toBe(true)
    expect(cotejarConElXml(items, resumen, xml([c0, c16('100.000000', '16.000000')], doc))).toMatchObject({
      invalido: expect.any(String),
    })
  })
  it('🔴 C2-18: cada componente de un concepto cuenta: importe, descuento, base, importe, tasa y factor del traslado, y la identificación', () => {
    const items = [{ ...incluido(11600, 'Tasa', 0.16), sku: 'F-1' }]
    const bueno = { ...c16('100.000000', '16.000000'), noIdentificacion: 'F-1' }
    const tb16 = tb('100.00', '16.00')
    const doc = { subTotal: '100.00', total: '116.00', iva: '16.00' }
    expect(cotejarConElXml(items, tb16, xml([bueno], doc))).toBe(true)
    const t = bueno.traslados[0]
    for (const malo of [
      { ...bueno, importe: '100.000001' },
      { ...bueno, descuento: '0.000001' },
      { ...bueno, noIdentificacion: 'F-2' },
      { ...bueno, traslados: [{ ...t, base: '99.999999' }] },
      { ...bueno, traslados: [{ ...t, importe: '16.000001' }] },
      { ...bueno, traslados: [{ ...t, tasa: '0.080000' }] },
      { ...bueno, traslados: [{ ...t, tipoFactor: 'Exento' as const, tasa: null, importe: null }] },
      { ...bueno, traslados: [t, t] },
    ])
      expect(cotejarConElXml(items, tb16, xml([malo], doc))).toMatchObject({ invalido: expect.any(String) })
  })
})

describe('C2 · cabeEnElSaldo — sólo la nota que agota lleva el centavo, y se registra por componente y ámbito (Codex C2-15)', () => {
  const s = (b: number, i: number, t: number) => ({ baseCents: b, ivaCents: i, totalCents: t })
  it('🔴 $0.04 devuelto en dos de $0.02: la segunda agota con 1 ¢ de BASE de más, registrado (v2 sólo registraba el IVA)', () => {
    const original = asig([incluido(4, 'Tasa', 0.16)]).porTratamiento // base 3, IVA 1, total 4
    const nota = asig([incluido(2, 'Tasa', 0.16)]).porTratamiento // base 2, IVA 0, total 2
    expect(original).toEqual({ IVA_16: s(3, 1, 4) })
    expect(nota).toEqual({ IVA_16: s(2, 0, 2) })
    expect(cabeEnElSaldo(nota, original, 'FACTURA')).toEqual({ ok: true, redondeo: [] })
    expect(cabeEnElSaldo(nota, restar(original, [nota], 0), 'FACTURA')).toEqual({
      ok: true,
      redondeo: [{ tratamiento: 'IVA_16', componente: 'BASE', cents: 1, ambito: 'FACTURA' }],
    })
    expect(cabeEnElSaldo({ IVA_16: s(1, 0, 1) }, restar(original, [nota, nota], 0), 'FACTURA')).toMatchObject({ ok: false })
  })
  it('$100 en dos de $50: la segunda agota con 1 ¢ de IVA de más, registrado; el ámbito viaja', () => {
    const tras1 = restar({ IVA_16: s(8621, 1379, 10000) }, [{ IVA_16: s(4310, 690, 5000) }], 0)
    expect(cabeEnElSaldo({ IVA_16: s(4310, 690, 5000) }, tras1, 'DOCUMENTO_GLOBAL')).toEqual({
      ok: true,
      redondeo: [{ tratamiento: 'IVA_16', componente: 'IVA', cents: 1, ambito: 'DOCUMENTO_GLOBAL' }],
    })
  })
  it('🔴 una nota que NO agota y pide más IVA o más base de la que queda ⇒ no cabe (sin tolerancia)', () => {
    expect(cabeEnElSaldo({ IVA_16: s(4310, 690, 4999) }, { IVA_16: s(4311, 689, 5000) }, 'FACTURA')).toMatchObject({
      ok: false,
      message: expect.stringContaining('16 %'),
    })
    expect(cabeEnElSaldo({ IVA_16: s(4312, 688, 4999) }, { IVA_16: s(4311, 689, 5000) }, 'FACTURA')).toMatchObject({ ok: false })
  })
})

describe('C2 · repartoDeLaDevolucion — una sola política: por artículos sólo con evidencia (C2-4, C2-12)', () => {
  const saldo = {
    IVA_0: { baseCents: 20000, ivaCents: 0, totalCents: 20000 },
    IVA_16: { baseCents: 5000, ivaCents: 800, totalCents: 5800 },
  }
  const montos = new Map([
    ['cafe', { totalCents: 20000, porTratamiento: { IVA_0: 20000 } }],
    ['pan', { totalCents: 2900, porTratamiento: { IVA_16: 2900 } }],
    ['pan2', { totalCents: 2900, porTratamiento: { IVA_16: 2900 } }],
  ])
  const ctx = (over: any = {}) => ({ montosPorRenglon: montos, acreditadoPorRenglon: new Map(), saldo, ...over })
  const d = (over: any) => ({ salesRefundCents: 0, refundedItems: [], congelado: null, ...over })
  it('por artículos (sólo el café) ⇒ todo al 0 %', () => {
    expect(
      repartoDeLaDevolucion(d({ salesRefundCents: 20000, refundedItems: [{ orderItemId: 'cafe', amountCents: 20000 }] }), ctx()),
    ).toEqual({
      modalidad: 'POR_ARTICULOS',
      brutoPorTratamiento: { IVA_0: 20000 },
      porRenglon: [{ orderItemId: 'cafe', totalCents: 20000, porTratamiento: { IVA_0: 20000 } }],
    })
  })
  it('🔴 un artículo facturado en dos tasas (su extra al 0 %) se reparte en proporción a lo facturado de cada una', () => {
    const conExtra = new Map([['a', { totalCents: 10000, porTratamiento: { IVA_16: 7500, IVA_0: 2500 } }]])
    expect(
      repartoDeLaDevolucion(
        d({ salesRefundCents: 4000, refundedItems: [{ orderItemId: 'a', amountCents: 4000 }] }),
        ctx({ montosPorRenglon: conExtra }),
      ),
    ).toMatchObject({ brutoPorTratamiento: { IVA_16: 3000, IVA_0: 1000 } })
  })
  it('🔴 C2-19: dos devoluciones de un artículo 100/100 (16 % / 0 %): 101 ⇒ 51/50; con eso acreditado, 99 ⇒ 49/50; suma 100/100', () => {
    const a = new Map([['a', { totalCents: 200, porTratamiento: { IVA_16: 100, IVA_0: 100 } }]])
    const r1 = repartoDeLaDevolucion(
      d({ salesRefundCents: 101, refundedItems: [{ orderItemId: 'a', amountCents: 101 }] }),
      ctx({ montosPorRenglon: a }),
    ) as any
    expect(r1.porRenglon).toEqual([{ orderItemId: 'a', totalCents: 101, porTratamiento: { IVA_16: 51, IVA_0: 50 } }])
    const r2 = repartoDeLaDevolucion(
      d({ salesRefundCents: 99, refundedItems: [{ orderItemId: 'a', amountCents: 99 }] }),
      ctx({ montosPorRenglon: a, acreditadoPorRenglon: new Map([['a', r1.porRenglon[0].porTratamiento]]) }),
    ) as any
    expect(r2.porRenglon[0].porTratamiento).toEqual({ IVA_16: 49, IVA_0: 50 })
    expect(
      repartoDeLaDevolucion(
        d({ salesRefundCents: 1, refundedItems: [{ orderItemId: 'a', amountCents: 1 }] }),
        ctx({ montosPorRenglon: a, acreditadoPorRenglon: new Map([['a', { IVA_16: 100, IVA_0: 100 }]]) }),
      ),
      // T7 ronda 1 (I3), cambio A PROPÓSITO: se detiene igual; en una original con varias tasas, 1 ¢ de más se dice como centavos de redondeo.
    ).toMatchObject({ reason: 'CENTAVOS_DE_REDONDEO' })
  })
  it('🔴 C2-19, propiedad: secuencias de devoluciones por artículo nunca rebasan lo facturado de un tratamiento, y agotar el artículo deja exactamente su reparto', () => {
    let semilla = 7
    const azar = (n: number) => ((semilla = (semilla * 1103515245 + 12345) % 2 ** 31), semilla % n)
    for (let caso = 0; caso < 300; caso++) {
      const porTratamiento = { IVA_16: 1 + azar(5000), IVA_0: azar(3000), EXENTO: azar(2) ? azar(800) : 0 }
      const total = Object.values(porTratamiento).reduce((s, x) => s + x, 0)
      const montos = new Map([['a', { totalCents: total, porTratamiento }]])
      const acreditado: Record<string, number> = {}
      let queda = total
      while (queda > 0) {
        const cents = azar(3) === 0 ? queda : 1 + azar(queda)
        const r = repartoDeLaDevolucion(
          d({ salesRefundCents: cents, refundedItems: [{ orderItemId: 'a', amountCents: cents }] }),
          ctx({ montosPorRenglon: montos, acreditadoPorRenglon: new Map([['a', { ...acreditado }]]) }),
        ) as any
        expect(Object.values(r.porRenglon[0].porTratamiento as Record<string, number>).reduce((s, x) => s + x, 0)).toBe(cents)
        for (const [t, c] of Object.entries(r.porRenglon[0].porTratamiento as Record<string, number>))
          acreditado[t] = (acreditado[t] ?? 0) + c
        for (const [t, c] of Object.entries(porTratamiento)) expect(acreditado[t] ?? 0).toBeLessThanOrEqual(c)
        queda -= cents
      }
      for (const [t, c] of Object.entries(porTratamiento)) expect(acreditado[t] ?? 0).toBe(c)
    }
  })
  it('🔴 C2-19 con la regla del PAC: el artículo de $65 con $2.49 de descuento quedó en 62.50; devolver 31.25 + 31.25 cabe y un centavo más no', () => {
    const items = [incluido(6500, 'Tasa', 0.16, 249)]
    const m = asig(items, () => 'a').porClave.get('a')!
    const montos = new Map([['a', { totalCents: m.IVA_16!.totalCents, porTratamiento: { IVA_16: m.IVA_16!.totalCents } }]])
    expect(montos.get('a')!.totalCents).toBe(6250)
    const r1 = repartoDeLaDevolucion(
      d({ salesRefundCents: 3125, refundedItems: [{ orderItemId: 'a', amountCents: 3125 }] }),
      ctx({ montosPorRenglon: montos }),
    ) as any
    const conR1 = ctx({ montosPorRenglon: montos, acreditadoPorRenglon: new Map([['a', r1.porRenglon[0].porTratamiento]]) })
    expect(
      repartoDeLaDevolucion(d({ salesRefundCents: 3125, refundedItems: [{ orderItemId: 'a', amountCents: 3125 }] }), conR1),
    ).toMatchObject({
      modalidad: 'POR_ARTICULOS',
    })
    expect(
      repartoDeLaDevolucion(d({ salesRefundCents: 3126, refundedItems: [{ orderItemId: 'a', amountCents: 3126 }] }), conR1),
    ).toMatchObject({
      // T7 ronda 1 (I3), cambio A PROPÓSITO: «ni un centavo más» sigue; el saldo de este `describe` tiene dos tasas ⇒ centavos de redondeo.
      reason: 'CENTAVOS_DE_REDONDEO',
    })
    // Con su saldo real (una sola tasa) ese centavo es «excede».
    expect(
      repartoDeLaDevolucion(d({ salesRefundCents: 3126, refundedItems: [{ orderItemId: 'a', amountCents: 3126 }] }), {
        ...conR1,
        saldo: { IVA_16: saldo.IVA_16 },
      }),
    ).toMatchObject({ reason: 'ARTICULO_EXCEDE_LO_FACTURADO' })
  })
  it('repartirSobreLoQueQueda: suma exacta, nada a un tratamiento agotado, todo lo que queda ⇒ exactamente lo que queda', () => {
    expect(repartirSobreLoQueQueda(10, { IVA_16: 0, IVA_0: 30 })).toEqual({ IVA_0: 10 })
    expect(repartirSobreLoQueQueda(80, { IVA_16: 49, IVA_0: 31 })).toEqual({ IVA_16: 49, IVA_0: 31 })
  })
  it('🔴 artículo facturado en $29 devuelto a $58 ⇒ se DETIENE aunque la tasa tenga de sobra', () => {
    expect(
      repartoDeLaDevolucion(d({ salesRefundCents: 5800, refundedItems: [{ orderItemId: 'pan', amountCents: 5800 }] }), ctx()),
    ).toMatchObject({
      reason: 'ARTICULO_EXCEDE_LO_FACTURADO',
    })
  })
  it('los artículos no suman lo devuelto ⇒ se DETIENE', () => {
    expect(
      repartoDeLaDevolucion(d({ salesRefundCents: 1000, refundedItems: [{ orderItemId: 'cafe', amountCents: 400 }] }), ctx()),
    ).toMatchObject({
      reason: 'ARTICULOS_NO_CUADRAN',
    })
  })
  it('🔴 C2-12: sin montos por artículo se DETIENE también con UNA sola tasa; un artículo que no está en los montos, igual', () => {
    const una = { montosPorRenglon: null, acreditadoPorRenglon: new Map(), saldo: { IVA_16: saldo.IVA_16 } }
    expect(
      repartoDeLaDevolucion(d({ salesRefundCents: 2900, refundedItems: [{ orderItemId: 'pan', amountCents: 2900 }] }), una),
    ).toMatchObject({
      reason: 'SIN_MONTO_POR_ARTICULO',
    })
    expect(
      repartoDeLaDevolucion(d({ salesRefundCents: 100, refundedItems: [{ orderItemId: 'otro', amountCents: 100 }] }), ctx()),
    ).toMatchObject({
      reason: 'ARTICULO_SIN_EVIDENCIA',
    })
  })
  it('🔴 P10: «por importe» elegido sólo cuando falta evidencia; con evidencia, con un exceso o sin artículos ⇒ no permitido', () => {
    const una = { montosPorRenglon: null, acreditadoPorRenglon: new Map(), saldo }
    expect(
      repartoDeLaDevolucion(
        d({ salesRefundCents: 1000, refundedItems: [{ orderItemId: 'pan', amountCents: 1000 }], modalidadElegida: 'POR_IMPORTE' }),
        una,
      ),
    ).toEqual({ modalidad: 'POR_IMPORTE_ELEGIDO', brutoPorTratamiento: { IVA_0: 775, IVA_16: 225 } })
    expect(
      repartoDeLaDevolucion(
        d({ salesRefundCents: 20000, refundedItems: [{ orderItemId: 'cafe', amountCents: 20000 }], modalidadElegida: 'POR_IMPORTE' }),
        ctx(),
      ),
    ).toMatchObject({ reason: 'MODALIDAD_NO_PERMITIDA' })
    expect(
      repartoDeLaDevolucion(
        d({ salesRefundCents: 5800, refundedItems: [{ orderItemId: 'pan', amountCents: 5800 }], modalidadElegida: 'POR_IMPORTE' }),
        ctx(),
      ),
    ).toMatchObject({ reason: 'MODALIDAD_NO_PERMITIDA' })
    expect(repartoDeLaDevolucion(d({ salesRefundCents: 1000, modalidadElegida: 'POR_IMPORTE' }), ctx())).toMatchObject({
      reason: 'MODALIDAD_NO_PERMITIDA',
    })
  })
  it('por importe: proporcional a lo que queda, suma exacta', () => {
    expect(repartoDeLaDevolucion(d({ salesRefundCents: 1000 }), ctx())).toEqual({
      modalidad: 'POR_IMPORTE',
      brutoPorTratamiento: { IVA_0: 775, IVA_16: 225 },
    })
  })
  it('🔴 delivery con reparto inválido ⇒ se DETIENE; válido ⇒ su reparto manda', () => {
    expect(repartoDeLaDevolucion(d({ salesRefundCents: 5800, congelado: 'INVALIDO' }), ctx())).toMatchObject({
      reason: 'REPARTO_DE_ENTREGA_INVALIDO',
    })
    expect(repartoDeLaDevolucion(d({ salesRefundCents: 5800, congelado: { IVA_16: 5800 } }), ctx())).toEqual({
      modalidad: 'DELIVERY',
      brutoPorTratamiento: { IVA_16: 5800 },
    })
  })
})

// ── Añadidos del implementador (T4): contra los XML REALES del sandbox de la T1 y bordes que el plan no fija ─────────────────────
describe('C2 · contra los XML reales del sandbox (T1, `/private/tmp/c2-t1-xml/`)', () => {
  // Transcritos de los XML timbrados el 7-oct. Lo que Facturapi escribe: sin `sku` no hay NoIdentificacion; sin descuento no hay
  // atributo Descuento (aquí '0'); el traslado al 0 % trae Importe="0"; el exento, sin TasaOCuota ni Importe; el no objeto, sin Impuestos.
  const tr = (tasa: string | null, base: string, importe: string | null) => ({
    impuesto: '002',
    tipoFactor: (tasa === null ? 'Exento' : 'Tasa') as 'Tasa' | 'Exento',
    tasa,
    base,
    importe,
  })
  const E1: XmlConceptos = {
    version: 1,
    subTotal: '200.00',
    descuento: '0',
    total: '216.00',
    totalImpuestosTrasladados: '16.00',
    conceptos: [
      {
        noIdentificacion: null,
        objetoImp: '02',
        importe: '100.000000',
        descuento: '0',
        traslados: [tr('0.160000', '100.000000', '16.000000')],
      },
      { noIdentificacion: null, objetoImp: '02', importe: '50.000000', descuento: '0', traslados: [tr('0.000000', '50.000000', '0')] },
      { noIdentificacion: null, objetoImp: '02', importe: '30.000000', descuento: '0', traslados: [tr(null, '30.000000', null)] },
      { noIdentificacion: null, objetoImp: '01', importe: '20.000000', descuento: '0', traslados: [] },
    ],
  }
  const E1_TB = [tr('0.160000', '100.00', '16.00'), tr('0.000000', '50.00', '0.00'), tr(null, '30.00', null)]
  const E1_ITEMS = [incluido(11600, 'Tasa', 0.16), incluido(5000, 'Tasa', 0), incluido(3000, 'Exento'), incluido(2000, null)]
  const E3: XmlConceptos = {
    version: 1,
    subTotal: '56.03',
    descuento: '2.15',
    total: '62.50',
    totalImpuestosTrasladados: '8.62',
    conceptos: [
      {
        noIdentificacion: null,
        objetoImp: '02',
        importe: '56.034483',
        descuento: '2.146552',
        traslados: [tr('0.160000', '53.887931', '8.622069')],
      },
    ],
  }
  const E3_TB = [tr('0.160000', '53.89', '8.62')]
  const E5: XmlConceptos = {
    version: 1,
    subTotal: '224.14',
    descuento: '0',
    total: '260.00',
    totalImpuestosTrasladados: '35.86',
    conceptos: [
      {
        noIdentificacion: null,
        objetoImp: '02',
        importe: '137.931034',
        descuento: '0',
        traslados: [tr('0.160000', '137.931038', '22.068966')],
      },
      {
        noIdentificacion: null,
        objetoImp: '02',
        importe: '86.206896',
        descuento: '0',
        traslados: [tr('0.160000', '86.206900', '13.793104')],
      },
    ],
  }
  const E5_TB = [tr('0.160000', '224.14', '35.86')]
  const E5_ITEMS = [incluido(16000, 'Tasa', 0.16), { ...incluido(5000, 'Tasa', 0.16), quantity: 2 }]
  const E2: XmlConceptos = {
    version: 1,
    subTotal: '337.93',
    descuento: '0',
    total: '376.00',
    totalImpuestosTrasladados: '38.07',
    conceptos: [
      {
        noIdentificacion: 'C2-T1',
        objetoImp: '02',
        importe: '100.000000',
        descuento: '0',
        traslados: [tr('0.160000', '100.000000', '16.000000')],
      },
      {
        noIdentificacion: 'C2-T2',
        objetoImp: '02',
        importe: '237.931034',
        descuento: '0',
        traslados: [tr('0.160000', '137.931034', '22.068965'), tr('0.000000', '100.000000', '0')],
      },
    ],
  }
  const E2_TB = [tr('0.160000', '237.93', '38.07'), tr('0.000000', '100.00', '0.00')]
  const E2_ITEMS = [
    { ...incluido(11600, 'Tasa', 0.16), sku: 'C2-T1' },
    {
      satProductKey: '01010101',
      satUnitKey: 'ACT',
      description: 'Venta',
      quantity: 1,
      unitPriceCents: 23793,
      unitPriceDecimal: '237.931034',
      discountCents: 0,
      taxIncluded: false,
      objetoImp: '02',
      sku: 'C2-T2',
      taxes: [
        { type: 'IVA' as const, factor: 'Tasa' as const, rate: 0.16, withholding: false, base: '137.931034' },
        { type: 'IVA' as const, factor: 'Tasa' as const, rate: 0, withholding: false, base: '100.000000' },
      ],
    },
  ]
  const deXml = (x: XmlConceptos, t: unknown) =>
    asignacionFiscal(unidadesDelXml(x) as any, documentoDelXml(x), resumenDelXml(t) as any) as Asignacion

  it('🔴 el modelo de la 6b coteja concepto por concepto con los cuatro XML (Importe "0" del 0 %, Base > Importe de E5, varias bases de la global)', () => {
    expect(cotejarConElXml(E1_ITEMS, E1_TB, E1)).toBe(true)
    expect(cotejarConElXml([incluido(6500, 'Tasa', 0.16, 249)], E3_TB, E3)).toBe(true)
    expect(cotejarConElXml(E5_ITEMS, E5_TB, E5)).toBe(true)
    expect(cotejarConElXml(E2_ITEMS, E2_TB, E2)).toBe(true)
  })
  it('🔴 sólo el factor distinto (tasa e importe intactos) también se rechaza', () => {
    const t = E3.conceptos[0].traslados[0]
    const malo: XmlConceptos = { ...E3, conceptos: [{ ...E3.conceptos[0], traslados: [{ ...t, tipoFactor: 'Exento' }] }] }
    expect(cotejarConElXml([incluido(6500, 'Tasa', 0.16, 249)], E3_TB, malo)).toMatchObject({ invalido: expect.any(String) })
  })
  it('🔴 la identificación se coteja en los DOS sentidos: un NoIdentificacion que el modelo no tiene (o al revés) ⇒ inválido', () => {
    const conFolio: XmlConceptos = { ...E3, conceptos: [{ ...E3.conceptos[0], noIdentificacion: 'C2-T9' }] }
    expect(cotejarConElXml([incluido(6500, 'Tasa', 0.16, 249)], E3_TB, conFolio)).toMatchObject({ invalido: expect.any(String) })
    expect(cotejarConElXml([{ ...incluido(6500, 'Tasa', 0.16, 249), sku: 'C2-T9' }], E3_TB, E3)).toMatchObject({
      invalido: expect.any(String),
    })
    expect(cotejarConElXml([{ ...incluido(6500, 'Tasa', 0.16, 249), sku: 'C2-T9' }], E3_TB, conFolio)).toBe(true)
  })
  it('🔴 la asignación desde el XML es la MISMA que desde el payload (E1, E3 con su ajuste −1, E5, E2)', () => {
    const casos: Array<[any[], XmlConceptos, unknown]> = [
      [E1_ITEMS, E1, E1_TB],
      [[incluido(6500, 'Tasa', 0.16, 249)], E3, E3_TB],
      [E5_ITEMS, E5, E5_TB],
      [E2_ITEMS, E2, E2_TB],
    ]
    for (const [items, x, t] of casos) {
      const delPayload = asig(items, i => `c${i}`)
      const delXml = deXml(x, t)
      expect(delXml.porTratamiento).toEqual(delPayload.porTratamiento)
      expect(delXml.ajustePorTratamiento).toEqual(delPayload.ajustePorTratamiento)
      expect([...delXml.porClave.entries()]).toEqual([...delPayload.porClave.entries()])
    }
    expect(deXml(E3, E3_TB).porTratamiento).toEqual({ IVA_16: { baseCents: 5389, ivaCents: 862, totalCents: 6250 } })
  })
  it('🔴 E2 (global con varias bases): cada ticket conserva lo que cobró — C2-T1 $116 al 16 %; C2-T2 $160 al 16 % + $100 al 0 %; y su nota real cabe en el ticket', () => {
    const a = deXml(E2, E2_TB)
    expect(a.porTratamiento).toEqual({
      IVA_16: { baseCents: 23793, ivaCents: 3807, totalCents: 27600 },
      IVA_0: { baseCents: 10000, ivaCents: 0, totalCents: 10000 },
    })
    const t1 = a.porClave.get('c0')!
    const t2 = a.porClave.get('c1')!
    expect(t1.IVA_16!.totalCents).toBe(11600)
    expect(t2.IVA_16!.totalCents).toBe(16000)
    expect(t2.IVA_0).toEqual({ baseCents: 10000, ivaCents: 0, totalCents: 10000 })
    const nota = asig([incluido(5800, 'Tasa', 0.16), incluido(2500, 'Tasa', 0)]).porTratamiento // E2-nota (83.00), timbrada
    expect(cabeEnElSaldo(nota, t2, 'TICKET')).toEqual({ ok: true, redondeo: [] })
    expect(cabeEnElSaldo(nota, a.porTratamiento, 'DOCUMENTO_GLOBAL')).toEqual({ ok: true, redondeo: [] })
  })
  it('🔴 un XML cuyos conceptos no suman su SubTotal o su Descuento ⇒ inválido, aunque el Total cuadre', () => {
    // SubTotal y Descuento corridos un centavo cada uno: el Total (216.00) y el IVA siguen iguales.
    expect(
      asignacionFiscal(
        unidadesDelXml(E1) as any,
        documentoDelXml({ ...E1, subTotal: '200.01', descuento: '0.01' }),
        resumenDelXml(E1_TB) as any,
      ),
    ).toEqual({
      invalido: MOTIVO_XML_NO_CUADRA,
    })
  })
  it('leerXmlConceptos: lo que escribe la Tarea 5 se lee tal cual; versión, decimales, factor o exento con importe malos ⇒ null', () => {
    expect(leerXmlConceptos(E1)).toEqual(E1)
    expect(leerXmlConceptos(E2)).toEqual(E2)
    const c = E1.conceptos[0]
    for (const malo of [
      null,
      'x',
      { ...E1, version: 2 },
      { ...E1, total: '216' + 'x' },
      { ...E1, totalImpuestosTrasladados: undefined },
      { ...E1, conceptos: 'x' },
      { ...E1, conceptos: [{ ...c, importe: '-1.00' }] },
      { ...E1, conceptos: [{ ...c, objetoImp: 2 }] },
      { ...E1, conceptos: [{ ...c, noIdentificacion: 7 }] },
      { ...E1, conceptos: [{ ...c, traslados: [{ ...c.traslados[0], tipoFactor: 'Cuota' }] }] },
      { ...E1, conceptos: [{ ...c, traslados: [{ ...c.traslados[0], importe: null }] }] },
      { ...E1, conceptos: [{ ...c, traslados: [{ ...c.traslados[0], tasa: null }] }] },
      { ...E1, conceptos: [{ ...c, traslados: [tr(null, '30.000000', '0')] }] },
    ])
      expect(leerXmlConceptos(malo)).toBeNull()
  })
  it('resumenDelXml: una tasa repetida o un impuesto que no es IVA ⇒ inválido; la tasa se compara como número', () => {
    expect(resumenDelXml([tr('0.160000', '1.00', '0.16'), tr('0.160000', '1.00', '0.16')])).toEqual({ invalido: MOTIVO_XML_NO_CUADRA })
    expect(resumenDelXml([{ ...tr('0.160000', '1.00', '0.16'), impuesto: '003' }])).toEqual({ invalido: MOTIVO_XML_NO_CUADRA })
    expect(resumenDelXml([tr('0.16', '1.00', '0.16')])).toEqual({ IVA_16: { baseCents: 100, ivaCents: 16 } })
    expect(resumenDelXml(null)).toEqual({ invalido: MOTIVO_XML_NO_CUADRA })
  })
  it('unidadesDelXml: un no objeto con traslados, o un traslado que no es IVA, no se asigna', () => {
    const c = E1.conceptos[3]
    expect(unidadesDelXml({ ...E1, conceptos: [{ ...c, traslados: [tr('0.160000', '20.000000', '3.200000')] }] })).toEqual({
      invalido: MOTIVO_XML_NO_CUADRA,
    })
    expect(
      unidadesDelXml({ ...E1, conceptos: [{ ...E1.conceptos[0], traslados: [{ ...E1.conceptos[0].traslados[0], impuesto: '003' }] }] }),
    ).toMatchObject({
      invalido: expect.stringMatching(/objeto/i),
    })
  })

  // ── Ronda de arreglos 1 (revisión de la T4) ──
  it('control — M-2: TotalImpuestosTrasladados corrido 1 ¢ con el MISMO Total ⇒ inválido (Σ IVA de las tasas = IVA del documento)', () => {
    expect(
      asignacionFiscal(unidadesDelXml(E1), documentoDelXml({ ...E1, totalImpuestosTrasladados: '16.01' }), resumenDelXml(E1_TB)),
    ).toEqual({
      invalido: MOTIVO_XML_NO_CUADRA,
    })
  })
  it('control — M-2: un IEPS en el traslado del concepto ⇒ el cotejo lo rechaza (todo lo demás igual)', () => {
    const conIeps: XmlConceptos = {
      ...E3,
      conceptos: [{ ...E3.conceptos[0], traslados: [{ ...E3.conceptos[0].traslados[0], impuesto: '003' }] }],
    }
    expect(cotejarConElXml([incluido(6500, 'Tasa', 0.16, 249)], E3_TB, conIeps)).toEqual({ invalido: MOTIVO_XML_NO_CUADRA })
  })
  it('🔴 M-4: `claveDe` en unidadesDelXml — la T8 agrupa por folio, y un ticket con dos conceptos es UNA clave', () => {
    const folio = (i: number, c: ConceptoDelXml) => c.noIdentificacion ?? `c${i}`
    const a = asignacionFiscal(unidadesDelXml(E2, folio), documentoDelXml(E2), resumenDelXml(E2_TB)) as Asignacion
    expect([...a.porClave.keys()]).toEqual(['C2-T1', 'C2-T2'])
    expect(a.porClave.get('C2-T2')).toEqual(deXml(E2, E2_TB).porClave.get('c1'))
    const c58 = {
      noIdentificacion: 'T1',
      objetoImp: '02',
      importe: '50.000000',
      descuento: '0',
      traslados: [tr('0.160000', '50.000000', '8.000000')],
    }
    const partido: XmlConceptos = {
      version: 1,
      subTotal: '100.00',
      descuento: '0',
      total: '116.00',
      totalImpuestosTrasladados: '16.00',
      conceptos: [c58, c58],
    }
    const b = asignacionFiscal(
      unidadesDelXml(partido, folio),
      documentoDelXml(partido),
      resumenDelXml([tr('0.160000', '100.00', '16.00')]),
    ) as Asignacion
    expect([...b.porClave.entries()]).toEqual([['T1', { IVA_16: { baseCents: 10000, ivaCents: 1600, totalCents: 11600 } }]])
  })
  it('🔴 M-B2 (ronda 2): un traslado del payload SIN tasa legible (null, ausente o NaN) NO lanza: documento, asignación y cotejo se detienen con su motivo', () => {
    for (const rate of [null, undefined, Number.NaN]) {
      const items = [
        {
          ...incluido(11600, 'Tasa', 0.16),
          taxes: [{ type: 'IVA' as const, factor: 'Tasa' as const, rate: rate as unknown as number, withholding: false }],
        },
      ]
      let doc: unknown
      let a: unknown
      let c: unknown
      expect(() => (doc = documentoDeConceptosOInvalido(items))).not.toThrow()
      expect(doc).toEqual({ invalido: MOTIVO_TASA_NO_SOPORTADA })
      expect(
        () =>
          (a = asignacionFiscal(
            unidadesDeConceptosOInvalido(items, () => 'a'),
            documentoDeConceptosOInvalido(items),
            resumenDeConceptosOInvalido(items),
          )),
      ).not.toThrow()
      expect(a).toEqual({ invalido: MOTIVO_TASA_NO_SOPORTADA })
      expect(() => (c = cotejarConElXml(items, E3_TB, E3))).not.toThrow()
      expect(c).toEqual({ invalido: MOTIVO_TASA_NO_SOPORTADA })
    }
  })
  it('🔴 M-5: una tasa fuera de 16/8/0 (10 %) NO lanza: asignación, cotejo y lectores del XML se detienen con su motivo', () => {
    const items = [incluido(11000, 'Tasa', 0.1)]
    const x10: XmlConceptos = {
      version: 1,
      subTotal: '100.00',
      descuento: '0',
      total: '110.00',
      totalImpuestosTrasladados: '10.00',
      conceptos: [
        {
          noIdentificacion: null,
          objetoImp: '02',
          importe: '100.000000',
          descuento: '0',
          traslados: [tr('0.100000', '100.000000', '10.000000')],
        },
      ],
    }
    const tb10 = [tr('0.100000', '100.00', '10.00')]
    let r: unknown
    expect(
      () =>
        (r = asignacionFiscal(
          unidadesDeConceptos(items, () => 'a'),
          documentoDeConceptos(items),
          resumenDeConceptos(items),
        )),
    ).not.toThrow()
    expect(r).toEqual({ invalido: MOTIVO_TASA_NO_SOPORTADA })
    let c: unknown
    expect(() => (c = cotejarConElXml(items, tb10, x10))).not.toThrow()
    expect(c).toEqual({ invalido: MOTIVO_TASA_NO_SOPORTADA })
    expect(unidadesDelXml(x10)).toEqual({ invalido: MOTIVO_TASA_NO_SOPORTADA })
    expect(resumenDelXml(tb10)).toEqual({ invalido: MOTIVO_TASA_NO_SOPORTADA })
  })
  describe('🔴 #4: un artículo REGALADO (descuento del 100 %) en la original ⇒ la nota se DETIENE con su motivo', () => {
    // Forma MEDIDA (B3a T1b, control G `6ac3eea0d7fa32314f5e6785`): el PAC timbra el concepto de cobro 0 con ObjetoImp 01, sin traslado y
    // Descuento = Importe. G: $10 al 16 % + $45 regalado ⇒ 47.41 / 38.79 / 1.38 / 10.00.
    const regalado = (importe: string) => ({ noIdentificacion: null, objetoImp: '01', importe, descuento: importe, traslados: [] })
    const G: XmlConceptos = {
      version: 1,
      subTotal: '47.41',
      descuento: '38.79',
      total: '10.00',
      totalImpuestosTrasladados: '1.38',
      conceptos: [
        {
          noIdentificacion: null,
          objetoImp: '02',
          importe: '8.620690',
          descuento: '0',
          traslados: [tr('0.160000', '8.620690', '1.379310')],
        },
        regalado('38.793103'),
      ],
    }
    const G_TB = [tr('0.160000', '8.62', '1.38')]
    // Café $50 + galleta $45 regalada (predicción de la revisión): 81.90 / 38.79 / 6.90 / 50.01 — el redondeo cruza tasas.
    const CAFE: XmlConceptos = {
      version: 1,
      subTotal: '81.90',
      descuento: '38.79',
      total: '50.01',
      totalImpuestosTrasladados: '6.90',
      conceptos: [
        {
          noIdentificacion: null,
          objetoImp: '02',
          importe: '43.103448',
          descuento: '0',
          traslados: [tr('0.160000', '43.103448', '6.896552')],
        },
        regalado('38.793103'),
      ],
    }
    const CAFE_TB = [tr('0.160000', '43.10', '6.90')]
    const CAFE_ITEMS = [incluido(5000, 'Tasa', 0.16), incluido(4500, 'Tasa', 0.16, 4500)]
    it('histórica con la forma de G ($10 + $45 regalado) ⇒ MOTIVO_CONCEPTO_REGALADO (antes la asignaba)', () => {
      expect(asignacionFiscal(unidadesDelXml(G), documentoDelXml(G), resumenDelXml(G_TB))).toEqual({ invalido: MOTIVO_CONCEPTO_REGALADO })
    })
    it('café $50 + galleta $45 regalada (documento $50.01) ⇒ el mismo motivo, no «el XML no coincide»', () => {
      expect(asignacionFiscal(unidadesDelXml(CAFE), documentoDelXml(CAFE), resumenDelXml(CAFE_TB))).toEqual({
        invalido: MOTIVO_CONCEPTO_REGALADO,
      })
    })
    it('control — M-D (ronda 2): el regalo visto SÓLO en el XML (el payload no lo trae) da su propio motivo, no «el XML no coincide»', () => {
      expect(cotejarConElXml([incluido(1000, 'Tasa', 0.16)], G_TB, G)).toEqual({ invalido: MOTIVO_CONCEPTO_REGALADO })
    })
    it('con entrada: el cotejo (payload 02 contra XML 01) y la asignación del payload se detienen con el mismo motivo', () => {
      expect(cotejarConElXml(CAFE_ITEMS, CAFE_TB, CAFE)).toEqual({ invalido: MOTIVO_CONCEPTO_REGALADO })
      expect(
        asignacionFiscal(
          unidadesDeConceptos(CAFE_ITEMS, i => `a${i}`),
          documentoDeConceptos(CAFE_ITEMS),
          resumenDeConceptos(CAFE_ITEMS),
        ),
      ).toEqual({
        invalido: MOTIVO_CONCEPTO_REGALADO,
      })
      expect(asig([incluido(1000, 'Tasa', 0.16), incluido(4500, 'Tasa', 0, 4500)])).toEqual({ invalido: MOTIVO_CONCEPTO_REGALADO }) // regalo al 0 %
    })
  })
})

describe('C2 · bordes del reparto que el plan no fija (añadidos del implementador)', () => {
  const saldo = { IVA_16: { baseCents: 5000, ivaCents: 800, totalCents: 5800 } }
  it('🔴 por importe (o elegido) que excede lo que queda ⇒ se DETIENE con EXCEEDS_REMAINING (nunca se reparte de más)', () => {
    const ctx = { montosPorRenglon: null, acreditadoPorRenglon: new Map(), saldo }
    expect(repartoDeLaDevolucion({ salesRefundCents: 5801, refundedItems: [], congelado: null }, ctx)).toMatchObject({
      reason: 'EXCEEDS_REMAINING',
    })
    expect(
      repartoDeLaDevolucion(
        {
          salesRefundCents: 5801,
          refundedItems: [{ orderItemId: 'x', amountCents: 5801 }],
          congelado: null,
          modalidadElegida: 'POR_IMPORTE',
        },
        ctx,
      ),
    ).toMatchObject({ reason: 'EXCEEDS_REMAINING' })
    expect(repartoDeLaDevolucion({ salesRefundCents: 5800, refundedItems: [], congelado: null }, ctx)).toEqual({
      modalidad: 'POR_IMPORTE',
      brutoPorTratamiento: { IVA_16: 5800 },
    })
  })
  it('🔴 un artículo con importe negativo o con fracción ⇒ ARTICULOS_NO_CUADRAN (aunque la suma cuadre)', () => {
    const ctx = {
      montosPorRenglon: new Map([['a', { totalCents: 5800, porTratamiento: { IVA_16: 5800 } }]]),
      acreditadoPorRenglon: new Map(),
      saldo,
    }
    const items = (xs: number[]) => xs.map(amountCents => ({ orderItemId: 'a', amountCents }))
    expect(repartoDeLaDevolucion({ salesRefundCents: 100, refundedItems: items([200, -100]), congelado: null }, ctx)).toMatchObject({
      reason: 'ARTICULOS_NO_CUADRAN',
    })
    expect(repartoDeLaDevolucion({ salesRefundCents: 100, refundedItems: items([50.5, 49.5]), congelado: null }, ctx)).toMatchObject({
      reason: 'ARTICULOS_NO_CUADRAN',
    })
  })
  it('repartirPorTasa: cada unidad conserva su total y el IVA nunca rebasa su total (ninguna base negativa)', () => {
    expect(repartirPorTasa({ totalCents: 20000, ivaCents: 2759 }, [116_000_000, 116_000_000])).toEqual([
      { baseCents: 8620, ivaCents: 1380, totalCents: 10000 },
      { baseCents: 8621, ivaCents: 1379, totalCents: 10000 },
    ])
    for (const partes of [
      repartirPorTasa({ totalCents: 3, ivaCents: 1 }, [10_000, 10_000, 10_000]),
      repartirPorTasa({ totalCents: 101, ivaCents: 14 }, [1, 999_999, 3]),
    ])
      for (const p of partes) expect(p.baseCents >= 0 && p.ivaCents <= p.totalCents).toBe(true)
  })
})

describe('C2 · ronda de arreglos 1 — I-1, I-2, I-3 y M-1', () => {
  const s16 = (b: number, i: number, t: number) => ({ IVA_16: { baseCents: b, ivaCents: i, totalCents: t } })
  it('🔴 I-1: café + galleta de cortesía devueltos (la galleta en $0, fuera de la factura por D9) ⇒ por artículos, sólo el café, en cualquier orden', () => {
    const montos = new Map([['cafe', { totalCents: 5000, porTratamiento: { IVA_16: 5000 } }]])
    const ctx = { montosPorRenglon: montos, acreditadoPorRenglon: new Map(), saldo: s16(4310, 690, 5000) }
    const cafe = { orderItemId: 'cafe', amountCents: 5000 }
    const galleta = { orderItemId: 'galleta', amountCents: 0 }
    for (const refundedItems of [
      [cafe, galleta],
      [galleta, cafe],
    ])
      expect(repartoDeLaDevolucion({ salesRefundCents: 5000, refundedItems, congelado: null }, ctx)).toEqual({
        modalidad: 'POR_ARTICULOS',
        brutoPorTratamiento: { IVA_16: 5000 },
        porRenglon: [{ orderItemId: 'cafe', totalCents: 5000, porTratamiento: { IVA_16: 5000 } }],
      })
  })
  it('🔴 I-2: P10 no depende del orden: un artículo sin evidencia y otro que excede lo facturado ⇒ EXCEDE, y «por importe» no se permite, en los dos órdenes', () => {
    const montos = new Map([['pan', { totalCents: 2900, porTratamiento: { IVA_16: 2900 } }]])
    const ctx = {
      montosPorRenglon: montos,
      acreditadoPorRenglon: new Map(),
      saldo: { ...s16(5000, 800, 5800), IVA_0: { baseCents: 20000, ivaCents: 0, totalCents: 20000 } },
    }
    const otro = { orderItemId: 'otro', amountCents: 100 }
    const pan = { orderItemId: 'pan', amountCents: 5800 }
    for (const refundedItems of [
      [otro, pan],
      [pan, otro],
    ]) {
      expect(
        repartoDeLaDevolucion({ salesRefundCents: 5900, refundedItems, congelado: null, modalidadElegida: 'POR_IMPORTE' }, ctx),
      ).toMatchObject({
        reason: 'MODALIDAD_NO_PERMITIDA',
      })
      expect(repartoDeLaDevolucion({ salesRefundCents: 5900, refundedItems, congelado: null }, ctx)).toMatchObject({
        reason: 'ARTICULO_EXCEDE_LO_FACTURADO',
      })
    }
  })
  it('🔴 I-3 (P8 se queda): el TOTAL agota y sólo difiere el reparto base/IVA por el redondeo acumulado (caso medido: saldo 14557/2331/16888, nota 14559/2329/16888) ⇒ no cabe, con el motivo del redondeo y sus centavos, en cualquier ámbito', () => {
    const texto =
      'El redondeo de las notas anteriores movió 2 ¢ entre base e IVA; esta última devolución no se puede timbrar aquí: hazla con tu contador o escríbenos a soporte.'
    for (const ambito of ['FACTURA', 'TICKET', 'DOCUMENTO_GLOBAL'] as const)
      expect(cabeEnElSaldo(s16(14559, 2329, 16888), s16(14557, 2331, 16888), ambito)).toEqual({ ok: false, message: texto })
    // con 1 ¢ sigue cabiendo (P8) y se registra; si el total no agota, sigue siendo «excede»
    expect(cabeEnElSaldo(s16(14558, 2330, 16888), s16(14557, 2331, 16888), 'FACTURA')).toEqual({
      ok: true,
      redondeo: [{ tratamiento: 'IVA_16', componente: 'BASE', cents: 1, ambito: 'FACTURA' }],
    })
    expect(cabeEnElSaldo(s16(14559, 2329, 16887), s16(14557, 2331, 16888), 'FACTURA')).toMatchObject({
      ok: false,
      message: expect.stringContaining('excede'),
    })
  })
  it('control — M-C (ronda 2): la guarda central de dinero — el TOTAL de la nota no puede pasar del saldo aunque su base y su IVA quepan (saldo con ajuste −1: 5000/800/5799; nota 5000/800/5800)', () => {
    expect(cabeEnElSaldo(s16(5000, 800, 5800), s16(5000, 800, 5799), 'FACTURA')).toEqual({
      ok: false,
      message:
        'Lo que se devuelve al 16 % ($58.00, IVA $8.00) excede lo que queda por acreditar de esa tasa en la factura original ($57.99, IVA $8.00).',
    })
    expect(cabeEnElSaldo(s16(5000, 800, 5800), s16(5000, 800, 5799), 'TICKET')).toMatchObject({
      ok: false,
      message: expect.stringContaining('excede'),
    })
    expect(cabeEnElSaldo(s16(5000, 800, 5800), s16(5000, 800, 5799), 'DOCUMENTO_GLOBAL')).toEqual({
      ok: false,
      message: MOTIVO_SALDO_DEL_DOCUMENTO,
    })
  })
  it('🔴 M-B1 (ronda 2): un importe devuelto que no es centavos enteros ≥ 0 (NaN, fracción, negativo, ausente, infinito) se DETIENE con su motivo y sin lanzar, en toda modalidad; el cero sigue siendo válido', () => {
    const ctx = { montosPorRenglon: null, acreditadoPorRenglon: new Map(), saldo: s16(5000, 800, 5800) }
    const invalido = { reason: 'IMPORTE_DEVUELTO_INVALIDO', message: MOTIVO_IMPORTE_DEVUELTO_INVALIDO }
    for (const salesRefundCents of [Number.NaN, 10.5, -500, undefined as unknown as number, Number.POSITIVE_INFINITY]) {
      let r: unknown
      expect(() => (r = repartoDeLaDevolucion({ salesRefundCents, refundedItems: [], congelado: null }, ctx))).not.toThrow()
      expect(r).toEqual(invalido)
    }
    expect(
      repartoDeLaDevolucion({ salesRefundCents: -1, refundedItems: [{ orderItemId: 'a', amountCents: -1 }], congelado: null }, ctx),
    ).toEqual(invalido)
    expect(repartoDeLaDevolucion({ salesRefundCents: 0.5, refundedItems: [], congelado: { IVA_16: 0.5 } }, ctx)).toEqual(invalido)
    expect(repartoDeLaDevolucion({ salesRefundCents: 0, refundedItems: [], congelado: null }, ctx)).toEqual({
      modalidad: 'POR_IMPORTE',
      brutoPorTratamiento: {},
    })
  })
  it('control — M-1 (C2-17 por clave): en cada tasa, Σ por clave de |base + IVA − total| = |ajuste de la tasa|; sin ajuste, base + IVA = total en cada clave', () => {
    const mezclas = [
      (p: number, d: number) => [incluido(p, 'Tasa', 0.16, d), incluido(p + 37, 'Tasa', 0.16)],
      (p: number, d: number) => [incluido(p, 'Tasa', 0.16, d), incluido(p + 37, 'Tasa', 0.16), incluido(p + 11, 'Tasa', 0)],
      (p: number, d: number) => [
        incluido(p, 'Tasa', 0.16, d),
        incluido(p + 11, 'Tasa', 0, d),
        incluido(p + 23, 'Exento', 0, d),
        incluido(p + 5, null),
      ],
      (p: number, d: number) => [incluido(p, 'Tasa', 0.16, d), incluido(p, 'Tasa', 0.16, d)],
    ]
    let conAjuste = 0
    for (let p = 100; p <= 30000; p += 997)
      for (const d of [0, 1, 49, 99])
        for (const m of mezclas) {
          const a = asig(m(p, d))
          for (const t of Object.keys(a.porTratamiento) as Array<keyof Asignacion['porTratamiento']>) {
            const desvio = [...a.porClave.values()].reduce(
              (s, k) => s + Math.abs((k[t]?.baseCents ?? 0) + (k[t]?.ivaCents ?? 0) - (k[t]?.totalCents ?? 0)),
              0,
            )
            expect(desvio).toBe(Math.abs(a.ajustePorTratamiento[t] ?? 0))
            if (a.ajustePorTratamiento[t]) conAjuste++
          }
        }
    expect(conAjuste).toBeGreaterThan(0) // la propiedad se ejerce también con ajuste
  })
  it('control — M-2: un ajuste de 2 ¢ en una tasa se asigna y se declara; de 3 ¢ (más que MAX_AJUSTE_DOCUMENTO_CENTS) ⇒ inválido', () => {
    const tr16 = (base: string, importe: string) => ({ impuesto: '002', tipoFactor: 'Tasa' as const, tasa: '0.160000', base, importe })
    const x = (importe: string, subTotal: string, total: string): XmlConceptos => ({
      version: 1,
      subTotal,
      descuento: '0',
      total,
      totalImpuestosTrasladados: '16.00',
      conceptos: [{ noIdentificacion: null, objetoImp: '02', importe, descuento: '0', traslados: [tr16('100.000000', '16.000000')] }],
    })
    const tb = [tr16('100.00', '16.00')]
    const dos = x('100.020000', '100.02', '116.02')
    const tres = x('100.030000', '100.03', '116.03')
    expect(asignacionFiscal(unidadesDelXml(dos), documentoDelXml(dos), resumenDelXml(tb))).toMatchObject({
      ajustePorTratamiento: { IVA_16: 2 },
    })
    expect(asignacionFiscal(unidadesDelXml(tres), documentoDelXml(tres), resumenDelXml(tb))).toEqual({ invalido: MOTIVO_XML_NO_CUADRA })
  })
})

// ─── C2 · Tarea 7: (B) tolerancia de centavos por artículo, (B′) descartada y el texto de lo devuelto de verdad ───
describe('C2 · T7 · el artículo que excede: (B), (B′) y el texto', () => {
  const s16 = (b: number, i: number, t: number) => ({ IVA_16: { baseCents: b, ivaCents: i, totalCents: t } })
  // A $19 − $2.49 (la 6b) y B $35: B quedó congelado en 34.99; el ajuste del 16 % en la original es −1 (medido en la prueba de la nota).
  const montos = new Map([
    ['A', { totalCents: 1651, porTratamiento: { IVA_16: 1651 } }],
    ['B', { totalCents: 3499, porTratamiento: { IVA_16: 3499 } }],
  ])
  const saldo = s16(4440, 710, 5150)
  const d = (cents: number, id = 'B', nombre?: string) => ({
    salesRefundCents: cents,
    refundedItems: [{ orderItemId: id, amountCents: cents, ...(nombre ? { nombre } : {}) }],
    congelado: null,
  })
  it('🔴 (B): B devuelto completo (35.00) excede 1 ¢ y el |ajuste| de SU tasa es 1 ⇒ sale, con el centavo registrado como ARTICULO', () => {
    expect(
      repartoDeLaDevolucion(d(3500), {
        montosPorRenglon: montos,
        acreditadoPorRenglon: new Map(),
        saldo,
        ajustePorTratamiento: { IVA_16: -1 },
      }),
    ).toEqual({
      modalidad: 'POR_ARTICULOS',
      brutoPorTratamiento: { IVA_16: 3500 },
      porRenglon: [{ orderItemId: 'B', totalCents: 3500, porTratamiento: { IVA_16: 3500 } }],
      redondeo: [{ tratamiento: 'IVA_16', componente: 'ARTICULO', cents: 1, ambito: 'FACTURA', orderItemId: 'B' }],
    })
  })
  it('🔴 (B) es ACUMULADA por artículo: con 34.99 ya acreditados de B (por un reparto anterior), otro centavo sí cabe y dos no', () => {
    const ctx = (acreditado: number) => ({
      montosPorRenglon: montos,
      acreditadoPorRenglon: new Map([['B', { IVA_16: acreditado }]]),
      saldo,
      ajustePorTratamiento: { IVA_16: -1 },
    })
    expect(repartoDeLaDevolucion(d(1), ctx(3499))).toMatchObject({ redondeo: [{ componente: 'ARTICULO', cents: 1, orderItemId: 'B' }] })
    expect(repartoDeLaDevolucion(d(2), ctx(3499))).toMatchObject({ reason: 'ARTICULO_EXCEDE_LO_FACTURADO' })
    // y si ya se tomó el centavo (35.00 acreditados), ni uno más
    expect(repartoDeLaDevolucion(d(1), ctx(3500))).toMatchObject({ reason: 'ARTICULO_EXCEDE_LO_FACTURADO' })
  })
  it('🔴 (B) nunca pasa del |ajuste| de su tasa: con ajuste 0 en su tasa y en todas, un centavo de más se detiene con el texto de siempre', () => {
    expect(repartoDeLaDevolucion(d(3500), { montosPorRenglon: montos, acreditadoPorRenglon: new Map(), saldo })).toMatchObject({
      reason: 'ARTICULO_EXCEDE_LO_FACTURADO',
    })
    expect(
      repartoDeLaDevolucion(d(3501), {
        montosPorRenglon: montos,
        acreditadoPorRenglon: new Map(),
        saldo,
        ajustePorTratamiento: { IVA_16: -2 },
      }),
    ).toMatchObject({ redondeo: [{ cents: 2 }] }) // 35.01 − 34.99 = 2 ¢ ≤ |−2|
    expect(
      repartoDeLaDevolucion(d(3502), {
        montosPorRenglon: montos,
        acreditadoPorRenglon: new Map(),
        saldo,
        ajustePorTratamiento: { IVA_16: -2 },
      }),
    ).toMatchObject({ reason: 'ARTICULO_EXCEDE_LO_FACTURADO' })
  })
  // Ronda 1 (I3), dorada que cambia A PROPÓSITO: el motivo ya no afirma «que quedó en otra tasa» (no hay dato para saberlo) y se llama
  // `CENTAVOS_DE_REDONDEO`.
  it('🔴 (B′) descartada: en una MIXTA donde la 6b dejó el centavo en OTRA tasa, se detiene con el texto honesto (no «excede» a secas)', () => {
    expect(
      repartoDeLaDevolucion(d(3500, 'B', 'Pan'), {
        montosPorRenglon: montos,
        acreditadoPorRenglon: new Map(),
        saldo: { ...saldo, IVA_0: { baseCents: 20000, ivaCents: 0, totalCents: 20000 } },
        ajustePorTratamiento: { IVA_0: 1 },
      }),
    ).toEqual({
      reason: 'CENTAVOS_DE_REDONDEO',
      message:
        'La devolución de Pan excede por 1 ¢ lo que se facturó de él. Una diferencia de centavos así suele venir del redondeo de la factura original; esta nota no se puede timbrar aquí: hazla con tu contador.',
    })
  })
  it('🔴 I3 (ronda 1): en una mixta, un exceso de centavos (≤ 2 ¢) se dice honesto AUNQUE el ajuste no esté en otra tasa (no hay dato para saberlo)', () => {
    const mixto = { ...saldo, IVA_0: { baseCents: 20000, ivaCents: 0, totalCents: 20000 } }
    for (const ajustePorTratamiento of [{}, { IVA_16: -1 }])
      expect(
        repartoDeLaDevolucion(d(3500 + (ajustePorTratamiento.IVA_16 ? 1 : 0), 'B'), {
          montosPorRenglon: montos,
          acreditadoPorRenglon: new Map(),
          saldo: mixto,
          ajustePorTratamiento,
        }),
      ).toMatchObject({ reason: 'CENTAVOS_DE_REDONDEO' })
    // Más de 2 ¢ ya no es redondeo: «excede».
    expect(repartoDeLaDevolucion(d(3502, 'B'), { montosPorRenglon: montos, acreditadoPorRenglon: new Map(), saldo: mixto })).toMatchObject({
      reason: 'ARTICULO_EXCEDE_LO_FACTURADO',
    })
  })
  // C2 · OF-2 (nit N-a, cambia A PROPÓSITO): el número es lo FACTURADO del artículo ⇒ «que se facturó en», no «que cobró».
  it('🔴 lo devuelto DE VERDAD contra lo facturado − lo acreditado, sin reescalar; el texto nombra el artículo y los montos', () => {
    expect(repartoDeLaDevolucion(d(10000, 'B', 'Pan dulce'), { montosPorRenglon: montos, acreditadoPorRenglon: new Map(), saldo })).toEqual(
      {
        reason: 'ARTICULO_EXCEDE_LO_FACTURADO',
        message:
          'Se devolvieron $100.00 de «Pan dulce» que se facturó en $34.99: $65.01 de más. La nota no acredita más de lo facturado de ese artículo; revisa la devolución con tu contador.',
      },
    )
    expect(
      repartoDeLaDevolucion(d(2000), { montosPorRenglon: montos, acreditadoPorRenglon: new Map([['B', { IVA_16: 2000 }]]), saldo }),
    ).toEqual({
      reason: 'ARTICULO_EXCEDE_LO_FACTURADO',
      message:
        'Se devolvieron $20.00 de un artículo que se facturó en $34.99 y al que le quedan $14.99 por acreditar: $5.01 de más. La nota no acredita más de lo facturado de ese artículo; revisa la devolución con tu contador.',
    })
  })
  it('🔴 en el ámbito del ticket (la global, T8) el centavo se registra con su ámbito', () => {
    expect(
      repartoDeLaDevolucion(d(3500), {
        montosPorRenglon: montos,
        acreditadoPorRenglon: new Map(),
        saldo,
        ajustePorTratamiento: { IVA_16: 1 },
        ambito: 'TICKET',
      }),
    ).toMatchObject({ redondeo: [{ ambito: 'TICKET', cents: 1 }] })
  })
})

// C2 · OF-2 (T7 N3): lo desconocido baja todo por conservador, salvo el IVA de una tasa que no tiene IVA (siempre 0).
describe('C2 · OF-2 · restar con lo desconocido', () => {
  const c = (baseCents: number, ivaCents: number, totalCents: number) => ({ baseCents, ivaCents, totalCents })
  it('🔴 al 0 %, exento y no objeto: lo desconocido baja base y total, nunca su IVA (antes quedaba negativo)', () => {
    const original = { IVA_0: c(10000, 0, 10000), EXENTO: c(5000, 0, 5000), NO_OBJETO: c(3000, 0, 3000) }
    expect(restar(original, [{ IVA_0: c(4000, 0, 4000) }], 2000)).toEqual({
      IVA_0: c(4000, 0, 4000),
      EXENTO: c(3000, 0, 3000),
      NO_OBJETO: c(1000, 0, 1000),
    })
  })
  it('control — al 16 % y al 8 %, lo desconocido también baja el IVA (conservador, como siempre)', () => {
    expect(restar({ IVA_16: c(8621, 1379, 10000), IVA_8: c(9259, 741, 10000) }, [], 500)).toEqual({
      IVA_16: c(8121, 879, 9500),
      IVA_8: c(8759, 241, 9500),
    })
  })
})
