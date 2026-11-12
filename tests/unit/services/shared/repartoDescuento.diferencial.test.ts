/**
 * W7 A1, rediseño B (decisión (ii) del founder, 12-nov): prueba DIFERENCIAL contra `origin/develop` (61125d8e0).
 *
 * - `recorteDeFila`: fuera de una cuenta LLENA (Σ filas < Σ renglones, antes del recorte) el recorte nuevo da EXACTAMENTE lo mismo que
 *   el de develop, en miles de cuentas generadas. Dentro de una llena sólo cambia un caso: un % de ámbito topado que conserva un
 *   renglón con valor se recorta en vez de retirarse.
 * - `importesDeLasFilas`: sin exceso (Σ filas re-derivadas ≤ Σ renglones) da lo mismo que develop, centavo a centavo.
 *
 * Las dos funciones de develop están copiadas TAL CUAL como oráculo (sólo cambian sus nombres); las piezas que usan no cambiaron.
 */
import {
  aCentavos,
  cuentaLlena,
  enAmbito,
  estaRegalado,
  importesDeLasFilas,
  leerReparto,
  nuevoRepartoDeCuenta,
  nuevoRepartoDirigido,
  recorteDeFila,
  seRecalculaComoPorcentajeDeCuenta,
  seRecalculaDentroDeSuAmbito,
  type FilaParaRecorte,
  type FilaParaReparto,
  type Recorte,
  type RenglonParaReparto,
  type RenglonQueCambia,
  type RepartoDescuento,
} from '@/services/shared/repartoDescuento'

// ── oráculos: develop 61125d8e0, src/services/shared/repartoDescuento.ts, copiados sin cambios ──────────────────────────────────
const aPesosRedondeados = (x: number) => Math.round(x * 100) / 100

function importesDeDevelop(
  renglones: RenglonParaReparto[],
  filas: FilaParaReparto[],
): { montosRederivados: Map<string, number>; descuento: number } {
  const suma = (lista: RenglonParaReparto[]) => lista.filter(x => !estaRegalado(x)).reduce((s, x) => s + Number(x.total ?? 0), 0)
  const baseDeCuenta = suma(renglones.filter(x => !x.orderPromotionId))
  const montosRederivados = new Map<string, number>()
  let descuento = 0
  for (const fila of filas) {
    let base: number | null = null
    if (seRecalculaComoPorcentajeDeCuenta(fila)) base = baseDeCuenta
    else if (seRecalculaDentroDeSuAmbito(fila)) {
      const ambito = leerReparto(fila.reparto)!.ambito!
      base = suma(renglones.filter(x => enAmbito(x, ambito)))
    }
    const tope = leerReparto(fila.reparto)?.tope ?? null
    if (base === null) {
      descuento += Number(fila.amount)
      continue
    }
    const calculado = aPesosRedondeados((base * Number(fila.value)) / 100)
    const monto = tope === null ? calculado : Math.min(calculado, tope)
    montosRederivados.set(fila.id, monto)
    descuento += monto
  }
  return { montosRederivados, descuento: aPesosRedondeados(descuento) }
}

function recorteDeDevelop(fila: FilaParaRecorte, renglones: RenglonQueCambia[]): Recorte {
  const salen = new Map(renglones.map(r => [r.id, r] as const))
  const monto = aCentavos(fila.amount)
  const reparto = leerReparto(fila.reparto)
  const ids = fila.appliedToItemIds ?? []
  const recortar = (quita: number, nuevoReparto: RepartoDescuento | null): Recorte =>
    quita >= monto
      ? { accion: 'RETIRAR', quitaCents: monto }
      : {
          accion: 'RECORTAR',
          quitaCents: quita,
          amountCents: monto - quita,
          appliedToItemIds: ids.filter(id => !salen.has(id)),
          reparto: nuevoReparto,
        }
  if (reparto?.alcance === 'DIRIGIDO') {
    const destinos = Object.keys(reparto.renglones)
    const tocados = destinos.filter(id => salen.has(id))
    if (tocados.length === 0) return { accion: 'NADA' }
    if (tocados.length === destinos.length) return { accion: 'RETIRAR', quitaCents: monto }
    const quedan = destinos.filter(id => !salen.has(id))
    const quita = tocados.reduce((s, id) => s + reparto.renglones[id], 0)
    return recortar(quita, { ...reparto, renglones: Object.fromEntries(quedan.map(id => [id, reparto.renglones[id]] as const)) })
  }
  if (reparto) return { accion: 'NADA' }
  if (ids.length === 1 && fila.discountId && salen.get(ids[0])?.appliedDiscountId === fila.discountId)
    return { accion: 'RETIRAR', quitaCents: monto }
  if (fila.isComp === true && fila.type === 'COMP' && !fila.discountId) {
    const tocados = ids.filter(id => salen.has(id))
    if (tocados.length === 0 || !tocados.every(id => salen.get(id)!.isCortesia)) return { accion: 'NADA' }
    if (tocados.length === ids.length) return { accion: 'RETIRAR', quitaCents: monto }
    const quita = tocados.reduce((s, id) => s + aCentavos(salen.get(id)!.discountAmount), 0)
    return recortar(quita, null)
  }
  return { accion: 'NADA' }
}

