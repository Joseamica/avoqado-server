/**
 * Máquina de efectivo 1a · matriz A (rediseño tras la ronda 3 de Codex: D1–D4 y codex-r6 1–6). UNA decisión pura,
 * `decidirSobreElFolio`: el primer mensaje congela el folio, el primer cierre comprobado es el desenlace, lo demás sólo se agrega. Con
 * una sola PC por negocio (D3) la matriz es más chica que la de r2: quién manda × lo que el folio ya tiene × importes × desenlace ×
 * carrito × credencial revocada (recorte R1: sin vigencias por hora) × hora física × lo más que vio la PC (r6 #1) × versión del
 * gerente × importes imposibles (F5, F12).
 *
 * La matriz enumera TODAS las combinaciones y las compara contra una tabla de reglas escrita a mano (la primera que coincide manda).
 * Además: cada regla decide al menos una combinación.
 */
import {
  acumularEnLaIncidencia,
  decidirSobreElFolio,
  huellaDeLaObservacion,
  type DecisionDelFolio,
  type EstadoDelFolio,
  type PeticionSobreElFolio,
} from '@/services/cashMachine/decisionDelFolio'
import type { CierreDeLaMaquina } from '@/services/cashMachine/ventaDeLaMaquina'

const ANTES = '2026-11-20T17:59:00.000Z'
const DESPUES = '2026-11-20T18:01:00.000Z'

type Que = 'CIERRE_PC' | 'CIERRE_GERENTE' | 'DUDA'
/** `CONGELADO`: H2 (Codex servidor r5), lo congeló un cierre imposible: sin desenlace y sin duda. */
type Folio = 'NINGUNO' | 'CONGELADO' | 'SIN_DESENLACE' | 'DECIDIDO' | 'OTRA_PC'
type Caso = {
  que: Que
  folio: Folio
  importes: 'IGUALES' | 'OTROS'
  desenlace: 'IGUAL' | 'OTRO'
  carrito: 'IGUAL' | 'OTRO'
  /** Recorte R1: la credencial de la PC ya está revocada (sin vigencias por hora). */
  revocada: boolean
  /** La hora física del cierre frente a la del desenlace guardado (ANTES). */
  hora: 'MISMA' | 'OTRA' | 'SIN_HORA'
  /** r6 #1: lo más que la PC vio entrar en el folio, frente a lo que declara el gerente (15000 o 20000). */
  visto: 'NADA' | 'MENOS' | 'MAS'
  version: 'VISTA' | 'VIEJA_REPETICION' | 'VIEJA_NUEVA'
  imposible: boolean
}

const cierre = (over: Partial<CierreDeLaMaquina> = {}): CierreDeLaMaquina => ({
  outcome: 'PAGADO',
  dueCents: 10000,
  saleCents: 10000,
  tipCents: 0,
  creditCents: 15000,
  changeDispensedCents: 5000,
  occurredAtKnown: true,
  occurredAt: ANTES,
  ...over,
})

function estadoDe(c: Caso): EstadoDelFolio {
  if (c.folio === 'NINGUNO') return { folio: null, terminado: false, duda: false }
  return {
    folio: {
      deviceId: c.folio === 'OTRA_PC' ? 'pc-B' : 'pc-A',
      cartHash: 'carrito-1',
      saleShiftId: 'turno-A',
      dueCents: 10000,
      saleCents: 10000,
      tipCents: 0,
      version: 3,
      maxCreditCents: c.visto === 'NADA' ? null : c.visto === 'MENOS' ? 10000 : 25000,
      decision:
        c.folio === 'DECIDIDO'
          ? {
              cierre: cierre(),
              resolvedBy: 'MAQUINA',
              userId: 'cajera',
              vendedorPorOmision: 'cajera',
              evidence: null,
              trasRevocar: false,
              motivoSinVenta: null,
            }
          : null,
    },
    terminado: false,
    duda: c.folio === 'SIN_DESENLACE',
  }
}

