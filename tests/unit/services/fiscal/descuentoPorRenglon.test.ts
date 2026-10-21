/**
 * IVA por producto, bloque B3a (spec planes 6-7 §4.2, D7 lectura, D8): cuánto descuento de CUENTA le toca a cada renglón.
 * Puro: la factura LEE los repartos que guardó quien calculó cada descuento (B2) y sólo lo que no consta va por D8.
 */
import {
  DESCUENTOS_PARA_CONCEPTOS,
  MOTIVO_DESCUENTOS_NO_CUADRAN,
  MOTIVO_REPARTO_FUERA_DE_LA_CUENTA,
  PAGINA_DE_DESCUENTOS,
  descuentoDeCuentaPorRenglon,
  descuentoPropioEnCabeceraCents,
  netoRenglonCents,
  partesDeLaCuenta,
} from '@/services/fiscal/descuentoPorRenglon'
import { MOTIVO_SIN_REPARTO_IVA_MEZCLADO } from '@/services/shared/repartoDescuento'

const cuenta = (renglones: Record<string, number>) => ({ v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones })
const dirigido = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones })
const espejo = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones })
const vivo = (llave: string, disponibleCents: number, grupoIva = 'IVA_16', propioEnCabeceraCents = 0) => ({
  llave,
  propioEnCabeceraCents,
  vivo: { grupoIva, disponibleCents },
})

describe('descuentoPropioEnCabeceraCents — qué descuento de renglón ya pesa en Order.discountAmount', () => {
  it('descuento de artículo o cortesía de «Cobrar» (total bruto): sí, por su fila espejo', () => {
    expect(descuentoPropioEnCabeceraCents({ total: 100, discountAmount: 20 })).toBe(2000)
    expect(descuentoPropioEnCabeceraCents({ total: 50, discountAmount: 50, isCortesia: true })).toBe(5000)
  })
  it('control — línea de promoción: nunca (la promoción no toca la cabecera)', () => {
    expect(descuentoPropioEnCabeceraCents({ total: 80, discountAmount: 20, orderPromotionId: 'op1' })).toBe(0)
  })
  it('🔴 promoción regalada después en la terminal (compItems): la cortesía SÍ sumó sus $80 a la cabecera', () => {
    expect(descuentoPropioEnCabeceraCents({ total: 80, discountAmount: 80, orderPromotionId: 'op1', isCortesia: true })).toBe(8000)
  })
  it('control — cortesía que dejó el renglón en 0 (móvil, importe libre de la terminal): no, bajó el subtotal', () => {
    expect(descuentoPropioEnCabeceraCents({ total: 0, discountAmount: 45, isCortesia: true })).toBe(0)
  })
})

