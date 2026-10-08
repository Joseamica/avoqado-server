// tests/integration/staffPay/acceso.organizacion.test.ts
// E6a-fix2 C2 (full-testing): las acciones de ORGANIZACIÓN (activar, propinas, periodicidad, niveles) piden el permiso en TODAS
// las sedes con el plan. Con el permiso en una sede y no en otra, la pantalla ofrecía el interruptor y el servidor lo rechazaba
// en técnico («necesitas staffpay:close en todas las sedes»), sin decir dónde ni a quién pedírselo, y sin dejar rastro en la
// bitácora. Ahora UNA función decide el 403 y el booleano `puedeAdministrarOrganizacion` de `GET /access`. Con el acceso REAL
// (getUserAccess, roles y `VenueRolePermission`), nada de mocks de permisos.
import prisma from '@/utils/prismaClient'
import { getAccess } from '@/controllers/dashboard/staffPay.dashboard.controller'
import { activarPagoAlPersonal, cambiarPropinas } from '@/services/dashboard/staffPay/activacion.service'
import { cambiarPeriodicidad } from '@/services/dashboard/staffPay/periodosGuardados'
import { crearNivel } from '@/services/dashboard/staffPay/niveles.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const key = `pf3org-${process.pid}-${Date.now()}`
let orgId: string
let full: string
let wellness: string
let lejana: string
let parcial: string
let dueno: string

const TEXTO = (falta: string) =>
  `Para esto necesitas el permiso «Cerrar periodos y registrar pagos» en todas las sedes de la organización (te falta en: ${falta}). Pídeselo al dueño del negocio.`

beforeAll(async () => {
  // Organización exenta: todas sus sedes tienen el plan (resolver REAL de funciones).
  orgId = (
    await prisma.organization.create({
      data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000', seatCapExempt: true },
    })
  ).id
  const sede = async (nombre: string) =>
    (
      await prisma.venue.create({
        data: { organizationId: orgId, name: nombre, slug: `${key}-${nombre}`.toLowerCase().replace(/ /g, '-') },
      })
    ).id
  full = await sede(`Full ${key}`)
  wellness = await sede(`Wellness ${key}`)
  lejana = await sede(`Lejana ${key}`)
  const persona = async (n: string) =>
    (await prisma.staff.create({ data: { email: `${key}-${n}@example.test`, firstName: n, lastName: 'QA', active: true } })).id
  parcial = await persona('parcial')
  dueno = await persona('dueno')
  // El caso de la QA: ADMIN en las dos sedes; sólo en Wellness el rol ADMIN trae además «Cerrar periodos y registrar pagos».
  await prisma.staffVenue.createMany({
    data: [
      { staffId: parcial, venueId: full, role: 'ADMIN', active: true },
      { staffId: parcial, venueId: wellness, role: 'ADMIN', active: true },
      ...[full, wellness, lejana].map(venueId => ({ staffId: dueno, venueId, role: 'OWNER' as const, active: true })),
    ],
  })
  await prisma.venueRolePermission.create({
    data: { venueId: wellness, role: 'ADMIN', permissions: ['staffpay:close'], modifiedBy: dueno },
  })
})

afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { organizationId: orgId } })
  await prisma.activityLog.deleteMany({ where: { venueId: { in: [full, wellness, lejana] } } })
  await prisma.staffPayLevel.deleteMany({ where: { organizationId: orgId } })
  await prisma.venueRolePermission.deleteMany({ where: { venueId: wellness } })
  await prisma.venue.deleteMany({ where: { organizationId: orgId } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: key } } })
  await prisma.organization.delete({ where: { id: orgId } })
})

/** `GET /access` por su controller, con la sesión de `userId` entrando desde `venueId`. */
async function access(userId: string, venueId: string): Promise<Record<string, unknown>> {
  let cuerpo: Record<string, unknown> | undefined
  let error: unknown
  await getAccess(
    { params: { venueId }, query: {}, body: {}, authContext: { userId } } as any,
    { json: (b: Record<string, unknown>) => (cuerpo = b) } as any,
    (e: unknown) => (error = e),
  )
  if (error) throw error
  return cuerpo!
}

/**
 * El PERMISSION_DENIED va por `logAction` (en segundo plano, como el del middleware). El setup de integración lo deja como
 * `jest.fn()` (no escribe): se lee lo que se le pidió escribir.
 */
