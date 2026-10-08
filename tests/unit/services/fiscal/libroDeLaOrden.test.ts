/**
 * IVA por producto, bloque B4b (spec planes 6-7 §4.9, D17, H20; Codex B4b r1 P1 #1, #2, #4; r2 N1, N2, N3, N8): el libro de una
 * orden. Puro.
 */
import { Prisma } from '@prisma/client'
import { desglosePorTratamiento, type DesglosePorTratamiento } from '../../../../src/services/fiscal/ivaMath'
import { abrirLibro, libroDeLaOrden, type MovimientoDelLibro, type ParteDelLibro } from '../../../../src/services/fiscal/libroDeLaOrden'
import { mezclaDeLaOrden, type RenglonDeMezcla } from '../../../../src/services/fiscal/mezclaDeOrden'
import { cuadrarConElPac, type ConceptoParaElPac, type TrasladoParaElPac } from '../../../../src/services/fiscal/reglaDelPac'
import { parteDeUnidades } from '../../../../src/services/shared/parteDeUnidades'

const L = (o: Record<string, unknown> = {}): RenglonDeMezcla => ({
  id: 'oi-cafe',
  quantity: 1,
  unitPrice: 116,
  total: 116,
  discountAmount: 0,
  orderPromotionId: null,
  isCortesia: false,
  ivaTratamiento: null,
  product: { taxRate: 0.16, ivaTratamiento: 'IVA_16' as const },
  ...o,
})
const G = (o: Record<string, unknown> = {}) =>
  L({ id: 'oi-grano', unitPrice: 100, total: 100, product: { taxRate: 0, ivaTratamiento: 'IVA_0' }, ...o })
const S = (o: Record<string, unknown> = {}) =>
  L({ id: 'oi-serv', unitPrice: 300, total: 300, product: { taxRate: 0, ivaTratamiento: 'EXENTO' }, ...o })
const dirigido = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones })
const venta = (id: string, pesos: number): MovimientoDelLibro => ({ id, type: 'REGULAR', amountCents: Math.round(pesos * 100) })
const devolucion = (id: string, pesos: number, processorData: unknown = { provenance: 'MANUAL' }): MovimientoDelLibro => ({
  id,
  type: 'REFUND',
  amountCents: -Math.round(pesos * 100),
  processorData,
})
const porArticulos = (items: unknown[]) => ({ provenance: 'MANUAL', refundedItems: items })
const congelado = (porTratamiento: Record<string, { baseCents: number; ivaCents: number }>) => ({
  provenance: 'PROVIDER_ADJUSTMENT',
  fiscalByRateCents: { v: 2, porTratamiento },
})
/** La suma de las partes, por tratamiento, y el IVA total. */
const suma = (partes: Iterable<ParteDelLibro>) => {
  const porTratamiento: DesglosePorTratamiento = {}
  let taxCents = 0
  for (const p of partes) {
    taxCents += p.taxCents
    for (const [t, v] of Object.entries(p.porTratamiento)) {
      const acc = (porTratamiento[t as keyof DesglosePorTratamiento] ??= { baseCents: 0, ivaCents: 0 })
      acc.baseCents += v!.baseCents
      acc.ivaCents += v!.ivaCents
    }
  }
  return { porTratamiento, taxCents }
}
const cafeYGrano = mezclaDeLaOrden([L(), G()])

describe('parteDeUnidades (la regla del escritor, mudada sin cambios)', () => {
  it('control: el piso por unidad y el residuo a las primeras unidades', () => {
    expect(parteDeUnidades(20000, 2, 0, 1)).toBe(10000)
    expect(parteDeUnidades(10001, 2, 0, 1)).toBe(5001)
    expect(parteDeUnidades(10001, 2, 1, 1)).toBe(5000)
  })
})

