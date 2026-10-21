/**
 * IVA por producto, B2 (spec planes 6-7 §4.1, D7, D8, H17; Codex r1 #1, #3): el reparto de los descuentos de una orden.
 * Puro: sin base ni reloj. Ningún renglón recibe más de lo que vale, aunque varias filas lo toquen.
 */
import { Prisma } from '@prisma/client'
import {
  MOTIVO_SIN_REPARTO_IVA_MEZCLADO,
  aCentavos,
  aportacionCents,
  capacidadRestante,
  enAmbito,
  estaRegalado,
  importesDeLasFilas,
  impuestoQueSeLlevan,
  leerReparto,
  mismoReparto,
  nuevoRepartoDeCuenta,
  nuevoRepartoDirigido,
  recorteDeFila,
  reduccionDeImpuestoCobrado,
  reduccionesQueNoVuelven,
  repartirConTopes,
  repartirSinConstancia,
  repartosDeLaOrden,
  seRecalculaComoPorcentajeDeCuenta,
  seRecalculaDentroDeSuAmbito,
} from '@/services/shared/repartoDescuento'

const r = (id: string, total: number, discountAmount = 0, orderPromotionId: string | null = null) => ({
  id,
  total,
  discountAmount,
  orderPromotionId,
})
/** Renglón con producto y categoría (el ámbito de un % dirigido, P1). */
const rp = (id: string, total: number, productId: string | null, categoryId: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  total,
  discountAmount: 0,
  orderPromotionId: null as string | null,
  productId,
  product: categoryId ? { categoryId } : null,
  ...extra,
})
const deCategoria = (amount: number, renglones: Record<string, number>) =>
  nuevoRepartoDirigido(amount, renglones, { espejo: false, ambito: { productos: [], categorias: ['c1'] } })
const t = (s: number) => new Date(Date.UTC(2026, 9, 1, 18, 0, s))
const fila = (id: string, amount: number, reparto: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'FIXED_AMOUNT',
  value: amount,
  amount,
  appliedToItemIds: [] as string[],
  reparto,
  createdAt: t(0),
  ...extra,
})
const renglonesDe = (m: Map<string, { renglones: Record<string, number> }>, id: string) => m.get(id)?.renglones

describe('aCentavos y aportacionCents', () => {
  it('pesos → centavos exactos, también desde Decimal; basura ⇒ 0', () => {
    expect(aCentavos(19.99)).toBe(1999)
    expect(aCentavos(new Prisma.Decimal('12.34'))).toBe(1234)
    expect(aCentavos('no-es-numero')).toBe(0)
    expect(aCentavos(Infinity)).toBe(0)
  })
  it('renglón bruto: total − su descuento · promoción: su total (neto) · cortesía: 0, nunca negativo', () => {
    expect(aportacionCents(r('a', 100, 30))).toBe(7000)
    expect(aportacionCents(r('p', 80, 20, 'op'))).toBe(8000)
    // 🔴 B3a r2 N1: la cortesía se resuelve ANTES que la promoción — una promoción regalada después con compItems aporta 0.
    expect(aportacionCents({ ...r('pc', 80, 80, 'op'), isCortesia: true })).toBe(0)
    expect(aportacionCents({ ...r('tc', 100, 100), isCortesia: true })).toBe(0)
    expect(aportacionCents(r('c', 50, 50))).toBe(0)
    expect(aportacionCents(r('m', 0, 45))).toBe(0)
  })
})

describe('repartirConTopes', () => {
  it('proporcional y, si un renglón se llena, lo que sobra va a los demás', () => {
    expect(
      repartirConTopes(1000, [
        { peso: 5000, tope: 5000 },
        { peso: 5000, tope: 200 },
      ]),
    ).toEqual([800, 200])
  })
  it('si no cabe, da lo que cabe — nunca más que el tope', () => {
    expect(
      repartirConTopes(1000, [
        { peso: 1, tope: 300 },
        { peso: 1, tope: 200 },
      ]),
    ).toEqual([300, 200])
  })
  it('peso 0 no recibe aunque tenga lugar', () => {
    expect(
      repartirConTopes(100, [
        { peso: 0, tope: 1000 },
        { peso: 1, tope: 50 },
      ]),
    ).toEqual([0, 50])
  })
  // Codex r1 P3: la precondición (centavos enteros) se valida; antes un monto con fracción se truncaba en silencio y un tope
  // con fracción reventaba con un RangeError de BigInt sin decir por qué.
  it('🔴 exige centavos enteros: un monto o un tope con fracción se rechaza con un error explícito, nunca se trunca', () => {
    expect(() => repartirConTopes(1000.5, [{ peso: 1, tope: 2000 }])).toThrow(/centavos enteros/)
    expect(() => repartirConTopes(100, [{ peso: 1, tope: 0.5 }])).toThrow(/centavos enteros/)
  })
})