function peticionDe(c: Caso): PeticionSobreElFolio {
  const importes =
    c.importes === 'IGUALES' ? { dueCents: 10000, saleCents: 10000, tipCents: 0 } : { dueCents: 11000, saleCents: 10000, tipCents: 1000 }
  const hora = c.hora === 'OTRA' ? DESPUES : c.hora === 'SIN_HORA' ? null : ANTES
  const c1 = cierre({
    ...importes,
    creditCents: c.desenlace === 'IGUAL' ? 15000 : 20000,
    changeDispensedCents: c.desenlace === 'IGUAL' ? 5000 : 9000,
    occurredAt: hora,
    occurredAtKnown: hora !== null,
  })
  const revocada = c.revocada
  const carritoRecibido = c.carrito === 'IGUAL' ? 'carrito-1' : 'carrito-2'
  const imposible = c.imposible
  if (c.que === 'CIERRE_GERENTE') {
    return {
      que: 'CIERRE',
      origen: 'GERENTE',
      cierre: c1,
      versionVista: c.version === 'VISTA' ? (c.folio === 'NINGUNO' ? 1 : 3) : 2,
      repeticion: c.version === 'VIEJA_REPETICION',
      imposible,
    }
  }
  if (c.que === 'DUDA') {
    return { que: 'DUDA', deviceId: 'pc-A', importes, carritoRecibido, turnoRecibido: 'turno-A', revocada, imposible }
  }
  return { que: 'CIERRE', origen: 'PC', deviceId: 'pc-A', cierre: c1, carritoRecibido, turnoRecibido: 'turno-A', revocada, imposible }
}

/** Recorte R1: lo que manda la PC con su credencial revocada (el gerente no está emparejado). */
const deLaPcRevocada = (c: Caso) => c.que !== 'CIERRE_GERENTE' && c.revocada
/** La hora física del cierre no es la del desenlace guardado (ANTES). */
const otraHora = (c: Caso) => c.hora !== 'MISMA'

/** La tabla de reglas, en orden: la primera que coincide manda. */
const REGLAS: Array<{ nombre: string; si: (c: Caso) => boolean; entonces: (c: Caso) => DecisionDelFolio }> = [
  {
    nombre: 'r6-4: el gerente con otra versión y una declaración nueva no escribe nada',
    si: c => c.que === 'CIERRE_GERENTE' && c.version === 'VIEJA_NUEVA',
    entonces: () => ({ accion: 'VERSION' }),
  },
  {
    nombre: 'r6 #1: el gerente (con la versión vista y una declaración nueva) no declara menos de lo que la PC ya vio entrar',
    si: c => c.que === 'CIERRE_GERENTE' && c.version !== 'VIEJA_REPETICION' && c.folio !== 'NINGUNO' && c.visto === 'MAS',
    entonces: () => ({ accion: 'MENOS_DE_LO_VISTO', creditCents: 25000 }),
  },
  {
    nombre: 'F5 y F12: importes imposibles (después de la versión del gerente, antes que todo lo demás)',
    si: c => c.imposible,
    entonces: () => ({ accion: 'IMPOSIBLE' }),
  },
  {
    nombre: 'D3: el folio de otra PC no se toca',
    si: c => c.que !== 'CIERRE_GERENTE' && c.folio === 'OTRA_PC',
    entonces: () => ({ accion: 'CONFLICTO', motivo: 'OTRA_PC' }),
  },
  {
    nombre: 'D2: otros importes que los congelados son conflicto',
    si: c => c.folio !== 'NINGUNO' && c.importes === 'OTROS',
    entonces: () => ({ accion: 'CONFLICTO', motivo: 'OTRA_EVIDENCIA' }),
  },
  {
    nombre: 'la primera duda congela el folio (H2: o abre su duda sobre lo que congeló un cierre imposible; otro carrito se anota)',
    si: c => c.que === 'DUDA' && (c.folio === 'NINGUNO' || c.folio === 'CONGELADO'),
    entonces: c => ({
      accion: 'ABRIR_DUDA',
      trasRevocar: deLaPcRevocada(c),
      discrepancia: c.folio === 'CONGELADO' && c.carrito === 'OTRO',
    }),
  },
  {
    nombre: 'r6-2: una duda nunca es desenlace: el folio contesta lo que tiene (otro carrito se anota)',
    si: c => c.que === 'DUDA',
    entonces: c => ({ accion: 'SEGUIR', discrepancia: c.carrito === 'OTRO' }),
  },
  {
    nombre: 'r6-3: otro desenlace físico después del desenlace es conflicto (nunca sustitución)',
    si: c => c.folio === 'DECIDIDO' && c.desenlace === 'OTRO',
    entonces: () => ({ accion: 'CONFLICTO', motivo: 'OTRA_EVIDENCIA' }),
  },
  {
    nombre: 'r6-1: el mismo desenlace contesta (y reanuda) lo que el folio tiene; la hora nueva o el otro carrito se anotan',
    si: c => c.folio === 'DECIDIDO',
    entonces: c => ({ accion: 'SEGUIR', discrepancia: (c.que === 'CIERRE_PC' && c.carrito === 'OTRO') || otraHora(c) }),
  },
  {
    nombre: 'el primer cierre comprobado es el desenlace (recorte R1: de una PC revocada, a cualquier hora, nunca es venta)',
    si: () => true,
    entonces: c => ({
      accion: 'ACEPTAR',
      trasRevocar: deLaPcRevocada(c),
      motivoSinVenta: deLaPcRevocada(c) ? 'PC_REVOCADA' : null,
      discrepancia: c.que === 'CIERRE_PC' && c.folio !== 'NINGUNO' && c.carrito === 'OTRO',
    }),
  },
]

