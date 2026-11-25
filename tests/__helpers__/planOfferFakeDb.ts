/**
 * Una base de prueba EN MEMORIA para el publicador de la oferta de planes y las listas `PLAN:*` (planes editables B1, Task 6).
 *
 * Existe para que las pruebas de carreras sean de verdad y no un eco de los mocks:
 * - **Transacciones con deshacer:** lo que escribe una transacción que lanza se revierte (sólo lo suyo, aunque otra corra a la vez).
 * - **Candados `pg_advisory_xact_lock` que esperan:** una transacción que pide un candado tomado espera a que la otra termine; los
 *   candados se sueltan al terminar la transacción (como en Postgres). Reentrantes dentro de la misma transacción.
 * - **`jsonb_set` sobre `PlanOfferVersion` con su `WHERE` literal:** la escritura se aplica sólo si la fila sigue `PREPARING` (cuando el
 *   SQL lo pide) y, para el contador de intentos, sólo si sigue en el valor esperado. Si el SQL no trae la condición, no se exige: así
 *   una prueba detecta una guarda que falta. `jsonb_set` no crea padres que falten (como Postgres): el JSON tiene que nacer completo.
 *
 * Los métodos de cada modelo se registran en `llamadas` (con el número de la transacción, `null` fuera de una) para las aserciones.
 *
 * ⚠️ LÍMITES (no es Postgres; que una prueba nueva no se apoye en esto):
 * - **El deshacer restaura la fila COMPLETA como estaba al escribir.** Si entre la escritura de una transacción y su deshacer otra
 *   escritura (fuera de transacción, «autocommit») toca la misma fila, el deshacer la borra. En Postgres esa otra escritura esperaría
 *   el candado de la fila. Las pruebas de hoy no lo hacen: cada lector espera el candado del escritor o corre después de su commit.
 * - **Sin aislamiento:** lo que una transacción escribió y aún no confirma lo ven todas las demás lecturas.
 * - **`select` se ignora:** cada lectura devuelve la fila completa (y el puntero, con sus dos versiones colgadas).
 * - **`pg_advisory_xact_lock` fuera de una transacción no espera** (ni toma nada).
 * - **`$executeRaw` reconoce las guardas por pedazos del SQL** (`"status" = 'PREPARING'`, `"col"->'k'->>?`, `'{ruta}'`, `?::jsonb`):
 *   otra forma de escribir la misma condición se trataría como ausente. Cualquier SQL que no reconoce, lanza.
 */
type Fila = Record<string, any>

const MODELOS = ['hybridCampaign', 'hybridOfferPublication', 'planOfferVersion', 'planOfferPointer', 'launchCampaign', 'feature'] as const
type Modelo = (typeof MODELOS)[number]

interface Contexto {
  id: number
  deshacer: Array<() => void>
  soltar: Array<() => void>
  tomados: Set<string>
}

/** Los `@default` del esquema que las pruebas leen (lo demás queda como lo escribe el servicio). */
const DEFAULTS: Record<Modelo, Fila> = {
  hybridCampaign: { revision: 0, currentPublicationId: null, pendingPublicationId: null, promotionGroupId: null },
  hybridOfferPublication: { stripePriceId: null, stripeProductId: null, stripeRenewalPriceId: null },
  planOfferVersion: {
    number: null,
    status: 'PREPARING',
    basedOnVersionId: null,
    hybridPublicationIds: null,
    preparacion: null,
    publishedById: null,
    publishedAt: null,
    discardedById: null,
    discardedAt: null,
  },
  planOfferPointer: { currentVersionId: null, pendingVersionId: null, revision: 0, nombresEnStripe: null },
  launchCampaign: {},
  feature: {},
}

/** Copia profunda con los `Date` del entorno de la prueba (`structuredClone` los crea en otro «realm» y `expect.any(Date)` falla). */
function copia<T>(v: T): T {
  if (v instanceof Date) return new Date(v.getTime()) as T
  if (Array.isArray(v)) return v.map(copia) as T
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copia(x)])) as T
  return v
}

