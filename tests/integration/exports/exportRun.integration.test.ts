/**
 * Integración (Postgres REAL) del servicio de pedidos:
 *  - Codex r1 #3: dos clics simultáneos ⇒ un pedido; cuatro distintos simultáneos ⇒ máximo 3 vivos (pg_advisory_xact_lock).
 *  - Codex r1 #7: borrar persona o sucursal deja la fila (SetNull) y la limpieza borra su archivo a su fecha.
 *  - Codex r1 #9: la limpieza de la prueba nunca borra con un id undefined.
 *
 *   ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration --runTestsByPath tests/integration/exports/exportRun.integration.test.ts --ci
 */
import prisma from '@/utils/prismaClient'
import { crearExportRunService } from '@/services/exports/exportRun.service'
import { fakeExportador } from '../../unit/services/exports/fakes'

interface Semillas {
  orgId?: string
  venueA?: string
  venueC?: string
  staffA?: string
  staffB?: string
  staffC?: string
  runIds: string[]
}

/** Borra SÓLO lo que sí se creó (regla del workspace: nunca un deleteMany con un id undefined). */
export async function limpiarSemillas(db: Pick<typeof prisma, 'exportRun' | 'staff' | 'venue' | 'organization'>, x: Semillas) {
  if (x.runIds.length) await db.exportRun.deleteMany({ where: { id: { in: x.runIds } } })
  for (const id of [x.staffA, x.staffB, x.staffC]) if (id) await db.staff.deleteMany({ where: { id } })
  for (const id of [x.venueA, x.venueC]) if (id) await db.venue.deleteMany({ where: { id } })
  if (x.orgId) await db.organization.deleteMany({ where: { id: x.orgId } })
}

const sufijo = `exr-${Date.now()}`
const s: Semillas = { runIds: [] }
const borrados: string[] = []
const carpetas: string[] = []
const svc = crearExportRunService({
  exportador: () => fakeExportador(12_000) as any,
  borrarArchivo: async p => {
    borrados.push(p)
  },
  borrarCarpeta: async scope => {
    carpetas.push(scope)
  }, // nunca el Storage real desde la prueba
})
const pedido = (venueId: string, staffId: string, startDate: string) => ({
  venueId,
  staffId,
  kind: 'ventas-detalladas',
  formato: 'csv' as const,
  columnas: ['paymentId', 'total'],
  filtros: { startDate, endDate: 'b' },
})
const anotar = (r: any) => {
  if (r.runId && !s.runIds.includes(r.runId)) s.runIds.push(r.runId)
  return r
}

beforeAll(async () => {
  s.orgId = (
    await prisma.organization.create({
      data: { name: `Exr Org ${sufijo}`, email: `${sufijo}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  s.venueA = (
    await prisma.venue.create({
      data: { organizationId: s.orgId, name: `exr-a-${sufijo}`, slug: `exr-a-${sufijo}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id
  s.venueC = (
    await prisma.venue.create({
      data: { organizationId: s.orgId, name: `exr-c-${sufijo}`, slug: `exr-c-${sufijo}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id
  for (const k of ['staffA', 'staffB', 'staffC'] as const) {
    s[k] = (
      await prisma.staff.create({ data: { email: `${k}-${sufijo}@example.test`, firstName: k, lastName: 'Exr' }, select: { id: true } })
    ).id
  }
})

afterAll(async () => {
  await limpiarSemillas(prisma, s)
  await prisma.$disconnect()
})

describe('exportRunService contra Postgres real', () => {
  it('🔴 dos pedidos iguales al mismo tiempo ⇒ UN solo pedido', async () => {
    const [a, b] = (await Promise.all([svc.pedir(pedido(s.venueA!, s.staffA!, 'x')), svc.pedir(pedido(s.venueA!, s.staffA!, 'x'))])).map(
      anotar,
    )
    expect(a.runId).toBe(b.runId)
    expect(await prisma.exportRun.count({ where: { requestedById: s.staffA } })).toBe(1)
  })
  it('🔴 cuatro distintos al mismo tiempo ⇒ máximo 3 vivos y uno «demasiadosVivos»', async () => {
    const rs = (await Promise.all(['a', 'b', 'c', 'd'].map(f => svc.pedir(pedido(s.venueA!, s.staffB!, f))))).map(anotar)
    expect(rs.filter(r => r.tipo === 'demasiadosVivos')).toHaveLength(1)
    expect(await prisma.exportRun.count({ where: { requestedById: s.staffB, status: { in: ['QUEUED', 'RUNNING'] } } })).toBe(3)
  })
  it('🔴 borrar la persona y la sucursal deja la fila sin dueño (SetNull) y la limpieza borra su archivo a su fecha', async () => {
    const r = anotar(await svc.pedir(pedido(s.venueC!, s.staffC!, 'z')))
    const ruta = `private/test/exports/${r.runId}/1/ventas-detalladas-2025-10-01.csv`
    // Fixture de la prueba (no es un camino del producto): un READY ya vencido con su archivo.
    await prisma.exportRun.update({
      where: { id: r.runId },
      data: { status: 'READY', filePath: ruta, finishedAt: new Date(), expiresAt: new Date(Date.now() - 1_000) },
    })
    await prisma.staff.delete({ where: { id: s.staffC } })
    s.staffC = undefined
    await prisma.venue.delete({ where: { id: s.venueC } })
    s.venueC = undefined
    expect(await prisma.exportRun.findUnique({ where: { id: r.runId } })).toMatchObject({
      requestedById: null,
      venueId: null,
      status: 'READY',
    })
    await svc.expirarVencidos()
    expect(carpetas).toContain(`exports/${r.runId}`)
    expect(await prisma.exportRun.findUnique({ where: { id: r.runId } })).toMatchObject({ status: 'EXPIRED', filePath: null })
  })
  it('🔴 montaje fallido a medias: la limpieza sólo borra lo que sí se creó, nunca con un id undefined', async () => {
    const llamadas: Array<[string, unknown]> = []
    const espia = new Proxy(
      {},
      {
        get: (_t, modelo: string) => ({
          deleteMany: async (a: { where: unknown }) => {
            llamadas.push([modelo, a.where])
          },
        }),
      },
    ) as any
    await limpiarSemillas(espia, { orgId: 'corg000000000000000000001', staffA: 'cstf000000000000000000001', runIds: [] })
    expect(llamadas).toEqual([
      ['staff', { id: 'cstf000000000000000000001' }],
      ['organization', { id: 'corg000000000000000000001' }],
    ])
  })
})