describe('B4b · los cobros de una orden suman exacto y nunca le quitan a una tasa (Codex r1 P1 #4; r2 N3)', () => {
  it('control: un solo cobro da exactamente lo de hoy (el reparto de siempre)', () => {
    expect(libroDeLaOrden(cafeYGrano, [venta('p1', 216)]).get('p1')).toEqual({
      ...desglosePorTratamiento(21600, cafeYGrano.mezcla),
      aproximada: false,
    })
  })

  it('🔴 Review Focus 1 · tres cobros de $72: IVA $16.00 y base al 0 % $100.00 (por cobro: 533, 534, 533)', () => {
    const partes = libroDeLaOrden(cafeYGrano, [venta('p1', 72), venta('p2', 72), venta('p3', 72)])
    expect([...partes.values()].map(p => p.taxCents)).toEqual([533, 534, 533])
    expect(suma(partes.values())).toEqual({
      porTratamiento: { IVA_16: { baseCents: 10000, ivaCents: 1600 }, IVA_0: { baseCents: 10000, ivaCents: 0 } },
      taxCents: 1600,
    })
  })

  it('🔴 excepción declarada · todo al 16 %: $38.67 + $38.67 + $38.66 dan IVA $16.00 (antes, por cobro, $15.99)', () => {
    const partes = libroDeLaOrden(mezclaDeLaOrden([L()]), [venta('p1', 38.67), venta('p2', 38.67), venta('p3', 38.66)])
    expect(suma(partes.values()).taxCents).toBe(1600)
  })

  it('🔴 Codex r2 N3 · un cobro de un centavo no le quita a una tasa lo ya asignado, ni la deja en −0.01 tras devolver su artículo', () => {
    const tres = mezclaDeLaOrden([L({ unitPrice: 100, total: 100 }), G({ unitPrice: 300, total: 300 }), S()])
    const partes = libroDeLaOrden(tres, [
      venta('p1', 200.23),
      devolucion('r1', 100, porArticulos([{ orderItemId: 'oi-cafe', quantity: 1, amountCents: 10000 }])),
      venta('p2', 0.01),
    ])
    // p1 asigna 2861 / 8581 / 8581. Repartir de nuevo los $200.24 daría 2860 / 8582 / 8582: le quitaría un centavo al 16 %, que ya se
    // devolvió entero. El centavo va a quien le falta.
    expect(partes.get('p2')).toEqual({
      netCents: 1,
      taxCents: 0,
      taxByRate: {},
      porTratamiento: { IVA_0: { baseCents: 1, ivaCents: 0 } },
      aproximada: false,
    })
    expect(suma(partes.values()).porTratamiento.IVA_16).toEqual({ baseCents: 0, ivaCents: 0 })
  })

  it('🔴 propiedad (Codex r3 R3-1, R3-6; T3 M1) · 3000 órdenes diversas: base e IVA de cada tasa nunca negativos, ningún cobro resta, ninguna devolución suma (tampoco tras devolver de más y volver a cobrar), y devolver todo deja cero', () => {
    // mulberry32: enteros de 32 bits con Math.imul. El generador de la v3 multiplicaba fuera de la precisión de Number y casi sólo
    // daba órdenes de un renglón al 16 % (Codex r3 R3-6).
    let estado = 20261005
    const azar = (n: number) => {
      estado = (estado + 0x6d2b79f5) | 0
      let t = Math.imul(estado ^ (estado >>> 15), 1 | estado)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
    }
    const productos = [
      { taxRate: 0.16, ivaTratamiento: 'IVA_16' as const },
      { taxRate: 0.08, ivaTratamiento: 'IVA_8' as const },
      { taxRate: 0, ivaTratamiento: 'IVA_0' as const },
      { taxRate: 0, ivaTratamiento: 'EXENTO' as const },
    ]
    const cobertura = {
      tamanos: [0, 0, 0, 0, 0],
      tratamientos: {} as Record<string, number>,
      diminutas: 0,
      conPeso: 0,
      conDescuentoPropio: 0,
      conDescuentoDeCuenta: 0,
      importe: 0,
      articulos: 0,
      congeladoQueCabe: 0,
      congeladoQueVacia: 0,
      congeladoQueNoCabe: 0,
      ajusteInvalido: 0,
      deMas: 0,
      cobroTrasDeMas: 0,
    }
    /** Todas las partes de un tratamiento con el signo pedido (≥ 0 para un cobro, ≤ 0 para una devolución). */
    const conSigno = (p: ParteDelLibro, signo: 1 | -1) =>
      Object.values(p.porTratamiento).every(v => signo * v!.baseCents >= 0 && signo * v!.ivaCents >= 0)

    for (let k = 0; k < 3000; k++) {
      const diminuta = azar(2) === 0 // órdenes de centavos: donde el redondeo muerde (R3-1)
      const n = 1 + azar(4)
      cobertura.tamanos[n] += 1
      if (diminuta) cobertura.diminutas += 1
      const items = Array.from({ length: n }, (_, i) => {
        const centavos = diminuta ? 2 + azar(59) : 100 + azar(30000)
        const producto = productos[azar(4)]
        cobertura.tratamientos[producto.ivaTratamiento] = (cobertura.tratamientos[producto.ivaTratamiento] ?? 0) + 1
        const pesado = azar(3) === 0
        if (pesado) cobertura.conPeso += 1
        return L({
          id: `l${i}`,
          quantity: pesado ? 1 : 1 + azar(3),
          weightQuantity: pesado ? (500 + azar(1500)) / 1000 : undefined,
          unitPrice: centavos / 100,
          total: centavos / 100,
          product: producto,
        })
      })
      // Un descuento propio de un renglón, o uno de la cuenta (dirigido a un renglón o sin reparto: D8), nunca los dos.
      let cuenta: Parameters<typeof mezclaDeLaOrden>[1] = undefined
      const clase = azar(3)
      const elegido = items[azar(n)]
      const suTotal = Math.round(Number(elegido.total) * 100)
      if (clase === 1) {
        elegido.discountAmount = azar(suTotal) / 100
        cobertura.conDescuentoPropio += 1
      } else if (clase === 2) {
        const d = azar(suTotal)
        cuenta = {
          discountAmount: d / 100,
          orderDiscounts: [{ amount: d / 100, reparto: azar(2) === 0 ? dirigido({ [elegido.id!]: d }) : null }],
        }
        cobertura.conDescuentoDeCuenta += 1
      }
      const comp = mezclaDeLaOrden(items, cuenta)
      const total = comp.mezcla.reduce((s, m) => s + m.grossCents, 0)
      const libro = abrirLibro(comp)
      // T3 M1 (revisión final): una de cada cuatro órdenes puede devolver de más (dato roto) y volver a cobrar después. Desde entonces
      // las tasas pueden quedar negativas y devolver todo ya no deja cero; lo que se sigue exigiendo es que ninguna devolución sume.
      const puedeDevolverDeMas = azar(4) === 0
      let rota = false
      const acum: Record<string, { baseCents: number; ivaCents: number }> = {}
      const anotar = (p: ParteDelLibro) => {
        for (const [t, v] of Object.entries(p.porTratamiento)) {
          const a = (acum[t] ??= { baseCents: 0, ivaCents: 0 })
          a.baseCents += v!.baseCents
          a.ivaCents += v!.ivaCents
        }
        if (rota) return
        for (const v of Object.values(acum)) expect(v.baseCents >= 0 && v.ivaCents >= 0).toBe(true) // R3-1: nunca negativos
      }
      let id = 0
      const dev = (cents: number, processorData: unknown = { provenance: 'MANUAL' }): MovimientoDelLibro => ({
        id: `r${id++}`,
        type: 'REFUND',
        amountCents: -cents,
        processorData,
      })
      let pagado = 0
      let devuelto = 0
      while (pagado < total) {
        const m = Math.min(total - pagado, 1 + azar(Math.max(1, Math.floor(total / (1 + azar(3))))))
        const venta = libro.registrar({ id: `p${id++}`, type: 'REGULAR', amountCents: m })
        expect(conSigno(venta, 1)).toBe(true) // un cobro nunca resta
        anotar(venta)
        if (rota) cobertura.cobroTrasDeMas += 1
        pagado += m
        while (azar(2) === 0 && (pagado > devuelto || rota)) {
          const queda = Math.max(0, pagado - devuelto)
          const tipo = azar(6)
          let mov: MovimientoDelLibro | null = null
          if (puedeDevolverDeMas && azar(3) === 0) {
            // T3 M1: devuelve más de lo que le queda (por importe o por un artículo)
            const deMas = queda + 1 + azar(Math.max(1, Math.floor(total / 4)))
            const it = items[azar(n)]
            mov = azar(2) === 0 ? dev(deMas) : dev(deMas, porArticulos([{ orderItemId: it.id, quantity: 1, amountCents: deMas }]))
            rota = true
            cobertura.deMas += 1
          } else if (tipo === 0) {
            mov = dev(1 + azar(queda))
            cobertura.importe += 1
          } else if (tipo === 1) {
            const it = items[azar(n)]
            const q = 1 + azar(Math.min(queda, Math.round(Number(it.total) * 100)))
            mov = dev(q, porArticulos([{ orderItemId: it.id, quantity: 1, amountCents: q }]))
            cobertura.articulos += 1
          } else {
            // Ajustes de Uber, armados sobre lo que el libro ya anotó de una tasa (la suma de sus partes).
            const vivos = Object.entries(acum).filter(([, v]) => v.baseCents + v.ivaCents > 0)
            if (vivos.length === 0) break
            const [t, v] = vivos[azar(vivos.length)]
            const s = v.baseCents + v.ivaCents
            const sinIva = t === 'IVA_0' || t === 'EXENTO'
            if (tipo === 2) {
              // cabe: base e IVA dentro de lo anotado
              const g = 1 + azar(s)
              const lo = Math.max(0, g - v.baseCents)
              const iva = lo + azar(Math.min(v.ivaCents, g) - lo + 1)
              mov = dev(g, congelado({ [t]: { baseCents: g - iva, ivaCents: iva } }))
              cobertura.congeladoQueCabe += 1
            } else if (tipo === 3) {
              // vacía la tasa con otro reparto de centavos (regla B)
              const reparto =
                sinIva || v.baseCents === 0 ? { baseCents: s, ivaCents: 0 } : { baseCents: v.baseCents - 1, ivaCents: v.ivaCents + 1 }
              mov = dev(s, congelado({ [t]: reparto }))
              cobertura.congeladoQueVacia += 1
            } else if (tipo === 4) {
              // no cabe: pide un centavo más de IVA del que le queda a la tasa
              if (sinIva || v.baseCents === 0) continue
              const g = v.ivaCents + 1 + azar(v.baseCents)
              mov = dev(g, congelado({ [t]: { baseCents: g - v.ivaCents - 1, ivaCents: v.ivaCents + 1 } }))
              cobertura.congeladoQueNoCabe += 1
            } else {
              // sin reparto válido: IVA en una tasa 0 (leerCongelado lo rechaza)
              const g = 1 + azar(queda)
              mov = dev(g, congelado({ IVA_0: { baseCents: 0, ivaCents: g } }))
              cobertura.ajusteInvalido += 1
            }
          }
          const parte = libro.registrar(mov)
          expect(conSigno(parte, -1)).toBe(true) // ninguna devolución suma: tampoco si cae en otro mes (R3-1)
          anotar(parte)
          devuelto -= mov.amountCents
        }
      }
      if (pagado > devuelto) {
        const ultima = libro.registrar(dev(pagado - devuelto))
        expect(conSigno(ultima, -1)).toBe(true)
        anotar(ultima)
      }
      if (!rota) for (const v of Object.values(acum)) expect(v).toEqual({ baseCents: 0, ivaCents: 0 }) // devolver todo deja cero
    }

    // Lo que la prueba dice que cubre, lo cubre (Codex r3 R3-6). El prototipo midió entre 1.4 y 3 veces cada mínimo.
    expect(Math.min(...cobertura.tamanos.slice(1))).toBeGreaterThan(500)
    for (const t of ['IVA_16', 'IVA_8', 'IVA_0', 'EXENTO']) expect(cobertura.tratamientos[t]).toBeGreaterThan(1200)
    expect(cobertura.diminutas).toBeGreaterThan(1000)
    expect(Math.min(cobertura.conPeso, cobertura.conDescuentoPropio, cobertura.conDescuentoDeCuenta)).toBeGreaterThan(500)
    expect(
      Math.min(cobertura.importe, cobertura.articulos, cobertura.congeladoQueCabe, cobertura.congeladoQueVacia, cobertura.ajusteInvalido),
    ).toBeGreaterThan(800)
    expect(cobertura.congeladoQueNoCabe).toBeGreaterThan(300)
    expect(Math.min(cobertura.deMas, cobertura.cobroTrasDeMas)).toBeGreaterThan(300) // T3 M1: lo roto también se recorre
  })
})

