/**
 * IVA por producto, bloque C1 (Tarea 3): los conceptos de UN ticket en la global (D4, H3), la forma de la global (H4) y la regla del founder
 * en la global (`cuadrarLaGlobal`: da exactamente lo cobrado con la función de la 6b, detrás de la barrera N3 y con cada tasa sola). Totales
 * del XML del sandbox de la Tarea 1 (`docs/superpowers/reports/2026-10-05-iva-c1-global-sandbox.md`). Sin red.
 */
import {
  aplicarAjustes,
  conceptosDeOrdenGlobal,
  cuadrarLaGlobal,
  cuadrarPorTasa,
  filasD16De,
  montoComercialCents,
  paramsDeLaGlobal,
  pertenenciaAlEmisor,
  MOTIVO_ARMADO_NO_CUADRA,
  SIN_FILAS_D16,
  type OrdenGlobalV2,
} from '../../../../src/services/fiscal/globalPorTratamiento'
import type { CfdiItemInput, CfdiItemTax } from '../../../../src/services/fiscal/providers/fiscal-provider.interface'
import { cotaDeRedondeoCents } from '../../../../src/services/fiscal/reglaDelPac' // la cota de redondeo de B3a: (conceptos, filasD16)
import * as regla from '../../../../src/services/fiscal/reglaDelPac'
import { MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT } from '../../../../src/services/fiscal/reglaDelPac'

const orden = (over: Partial<OrdenGlobalV2>): OrdenGlobalV2 => ({
  orderId: 'o1',
  huella: 'h',
  folio: 'F-1',
  formaPago: '04',
  paidCents: 0,
  renglones: [],
  porTratamiento: {},
  conceptosReales: null,
  filasD16: [],
  ...over,
})
// Conceptos armados de lo cobrado por tratamiento (o líneas IVA incluido): su precio ya es lo cobrado, no les queda redondeo de D16 (C1-43).
const sin = { filasD16: SIN_FILAS_D16 }
const linea = (orderId: string, totalCents: number, formaPago = '04') => ({
  orderId,
  orderNumber: orderId.toUpperCase(),
  totalCents,
  subtotalCents: Math.round(totalCents / 1.16),
  taxCents: totalCents - Math.round(totalCents / 1.16),
  formaPago,
  priceIncludesIva: true,
  taxRate: 0.16,
  objetoImp: '02',
})
// Un concepto IVA incluido de esa tasa; el segundo argumento sobreescribe campos (p. ej. `discountCents`).
const conTasa =
  (rate: number) =>
  (cents: number, over: Partial<CfdiItemInput> = {}): CfdiItemInput => ({
    satProductKey: '01010101',
    satUnitKey: 'ACT',
    description: 'Venta',
    quantity: 1,
    unitPriceCents: cents,
    discountCents: 0,
    objetoImp: '02',
    taxIncluded: true,
    taxes: [{ type: 'IVA', factor: 'Tasa', rate, withholding: false } satisfies CfdiItemTax],
    ...over,
  })
const linea16 = conTasa(0.16)
const linea0 = conTasa(0)

/**
 * Casos de la Tarea 1 (suplementario G6s/G8s, medidos contra el PAC el 7-oct): tickets de hoy todo al 16 % con IVA incluido —uno CON
 * descuento: sin descuento el ±1 ¢ no puede ocurrir (ruling del controlador, 7-oct)— y un mezclado 16 % + 0 %. Los tickets de hoy se arman
 * con `conceptosDeOrdenGlobal` (sus `lineas`) y el descuento se le pone al concepto como en el `hoy(cents, sku, descuento)` del experimento
 * (precio = lo que marcaba el ticket, descuento aparte); el mezclado, con `conceptosDeOrdenGlobal` tal cual.
 */
type CasoT1 = { tickets: number[]; descuentos: number[]; g16: number; g0: number; cobrado: number }
const armarCaso = (k: CasoT1, pre: string) => {
  const items: CfdiItemInput[] = [
    ...k.tickets.map((g, i) => ({
      ...conceptosDeOrdenGlobal(
        orden({ orderId: `${pre}${i}`, porTratamiento: { IVA_16: g - k.descuentos[i] }, lineas: [linea(`${pre}${i}`, g)] }),
      )[0],
      discountCents: k.descuentos[i],
    })),
    ...conceptosDeOrdenGlobal(orden({ folio: `${pre}m`, porTratamiento: { IVA_16: k.g16, IVA_0: k.g0 } })),
  ]
  return { items, cobrado: k.cobrado, mayor: k.tickets.indexOf(Math.max(...k.tickets)) }
}
/** G6s (id sandbox 6ac676968475f14aad8e5b6d / 6ac676978475f14aad8e5c02): el PAC da 1016.82, se cobraron 1016.81 («sobra»). */
const casoG6 = () => armarCaso({ tickets: [39157, 21299, 6090], descuentos: [0, 4869, 0], g16: 24212, g0: 15792, cobrado: 101681 }, 'g6-')
/** G8s (id sandbox 6ac676988475f14aad8e5c80): el PAC da 2250.21, se cobraron 2250.22 («falta»). */
const casoG8 = () => armarCaso({ tickets: [62555, 69313, 68373], descuentos: [0, 0, 1960], g16: 21512, g0: 5229, cobrado: 225022 }, 'g8-')
/**
 * «Falta» un centavo que la 6b NO puede cuadrar (búsqueda sin red de la Tarea 3, `t3-buscar-detenida.ts`, mulberry32 semilla 20261007, la
 * misma forma que G8s; NO validado contra el PAC: el modelo es el de la 6b). Bajar 1 ¢ el descuento del ticket que lo trae sube el total
 * 2 ¢ (el descuento del documento baja 1 ¢ y el IVA sube 1 ¢ a la vez); subirlo o ponérselo al otro no lo mueve o lo baja.
 */
