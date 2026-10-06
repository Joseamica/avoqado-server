/**
 * IVA por producto, bloque B3a (Codex r1 #4, r2, r3; Tarea 1b): el total que calcula el PAC con la regla MEDIDA en el sandbox
 * — por concepto a 6 decimales (con IVA incluido el importe sin descuento se deduce del total); subtotal, descuento e IVA de CADA
 * TASA del documento redondeados aparte. Los totales son los del XML timbrado (`2026-10-01-iva-b3a-regla-del-pac-sandbox.md`,
 * sección «Tarea 1b»), con el id de Facturapi (sandbox) de cada variante. Sin red.
 */
import { Prisma } from '@prisma/client'
import {
  MAX_CENTAVOS_DE_REDONDEO,
  MOTIVO_BUSQUEDA_LIMITADA,
  MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT,
  MOTIVO_MEDIO_CENTAVO_SIN_REGLA,
  MOTIVO_OCHO_SIN_REGLA,
  conceptoDesdeElPayload,
  conceptoSegunElPac,
  conceptoValidoAnteElSat,
  confirmarCuadre,
  cotaDeRedondeoCents,
  cuadrarConElPac,
  documentoSegunElPac,
  motivoNoCuadra,
  totalSegunElPacCents,
  type ConceptoParaElPac,
  type TrasladoParaElPac,
} from '@/services/fiscal/reglaDelPac'

const tasa = (t: number): TrasladoParaElPac => ({ factor: 'Tasa', tasa: t })
const c = (
  precio: number,
  cantidad: number,
  traslado: TrasladoParaElPac,
  o: { descuentoCents?: number; ivaIncluido?: boolean; nombre?: string } = {},
): ConceptoParaElPac => ({
  precio: new Prisma.Decimal(String(precio)),
  cantidad,
  descuentoCents: o.descuentoCents ?? 0,
  ivaIncluido: o.ivaIncluido ?? true,
  traslado,
  ...(o.nombre ? { nombre: o.nombre } : {}),
})
const veces = (n: number, x: ConceptoParaElPac) => Array.from({ length: n }, () => x)

describe('totalSegunElPacCents — los totales que el sandbox timbró (Tarea 1b)', () => {
  it.each([
    // [variante del sandbox (id de Facturapi), conceptos, total del XML en centavos]
    [
      'R1 6ac3ee8d80225496cf0de546 🔴 descuento de cuenta en 2 piezas sin IVA incluido (cobrado 2.38)',
      [
        c(2.03, 1, tasa(0.16), { descuentoCents: 100, ivaIncluido: false }),
        c(2.03, 1, tasa(0.16), { descuentoCents: 100, ivaIncluido: false }),
      ],
      239,
    ],
    [
      'R2 6ac3ee8d80225496cf0de6ec 🔴 precio por kilo derivado con 2 decimales, sin IVA incluido (cobrado 2.50)',
      [c(2.16, 0.5, tasa(0.16), { ivaIncluido: false }), c(2.16, 0.5, tasa(0.16), { ivaIncluido: false })],
      251,
    ],
    [
      'R3 6ac3ee8f80225496cf0de9b4 IVA incluido, dos conceptos con descuento de cuenta',
      [c(100, 1, tasa(0.16), { descuentoCents: 1000 }), c(50, 1, tasa(0.16), { descuentoCents: 500 })],
      13500,
    ],
    [
      'R4 6ac3ee9080225496cf0dea78 16 % + 0 % + exento con descuentos',
      [c(100, 1, tasa(0.16), { descuentoCents: 1000 }), c(50, 1, tasa(0), { descuentoCents: 500 }), c(30, 1, { factor: 'Exento' })],
      16500,
    ],
    [
      'R5 6ac3ee91d7fa32314f5e4a69 🔴 subtotal y descuento redondeados aparte (cobrado 67.50)',
      [c(65, 1, tasa(0.16), { descuentoCents: 233 }), c(5, 1, tasa(0.16), { descuentoCents: 17 })],
      6749,
    ],
    [
      'R6 6ac3ee91d7fa32314f5e4b11 lo que queda tras quitar un concepto, y cuadra (cobrado 116.01)',
      [c(5.8, 1, tasa(0.16), { descuentoCents: 579 }), c(116, 1, tasa(0.16))],
      11601,
    ],
    [
      'R7 6ac3ee92d7fa32314f5e4d25 🔴 lo que queda tras quitar un concepto, y no cuadra (cobrado 116.01)',
      [c(5.04, 1, tasa(0.16), { descuentoCents: 503 }), c(116, 1, tasa(0.16))],
      11600,
    ],
    [
      'L 6ac3ee9b80225496cf0df8e0 🔴 5 × (1.050011 × 99.999 kg) + pieza de $0.01, IVA incluido: el importe se deduce del total (cobrado 525.01)',
      [...veces(5, c(1.050011, 99.999, tasa(0.16))), c(0.01, 1, tasa(0.16))],
      52502,
    ],
    [
      'M 6ac3ee9c80225496cf0dfbc2 🔴 2 × (0.999030 × 1.031 kg) SIN IVA incluido (cobrado 2.38)',
      [c(0.99903, 1.031, tasa(0.16), { ivaIncluido: false }), c(0.99903, 1.031, tasa(0.16), { ivaIncluido: false })],
      239,
    ],
    [
      'K 6ac3ee9cd7fa32314f5e5f4d 🔴 125 × (1.050011 × 99.999 kg) al 0 %: suma los decimales y redondea UNA vez',
      veces(125, c(1.050011, 99.999, tasa(0))),
      1312501,
    ],
    [
      'P1 6ac3f066d7fa32314f60386e (fuera de muestra) 1.050011 × 99.999 kg con $3.00 de descuento, IVA incluido',
      [c(1.050011, 99.999, tasa(0.16), { descuentoCents: 300 })],
      10200,
    ],
    [
      'P2 6ac3f06680225496cf0fd172 (fuera de muestra) 12.34 × 7 con $4.20 + 20.50 × 3 con $6.15, IVA incluido',
      [c(12.34, 7, tasa(0.16), { descuentoCents: 420 }), c(20.5, 3, tasa(0.16), { descuentoCents: 615 })],
      13753,
    ],
    [
      'P3 6ac3f06780225496cf0fd3ac (fuera de muestra) 0.99903 × 1.031 al 16 % + 123.455378 × 0.437 al 0 % con $3.33, IVA incluido',
      [c(0.99903, 1.031, tasa(0.16)), c(123.455378, 0.437, tasa(0), { descuentoCents: 333 })],
      5165,
    ],
  ])('%s', (_v, conceptos, totalCents) => {
    expect(totalSegunElPacCents(conceptos as ConceptoParaElPac[])).toBe(totalCents)
  })

  it('🔴 Codex r3 R3-2: el IVA se redondea POR TASA ($69.16 al 16 % + $0.07 al 8 % ⇒ 9.54 + 0.01 ⇒ 69.24, no 69.23)', () => {
    expect(totalSegunElPacCents([c(69.16, 1, tasa(0.16)), c(0.07, 1, tasa(0.08))])).toBe(6924)
  })

  it('un concepto «no objeto» (sin traslado) no suma impuesto', () => {
    expect(totalSegunElPacCents([c(50, 1, null)])).toBe(5000)
  })

  it('G 6ac3eea0d7fa32314f5e6785 (control): un concepto de cobro 0 no entra al resumen de traslados ⇒ 10.00', () => {
    expect(totalSegunElPacCents([c(45, 1, tasa(0.16), { descuentoCents: 4500 }), c(10, 1, tasa(0.16))])).toBe(1000)
  })
})