describe('B4b · devoluciones: H20, lo que queda, las cantidades y lo devuelto de más (Codex r1 P1 #1, #2; r2 N1, N2; respuesta 3)', () => {
  it('🔴 H20: devolver por artículos sólo el grano al 0 % no baja el IVA del 16 %', () => {
    const partes = libroDeLaOrden(cafeYGrano, [
      venta('p1', 216),
      devolucion('r1', 100, porArticulos([{ orderItemId: 'oi-grano', quantity: 1, amountCents: 10000 }])),
    ])
    expect(partes.get('r1')).toMatchObject({
      porTratamiento: { IVA_0: { baseCents: -10000, ivaCents: 0 } },
      taxCents: 0,
      aproximada: false,
    })
  })

  it('🔴 artículos y luego importe: los $50 por importe salen del 16 %, que es lo único que queda; la base al 0 % nunca queda negativa', () => {
    const partes = libroDeLaOrden(cafeYGrano, [
      venta('p1', 216),
      devolucion('r1', 100, porArticulos([{ orderItemId: 'oi-grano', quantity: 1, amountCents: 10000 }])),
      devolucion('r2', 50),
    ])
    expect(partes.get('r2')).toMatchObject({ porTratamiento: { IVA_16: { baseCents: -4310, ivaCents: -690 } }, aproximada: false })
    // Queda del café $66 (base 56.90 + IVA 9.10); del grano, nada.
    expect(suma(partes.values()).porTratamiento).toEqual({
      IVA_16: { baseCents: 5690, ivaCents: 910 },
      IVA_0: { baseCents: 0, ivaCents: 0 },
    })
  })

  it('🔴 ya no queda nada en ninguna tasa: lo de más se reparte con lo vendido, no se pierde, y se marca aproximada', () => {
    const partes = libroDeLaOrden(cafeYGrano, [venta('p1', 216), devolucion('r1', 216), devolucion('r2', 10)])
    const r2 = partes.get('r2')!
    expect(r2.netCents + r2.taxCents).toBe(-1000)
    expect(r2.aproximada).toBe(true)
  })

  it('🔴 Review Focus 2 · un artículo con descuento devuelto completo ($100 de uno que cobró $80): $80 de su tasa, $20 de lo que queda', () => {
    const conDescuento = mezclaDeLaOrden([L(), G()], {
      discountAmount: 20,
      orderDiscounts: [{ amount: 20, reparto: dirigido({ 'oi-grano': 2000 }) }],
    })
    const partes = libroDeLaOrden(conDescuento, [
      venta('p1', 196),
      devolucion('r1', 100, porArticulos([{ orderItemId: 'oi-grano', quantity: 1, amountCents: 10000 }])),
    ])
    expect(partes.get('r1')).toMatchObject({
      porTratamiento: { IVA_0: { baseCents: -8000, ivaCents: 0 }, IVA_16: { baseCents: -1724, ivaCents: -276 } },
      aproximada: true,
    })
    expect(suma(partes.values()).porTratamiento).toEqual({
      IVA_16: { baseCents: 8276, ivaCents: 1324 },
      IVA_0: { baseCents: 0, ivaCents: 0 },
    })
  })

  it('🔴 Codex r2 N2 · devolver UNA de dos unidades con descuento: su tope es lo que cobró esa unidad ($80); lo de más, de lo que queda', () => {
    const dos = mezclaDeLaOrden([L(), G({ quantity: 2, unitPrice: 100, total: 200 })], {
      discountAmount: 40,
      orderDiscounts: [{ amount: 40, reparto: dirigido({ 'oi-grano': 4000 }) }],
    })
    // Lo que escribe issueRefund por una unidad: la mitad del bruto del renglón ($100).
    const unidad = porArticulos([{ orderItemId: 'oi-grano', quantity: 1, amountCents: 10000 }])
    const partes = libroDeLaOrden(dos, [venta('p1', 276), devolucion('r1', 100, unidad), devolucion('r2', 100, unidad)])
    // r1: $80 del 0 % y los $20 de más en proporción a lo que queda (café 11600 · la otra unidad 8000): 1184 del café, 816 del grano.
    // (La v2 restaba los $100 del 0 % y dejaba el IVA en $16.00.)
    expect(partes.get('r1')).toEqual({
      netCents: -9837,
      taxCents: -163,
      taxByRate: { '0.16': -163 },
      porTratamiento: { IVA_16: { baseCents: -1021, ivaCents: -163 }, IVA_0: { baseCents: -8816, ivaCents: 0 } },
      aproximada: true,
    })
    // r2 (puede caer en otro mes): al 0 % le quedan 7184 (su segunda unidad menos lo que ya salió); lo demás, del café.
    expect(partes.get('r2')).toMatchObject({
      porTratamiento: { IVA_16: { baseCents: -2428, ivaCents: -388 }, IVA_0: { baseCents: -7184, ivaCents: 0 } },
      aproximada: true,
    })
    // Queda del café $76: cada devolución llevó el IVA de su monto (respuesta 11, respuesta 12), así que dice 6551 + 1049 y no
    // B(7600) = 6552 + 1048.
    expect(suma(partes.values()).porTratamiento).toEqual({
      IVA_16: { baseCents: 6551, ivaCents: 1049 },
      IVA_0: { baseCents: 0, ivaCents: 0 },
    })
  })

  it('🔴 Codex r3 R3-1 · cuatro devoluciones de 4 ¢ de una venta de 16 ¢: ninguna suma IVA, ninguna tasa queda negativa, y llegan a cero', () => {
    const partes = libroDeLaOrden(mezclaDeLaOrden([L({ unitPrice: 0.16, total: 0.16 })]), [
      venta('p1', 0.16),
      ...[1, 2, 3, 4].map(k => devolucion(`r${k}`, 0.04)),
    ])
    // El IVA de su monto (1 ¢) mientras queda IVA; después, 0. La v3 llegaba a IVA −1 y la última devolución SUMABA +1, que en otro mes
    // es IVA positivo por devolver dinero.
    expect([1, 2, 3, 4].map(k => partes.get(`r${k}`)!.porTratamiento.IVA_16)).toEqual([
      { baseCents: -3, ivaCents: -1 },
      { baseCents: -3, ivaCents: -1 },
      { baseCents: -4, ivaCents: 0 },
      { baseCents: -4, ivaCents: 0 },
    ])
    expect(suma(partes.values()).porTratamiento.IVA_16).toEqual({ baseCents: 0, ivaCents: 0 })
  })

  it('🔴 T3 M1 (revisión final) · tras devolver de más y volver a cobrar, ninguna devolución suma IVA: su base absorbe el monto', () => {
    // La secuencia del fuzz del revisor de la T3: antes de acotar el tope en 0, la última devolución daba IVA_16 { base −5, iva +1 }.
    const comp = mezclaDeLaOrden([
      G({ unitPrice: 1.8, total: 1.8 }),
      L({ unitPrice: 2.42, total: 2.42 }),
      L({ id: 'oi-ocho', unitPrice: 0.52, total: 0.52, product: { taxRate: 0.08, ivaTratamiento: 'IVA_8' } }),
    ])
    const movimientos = [venta('p1', 0.25), devolucion('r1', 0.34), devolucion('r2', 0.09), venta('p2', 0.24), devolucion('r3', 0.09)]
    const partes = libroDeLaOrden(comp, movimientos)
    for (const [r, cents] of [
      ['r1', 34],
      ['r2', 9],
      ['r3', 9],
    ] as const) {
      const parte = partes.get(r)!
      for (const v of Object.values(parte.porTratamiento)) expect(v!.ivaCents).toBeLessThanOrEqual(0)
      expect(parte.netCents + parte.taxCents).toBe(-cents) // base + IVA = lo devuelto: no se pierde ni se inventa dinero
    }
    expect(partes.get('r3')!.porTratamiento.IVA_16).toEqual({ baseCents: -4, ivaCents: 0 })
  })

  it('🔴 T3 M1, su hermano · tras devolver de más, un ajuste de Uber que vacía su tasa tampoco suma IVA: va tal cual, no «se lleva lo anotado»', () => {
    // Diez devoluciones de 4 ¢ sobre un cobro de 4 ¢ anotan 1 ¢ de IVA cada una (lo de más); el cobro siguiente deja el 16 % en
    // { base 13, iva −3 } con saldo 10. La regla B («se lleva lo anotado») le devolvía +3 de IVA.
    const movimientos = [
      venta('p1', 0.04),
      ...Array.from({ length: 10 }, (_, k) => devolucion(`d${k}`, 0.04)),
      venta('p2', 0.46),
      devolucion('uber', 0.1, congelado({ IVA_16: { baseCents: 10, ivaCents: 0 } })),
    ]
    const uber = libroDeLaOrden(mezclaDeLaOrden([L()]), movimientos).get('uber')!
    expect(uber.porTratamiento.IVA_16!.ivaCents).toBeLessThanOrEqual(0)
    expect(uber.porTratamiento.IVA_16!.baseCents).toBeLessThanOrEqual(0)
    expect(uber.netCents + uber.taxCents).toBe(-10)
    expect(uber.aproximada).toBe(true) // devolver de más es un dato roto: se hereda
  })

  it('🔴 Codex r2 N1 · venta $150, manual de $75 y ajuste de Uber de $75 (congelado 64.65 + 10.35), en los dos órdenes: cero, y el congelado tal cual', () => {
    const todo16 = mezclaDeLaOrden([L({ unitPrice: 75, total: 75 }), L({ id: 'oi-torta', unitPrice: 75, total: 75 })])
    const ajuste = congelado({ IVA_16: { baseCents: 6465, ivaCents: 1035 } }) // lo que congela la conciliación (reconciliacionDinero.test.ts:345)
    const manual = devolucion('r-m', 75)
    const deUber = devolucion('r-a', 75, ajuste)
    for (const orden of [
      [manual, deUber],
      [deUber, manual],
    ]) {
      const partes = libroDeLaOrden(todo16, [venta('p1', 150), ...orden])
      expect(partes.get('r-a')!.porTratamiento).toEqual({ IVA_16: { baseCents: -6465, ivaCents: -1035 } })
      expect(partes.get('r-m')!.porTratamiento).toEqual({ IVA_16: { baseCents: -6466, ivaCents: -1034 } })
      expect(suma(partes.values())).toEqual({ porTratamiento: { IVA_16: { baseCents: 0, ivaCents: 0 } }, taxCents: 0 })
    }
  })

  it('🔴 respuesta 8 (regla B) · un congelado que vacía su tasa con otro reparto de centavos: mismo bruto, se lleva lo anotado', () => {
    // La conciliación congela cobro por cobro: 3334 + 3334 + 3333 de base y 533 × 3 de IVA = 10001 / 1599. El libro anotó 10000 / 1600.
    const ajuste = congelado({ IVA_16: { baseCents: 10001, ivaCents: 1599 } })
    const partes = libroDeLaOrden(mezclaDeLaOrden([L()]), [
      venta('p1', 38.67),
      venta('p2', 38.67),
      venta('p3', 38.66),
      devolucion('r1', 116, ajuste),
    ])
    expect(partes.get('r1')).toMatchObject({ netCents: -10000, taxCents: -1600, aproximada: false })
    expect(suma(partes.values())).toEqual({ porTratamiento: { IVA_16: { baseCents: 0, ivaCents: 0 } }, taxCents: 0 })
  })

  it('🔴 un artículo conocido y otro que no está: toda la devolución va por importe y se marca aproximada', () => {
    const partes = libroDeLaOrden(cafeYGrano, [
      venta('p1', 216),
      devolucion(
        'r1',
        100,
        porArticulos([
          { orderItemId: 'oi-grano', quantity: 1, amountCents: 5000 },
          { orderItemId: 'oi-x', quantity: 1, amountCents: 5000 },
        ]),
      ),
    ])
    expect(partes.get('r1')).toMatchObject({
      porTratamiento: { IVA_16: { baseCents: -4629, ivaCents: -741 }, IVA_0: { baseCents: -4630, ivaCents: 0 } },
      aproximada: true,
    })
  })

  it('control: dos artículos de dos tasas en la misma proporción que lo vendido (la mezcla daría lo mismo)', () => {
    const partes = libroDeLaOrden(cafeYGrano, [
      venta('p1', 216),
      devolucion(
        'r1',
        216,
        porArticulos([
          { orderItemId: 'oi-cafe', quantity: 1, amountCents: 11600 },
          { orderItemId: 'oi-grano', quantity: 1, amountCents: 10000 },
        ]),
      ),
    ])
    expect(suma(partes.values()).porTratamiento).toEqual({ IVA_16: { baseCents: 0, ivaCents: 0 }, IVA_0: { baseCents: 0, ivaCents: 0 } })
  })

  it('Review Focus 4 · forma vieja (`amount` en pesos, sin cantidad) que suma más que la devolución: se reparte DENTRO de lo devuelto, sin aproximar', () => {
    const partes = libroDeLaOrden(cafeYGrano, [
      venta('p1', 216),
      devolucion('r1', 50, porArticulos([{ orderItemId: 'oi-grano', amount: 100 }])),
    ])
    expect(partes.get('r1')).toMatchObject({ porTratamiento: { IVA_0: { baseCents: -5000, ivaCents: 0 } }, aproximada: false })
  })

  it('control: el ajuste del proveedor con reparto congelado da exactamente ese reparto', () => {
    const ajuste = {
      ...congelado({ IVA_16: { baseCents: 10000, ivaCents: 1600 } }),
      refundedItems: [{ orderItemId: 'oi-grano', quantity: 1, amountCents: 11600 }],
    }
    expect(libroDeLaOrden(cafeYGrano, [venta('p1', 216), devolucion('r1', 116, ajuste)]).get('r1')).toEqual({
      netCents: -10000,
      taxCents: -1600,
      taxByRate: { '0.16': -1600 },
      porTratamiento: { IVA_16: { baseCents: -10000, ivaCents: -1600 } },
      aproximada: false,
    })
  })

  it('🔴 Codex r3 R3-3 · con un solo IVA, un artículo que no está no es aproximado (todo cae en su tasa); un ajuste sin reparto válido SÍ', () => {
    const todo16 = mezclaDeLaOrden([L(), L({ id: 'oi-pan', unitPrice: 58, total: 58 })])
    const partes = libroDeLaOrden(todo16, [
      venta('p1', 174),
      devolucion('r1', 58, porArticulos([{ orderItemId: 'oi-x', amountCents: 5800 }])),
      devolucion('r2', 10, { provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: 'x' }),
    ])
    // r2: no se sabe qué IVA declaró el proveedor, aunque la tasa sea una sola (la v3 lo pedía `false`, contra su propia regla).
    expect([partes.get('r1')!.aproximada, partes.get('r2')!.aproximada]).toEqual([false, true])
  })
})