const casoG8Detenida = () => armarCaso({ tickets: [41154, 68978], descuentos: [0, 18904], g16: 33787, g0: 12955, cobrado: 137970 }, 'g8d-')
/** De los casos del Paso 7 (medición de frecuencia), el de más ajustes que dejó el cuadre. */
const casoMuchosAjustes = () => {
  // 10 tickets con IVA aparte de $10.03 + IVA (cobrados $11.63 cada uno): el PAC suma 116.35; la v4 despeja 4 ¢ en el grupo lineal.
  const items = Array.from({ length: 10 }, (_, i) =>
    conceptosDeOrdenGlobal(
      orden({ folio: `n${i}`, lineas: [{ ...linea(`n${i}`, 1163), subtotalCents: 1003, taxCents: 160, priceIncludesIva: false }] }),
    ),
  ).flat()
  return { items, cobrado: 11630 }
}

describe('C1 · conceptosDeOrdenGlobal (D4)', () => {
  it('🔴 mezclado 16 % + 0 % + exento + no objeto: UN concepto neto con tres bases (6 decimales) y el no objeto aparte, los dos con el folio', () => {
    expect(
      conceptosDeOrdenGlobal(orden({ folio: 'F-9', porTratamiento: { IVA_16: 16000, IVA_0: 10000, EXENTO: 5000, NO_OBJETO: 3000 } })),
    ).toEqual([
      {
        satProductKey: '01010101',
        satUnitKey: 'ACT',
        description: 'Venta',
        quantity: 1,
        discountCents: 0,
        sku: 'F-9',
        unitPriceCents: 28793,
        unitPriceDecimal: '287.931034',
        objetoImp: '02',
        taxIncluded: false,
        taxes: [
          { type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false, base: '137.931034' },
          { type: 'IVA', factor: 'Tasa', rate: 0, withholding: false, base: '100.000000' },
          { type: 'IVA', factor: 'Exento', rate: 0, withholding: false, base: '50.000000' },
        ],
      },
      {
        satProductKey: '01010101',
        satUnitKey: 'ACT',
        description: 'Venta',
        quantity: 1,
        discountCents: 0,
        sku: 'F-9',
        unitPriceCents: 3000,
        objetoImp: '01',
        taxes: [],
        taxIncluded: false,
      },
    ])
  })
  it('🔴 todo al 0 %: concepto normal con traslado Tasa 0, SIN base (se puede ajustar), nunca «no objeto 01»', () => {
    expect(conceptosDeOrdenGlobal(orden({ porTratamiento: { IVA_0: 4550 } }))).toEqual([
      {
        satProductKey: '01010101',
        satUnitKey: 'ACT',
        description: 'Venta',
        quantity: 1,
        discountCents: 0,
        sku: 'F-1',
        unitPriceCents: 4550,
        objetoImp: '02',
        taxIncluded: true,
        taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0, withholding: false }],
      },
    ])
  })
  it('todo exento: concepto normal con traslado Exento, sin base', () => {
    expect(conceptosDeOrdenGlobal(orden({ porTratamiento: { EXENTO: 4550 } }))[0]?.taxes).toEqual([
      { type: 'IVA', factor: 'Exento', rate: 0, withholding: false },
    ])
  })
  it('todo-16 con líneas de hoy: la línea de siempre + su folio (H3)', () => {
    expect(conceptosDeOrdenGlobal(orden({ porTratamiento: { IVA_16: 11600 }, lineas: [linea('o1', 11600)] }))).toEqual([
      {
        satProductKey: '01010101',
        satUnitKey: 'ACT',
        description: 'Venta',
        quantity: 1,
        unitPriceCents: 11600,
        discountCents: 0,
        objetoImp: '02',
        taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
        taxIncluded: true,
        sku: 'O1',
      },
    ])
  })
  it('C1-P10: la forma POR_TRATAMIENTO arma un concepto normal por tratamiento con el mismo folio, todos ajustables', () => {
    const items = conceptosDeOrdenGlobal(
      orden({ folio: 'F-9', porTratamiento: { IVA_16: 16000, IVA_0: 10000, NO_OBJETO: 3000 } }),
      'POR_TRATAMIENTO',
    )
    expect(items.map(i => [i.unitPriceCents, i.taxIncluded, i.taxes.map(t => `${t.factor}:${t.rate}`).join(','), i.sku])).toEqual([
      [16000, true, 'Tasa:0.16', 'F-9'],
      [10000, true, 'Tasa:0', 'F-9'],
      [3000, false, '', 'F-9'],
    ])
    expect(items.every(i => !i.taxes.some(t => t.base !== undefined))).toBe(true)
  })
})

