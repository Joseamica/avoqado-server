/**
 * Puente QR legacy de MindForm, simulado desde ABAJO (el pool de Postgres) para las pruebas de D15.
 *
 * Se simula el pool y no `forEachLegacyPaymentPage`: el defecto vivía justo en el recorrido por páginas
 * (una página que falla se tomaba por «ya no hay más»), así que las pruebas tienen que pasar por el recorrido real.
 *
 * Uso: `jest.mock('@/services/legacy/legacyPool', () => require('@tests/__helpers__/puenteQrLegacy').moduloLegacyPool)`.
 */
export const MINDFORM = 'cmisvi38o001fhr2828ygmxi2'
export const TAMANO_DE_PAGINA = 500

type Pagina = Array<Record<string, unknown>> | Error

const estado: { configurado: boolean; paginas: Pagina[]; consultas: string[] } = { configurado: true, paginas: [], consultas: [] }

const pool = {
  query: async (sql: string) => {
    estado.consultas.push(sql)
    // El conteo del listado: no es una página. El recorrido por páginas no lo pide (`includeTotal: false`).
    if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] }
    const pagina = estado.paginas.shift() ?? []
    if (pagina instanceof Error) throw pagina
    return { rows: pagina }
  },
}

/** El módulo `legacyPool` simulado. `legacyPool` es un getter: `null` = `LEGACY_DATABASE_URL` sin configurar. */
export const moduloLegacyPool = {
  get legacyPool() {
    return estado.configurado ? pool : null
  },
}

/** Lo que va a contestar el puente, página por página. Un `Error` = esa página revienta. Sin más páginas = cero filas. */
export function puenteContesta(...paginas: Pagina[]) {
  estado.configurado = true
  estado.paginas = paginas
  estado.consultas = []
}

export function puenteSinConfigurar() {
  estado.configurado = false
  estado.paginas = []
  estado.consultas = []
}

export const consultasAlPuente = () => estado.consultas.length

/**
 * `n` cobros QR legacy tal como los devuelve `pg`: importes en CENTAVOS y como texto. Cada uno vale $100 + $10 de propina,
 * así que una página completa (500) suma $50,000 + $5,000.
 */
export function cobrosLegacy(n: number, desde = 0): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `pi_${String(desde + i).padStart(5, '0')}`,
    amount: '10000',
    tipAmount: '1000',
    status: 'ACCEPTED',
    method: 'STRIPE',
    cardBrand: 'visa',
    last4: '4242',
    // Más nuevo primero, como el ORDER BY del puente.
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - (desde + i) * 1000),
    updatedAt: null,
    source: null,
    splitType: null,
    tableNumber: null,
    waiterName: null,
    currency: 'MXN',
    bank: null,
  }))
}

export const PUENTE_CAIDO = new Error('connection terminated unexpectedly')
