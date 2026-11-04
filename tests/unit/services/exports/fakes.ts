export function fakePrisma() {
  const filas: any[] = []
  const candados: Array<{ sql: string; valores: unknown[] }> = []
  let seq = 0
  const coincide = (r: any, w: any): boolean =>
    Object.entries(w ?? {}).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((x: any) => coincide(r, x))
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(r[k])
        if ('not' in v) return r[k] !== v.not
        if ('gt' in v) return r[k] != null && r[k] > v.gt // cursor por id del barrido de avisos (Codex r4)
        if ('lt' in v) return r[k] != null && r[k] < v.lt
        if ('lte' in v) return r[k] != null && r[k] <= v.lte
        if ('gte' in v) return r[k] != null && r[k] >= v.gte
      }
      return r[k] === v
    })
  const ordenar = (xs: any[], orderBy?: any) =>
    orderBy?.id // Codex r4: el barrido de avisos recorre por id (los ids del simulador van con ceros: el orden de texto es el de creación)
      ? [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : [...xs].sort((a, b) => +a.createdAt - +b.createdAt)
  const db: any = {
    filas,
    candados,
    $queryRaw: async (sql: TemplateStringsArray, ...valores: unknown[]) => {
      candados.push({ sql: sql.join('?'), valores })
      return [{}]
    },
    exportRun: {
      create: async ({ data }: any) => {
        const r = {
          id: `run${String(++seq).padStart(4, '0')}`,
          processedRows: 0,
          attempts: 0,
          status: 'QUEUED',
          cambioACsv: false,
          esperandoCobros: false,
          startedAt: null,
          finishedAt: null,
          filePath: null,
          campanitaAt: null,
          correoAt: null,
          avisoIntentos: 0,
          createdAt: data.corte,
          ...data,
        }
        filas.push(r)
        return structuredClone(r)
      },
      // Codex r2 R1: como Prisma real, las lecturas devuelven COPIAS (un updateMany posterior no cambia lo ya leído).
      findFirst: async ({ where }: any) => structuredClone(ordenar(filas.filter(r => coincide(r, where)))[0] ?? null),
      findUnique: async ({ where }: any) => structuredClone(filas.find(r => r.id === where.id) ?? null),
      findMany: async ({ where, take, orderBy }: any) =>
        structuredClone(
          ordenar(
            filas.filter(r => coincide(r, where)),
            orderBy,
          ).slice(0, take ?? Infinity),
        ),
      count: async ({ where }: any) => filas.filter(r => coincide(r, where)).length,
      updateMany: async ({ where, data }: any) => {
        const m = filas.filter(r => coincide(r, where))
        m.forEach(r => Object.assign(r, data))
        return { count: m.length }
      },
    },
    staff: { findUnique: async () => ({ email: 'duena@example.test' }) },
    venue: { findUnique: async () => ({ slug: 'testarudo', name: 'Testarudo' }) },
  }
  db.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db)
  return db
}

/** n filas, ids descendentes únicos; columnas `paymentId`, `total` y, si hacen falta más, `c2..c(columnas-1)`. */
export function fakeExportador(n: number, columnas = 2) {
  const filas = Array.from({ length: n }, (_, i) => ({
    id: `p${String(n - i).padStart(6, '0')}`,
    createdAt: new Date(1_759_300_000_000 + (n - i) * 1000),
    total: i,
  }))
  const extra = Array.from({ length: Math.max(0, columnas - 2) }, (_, k) => ({
    id: `c${k + 2}`,
    label: `C${k + 2}`,
    value: (f: any) => f.total,
  }))
  return {
    kind: 'ventas-detalladas',
    titulo: 'Ventas detalladas',
    nombreArchivo: 'ventas-detalladas',
    permiso: 'reports:read',
    autorizar: async () => null,
    parsearFiltros: (r: any) => r,
    columnas: [
      { id: 'paymentId', label: 'ID', value: (f: any) => f.id },
      { id: 'total', label: 'Total', value: (f: any) => f.total },
      ...extra,
    ],
    contar: async () => n,
    pagina: async (_v: string, _f: any, _c: Date, d: any, lim: number) => filas.filter(f => !d || f.id < d.id).slice(0, lim),
    cursorDe: (f: any) => ({ createdAt: f.createdAt.toISOString(), id: f.id }),
  }
}

/** Libro falso: guarda las páginas y devuelve un buffer con su JSON. */
export function fakeLibro() {
  const paginas: unknown[][] = []
  return {
    paginas,
    abrirLibro: () => ({
      agregar: (f: unknown[]) => {
        paginas.push(f)
      },
      cerrar: async () => Buffer.from(JSON.stringify(paginas.flat())),
      abortar: () => {},
    }),
  }
}