describe('cuadrarConElPac — toda factura individual da lo cobrado (Tarea 6b v4, founder 5-oct)', () => {
  const hoy = { desbloqueado: false }
  const doc = (subtotalCents: number, descuentoCents: number, ivaCents: number, totalCents: number) => ({
    subtotalCents,
    descuentoCents,
    ivaCents,
    totalCents,
  })
  const enUno = (n: number) => Array.from({ length: n }, (_, i) => [i, 0, 1])

  it('control (R3): el PAC ya da lo cobrado ⇒ sin ajustes, los mismos conceptos', () => {
    const cs = [c(100, 1, tasa(0.16), { descuentoCents: 1000 }), c(50, 1, tasa(0.16), { descuentoCents: 500 })]
    expect(cuadrarConElPac(cs, 13500, hoy)).toEqual({ ok: true, conceptos: cs, ajustes: [], documento: doc(12931, 1293, 1862, 13500) })
  })

  it.each([
    // [caso, conceptos, cobrado, ajustes [indice, de, a], documento del PAC ya ajustado]
    [
      '🔴 el del founder: $65 con $2.50 propios (62.49)',
      [c(65, 1, tasa(0.16), { descuentoCents: 250 })],
      6250,
      [[0, 250, 249]],
      doc(5603, 215, 862, 6250),
    ],
    [
      'R5: $65 + $5 con 2.33 / 0.17 (67.49) ⇒ el de mayor importe',
      [c(65, 1, tasa(0.16), { descuentoCents: 233 }), c(5, 1, tasa(0.16), { descuentoCents: 17 })],
      6750,
      [[0, 233, 232]],
      doc(6034, 215, 931, 6750),
    ],
    [
      'R5 al revés: decide el importe, no la posición',
      [c(5, 1, tasa(0.16), { descuentoCents: 17 }), c(65, 1, tasa(0.16), { descuentoCents: 233 })],
      6750,
      [[1, 233, 232]],
      doc(6034, 215, 931, 6750),
    ],
    [
      'primero el que ya trae descuento: $10 sin descuento + $3 con $0.99 (12.02)',
      [c(10, 1, tasa(0.16)), c(3, 1, tasa(0.16), { descuentoCents: 99 })],
      1201,
      [[1, 99, 100]],
      doc(1121, 86, 166, 1201),
    ],
    [
      'R1: 2 × $2.03 sin IVA incluido con $1 cada una (2.39)',
      veces(2, c(2.03, 1, tasa(0.16), { descuentoCents: 100, ivaIncluido: false })),
      238,
      [[0, 100, 101]],
      doc(406, 201, 33, 238),
    ],
    [
      'R7: $5.04 con $5.03 + $116 (116.00) ⇒ menos descuento',
      [c(5.04, 1, tasa(0.16), { descuentoCents: 503 }), c(116, 1, tasa(0.16))],
      11601,
      [[0, 503, 502]],
      doc(10434, 433, 1600, 11601),
    ],
    [
      'M: 2 × (0.99903 × 1.031 kg) sin IVA incluido (2.39)',
      veces(2, c(0.99903, 1.031, tasa(0.16), { ivaIncluido: false })),
      238,
      [[0, 0, 1]],
      doc(206, 1, 33, 238),
    ],
    [
      'K: 125 × (1.050011 × 99.999 kg) al 0 % (13,125.01)',
      veces(125, c(1.050011, 99.999, tasa(0))),
      1312500,
      [[0, 0, 1]],
      doc(1312501, 1, 0, 1312500),
    ],
    [
      'baja hasta 0, nunca negativo: $1.05 con $0.01 + $1.04 sin IVA incluido (2.41)',
      [c(1.05, 1, tasa(0.16), { descuentoCents: 1, ivaIncluido: false }), c(1.04, 1, tasa(0.16), { ivaIncluido: false })],
      242,
      [[0, 1, 0]],
      doc(209, 0, 33, 242),
    ],
    [
      '🔴 nunca deja un concepto en base 0: $0.05 con $0.04 (con $0.05 cuadraría) + $1.00 (1.02)',
      [c(0.05, 1, tasa(0.16), { descuentoCents: 4 }), c(1, 1, tasa(0.16))],
      101,
      [[1, 0, 1]],
      doc(91, 4, 14, 101),
    ],
    [
      '16 % + 0 %: el de 0 % no tiene descuento que bajar ⇒ sólo el de 16 %',
      [c(65, 1, tasa(0.16), { descuentoCents: 250 }), c(50, 1, tasa(0))],
      11250,
      [[0, 250, 249]],
      doc(10603, 215, 862, 11250),
    ],
    [
      '5 × $1.03 sin IVA incluido (5.97 contra 5.95) ⇒ un centavo a dos conceptos',
      veces(5, c(1.03, 1, tasa(0.16), { ivaIncluido: false })),
      595,
      enUno(2),
      doc(515, 2, 82, 595),
    ],
    [
      '🔴 Codex r1 #1a: 10 × $10.03 sin IVA incluido (116.35 contra 116.30) ⇒ un centavo a cuatro',
      veces(10, c(10.03, 1, tasa(0.16), { ivaIncluido: false })),
      11630,
      enUno(4),
      doc(10030, 4, 1604, 11630),
    ],
    [
      '🔴 Codex r1 #1b: $10 al 16 % con $0.18 + $50 al 0 % (59.81 contra 59.82) ⇒ grupos en sentidos opuestos',
      [c(10, 1, tasa(0.16), { descuentoCents: 18 }), c(50, 1, tasa(0))],
      5982,
      [
        [0, 18, 17],
        [1, 0, 1],
      ],
      doc(5862, 16, 136, 5982),
    ],
    [
      '🔴 Codex r2 N1a: 20,000 × $0.02 con $0.02 + $0.11 (400.08) ⇒ sentidos opuestos DENTRO del 16 %',
      [c(0.02, 20000, tasa(0.16), { descuentoCents: 2 }), c(0.11, 1, tasa(0.16))],
      40009,
      [
        [0, 2, 0],
        [1, 0, 1],
      ],
      doc(34491, 1, 5519, 40009), // 6b sandbox: con descuento 0 el traslado es T − Bq (antes 34492 / 5518)
    ],
    [
      '🔴 Codex r2 N1b: 40,000 × $0.02 con $0.03 + $0.11 (800.07) ⇒ −3 y +2',
      [c(0.02, 40000, tasa(0.16), { descuentoCents: 3 }), c(0.11, 1, tasa(0.16))],
      80008,
      [
        [0, 3, 0],
        [1, 0, 2],
      ],
      doc(68973, 2, 11037, 80008), // 6b sandbox: con descuento 0 el traslado es T − Bq (antes 68975 / 11035)
    ],
    [
      '🔴 Codex r2 N2: 30 × $10.03 sin IVA incluido (349.04 contra 348.90: 14 ¢) ⇒ un centavo a doce (rueda)',
      veces(30, c(10.03, 1, tasa(0.16), { ivaIncluido: false })),
      34890,
      enUno(12),
      doc(30090, 12, 4812, 34890),
    ],
    [
      '🔴 Codex r3 R3-1: 5 × (1.00 × 9,999.996 kg) con $0.01, IVA incluido (49,999.92 contra 49,999.95): el residuo pide −2 neto',
      veces(5, c(1, 9999.996, tasa(0.16), { descuentoCents: 1 })),
      4999995,
      [
        [0, 1, 0],
        [1, 1, 0],
      ],
      doc(4310343, 3, 689655, 4999995),
    ],
    [
      '🔴 Codex r3 R3-2: seis de ésos (59,999.92 contra 59,999.94) ⇒ un trío de −1',
      veces(6, c(1, 9999.996, tasa(0.16), { descuentoCents: 1 })),
      5999994,
      [
        [0, 1, 0],
        [1, 1, 0],
        [2, 1, 0],
      ],
      doc(5172412, 3, 827585, 5999994),
    ],
    [
      '🔴 Codex r3 R3-2: 30 × (9.728419 × 1.031 kg) sin IVA incluido: el IVA aparte es lineal aun con importe fraccionario',
      veces(30, c(9.728419, 1.031, tasa(0.16), { ivaIncluido: false })),
      34890,
      enUno(12),
      doc(30090, 12, 4812, 34890),
    ],
    [
      '🔴 Codex r3 R3-2: 60,000 × $0.02 con $0.04 + $0.11 (1,200.06) ⇒ −4 y +3',
      [c(0.02, 60000, tasa(0.16), { descuentoCents: 4 }), c(0.11, 1, tasa(0.16))],
      120007,
      [
        [0, 4, 0],
        [1, 0, 3],
      ],
      doc(103455, 3, 16555, 120007), // 6b sandbox: con descuento 0 el traslado es T − Bq (antes 103458 / 16552)
    ],
    [
      '🔴 Codex r3 R3-3: capacidades: el 16 % sólo admite 1 ¢ más y el 0 %, 4 ¢ (0.41 contra 0.36)',
      [
        ...veces(29, c(10, 1, tasa(0.16), { descuentoCents: 999, ivaIncluido: false })),
        c(10, 1, tasa(0.16), { descuentoCents: 998, ivaIncluido: false }),
        c(10, 1, tasa(0), { descuentoCents: 995, ivaIncluido: false }),
      ],
      36,
      [
        [29, 998, 999],
        [30, 995, 999],
      ],
      doc(31000, 30969, 5, 36),
    ],
  ])('%s', (_caso, cs, cobrado, ajustes, documento) => {
    const lista = cs as ConceptoParaElPac[]
    const r = cuadrarConElPac(lista, cobrado as number, hoy)
    const esperados = (ajustes as number[][]).map(([indice, deCents, aCents]) => ({ indice, deCents, aCents }))
    expect(r).toMatchObject({ ok: true, ajustes: esperados, documento })
    if (!r.ok) return
    // Sólo cambia `descuentoCents` de los ajustados (tasa y tratamiento intactos); los demás son los mismos objetos.
    r.conceptos.forEach((x, j) => {
      const a = esperados.find(e => e.indice === j)
      if (a) expect(x).toEqual({ ...lista[j], descuentoCents: a.aCents })
      else expect(x).toBe(lista[j])
    })
  })

  it.each([
    [
      'R2: IVA aparte, un solo grupo: el total salta de 2.51 a 2.49 con un centavo de la suma',
      veces(2, c(2.16, 0.5, tasa(0.16), { ivaIncluido: false })),
      250,
      251,
    ],
    [
      'L: IVA incluido, sin descuentos: con su residuo (0.025 ¢) el neto sólo puede ser +1, y en cualquier producto da 525.00',
      [...veces(5, c(1.050011, 99.999, tasa(0.16))), c(0.01, 1, tasa(0.16))],
      52501,
      52502,
    ],
    [
      '125 × (1.050011 × 99.999 kg) al 16 %: residuo 0.625 ¢ ⇒ neto +1 o +2; los dos dan 13,124.99 y 13,124.98',
      veces(125, c(1.050011, 99.999, tasa(0.16))),
      1312500,
      1312501,
    ],
    [
      '🔴 decisión del founder: 2 × $1.04 sin IVA incluido, cobrado 2.42 — el máximo posible es 2.41 y todo descuento lo baja (Codex r3 enumeró las 10,816 combinaciones)',
      veces(2, c(1.04, 1, tasa(0.16), { ivaIncluido: false })),
      242,
      241,
    ],
    [
      'Codex r1 #3, lo que queda tras D9: un solo concepto, $84.16 con $1.26 (82.89 contra 82.90)',
      [c(84.16, 1, tasa(0.16), { descuentoCents: 126 })],
      8290,
      8289,
    ],
  ])('%s ⇒ se detiene con su motivo', (_caso, cs, cobrado, pac) => {
    expect(cuadrarConElPac(cs as ConceptoParaElPac[], cobrado as number, hoy)).toEqual({
      ok: false,
      motivo: motivoNoCuadra(pac as number, cobrado as number),
    })
  })

  it('🔴 Codex r1 #2: bajar el descuento de 20,000 × $0.02 a $0.01 deja el descuento fiscal en −0.000179: inválido ante el SAT', () => {
    const candidato = c(0.02, 20000, tasa(0.16), { descuentoCents: 1 })
    expect(conceptoSegunElPac(candidato).descuento.toFixed(6)).toBe('-0.000179')
    expect(conceptoValidoAnteElSat(candidato)).toBe(false)
    expect(conceptoValidoAnteElSat(c(0.02, 20000, tasa(0.16), { descuentoCents: 2 }))).toBe(true) // 0.008441
  })

  it('un documento que ya trae un concepto inválido no se cuadra: se detiene con su motivo', () => {
    expect(cuadrarConElPac([c(0.02, 20000, tasa(0.16), { descuentoCents: 1 }), c(0.11, 1, tasa(0.16))], 40010, hoy)).toEqual({
      ok: false,
      motivo: MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT,
    })
  })

  it('🔴 Codex r1 #6: el orden de captura no decide (Té/Agua empatados: decide el nombre)', () => {
    const te = c(2.03, 1, tasa(0.16), { descuentoCents: 100, ivaIncluido: false, nombre: 'Té' })
    const agua = c(2.03, 1, tasa(0.16), { descuentoCents: 100, ivaIncluido: false, nombre: 'Agua' })
    for (const cs of [
      [te, agua],
      [agua, te],
    ]) {
      const r = cuadrarConElPac(cs, 238, hoy)
      expect(r.ok && r.conceptos.map(x => [x.nombre, x.descuentoCents])).toEqual(cs.map(x => [x.nombre, x.nombre === 'Agua' ? 101 : 100]))
    }
  })

  it('🔴 Codex r2 N6: tasa 0 y Exento empatados (mismo nombre, precio y descuento): decide el tratamiento, no la posición', () => {
    const cafe = c(65, 1, tasa(0.16), { descuentoCents: 250 })
    const cero = c(50, 1, tasa(0), { descuentoCents: 1, nombre: 'Igual' })
    const exento = c(50, 1, { factor: 'Exento' }, { descuentoCents: 1, nombre: 'Igual' })
    for (const cs of [
      [cafe, cero, exento],
      [cafe, exento, cero],
    ]) {
      const r = cuadrarConElPac(cs, 16248, hoy)
      expect(r.ok && r.conceptos.map(x => [x.traslado?.factor === 'Exento' ? 'Exento' : x.traslado?.factor, x.descuentoCents])).toEqual(
        cs.map(x => [x.traslado?.factor === 'Exento' ? 'Exento' : x.traslado?.factor, x === exento ? 0 : x.descuentoCents]),
      )
    }
  })

  it('límite operativo: con menos clases permitidas que las que hay, no prueba parejas y lo dice (no afirma que no exista)', () => {
    const n1a = [c(0.02, 20000, tasa(0.16), { descuentoCents: 2 }), c(0.11, 1, tasa(0.16))]
    expect(cuadrarConElPac(n1a, 40009, { desbloqueado: false, maxClases: 1 })).toEqual({ ok: false, motivo: MOTIVO_BUSQUEDA_LIMITADA })
  })

  it('límite DECLARADO: 80,000 × $0.02 con $0.06 + $0.13 (1,600.06 contra 1,600.07) se detiene con «no encontramos»; más hondo (10 ¢) cuadraría con −6 y +6', () => {
    const cs = [c(0.02, 80000, tasa(0.16), { descuentoCents: 6 }), c(0.13, 1, tasa(0.16))]
    expect(cuadrarConElPac(cs, 160007, hoy)).toEqual({ ok: false, motivo: motivoNoCuadra(160006, 160007) })
    expect(cuadrarConElPac(cs, 160007, { desbloqueado: false, maxCentavos: 10 })).toMatchObject({
      ok: true,
      ajustes: [
        { indice: 0, deCents: 6, aCents: 0 },
        { indice: 1, deCents: 0, aCents: 6 },
      ],
    })
  })

  it('🔴 Codex r3 R3-4 + revisión Men-1: el límite cuenta los REPRESENTANTES que se prueban (hasta 3 por clase), no renglones: cinco renglones idénticos son 3', () => {
    const cinco = veces(5, c(1, 9999.996, tasa(0.16), { descuentoCents: 1 }))
    expect(cuadrarConElPac(cinco, 4999995, { desbloqueado: false, maxClases: 3 })).toMatchObject({ ok: true })
    expect(cuadrarConElPac(cinco, 4999995, { desbloqueado: false, maxClases: 2 })).toEqual({ ok: false, motivo: MOTIVO_BUSQUEDA_LIMITADA })
  })

  describe('confirmarCuadre — el resultado se recalcula desde cero antes de darlo por bueno (revisión Men-2)', () => {
    it('control: el R5 ya ajustado (2.32 / 0.17) da lo cobrado ⇒ ok con su documento', () => {
      const cs = [c(65, 1, tasa(0.16), { descuentoCents: 232 }), c(5, 1, tasa(0.16), { descuentoCents: 17 })]
      expect(confirmarCuadre(cs, [{ indice: 0, deCents: 233, aCents: 232 }], 6750, 6749)).toEqual({
        ok: true,
        conceptos: cs,
        ajustes: [{ indice: 0, deCents: 233, aCents: 232 }],
        documento: documentoSegunElPac(cs),
      })
    })
    it('🔴 un resultado cuyo documento NO da lo cobrado (un atajo de la búsqueda que fallara) ⇒ se detiene, no devuelve ok', () => {
      const cs = [c(65, 1, tasa(0.16), { descuentoCents: 233 }), c(5, 1, tasa(0.16), { descuentoCents: 17 })] // 67.49
      expect(confirmarCuadre(cs, [], 6750, 6749)).toEqual({ ok: false, motivo: motivoNoCuadra(6749, 6750) })
    })
    it('🔴 un resultado con un concepto inválido ante el SAT ⇒ se detiene con su motivo, aunque el total cuadre', () => {
      const cs = [c(0.02, 20000, tasa(0.16), { descuentoCents: 1 }), c(0.11, 1, tasa(0.16))]
      const total = documentoSegunElPac(cs).totalCents
      expect(confirmarCuadre(cs, [], total, total)).toEqual({ ok: false, motivo: MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT })
    })
  })

  it('el motivo dice las dos cantidades, en pesos', () => {
    expect(motivoNoCuadra(251, 250)).toContain('$2.51')
    expect(motivoNoCuadra(251, 250)).toContain('$2.50')
  })

  it('8 %: lo desbloqueado se detiene aunque cuadre; lo de hoy sale como hoy si cuadra; y nunca se ajusta con una regla sin medir', () => {
    const o = [c(69.16, 1, tasa(0.16)), c(0.07, 1, tasa(0.08))]
    expect(cuadrarConElPac(o, 6924, { desbloqueado: true })).toEqual({ ok: false, motivo: MOTIVO_OCHO_SIN_REGLA })
    expect(cuadrarConElPac(o, 6924, hoy)).toMatchObject({ ok: true, ajustes: [] })
    // $65 con $2.50 al 8 %: el modelo da 62.51 (con 2.51 daría 62.50), pero el 8 % no se ajusta.
    expect(cuadrarConElPac([c(65, 1, tasa(0.08), { descuentoCents: 250 })], 6250, hoy)).toEqual({
      ok: false,
      motivo: MOTIVO_OCHO_SIN_REGLA,
    })
  })

  it('zona prohibida (E 6ac3ee9ed7fa32314f5e6380): 45 × 1.537 con IVA incluido ⇒ su motivo, también sin marca', () => {
    expect(cuadrarConElPac([c(45, 1.537, tasa(0.16))], 6916, hoy)).toEqual({ ok: false, motivo: MOTIVO_MEDIO_CENTAVO_SIN_REGLA })
  })

  it('control — un paso al lado: 45 × 1.536 = 69.12 ⇒ sin ajustes', () => {
    expect(cuadrarConElPac([c(45, 1.536, tasa(0.16))], 6912, hoy)).toMatchObject({ ok: true, ajustes: [] })
  })

  it('la búsqueda no pierde soluciones: 500 ventas al azar (1-3 conceptos; la mitad, difíciles: IVA incluido con cantidades enormes de precios de centavos) contra fuerza bruta de −3 a +3 centavos por concepto', () => {
    let s = 20261005
    const azar = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const entre = (a: number, b: number) => a + Math.floor(azar() * (b - a + 1))
    const importe = (x: ConceptoParaElPac) => x.precio.mul(x.cantidad).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber()
    const tratamientos: TrasladoParaElPac[] = [tasa(0.16), tasa(0.16), tasa(0.16), tasa(0), { factor: 'Exento' }, null]
    let resueltasPorLaBruta = 0
    for (let k = 0; k < 500; k++) {
      // Una de cada dos ventas es «difícil»: IVA incluido al 16 % con muchas cantidades enormes (las que piden sentidos opuestos).
      const dificil = k % 2 === 0
      const incluido = dificil || azar() < 0.75
      const cs = Array.from({ length: entre(1, 3) }, () => {
        const rugoso = incluido && azar() < (dificil ? 0.4 : 0.2)
        const precio = rugoso ? entre(1, 9) : entre(1, 20000)
        const cantidad = rugoso ? entre(5000, 60000) : entre(1, 4)
        const d =
          azar() < 0.6
            ? Math.min(azar() < 0.5 ? entre(1, 5) : entre(1, Math.max(1, Math.floor((precio * cantidad) / 3))), precio * cantidad - 1)
            : 0
        return c(precio / 100, cantidad, dificil ? tasa(0.16) : tratamientos[entre(0, 5)], { descuentoCents: d, ivaIncluido: incluido })
      })
      if (!cs.every(x => conceptoValidoAnteElSat(x))) continue
      const tasaDe = (x: ConceptoParaElPac) => (x.traslado?.factor === 'Tasa' ? x.traslado.tasa : 0)
      const cobrado = cs.reduce(
        (t, x) => t + (incluido ? importe(x) - x.descuentoCents : Math.round((importe(x) - x.descuentoCents) * (1 + tasaDe(x)))),
        0,
      )
      if (documentoSegunElPac(cs).totalCents === cobrado) continue
      // Fuerza bruta: todas las combinaciones de −3..+3 por concepto, con las mismas reglas.
      const opciones = cs.map(x =>
        [-3, -2, -1, 0, 1, 2, 3].filter(d => {
          const a = x.descuentoCents + d
          if (a < 0 || (d !== 0 && a >= importe(x))) return false
          const nuevo = { ...x, descuentoCents: a }
          return d === 0 || (conceptoValidoAnteElSat(nuevo) && !conceptoSegunElPac(nuevo).base.isZero())
        }),
      )
      const combinar = (i: number, acum: number[]): boolean =>
        i === cs.length
          ? acum.some(d => d !== 0) &&
            documentoSegunElPac(cs.map((x, j) => ({ ...x, descuentoCents: x.descuentoCents + acum[j] }))).totalCents === cobrado
          : opciones[i].some(d => combinar(i + 1, [...acum, d]))
      if (!combinar(0, [])) continue
      resueltasPorLaBruta++
      expect(cuadrarConElPac(cs, cobrado, hoy)).toMatchObject({ ok: true })
    }
    expect(resueltasPorLaBruta).toBeGreaterThan(35)
  })
})