describe('leerReparto — lo viejo, corrupto o incoherente es null (D8), nunca lanza', () => {
  const cuenta = { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { a: 100 } }
  const dirigido = { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { a: 100 } }
  it('lee CUENTA (con y sin base) y DIRIGIDO', () => {
    expect(leerReparto(cuenta)).toEqual(cuenta)
    expect(leerReparto({ ...cuenta, base: ['a'] })).toEqual({ ...cuenta, base: ['a'] })
    expect(leerReparto(dirigido)).toEqual(dirigido)
  })
  // Control de regresión: los 15 casos ya pasan con el cuerpo neutro (`leerReparto ⇒ null`); muerden si una guarda se afloja.
  it.each([
    ['nulo', null],
    ['arreglo', []],
    ['otra versión', { ...cuenta, v: 2 }],
    ['alcance inventado', { ...cuenta, alcance: 'TODO' }],
    ['CUENTA espejo', { ...cuenta, espejo: true }],
    ['CUENTA sin conPromociones', { ...cuenta, conPromociones: null }],
    ['DIRIGIDO con conPromociones', { ...dirigido, conPromociones: true }],
    ['DIRIGIDO con base', { ...dirigido, base: ['a'] }],
    ['base que no es lista de textos', { ...cuenta, base: [1] }],
    ['centavos negativos', { ...cuenta, renglones: { a: -1 } }],
    ['centavos con fracción', { ...cuenta, renglones: { a: 1.5 } }],
    ['CUENTA con ámbito', { ...cuenta, ambito: { productos: [], categorias: ['c1'] } }],
    ['ámbito mal formado', { ...dirigido, ambito: { productos: 'pa', categorias: [] } }],
    ['tope negativo', { ...cuenta, tope: -1 }],
    ['reduceImpuesto que no es booleano', { ...cuenta, reduceImpuesto: 'sí' }],
  ])('%s ⇒ null', (_caso, valor) => expect(leerReparto(valor)).toBeNull())
  it('conserva el ámbito de una DIRIGIDA y la marca de D16', () => {
    const conAmbito = { ...dirigido, espejo: false, ambito: { productos: ['pa'], categorias: [] } }
    expect(leerReparto(conAmbito)).toEqual(conAmbito)
    expect(leerReparto({ ...cuenta, reduceImpuesto: true })).toEqual({ ...cuenta, reduceImpuesto: true })
    expect(leerReparto({ ...cuenta, tope: 12 })).toEqual({ ...cuenta, tope: 12 })
  })
  it('mismoReparto ignora el orden de las llaves', () => {
    // Rúbrica R-1: dos objetos con DISTINTO orden de llaves (arriba y en `renglones`), no dos copias del mismo.
    const ab = { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, base: ['a', 'b'], renglones: { a: 1, b: 2 } }
    const ba = { renglones: { b: 2, a: 1 }, base: ['b', 'a'], espejo: false, conPromociones: true, alcance: 'CUENTA', v: 1 }
    expect(mismoReparto(ab as any, ba as any)).toBe(true)
    expect(mismoReparto(cuenta as any, null)).toBe(false)
  })
  it('mismoReparto distingue el tope, la marca de D16 y el ámbito (preflight R-7: B2b reescribe la marca por aquí)', () => {
    const dir = { ...dirigido, espejo: false, ambito: { productos: ['pa'], categorias: [] } }
    expect(mismoReparto(cuenta as any, { ...cuenta, tope: 12 } as any)).toBe(false)
    expect(mismoReparto(cuenta as any, { ...cuenta, reduceImpuesto: true } as any)).toBe(false)
    expect(mismoReparto(dir as any, { ...dir, ambito: { productos: ['pb'], categorias: [] } } as any)).toBe(false)
    expect(mismoReparto(dir as any, { ...dir, ambito: { productos: ['pa'], categorias: [] } } as any)).toBe(true)
  })
})

describe('el predicado del recálculo (la regla de HOY, con P1)', () => {
  const pct = (extra: Record<string, unknown> = {}) => fila('d1', 0, null, { type: 'PERCENTAGE', value: 10, ...extra })
  it('% con valor y sin appliedToItemIds se re-deriva; congelado si tiene appliedToItemIds, es fijo o vale 0', () => {
    expect(seRecalculaComoPorcentajeDeCuenta(pct())).toBe(true)
    expect(seRecalculaComoPorcentajeDeCuenta(pct({ appliedToItemIds: ['a'] }))).toBe(false)
    expect(seRecalculaComoPorcentajeDeCuenta(pct({ type: 'FIXED_AMOUNT' }))).toBe(false)
    expect(seRecalculaComoPorcentajeDeCuenta(pct({ value: 0 }))).toBe(false)
  })
  it('🔴 Codex r1 #3: un porcentaje chico válido (0.0049 %) se sigue re-derivando — se compara como número', () => {
    expect(seRecalculaComoPorcentajeDeCuenta(pct({ value: new Prisma.Decimal('0.0049') }))).toBe(true)
  })
  // Control de regresión: pasa con el cuerpo neutro (`false`); muerde si se quita la condición `alcance !== 'DIRIGIDO'`.
  it('🔴 P1: una fila DIRIGIDA (categoría, 2×1) ya no se re-deriva sobre toda la cuenta', () => {
    expect(seRecalculaComoPorcentajeDeCuenta(pct({ reparto: nuevoRepartoDirigido(5, { a: 5 }, { espejo: false }) }))).toBe(false)
  })
  it('P1 acotado (Codex r2 N1): una DIRIGIDA con ámbito se re-deriva dentro de él; sin ámbito (extras, 2×1) no', () => {
    expect(seRecalculaDentroDeSuAmbito(pct({ reparto: deCategoria(5, { a: 5 }) }))).toBe(true)
    expect(seRecalculaDentroDeSuAmbito(pct({ reparto: nuevoRepartoDirigido(5, { a: 5 }, { espejo: false }) }))).toBe(false)
    expect(seRecalculaDentroDeSuAmbito(pct({ reparto: deCategoria(5, { a: 5 }), appliedToItemIds: ['a'] }))).toBe(false)
    expect(seRecalculaDentroDeSuAmbito(pct({ reparto: deCategoria(5, { a: 5 }), type: 'FIXED_AMOUNT' }))).toBe(false)
  })
  it('enAmbito: con producto, sin promoción, y su producto o su categoría en la lista', () => {
    const ambito = { productos: ['pa'], categorias: ['c1'] }
    expect(enAmbito(rp('a', 10, 'pa', 'c9'), ambito)).toBe(true)
    expect(enAmbito(rp('b', 10, 'pb', 'c1'), ambito)).toBe(true)
    expect(enAmbito(rp('c', 10, 'pc', 'c9'), ambito)).toBe(false)
    expect(enAmbito(rp('x', 10, null, null), ambito)).toBe(false)
    expect(enAmbito(rp('p', 10, 'pa', 'c1', { orderPromotionId: 'op' }), ambito)).toBe(false)
  })
})

