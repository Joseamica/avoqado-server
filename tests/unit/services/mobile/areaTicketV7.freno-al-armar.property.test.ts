import { AreaTicketInventoryTarget, Prisma, Unit } from '@prisma/client'

import { frenoAlArmar, type FotoParaFrenar } from '@/services/mobile/areaTicketV7.mobile.service'
import { convertUnit } from '@/utils/unitConversion'

/**
 * D5 (pizarrón hz:0555ee15:D5), prueba de PROPIEDAD con semilla fija: el freno al armar nunca es falso. Si `frenoAlArmar` rechaza,
 * la liquidación (`consumeAreaTicketReservations` + `consumeUnreservedAreaOrderInventory`, modelada aquí paso por paso) también
 * rechaza, aunque las dos lean los renglones en ÓRDENES DISTINTOS (Codex r5 y r6: la suma de cantidades con conversiones no exactas
 * g↔oz o ml↔fl oz cambia en el último de sus ~20 dígitos según el orden). Lo disponible es como lo guarda la base: 3 decimales.
 */
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)
const guardado = (v: Prisma.Decimal.Value) => D(v).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP) // numeric(12,3) de Postgres

/** Generador determinista (mulberry32). */
function semilla(s: number) {
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Un renglón: sus componentes (receta o extras del mismo insumo) en la unidad de la receta, sus piezas y si es de un vale (apartado). */
type Renglon = { componentes: string[]; piezas: number; deVale: boolean }
type Caso = {
  unidadReceta: Unit
  unidadInsumo: Unit
  renglones: Renglon[]
  ajeno: Prisma.Decimal
  existencia: Prisma.Decimal
  lotes: Prisma.Decimal
}
/** En qué orden se leen los renglones y, dentro de cada uno, sus componentes (la base no promete ninguno). */
type Orden = { renglones: number[]; componentes: number[][] }

const INSUMO = { inventoryKind: AreaTicketInventoryTarget.RAW_MATERIAL, inventoryId: 'harina' } as const
const CLAVE = `${INSUMO.inventoryKind}:${INSUMO.inventoryId}`
const natural = (caso: Caso): Orden => ({
  renglones: caso.renglones.map((_, i) => i),
  componentes: caso.renglones.map(r => r.componentes.map((_, k) => k)),
})

/** Lo que pide un renglón, como `buildUnreservedAreaOrderInventoryDemands`: cada componente convertido × piezas, sumados en orden. */
const pideElRenglon = (caso: Caso, i: number, orden: Orden) =>
  orden.componentes[i].reduce(
    (s, k) => s.add(convertUnit(D(caso.renglones[i].componentes[k]), caso.unidadReceta, caso.unidadInsumo).mul(caso.renglones[i].piezas)),
    D(0),
  )
/** El apartado de un renglón de vale, como al emitir: lo que pide (en el orden de la emisión), guardado a 3 decimales. */
const apartadoDe = (caso: Caso, i: number) => guardado(pideElRenglon(caso, i, natural(caso)))

/** La demanda sin cubrir, como el constructor: `max(0, pide − apartado)` por renglón y luego la suma, todo en el orden dado. */
function demandaEnOrden(caso: Caso, orden: Orden): Prisma.Decimal {
  let total = D(0)
  for (const i of orden.renglones) {
    const sinCubrir = Prisma.Decimal.max(D(0), pideElRenglon(caso, i, orden).sub(caso.renglones[i].deVale ? apartadoDe(caso, i) : 0))
    if (!sinCubrir.isZero()) total = total.add(sinCubrir)
  }
  return total
}

const apartadosPropios = (caso: Caso) => caso.renglones.flatMap((r, i) => (r.deVale ? [apartadoDe(caso, i)] : []))

/** La liquidación de develop, paso a paso, leyendo en `orden`: ¿rechaza? */
function liquidacionRechaza(caso: Caso, orden: Orden): boolean {
  let existencia = caso.existencia
  let lotes = caso.lotes
  for (const q of apartadosPropios(caso)) {
    // consumeRawMaterialReservation: nada que consumir (q ≤ 0) o lotes que no alcanzan ⇒ rechazo.
    if (q.lessThanOrEqualTo(0) || lotes.lessThan(q)) return true
    lotes = lotes.sub(q)
    existencia = existencia.sub(q)
  }
  const demanda = demandaEnOrden(caso, orden)
  if (demanda.isZero()) return false
  // consumeUnreservedAreaOrderInventory: existencia libre (sólo quedan ACTIVE los apartados ajenos) y lotes FIFO.
  if (existencia.sub(caso.ajeno).lessThan(demanda)) return true
  return lotes.lessThan(demanda)
}

/** El freno al armar con la foto, leyendo en `orden`. */
function armarFrena(caso: Caso, orden: Orden): boolean {
  const propios = apartadosPropios(caso)
  const demanda = demandaEnOrden(caso, orden)
  const foto: FotoParaFrenar = {
    demands: demanda.isZero() ? [] : [{ ...INSUMO, quantityBaseUnits: demanda, label: 'Harina' }],
    apartados: propios.map(q => ({ ...INSUMO, quantityBaseUnits: q })),
    existencia: new Map([[CLAVE, caso.existencia]]),
    lotes: new Map([[CLAVE, caso.lotes]]),
    activos: new Map([[CLAVE, propios.reduce((s, q) => s.add(q), D(0)).add(caso.ajeno)]]),
  }
  return frenoAlArmar(foto) !== null
}

function barajar(azar: () => number, n: number): number[] {
  const orden = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1))
    ;[orden[i], orden[j]] = [orden[j], orden[i]]
  }
  return orden
}
const ordenAlAzar = (azar: () => number, caso: Caso): Orden => ({
  renglones: barajar(azar, caso.renglones.length),
  componentes: caso.renglones.map(r => barajar(azar, r.componentes.length)),
})