describe('documentoSegunElPac y conceptoDesdeElPayload', () => {
  it('el documento es el del XML: R5 del sandbox ⇒ SubTotal 60.34, Descuento 2.16, IVA 9.31, Total 67.49', () => {
    expect(documentoSegunElPac([c(65, 1, tasa(0.16), { descuentoCents: 233 }), c(5, 1, tasa(0.16), { descuentoCents: 17 })])).toEqual({
      subtotalCents: 6034,
      descuentoCents: 216,
      ivaCents: 931,
      totalCents: 6749,
    })
  })
  const iva = (factor: 'Tasa' | 'Exento', rate: number) => [{ type: 'IVA' as const, factor, rate, withholding: false }]
  const plano = (x: ConceptoParaElPac) => ({ ...x, precio: x.precio.toString() })
  it.each([
    [
      'IVA incluido al 16 % con descuento',
      {
        description: 'Latte',
        unitPriceCents: 6500,
        quantity: 1,
        discountCents: 249,
        taxIncluded: true,
        objetoImp: '02',
        taxes: iva('Tasa', 0.16),
      },
      { precio: '65', cantidad: 1, descuentoCents: 249, ivaIncluido: true, traslado: { factor: 'Tasa', tasa: 0.16 }, nombre: 'Latte' },
    ],
    [
      'IVA aparte',
      {
        description: 'Renta',
        unitPriceCents: 20000,
        quantity: 1,
        discountCents: 0,
        taxIncluded: false,
        objetoImp: '02',
        taxes: iva('Tasa', 0.16),
      },
      { precio: '200', cantidad: 1, descuentoCents: 0, ivaIncluido: false, traslado: { factor: 'Tasa', tasa: 0.16 }, nombre: 'Renta' },
    ],
    [
      'Exento',
      {
        description: 'Consulta',
        unitPriceCents: 3000,
        quantity: 1,
        discountCents: 0,
        taxIncluded: true,
        objetoImp: '02',
        taxes: iva('Exento', 0),
      },
      { precio: '30', cantidad: 1, descuentoCents: 0, ivaIncluido: true, traslado: { factor: 'Exento' }, nombre: 'Consulta' },
    ],
    [
      'no objeto (01) ⇒ sin traslado',
      { description: 'Propina', unitPriceCents: 5000, quantity: 1, discountCents: 0, taxIncluded: true, objetoImp: '01', taxes: [] },
      { precio: '50', cantidad: 1, descuentoCents: 0, ivaIncluido: true, traslado: null, nombre: 'Propina' },
    ],
    [
      'el precio decimal de la Tarea 6 manda sobre los centavos',
      {
        description: 'Jamón',
        unitPriceCents: 4500,
        unitPriceDecimal: '44.996747',
        quantity: 1.537,
        discountCents: 0,
        taxIncluded: true,
        objetoImp: '02',
        taxes: iva('Tasa', 0.16),
      },
      {
        precio: '44.996747',
        cantidad: 1.537,
        descuentoCents: 0,
        ivaIncluido: true,
        traslado: { factor: 'Tasa', tasa: 0.16 },
        nombre: 'Jamón',
      },
    ],
    [
      // Revisión Men-3: misma condición que el proveedor (`unitPriceDecimal != null ? Number(…)`): una cadena vacía le llega a Facturapi
      // como precio 0, así que la barrera tiene que medir precio 0, no los centavos.
      'precio decimal vacío: se lee como lo manda el proveedor (Number("") = 0)',
      {
        description: 'Raro',
        unitPriceCents: 4500,
        unitPriceDecimal: '',
        quantity: 1,
        discountCents: 0,
        taxIncluded: true,
        objetoImp: '02',
        taxes: iva('Tasa', 0.16),
      },
      { precio: '0', cantidad: 1, descuentoCents: 0, ivaIncluido: true, traslado: { factor: 'Tasa', tasa: 0.16 }, nombre: 'Raro' },
    ],
  ])('%s', (_caso, item, esperado) => {
    expect(plano(conceptoDesdeElPayload(item as any))).toEqual(esperado)
  })
})