describe('descuentoDeCuentaPorRenglon', () => {
  it('🔴 LEE el reparto tal cual, aunque no sea proporcional al precio (D7: nunca se reinterpreta)', () => {
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 1000,
        renglones: [vivo('a', 10000), vivo('b', 10000)],
        filas: [{ amount: 10, reparto: cuenta({ a: 700, b: 300 }) }],
      }),
    ).toEqual({ porLlave: { a: 700, b: 300 }, motivos: [] })
  })
  it('con IVA mezclado basta el reparto guardado: no hay que adivinar', () => {
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 1500,
        renglones: [vivo('a', 10000), vivo('b', 5000, 'IVA_0')],
        filas: [{ amount: 15, reparto: cuenta({ a: 1000, b: 500 }) }],
      }),
    ).toEqual({ porLlave: { a: 1000, b: 500 }, motivos: [] })
  })
  it('una fila ESPEJO no suma: su importe ya vive en el renglón (y llega a la cabecera por él)', () => {
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 2700,
        renglones: [vivo('a', 8000, 'IVA_16', 2000), vivo('b', 5000)],
        filas: [
          { amount: 20, reparto: espejo({ a: 2000 }) },
          { amount: 7, reparto: cuenta({ a: 400, b: 300 }) },
        ],
      }),
    ).toEqual({ porLlave: { a: 400, b: 300 }, motivos: [] })
  })
  it('una DIRIGIDA con un destino en 0 (B2: guarda todos sus destinos) no mira ese destino', () => {
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 1000,
        renglones: [vivo('a', 10000)],
        filas: [{ amount: 10, reparto: dirigido({ a: 1000, borrado: 0 }) }],
      }),
    ).toEqual({ porLlave: { a: 1000 }, motivos: [] })
  })
  it('sin filas (delivery, cabecera sola): D8 con un solo IVA, en proporción a lo que le queda a cada renglón', () => {
    expect(descuentoDeCuentaPorRenglon({ cabeceraCents: 1000, renglones: [vivo('a', 6000), vivo('b', 4000)], filas: [] })).toEqual({
      porLlave: { a: 600, b: 400 },
      motivos: [],
    })
  })
  it('D8 con IVA mezclado ⇒ el motivo de B2', () => {
    expect(descuentoDeCuentaPorRenglon({ cabeceraCents: 1000, renglones: [vivo('a', 6000), vivo('b', 4000, 'IVA_0')], filas: [] })).toEqual(
      {
        porLlave: {},
        motivos: [MOTIVO_SIN_REPARTO_IVA_MEZCLADO],
      },
    )
  })
  it('fila vieja (sin reparto) junto a una con reparto: lo viejo va por D8 sobre lo que le queda a cada renglón', () => {
    // La de 10 pesa 1000 en «a»; los 600 viejos se reparten sobre 9000 y 10000: 284 y 316 (mayor remanente).
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 1600,
        renglones: [vivo('a', 10000), vivo('b', 10000)],
        filas: [
          { amount: 10, reparto: cuenta({ a: 1000 }) },
          { amount: 6, reparto: null },
        ],
      }),
    ).toEqual({ porLlave: { a: 1284, b: 316 }, motivos: [] })
  })
  it('un reparto que suma MENOS que su fila (B2: no cupo): lo que guarda consta y lo que falta va por D8', () => {
    // a: 500 que constan; los 500 que no cupieron se reparten sobre 9500 y 10000 ⇒ 244 y 256.
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 1000,
        renglones: [vivo('a', 10000), vivo('b', 10000)],
        filas: [{ amount: 10, reparto: cuenta({ a: 500 }) }],
      }),
    ).toEqual({ porLlave: { a: 744, b: 256 }, motivos: [] })
  })
  it('🔴 C9b (M1, cabecera NOMINAL de B2c): lo que le falta a un reparto válido entra a D8 sólo hasta la capacidad que queda; lo que no cupo nunca se cobró', () => {
    // A $100 regalado en la terminal (espejo COMP, 10000) + B $50; fijo de cuenta de $60 que sólo cupo en B (5000). Cabecera
    // 160 = Σ filas sin tope. Los $10 que no cupieron no tienen dónde ir (capacidad 0): se descartan, sin motivo.
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 16000,
        renglones: [vivo('A', 0, 'IVA_16', 10000), vivo('B', 5000)],
        filas: [
          { amount: 60, reparto: cuenta({ B: 5000 }) },
          { amount: 100, reparto: espejo({ A: 10000 }) },
        ],
      }),
    ).toEqual({ porLlave: { B: 5000 }, motivos: [] })
  })
  it('un reparto que suma MÁS que su fila no es constancia: la fila entera va por D8', () => {
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 500,
        renglones: [vivo('a', 10000), vivo('b', 10000)],
        filas: [{ amount: 5, reparto: cuenta({ a: 1000 }) }],
      }),
    ).toEqual({ porLlave: { a: 250, b: 250 }, motivos: [] })
  })
  it('un reparto sobre un renglón que no está en la cuenta ⇒ su motivo', () => {
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 1000,
        renglones: [vivo('a', 10000)],
        filas: [{ amount: 10, reparto: cuenta({ borrado: 1000 }) }],
      }),
    ).toEqual({ porLlave: {}, motivos: [MOTIVO_REPARTO_FUERA_DE_LA_CUENTA] })
  })
  it('lo que consta suma más que la cabecera ⇒ su motivo', () => {
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 500,
        renglones: [vivo('a', 10000)],
        filas: [{ amount: 10, reparto: cuenta({ a: 1000 }) }],
      }),
    ).toEqual({ porLlave: {}, motivos: [MOTIVO_DESCUENTOS_NO_CUADRAN] })
  })
  it('control — E8b (M2, importadas de SoftRestaurant): sin ninguna fila con reparto, descuentos propios por encima de la cabecera ⇒ 0, como hoy', () => {
    expect(descuentoDeCuentaPorRenglon({ cabeceraCents: 1000, renglones: [vivo('a', 8500, 'IVA_16', 1500)], filas: [] })).toEqual({
      porLlave: {},
      motivos: [],
    })
  })
  it('🔴 M2: con una fila que SÍ trae reparto (escritor nativo), descuentos propios por encima de la cabecera ⇒ su motivo', () => {
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 1000,
        renglones: [vivo('a', 8500, 'IVA_16', 1500)],
        filas: [{ amount: 10, reparto: espejo({ a: 1000 }) }],
      }),
    ).toEqual({ porLlave: {}, motivos: [MOTIVO_DESCUENTOS_NO_CUADRAN] })
  })
  it('🔴 101 descuentos de un centavo se facturan: no hay tope de filas (Codex r1 #6)', () => {
    const filas = Array.from({ length: 101 }, () => ({ amount: 0.01, reparto: null }))
    expect(descuentoDeCuentaPorRenglon({ cabeceraCents: 101, renglones: [vivo('a', 10000)], filas })).toEqual({
      porLlave: { a: 101 },
      motivos: [],
    })
  })
  it('control — la consulta pide una página y una fila de más, en orden estable', () => {
    expect(DESCUENTOS_PARA_CONCEPTOS).toEqual({
      select: { id: true, amount: true, reparto: true },
      orderBy: { id: 'asc' },
      take: PAGINA_DE_DESCUENTOS + 1,
    })
  })
  it('control — sin descuentos ⇒ nada, sin motivos', () => {
    expect(descuentoDeCuentaPorRenglon({ cabeceraCents: 0, renglones: [vivo('a', 100)], filas: [] })).toEqual({ porLlave: {}, motivos: [] })
  })
})