describe('B4b · lo que no se sabe nunca pasa por exacto (Codex r2 N8)', () => {
  it('🔴 la incertidumbre se hereda: tras una devolución aproximada, la siguiente por importe también lo es (aunque caiga en otro mes)', () => {
    const partes = libroDeLaOrden(cafeYGrano, [
      venta('p1', 216),
      devolucion('r1', 100, porArticulos([{ orderItemId: 'oi-x', quantity: 1, amountCents: 10000 }])),
      devolucion('r2', 50),
    ])
    expect(partes.get('r1')!.aproximada).toBe(true)
    expect(partes.get('r2')).toMatchObject({
      porTratamiento: { IVA_16: { baseCents: -2315, ivaCents: -370 }, IVA_0: { baseCents: -2315, ivaCents: 0 } },
      aproximada: true,
    })
  })

  it('🔴 una composición aproximada no se descarta aunque le quede una sola tasa (renglón roto)', () => {
    const rota = mezclaDeLaOrden([L(), G({ total: 30, discountAmount: 50 })])
    expect(rota.mezcla).toHaveLength(1)
    expect(libroDeLaOrden(rota, [venta('p1', 116)]).get('p1')!.aproximada).toBe(true)
  })

  it('🔴 ruling T2-I1 · una composición VACÍA y aproximada (su única tasa quedó recortada a 0) va al 16 % como el importe libre, pero aproximada; y su devolución también', () => {
    const vacia = mezclaDeLaOrden([L({ total: 30, discountAmount: 50 })])
    expect(vacia).toMatchObject({ mezcla: [], aproximada: true })
    const partes = libroDeLaOrden(vacia, [venta('p1', 30), devolucion('r1', 10)])
    expect(partes.get('p1')).toEqual({ ...desglosePorTratamiento(3000, []), aproximada: true })
    expect(partes.get('r1')).toEqual({
      netCents: -862,
      taxCents: -138,
      taxByRate: { '0.16': -138 },
      porTratamiento: { IVA_16: { baseCents: -862, ivaCents: -138 } },
      aproximada: true,
    })
  })

  it('🔴 T3-I1 · una composición vacía cuya ÚNICA línea es al 0 % (rota) va a SU tasa, no al 16 %: sin IVA inventado, aproximada; y su devolución también', () => {
    const rota = mezclaDeLaOrden([G({ total: 30, discountAmount: 50 })])
    expect(rota).toMatchObject({ mezcla: [], aproximada: true })
    expect(rota.renglones).toEqual([expect.objectContaining({ tratamiento: 'IVA_0', tasa: 0 })])
    const partes = libroDeLaOrden(rota, [venta('p1', 30), devolucion('r1', 30)])
    expect(partes.get('p1')).toEqual({
      netCents: 3000,
      taxCents: 0,
      taxByRate: {},
      porTratamiento: { IVA_0: { baseCents: 3000, ivaCents: 0 } },
      aproximada: true,
    })
    expect(partes.get('r1')).toEqual({
      netCents: -3000,
      taxCents: 0,
      taxByRate: {},
      porTratamiento: { IVA_0: { baseCents: -3000, ivaCents: 0 } },
      aproximada: true,
    })
    // Lo mismo con una línea exenta: su cobro no se pasa al 16 %.
    const exenta = mezclaDeLaOrden([S({ total: 30, discountAmount: 50 })])
    expect(exenta).toMatchObject({ mezcla: [], aproximada: true })
    expect(libroDeLaOrden(exenta, [venta('p1', 30)]).get('p1')).toEqual({
      netCents: 3000,
      taxCents: 0,
      taxByRate: {},
      porTratamiento: { EXENTO: { baseCents: 3000, ivaCents: 0 } },
      aproximada: true,
    })
  })

  it('control — renglones de DOS tratamientos, todos recortados a 0 (mezcla vacía): no consta a qué tasa va, sigue al 16 % y aproximada', () => {
    const rotos = mezclaDeLaOrden([G({ total: 30, discountAmount: 50 }), L({ total: 30, discountAmount: 50 })])
    expect(rotos).toMatchObject({ mezcla: [], aproximada: true })
    expect(rotos.renglones).toHaveLength(2)
    expect(libroDeLaOrden(rotos, [venta('p1', 30)]).get('p1')).toEqual({ ...desglosePorTratamiento(3000, []), aproximada: true })
  })

  it('control: el importe libre de verdad (sin renglones y exacto) sigue al 16 %, como hoy', () => {
    const libre = mezclaDeLaOrden([])
    expect(libre).toEqual({ mezcla: [], renglones: [], aproximada: false })
    expect(libroDeLaOrden(libre, [venta('p1', 99.99)]).get('p1')).toEqual({ ...desglosePorTratamiento(9999, []), aproximada: false })
  })

  it('🔴 un ajuste del proveedor SIN reparto válido se reparte por lo que queda y se cuenta', () => {
    const partes = libroDeLaOrden(cafeYGrano, [
      venta('p1', 216),
      devolucion('r1', 116, { provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: 'x' }),
    ])
    expect(partes.get('r1')).toMatchObject({
      porTratamiento: { IVA_16: { baseCents: -5371, ivaCents: -859 }, IVA_0: { baseCents: -5370, ivaCents: 0 } },
      aproximada: true,
    })
  })

  it('🔴 respuesta 13 · un congelado de una tasa que la orden no vendió (16 % en una orden de puro 0 %) va por lo que queda, y se cuenta', () => {
    const partes = libroDeLaOrden(mezclaDeLaOrden([G()]), [
      venta('p1', 100),
      devolucion('r1', 50, congelado({ IVA_16: { baseCents: 4310, ivaCents: 690 } })),
    ])
    // Tal cual dejaría el 16 % en base −43.10 e IVA −6.90 (la v3 lo hacía).
    expect(partes.get('r1')).toMatchObject({ porTratamiento: { IVA_0: { baseCents: -5000, ivaCents: 0 } }, aproximada: true })
  })

  it('🔴 respuesta 13 · un congelado que pide más IVA del que le queda a su tasa va por lo que queda, y se cuenta', () => {
    const partes = libroDeLaOrden(mezclaDeLaOrden([L()]), [
      venta('p1', 116),
      devolucion('r1', 50, congelado({ IVA_16: { baseCents: 3000, ivaCents: 2000 } })),
    ])
    expect(partes.get('r1')).toMatchObject({ porTratamiento: { IVA_16: { baseCents: -4310, ivaCents: -690 } }, aproximada: true })
  })

  it('🔴 Codex r4 R4-1 · el congelado que no cabe va por lo que QUEDA y nunca vuelve a usar sus artículos (la forma que escribe Uber)', () => {
    // Café $116 al 16 % y dos granos de $50 al 0 %. Manual: un grano ($50). Uber retira el renglón del grano: $100, con sus
    // refundedItems (deliveryReconciliation.service.ts:434), y congela café 19.95 + 3.20 y grano 76.85: al grano sólo le quedan $50.
    const comp = mezclaDeLaOrden([L(), G({ quantity: 2, unitPrice: 50, total: 100 })])
    const ajuste = {
      ...congelado({ IVA_16: { baseCents: 1995, ivaCents: 320 }, IVA_0: { baseCents: 7685, ivaCents: 0 } }),
      refundedItems: [{ orderItemId: 'oi-grano', quantity: 2, amountCents: 10000 }],
    }
    const partes = libroDeLaOrden(comp, [
      venta('p1', 216),
      devolucion('r1', 50, porArticulos([{ orderItemId: 'oi-grano', quantity: 1, amountCents: 5000 }])),
      devolucion('r2', 100, ajuste),
    ])
    // Por lo que queda (café 11600 · grano 5000): 69.88 del café y 30.12 del grano ⇒ IVA 9.64. Con sus artículos daría 6.90.
    expect(partes.get('r2')).toEqual({
      netCents: -9036,
      taxCents: -964,
      taxByRate: { '0.16': -964 },
      porTratamiento: { IVA_16: { baseCents: -6024, ivaCents: -964 }, IVA_0: { baseCents: -3012, ivaCents: 0 } },
      aproximada: true,
      congeladoRechazado: true,
    })
  })

  it('🔴 Codex r4 R4-3 · devolver más de lo cobrado se cuenta también con una sola tasa', () => {
    const partes = libroDeLaOrden(mezclaDeLaOrden([L()]), [venta('p1', 116), devolucion('r1', 116), devolucion('r2', 10)])
    expect(partes.get('r2')).toMatchObject({ porTratamiento: { IVA_16: { baseCents: -862, ivaCents: -138 } }, aproximada: true })
  })

  it('🔴 Codex r3 R3-3 · mayo deja el saldo estimado; en junio, el congelado que vacía el 16 % consume lo anotado (regla B) y también es aproximado', () => {
    const partes = libroDeLaOrden(cafeYGrano, [
      venta('p1', 216),
      devolucion('r1', 100, porArticulos([{ orderItemId: 'oi-x', quantity: 1, amountCents: 10000 }])), // mayo: va por importe, aproximada
      devolucion('r2', 62.3, congelado({ IVA_16: { baseCents: 5369, ivaCents: 861 } })), // junio: vacía los $62.30 que quedan del 16 %
    ])
    // Al 16 % le quedaban base 53.71 + IVA 8.59 (estimados en mayo). La regla B se los lleva: −8.59, no el −8.61 congelado.
    expect(partes.get('r2')).toMatchObject({ porTratamiento: { IVA_16: { baseCents: -5371, ivaCents: -859 } }, aproximada: true })
  })
})

