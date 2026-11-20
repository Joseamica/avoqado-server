/**
 * Máquina de efectivo 1a · Codex servidor r2 (familia A: «quién puede escribir el desenlace de un folio»). Dos rondas parcharon esta
 * familia caso por caso y se volvió a romper (r2 #1, #4, #8, #9). Ahora hay UNA decisión pura, `decidirEscrituraDelFolio`, y cada
 * entrada (venta, duda, GET, resolución del gerente, revisión, repetición y la carrera P2002) la llama bajo el candado del folio.
 *
 * La matriz enumera TODAS las combinaciones (quién escribe × desenlace × motivo × lo que el folio ya tiene × su duda × la evidencia) y
 * las compara contra una tabla de reglas escrita a mano (la primera que coincide manda). Además: cada regla se usa al menos una vez.
 */
import {
  acumularEvento,
  decidirEscrituraDelFolio,
  type DecisionDelFolio,
  type EstadoDelFolio,
  type PeticionSobreElFolio,
  type QuienEscribe,
} from '@/services/cashMachine/decisionDelFolio'

const REVOCADA_EN = new Date('2026-11-20T18:00:00.000Z')
const ANTES = new Date('2026-11-20T17:59:00.000Z')
const DESPUES = new Date('2026-11-20T18:01:00.000Z')

type Quien = 'PC' | 'PC_REVOCADA_ANTES' | 'PC_REVOCADA_DESPUES' | 'PC_REVOCADA_SIN_HORA' | 'GERENTE'
type Previo = 'NINGUNO' | 'CIERRE_PROPIO' | 'CIERRE_OTRA_PC' | 'SIN_REGISTRO_PROPIO' | 'SIN_REGISTRO_OTRA_PC'
type Duda = 'NINGUNA' | 'PROPIA_ABIERTA' | 'PROPIA_CERRADA' | 'OTRA_PC'
type Evidencia = 'IGUAL' | 'OTRO_IMPORTE' | 'OTRO_CARRITO'
type Caso = {
  que: 'CIERRE' | 'DUDA' | 'CONSULTA'
  quien: Quien
  outcome: 'PAGADO' | 'CANCELADO'
  motivo: 'NINGUNO' | 'DESCUENTO'
  previo: Previo
  duda: Duda
  evidencia: Evidencia
}

const QUIENES: Quien[] = ['PC', 'PC_REVOCADA_ANTES', 'PC_REVOCADA_DESPUES', 'PC_REVOCADA_SIN_HORA', 'GERENTE']
const PREVIOS: Previo[] = ['NINGUNO', 'CIERRE_PROPIO', 'CIERRE_OTRA_PC', 'SIN_REGISTRO_PROPIO', 'SIN_REGISTRO_OTRA_PC']
const DUDAS: Duda[] = ['NINGUNA', 'PROPIA_ABIERTA', 'PROPIA_CERRADA', 'OTRA_PC']
const EVIDENCIAS: Evidencia[] = ['IGUAL', 'OTRO_IMPORTE', 'OTRO_CARRITO']

/** Lo guardado en el folio: la PC `pc-A` (o `pc-B`, otra PC), huella `h1`, carrito `c1`, $187.50 sin propina. */
const guardado = (deviceId: string) => ({ deviceId, huella: 'h1', huellaDelCarrito: 'c1', dueCents: 18750, saleCents: 18750, tipCents: 0 })

function estadoDe(c: Caso): EstadoDelFolio {
  const previoDe = (p: Previo, tipo: 'CIERRE' | 'SIN_REGISTRO') =>
    p === `${tipo}_PROPIO` ? guardado('pc-A') : p === `${tipo}_OTRA_PC` ? guardado('pc-B') : null
  return {
    cierre: previoDe(c.previo, 'CIERRE'),
    sinRegistro: previoDe(c.previo, 'SIN_REGISTRO'),
    duda:
      c.duda === 'NINGUNA'
        ? null
        : { ...guardado(c.duda === 'OTRA_PC' ? 'pc-B' : 'pc-A'), huella: null, abierta: c.duda !== 'PROPIA_CERRADA' },
  }
}