describe('importesDeLasFilas — la regla única de los recalculadores; P1 acotado al camino defectuoso (Codex r2 N1)', () => {
  const pct = (id: string, value: number, reparto: unknown, amount: number) => fila(id, amount, reparto, { type: 'PERCENTAGE', value })
  it('% de cuenta: sobre los renglones sin promoción, como hoy', () => {
    const res = importesDeLasFilas([rp('a', 100, 'pa', 'c1'), rp('p', 90, 'pp', 'c1', { orderPromotionId: 'op' })], [pct('d', 10, null, 9)])
    expect(res.montosRederivados.get('d')).toBe(10)
    expect(res.descuento).toBe(10)
  })
  it('control — venta sana: subir la cantidad del mismo artículo re-deriva igual que hoy ($10 → $20)', () => {
    const res = importesDeLasFilas([rp('a', 200, 'pa', 'c1')], [pct('cat', 10, deCategoria(10, { a: 10 }), 10)])
    expect(res.montosRederivados.get('cat')).toBe(20)
  })
  it('control — venta sana: otro artículo de la misma categoría entra al ámbito ($15, igual que hoy)', () => {
    const res = importesDeLasFilas([rp('a', 100, 'pa', 'c1'), rp('a2', 50, 'pa2', 'c1')], [pct('cat', 10, deCategoria(10, { a: 10 }), 10)])
    expect(res.montosRederivados.get('cat')).toBe(15)
  })
  it('🔴 antes/después: un artículo de OTRA categoría ya no infla el % de categoría: $10 (hoy, % de toda la cuenta: $25)', () => {
    const res = importesDeLasFilas([rp('a', 100, 'pa', 'c1'), rp('b', 150, 'pb', 'c9')], [pct('cat', 10, deCategoria(10, { a: 10 }), 10)])
    expect(res.montosRederivados.get('cat')).toBe(10)
  })
  it('🔴 un «Otro importe» (sin producto) no entra al ámbito: $10 (hoy $15)', () => {
    const res = importesDeLasFilas([rp('a', 100, 'pa', 'c1'), rp('x', 50, null, null)], [pct('cat', 10, deCategoria(10, { a: 10 }), 10)])
    expect(res.montosRederivados.get('cat')).toBe(10)
  })
  it('% de artículo: el ámbito es el producto', () => {
    const deArticulo = nuevoRepartoDirigido(10, { a: 10 }, { espejo: false, ambito: { productos: ['pa'], categorias: [] } })
    const res = importesDeLasFilas(
      [rp('a', 100, 'pa', 'c1'), rp('a2', 50, 'pa', 'c1'), rp('b', 100, 'pb', 'c1')],
      [pct('art', 10, deArticulo, 10)],
    )
    expect(res.montosRederivados.get('art')).toBe(15)
  })
  it('🔴 R6 antes/después: un 10 % de CUENTA con tope de $12 no lo pasa al crecer la cuenta ($12; hoy $20)', () => {
    const res = importesDeLasFilas(
      [rp('a', 100, 'pa', 'c1'), rp('b', 100, 'pb', 'c9')],
      [pct('cta', 10, nuevoRepartoDeCuenta({ conPromociones: false, tope: 12 }), 10)],
    )
    expect(res.montosRederivados.get('cta')).toBe(12)
  })
  it('control — R6, venta sana: bajo el tope el % de cuenta re-deriva igual que hoy ($11)', () => {
    const res = importesDeLasFilas(
      [rp('a', 100, 'pa', 'c1'), rp('b', 10, 'pb', 'c9')],
      [pct('cta', 10, nuevoRepartoDeCuenta({ conPromociones: false, tope: 12 }), 10)],
    )
    expect(res.montosRederivados.get('cta')).toBe(11)
  })
  it('un % de categoría con tope del catálogo ($12) no lo pasa al crecer su ámbito (hoy, % de la cuenta sin tope)', () => {
    const conTope = nuevoRepartoDirigido(10, { a: 10 }, { espejo: false, ambito: { productos: [], categorias: ['c1'] }, tope: 12 })
    const res = importesDeLasFilas([rp('a', 100, 'pa', 'c1'), rp('a2', 100, 'pa2', 'c1')], [pct('cat', 10, conTope, 10)])
    expect(res.montosRederivados.get('cat')).toBe(12)
  })
  it('🔴 antes/después: un 2×1 al 100 % (DIRIGIDA sin ámbito) se congela en $50; hoy se volvía 100 % de la cuenta ($150)', () => {
    const res = importesDeLasFilas(
      [rp('a', 100, 'pa', 'c1'), rp('b', 50, 'pb', 'c1')],
      [pct('bogo', 100, nuevoRepartoDirigido(50, { b: 50 }, { espejo: false }), 50)],
    )
    expect(res.montosRederivados.has('bogo')).toBe(false)
    expect(res.descuento).toBe(50)
  })
  // Control de regresión (Codex r1 P2, ruling del tope): un tope de 0 NO es «sin tope»; el recálculo ya lo respeta.
  it('control — un tope de 0 en el reparto topa el recálculo en $0', () => {
    const res = importesDeLasFilas(
      [rp('a', 150, 'pa', 'c1')],
      [pct('cta', 10, nuevoRepartoDeCuenta({ conPromociones: false, tope: 0 }), 0)],
    )
    expect(res.montosRederivados.get('cta')).toBe(0)
    expect(nuevoRepartoDeCuenta({ conPromociones: true, tope: 0 }).tope).toBe(0)
  })
  it('fijo, con appliedToItemIds o con valor 0: su importe de hoy', () => {
    const res = importesDeLasFilas(
      [rp('a', 100, 'pa', 'c1')],
      [fila('fijo', 7, null), { ...pct('esp', 10, null, 3), appliedToItemIds: ['a'] }, pct('cero', 0, null, 4)],
    )
    expect(res.montosRederivados.size).toBe(0)
    expect(res.descuento).toBe(14)
  })
})