const todos: Caso[] = []
for (const que of ['CIERRE_PC', 'CIERRE_GERENTE', 'DUDA'] as Que[])
  for (const folio of ['NINGUNO', 'CONGELADO', 'SIN_DESENLACE', 'DECIDIDO', 'OTRA_PC'] as Folio[])
    for (const importes of ['IGUALES', 'OTROS'] as const)
      for (const desenlace of ['IGUAL', 'OTRO'] as const)
        for (const carrito of ['IGUAL', 'OTRO'] as const)
          for (const revocada of [false, true])
            for (const hora of ['MISMA', 'OTRA', 'SIN_HORA'] as const)
              for (const visto of ['NADA', 'MENOS', 'MAS'] as const)
                for (const version of ['VISTA', 'VIEJA_REPETICION', 'VIEJA_NUEVA'] as const)
                  for (const imposible of [false, true])
                    todos.push({ que, folio, importes, desenlace, carrito, revocada, hora, visto, version, imposible })

describe('matriz A · decidirSobreElFolio', () => {
  it(`enumera ${todos.length} combinaciones y cada una da lo que dice la tabla`, () => {
    const malas = todos
      .map(c => {
        const esperada = REGLAS.find(r => r.si(c))!.entonces(c)
        return { c, esperada, real: decidirSobreElFolio(estadoDe(c), peticionDe(c)) }
      })
      .filter(x => JSON.stringify(x.esperada) !== JSON.stringify(x.real))
    expect(malas.slice(0, 5)).toEqual([])
  })

  it('ninguna regla de la tabla sobra (cada una decide al menos una combinación)', () => {
    const usadas = new Set(todos.map(c => REGLAS.find(r => r.si(c))!.nombre))
    expect(REGLAS.map(r => r.nombre).filter(n => !usadas.has(n))).toEqual([])
  })

  it('CONSULTA: TERMINADO > RECIBIDO > DUDA_ABIERTA > NO_EXISTE; nunca escribe ni fabrica un desenlace', () => {
    const conDesenlace = estadoDe({ que: 'CIERRE_PC', folio: 'DECIDIDO' } as Caso)
    const sinDesenlace = estadoDe({ que: 'DUDA', folio: 'SIN_DESENLACE' } as Caso)
    expect(decidirSobreElFolio({ ...conDesenlace, terminado: true }, { que: 'CONSULTA' })).toEqual({ accion: 'TERMINADO' })
    expect(decidirSobreElFolio(conDesenlace, { que: 'CONSULTA' })).toEqual({ accion: 'RECIBIDO' })
    expect(decidirSobreElFolio(sinDesenlace, { que: 'CONSULTA' })).toEqual({ accion: 'DUDA_ABIERTA' })
    expect(decidirSobreElFolio({ folio: null, terminado: false, duda: false }, { que: 'CONSULTA' })).toEqual({ accion: 'NO_EXISTE' })
  })
})