function quienDe(q: Quien): QuienEscribe {
  if (q === 'GERENTE') return { tipo: 'GERENTE', deviceId: 'pc-A' }
  return { tipo: 'PC', deviceId: 'pc-A', revocadaEn: q === 'PC' ? null : REVOCADA_EN }
}

function peticionDe(c: Caso): PeticionSobreElFolio {
  const importes = c.evidencia === 'OTRO_IMPORTE' ? { dueCents: 20000, saleCents: 20000, tipCents: 0 } : guardado('pc-A')
  // Un cierre sin pedido (CANCELADO) no lleva carrito: nada que comparar.
  const carrito = c.que === 'CIERRE' && c.outcome === 'CANCELADO' ? null : c.evidencia === 'OTRO_CARRITO' ? 'c2' : 'c1'
  const importesSolos = { dueCents: importes.dueCents, saleCents: importes.saleCents, tipCents: importes.tipCents }
  if (c.que === 'CONSULTA') return { que: 'CONSULTA' }
  if (c.que === 'DUDA') return { que: 'DUDA', quien: quienDe(c.quien), importes: importesSolos, huellaDelCarrito: carrito }
  return {
    que: 'CIERRE',
    quien: quienDe(c.quien),
    outcome: c.outcome,
    horaDelComprobante: c.quien === 'PC_REVOCADA_ANTES' ? ANTES : c.quien === 'PC_REVOCADA_SIN_HORA' ? null : DESPUES,
    evidencia: { huella: c.evidencia === 'OTRO_IMPORTE' ? 'h2' : 'h1', huellaDelCarrito: carrito },
    importes: importesSolos,
    ...(c.motivo === 'DESCUENTO' ? { motivoSinVenta: 'DESCUENTO' as const } : {}),
  }
}

type Regla = { cuando: Partial<{ [K in keyof Caso]: Caso[K] | Caso[K][] }>; esperado: DecisionDelFolio }
const coincide = (c: Caso, r: Regla) =>
  Object.entries(r.cuando).every(([k, v]) => (Array.isArray(v) ? v.includes(c[k as keyof Caso] as never) : c[k as keyof Caso] === v))

const OTRA_PC = { accion: 'CONFLICTO', motivo: 'OTRA_PC' } as const
const OTRA_EVIDENCIA = { accion: 'CONFLICTO', motivo: 'OTRA_EVIDENCIA' } as const
const PROPIOS: Previo[] = ['CIERRE_PROPIO', 'SIN_REGISTRO_PROPIO']
const AJENOS: Previo[] = ['CIERRE_OTRA_PC', 'SIN_REGISTRO_OTRA_PC']
const DISTINTA: Evidencia[] = ['OTRO_IMPORTE', 'OTRO_CARRITO']
const REVOCADAS: Quien[] = ['PC_REVOCADA_ANTES', 'PC_REVOCADA_DESPUES', 'PC_REVOCADA_SIN_HORA']