describe('R8 — el % ya no se calcula sobre lo regalado (founder, 2-oct)', () => {
  const pct = (id: string, value: number, reparto: unknown, amount: number) => fila(id, amount, reparto, { type: 'PERCENTAGE', value })
  const cortesia = (id: string, total: number, categoryId = 'c1') =>
    rp(id, total, `p-${id}`, categoryId, { discountAmount: total, isCortesia: true })
  it('estaRegalado: cortesía, o descuento propio que cubre todo; uno parcial no', () => {
    expect(estaRegalado(cortesia('c', 50))).toBe(true)
    expect(estaRegalado(rp('x', 50, 'px', 'c1', { discountAmount: 50 }))).toBe(true)
    expect(estaRegalado(rp('y', 50, 'py', 'c1', { discountAmount: 10 }))).toBe(false)
    expect(estaRegalado(rp('z', 0, null, null))).toBe(false)
  })
  it('🔴 antes/después: el % de cuenta no cuenta una cortesía de la terminal (10 % de $100 = $10; hoy $15)', () => {
    const res = importesDeLasFilas([rp('a', 100, 'pa', 'c1'), cortesia('c', 50)], [pct('cta', 10, null, 10)])
    expect(res.montosRederivados.get('cta')).toBe(10)
  })
  it('🔴 antes/después: tampoco el % de categoría ($10; hoy $15)', () => {
    const res = importesDeLasFilas([rp('a', 100, 'pa', 'c1'), cortesia('c', 50)], [pct('cat', 10, deCategoria(10, { a: 10 }), 10)])
    expect(res.montosRederivados.get('cat')).toBe(10)
  })
  it('control — venta sana: un artículo con descuento PARCIAL sigue en la base como hoy ($15)', () => {
    const res = importesDeLasFilas([rp('a', 100, 'pa', 'c1', { discountAmount: 10 }), rp('b', 50, 'pb', 'c1')], [pct('cta', 10, null, 15)])
    expect(res.montosRederivados.get('cta')).toBe(15)
  })
})

