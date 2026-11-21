/**
 * Máquina de efectivo (rediseño r3): las tablas de la máquina —folio congelado, observaciones, incidencias, cierres y emparejamientos—
 * en memoria, sobre el `prismaMock` de siempre. Una transacción que truena deshace lo que escribió en ESTAS tablas (como Postgres), así
 * que las pruebas ven lo que de verdad quedaría: la evidencia de la primera transacción sobrevive a la venta que se revierte.
 *
 * Sólo lo que usan los servicios de `src/services/cashMachine/`: igualdad, `in`, `contains`, `lt`, `gt`, `not`, `AND`/`OR`/`NOT`, las llaves
 * compuestas (`venueId_referenceCC`…), `increment`, `deleteMany` y `select` (se ignora: se devuelve la fila entera).
 */
import { Prisma } from '@prisma/client'

type Fila = Record<string, any>
/** `Prisma.JsonNull` / `DbNull` se leen de vuelta como `null` (como en Postgres). */
const valor = (v: unknown) => (v === Prisma.JsonNull || v === Prisma.DbNull ? null : v)

export interface BaseDeLaMaquina {
  folios: Fila[]
  observaciones: Fila[]
  incidencias: Fila[]
  cierres: Fila[]
  vinculos: Fila[]
}

const LLAVES: Record<string, string[]> = {
  venueId_referenceCC: ['venueId', 'referenceCC'],
  venueId_referenceCC_kind: ['venueId', 'referenceCC', 'kind'],
  venueId_referenceCC_fingerprint: ['venueId', 'referenceCC', 'fingerprint'],
}

function coincide(fila: Fila, where: Fila | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([k, v]) => {
    if (k === 'AND') return (v as Fila[]).every(w => coincide(fila, w))
    if (k === 'OR') return (v as Fila[]).some(w => coincide(fila, w))
    if (k === 'NOT') return !coincide(fila, v as Fila)
    if (LLAVES[k]) return LLAVES[k].every(c => fila[c] === (v as Fila)[c])
    const enLaFila = fila[k]
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Fila
      if ('in' in o) return (o.in as unknown[]).includes(enLaFila)
      if ('contains' in o) return typeof enLaFila === 'string' && enLaFila.includes(o.contains)
      if ('lt' in o) return enLaFila < o.lt
      if ('gt' in o) return enLaFila > o.gt
      // `Prisma.DbNull` / `JsonNull` en un filtro valen null (como en Postgres).
      if ('not' in o) return valor(o.not) === null ? enLaFila != null : enLaFila !== o.not
      if ('equals' in o) return enLaFila === valor(o.equals)
      return false
    }
    return (enLaFila ?? null) === (v ?? null)
  })
}

let secuencia = 0
const nuevoId = (prefijo: string) => `${prefijo}-${++secuencia}`

function aplicar(fila: Fila, data: Fila): Fila {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in v) fila[k] = (fila[k] ?? 0) + (v as Fila).increment
    else fila[k] = valor(v)
  }
  fila.updatedAt = new Date()
  return fila
}

const copia = (b: BaseDeLaMaquina): BaseDeLaMaquina => structuredClone(b)