// ── generador determinista ──────────────────────────────────────────────────────────────────────────────────────────────────────
function mulberry32(semilla: number) {
  let a = semilla
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function cuentaAlAzar(azar: () => number) {
  const entero = (min: number, max: number) => min + Math.floor(azar() * (max - min + 1))
  const pesos = (maxCents: number) => entero(0, maxCents) / 100
  const n = entero(2, 5)
  const renglones: RenglonParaReparto[] = Array.from({ length: n }, (_, i) => {
    const total = azar() < 0.1 ? 0 : pesos(20000)
    const cortesia = azar() < 0.1
    const promo = azar() < 0.1 // también regalada: una promoción que después se da de cortesía
    const propio = cortesia ? total : azar() < 0.15 ? Math.min(total, pesos(5000)) : 0
    const sinProducto = azar() < 0.05 // «Otro importe»: nunca entra a un ámbito
    return {
      id: `r${i}`,
      total,
      discountAmount: propio,
      orderPromotionId: promo ? 'op' : null,
      isCortesia: cortesia,
      productId: sinProducto ? null : `p${i}`,
      product: sinProducto ? null : { categoryId: azar() < 0.6 ? 'c1' : 'c2' },
    }
  })
  const ids = renglones.map(r => r.id)
  const algunos = () => ids.filter(() => azar() < 0.6)
  const centavosPara = (lista: string[]) => Object.fromEntries(lista.map(id => [id, entero(0, 9000)] as const))
  const filas: FilaParaRecorte[] = Array.from({ length: entero(1, 4) }, (_, k) => {
    const id = `f${k}`
    const createdAt = new Date(Date.UTC(2026, 10, 1, 0, 0, k))
    const amount = pesos(15000)
    const tipo = entero(0, 6)
    const destinos = algunos().length > 0 ? algunos() : [ids[0]]
    if (tipo === 0) {
      // % de ámbito (re-derivable), a veces con tope del catálogo.
      const tope = azar() < 0.2 ? pesos(3000) : undefined
      const reparto = {
        v: 1,
        alcance: 'DIRIGIDO',
        conPromociones: null,
        espejo: false,
        renglones: centavosPara(destinos),
        ambito: { productos: [], categorias: ['c1'] },
        ...(tope !== undefined ? { tope } : {}),
      }
      return { id, type: 'PERCENTAGE', value: entero(1, 50), amount, appliedToItemIds: [], reparto, createdAt }
    }
    if (tipo === 1) {
      // Dirigida fija (premio, 2×1), a veces espejo.
      const espejo = azar() < 0.3
      return {
        id,
        type: 'FIXED_AMOUNT',
        value: amount,
        amount,
        appliedToItemIds: espejo ? destinos : [],
        reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo, renglones: centavosPara(destinos) },
        createdAt,
      }
    }
    if (tipo === 2) {
      return {
        id,
        type: azar() < 0.5 ? 'PERCENTAGE' : 'FIXED_AMOUNT',
        value: entero(1, 50),
        amount,
        appliedToItemIds: [],
        reparto: nuevoRepartoDeCuenta({
          conPromociones: azar() < 0.5,
          base: azar() < 0.3 ? destinos : null,
          tope: azar() < 0.2 ? pesos(3000) : null,
        }),
        createdAt,
      }
    }
    if (tipo === 5) {
      // Cortesía moderna de la terminal: COMP espejo con reparto, sin discountId.
      return {
        id,
        type: 'COMP',
        value: 100,
        amount,
        appliedToItemIds: destinos,
        reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: centavosPara(destinos) },
        isComp: true,
        discountId: null,
        createdAt,
      }
    }
    if (tipo === 3) {
      // Espejo viejo sin reparto ligado al descuento del renglón.
      return { id, type: 'PERCENTAGE', value: 10, amount, appliedToItemIds: [destinos[0]], reparto: null, discountId: 'd1', createdAt }
    }
    if (tipo === 4) {
      // Cortesía vieja de «Cobrar» (COMP sin discountId).
      return { id, type: 'COMP', value: 100, amount, appliedToItemIds: destinos, reparto: null, isComp: true, discountId: null, createdAt }
    }
    return {
      id,
      type: 'FIXED_AMOUNT',
      value: amount,
      amount,
      appliedToItemIds: [],
      reparto: nuevoRepartoDirigido(amount, {}, { espejo: false }),
      createdAt,
    }
  })
  if (azar() < 0.35) {
    const falta = renglones.reduce((s, r) => s + aCentavos(r.total), 0) - filas.reduce((s, f) => s + aCentavos(f.amount), 0)
    if (falta > 0)
      filas.push({
        id: 'justa',
        type: 'FIXED_AMOUNT',
        value: falta / 100,
        amount: falta / 100,
        appliedToItemIds: [],
        reparto: nuevoRepartoDeCuenta({ conPromociones: true }),
        createdAt: new Date(Date.UTC(2026, 10, 1, 0, 1, 0)),
      })
  }
  const cambian: RenglonQueCambia[] = ids
    .filter(() => azar() < 0.4)
    .map(id => {
      const r = renglones.find(x => x.id === id)!
      return {
        id,
        appliedDiscountId: azar() < 0.3 ? 'd1' : null,
        isCortesia: azar() < 0.3 || !!r.isCortesia,
        discountAmount: r.discountAmount,
      }
    })
  return {
    renglones,
    filas,
    cambian: cambian.length > 0 ? cambian : [{ id: ids[0], appliedDiscountId: null, isCortesia: false, discountAmount: 0 }],
  }
}

