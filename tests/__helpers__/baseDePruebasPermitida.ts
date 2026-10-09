// Guarda GLOBAL de la base de integración, para todas las suites, antes de que corra cualquier gancho.
//
// Las limpiezas de las pruebas filtran por el negocio del fixture: `deleteMany({ where: { venueId } })` (~660 lugares).
// Si el fixture no llegó a crearse (la guarda propia de la suite falló, o un beforeEach truena antes de asignar),
// `venueId` queda undefined, Prisma IGNORA el filtro y la limpieza borra la TABLA ENTERA. Medido el 8-oct-2026: así se
// vaciaron Payment, Order y CommissionConfig de una base de fase, y en un ensayo 33,361 pagos quedaron en 0.
// Por eso ninguna suite arranca contra la base compartida de todas las sesiones (`av-db-25`, sin respaldo automático)
// ni contra un host que no sea local. Las bases desechables (`avoqado_<tarea>_test_<fecha>`) y las propias de una fase
// siguen permitidas.

const BASES_COMPARTIDAS = new Set(['av-db-25'])
const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const ESQUEMAS_POSTGRES = new Set(['postgresql:', 'postgres:'])

/** `null` si la base sirve para integración; si no, el motivo en español. Nunca repite la URL (trae la contraseña). */
export function motivoParaRechazarBaseDePruebas(url: string): string | null {
  let destino: URL
  try {
    destino = new URL(url)
  } catch {
    return 'TEST_DATABASE_URL no es una dirección de base válida'
  }
  if (!ESQUEMAS_POSTGRES.has(destino.protocol)) return 'TEST_DATABASE_URL no apunta a PostgreSQL'
  if (!HOSTS_LOCALES.has(destino.hostname.toLowerCase()))
    return 'el servidor de la base no es local (nunca se prueba contra una base remota)'
  let base: string
  try {
    base = decodeURIComponent(destino.pathname.replace(/^\//, ''))
  } catch {
    return 'el nombre de la base no se puede leer'
  }
  base = base.trim().toLowerCase()
  if (!base) return 'TEST_DATABASE_URL no dice qué base usar'
  if (BASES_COMPARTIDAS.has(base)) return `«${base}» es la base compartida de todas las sesiones y no tiene respaldo`
  return null
}