describe('C1 · cuadrarLaGlobal — la regla del founder en la global, con la función de la 6b', () => {
  const g1a = () => [
    ...conceptosDeOrdenGlobal(orden({ folio: 'T1', porTratamiento: { IVA_16: 11600 }, lineas: [linea('t1', 11600)] })),
    ...conceptosDeOrdenGlobal(orden({ folio: 'T2', porTratamiento: { IVA_16: 16000, IVA_0: 10000, EXENTO: 5000, NO_OBJETO: 3000 } })),
    ...conceptosDeOrdenGlobal(orden({ folio: 'T4', porTratamiento: { EXENTO: 4550 } })),
    ...conceptosDeOrdenGlobal(orden({ folio: 'T5', porTratamiento: { IVA_0: 2500 } })),
  ]
  it('🔴 G1a (Tarea 1): da lo cobrado sin ajuste ⇒ montos 488.43 + 38.07 = 526.50', () => {
    expect(cuadrarLaGlobal(g1a(), 52650, sin)).toEqual({
      ok: true,
      items: g1a(),
      ajustes: [],
      montos: { subtotalCents: 48843, taxCents: 3807, totalCents: 52650 },
    })
  })
  // Desviación declarada (Tarea 3, 7-oct): con el ticket CON descuento que exige el ruling, la 6b pone el centavo DONDE ELLA LO PONE (Global
  // Constraints: «un centavo de descuento donde la 6b lo ponga»): su preferencia es «con descuento, mayor importe, clave fiscal», así que en
  // G6 elige el ticket que ya traía descuento, no el de mayor importe que esperaba el plan (escrito para tickets sin descuento); y en G8 SÍ hay
  // un descuento que bajar. Los dos documentos crudos coinciden al dígito con el XML del sandbox.
  it('🔴 G6 (Tarea 1, «sobra» un centavo): un centavo más de descuento donde lo pone la 6b —el ticket que ya traía descuento—; los montos dan lo cobrado', () => {
    const { items, cobrado, mayor } = casoG6() // los números exactos que imprimió la Tarea 1 («G6 caso»), armados con conceptosDeOrdenGlobal
    const doc = (its: CfdiItemInput[]) => regla.documentoSegunElPac(its.flatMap(regla.conceptosDesdeElPayload))
    expect(doc(items)).toEqual({ subtotalCents: 94032, descuentoCents: 4197, ivaCents: 11847, totalCents: 101682 }) // = XML G6s-crudo 940.32 / 41.97 / 1016.82
    const r = cuadrarLaGlobal(items, cobrado, sin)
    expect(r).toMatchObject({
      ok: true,
      ajustes: [{ indice: 1, deCents: 4869, aCents: 4870 }],
      montos: { subtotalCents: 89834, taxCents: 11847, totalCents: cobrado },
    })
    // El ajuste que timbró el sandbox (G6s: 1 ¢ al ticket de mayor importe ⇒ 940.32 / 41.98 / 1016.81) también da lo cobrado: la 6b sólo desempata.
    expect(doc(items.map((it, i) => (i === mayor ? { ...it, discountCents: 1 } : it)))).toEqual({
      subtotalCents: 94032,
      descuentoCents: 4198,
      ivaCents: 11847,
      totalCents: 101681,
    })
  })
  it('🔴 G8 (Tarea 1, «falta» un centavo): el ticket que trae descuento lo baja un centavo ⇒ da lo cobrado', () => {
    const { items, cobrado } = casoG8()
    expect(regla.documentoSegunElPac(items.flatMap(regla.conceptosDesdeElPayload))).toEqual({
      subtotalCents: 196395,
      descuentoCents: 1690,
      ivaCents: 30316,
      totalCents: 225021,
    }) // = XML G8s 1963.95 / 16.90 / 2250.21
    expect(cuadrarLaGlobal(items, cobrado, sin)).toMatchObject({
      ok: true,
      ajustes: [{ indice: 2, deCents: 1960, aCents: 1959 }],
      montos: { totalCents: cobrado },
    })
  })
  it('🔴 G8 detenida (Paso 7): «falta» un centavo y ningún movimiento de descuentos lo da ⇒ se detiene con el motivo de la 6b (nunca se timbra distinto)', () => {
    const { items, cobrado } = casoG8Detenida()
    expect(regla.documentoSegunElPac(items.flatMap(regla.conceptosDesdeElPayload)).totalCents).toBe(cobrado - 1)
    expect(cuadrarLaGlobal(items, cobrado, sin)).toMatchObject({ ok: false, motivo: expect.stringMatching(/moviendo centavos/) })
  })
  it('🔴 un concepto con varias tasas con descuento ⇒ inválido (nunca se manda)', () => {
    const [mezclado] = conceptosDeOrdenGlobal(orden({ porTratamiento: { IVA_16: 16000, IVA_0: 10000 } }))
    expect(cuadrarLaGlobal([{ ...mezclado, discountCents: 1 }], 26000, sin)).toMatchObject({
      ok: false,
      motivo: MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT,
    })
  })
  // Ronda de arreglos 1 (revisión de la Tarea 3, Important #2): `aplicarAjustes` es la puerta de «para enviar» de la Tarea 7. Un mezclado
  // alterado en la entrada (con descuento, un precio que no es la suma de sus bases, cantidad 2) el PAC lo timbraría distinto; y un concepto
  // con dos traslados de IVA sin `base` no se puede leer. Los dos lo rechazan (`null` / `ok: false` con motivo), NUNCA lanzan.
  const mezcladoSano = () => conceptosDeOrdenGlobal(orden({ porTratamiento: { IVA_16: 16000, IVA_0: 10000 } }))[0]
  it.each([
    ['con descuento', () => ({ ...mezcladoSano(), discountCents: 500 })],
    ['con un precio que no es la suma de sus bases', () => ({ ...mezcladoSano(), unitPriceDecimal: '300.000000' })],
    ['con cantidad 2', () => ({ ...mezcladoSano(), quantity: 2 })],
    ['con dos traslados de IVA sin base', () => ({ ...mezcladoSano(), taxes: mezcladoSano().taxes.map(({ base: _b, ...t }) => t) })],
  ])('🔴 ronda 1: un concepto mezclado %s ⇒ aplicarAjustes da null y cuadrarLaGlobal ok: false con motivo; ninguno lanza', (_, armar) => {
    const items: CfdiItemInput[] = [armar()]
    expect(regla.conceptoMultitasaValido(mezcladoSano())).toBe(true) // control: el sano sí es válido
    expect(aplicarAjustes([mezcladoSano()], [], 26000, sin)).not.toBeNull() // control: el sano se reproduce
    expect(() => aplicarAjustes(items, [], 26000, sin)).not.toThrow()
    expect(aplicarAjustes(items, [], 26000, sin)).toBeNull()
    expect(() => cuadrarLaGlobal(items, 26000, sin)).not.toThrow()
    expect(cuadrarLaGlobal(items, 26000, sin)).toMatchObject({ ok: false, motivo: MOTIVO_CONCEPTO_INVALIDO_ANTE_EL_SAT })
  })
  it('aplicarAjustes: reproduce lo congelado; rechaza un índice repetido, uno sobre un concepto mezclado, un «de» que no coincide o un ajuste que deja la tasa fuera de lo cobrado', () => {
    const { items, cobrado } = casoG6()
    const g = cuadrarLaGlobal(items, cobrado, sin) as Extract<ReturnType<typeof cuadrarLaGlobal>, { ok: true }>
    expect(aplicarAjustes(items, g.ajustes, cobrado, sin)).toEqual(g.items)
    const g1 = g1a()
    expect(
      aplicarAjustes(
        g1,
        [
          { indice: 0, deCents: 0, aCents: 1 },
          { indice: 0, deCents: 0, aCents: 2 },
        ],
        52650,
        sin,
      ),
    ).toBeNull()
    // El 1 es el mezclado: se rechaza con `null`, sin tronar en la guarda de `conceptoDesdeElPayload` (el lector no se cae; sabotaje f).
    expect(() => aplicarAjustes(g1, [{ indice: 1, deCents: 0, aCents: 1 }], 52650, sin)).not.toThrow()
    expect(aplicarAjustes(g1, [{ indice: 1, deCents: 0, aCents: 1 }], 52650, sin)).toBeNull()
    expect(aplicarAjustes(g1, [{ indice: 0, deCents: 5, aCents: 6 }], 52650, sin)).toBeNull()
    expect(aplicarAjustes(g1, [{ indice: 0, deCents: 0, aCents: 1 }], 52650, sin)).toBeNull() // C1-36: la tasa ya no da lo cobrado
  })
  it('🔴 C1-30: aplicarAjustes con la barrera N3: si lo comercial no es lo cobrado, no reproduce nada', () => {
    expect(aplicarAjustes(g1a(), [], 52650, sin)).not.toBeNull()
    expect(aplicarAjustes(g1a(), [], 52651, sin)).toBeNull()
    // Sabotaje j (Tarea 3): el caso de C1-30 —$100 al 0 % contra $90 cobrados—. Con $10 de descuento el documento da justo lo cobrado y
    // la tasa también, así que lo ÚNICO que rechaza ese «ajuste» es la barrera (el 52651 de arriba lo rechaza además la suma final).
    const [cien] = conceptosDeOrdenGlobal(orden({ folio: 'Z', porTratamiento: { IVA_0: 10000 } }))
    expect(regla.documentoSegunElPac([{ ...regla.conceptoDesdeElPayload(cien), descuentoCents: 1000 }]).totalCents).toBe(9000)
    expect(aplicarAjustes([cien], [{ indice: 0, deCents: 0, aCents: 1000 }], 9000, sin)).toBeNull()
  })
  it('🔴 sin techo (C1-11): lo que congeló `cuadrarLaGlobal` se reproduce entero, sean cuantos sean los ajustes', () => {
    const { items, cobrado } = casoMuchosAjustes() // ayudante: de los casos del Paso 7, el de más ajustes que haya dejado el cuadre (más de uno)
    const g = cuadrarLaGlobal(items, cobrado, sin) as Extract<ReturnType<typeof cuadrarLaGlobal>, { ok: true }>
    expect(g.ok).toBe(true) // (rojo por aserción con el cuerpo neutro)
    expect(g.ajustes.length).toBeGreaterThan(1)
    expect(aplicarAjustes(items, g.ajustes, cobrado, sin)).toEqual(g.items)
  })
  it('🔴 C1-30 (Codex): un concepto de $100 al 0 % contra $90 cobrados ⇒ se DETIENE con «error al armarla»; nunca $10 de descuento y la búsqueda no corre', () => {
    const espia = jest.spyOn(regla, 'cuadrarConElPac')
    const [cien] = conceptosDeOrdenGlobal(orden({ folio: 'Z', porTratamiento: { IVA_0: 10000 } }))
    expect(cuadrarLaGlobal([cien], 9000, sin)).toMatchObject({ ok: false, motivo: expect.stringContaining(MOTIVO_ARMADO_NO_CUADRA) })
    expect(espia).not.toHaveBeenCalled()
    espia.mockRestore()
  })
  it('🔴 C2-23 / C1-30: cuadrarPorTasa cuadra CADA tasa sola —una llamada por tasa, sólo con sus conceptos y su monto comercial—', () => {
    const espia = jest.spyOn(regla, 'cuadrarConElPac')
    const items = g1a()
    const cs = items.flatMap(regla.conceptosDesdeElPayload)
    expect(cuadrarPorTasa(cs, 52650, sin)).toMatchObject({ ok: true })
    for (const [grupo, objetivo] of espia.mock.calls) {
      const tasas = new Set(grupo.map((c: any) => (!c.traslado ? 'NO' : c.traslado.factor === 'Exento' ? 'EX' : String(c.traslado.tasa))))
      expect(tasas.size).toBe(1) // nunca mezcla tasas
      expect(objetivo).toBe(montoComercialCents(grupo))
    }
    espia.mockRestore()
  })
  it('🔴 C1-35 (Codex): la cota sólo deja ENTRAR; la búsqueda va contra lo COBRADO de la tasa. Real $65 − $2.50 al 16 % (comercial 6250) contra 6249 congelado: el PAC de los originales ya da 6249 ⇒ sale sin tocar nada', () => {
    const cs = [regla.conceptoDesdeElPayload(linea16(6500, { discountCents: 250 }))]
    expect(cotaDeRedondeoCents(cs, 0)).toBeGreaterThanOrEqual(1) // la cota de B3a (firma final) admite el centavo de este caso
    expect(cuadrarPorTasa(cs, 6249, { cobradoPorTasa: { IVA_16: 6249 }, ...sin })).toEqual({
      ok: true,
      ajustes: [],
      documento: expect.objectContaining({ totalCents: 6249 }),
    })
  })
  it('🔴 C1-35: más allá de la cota de B3a, error de armado; y el resultado final siempre es EXACTO', () => {
    const cs = [regla.conceptoDesdeElPayload(linea16(6500, { discountCents: 250 }))]
    const fuera = 6250 - cotaDeRedondeoCents(cs, 0) - 1
    expect(cuadrarPorTasa(cs, fuera, { cobradoPorTasa: { IVA_16: fuera }, ...sin })).toMatchObject({
      ok: false,
      motivo: expect.stringContaining(MOTIVO_ARMADO_NO_CUADRA),
    })
    const r = cuadrarPorTasa(cs, 6250, sin)
    if (r.ok) expect(r.documento.totalCents).toBe(6250)
  })
  it('🔴 C1-39 (Codex): la cota de CADA tasa es la de sus conceptos. 16 %: un concepto neto, base $100 (comercial 11600, objetivo 11484); 0 %: 120 conceptos de $2 − $1 (comercial 12000, objetivo 12116); el documento da 23600 en los dos ⇒ se DETIENE sin buscar (la cota del documento, 121 ¢, ya no le presta tolerancia al 16 %, cuya cota es la de un concepto)', () => {
    const espia = jest.spyOn(regla, 'cuadrarConElPac')
    const neto16 = regla.conceptoDesdeElPayload({ ...linea16(10000), taxIncluded: false })
    const ceros = Array.from({ length: 120 }, () => regla.conceptoDesdeElPayload(linea0(200, { discountCents: 100 })))
    const cs = [neto16, ...ceros]
    expect(montoComercialCents(cs)).toBe(23600)
    expect(cotaDeRedondeoCents([neto16], 0)).toBeLessThan(116) // la de su tasa
    expect(cotaDeRedondeoCents(cs, 0)).toBeGreaterThanOrEqual(116) // la del documento (con la que v6 lo dejaba pasar)
    const porTasa = { IVA_16: 11484, IVA_0: 12116 }
    expect(cuadrarPorTasa(cs, 23600, { cobradoPorTasa: porTasa, ...sin })).toMatchObject({
      ok: false,
      motivo: expect.stringContaining('al 16 %'),
    })
    expect(espia).not.toHaveBeenCalled()
    espia.mockRestore()
    const items = [{ ...linea16(10000), taxIncluded: false }, ...Array.from({ length: 120 }, () => linea0(200, { discountCents: 100 }))]
    expect(aplicarAjustes(items, [], 23600, { cobradoPorTasa: porTasa, ...sin })).toBeNull() // reproducir usa la misma barrera
  })
  it('🔴 C1-43: una fila D16 ensancha SÓLO la cota de su tasa; las filas son obligatorias y una cuenta inválida detiene (nunca NaN)', () => {
    const neto16 = regla.conceptoDesdeElPayload({ ...linea16(10000), taxIncluded: false }) // comercial 11600, cota de su tasa con 0 filas: la mínima de B3a
    const cero = regla.conceptoDesdeElPayload(linea0(5000))
    const cs = [neto16, cero]
    const lejos = cotaDeRedondeoCents([neto16], 0) + 2 // fuera de la cota sin filas, dentro con 10 filas al 16 %
    expect(cotaDeRedondeoCents([neto16], 10)).toBeGreaterThanOrEqual(lejos)
    const porTasa = { IVA_16: 11600 - lejos, IVA_0: 5000 }
    const motivo = (r: ReturnType<typeof cuadrarPorTasa>) => (r.ok ? '' : r.motivo)
    expect(motivo(cuadrarPorTasa(cs, 16600 - lejos, { cobradoPorTasa: porTasa, ...sin }))).toContain(MOTIVO_ARMADO_NO_CUADRA)
    expect(
      motivo(cuadrarPorTasa(cs, 16600 - lejos, { cobradoPorTasa: porTasa, filasD16: { documento: 10, porTasa: { IVA_16: 10 } } })),
    ).not.toContain(MOTIVO_ARMADO_NO_CUADRA) // entra a la búsqueda
    expect(
      motivo(cuadrarPorTasa(cs, 16600 - lejos, { cobradoPorTasa: porTasa, filasD16: { documento: 10, porTasa: { IVA_0: 10 } } })),
    ).toContain(MOTIVO_ARMADO_NO_CUADRA) // filas de otra tasa: no
    expect(motivo(cuadrarPorTasa(cs, 16600, { filasD16: { documento: Number.NaN, porTasa: {} } }))).toContain(MOTIVO_ARMADO_NO_CUADRA)
    expect(motivo(cuadrarPorTasa(cs, 16600, { filasD16: { documento: 0, porTasa: { IVA_16: -1 } } }))).toContain(MOTIVO_ARMADO_NO_CUADRA)
  })
  it('🔴 C1-43: filasD16De — una fila cuenta una vez en el documento y una vez en cada tasa que toca; la que sólo toca renglones ajenos no cuenta; la que no nombra renglones cuenta en todas', () => {
    const tasas = () =>
      new Map<string, 'IVA_16' | 'IVA_0'>([
        ['pan', 'IVA_16'],
        ['cafe', 'IVA_0'],
      ])
    expect(filasD16De([['pan', 'cafe'], ['pan'], ['otro'], []], tasas())).toEqual({ documento: 3, porTasa: { IVA_16: 3, IVA_0: 2 } })
    expect(filasD16De([], tasas())).toEqual(SIN_FILAS_D16)
  })
  it('🔴 C1-36 (Codex): reproducir ajustes que COMPENSAN entre tasas (16 % −1 ¢ de descuento, 0 % +1 ¢) da el mismo total y se rechaza', () => {
    const items = [linea16(11600, { discountCents: 100 }), linea0(10000)]
    expect(aplicarAjustes(items, [], 21500, { cobradoPorTasa: { IVA_16: 11500, IVA_0: 10000 }, ...sin })).not.toBeNull()
    expect(
      aplicarAjustes(
        items,
        [
          { indice: 0, deCents: 100, aCents: 99 },
          { indice: 1, deCents: 0, aCents: 1 },
        ],
        21500,
        { cobradoPorTasa: { IVA_16: 11500, IVA_0: 10000 }, ...sin },
      ),
    ).toBeNull()
    expect(
      aplicarAjustes(
        items,
        [
          { indice: 0, deCents: 100, aCents: 99 },
          { indice: 1, deCents: 0, aCents: 1 },
        ],
        21500,
        sin,
      ),
    ).toBeNull() // sin lo de cada tasa, se deriva igual
  })
  it('🔴 C2-23: lo de cada tasa tiene que ser lo cobrado de ESA tasa: el documento suma igual, pero el 16 % trae $1 de más y el 0 % $1 de menos ⇒ se detiene', () => {
    const cs = [regla.conceptoDesdeElPayload({ ...linea16(11700) }), regla.conceptoDesdeElPayload({ ...linea0(9900) })] // ayudantes: un concepto IVA incluido de esa tasa
    expect(cuadrarPorTasa(cs, 21600, sin)).toMatchObject({ ok: true }) // sin lo de cada tasa, el documento cuadra
    expect(cuadrarPorTasa(cs, 21600, { cobradoPorTasa: { IVA_16: 11600, IVA_0: 10000 }, ...sin })).toMatchObject({
      ok: false,
      motivo: expect.stringContaining('al 16 %'),
    })
  })
})