/** La especificación: la primera regla que coincide manda. Las reglas de r2 llevan su número. */
const REGLAS: Regla[] = [
  // ── CIERRE (la PC sube su cierre, o el gerente resuelve la duda) ───────────────────────────────────────────────────────────
  // Lo definitivo de OTRA PC nunca se toca ni se le contesta a ésta (r1 #4).
  { cuando: { que: 'CIERRE', previo: AJENOS }, esperado: OTRA_PC },
  // La repetición EXACTA de lo definitivo se permite, también a la PC revocada (decisión de r2).
  { cuando: { que: 'CIERRE', previo: 'CIERRE_PROPIO', evidencia: 'IGUAL' }, esperado: { accion: 'REPETIR', de: 'CIERRE' } },
  // Un cancelado no lleva carrito: con otro carrito sigue siendo la misma operación.
  {
    cuando: { que: 'CIERRE', previo: 'CIERRE_PROPIO', outcome: 'CANCELADO', evidencia: 'OTRO_CARRITO' },
    esperado: { accion: 'REPETIR', de: 'CIERRE' },
  },
  { cuando: { que: 'CIERRE', previo: 'SIN_REGISTRO_PROPIO', evidencia: 'IGUAL' }, esperado: { accion: 'REPETIR', de: 'SIN_REGISTRO' } },
  {
    cuando: { que: 'CIERRE', previo: 'SIN_REGISTRO_PROPIO', outcome: 'CANCELADO', evidencia: 'OTRO_CARRITO' },
    esperado: { accion: 'REPETIR', de: 'SIN_REGISTRO' },
  },
  // r2 #5: la misma PC con otro carrito u otros importes es OTRA operación (409 con su evidencia), nunca un 200.
  { cuando: { que: 'CIERRE', previo: PROPIOS }, esperado: OTRA_EVIDENCIA },
  // r2 #4: la duda es de OTRA PC: ni la venta ni un 202 la cierran.
  { cuando: { que: 'CIERRE', duda: 'OTRA_PC' }, esperado: OTRA_PC },
  { cuando: { que: 'CIERRE', duda: 'PROPIA_CERRADA' }, esperado: { accion: 'CONFLICTO', motivo: 'DUDA_CERRADA' } },
  // r2 #5: con duda, el cierre usa SU carrito congelado y SU reparto venta/propina.
  { cuando: { que: 'CIERRE', duda: 'PROPIA_ABIERTA', evidencia: 'OTRO_IMPORTE' }, esperado: OTRA_EVIDENCIA },
  { cuando: { que: 'CIERRE', duda: 'PROPIA_ABIERTA', outcome: 'PAGADO', evidencia: 'OTRO_CARRITO' }, esperado: OTRA_EVIDENCIA },
  // r2 #1: la PC revocada conserva `revokedAt` aunque exista su duda; el primer cierre mira la hora y queda TRAS_REVOCAR.
  {
    cuando: { que: 'CIERRE', quien: ['PC_REVOCADA_DESPUES', 'PC_REVOCADA_SIN_HORA'], outcome: 'PAGADO' },
    esperado: { accion: 'SIN_REGISTRO', motivo: 'PC_REVOCADA', trasRevocar: true },
  },
  {
    cuando: { que: 'CIERRE', quien: 'PC_REVOCADA_ANTES', outcome: 'PAGADO', motivo: 'DESCUENTO' },
    esperado: { accion: 'SIN_REGISTRO', motivo: 'DESCUENTO', trasRevocar: true },
  },
  { cuando: { que: 'CIERRE', quien: REVOCADAS }, esperado: { accion: 'REGISTRAR', trasRevocar: true } },
  {
    cuando: { que: 'CIERRE', outcome: 'PAGADO', motivo: 'DESCUENTO' },
    esperado: { accion: 'SIN_REGISTRO', motivo: 'DESCUENTO', trasRevocar: false },
  },
  { cuando: { que: 'CIERRE' }, esperado: { accion: 'REGISTRAR', trasRevocar: false } },

  // ── DUDA (la PC no sabe cómo terminó) ─────────────────────────────────────────────────────────────────────────────────────
  { cuando: { que: 'DUDA', duda: 'OTRA_PC' }, esperado: OTRA_PC },
  { cuando: { que: 'DUDA', previo: AJENOS }, esperado: OTRA_PC },
  // r1 #7: otra versión de la evidencia es 409 (y se guarda como CONFLICTO).
  { cuando: { que: 'DUDA', duda: ['PROPIA_ABIERTA', 'PROPIA_CERRADA'], evidencia: DISTINTA }, esperado: OTRA_EVIDENCIA },
  { cuando: { que: 'DUDA', previo: PROPIOS, evidencia: DISTINTA }, esperado: OTRA_EVIDENCIA },
  { cuando: { que: 'DUDA', previo: 'CIERRE_PROPIO' }, esperado: { accion: 'REPETIR', de: 'CIERRE' } },
  { cuando: { que: 'DUDA', previo: 'SIN_REGISTRO_PROPIO' }, esperado: { accion: 'REPETIR', de: 'SIN_REGISTRO' } },
  { cuando: { que: 'DUDA', duda: 'PROPIA_ABIERTA' }, esperado: { accion: 'DUDA_ABIERTA' } },
  { cuando: { que: 'DUDA', duda: 'PROPIA_CERRADA' }, esperado: { accion: 'CONFLICTO', motivo: 'DUDA_CERRADA' } },
  // La PC revocada todavía ENTREGA su duda (evidencia, nunca autoridad): queda TRAS_REVOCAR.
  { cuando: { que: 'DUDA', quien: REVOCADAS }, esperado: { accion: 'ABRIR_DUDA', trasRevocar: true } },
  { cuando: { que: 'DUDA' }, esperado: { accion: 'ABRIR_DUDA', trasRevocar: false } },

  // ── CONSULTA (GET del folio y de la duda: nunca escribe ni fabrica un desenlace, r1 #6) ───────────────────────────────────
  { cuando: { que: 'CONSULTA', previo: ['CIERRE_PROPIO', 'CIERRE_OTRA_PC'] }, esperado: { accion: 'REPETIR', de: 'CIERRE' } },
  {
    cuando: { que: 'CONSULTA', previo: ['SIN_REGISTRO_PROPIO', 'SIN_REGISTRO_OTRA_PC'] },
    esperado: { accion: 'REPETIR', de: 'SIN_REGISTRO' },
  },
  { cuando: { que: 'CONSULTA', duda: ['PROPIA_ABIERTA', 'PROPIA_CERRADA', 'OTRA_PC'] }, esperado: { accion: 'DUDA_ABIERTA' } },
  { cuando: { que: 'CONSULTA' }, esperado: { accion: 'NO_EXISTE' } },
]