function cumple(fila: Fila, where: Fila | undefined): boolean {
  for (const [campo, esperado] of Object.entries(where ?? {})) {
    // Como Prisma: un filtro `undefined` no filtra.
    if (esperado === undefined) continue
    const valor = fila[campo] ?? null
    if (esperado !== null && typeof esperado === 'object' && !(esperado instanceof Date)) {
      if ('in' in esperado) {
        if (!(esperado.in as unknown[]).includes(valor)) return false
        continue
      }
      if ('not' in esperado) {
        if (valor === (esperado.not ?? null)) return false
        continue
      }
      throw new Error(`base de prueba: filtro no soportado en ${campo}: ${JSON.stringify(esperado)}`)
    }
    if (valor !== esperado) return false
  }
  return true
}

function aplicar(fila: Fila, data: Fila): Fila {
  const nueva = { ...fila }
  for (const [campo, valor] of Object.entries(data)) {
    if (valor === undefined) continue
    if (valor !== null && typeof valor === 'object' && 'increment' in valor) nueva[campo] = (nueva[campo] ?? 0) + valor.increment
    else nueva[campo] = copia(valor)
  }
  return nueva
}

/** `jsonb_set(target, path, value)` con `create_missing = true`: crea sólo la ÚLTIMA llave; si falta un padre, no cambia nada. */
export function jsonbSet(target: unknown, ruta: string[], valor: unknown): unknown {
  if (target === null || target === undefined) return null
  const raiz = copia(target) as Fila
  let nodo: Fila = raiz
  for (const llave of ruta.slice(0, -1)) {
    if (nodo[llave] === null || typeof nodo[llave] !== 'object') return copia(target)
    nodo = nodo[llave]
  }
  nodo[ruta[ruta.length - 1]] = copia(valor)
  return raiz
}

const arregloDePostgres = (texto: string) => texto.replace(/^\{|\}$/g, '').split(',')

