// tests/integration/commission/comisionesExistentesConIva.integration.test.ts
/**
 * Fase 3 de Pago al personal, decisión del founder I3 = «A, configurable» (8-oct-2026), contra Postgres REAL.
 *
 * La fase cambió el significado de `includeTax = false`: antes no restaba nada (el `taxAmount` de la orden suele ser 0, así
 * que se comisionaba sobre lo cobrado CON IVA); ahora es «sin IVA». Para que nadie cobre menos el día del despliegue, la
 * migración de DATOS `*_comisiones_existentes_con_iva` deja «con IVA» TODOS los esquemas que ya existen. Los NUEVOS siguen
 * naciendo «sin IVA» (default del servidor y de la base), y cada esquema se cambia con su interruptor «Calcular con IVA».
 *
 * Se ejecuta el SQL REAL del archivo, acotado al negocio de la prueba (la base de pruebas es compartida por las suites;
 * en `migrate deploy` el archivo corre sin acotar).
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/comisionesExistentesConIva.integration.test.ts --ci --runInBand
 */
import fs from 'fs'
import path from 'path'
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from './_mundoComisiones'

// El plan (Comisiones es Premium) va simulado: aquí se prueba la migración y el default de lo que se crea después.
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasCommissionsAccess: jest.fn(async () => true),
}))

const MIGRACIONES = path.join(__dirname, '../../../prisma/migrations')

/** Las sentencias del archivo REAL, sin comentarios. */
function sentencias(): string[] {
  const dir = fs.readdirSync(MIGRACIONES).find(nombre => nombre.endsWith('_comisiones_existentes_con_iva'))
  if (!dir) throw new Error('falta la migración *_comisiones_existentes_con_iva')
  return fs
    .readFileSync(path.join(MIGRACIONES, dir, 'migration.sql'), 'utf-8')
    .split('\n')
    .filter(linea => !linea.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
}

/** Corre la migración acotada a los esquemas de ESTE negocio (los de la sede y los de su organización). */
async function migrar(): Promise<number> {
  let filas = 0
  for (const s of sentencias()) {
    filas += await prisma.$executeRawUnsafe(`${s} AND (esquema."venueId" = $1 OR esquema."orgId" = $2)`, m.venueId, m.orgId)
  }
  return filas
}

let m: MundoComisiones
let server: Server
beforeAll(async () => {
  asegurarBaseDePrueba()
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})
afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  if (mundo) await prisma.commissionConfig.deleteMany({ where: { orgId: mundo.orgId, venueId: null } })
  await borrarMundoComisiones(mundo)
})

/** Un esquema como lo dejó el código ANTES de la fase: `includeTax` en su default de siempre (false). */
const esquemaViejo = (datos: Record<string, unknown>) =>
  prisma.commissionConfig.create({
    data: { name: 'Viejo', defaultRate: 0.05, createdById: m.owner, categoryIds: [], ...datos } as any,
    select: { id: true },
  })

const conIva = async (ids: string[]) =>
  (await prisma.commissionConfig.findMany({ where: { id: { in: ids } }, select: { includeTax: true } })).map(c => c.includeTax)

const token = () =>
  jwt.sign({ sub: m.owner, orgId: m.orgId, venueId: m.venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })

describe('decisión I3 = A: los esquemas que existen al desplegar quedan «con IVA» (conservan lo que pagan hoy)', () => {
  it('🔴 todos los esquemas existentes —de sede y de organización, por porcentaje, niveles o fijo, activos, apagados o borrados— quedan con IVA; correrla dos veces no cambia nada', async () => {
    m = await crearMundoComisiones('existentes-con-iva', { includeTax: false })
    const viejos = [
      m.configId, // de sede, por porcentaje
      (await esquemaViejo({ venueId: m.venueId, calcType: 'TIERED' })).id,
      (await esquemaViejo({ venueId: m.venueId, calcType: 'FIXED', defaultRate: 5 })).id,
      (await esquemaViejo({ venueId: null, orgId: m.orgId })).id, // de organización
      (await esquemaViejo({ venueId: m.venueId, active: false })).id,
      (await esquemaViejo({ venueId: m.venueId, active: false, deletedAt: new Date(), deletedBy: m.owner })).id,
    ]
    const yaConIva = (await esquemaViejo({ venueId: m.venueId, includeTax: true })).id
    expect(await conIva(viejos)).toEqual(viejos.map(() => false))

    expect(await migrar()).toBe(viejos.length) // sólo los que estaban sin IVA; el que ya tenía IVA no se toca
    expect(await conIva([...viejos, yaConIva])).toEqual([...viejos, yaConIva].map(() => true))

    expect(await migrar()).toBe(0) // idempotente
  })

  it('un esquema que se crea DESPUÉS por la API nace «sin IVA» (de sede y de organización); con el interruptor prendido, con IVA', async () => {
    m = await crearMundoComisiones('nuevos-sin-iva', { includeTax: false })
    await migrar()
    const base = '/api/v1/dashboard/commissions/venues/' + m.venueId
    const crear = (ruta: string, cuerpo: Record<string, unknown>) =>
      request(server)
        .post(base + ruta)
        .set('Authorization', `Bearer ${token()}`)
        .send({ name: 'Nuevo', calcType: 'PERCENTAGE', defaultRate: 0.03, ...cuerpo })

    const deSede = await crear('/configs', {})
    const deOrganizacion = await crear('/org-configs', {})
    const conInterruptor = await crear('/configs', { includeTax: true })
    expect([deSede.status, deOrganizacion.status, conInterruptor.status]).toEqual([201, 201, 201])

    expect(await conIva([deSede.body.id, deOrganizacion.body.data.id, conInterruptor.body.id])).toEqual([false, false, true])
    expect(await conIva([m.configId])).toEqual([true]) // el que ya existía sigue con IVA
  })
})