function* casos(): Generator<Caso> {
  for (const previo of PREVIOS)
    for (const duda of DUDAS) {
      for (const quien of QUIENES)
        for (const outcome of ['PAGADO', 'CANCELADO'] as const)
          for (const motivo of ['NINGUNO', 'DESCUENTO'] as const)
            for (const evidencia of EVIDENCIAS) yield { que: 'CIERRE', quien, outcome, motivo, previo, duda, evidencia }
      for (const quien of QUIENES.filter(q => q !== 'GERENTE'))
        for (const evidencia of EVIDENCIAS) yield { que: 'DUDA', quien, outcome: 'PAGADO', motivo: 'NINGUNO', previo, duda, evidencia }
      yield { que: 'CONSULTA', quien: 'PC', outcome: 'PAGADO', motivo: 'NINGUNO', previo, duda, evidencia: 'IGUAL' }
    }
}

describe('decidirEscrituraDelFolio · la matriz completa (familia A)', () => {
  const todos = [...casos()]
  const usadas = new Set<number>()

  it(`enumera ${todos.length} combinaciones y cada una da lo que dice la tabla`, () => {
    // 1200 cierres + 240 dudas + 20 consultas.
    expect(todos).toHaveLength(1200 + 240 + 20)
    const fallas: string[] = []
    for (const c of todos) {
      const i = REGLAS.findIndex(r => r.cuando.que === c.que && coincide(c, r))
      expect(i).toBeGreaterThanOrEqual(0)
      usadas.add(i)
      const obtenido = decidirEscrituraDelFolio(estadoDe(c), peticionDe(c))
      // Sin importar el orden de las llaves (objetos planos).
      const canon = (o: object) => JSON.stringify(o, Object.keys(o).sort())
      if (canon(obtenido) !== canon(REGLAS[i].esperado)) {
        fallas.push(`${JSON.stringify(c)} → ${JSON.stringify(obtenido)} (esperado ${JSON.stringify(REGLAS[i].esperado)})`)
      }
    }
    expect(fallas.slice(0, 10)).toEqual([])
  })

  it('ninguna regla de la tabla sobra (cada una decide al menos una combinación)', () => {
    for (const c of todos) usadas.add(REGLAS.findIndex(r => r.cuando.que === c.que && coincide(c, r)))
    expect(REGLAS.map((_, i) => i).filter(i => !usadas.has(i))).toEqual([])
  })
})