const CASOS = 20_000

describe('W7 A1 · diferencial contra develop (61125d8e0)', () => {
  it(`recorteDeFila: en ${CASOS.toLocaleString('es-MX')} cuentas generadas NO llenas, el recorte nuevo = el de develop, fila por fila`, () => {
    const azar = mulberry32(20261112)
    let comparadas = 0
    let llenas = 0
    for (let i = 0; i < CASOS; i++) {
      const { renglones, filas, cambian } = cuentaAlAzar(azar)
      const llena = cuentaLlena(renglones, filas)
      if (llena) {
        llenas++
        continue
      }
      for (const fila of filas) {
        expect({ caso: i, fila: fila.id, recorte: recorteDeFila(fila, cambian, { vivos: renglones, cuentaLlena: false }) }).toEqual({
          caso: i,
          fila: fila.id,
          recorte: recorteDeDevelop(fila, cambian),
        })
        comparadas++
      }
    }
    // Que el generador de verdad ejercite los dos lados.
    expect(comparadas).toBeGreaterThan(20_000)
    expect(llenas).toBeGreaterThan(100)
  })

  it(`recorteDeFila: dentro de una cuenta llena sólo cambia el % de ámbito topado con un renglón con valor; todo lo demás = develop`, () => {
    const azar = mulberry32(7)
    let distintas = 0
    let exactas = 0
    for (let i = 0; i < CASOS; i++) {
      const { renglones, filas, cambian } = cuentaAlAzar(azar)
      if (!cuentaLlena(renglones, filas)) continue
      const techo = renglones.reduce((s, r) => s + aCentavos(r.total), 0)
      if (filas.reduce((s, f) => s + aCentavos(f.amount), 0) === techo) exactas++
      for (const fila of filas) {
        const nuevo = recorteDeFila(fila, cambian, { vivos: renglones, cuentaLlena: true })
        const viejo = recorteDeDevelop(fila, cambian)
        if (JSON.stringify(nuevo) === JSON.stringify(viejo)) continue
        distintas++
        // La única diferencia permitida: develop retira y el nuevo recorta a $0 un % de ámbito.
        expect(seRecalculaDentroDeSuAmbito(fila)).toBe(true)
        expect(viejo.accion).toBe('RETIRAR')
        expect(nuevo).toMatchObject({ accion: 'RECORTAR', amountCents: 0, quitaCents: aCentavos(fila.amount) })
      }
    }
    expect(distintas).toBeGreaterThan(0)
    expect(exactas).toBeGreaterThan(1_000) // Codex r8: también cuentas EXACTAMENTE llenas, no sólo excedidas
  })

  it(`importesDeLasFilas: en ${CASOS.toLocaleString('es-MX')} cuentas generadas SIN exceso, los importes y la cabecera = develop`, () => {
    const azar = mulberry32(12112026)
    let sinExceso = 0
    for (let i = 0; i < CASOS; i++) {
      const { renglones, filas } = cuentaAlAzar(azar)
      const viejo = importesDeDevelop(renglones, filas)
      const techo = renglones.reduce((s, r) => s + aCentavos(r.total), 0)
      const suma = filas.reduce((s, f) => s + aCentavos(viejo.montosRederivados.get(f.id) ?? f.amount), 0)
      if (suma > techo) continue
      sinExceso++
      const nuevo = importesDeLasFilas(renglones, filas)
      expect({ caso: i, descuento: nuevo.descuento, montos: [...nuevo.montosRederivados] }).toEqual({
        caso: i,
        descuento: viejo.descuento,
        montos: [...viejo.montosRederivados],
      })
    }
    expect(sinExceso).toBeGreaterThan(1_000)
  })
})