function generar(azar: () => number): Caso {
  const conversiones: Array<[Unit, Unit]> = [
    [Unit.GRAM, Unit.OUNCE],
    [Unit.MILLILITER, Unit.FLUID_OUNCE],
    [Unit.OUNCE, Unit.GRAM],
  ]
  const [unidadReceta, unidadInsumo] = conversiones[Math.floor(azar() * conversiones.length)]
  // Cantidades de receta con 3 decimales, como las guarda la base (5, 11.125, 40.574…).
  const cantidad = () => (Math.floor(azar() * 60000) / 1000 + 0.001).toFixed(3)
  // La mitad de los casos de gramos → onzas son «exactos» como el de Codex r6: los componentes de un renglón suman justo un número par
  // de onzas (2 oz = 56.699 g), y al convertirlos uno por uno la suma queda en ±1e-19 según el orden.
  const exactos = unidadReceta === Unit.GRAM && unidadInsumo === Unit.OUNCE && azar() < 0.5
  const componentesExactos = () => {
    const milesimas = Math.round((2 + 2 * Math.floor(azar() * 3)) * 28349.5) // 2, 4 o 6 oz en miligramos (entero)
    const partes = 2 + Math.floor(azar() * 2)
    const cortes = Array.from({ length: partes - 1 }, () => 1 + Math.floor(azar() * (milesimas - 1))).sort((a, b) => a - b)
    return [0, ...cortes, milesimas].slice(1).map((c, k, arr) => ((c - (k === 0 ? 0 : arr[k - 1])) / 1000).toFixed(3))
  }
  const renglones: Renglon[] = Array.from({ length: 1 + Math.floor(azar() * 5) }, () => ({
    componentes: exactos ? componentesExactos() : Array.from({ length: 1 + Math.floor(azar() * 3) }, cantidad),
    piezas: exactos ? 1 : 1 + Math.floor(azar() * 3),
    deVale: exactos ? azar() < 0.8 : azar() < 0.5,
  }))
  const caso: Caso = { unidadReceta, unidadInsumo, renglones, ajeno: D(0), existencia: D(0), lotes: D(0) }
  // «Justa»: lo que la liquidación consumiría (en el orden natural), guardado a 3 decimales; luego justa, −0.001 o +0.001.
  const propios = apartadosPropios(caso).reduce((s, q) => s.add(q), D(0))
  const justa = guardado(propios.add(demandaEnOrden(caso, natural(caso))))
  const ajuste = [D(0), D('-0.001'), D('0.001')][Math.floor(azar() * 3)]
  caso.lotes = Prisma.Decimal.max(D(0), justa.add(ajuste))
  // Apartado ajeno: ninguno, uno pequeño, o uno que deja la existencia libre en negativo (el caso de Codex r6).
  const tipoDeAjeno = Math.floor(azar() * 3)
  caso.ajeno = tipoDeAjeno === 0 ? D(0) : guardado(D(Math.floor(azar() * 3000)).div(1000))
  caso.existencia = tipoDeAjeno === 2 ? caso.lotes : caso.lotes.add(caso.ajeno)
  return caso
}

describe('Vales V7 — D5: propiedad «si armar frena, la liquidación también rechaza» (semilla fija)', () => {
  it('400 casos con conversiones no exactas, 1–5 renglones y órdenes de lectura distintos', () => {
    const azar = semilla(20261120)
    let frenos = 0
    let pasan = 0
    for (let n = 0; n < 400; n++) {
      const caso = generar(azar)
      const ordenArmar = ordenAlAzar(azar, caso)
      const ordenLiquidar = ordenAlAzar(azar, caso)
      if (armarFrena(caso, ordenArmar)) {
        frenos++
        expect({ caso: n, liquidacionRechaza: liquidacionRechaza(caso, ordenLiquidar) }).toEqual({ caso: n, liquidacionRechaza: true })
      } else {
        pasan++
      }
    }
    // El generador produce de los dos: sin frenos la propiedad no probaría nada.
    expect(frenos).toBeGreaterThan(30)
    expect(pasan).toBeGreaterThan(30)
  })

  it('el caso de Codex r6: extras de 5, 11.125 y 40.574 g que apartan 2 oz, 1 oz ajena y 2 oz justas ⇒ no frena en ningún orden', () => {
    const caso: Caso = {
      unidadReceta: Unit.GRAM,
      unidadInsumo: Unit.OUNCE,
      renglones: [{ componentes: ['5', '11.125', '40.574'], piezas: 1, deVale: true }],
      ajeno: D('1.000'),
      existencia: D('2.000'),
      lotes: D('2.000'),
    }
    expect(apartadosPropios(caso).map(q => q.toFixed(3))).toEqual(['2.000'])
    for (const componentes of [
      [0, 1, 2],
      [1, 0, 2],
      [2, 1, 0],
    ]) {
      expect({ componentes, frena: armarFrena(caso, { renglones: [0], componentes: [componentes] }) }).toEqual({
        componentes,
        frena: false,
      })
    }
  })

  it('falta de verdad por 0.001 ⇒ frena (y la liquidación también rechaza)', () => {
    const caso: Caso = {
      unidadReceta: Unit.GRAM,
      unidadInsumo: Unit.GRAM,
      renglones: [{ componentes: ['100'], piezas: 1, deVale: false }],
      ajeno: D(0),
      existencia: D('99.999'),
      lotes: D('100'),
    }
    expect(armarFrena(caso, natural(caso))).toBe(true)
    expect(liquidacionRechaza(caso, natural(caso))).toBe(true)
  })
})