describe('netoRenglonCents — lo que el renglón cobra', () => {
  it('bruto con descuento de artículo: total − descuento', () => expect(netoRenglonCents({ total: 100, discountAmount: 30 })).toBe(7000))
  it('cortesía de «Cobrar» (descuento = total): 0', () =>
    expect(netoRenglonCents({ total: 50, discountAmount: 50, isCortesia: true })).toBe(0))
  it('cortesía del móvil (total 0, descuento = lo regalado): 0, no negativo', () =>
    expect(netoRenglonCents({ total: 0, discountAmount: 45, isCortesia: true })).toBe(0))
  it('🔴 promoción regalada después en la terminal (total 80, descuento 80, cortesía): 0', () =>
    expect(netoRenglonCents({ total: 80, discountAmount: 80, orderPromotionId: 'op1', isCortesia: true })).toBe(0))
  it('🔴 promoción normal del 50 % (total = descuento, SIN cortesía): cobra su total, no se confunde con cortesía', () =>
    expect(netoRenglonCents({ total: 50, discountAmount: 50, orderPromotionId: 'op1' })).toBe(5000))
  it('dato roto (descuento mayor que un total no cero): negativo, para que lo detenga su motivo', () =>
    expect(netoRenglonCents({ total: 30, discountAmount: 50 })).toBe(-2000))
})