describe('conceptoSegunElPac — los valores POR CONCEPTO del XML (lo que distingue la regla de la Tarea 1b del modelo r6 del brief)', () => {
  const a6 = (x: { toFixed: (n: number) => string }) => x.toFixed(6)
  it('🔴 L 6ac3ee9b80225496cf0df8e0: con IVA incluido y sin descuento el Importe se DEDUCE del total (90.517283), la Base es VU × q (90.517295)', () => {
    const x = conceptoSegunElPac(c(1.050011, 99.999, tasa(0.16)))
    expect([a6(x.importe), a6(x.base)]).toEqual(['90.517283', '90.517295'])
  })
  it('🔴 P1 6ac3f066d7fa32314f60386e: con descuento el Importe es VU × q (90.517295) y el Descuento = Importe − ((T − D) − traslado) (2.586219, no 2.586207)', () => {
    const x = conceptoSegunElPac(c(1.050011, 99.999, tasa(0.16), { descuentoCents: 300 }))
    expect([a6(x.importe), a6(x.descuento)]).toEqual(['90.517295', '2.586219'])
  })
  it('🔴 R3 6ac3ee8f80225496cf0de9b4, segundo concepto ($50 con $5): Descuento 4.310344 (el modelo r6 del brief daba 4.310345)', () => {
    expect(a6(conceptoSegunElPac(c(50, 1, tasa(0.16), { descuentoCents: 500 })).descuento)).toBe('4.310344')
  })

  // B3a Tarea 6b, sandbox discriminante (task-6b-sandbox-report.md, 10 XML con la carga exacta del cargador): con IVA incluido y SIN
  // descuento el PAC obliga a que el renglón sume exacto: traslado = max(r6(Bq × t), T − Bq), Importe = T − traslado y, si el traslado
  // no es r6(Bq × t), Base = r6(traslado / t). Valores copiados de los XML (16 %, IVA incluido, descuento 0).
  it.each([
    // [concepto del sandbox, precio, cantidad, Importe, Base, Traslado]
    ['F5.1 160 × 1 (le falta: va al traslado)', 160, 1, '137.931034', '137.931038', '22.068966'],
    ['F1.2 100 × 1 (le sobra: sale del importe)', 100, 1, '86.206896', '86.206897', '13.793104'],
    ['F3.3 50 × 2 (le falta: va al traslado)', 50, 2, '86.206896', '86.206900', '13.793104'],
    ['F4.1 75 × 2 (le falta: va al traslado)', 75, 2, '129.310344', '129.310350', '20.689656'],
    ['F2.1 65 × 2 (le sobra: sale del importe)', 65, 2, '112.068965', '112.068966', '17.931035'],
    ['F6.6 70 × 2', 70, 2, '120.689655', '120.689656', '19.310345'],
    ['F6.5 10 × 1 (exacto)', 10, 1, '8.620690', '8.620690', '1.379310'],
    ['E 6ac3ee9ed7fa32314f5e6380 (Tarea 1b) 45 × 1.537', 45, 1.537, '59.624999', '59.625006', '9.540001'],
  ])('🔴 6b sandbox, sin descuento: %s', (_caso, precio, cantidad, importe, base, traslado) => {
    const x = conceptoSegunElPac(c(precio as number, cantidad as number, tasa(0.16)))
    expect([a6(x.importe), a6(x.descuento), a6(x.base), a6(x.traslado)]).toEqual([importe, '0.000000', base, traslado])
  })

  it.each([
    // [concepto del sandbox, precio, cantidad, descuento en centavos, Importe, Descuento, Base, Traslado]
    ['F10.1 10 × 3 con $2.50', 10, 3, 250, '25.862070', '2.155174', '23.706898', '3.793104'],
    ['F7.6 50 × 2 con $0.50', 50, 2, 50, '86.206896', '0.431034', '85.775862', '13.724138'],
  ])('control — 6b sandbox, con descuento la regla no cambia: %s', (_caso, precio, cantidad, d, importe, descuento, base, traslado) => {
    const x = conceptoSegunElPac(c(precio as number, cantidad as number, tasa(0.16), { descuentoCents: d as number }))
    expect([a6(x.importe), a6(x.descuento), a6(x.base), a6(x.traslado)]).toEqual([importe, descuento, base, traslado])
  })
})