describe('C1 · paramsDeLaGlobal', () => {
  // Ronda 1 de la T6 (I3): el título decía «la forma del ticket de mayor monto»; con un ticket por forma es la que suma más: '04' no cambia.
  it('receptor, uso, periodo y la forma que suma más (H4)', () => {
    const p = paramsDeLaGlobal(
      { lugarExpedicion: '01000', serie: 'G' },
      [
        orden({ orderId: 'o1', formaPago: '01', paidCents: 5000, porTratamiento: { IVA_0: 5000 } }),
        orden({ orderId: 'o2', formaPago: '04', paidCents: 9000, porTratamiento: { IVA_0: 9000 } }),
      ],
      { facturaPeriodicity: 'day', meses: '10', anio: 2026 },
    )
    expect(p).toMatchObject({
      receptor: { legal_name: 'PÚBLICO EN GENERAL', tax_id: 'XAXX010101000', tax_system: '616', address: { zip: '01000' } },
      payment_form: '04',
      use: 'S01',
      serie: 'G',
      global: { periodicity: 'day', months: '10', year: 2026 },
    })
    expect(p.items).toHaveLength(2)
  })
  it('🔴 I3 (ronda 1 de la T6): la forma se suma entre tickets (dos de $50 con tarjeta contra uno de $90 en efectivo ⇒ tarjeta)', () => {
    const p = paramsDeLaGlobal(
      { lugarExpedicion: '01000' },
      [
        orden({ orderId: 'o1', formaPago: '04', paidCents: 5000, porTratamiento: { IVA_0: 5000 } }),
        orden({ orderId: 'o2', formaPago: '04', paidCents: 5000, porTratamiento: { IVA_0: 5000 } }),
        orden({ orderId: 'o3', formaPago: '01', paidCents: 9000, porTratamiento: { IVA_0: 9000 } }),
      ],
      { facturaPeriodicity: 'day', meses: '10', anio: 2026 },
    )
    expect(p.payment_form).toBe('04')
  })
})

