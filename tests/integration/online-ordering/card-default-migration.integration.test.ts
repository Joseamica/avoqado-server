// tests/integration/online-ordering/card-default-migration.integration.test.ts
/**
 * Integration (Postgres REAL) — S1b: la tarjeta en línea viene prendida. Corre el UPDATE de la migración de verdad, acotado a las
 * filas de esta prueba para no prenderles la tarjeta a las demás suites. Se prende sólo a quien NUNCA expresó el switch: un `false`
 * repetido por el MCP no escribe TOGGLED, pero queda en el patch de ONLINE_ORDERING_SETTINGS_UPDATED (Codex plan r2).
 */
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import prisma from '@/utils/prismaClient'

jest.setTimeout(60_000)

const RUN = Date.now().toString(36)
const MIGRACIONES = path.join(process.cwd(), 'prisma/migrations')

/** El UPDATE de la migración, sólo para estos negocios: el criterio que se prueba es el del archivo, no una copia. */
function updateDeLaMigracion(venueIds: string[]): string {
  const carpeta = readdirSync(MIGRACIONES).find(d => d.endsWith('_tarjeta_en_linea_prendida_de_fabrica'))
  if (!carpeta) throw new Error('Falta la migración tarjeta_en_linea_prendida_de_fabrica')
  const sql = readFileSync(path.join(MIGRACIONES, carpeta, 'migration.sql'), 'utf8')
  const update = sql.match(/UPDATE "OnlineOrderingSettings"[\s\S]*?;/)?.[0]
  if (!update) throw new Error('La migración no trae el UPDATE')
  return `${update.slice(0, -1)} AND s."venueId" IN (${venueIds.map(id => `'${id}'`).join(', ')})`
}

describe('S1b: la migración prende la tarjeta sólo a quien nunca expresó el switch', () => {
  let orgId: string | undefined
  const venues: Record<string, string> = {}
  const settings: Record<string, string> = {}

  async function negocio(nombre: string) {
    const venue = await prisma.venue.create({
      data: { name: `ITEST ${nombre}`, slug: `itest-s1b-${nombre}-${RUN}`, organizationId: orgId!, timezone: 'America/Mexico_City' },
    })
    venues[nombre] = venue.id
    const fila = await prisma.onlineOrderingSettings.create({ data: { venueId: venue.id, acceptsCardOnline: false } })
    settings[nombre] = fila.id
  }

  const bitacora = (nombre: string, action: string, data: object) =>
    prisma.activityLog.create({
      data: { venueId: venues[nombre], action, entity: 'OnlineOrderingSettings', entityId: settings[nombre], data },
    })

  const tarjeta = async (nombre: string) =>
    (await prisma.onlineOrderingSettings.findUniqueOrThrow({ where: { id: settings[nombre] } })).acceptsCardOnline

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: 'ITEST S1b', slug: `itest-s1b-org-${RUN}`, email: `itest-s1b-${RUN}@test.com`, phone: '5550000000' },
      })
    ).id
    for (const nombre of ['sin-bitacora', 'otro-campo', 'patch-false', 'toggled']) await negocio(nombre)
    await bitacora('otro-campo', 'ONLINE_ORDERING_SETTINGS_UPDATED', { changed: ['minOrderAmount'], patch: { minOrderAmount: 50 } })
    await bitacora('patch-false', 'ONLINE_ORDERING_SETTINGS_UPDATED', { changed: ['acceptsCardOnline'], patch: { acceptsCardOnline: false } })
    await bitacora('toggled', 'ONLINE_ORDERING_CARD_TOGGLED', { from: true, to: false })
    await prisma.$executeRawUnsafe(updateDeLaMigracion(Object.values(venues)))
  })

  afterAll(async () => {
    // Limpieza acotada: sin negocio NO se borra nada (una limpieza sin filtro vaciaría tablas enteras).
    if (!orgId) return
    const ids = Object.values(venues)
    if (ids.length > 0) {
      await prisma.activityLog.deleteMany({ where: { venueId: { in: ids } } })
      await prisma.onlineOrderingSettings.deleteMany({ where: { venueId: { in: ids } } })
      await prisma.venue.deleteMany({ where: { id: { in: ids } } })
    }
    await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  it('sin bitácora del switch: se prende', async () => {
    await expect(tarjeta('sin-bitacora')).resolves.toBe(true)
  })

  it('cambió otro ajuste, nunca la tarjeta: se prende', async () => {
    await expect(tarjeta('otro-campo')).resolves.toBe(true)
  })

  it('un false repetido por el MCP (patch sin TOGGLED) cuenta como su decisión: sigue apagada', async () => {
    await expect(tarjeta('patch-false')).resolves.toBe(false)
  })

  it('la apagó a mano (TOGGLED): sigue apagada', async () => {
    await expect(tarjeta('toggled')).resolves.toBe(false)
  })

  it('un negocio nuevo nace con la tarjeta prendida (el default de la columna)', async () => {
    const venue = await prisma.venue.create({
      data: { name: 'ITEST S1b nuevo', slug: `itest-s1b-nuevo-${RUN}`, organizationId: orgId!, timezone: 'America/Mexico_City' },
    })
    venues.nuevo = venue.id
    const filas = await prisma.$queryRawUnsafe<{ acceptsCardOnline: boolean }[]>(
      `INSERT INTO "OnlineOrderingSettings" ("id", "venueId", "updatedAt") VALUES ('cmfulltests1bnuevo${RUN.slice(-7).padStart(7, '0')}', '${venue.id}', now()) RETURNING "acceptsCardOnline"`,
    )
    expect(filas[0].acceptsCardOnline).toBe(true)
  })
})