describe('peso (Tarea 6, D9) — las variantes del grupo PESO que el sandbox midió (controles del modelo de la Tarea 3)', () => {
  it.each([
    // [variante del sandbox, conceptos, total medido en centavos]
    ['A una línea, 16 %', [c(44.996747, 1.537, tasa(0.16))], 6916],
    ['B una línea, 0 %', [c(44.996747, 1.537, tasa(0))], 6916],
    ['C con $5 de descuento', [c(44.996747, 1.537, tasa(0.16), { descuentoCents: 500 })], 6416],
    ['D 0.437 kg', [c(123.455378, 0.437, tasa(0.16))], 5395],
    [
      'H varias líneas al 16 %',
      [
        c(44.996747, 1.537, tasa(0.16), { descuentoCents: 500 }),
        c(100.033333, 0.3, tasa(0.16)),
        c(40, 0.5, tasa(0.16)),
        c(65, 1, tasa(0.16)),
      ],
      17917,
    ],
    ['I varias líneas 16 % y 0 %', [c(44.996747, 1.537, tasa(0.16)), c(100.033333, 0.3, tasa(0)), c(50, 1, tasa(0))], 14917],
    ['J sin IVA incluido', [c(44.996747, 1.537, tasa(0.16), { ivaIncluido: false })], 8023],
    ['L 🔴 base e IVA redondeados aparte (cobrado 525.01)', [...veces(5, c(1.050011, 99.999, tasa(0.16))), c(0.01, 1, tasa(0.16))], 52502],
    ['M 🔴 sin IVA incluido, impuesto acumulado (cobrado 2.38)', veces(2, c(0.99903, 1.031, tasa(0.16), { ivaIncluido: false })), 239],
    ['K 125 conceptos al 0 %: los decimales se suman antes de redondear', veces(125, c(1.050011, 99.999, tasa(0))), 1312501],
  ])('peso · %s', (_v, conceptos, totalCents) => {
    expect(totalSegunElPacCents(conceptos as ConceptoParaElPac[])).toBe(totalCents)
  })

  it('peso · control: precios en centavos de siempre (dorada `peso`, 0.25 kg × $180) ⇒ lo cobrado', () => {
    expect(totalSegunElPacCents([c(180, 0.25, tasa(0.16))])).toBe(4500)
  })
})