export function crearBaseDePrueba(prismaMock: any) {
  const tablas: Record<Modelo, Map<string, Fila>> = Object.fromEntries(MODELOS.map(m => [m, new Map<string, Fila>()])) as any
  const bitacora: Fila[] = []
  const llamadas: Array<{ tx: number | null; modelo: string; metodo: string; args: any }> = []
  /** Cada candado tomado, en orden: `{ tx, llave }`. */
  const candados: Array<{ tx: number; llave: string }> = []
  const colas = new Map<string, Promise<void>>()
  /** Qué transacción tiene cada candado AHORA. */
  const tomadosAhora = new Map<string, number>()
  /** Cada `UPDATE "PlanOfferVersion"` con `jsonb_set`: qué pidió, si se aplicó y cómo quedó la fila. */
  const historial: Array<{
    tx: number | null
    columna: string
    ruta: string[]
    valor: unknown
    aplicada: boolean
    fila: Fila | undefined
    /** Los candados que alguna transacción tenía tomados en ese momento. */
    candadosTomados: string[]
  }> = []
  const contextos = new WeakMap<object, Contexto>()
  let siguienteTx = 0
  let siguienteId = 0
  /** Lo que se puede contestar a un `groupBy` de `venueFeature` (la vista previa). */
  const gruposDeSuscripciones: Array<{ stripePriceId: string; _count: { _all: number } }> = []

  const escribir = (ctx: Contexto | null, modelo: Modelo | 'activityLog', id: string, nueva: Fila | undefined) => {
    if (modelo === 'activityLog') {
      bitacora.push(nueva!)
      ctx?.deshacer.push(() => bitacora.splice(bitacora.indexOf(nueva!), 1))
      return
    }
    const tabla = tablas[modelo]
    const previa = tabla.get(id)
    if (nueva === undefined) tabla.delete(id)
    else tabla.set(id, nueva)
    ctx?.deshacer.push(() => (previa === undefined ? tabla.delete(id) : tabla.set(id, previa)))
  }

  const conRelaciones = (modelo: Modelo, fila: Fila): Fila => {
    if (modelo !== 'planOfferPointer') return copia(fila)
    const version = (id: string | null) => (id ? (copia(tablas.planOfferVersion.get(id)) ?? null) : null)
    return { ...copia(fila), currentVersion: version(fila.currentVersionId), pendingVersion: version(fila.pendingVersionId) }
  }

  function modelo(nombre: Modelo, ctx: Contexto | null) {
    const tabla = tablas[nombre]
    const registrar = (metodo: string, args: any) => llamadas.push({ tx: ctx?.id ?? null, modelo: nombre, metodo, args: copia(args) })
    const buscar = (where: Fila | undefined) => [...tabla.values()].filter(f => cumple(f, where))
    return {
      findUnique: async (args: any) => {
        registrar('findUnique', args)
        const fila = buscar(args.where)[0]
        return fila ? conRelaciones(nombre, fila) : null
      },
      findUniqueOrThrow: async (args: any) => {
        registrar('findUniqueOrThrow', args)
        const fila = buscar(args.where)[0]
        if (!fila) throw Object.assign(new Error(`${nombre} no encontrado`), { code: 'P2025' })
        return conRelaciones(nombre, fila)
      },
      findFirst: async (args: any = {}) => {
        registrar('findFirst', args)
        const fila = buscar(args.where)[0]
        return fila ? conRelaciones(nombre, fila) : null
      },
      findMany: async (args: any = {}) => {
        registrar('findMany', args)
        const filas = buscar(args.where).map(f => conRelaciones(nombre, f))
        return args.take ? filas.slice(0, args.take) : filas
      },
      create: async (args: any) => {
        registrar('create', args)
        const id = args.data.id ?? `c${nombre.slice(0, 6).toLowerCase()}${String(++siguienteId).padStart(4, '0')}`
        const fila = { ...DEFAULTS[nombre], id, createdAt: new Date(), ...copia(args.data) }
        escribir(ctx, nombre, id, fila)
        return copia(fila)
      },
      update: async (args: any) => {
        registrar('update', args)
        const fila = buscar(args.where)[0]
        if (!fila) throw Object.assign(new Error(`${nombre} no encontrado`), { code: 'P2025' })
        const nueva = aplicar(fila, args.data)
        escribir(ctx, nombre, fila.id, nueva)
        return copia(nueva)
      },
      updateMany: async (args: any) => {
        registrar('updateMany', args)
        const filas = buscar(args.where)
        for (const fila of filas) escribir(ctx, nombre, fila.id, aplicar(fila, args.data))
        return { count: filas.length }
      },
    }
  }

  async function tomar(ctx: Contexto, llave: string) {
    if (ctx.tomados.has(llave)) return
    const previo = colas.get(llave) ?? Promise.resolve()
    let soltar!: () => void
    const mio = new Promise<void>(r => (soltar = r))
    colas.set(
      llave,
      previo.then(() => mio),
    )
    await previo
    ctx.tomados.add(llave)
    tomadosAhora.set(llave, ctx.id)
    ctx.soltar.push(() => {
      tomadosAhora.delete(llave)
      soltar()
    })
    candados.push({ tx: ctx.id, llave })
  }

  function actualizarVersion(ctx: Contexto | null, sql: string, valores: unknown[]): number {
    const columna = /SET "(\w+)"/.exec(sql)?.[1]
    if (!columna) throw new Error(`base de prueba: UPDATE sin columna: ${sql}`)
    const literal = /jsonb_set\("\w+", '\{([\w,]+)\}'/.exec(sql)
    let i = 0
    const ruta = literal ? literal[1].split(',') : arregloDePostgres(String(valores[i++]))
    const valor = /\?::jsonb/.test(sql) ? JSON.parse(String(valores[i++])) : valores[i++]
    const id = String(valores[i++])
    const fila = tablas.planOfferVersion.get(id)
    const anotar = (aplicada: boolean) => {
      historial.push({
        tx: ctx?.id ?? null,
        columna,
        ruta,
        valor,
        aplicada,
        fila: copia(tablas.planOfferVersion.get(id)),
        candadosTomados: [...tomadosAhora.keys()],
      })
      return aplicada ? 1 : 0
    }
    if (!fila) return anotar(false)
    if (sql.includes(`"status" = 'PREPARING'`) && fila.status !== 'PREPARING') return anotar(false)
    const cas = /"(\w+)"->'(\w+)'->>\?/.exec(sql)
    if (cas) {
      const clave = String(valores[i++])
      const esperado = valores[i++]
      if (fila[cas[1]]?.[cas[2]]?.[clave] !== esperado) return anotar(false)
    }
    escribir(ctx, 'planOfferVersion', id, { ...fila, [columna]: jsonbSet(fila[columna], ruta, valor) })
    return anotar(true)
  }

  function cliente(ctx: Contexto | null) {
    const c: any = Object.fromEntries(MODELOS.map(m => [m, modelo(m, ctx)]))
    c.activityLog = {
      create: async (args: any) => {
        llamadas.push({ tx: ctx?.id ?? null, modelo: 'activityLog', metodo: 'create', args: copia(args) })
        escribir(ctx, 'activityLog', '', copia(args.data))
        return { id: `log${bitacora.length}` }
      },
    }
    c.venueFeature = {
      groupBy: async (args: any) => {
        llamadas.push({ tx: ctx?.id ?? null, modelo: 'venueFeature', metodo: 'groupBy', args: copia(args) })
        const ids: string[] = args.where?.stripePriceId?.in ?? []
        return gruposDeSuscripciones.filter(g => ids.includes(g.stripePriceId)).map(g => copia(g))
      },
    }
    c.$executeRaw = async (strings: TemplateStringsArray, ...valores: unknown[]) => {
      const sql = strings.join('?')
      if (sql.includes('pg_advisory_xact_lock')) {
        if (ctx) await tomar(ctx, String(valores[0]))
        return 1
      }
      if (sql.includes('UPDATE "PlanOfferVersion"')) return actualizarVersion(ctx, sql, valores)
      throw new Error(`base de prueba: SQL no esperado: ${sql}`)
    }
    // `activeGroupsByKey` (la fila del tablero): ninguna promoción agrupada.
    c.$queryRaw = async () => []
    if (ctx) contextos.set(c, ctx)
    return c
  }

  const $transaction = async (fn: (tx: any) => Promise<unknown>) => {
    const ctx: Contexto = { id: ++siguienteTx, deshacer: [], soltar: [], tomados: new Set() }
    const tx = cliente(ctx)
    try {
      return await fn(tx)
    } catch (error) {
      for (const deshacer of ctx.deshacer.reverse()) deshacer()
      throw error
    } finally {
      for (const soltar of ctx.soltar) soltar()
    }
  }

  // El cliente de fuera de las transacciones ES el `prismaMock` que importan los servicios.
  Object.assign(prismaMock, cliente(null), { $transaction: jest.fn($transaction) })

  return {
    tablas,
    bitacora,
    historial,
    llamadas,
    candados,
    gruposDeSuscripciones,
    /** Mete una fila sin pasar por la bitácora de llamadas. */
    sembrar(nombre: Modelo, fila: Fila) {
      tablas[nombre].set(fila.id, { ...DEFAULTS[nombre], ...copia(fila) })
    },
    fila(nombre: Modelo, id: string): Fila | undefined {
      return copia(tablas[nombre].get(id))
    },
    /** ¿Alguna transacción tiene ese candado en este momento? */
    candadoTomado(llave: string): boolean {
      return tomadosAhora.has(llave)
    },
    /** Los candados que tiene tomados la transacción `tx` en este momento. */
    candadosDe(tx: object): string[] {
      return [...(contextos.get(tx)?.tomados ?? [])]
    },
    /** Las llamadas de un modelo y un método, en orden. */
    llamadasA(nombre: string, metodo: string) {
      return llamadas.filter(l => l.modelo === nombre && l.metodo === metodo)
    },
  }
}

export type BaseDePrueba = ReturnType<typeof crearBaseDePrueba>

/** Una promesa que la prueba suelta a mano (para fijar el orden de una carrera). */
export function pausa() {
  let soltar!: () => void
  const promesa = new Promise<void>(r => (soltar = r))
  return { promesa, soltar }
}

/** Deja correr todo lo que no espera a una `pausa` (la base y Stripe simulados no usan reloj ni red). */
export async function vueltas(n = 3) {
  for (let i = 0; i < n; i++) await new Promise(resolver => setImmediate(resolver))
}
