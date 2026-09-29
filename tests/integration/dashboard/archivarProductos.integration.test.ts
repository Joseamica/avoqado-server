/**
 * IVA por producto, plan 5 — archivar y el trigger de borrado, contra Postgres REAL (H1). Negocio NUEVO por caso.
 * Tarea 1: la migración 20260929000200 apaga UNA vez los productos que el dashboard ya había «borrado» sólo con deletedAt.
 * Tarea 2: borrar una categoría cuyo único contenido es un archivado. Tarea 5: el trigger BEFORE DELETE y los caminos de demo.
 */
import { readFileSync } from 'fs'
import path from 'path'

import prisma from '@/utils/prismaClient'
import { limpiarNegocios, nuevoNegocio, type Negocio } from '../fiscal/exclusionContable.fixtures'

jest.setTimeout(120_000)

afterAll(() => limpiarNegocios())

/** Un producto en la categoría «Plan 5» del negocio (se crea la primera vez). Devuelve su id. */
async function producto(x: Negocio, nombre: string, extra: { isDemo?: boolean } = {}): Promise<string> {
  const categoria = await prisma.menuCategory.upsert({
    where: { venueId_slug: { venueId: x.venueId, slug: 'plan5' } },
    create: { venueId: x.venueId, name: 'Plan 5', slug: 'plan5' },
    update: {},
  })
  return (
    await prisma.product.create({
      data: { venueId: x.venueId, categoryId: categoria.id, sku: `${nombre}-${x.rfc}`, name: nombre, price: 100, ...extra },
    })
  ).id
}

describe('D1 · archivar es deletedAt + deletedBy + active=false', () => {
  it('la migración apaga UNA vez los que el dashboard sólo marcaba con deletedAt; nada más se toca', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const viejo = await producto(x, 'Masaje')
    const vivo = await producto(x, 'Facial')
    const cuando = new Date('2026-09-01T12:00:00.000Z')
    // Así «borraba» el dashboard hasta el plan 5: deletedAt y deletedBy, active intacto.
    await prisma.product.update({ where: { id: viejo }, data: { deletedAt: cuando, deletedBy: 'staff-viejo' } })

    const sql = readFileSync(path.join(process.cwd(), 'prisma/migrations/20260929000200_producto_archivado_se_apaga/migration.sql'), 'utf8')
    await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('-- archivados-apagados:inicio'), sql.indexOf('-- archivados-apagados:fin')))

    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: viejo }, select: { active: true, deletedAt: true, deletedBy: true } }),
    ).toEqual({ active: false, deletedAt: cuando, deletedBy: 'staff-viejo' })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: vivo } })).active).toBe(true)
  })
})