describe('B4b · la garantía frente a las notas de crédito, en su dominio (respuesta 12; fallo 6 de la ronda 6; Codex r4 R4-5, r5 R5-7)', () => {
  /** «La nota» de una devolución: el IVA de su monto (splitIvaIncluded). */
  const notaDe = (q: number, tasa: number) => q - Math.round(q / (1 + tasa))

  it('🔴 la primera devolución de una tasa lleva el IVA de su monto, y tras k devoluciones la diferencia acumulada es a lo más ⌊k/2⌋ ¢', () => {
    // El dominio: devoluciones MANUALES POR IMPORTE después del cobro, sin pasar de lo cobrado. Todas las secuencias de hasta 4 sobre
    // ventas de 1 a 20 ¢, al 16 % y al 8 %. La demostración está arriba; el prototipo llegó a 60 ¢ y 6 devoluciones.
    let secuencias = 0
    const recorrer = (tasa: number, venta: number, devoluciones: number[]) => {
      const pagado = devoluciones.reduce((s, q) => s + q, 0)
      if (devoluciones.length > 0) {
        secuencias += 1
        const producto =
          tasa === 0.16 ? { taxRate: 0.16, ivaTratamiento: 'IVA_16' as const } : { taxRate: 0.08, ivaTratamiento: 'IVA_8' as const }
        const libro = abrirLibro(mezclaDeLaOrden([L({ unitPrice: venta / 100, total: venta / 100, product: producto })]))
        libro.registrar({ id: 'v', type: 'REGULAR', amountCents: venta })
        let diferencia = 0
        devoluciones.forEach((q, k) => {
          // Codex r5 R5-12: `0 − x`, no `−x`: una devolución sin IVA daría −0 y Jest distingue −0 de 0.
          const iva =
            0 - libro.registrar({ id: `r${k}`, type: 'REFUND', amountCents: -q, processorData: { provenance: 'MANUAL' } }).taxCents
          if (k === 0) expect(iva).toBe(notaDe(q, tasa)) // la primera, siempre su nota
          diferencia += notaDe(q, tasa) - iva
          expect(Math.abs(diferencia)).toBeLessThanOrEqual(Math.floor((k + 1) / 2))
        })
      }
      if (devoluciones.length === 4) return
      for (let q = 1; q <= venta - pagado; q++) recorrer(tasa, venta, [...devoluciones, q])
    }
    for (const tasa of [0.16, 0.08]) for (let venta = 1; venta <= 20; venta++) recorrer(tasa, venta, [])
    expect(secuencias).toBeGreaterThan(50_000)
  })

  it('🔴 Codex r4 R4-5 · $1.16 devuelto en 16 de 4 ¢ y una de 52 ¢: 7 ¢ de diferencia con las notas (no «un centavo»), dentro de la cota de 8', () => {
    const partes = libroDeLaOrden(mezclaDeLaOrden([L({ unitPrice: 1.16, total: 1.16 })]), [
      venta('p1', 1.16),
      ...Array.from({ length: 16 }, (_, k) => devolucion(`r${k}`, 0.04)),
      devolucion('final', 0.52),
    ])
    expect(partes.get('final')!.porTratamiento.IVA_16).toEqual({ baseCents: -52, ivaCents: 0 }) // su nota diría 7
    const ivaDevuelto = -[...partes.values()].reduce((s, p) => s + (p.taxCents < 0 ? p.taxCents : 0), 0)
    expect(ivaDevuelto).toBe(16) // = el IVA de la venta: devolver todo deja cero; las 17 notas sumarían 16 × 1 + 7 = 23
  })

  it('🔴 en una orden de DOS tasas (16 % y 8 %), la garantía vale tasa por tasa, con k = las devoluciones que tocaron esa tasa', () => {
    // La devolución por importe se reparte por lo que queda de cada tasa; cada tasa ve su propia secuencia de montos.
    const ocho = { taxRate: 0.08, ivaTratamiento: 'IVA_8' as const }
    let comparaciones = 0 // que la prueba compare de verdad: con partes vacías el `continue` saltaría todo
    for (let a = 1; a <= 8; a++) {
      for (let b = 1; b <= 8; b++) {
        const recorrer = (devoluciones: number[]) => {
          if (devoluciones.length > 0) {
            const libro = abrirLibro(
              mezclaDeLaOrden([
                L({ unitPrice: a / 100, total: a / 100 }),
                L({ id: 'oi-8', unitPrice: b / 100, total: b / 100, product: ocho }),
              ]),
            )
            libro.registrar({ id: 'v', type: 'REGULAR', amountCents: a + b })
            const tasas = { IVA_16: { tasa: 0.16, k: 0, diferencia: 0 }, IVA_8: { tasa: 0.08, k: 0, diferencia: 0 } }
            devoluciones.forEach((q, i) => {
              const parte = libro.registrar({ id: `r${i}`, type: 'REFUND', amountCents: -q, processorData: { provenance: 'MANUAL' } })
              expect(parte.netCents + parte.taxCents).toBe(0 - q) // en el dominio, la devolución sale entera de lo que queda
              for (const [t, s] of Object.entries(tasas)) {
                const p = parte.porTratamiento[t as 'IVA_16' | 'IVA_8']
                if (!p) continue
                const monto = 0 - (p.baseCents + p.ivaCents)
                comparaciones += 1
                s.k += 1
                s.diferencia += notaDe(monto, s.tasa) - (0 - p.ivaCents)
                expect(Math.abs(s.diferencia)).toBeLessThanOrEqual(Math.floor(s.k / 2))
              }
            })
          }
          if (devoluciones.length === 3) return
          const pagado = devoluciones.reduce((s, q) => s + q, 0)
          for (let q = 1; q <= a + b - pagado; q++) recorrer([...devoluciones, q])
        }
        recorrer([])
      }
    }
    expect(comparaciones).toBeGreaterThan(50_000) // medido: 51,382
  })

  it('control · fuera del dominio: el congelado de Uber lleva el reparto del proveedor y su primera devolución puede diferir de su nota', () => {
    // El contraejemplo de Codex r5 R5-7: venta de 4 ¢ (base 3, IVA 1); un congelado de 1 ¢ con base 0 e IVA 1 cabe y va tal cual.
    const parte = libroDeLaOrden(mezclaDeLaOrden([L({ unitPrice: 0.04, total: 0.04 })]), [
      venta('p1', 0.04),
      devolucion('r1', 0.01, congelado({ IVA_16: { baseCents: 0, ivaCents: 1 } })),
    ]).get('r1')!
    expect(parte.taxCents).toBe(-1)
    expect(notaDe(1, 0.16)).toBe(0) // su nota diría 0: 1 ¢ > ⌊1/2⌋ = 0. Por eso los congelados quedan fuera de la garantía.
  })
})