describe('decidirEscrituraDelFolio · revisión de una incidencia (r2 #8)', () => {
  const vacio: EstadoDelFolio = { cierre: null, sinRegistro: null, duda: null }
  const REVISIONES: Array<[string, 'ABIERTO' | 'RESUELTO', number, DecisionDelFolio]> = [
    // [kind, status, versión que vio el gerente (la actual es 2), esperado]
    ['ESPERANDO', 'ABIERTO', 2, { accion: 'NO_REVISABLE' }],
    ['ESPERANDO', 'RESUELTO', 1, { accion: 'NO_REVISABLE' }],
    ['IMPOSIBLE', 'ABIERTO', 2, { accion: 'REVISAR' }],
    ['IMPOSIBLE', 'ABIERTO', 1, { accion: 'CONFLICTO', motivo: 'VERSION' }],
    ['CONFLICTO', 'RESUELTO', 2, { accion: 'REPETIR', de: 'REVISION' }],
    ['CONFLICTO', 'RESUELTO', 1, { accion: 'CONFLICTO', motivo: 'VERSION' }],
    ['NO_SE_PUDO_REGISTRAR', 'ABIERTO', 2, { accion: 'REVISAR' }],
    ['TRAS_REVOCAR', 'ABIERTO', 3, { accion: 'CONFLICTO', motivo: 'VERSION' }],
  ]
  it.each(REVISIONES)('%s %s vista v%i', (kind, status, versionVista, esperado) => {
    expect(decidirEscrituraDelFolio(vacio, { que: 'REVISION', kind, status, versionVista, versionActual: 2 })).toEqual(esperado)
  })
})

describe('acumularEvento · la evidencia de una incidencia (r2 #8)', () => {
  const ev = (n: number, recibidoEn = `2026-11-20T18:0${n % 10}:00.000Z`) => ({ cierre: { creditCents: n }, recibidoEn })

  it('la primera: versión 1, un evento, una entrega', () => {
    const { payload, nueva } = acumularEvento(null, ev(1))
    expect(nueva).toBe(true)
    expect(payload).toMatchObject({ eventos: [ev(1)], veces: 1, version: 1, repetidas: 0 })
  })

  it('🔴 una repetición IDÉNTICA (sólo cambia la hora de llegada) no es evidencia nueva: cuenta la entrega, no sube la versión ni la reabre', () => {
    const uno = acumularEvento(null, ev(1)).payload
    const { payload, nueva } = acumularEvento(uno, ev(1, '2026-11-20T19:00:00.000Z'))
    expect(nueva).toBe(false)
    expect(payload).toMatchObject({ veces: 2, version: 1, repetidas: 1 })
    expect((payload as any).eventos).toHaveLength(1)
  })

  it('🔴 después de 50 eventos se conservan el PRIMERO y el ÚLTIMO real (no el número 50)', () => {
    let p: unknown = null
    for (let n = 1; n <= 60; n++) p = acumularEvento(p, ev(n)).payload
    const eventos = (p as any).eventos as Array<{ cierre: { creditCents: number } }>
    expect(eventos).toHaveLength(50)
    expect(eventos[0].cierre.creditCents).toBe(1)
    expect(eventos[eventos.length - 1].cierre.creditCents).toBe(60)
    expect(p).toMatchObject({ veces: 60, version: 60 })
  })

  it('🔴 la revisión previa se conserva cuando llega evidencia nueva (la incidencia se reabre con su historia)', () => {
    const revisada = {
      ...(acumularEvento(null, ev(1)).payload as object),
      revision: { nota: 'visto', staffId: 'g' },
      revisiones: [{ nota: 'visto' }],
    }
    const { payload, nueva } = acumularEvento(revisada, ev(2))
    expect(nueva).toBe(true)
    expect(payload).toMatchObject({ revision: { nota: 'visto' }, revisiones: [{ nota: 'visto' }], version: 2 })
  })
})
