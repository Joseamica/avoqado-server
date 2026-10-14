// tests/integration/customer-display/customerDisplayVenueChange.integration.test.ts
import prisma from '@/utils/prismaClient'
import { NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { saveCustomerDisplayDesign } from '@/services/customer-display/customerDisplayDesign.service'
import { borrarDisenoAlCambiarDeNegocio } from '@/services/customer-display/customerDisplayVenueChange'
import { esperarBloqueado, retener, retenerTerminal } from './barrera'

// El guardado del diseño (fixture y caso 5) consulta el plan del negocio.
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(async () => true) }))

// `logAction` lo simula el setup de integración. Aquí se lee como «un asiento escrito FUERA de la transacción»: si el
// gancho lo usara, el asiento quedaría aunque la mudanza se deshiciera.
const bitacoraFueraDeLaTransaccion = logAction as jest.Mock

const suffix = `cdvc-${Date.now()}`
let orgId: string
let venueA: string
let venueB: string
let staffId: string
let terminalId: string

const INSTALADA_DESDE = new Date('2026-10-01T12:00:00.000Z')

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  const crearVenue = async (n: string) =>
    (
      await prisma.venue.create({
        data: { organizationId: orgId, name: `Venue ${n} ${suffix}`, slug: `venue-${n}-${suffix}`, timezone: 'America/Mexico_City' },
        select: { id: true },
      })
    ).id
  venueA = await crearVenue('a')
  venueB = await crearVenue('b')
  staffId = (
    await prisma.staff.create({
      data: { email: `staff-${suffix}@example.test`, firstName: 'Ana', lastName: 'Prueba' },
      select: { id: true },
    })
  ).id
})

beforeEach(async () => {
  if (!venueA || !venueB) return
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  terminalId = (
    await prisma.terminal.create({
      data: { venueId: venueA, name: `Caja ${suffix}`, type: 'POS_ANDROID' },
      select: { id: true },
    })
  ).id
  // El diseño, con el guardado REAL (no un `create` suelto): es la fila que el gancho tiene que borrar.
  await saveCustomerDisplayDesign({
    venueId: venueA,
    terminalId,
    draft: { welcomeText: 'Hola' },
    expectedEditToken: 'factory',
    staffId,
  })
  // El reporte del aparato (acuse, instalación y versión), como lo deja una tablet que ya mostró el diseño.
  await prisma.terminal.update({
    where: { id: terminalId },
    data: {
      customerDisplayAck: { seq: 3, fingerprint: 'abc' },
      customerDisplayInstallationId: 'inst-1',
      customerDisplayInstallationSince: INSTALADA_DESDE,
      customerDisplayInstallationSwitches: ['2026-10-01T12:00:00.000Z'],
      customerDisplayDesignVersion: 2,
    },
  })
  bitacoraFueraDeLaTransaccion.mockClear() // el guardado del fixture sí la usa; el setup no limpia los mocks
})