describe('repartosDeLaOrden — el cálculo canónico', () => {
  it('🔴 Codex r1 #1: premio dirigido de $100 a A y cupón de $10 ⇒ A recibe $100 y el cupón cae entero en B', () => {
    const premio = fila('premio', 100, nuevoRepartoDirigido(100, { A: 100 }, { espejo: false }), { createdAt: t(2) })
    const cupon = fila('cupon', 10, nuevoRepartoDeCuenta({ conPromociones: true }), { createdAt: t(1) })
    const m = repartosDeLaOrden([r('A', 100), r('B', 100)], [cupon, premio])
    expect(renglonesDe(m, 'premio')).toEqual({ A: 10000 })
    expect(renglonesDe(m, 'cupon')).toEqual({ B: 1000 })
  })
  it('🔴 dirigido de $80 a A y cuenta de $100 ⇒ A nunca pasa de $100 (80 + 16.67)', () => {
    const m = repartosDeLaOrden(
      [r('A', 100), r('B', 100)],
      [
        fila('dir', 80, nuevoRepartoDirigido(80, { A: 80 }, { espejo: false })),
        fila('cta', 100, nuevoRepartoDeCuenta({ conPromociones: true })),
      ],
    )
    expect(renglonesDe(m, 'dir')).toEqual({ A: 8000 })
    expect(renglonesDe(m, 'cta')).toEqual({ A: 1667, B: 8333 })
  })
  it('🔴 promoción $100→$80 + cuenta de $10 (spec §11): exactamente $10, ninguna parte negativa', () => {
    const m = repartosDeLaOrden([r('n', 100), r('p', 80, 20, 'op')], [fila('cta', 10, nuevoRepartoDeCuenta({ conPromociones: true }))])
    expect(renglonesDe(m, 'cta')).toEqual({ n: 556, p: 444 })
  })
  it('una fila re-derivada por el recálculo toma su regla: sin la línea de promoción', () => {
    const m = repartosDeLaOrden([r('n', 100), r('p', 80, 20, 'op')], [fila('pct', 10, null, { type: 'PERCENTAGE', value: 10 })], {
      rederivadas: new Set(['pct']),
    })
    expect(m.get('pct')).toEqual({ v: 1, alcance: 'CUENTA', conPromociones: false, espejo: false, renglones: { n: 1000 } })
  })
  it('🔴 H17: 2 centavos entre 4 renglones iguales ⇒ suma 2, nadie negativo', () => {
    const m = repartosDeLaOrden(
      [r('a', 1), r('b', 1), r('c', 1), r('d', 1)],
      [fila('x', 0.02, nuevoRepartoDeCuenta({ conPromociones: true }))],
    )
    expect(Object.values(renglonesDe(m, 'x')!)).toEqual([1, 1])
  })
  it('la base guardada limita a quién le toca («Cobrar», motor con promociones)', () => {
    const m = repartosDeLaOrden(
      [r('a', 100), r('b', 100), r('z', 100)],
      [fila('x', 10, nuevoRepartoDeCuenta({ conPromociones: false, base: ['a', 'b'] }))],
    )
    expect(renglonesDe(m, 'x')).toEqual({ a: 500, b: 500 })
  })
  it('un dirigido que no cabe en un renglón se acomoda en sus otros renglones, nunca fuera de ellos', () => {
    const m = repartosDeLaOrden(
      [r('a', 100, 95), r('b', 100), r('z', 100)],
      [fila('cat', 20, nuevoRepartoDirigido(20, { a: 10, b: 10 }, { espejo: false }))],
    )
    expect(renglonesDe(m, 'cat')).toEqual({ a: 500, b: 1500 })
  })
  it('🔴 premio sobre una cortesía (capacidad 0): no se guarda un reparto imposible — su destino queda en 0 y la factura lo verá', () => {
    const m = repartosDeLaOrden(
      [r('cort', 0, 200), r('b', 100)],
      [fila('premio', 100, nuevoRepartoDirigido(100, { cort: 100 }, { espejo: false }))],
    )
    expect(renglonesDe(m, 'premio')).toEqual({ cort: 0 })
  })
  it('una DIRIGIDA recupera su destino en 0 cuando ese renglón vuelve a tener lugar (se quitó la cortesía)', () => {
    const premio = fila('premio', 100, nuevoRepartoDirigido(100, { cort: 100 }, { espejo: false }))
    const sinLugar = repartosDeLaOrden([r('cort', 200, 200), r('b', 100)], [premio])
    expect(renglonesDe(sinLugar, 'premio')).toEqual({ cort: 0 })
    const conLugar = repartosDeLaOrden([r('cort', 200, 0), r('b', 100)], [{ ...premio, reparto: sinLugar.get('premio') }])
    expect(renglonesDe(conLugar, 'premio')).toEqual({ cort: 10000 })
  })
  // Control de regresión: pasa con el cuerpo neutro (dos mapas vacíos); con el cálculo real afirma que la 2ª pasada no mueve centavos.
  it('idempotente: sincronizar lo ya sincronizado no cambia nada (dirigido topado + cuenta)', () => {
    const rs = [r('a', 100, 95), r('b', 100), r('c', 50)]
    const fs = [
      fila('cat', 20, nuevoRepartoDirigido(20, { a: 10, b: 10 }, { espejo: false }), { createdAt: t(1) }),
      fila('cta', 33.33, nuevoRepartoDeCuenta({ conPromociones: true }), { createdAt: t(2) }),
    ]
    const uno = repartosDeLaOrden(rs, fs)
    const dos = repartosDeLaOrden(
      rs,
      fs.map(f => ({ ...f, reparto: uno.get(f.id) ?? f.reparto })),
    )
    expect(dos).toEqual(uno)
  })
  it('🔴 B3a r2 N1: una promoción regalada después (isCortesia) no recibe nada del descuento de cuenta — $10 al café (antes $5.56/$4.44)', () => {
    const m = repartosDeLaOrden(
      [r('cafe', 100), { ...r('combo', 80, 80, 'op'), isCortesia: true }],
      [fila('cta', 10, nuevoRepartoDeCuenta({ conPromociones: true }))],
    )
    expect(renglonesDe(m, 'cta')).toEqual({ cafe: 1000 })
  })
  it('una fila de CUENTA re-derivada conserva su tope y su marca de D16', () => {
    const conTope = { ...nuevoRepartoDeCuenta({ conPromociones: true, tope: 12 }), reduceImpuesto: true }
    const m = repartosDeLaOrden([r('a', 100)], [fila('cta', 10, conTope, { type: 'PERCENTAGE', value: 10 })], {
      rederivadas: new Set(['cta']),
    })
    expect(m.get('cta')).toEqual({
      v: 1,
      alcance: 'CUENTA',
      conPromociones: false,
      espejo: false,
      tope: 12,
      reduceImpuesto: true,
      renglones: { a: 1000 },
    })
  })
  it('🔴 Codex r2 N6: un destino que el redondeo deja en 0 se conserva y recupera su parte cuando el otro pierde lugar', () => {
    const unCentavo = nuevoRepartoDirigido(0.01, { A: 1, B: 1 }, { espejo: false })
    expect(unCentavo.renglones).toEqual({ A: 1, B: 0 })
    const m = repartosDeLaOrden([r('A', 1, 1), r('B', 1)], [fila('x', 0.01, unCentavo)])
    expect(renglonesDe(m, 'x')).toEqual({ A: 0, B: 1 })
  })
  it('una DIRIGIDA re-derivada en su ámbito sigue DIRIGIDA, con los pesos de su ámbito (los de otra categoría no reciben)', () => {
    const conAmbito = deCategoria(10, { a: 10 })
    const m = repartosDeLaOrden(
      [rp('a', 100, 'pa', 'c1'), rp('a2', 50, 'pa2', 'c1'), rp('b', 100, 'pb', 'c9')],
      [fila('cat', 15, conAmbito, { type: 'PERCENTAGE', value: 10 })],
      { rederivadas: new Set(['cat']) },
    )
    expect(m.get('cat')).toEqual({ ...conAmbito, renglones: { a: 1000, a2: 500 } })
  })
  it('las espejo quedan intactas y no consumen capacidad (su importe ya salió de la aportación)', () => {
    const espejo = nuevoRepartoDirigido(20, { a: 20 }, { espejo: true })
    const m = repartosDeLaOrden(
      [r('a', 100, 20)],
      [fila('esp', 20, espejo), fila('cta', 80, nuevoRepartoDeCuenta({ conPromociones: true }))],
    )
    expect(m.get('esp')).toEqual(espejo)
    expect(renglonesDe(m, 'cta')).toEqual({ a: 8000 })
  })
  it('una fila vieja sin reparto no se inventa ni consume capacidad', () => {
    const m = repartosDeLaOrden([r('a', 100)], [fila('vieja', 5, null), fila('cta', 100, nuevoRepartoDeCuenta({ conPromociones: true }))])
    expect(m.has('vieja')).toBe(false)
    expect(renglonesDe(m, 'cta')).toEqual({ a: 10000 })
  })
  it('determinista: ni el orden de los renglones ni el de las filas cambia el resultado (empate de hora ⇒ por id)', () => {
    const filas = [
      fila('b', 0.01, nuevoRepartoDeCuenta({ conPromociones: true })),
      fila('a', 0.01, nuevoRepartoDeCuenta({ conPromociones: true })),
    ]
    const uno = repartosDeLaOrden([r('y', 10), r('x', 10)], filas)
    const dos = repartosDeLaOrden([r('x', 10), r('y', 10)], [...filas].reverse())
    expect([...uno.entries()].sort()).toEqual([...dos.entries()].sort())
    expect(renglonesDe(uno, 'a')).toEqual({ x: 1 })
    expect(renglonesDe(uno, 'b')).toEqual({ y: 1 })
  })
})