it('🔴 recorte R1: una PC revocada nunca registra venta, con hora antes, después o sin ella (r6 #3 desaparece)', () => {
  for (const occurredAt of [ANTES, DESPUES, '2026-11-20', null]) {
    const d = decidirSobreElFolio(
      { folio: null, terminado: false, duda: false },
      {
        que: 'CIERRE',
        origen: 'PC',
        deviceId: 'pc-A',
        cierre: cierre({ occurredAt, occurredAtKnown: occurredAt !== null }),
        carritoRecibido: 'carrito-1',
        turnoRecibido: 'turno-A',
        revocada: true,
      },
    )
    expect(d).toEqual({ accion: 'ACEPTAR', trasRevocar: true, motivoSinVenta: 'PC_REVOCADA', discrepancia: false })
  }
})

describe('r6-3: la huella de una observación', () => {
  const base = {
    que: 'CIERRE',
    origen: 'PC',
    deviceId: 'pc-A',
    bindingId: 'b1',
    outcome: 'GUARDADO',
    cancelMode: '2',
    dueCents: 10000,
    saleCents: 10000,
    tipCents: 0,
    creditCents: 5000,
    changeDispensedCents: 0,
    occurredAt: null,
    saleShiftId: 'turno-A',
    cartHash: 'c1',
    congelado: 'c1',
  }
  it('🔴 GUARDADO y CANCELADO con las MISMAS cifras son observaciones distintas (desenlace y modo de cancelación)', () => {
    expect(huellaDeLaObservacion(base)).not.toBe(huellaDeLaObservacion({ ...base, outcome: 'CANCELADO', cancelMode: '1' }))
  })
  it('🔴 entran el origen, el turno y el carrito recibidos, la hora física y lastSeen', () => {
    const h = huellaDeLaObservacion(base)
    for (const cambio of [
      { origen: 'GERENTE' },
      { saleShiftId: 'turno-B' },
      { cartHash: 'c2' },
      { congelado: 'c9' },
      { occurredAt: '2026-11-20T18:00:00.000Z' },
      { lastSeen: { credit: 5000 } },
    ]) {
      expect(huellaDeLaObservacion({ ...base, ...cambio })).not.toBe(h)
    }
  })
  it('no entran la hora de llegada ni quién de la sesión la mandó (dos gerentes que declaran lo mismo son una)', () => {
    expect(huellaDeLaObservacion({ ...base, recibidoEn: 'x', userId: 'a' })).toBe(
      huellaDeLaObservacion({ ...base, recibidoEn: 'y', userId: 'b' }),
    )
  })
})

describe('r6-3: la incidencia guarda la primera y la última entrega; la novedad la dice el historial', () => {
  it('la primera: versión 1, un evento, una entrega', () => {
    expect(acumularEnLaIncidencia(null, { a: 1 }, true)).toEqual({ eventos: [{ a: 1 }], veces: 1, repetidas: 0, version: 1 })
  })
  it('🔴 A–B–A: la tercera es retransmisión (ya está en el historial): cuenta, no sube la versión ni reabre', () => {
    const a = acumularEnLaIncidencia(null, { a: 1 }, true)
    const ab = acumularEnLaIncidencia(a, { b: 1 }, true)
    const aba = acumularEnLaIncidencia(ab, { a: 1 }, false)
    expect(aba).toMatchObject({ version: 2, veces: 3, repetidas: 1, eventos: [{ a: 1 }, { b: 1 }] })
  })
  it('🔴 sin tope: la observación 52 distinta sube a la versión 52 y es la última (r6-3: con 51 se perdía la penúltima)', () => {
    let p: unknown = null
    for (let i = 1; i <= 52; i++) p = acumularEnLaIncidencia(p, { i }, true)
    expect(p).toMatchObject({ version: 52, veces: 52, eventos: [{ i: 1 }, { i: 52 }] })
  })
  it('la revisión previa se conserva cuando llega evidencia nueva', () => {
    const revisada = { ...(acumularEnLaIncidencia(null, { a: 1 }, true) as object), revision: { nota: 'ok' }, revisiones: [{ nota: 'ok' }] }
    expect(acumularEnLaIncidencia(revisada, { b: 1 }, true)).toMatchObject({
      revision: { nota: 'ok' },
      revisiones: [{ nota: 'ok' }],
      version: 2,
    })
  })
})
