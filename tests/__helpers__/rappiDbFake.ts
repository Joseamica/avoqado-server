/**
 * Base EN MEMORIA para las pruebas del self-onboarding de Rappi, sobre el mock global de Prisma
 * (`setup.ts`): los vínculos por `storeId` y los intents por id, con sólo las operaciones que usan
 * `rappi.provisioning` y el controller del OAuth.
 *
 * 🔴 Dos cosas la hacen fiel, no complaciente (R14): `updateMany` es un CAS de verdad (sólo escribe si
 * el estado coincide), y el `$executeRaw` de resultados aplica el merge de `mezclaResultadoSql` y
 * respeta «no degradar un final» SÓLO si la sentencia trae la lista de finales. Así una prueba de
 * orden o de doble envío no puede pasar por el motivo equivocado.
 *
 * Se llama en cada `beforeEach`: reinstala las implementaciones y devuelve una base vacía.
 */
import prisma from '@/utils/prismaClient'

export type Fila = Record<string, any>
export interface DbFalsa {
  links: Map<string, Fila>
  intents: Map<string, Fila>
  /** El SQL de cada `$queryRaw`, para comprobar el `FOR UPDATE`. */
  sqlLeidos: string[]
}

const esSql = (v: any): v is { sql: string; values: unknown[] } => !!v && Array.isArray(v.values) && Array.isArray(v.strings)

export function crearDbFalsa(): DbFalsa {
  const db: DbFalsa = { links: new Map(), intents: new Map(), sqlLeidos: [] }
  const p = prisma as any
  const L = p.deliveryChannelLink
  const I = p.deliveryConnectIntent
  const porId = (id: string) => [...db.links.values()].find(f => f.id === id) as Fila
  let n = 0

  p.$queryRaw.mockReset().mockImplementation(async (s: TemplateStringsArray, storeId: string) => {
    db.sqlLeidos.push(s.join('?'))
    const f = db.links.get(storeId)
    return f ? [{ id: f.id, venueId: f.venueId, status: f.status, config: f.config ?? null }] : []
  })
  L.createMany.mockReset().mockImplementation(async ({ data }: { data: Fila[] }) => {
    let count = 0
    for (const d of data)
      if (!db.links.has(d.externalLocationId)) {
        db.links.set(d.externalLocationId, { id: `l${++n}`, config: null, ...d })
        count++
      }
    return { count }
  })
  L.update.mockReset().mockImplementation(async ({ where, data }: Fila) => Object.assign(porId(where.id), data))
  L.delete.mockReset().mockImplementation(async ({ where }: Fila) => {
    const f = porId(where.id)
    db.links.delete(f.externalLocationId)
    return f
  })
  // Una COPIA, como Prisma: quien leyó la fila no ve los CAS posteriores si no la vuelve a leer.
  I.findUnique
    .mockReset()
    .mockImplementation(async ({ where }: Fila) => (db.intents.has(where.id) ? { ...db.intents.get(where.id) } : null))
  I.updateMany.mockReset().mockImplementation(async ({ where, data }: Fila) => {
    const i = db.intents.get(where.id)
    const estados = typeof where.state === 'string' ? [where.state] : where.state.in
    if (!i || !estados.includes(i.state)) return { count: 0 }
    Object.assign(i, data)
    return { count: 1 }
  })
  p.$executeRaw.mockReset().mockImplementation(async (_s: TemplateStringsArray, ...v: unknown[]) => {
    const sqls = v.filter(esSql)
    const mezcla = sqls.find(x => x.sql.includes('jsonb_build_object'))
    const intento = db.intents.get(v.find((x): x is string => typeof x === 'string' && db.intents.has(x)) ?? '')
    if (!mezcla || !intento) return 0
    const [storeId, , json] = mezcla.values as [string, string, string]
    const finales = sqls.find(x => x.values.includes('ACTIVATED'))?.values ?? []
    const previo = intento.resultsJson?.[storeId]
    if (finales.includes(previo?.outcome)) return 0
    intento.resultsJson = { ...(intento.resultsJson ?? {}), [storeId]: { ...previo, ...JSON.parse(json) } }
    return 1
  })
  return db
}