describe('capacidadRestante — lo que cada renglón todavía puede recibir (P11)', () => {
  it('descuenta su descuento propio y lo que ya le dieron las filas; una cortesía queda en 0', () => {
    const cap = capacidadRestante(
      [r('a', 100, 10), r('b', 50), r('c', 0, 80)],
      [fila('dir', 30, nuevoRepartoDirigido(30, { a: 30 }, { espejo: false }))],
    )
    expect(Object.fromEntries(cap)).toEqual({ a: 6000, b: 5000, c: 0 })
  })
})

describe('repartirSinConstancia — D8 (filas viejas, cabecera de delivery)', () => {
  it('un solo IVA ⇒ proporcional exacto', () => {
    expect(
      repartirSinConstancia(1000, [
        { id: 'a', importeCents: 10000, grupoIva: 'IVA_16' },
        { id: 'b', importeCents: 30000, grupoIva: 'IVA_16' },
      ]),
    ).toEqual({
      ok: true,
      porRenglon: { a: 250, b: 750 },
    })
  })
  it('IVA mezclado ⇒ motivo en lenguaje del dueño (sin «reparto guardado»)', () => {
    const res = repartirSinConstancia(1000, [
      { id: 'a', importeCents: 10000, grupoIva: 'IVA_16' },
      { id: 'b', importeCents: 10000, grupoIva: 'IVA_0' },
    ])
    expect(res).toEqual({ ok: false, motivo: MOTIVO_SIN_REPARTO_IVA_MEZCLADO })
    expect(MOTIVO_SIN_REPARTO_IVA_MEZCLADO).not.toMatch(/reparto/i)
  })
  it('más descuento que importe ⇒ motivo; sin descuento ⇒ nada', () => {
    expect(repartirSinConstancia(5000, [{ id: 'a', importeCents: 1000, grupoIva: 'IVA_16' }]).ok).toBe(false)
    expect(repartirSinConstancia(0, [{ id: 'a', importeCents: 1000, grupoIva: 'IVA_16' }])).toEqual({ ok: true, porRenglon: {} })
  })
  // Codex r1 P3: el camino de lectura (D8) nunca lanza ni trunca dinero: con fracción de centavo, resultado inválido.
  it('🔴 un monto o un importe con fracción de centavo ⇒ resultado inválido con motivo (ni lanza ni trunca)', () => {
    const montoConFraccion = () => repartirSinConstancia(50.5, [{ id: 'a', importeCents: 1000, grupoIva: 'IVA_16' }])
    expect(montoConFraccion).not.toThrow()
    expect(montoConFraccion()).toMatchObject({ ok: false })
    expect(repartirSinConstancia(50, [{ id: 'a', importeCents: 1000.5, grupoIva: 'IVA_16' }])).toMatchObject({ ok: false })
  })
})