// B3a ronda final, ajuste 2: la barrera previa a la búsqueda. Todo lineal ⇒ un centavo por concepto (el redondeo de D16 con IVA aparte
// llega a lo más a n + ½ ¢ con n renglones; la búsqueda cuesta ≈ 1 ms ahí); con algún no lineal, la cota medida de 6 ¢.
describe('cotaDeRedondeoCents (ronda final, ajuste 2)', () => {
  const aparte = (p: number) => c(p, 1, tasa(0.16), { ivaIncluido: false })
  it('🔴 todo con IVA aparte, 8 conceptos ⇒ 8 ¢ (uno por concepto)', () => {
    expect(cotaDeRedondeoCents(veces(8, aparte(10)), 0)).toBe(8)
  })
  it('🔴 todo lineal mezclando IVA aparte, tasa 0 con IVA incluido, exento y sin traslado, 9 conceptos ⇒ 9 ¢', () => {
    const mezcla = [...veces(6, aparte(10)), c(5, 1, tasa(0)), c(5, 1, { factor: 'Exento' }), c(5, 1, null)]
    expect(cotaDeRedondeoCents(mezcla, 0)).toBe(9)
  })
  it('control — todo lineal con pocos conceptos ⇒ nunca baja de la cota medida', () => {
    expect(MAX_CENTAVOS_DE_REDONDEO).toBe(6)
    expect(cotaDeRedondeoCents([aparte(10)], 0)).toBe(6)
    expect(cotaDeRedondeoCents(veces(6, aparte(10)), 0)).toBe(6)
  })
  it('🔴 todo lineal: un concepto y 14 filas de descuento que participan en D16 (cada una redondea una vez) ⇒ 15 ¢ (Codex final r2)', () => {
    expect(cotaDeRedondeoCents([aparte(100)], 14)).toBe(15)
  })
  it('control — con algún no lineal, las filas de D16 no mueven la cota medida', () => {
    expect(cotaDeRedondeoCents([aparte(100), c(10, 1, tasa(0.16))], 14)).toBe(6)
  })
  it('control — con UN solo concepto no lineal (IVA incluido con tasa), la cota medida aunque haya muchos lineales', () => {
    expect(cotaDeRedondeoCents([...veces(20, aparte(10)), c(10, 1, tasa(0.16))], 0)).toBe(6)
    expect(cotaDeRedondeoCents(veces(8, c(10, 1, tasa(0.16))), 0)).toBe(6)
  })
})