afterAll(async () => {
  if (!venueA || !venueB) return
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  await prisma.activityLog.deleteMany({ where: { OR: [{ venueId: { in: [venueA, venueB] } }, { staffId }] } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
})

const terminal = () =>
  prisma.terminal.findUniqueOrThrow({
    where: { id: terminalId },
    select: {
      venueId: true,
      customerDisplayAck: true,
      customerDisplayInstallationId: true,
      customerDisplayInstallationSince: true,
      customerDisplayInstallationSwitches: true,
      customerDisplayDesignVersion: true,
    },
  })

const REPORTE_INTACTO = {
  customerDisplayAck: { seq: 3, fingerprint: 'abc' },
  customerDisplayInstallationId: 'inst-1',
  customerDisplayInstallationSince: INSTALADA_DESDE,
  customerDisplayInstallationSwitches: ['2026-10-01T12:00:00.000Z'],
  customerDisplayDesignVersion: 2,
}

const REPORTE_LIMPIO = {
  customerDisplayAck: null,
  customerDisplayInstallationId: null,
  customerDisplayInstallationSince: null,
  customerDisplayInstallationSwitches: null,
  customerDisplayDesignVersion: null,
}

const asientos = () => prisma.activityLog.findMany({ where: { entityId: terminalId, action: 'CUSTOMER_DISPLAY_DESIGN_RESET' } })

/** Lo que hace cualquier escritor de `Terminal.venueId`: el gancho y, en la MISMA transacción, su escritura. */
const mudarA = (toVenueId: string) =>
  prisma.$transaction(async tx => {
    const r = await borrarDisenoAlCambiarDeNegocio(tx, { terminalId, toVenueId, reason: 'terminal_moved', staffId })
    await tx.terminal.update({ where: { id: terminalId }, data: { venueId: toVenueId } })
    return r
  })

describe('borrarDisenoAlCambiarDeNegocio (Postgres real)', () => {
  it('1. la mudanza borra el diseño, limpia acuse e instalación y deja el asiento, en la transacción del llamador', async () => {
    const r = await mudarA(venueB)

    expect(r).toEqual({ cambio: true, disenoBorrado: true, fromVenueId: venueA })
    expect(await prisma.customerDisplayDesign.findUnique({ where: { terminalId } })).toBeNull()
    expect(await terminal()).toEqual({ venueId: venueB, ...REPORTE_LIMPIO })

    const escritos = await asientos()
    expect(escritos).toHaveLength(1)
    expect(escritos[0]).toMatchObject({
      staffId,
      venueId: venueB,
      entity: 'Terminal',
      entityId: terminalId,
      data: { reason: 'terminal_moved', fromVenueId: venueA, toVenueId: venueB },
    })
    expect(bitacoraFueraDeLaTransaccion).not.toHaveBeenCalled()
  })

  it('2. si la transacción del llamador truena DESPUÉS del gancho, diseño y acuse siguen como estaban y no queda asiento', async () => {
    const truena = new Error('el escritor falla después del gancho')

    await expect(
      prisma.$transaction(async tx => {
        await borrarDisenoAlCambiarDeNegocio(tx, { terminalId, toVenueId: venueB, reason: 'terminal_moved', staffId })
        await tx.terminal.update({ where: { id: terminalId }, data: { venueId: venueB } })
        throw truena
      }),
    ).rejects.toBe(truena)

    expect(await prisma.customerDisplayDesign.findUnique({ where: { terminalId }, select: { welcomeText: true } })).toEqual({
      welcomeText: 'Hola',
    })
    expect(await terminal()).toEqual({ venueId: venueA, ...REPORTE_INTACTO })
    expect(await asientos()).toHaveLength(0)
    // Un asiento por `logAction` (fuera de la transacción) habría quedado escrito aunque la mudanza se deshizo.
    expect(bitacoraFueraDeLaTransaccion).not.toHaveBeenCalled()
  })

  it('3. al MISMO negocio (cancelar una migración v2 que no se movió) no toca nada', async () => {
    const r = await prisma.$transaction(tx =>
      borrarDisenoAlCambiarDeNegocio(tx, { terminalId, toVenueId: venueA, reason: 'migration_reverted', staffId }),
    )

    expect(r).toEqual({ cambio: false, disenoBorrado: false, fromVenueId: venueA })
    expect(await prisma.customerDisplayDesign.findUnique({ where: { terminalId }, select: { welcomeText: true } })).toEqual({
      welcomeText: 'Hola',
    })
    expect(await terminal()).toEqual({ venueId: venueA, ...REPORTE_INTACTO })
    expect(await asientos()).toHaveLength(0)
  })

  it('4. una TPV sin diseño: limpia el reporte del aparato, pero no deja asiento', async () => {
    await prisma.customerDisplayDesign.delete({ where: { terminalId } })

    const r = await mudarA(venueB)

    expect(r).toEqual({ cambio: true, disenoBorrado: false, fromVenueId: venueA })
    expect(await terminal()).toEqual({ venueId: venueB, ...REPORTE_LIMPIO })
    expect(await asientos()).toHaveLength(0)
    expect(bitacoraFueraDeLaTransaccion).not.toHaveBeenCalled()
  })

  // Portado de `4ffd794c5:tests/integration/customer-display/terminalVenueMove.integration.test.ts:235-264`, con el gancho.
  // Prueba la revalidación del GUARDADO bajo el candado, no el candado inicial del gancho (para eso está el caso 6).
  it('5. una edición que empezó antes de la mudanza no escribe después: 404, y el diseño no renace', async () => {
    const diseno = await prisma.customerDisplayDesign.findUniqueOrThrow({ where: { terminalId }, select: { id: true, revision: true } })
    const { pid, soltar, transaccion } = await retener(tx =>
      borrarDisenoAlCambiarDeNegocio(tx, { terminalId, toVenueId: venueB, reason: 'terminal_moved', staffId }),
    )

    // El guardado pasa su lectura inicial (la terminal todavía es de A para él) y espera el candado de la mudanza.
    const guardado = saveCustomerDisplayDesign({
      venueId: venueA,
      terminalId,
      draft: { welcomeText: 'Escrito tarde' },
      expectedEditToken: `${diseno.id}:${diseno.revision}`,
      staffId,
    })
    expect(await esperarBloqueado(pid, guardado)).toBe('bloqueada')

    soltar(async tx => {
      await tx.terminal.update({ where: { id: terminalId }, data: { venueId: venueB } })
    })
    await transaccion

    await expect(guardado).rejects.toBeInstanceOf(NotFoundError)
    expect((await terminal()).venueId).toBe(venueB)
    expect(await prisma.customerDisplayDesign.findUnique({ where: { terminalId } })).toBeNull()
  })

  // 🔴 Ruling #4: el gancho espera el candado de la terminal ANTES de tocar nada. La barrera va ANTES del gancho.
  it('6. el gancho espera el candado ANTES de tocar nada: un guardado que tiene la fila termina, y después se borra', async () => {
    const { pid, soltar, transaccion } = await retenerTerminal(terminalId) // un guardado tiene la fila
    const mudanza = prisma.$transaction(async tx => {
      await borrarDisenoAlCambiarDeNegocio(tx, { terminalId, toVenueId: venueB, reason: 'terminal_moved' })
      await tx.terminal.update({ where: { id: terminalId }, data: { venueId: venueB } })
    })
    expect(await esperarBloqueado(pid, mudanza)).toBe('bloqueada')

    // El guardado, que todavía tiene la fila, escribe el diseño. Si el gancho hubiera borrado sin esperar el candado,
    // esta escritura chocaría con su borrado sin confirmar (interbloqueo o lock_timeout) y la barrera fallaría.
    soltar(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`
      await tx.customerDisplayDesign.update({ where: { terminalId }, data: { welcomeText: 'guardado mientras esperaba' } })
    })
    await expect(transaccion).resolves.toBeUndefined()
    await expect(mudanza).resolves.toBeUndefined()
    expect(await prisma.customerDisplayDesign.findUnique({ where: { terminalId } })).toBeNull()
    expect(await terminal()).toEqual({ venueId: venueB, ...REPORTE_LIMPIO })
  })
})