describe('reduccionDeImpuestoCobrado — D16 (spec §4.8; Codex r1 #1, #2)', () => {
  const R = (id: string, total: unknown, taxAmount: unknown) => ({ id, total, taxAmount })
  it.each([['IVA_INCLUIDO'], ['DESCONOCIDO'], [null], [undefined]])('%s ⇒ 0 (control de regresión: el cuerpo neutro ya da 0)', contrato => {
    expect(reduccionDeImpuestoCobrado(contrato, { a: 1000 }, [R('a', 100, 16)])).toBe(0)
  })
  it('🔴 por renglón, con lo que de verdad le tocó: 2×1 de A ($10, IVA $1.60) y B (3 × $20, sin IVA), $10/$20 ⇒ $1.60', () => {
    expect(reduccionDeImpuestoCobrado('IVA_APARTE', { A: 1000, B: 2000 }, [R('A', 10, '1.6'), R('B', 60, 0)])).toBe(1.6)
  })
  it('🔴 Decimal y un solo redondeo: $0.08 sobre base $0.16 con IVA $0.03 ⇒ $0.02 (con Number salía $0.01)', () => {
    expect(reduccionDeImpuestoCobrado('IVA_APARTE', { x: 8 }, [R('x', '0.16', '0.03')])).toBe(0.02)
  })
  // Pasa con el cuerpo neutro (espera 0): control; cae con el sabotaje «redondear por renglón y luego escalar» ($0.01).
  it('control — sobre lo APLICADO: $0.02 de un renglón de $1 con IVA $0.16 ⇒ $0.00 (redondear y luego escalar daba $0.01)', () => {
    expect(reduccionDeImpuestoCobrado('IVA_APARTE', { x: 2 }, [R('x', 1, '0.16')])).toBe(0)
  })
  it('nunca más que el impuesto de los renglones que recibieron parte', () => {
    expect(reduccionDeImpuestoCobrado('IVA_APARTE', { x: 5000 }, [R('x', 10, '1.6')])).toBe(1.6)
  })
  it('nunca más que el impuesto disponible de la cabecera; negativo o cero ⇒ 0', () => {
    expect(reduccionDeImpuestoCobrado('IVA_APARTE', { a: 1000 }, [R('a', 100, 16)], 1)).toBe(1)
    expect(reduccionDeImpuestoCobrado('IVA_APARTE', { a: 1000 }, [R('a', 100, 16)], 0)).toBe(0)
    expect(reduccionDeImpuestoCobrado('IVA_APARTE', { a: 1000 }, [R('a', 100, 16)], '-5')).toBe(0)
  })
  // Preflight R-1: pasa con el cuerpo neutro; cae con el sabotaje «dividir sin mirar el total/impuesto».
  it('control — renglón de importe 0, sin impuesto, inexistente o con parte 0: no aporta (sin dividir entre cero)', () => {
    expect(reduccionDeImpuestoCobrado('IVA_APARTE', { z: 100, y: 100, w: 100, x: 0 }, [R('z', 0, 5), R('y', 10, 0), R('x', 10, 5)])).toBe(0)
  })
})

describe('impuestoQueSeLlevan — R9 (Codex r4 R4-1): los renglones que salen se llevan su IVA de la cabecera', () => {
  const sale = (taxAmount: unknown) => ({ taxAmount })
  it('🔴 caso 1: cabecera 24 (16 + 8) y sale el renglón de 16 ⇒ 16', () => {
    expect(Number(impuestoQueSeLlevan('IVA_APARTE', { taxAmount: 24, reduccionesQueVuelven: [] }, [sale(16)]))).toBe(16)
  })
  it('🔴 caso 2: D16 ya dejó la cabecera en 0 (una fila restó 16) y la base lo cuenta ⇒ 16', () => {
    expect(Number(impuestoQueSeLlevan('IVA_APARTE', { taxAmount: 0, reduccionesQueVuelven: [16] }, [sale(16)]))).toBe(16)
  })
  it('🔴 piso: nunca más que la base de la cabecera (12 ⇒ 12, no 16)', () => {
    expect(Number(impuestoQueSeLlevan('IVA_APARTE', { taxAmount: 12, reduccionesQueVuelven: [] }, [sale(16)]))).toBe(12)
  })
  it('🔴 DESCONOCIDO con IVA escrito (SoftRestaurant de antes del contrato): también se lleva el suyo (16 + 8 ⇒ 24)', () => {
    expect(Number(impuestoQueSeLlevan('DESCONOCIDO', { taxAmount: 24, reduccionesQueVuelven: [] }, [sale(16), sale(8)]))).toBe(24)
  })
  // Preflight R-1: pasa con el cuerpo neutro (0); cae con los sabotajes «sin la rama de IVA incluido» o «sin el piso de la base».
  it('control — IVA incluido ⇒ 0 aunque el renglón traiga IVA escrito; renglones sin IVA o negativos ⇒ 0; base negativa ⇒ 0', () => {
    expect(Number(impuestoQueSeLlevan('IVA_INCLUIDO', { taxAmount: 16, reduccionesQueVuelven: [] }, [sale(16)]))).toBe(0)
    expect(
      Number(impuestoQueSeLlevan('IVA_APARTE', { taxAmount: 24, reduccionesQueVuelven: [] }, [sale(0), sale('-5'), sale(undefined)])),
    ).toBe(0)
    expect(Number(impuestoQueSeLlevan('DESCONOCIDO', { taxAmount: '-1.6', reduccionesQueVuelven: [] }, [sale(16)]))).toBe(0)
  })
})

describe('reduccionesQueNoVuelven — Codex r5 #1: las reducciones cuya vuelta no está garantizada', () => {
  const marca = { v: 1, alcance: 'CUENTA', conPromociones: false, espejo: false, reduceImpuesto: true, renglones: { a: 1000 } }
  const f = (id: string, taxReduction: unknown, reparto: unknown = null) => ({ id, taxReduction, reparto })
  it('🔴 la del motor de antes de D16 (sin reparto, o sin la marca) con reducción ≠ 0 es heredada; la marcada en IVA_APARTE no', () => {
    const filas = [f('vieja', '3.2'), f('sinMarca', 1, { ...marca, reduceImpuesto: undefined }), f('d16', '0.8', marca)]
    expect(reduccionesQueNoVuelven('IVA_APARTE', filas).map(x => x.id)).toEqual(['vieja', 'sinMarca'])
  })
  it('🔴 una marcada en una orden que ya no es IVA_APARTE (una fusión la dejó DESCONOCIDO) tampoco: la sincronización ya no la recalcula', () => {
    expect(reduccionesQueNoVuelven('DESCONOCIDO', [f('d16', '0.8', marca)]).map(x => x.id)).toEqual(['d16'])
  })
  // Preflight R-1: pasa con el cuerpo neutro ([]); cae con el sabotaje «sin mirar si la reducción es 0».
  it('control — reducción 0 (marcada o no) no estorba', () => {
    expect(reduccionesQueNoVuelven('IVA_APARTE', [f('cero', 0), f('ceroMarcada', '0', marca)])).toEqual([])
  })
})