describe('C1 · pertenenciaAlEmisor — una sola regla para candidatos, conteos y listado', () => {
  // Ajuste del founder (7-oct): `includeOffTerminalSalesInGlobal` apagado de fábrica (el de `e`).
  const e = { id: 'e1', invoiceCashSales: false, includeOffTerminalSalesInGlobal: false }
  /** Con el interruptor «Incluir en la global las ventas cobradas fuera de la terminal» encendido. */
  const fueraDeTerminal = { ...e, includeOffTerminalSalesInGlobal: true }
  const ok = { fiscalEmisorId: 'e1', facturacionEnabled: true, includeInGlobal: true }
  const tarjeta = (config: any) => ({ method: 'CREDIT_CARD', conComercio: true, config })
  const efectivo = { method: 'CASH', conComercio: false, config: null }
  const transferencia = { method: 'TRANSFER', conComercio: false, config: null }
  const vale = { method: 'OTHER', conComercio: false, config: null }
  // «control — …»: filas que ya pasan con el cuerpo neutro (que todo sea CANDIDATA); la integración las discrimina contra la base.
  it.each([
    ['control — tarjeta nuestra', [tarjeta(ok)], e, true, 'CANDIDATA'],
    ['tarjeta nuestra + efectivo, sin el interruptor', [tarjeta(ok), efectivo], e, true, 'EFECTIVO'],
    [
      'control — tarjeta nuestra + efectivo, con el interruptor',
      [tarjeta(ok), efectivo],
      { ...e, invoiceCashSales: true },
      true,
      'CANDIDATA',
    ],
    ['nuestra con facturación apagada', [tarjeta({ ...ok, facturacionEnabled: false })], e, true, 'COMERCIO_FUERA'],
    ['nuestra + una de otro RFC', [tarjeta(ok), tarjeta({ ...ok, fiscalEmisorId: 'e2' })], e, false, 'COMERCIO_FUERA'],
    ['nuestra + un comercio sin configuración', [tarjeta(ok), tarjeta(null)], e, true, 'COMERCIO_FUERA'],
    ['🔴 sólo de otro RFC ⇒ AJENA (no se lista aquí)', [tarjeta({ ...ok, fiscalEmisorId: 'e2' })], e, false, 'AJENA'],
    ['🔴 sólo comercios sin configuración ⇒ SIN_EMISOR (se lista a todos)', [tarjeta(null)], e, false, 'SIN_EMISOR'],
    [
      'control — 🔴 efectivo puro, un RFC, con los dos interruptores ⇒ entra (P3)',
      [efectivo],
      { ...fueraDeTerminal, invoiceCashSales: true },
      true,
      'CANDIDATA',
    ],
    [
      'control — efectivo puro, un RFC, ventas fuera de la terminal incluidas pero sin «facturar efectivo» ⇒ EFECTIVO',
      [efectivo],
      fueraDeTerminal,
      true,
      'EFECTIVO',
    ],
    ['🔴 efectivo puro con varios RFC ⇒ SIN_EMISOR (antes invisible)', [efectivo], { ...e, invoiceCashSales: true }, false, 'SIN_EMISOR'],
    [
      '🔴 efectivo puro con varios RFC, aunque el interruptor esté encendido ⇒ SIN_EMISOR (nadie sabe de quién es)',
      [efectivo],
      { ...fueraDeTerminal, invoiceCashSales: true },
      false,
      'SIN_EMISOR',
    ],
    [
      'control — transferencia sin comercio, un RFC, ventas fuera de la terminal incluidas',
      [transferencia],
      fueraDeTerminal,
      true,
      'CANDIDATA',
    ],
    ['control — tarjeta nuestra + transferencia sin comercio', [tarjeta(ok), transferencia], e, false, 'CANDIDATA'],
    // 🔴 Ajuste del founder (7-oct): la configuración del dueño manda. Testarudo (un RFC, «facturar efectivo» encendido, sin el interruptor nuevo).
    [
      '🔴 founder: efectivo puro, un RFC, «facturar efectivo» encendido y SIN el interruptor nuevo ⇒ SIN_TERMINAL (Testarudo)',
      [efectivo],
      { ...e, invoiceCashSales: true },
      true,
      'SIN_TERMINAL',
    ],
    [
      '🔴 founder: transferencia sin comercio, un RFC, sin el interruptor ⇒ SIN_TERMINAL (Testarudo)',
      [transferencia],
      e,
      true,
      'SIN_TERMINAL',
    ],
    ['🔴 founder: vale o tipo de pago propio sin comercio, un RFC, sin el interruptor ⇒ SIN_TERMINAL', [vale], e, true, 'SIN_TERMINAL'],
    [
      '🔴 founder: efectivo puro, un RFC, sin ninguno de los dos interruptores ⇒ SIN_TERMINAL (el nuevo decide primero)',
      [efectivo],
      e,
      true,
      'SIN_TERMINAL',
    ],
    [
      '🔴 founder: efectivo + transferencia sin comercio, un RFC, sin el interruptor ⇒ SIN_TERMINAL',
      [efectivo, transferencia],
      { ...e, invoiceCashSales: true },
      true,
      'SIN_TERMINAL',
    ],
    [
      'control — founder: tarjeta nuestra + efectivo, SIN el interruptor nuevo ⇒ como hoy (entra con «facturar efectivo»)',
      [tarjeta(ok), efectivo],
      { ...e, invoiceCashSales: true },
      true,
      'CANDIDATA',
    ],
    [
      'control — founder: tarjeta nuestra + transferencia, un RFC, SIN el interruptor nuevo ⇒ como hoy (entra)',
      [tarjeta(ok), transferencia],
      e,
      true,
      'CANDIDATA',
    ],
    // T10, ronda 1 (m3): el interruptor ENCENDIDO no mueve a las ventas CON comercio (ni a la transferencia con varios RFC).
    [
      'control — m3: tarjeta nuestra + efectivo sin «facturar efectivo», interruptor encendido ⇒ EFECTIVO',
      [tarjeta(ok), efectivo],
      fueraDeTerminal,
      true,
      'EFECTIVO',
    ],
    [
      'control — m3: nuestra + comercio sin configuración, interruptor encendido ⇒ COMERCIO_FUERA',
      [tarjeta(ok), tarjeta(null)],
      fueraDeTerminal,
      true,
      'COMERCIO_FUERA',
    ],
    [
      'control — m3: sólo de otro RFC, interruptor encendido ⇒ AJENA',
      [tarjeta({ ...ok, fiscalEmisorId: 'e2' })],
      fueraDeTerminal,
      false,
      'AJENA',
    ],
    [
      'control — m3: transferencia con varios RFC, interruptor encendido ⇒ SIN_EMISOR',
      [transferencia],
      fueraDeTerminal,
      false,
      'SIN_EMISOR',
    ],
  ])('%s', (_n, pagos, emisor, unSolo, esperado) => {
    expect(pertenenciaAlEmisor(pagos as any, emisor as any, unSolo as boolean)).toBe(esperado)
  })
})

// C1 · Tarea 11: `CORREGIDA_DESPUES` ya tiene camino (la complementaria); el texto lo dice.
import { TEXTO_EXCLUSION_GLOBAL as TEXTOS_T11 } from '../../../../src/services/fiscal/globalPorTratamiento'
describe('C1 · Tarea 11 — el texto de CORREGIDA_DESPUES', () => {
  it('🔴 dice que no está en ninguna global vigente (corregida después, o su global cancelada) y manda a la complementaria', () => {
    expect(TEXTOS_T11.CORREGIDA_DESPUES).toMatch(/ninguna factura global vigente/)
    expect(TEXTOS_T11.CORREGIDA_DESPUES).toMatch(/se canceló/)
    expect(TEXTOS_T11.CORREGIDA_DESPUES).toMatch(/global complementaria/)
  })
})