/** Un modelo en memoria sobre `tabla` (que se lee de `base` en cada llamada: la transacción puede reemplazarla). */
function modelo(
  prismaModel: Fila,
  base: () => BaseDeLaMaquina,
  tabla: keyof BaseDeLaMaquina,
  prefijo: string,
  unicas: string[][],
  defaults: Fila = {},
) {
  const filas = () => base()[tabla]
  prismaModel.findUnique.mockImplementation(async (a: Fila) => filas().find(f => coincide(f, a?.where)) ?? null)
  prismaModel.findFirst.mockImplementation(async (a: Fila) => filas().find(f => coincide(f, a?.where)) ?? null)
  prismaModel.findMany.mockImplementation(async (a: Fila) => {
    let r = filas().filter(f => coincide(f, a?.where))
    if (a?.orderBy) {
      r = [...r].sort((x, y) => {
        for (const o of [a.orderBy].flat() as Fila[]) {
          const [campo, dir] = Object.entries(o)[0] as [string, string]
          if (x[campo] < y[campo]) return dir === 'desc' ? 1 : -1
          if (x[campo] > y[campo]) return dir === 'desc' ? -1 : 1
        }
        return 0
      })
    }
    return a?.take ? r.slice(0, a.take) : r
  })
  prismaModel.count.mockImplementation(async (a: Fila) => filas().filter(f => coincide(f, a?.where)).length)
  prismaModel.create.mockImplementation(async (a: Fila) => {
    for (const campos of unicas) {
      if (filas().some(f => campos.every(c => f[c] === a.data[c]))) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
      }
    }
    const datos = Object.fromEntries(Object.entries(a.data as Fila).map(([k, v]) => [k, valor(v)]))
    const fila = { id: nuevoId(prefijo), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...datos }
    filas().push(fila)
    return fila
  })
  prismaModel.update.mockImplementation(async (a: Fila) => {
    const fila = filas().find(f => coincide(f, a.where))
    if (!fila) throw new Error(`${String(tabla)}: no existe la fila a actualizar`)
    return aplicar(fila, a.data)
  })
  prismaModel.updateMany.mockImplementation(async (a: Fila) => {
    const r = filas().filter(f => coincide(f, a.where))
    r.forEach(f => aplicar(f, a.data))
    return { count: r.length }
  })
  prismaModel.deleteMany.mockImplementation(async (a: Fila) => {
    const quedan = filas().filter(f => !coincide(f, a?.where))
    const count = filas().length - quedan.length
    filas().splice(0, filas().length, ...quedan)
    return { count }
  })
  prismaModel.upsert.mockImplementation(async (a: Fila) => {
    const fila = filas().find(f => coincide(f, a.where))
    if (fila) return aplicar(fila, a.update ?? {})
    return prismaModel.create({ data: a.create })
  })
  prismaModel.createMany.mockImplementation(async (a: Fila) => {
    let count = 0
    for (const data of [a.data].flat()) {
      try {
        await prismaModel.create({ data })
        count++
      } catch (e) {
        if (!a.skipDuplicates) throw e
      }
    }
    return { count }
  })
}

/**
 * Instala la base en memoria sobre `prismaMock` y envuelve `$transaction`: si la transacción truena, ESTAS tablas vuelven a como
 * estaban. Llamarla en cada `beforeEach` (después de `jest.clearAllMocks`).
 */
export function instalarMaquinaEnMemoria(prismaMock: any): BaseDeLaMaquina {
  const estado = { base: { folios: [], observaciones: [], incidencias: [], cierres: [], vinculos: [] } as BaseDeLaMaquina }
  const base = () => estado.base
  const folio = [LLAVES.venueId_referenceCC]
  modelo(prismaMock.cashMachineFolio, base, 'folios', 'folio', folio, { version: 1, decision: null, pedido: null, maxCreditCents: null })
  modelo(prismaMock.cashMachineObservation, base, 'observaciones', 'obs', [LLAVES.venueId_referenceCC_fingerprint])
  modelo(prismaMock.cashMachineIncident, base, 'incidencias', 'inc', [LLAVES.venueId_referenceCC_kind], {
    resolvedByStaffId: null,
    resolvedAt: null,
    deviceId: null,
  })
  modelo(prismaMock.cashMachineClose, base, 'cierres', 'close', folio, { motivoSinRegistro: null })
  modelo(prismaMock.cashMachineBinding, base, 'vinculos', 'binding', [], { active: true, revokedAt: null })
  prismaMock.$transaction.mockImplementation(async (cb: any) => {
    if (typeof cb !== 'function') return Promise.all(cb)
    const antes = copia(estado.base)
    try {
      return await cb(prismaMock)
    } catch (error) {
      // Postgres deshace la transacción: las MISMAS tablas (los arreglos se reemplazan en su lugar).
      for (const k of Object.keys(antes) as Array<keyof BaseDeLaMaquina>) estado.base[k].splice(0, estado.base[k].length, ...antes[k])
      throw error
    }
  })
  return estado.base
}
