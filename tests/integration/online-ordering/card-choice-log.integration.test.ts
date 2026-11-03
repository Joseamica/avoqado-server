// tests/integration/online-ordering/card-choice-log.integration.test.ts
/**
 * Integration (Postgres REAL) — S1b decide por la bitácora quién ya expresó el switch de la tarjeta. Por eso esa entrada se escribe en
 * la MISMA transacción del ajuste (Codex S1b r2): `logAction` está simulado en toda la integración, así que la fila que aparece aquí
 * sólo pudo salir de la transacción. Sólo filas propias (sufijo único), borradas en `afterAll`.
 */
import prisma from '@/utils/prismaClient'
import { updateSettings } from '@/services/online-ordering/settings.service'

jest.setTimeout(60_000)

const RUN = Date.now().toString(36)

describe('la elección de la tarjeta queda anotada en la misma transacción', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: 'ITEST Eleccion', slug: `itest-eleccion-org-${RUN}`, email: `itest-eleccion-${RUN}@test.com`, phone: '5550000000' },
      })
    ).id
    venueId = (
      await prisma.venue.create({
        data: { name: 'ITEST Eleccion', slug: `itest-eleccion-${RUN}`, organizationId: orgId, timezone: 'America/Mexico_City' },
      })
    ).id
    staffId = (
      await prisma.staff.create({ data: { email: `itest-eleccion-staff-${RUN}@test.com`, firstName: 'Duena', lastName: 'ITEST', active: true } })
    ).id
  })

  afterAll(async () => {
    // Limpieza acotada: sin negocio NO se borra nada (una limpieza sin filtro vaciaría tablas enteras).
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.onlineOrderingSettings.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  it('al volver de guardar un «no», su entrada ya está en la base, con el patch que lee el relleno', async () => {
    await updateSettings(venueId!, { acceptsCardOnline: false }, staffId!)
    const fila = await prisma.onlineOrderingSettings.findUniqueOrThrow({ where: { venueId: venueId! } })
    const entradas = await prisma.activityLog.findMany({
      where: { entity: 'OnlineOrderingSettings', entityId: fila.id, action: 'ONLINE_ORDERING_SETTINGS_UPDATED' },
    })
    expect(entradas).toHaveLength(1)
    expect(entradas[0].staffId).toBe(staffId)
    expect((entradas[0].data as { patch: unknown }).patch).toEqual({ acceptsCardOnline: false })
  })
})