// ─── Bloque B4b (Codex r1 P1 #3): lo que consta se separa de lo que falta. La factura sigue igual; el reporte conserva lo guardado ───
describe('B4b · partesDeLaCuenta', () => {
  const R = (llave: string, disponibleCents: number, grupoIva = 'IVA_16') => ({
    llave,
    propioEnCabeceraCents: 0,
    vivo: { grupoIva, disponibleCents },
  })
  const dir = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones })
  const cafeYGrano = [R('cafe', 11600), R('grano', 10000, 'IVA_0')]

  it('🔴 una fila con reparto y otra vieja sin él: lo que consta se conserva y lo demás queda para D8', () => {
    expect(
      partesDeLaCuenta({
        cabeceraCents: 3000,
        renglones: cafeYGrano,
        filas: [
          { amount: 20, reparto: dir({ grano: 2000 }) },
          { amount: 10, reparto: null },
        ],
      }),
    ).toEqual({
      porLlave: { grano: 2000 },
      d8Cents: 1000,
      quedan: [
        { id: 'cafe', importeCents: 11600, grupoIva: 'IVA_16' },
        { id: 'grano', importeCents: 8000, grupoIva: 'IVA_0' },
      ],
      motivos: [],
    })
  })

  it('🔴 un reparto incompleto (guardó 20 de 30): lo guardado se conserva y lo que le falta entra a D8 hasta la capacidad (M1)', () => {
    const p = partesDeLaCuenta({ cabeceraCents: 3000, renglones: cafeYGrano, filas: [{ amount: 30, reparto: dir({ grano: 2000 }) }] })
    expect(p).toMatchObject({ porLlave: { grano: 2000 }, d8Cents: 1000, motivos: [] })
  })

  it('🔴 un reparto sobre un renglón que ya no cobra: el motivo de la factura, y lo que sí consta se conserva', () => {
    const p = partesDeLaCuenta({
      cabeceraCents: 3000,
      renglones: cafeYGrano,
      filas: [{ amount: 30, reparto: dir({ grano: 2000, regalo: 1000 }) }],
    })
    expect(p).toMatchObject({ porLlave: { grano: 2000 }, d8Cents: 0, motivos: [MOTIVO_REPARTO_FUERA_DE_LA_CUENTA] })
  })

  it('🔴 lo guardado suma más que la cabecera: el motivo, y lo que consta se conserva', () => {
    const p = partesDeLaCuenta({ cabeceraCents: 1000, renglones: cafeYGrano, filas: [{ amount: 20, reparto: dir({ grano: 2000 }) }] })
    expect(p).toMatchObject({ porLlave: { grano: 2000 }, d8Cents: 0, motivos: [MOTIVO_DESCUENTOS_NO_CUADRAN] })
  })

  it('🔴 dos motivos a la vez (M3): salen los dos, en el orden de la factura (fuera de la cuenta, luego no cuadran)', () => {
    const p = partesDeLaCuenta({ cabeceraCents: 500, renglones: cafeYGrano, filas: [{ amount: 10, reparto: dir({ borrado: 1000 }) }] })
    expect(p).toMatchObject({ porLlave: {}, d8Cents: 0, motivos: [MOTIVO_REPARTO_FUERA_DE_LA_CUENTA, MOTIVO_DESCUENTOS_NO_CUADRAN] })
  })

  it('control — la factura (descuentoDeCuentaPorRenglon) dice lo mismo que antes con IVA mezclado sin constancia', () => {
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 3000,
        renglones: cafeYGrano,
        filas: [
          { amount: 20, reparto: dir({ grano: 2000 }) },
          { amount: 10, reparto: null },
        ],
      }),
    ).toEqual({ porLlave: {}, motivos: [MOTIVO_SIN_REPARTO_IVA_MEZCLADO] })
  })

  it('control — M3: con dos motivos posibles la factura se detiene SÓLO con el primero (reparto fuera de la cuenta)', () => {
    expect(
      descuentoDeCuentaPorRenglon({ cabeceraCents: 500, renglones: cafeYGrano, filas: [{ amount: 10, reparto: dir({ borrado: 1000 }) }] }),
    ).toEqual({ porLlave: {}, motivos: [MOTIVO_REPARTO_FUERA_DE_LA_CUENTA] })
  })

  it('control — la factura con un reparto fuera de la cuenta no conserva nada (porLlave vacío), aunque otro renglón sí conste', () => {
    expect(
      descuentoDeCuentaPorRenglon({
        cabeceraCents: 3000,
        renglones: cafeYGrano,
        filas: [{ amount: 30, reparto: dir({ grano: 2000, regalo: 1000 }) }],
      }),
    ).toEqual({ porLlave: {}, motivos: [MOTIVO_REPARTO_FUERA_DE_LA_CUENTA] })
  })
})