const negaciones = (staffId: string, venueId: string) =>
  (logAction as jest.Mock).mock.calls
    .map(([p]) => p)
    .filter(p => p.action === 'PERMISSION_DENIED' && p.staffId === staffId && p.venueId === venueId)

describe('C2 · permiso de cierre en una sede y no en otra (entrando desde la sede donde SÍ lo tiene)', () => {
  it('GET /access dice que no puede administrar la organización', async () => {
    expect(await access(parcial, wellness)).toMatchObject({ puedeAdministrarOrganizacion: false })
  })

  it('propinas y activar dan 403 en español: qué falta, dónde y a quién pedírselo, sin códigos internos', async () => {
    // La lejana no la ve: no se nombra (cuenta como «sede donde no tienes acceso»).
    const falta = `Full ${key} y 1 sede donde no tienes acceso`
    const propinas = cambiarPropinas({ userId: parcial, venueId: wellness, encender: true })
    await expect(propinas).rejects.toMatchObject({ statusCode: 403, message: TEXTO(falta) })
    const activar = activarPagoAlPersonal({ userId: parcial, venueId: wellness, periodicidad: 'MONTHLY' })
    await expect(activar).rejects.toMatchObject({ statusCode: 403, message: TEXTO(falta) })
    await expect(cambiarPropinas({ userId: parcial, venueId: wellness, encender: true })).rejects.not.toMatchObject({
      message: expect.stringMatching(/staffpay:/),
    })
  })

  it('cada 403 de una ESCRITURA deja PERMISSION_DENIED en la bitácora, como los del middleware', async () => {
    const antes = negaciones(parcial, wellness).length
    await expect(cambiarPeriodicidad({ userId: parcial, venueId: wellness, periodicidad: 'SEMIMONTHLY' })).rejects.toMatchObject({
      statusCode: 403,
    })
    const filas = negaciones(parcial, wellness)
    expect(filas.length).toBe(antes + 1)
    expect(filas[filas.length - 1]).toMatchObject({
      organizationId: orgId,
      entity: 'permission',
      entityId: 'staffpay:close',
      data: { permission: 'staffpay:close', reason: 'FALTA_PERMISO_EN_SEDES', faltanEn: expect.arrayContaining([full, lejana]) },
    })
  })

  it('el booleano de GET /access es una LECTURA: no deja nada en la bitácora', async () => {
    const antes = negaciones(parcial, wellness).length
    expect(await access(parcial, wellness)).toMatchObject({ puedeAdministrarOrganizacion: false })
    expect(negaciones(parcial, wellness).length).toBe(antes)
  })

  it('el hermano con OTRO permiso (niveles: «Configurar pago al personal») dice su nombre, no el código', async () => {
    // ADMIN trae staffpay:manage de fábrica en todas; en la lejana no tiene acceso.
    await expect(crearNivel({ organizationId: orgId, name: 'Coach', actorId: parcial, venueId: wellness })).rejects.toMatchObject({
      statusCode: 403,
      message:
        'Para esto necesitas el permiso «Configurar pago al personal» en todas las sedes de la organización (te falta en: 1 sede donde no tienes acceso). Pídeselo al dueño del negocio.',
    })
  })
})

describe('C2 · regresión: con el permiso en TODAS las sedes', () => {
  it('GET /access dice que sí puede, y el permiso deja pasar (lo que sigue es la regla de la acción, no un 403)', async () => {
    expect(await access(dueno, wellness)).toMatchObject({ puedeAdministrarOrganizacion: true })
    expect(await access(dueno, full)).toMatchObject({ puedeAdministrarOrganizacion: true })
    // Sin activar todavía: el permiso pasa y la propia acción contesta 409 NO_ACTIVADO.
    await expect(cambiarPropinas({ userId: dueno, venueId: full, encender: true })).rejects.toMatchObject({
      statusCode: 409,
      code: 'NO_ACTIVADO',
    })
  })

  it('los campos de siempre de GET /access siguen ahí (aditivo)', async () => {
    const r = await access(dueno, full)
    expect(Object.keys(r).sort()).toEqual(
      [
        'activado',
        'enabled',
        'inicioAlActivar',
        'periodicidad',
        'periodicidadFija',
        'propinasEncendidas',
        'puedeAdministrarOrganizacion',
        'startDate',
      ].sort(),
    )
  })
})