describe('recorteDeFila — B2c (P4, P5): qué pasa con una fila cuando salen renglones', () => {
  const sale = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    appliedDiscountId: null,
    isCortesia: false,
    discountAmount: 0,
    ...extra,
  })
  const dirigido = (renglones: Record<string, number>, espejo = false) => ({
    v: 1,
    alcance: 'DIRIGIDO',
    conPromociones: null,
    espejo,
    renglones,
  })

  it('🔴 DIRIGIDA con todos sus destinos fuera ⇒ se retira entera, aunque su parte guardada sea 0 (premio sobre una cortesía)', () => {
    expect(recorteDeFila(fila('premio', 100, dirigido({ cort: 0 })), [sale('cort')])).toEqual({ accion: 'RETIRAR', quitaCents: 10000 })
  })
  it('🔴 DIRIGIDA con uno de dos destinos fuera ⇒ se recorta por la parte GUARDADA de ese destino', () => {
    expect(recorteDeFila(fila('cat', 20, dirigido({ a: 500, b: 1500 })), [sale('a')])).toEqual({
      accion: 'RECORTAR',
      quitaCents: 500,
      amountCents: 1500,
      appliedToItemIds: [],
      reparto: dirigido({ b: 1500 }),
    })
  })
  it('espejo del artículo que sale ⇒ se retira', () => {
    expect(recorteDeFila(fila('esp', 10, dirigido({ a: 1000 }, true), { appliedToItemIds: ['a'] }), [sale('a')])).toEqual({
      accion: 'RETIRAR',
      quitaCents: 1000,
    })
  })
  it('cortesía espejo con dos renglones, sale uno ⇒ se recorta y deja el otro', () => {
    const comp = fila('comp', 80, dirigido({ x: 5000, y: 3000 }, true), { type: 'COMP', isComp: true, appliedToItemIds: ['x', 'y'] })
    expect(recorteDeFila(comp, [sale('x', { isCortesia: true, discountAmount: 50 })])).toEqual({
      accion: 'RECORTAR',
      quitaCents: 5000,
      amountCents: 3000,
      appliedToItemIds: ['y'],
      reparto: dirigido({ y: 3000 }, true),
    })
  })
  it('control — DIRIGIDA sin destinos que salgan, y fila de CUENTA ⇒ nada (la de cuenta la re-reparte la sincronización)', () => {
    expect(recorteDeFila(fila('cat', 20, dirigido({ b: 2000 })), [sale('a')])).toEqual({ accion: 'NADA' })
    expect(recorteDeFila(fila('cta', 10, nuevoRepartoDeCuenta({ conPromociones: true })), [sale('a')])).toEqual({ accion: 'NADA' })
  })
  it('vieja sin reparto con forma de espejo de artículo ⇒ se retira; vieja de cuenta ⇒ nada (D8)', () => {
    const espejoViejo = fila('ev', 10, null, { type: 'PERCENTAGE', discountId: 'cat-10', appliedToItemIds: ['a'] })
    expect(recorteDeFila(espejoViejo, [sale('a', { appliedDiscountId: 'cat-10' })])).toEqual({ accion: 'RETIRAR', quitaCents: 1000 })
    const cobrarViejo = fila('cv', 20, null, { discountId: 'orden-20', appliedToItemIds: ['a', 'b'] })
    expect(recorteDeFila(cobrarViejo, [sale('a')])).toEqual({ accion: 'NADA' })
  })
  it('cortesía vieja de «Cobrar» sin reparto, sale uno de sus dos renglones ⇒ se recorta por el descuento de ese renglón', () => {
    const compViejo = fila('cv', 80, null, { type: 'COMP', isComp: true, appliedToItemIds: ['x', 'y'] })
    expect(recorteDeFila(compViejo, [sale('x', { isCortesia: true, discountAmount: 50 })])).toEqual({
      accion: 'RECORTAR',
      quitaCents: 5000,
      amountCents: 3000,
      appliedToItemIds: ['y'],
      reparto: null,
    })
  })
  // Preflight T-1 (Codex r1 P2 de B2): una COMP del catálogo (de cuenta) lleva `discountId`; la cortesía independiente de su
  // renglón no la vuelve espejo — las mismas dos formas que reconoce `revertirDescuentoDelRenglon`.
  it('control — COMP del catálogo (con discountId) sobre una cortesía que sale ⇒ NADA', () => {
    const compDelCatalogo = fila('cuenta', 20, null, { type: 'COMP', isComp: true, discountId: 'cat-comp', appliedToItemIds: ['cafe'] })
    expect(recorteDeFila(compDelCatalogo, [sale('cafe', { isCortesia: true, discountAmount: 100 })])).toEqual({ accion: 'NADA' })
  })
  // Preflight T-4 (nota B2 T1): el recorte deja la DIRIGIDA con sus destinos vivos; si un destino ya no está entre los renglones,
  // el reparto canónico tampoco lo conserva (B2c depende de ello).
  it('control — destino DIRIGIDO cuyo renglón ya no está en la orden desaparece de las llaves del reparto', () => {
    const m = repartosDeLaOrden([r('b', 100)], [fila('cat', 20, nuevoRepartoDirigido(20, { a: 5, b: 15 }, { espejo: false }))])
    expect(Object.keys(renglonesDe(m, 'cat')!)).toEqual(['b'])
  })
})