// Fallo 11 de la ronda 6: el documento del PAC se calcula AQUÍ, con la función CORREGIDA de B3a (con IVA incluido y sin descuento,
// traslado = max(r6(Bq·t), T − Bq)). Las cifras de los comentarios se recalcularon el 5-oct con esa función: con descuento no cambian.
describe('B4b · el libro contra la factura que la Tarea 6b ya cuadró (respuesta 6 del controlador; Codex r2, r3 R3-7, r5)', () => {
  const tasa = (t: number): TrasladoParaElPac => ({ factor: 'Tasa', tasa: t })
  const c = (precio: number, traslado: TrasladoParaElPac, descuentoCents = 0, cantidad = 1): ConceptoParaElPac => ({
    precio: new Prisma.Decimal(String(precio)),
    cantidad,
    descuentoCents,
    ivaIncluido: true,
    traslado,
  })
  const factura = (cs: ConceptoParaElPac[], cobrado: number) => {
    const r = cuadrarConElPac(cs, cobrado, { desbloqueado: false })
    if (!r.ok) throw new Error(r.motivo)
    return r
  }

  it('🔴 el caso del founder ($65 con $2.50 propios: el PAC daba 62.49 y la 6b la cuadró a 62.50): el libro da su misma base e IVA', () => {
    const r = factura([c(65, tasa(0.16), 250)], 6250)
    expect(r.ajustes).toHaveLength(1) // de verdad la ajustó (descuento 250 → 249)
    const p = libroDeLaOrden(mezclaDeLaOrden([L({ unitPrice: 65, total: 65, discountAmount: 2.5 })]), [venta('p1', 62.5)]).get('p1')!
    expect({ base: p.netCents, iva: p.taxCents }).toEqual({
      base: r.documento.subtotalCents - r.documento.descuentoCents,
      iva: r.documento.ivaCents,
    }) // 5388 y 862
  })

  it('🔴 excepción delimitada · si la 6b mueve un centavo de descuento ENTRE tasas, el reporte sigue lo que cobró cada producto: un centavo de diferencia, mismo total', () => {
    const r = factura([c(10, tasa(0.16), 18), c(50, tasa(0))], 5982)
    expect(r.ajustes).toEqual([
      { indice: 0, deCents: 18, aCents: 17 },
      { indice: 1, deCents: 0, aCents: 1 },
    ])
    expect(r.documento).toEqual({ subtotalCents: 5862, descuentoCents: 16, ivaCents: 136, totalCents: 5982 })
    const p = libroDeLaOrden(mezclaDeLaOrden([L({ unitPrice: 10, total: 10, discountAmount: 0.18 }), G({ unitPrice: 50, total: 50 })]), [
      venta('p1', 59.82),
    ]).get('p1')!
    // El café cobró 9.82 ⇒ base 8.47 + IVA 1.35; el grano, 50. La factura ajustada dice IVA 1.36 y base 58.46.
    expect({ base: p.netCents, iva: p.taxCents }).toEqual({ base: 5847, iva: 135 })
    expect(p.netCents + p.taxCents).toBe(r.documento.totalCents)
  })

  it('🔴 Codex r3 R3-7 · sin ajuste y con una sola tasa también puede diferir: 20,000 × $0.01 con $0.01 de descuento (el PAC trabaja a 6 decimales)', () => {
    const r = factura([c(0.01, tasa(0.16), 1, 20000)], 19999)
    expect(r.ajustes).toEqual([]) // la 6b no movió nada
    // Con la regla corregida (con descuento no cambió): SubTotal 172.42, Descuento 0.02 (0.015821), IVA 27.59 (27.585821), Total 199.99.
    expect(r.documento).toEqual({ subtotalCents: 17242, descuentoCents: 2, ivaCents: 2759, totalCents: 19999 })
    const p = libroDeLaOrden(mezclaDeLaOrden([L({ quantity: 20000, unitPrice: 0.01, total: 200, discountAmount: 0.01 })]), [
      venta('p1', 199.99),
    ]).get('p1')!
    // El libro saca el IVA de lo cobrado: B(19999) = 17241 + 2758. Mismo total; un centavo pasa de base a IVA.
    expect({ base: p.netCents, iva: p.taxCents }).toEqual({ base: 17241, iva: 2758 })
    expect(p.netCents + p.taxCents).toBe(r.documento.totalCents)
  })

  it('🔴 fallo 11 de la ronda 6 · la misma venta SIN descuento: con la regla corregida el PAC suma exacto y coincide con el libro', () => {
    // Regla corregida: traslado = max(r6(172.42 × 0.16), 200 − 172.42) = 27.5872 e importe = 200 − 27.5872 = 172.4128. Con la regla
    // vieja (importe 172.42 + IVA 27.59) el PAC daba $200.01 y la 6b tenía que ajustar: esta prueba es también la puerta de la
    // precondición «T6b con la regla corregida».
    const r = factura([c(0.01, tasa(0.16), 0, 20000)], 20000)
    expect(r.ajustes).toEqual([])
    expect(r.documento).toEqual({ subtotalCents: 17241, descuentoCents: 0, ivaCents: 2759, totalCents: 20000 })
    const p = libroDeLaOrden(mezclaDeLaOrden([L({ quantity: 20000, unitPrice: 0.01, total: 200 })]), [venta('p1', 200)]).get('p1')!
    expect({ base: p.netCents, iva: p.taxCents }).toEqual({ base: r.documento.subtotalCents, iva: r.documento.ivaCents }) // 17241 y 2759
  })

  it('🔴 fallo 3 de la ronda 7 (Codex r6 R6-3) · control: SIN descuento también puede diferir un centavo. 3,498 × $0.01: mismo total, base e IVA cruzados, y la 6b la da por buena', () => {
    // Regla corregida: Imp 30.154999, Tr 4.825001, Base 30.156258 ⇒ el documento dice SubTotal 30.15 e IVA 4.83. El libro saca el IVA de
    // lo cobrado: B(3498) = 3016 + 482. Es lo correcto: el libro NO imita al PAC (no hay garantía de coincidencia sin descuento).
    const r = factura([c(0.01, tasa(0.16), 0, 3498)], 3498)
    expect(r.ajustes).toEqual([]) // cuadrarConElPac devuelve ok sin mover nada
    expect(r.documento).toEqual({ subtotalCents: 3015, descuentoCents: 0, ivaCents: 483, totalCents: 3498 })
    const p = libroDeLaOrden(mezclaDeLaOrden([L({ quantity: 3498, unitPrice: 0.01, total: 34.98 })]), [venta('p1', 34.98)]).get('p1')!
    expect({ base: p.netCents, iva: p.taxCents }).toEqual({ base: 3016, iva: 482 })
    expect(p.netCents + p.taxCents).toBe(r.documento.totalCents)
  })
})
