// tests/integration/devices/deviceDiagnostics.integration.test.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { esEsperaDeLaBase, guardarDiagnostico, type DeviceDiagnostics } from '@/services/mobile/deviceDiagnostics'
import { getTerminalsData, getTpvById, updateTpv } from '@/services/dashboard/tpv.dashboard.service'
import { getTerminalForOrg } from '@/services/organization-dashboard/orgTerminals.service'
import { getAllTerminals, getTerminalById } from '@/services/dashboard/terminals.superadmin.service'

/**
 * El reporte de dibujo del POS de Windows (hz:a5fa2439:D1) se guarda con UNA sentencia condicionada: lo guardado nunca
 * retrocede dentro de una misma apertura del programa (`proc`), otra apertura siempre reemplaza (un sondeo atrasado de la
 * anterior puede pisar un instante; el siguiente de la apertura viva lo corrige), y un JSON viejo o raro nunca hace fallar
 * la sentencia. La condición la evalúa Postgres, por eso va contra la base.
 */
const suffix = `dibujo-${Date.now()}`
const LATIDO = new Date('2026-11-20T12:00:00.000Z')
const T1 = new Date('2026-11-25T18:00:00.000Z')
const T2 = new Date('2026-11-25T18:00:20.000Z')
const reporte = (proc: string, rev: number, extra: Partial<DeviceDiagnostics> = {}): DeviceDiagnostics => ({
  proc,
  rev,
  api: 'SOFTWARE_FAST',
  paintMs: 712,
  performance: 'LIGHT',
  drawingMode: 'FAST',
  forced: true,
  failed: false,
  manual: false,
  ...extra,
})
const A = 'aaaaaaaa'
const B = 'bbbbbbbb'

let orgId: string
let venueId: string
let posId: string
let tpvId: string

const leer = async (id = posId) =>
  prisma.terminal.findUniqueOrThrow({ where: { id }, select: { deviceDiagnostics: true, lastHeartbeat: true } })
const poner = (valor: Prisma.InputJsonValue | typeof Prisma.DbNull) =>
  prisma.terminal.update({ where: { id: posId }, data: { deviceDiagnostics: valor }, select: { id: true } })

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `Venue ${suffix}`, slug: `venue-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id
  posId = (
    await prisma.terminal.create({
      data: { venueId, name: 'PC', type: 'POS_ANDROID', deviceUid: `pc-${suffix}`, lastHeartbeat: LATIDO },
      select: { id: true },
    })
  ).id
  tpvId = (await prisma.terminal.create({ data: { venueId, name: 'Terminal', type: 'TPV_ANDROID' }, select: { id: true } })).id
})

beforeEach(async () => {
  await poner(Prisma.DbNull)
})

afterAll(async () => {
  // Cada borrado con su propia guarda: un id undefined vaciaría tablas enteras (8-oct).
  if (venueId) {
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('guardarDiagnostico', () => {
  it('columna vacía ⇒ escribe con receivedAt del servidor', async () => {
    await expect(guardarDiagnostico(posId, reporte(A, 2), T1)).resolves.toBe(true)
    expect((await leer()).deviceDiagnostics).toEqual({ ...reporte(A, 2), receivedAt: T1.toISOString() })
  })

  it('misma apertura y misma revisión ⇒ no escribe (el sondeo de cada 15–20 s con la misma cabecera)', async () => {
    await guardarDiagnostico(posId, reporte(A, 2), T1)
    await expect(guardarDiagnostico(posId, reporte(A, 2, { paintMs: 1 }), T2)).resolves.toBe(false)
    expect((await leer()).deviceDiagnostics).toEqual({ ...reporte(A, 2), receivedAt: T1.toISOString() })
  })

  it('misma apertura y rev mayor ⇒ reemplaza; rev menor ⇒ no escribe (el atrasado no pisa al nuevo)', async () => {
    await guardarDiagnostico(posId, reporte(A, 2), T1)
    await expect(guardarDiagnostico(posId, reporte(A, 3), T2)).resolves.toBe(true)
    await expect(guardarDiagnostico(posId, reporte(A, 2), T2)).resolves.toBe(false)
    expect((await leer()).deviceDiagnostics).toEqual({ ...reporte(A, 3), receivedAt: T2.toISOString() })
  })

  it('otra apertura reemplaza aunque su rev sea menor, y lo guardado es sólo el reporte', async () => {
    await guardarDiagnostico(posId, reporte(A, 7), T1)
    await expect(guardarDiagnostico(posId, reporte(B, 1), T2)).resolves.toBe(true)
    const guardado = (await leer()).deviceDiagnostics
    expect(guardado).toEqual({ ...reporte(B, 1), receivedAt: T2.toISOString() })
    expect(guardado).not.toHaveProperty('prevProc')
  })

  it('la secuencia de la auditoría: un atrasado de la apertura anterior pisa un instante y la apertura viva lo corrige', async () => {
    await expect(guardarDiagnostico(posId, reporte(B, 1), T1)).resolves.toBe(true) // la apertura nueva guarda primero
    await expect(guardarDiagnostico(posId, reporte(A, 1), T2)).resolves.toBe(true) // llega tarde la anterior: se acepta
    expect((await leer()).deviceDiagnostics).toMatchObject({ proc: A, rev: 1 })
    await expect(guardarDiagnostico(posId, reporte(B, 1), T2)).resolves.toBe(true) // el siguiente sondeo de la viva lo corrige
    expect((await leer()).deviceDiagnostics).toMatchObject({ proc: B, rev: 1 })
    await expect(guardarDiagnostico(posId, reporte(B, 2), T2)).resolves.toBe(true)
    await expect(guardarDiagnostico(posId, reporte(B, 1), T2)).resolves.toBe(false) // atrasado de la misma apertura: no
    const guardado = (await leer()).deviceDiagnostics
    expect(guardado).toEqual({ ...reporte(B, 2), receivedAt: T2.toISOString() })
    expect(guardado).not.toHaveProperty('prevProc')
  })

  it('un valor viejo con la llave prevProc no estorba y desaparece en la siguiente escritura', async () => {
    await poner({ ...reporte(A, 7), receivedAt: T1.toISOString(), prevProc: B })
    await expect(guardarDiagnostico(posId, reporte(B, 1), T2)).resolves.toBe(true)
    expect((await leer()).deviceDiagnostics).toEqual({ ...reporte(B, 1), receivedAt: T2.toISOString() })
  })

  it.each([
    ['una cadena', 'basura'],
    ['un arreglo', [1, 2]],
    ['rev de texto en la misma apertura', { ...reporte(A, 9), rev: 'x' }],
    ['rev decimal', { ...reporte(A, 9), rev: 9.5 }],
    ['proc que no es texto', { ...reporte(A, 9), proc: 12345678 }],
  ])('lo guardado es %s ⇒ reemplaza sin lanzar', async (_caso, raro) => {
    await poner(raro as Prisma.InputJsonValue)
    await expect(guardarDiagnostico(posId, reporte(A, 2), T1)).resolves.toBe(true)
    expect((await leer()).deviceDiagnostics).toMatchObject({ proc: A, rev: 2, receivedAt: T1.toISOString() })
  })

  it('una ficha TPV_ANDROID ⇒ no escribe', async () => {
    await expect(guardarDiagnostico(tpvId, reporte(A, 2), T1)).resolves.toBe(false)
    expect((await leer(tpvId)).deviceDiagnostics).toBeNull()
  })

  it('no toca lastHeartbeat', async () => {
    await guardarDiagnostico(posId, reporte(A, 2), T1)
    await guardarDiagnostico(posId, reporte(B, 1), T2)
    expect((await leer()).lastHeartbeat).toEqual(LATIDO)
  })

  it('con la fila tomada por otra transacción falla en ~2 s sin colgarse', async () => {
    let tomado!: () => void
    let soltar!: () => void
    const yaTomada = new Promise<void>(r => (tomado = r))
    const retenida = new Promise<void>(r => (soltar = r))
    const otra = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${posId} FOR UPDATE`
        tomado()
        await retenida
      },
      { timeout: 20_000 },
    )
    await yaTomada

    // Sin la espera corta, la sentencia esperaría para siempre: la prueba se rinde a los 6 s y suelta la fila.
    const t0 = Date.now()
    let error: unknown
    let rendirse: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        guardarDiagnostico(posId, reporte(A, 2), T1),
        new Promise((_ok, mal) => {
          rendirse = setTimeout(() => mal(new Error('colgada: la sentencia no tiene espera corta')), 6_000)
        }),
      ])
    } catch (e) {
      error = e
    } finally {
      clearTimeout(rendirse)
      soltar()
    }
    const espera = Date.now() - t0
    await otra

    expect(String(error)).toMatch(/lock timeout|55P03/i)
    // El error real de Prisma se reconoce como espera de la base: va a debug, no llena el log.
    expect(esEsperaDeLaBase(error)).toBe(true)
    expect(espera).toBeGreaterThanOrEqual(1_500)
    expect(espera).toBeLessThan(4_500)
    expect((await leer()).deviceDiagnostics).toBeNull()
  })
})

describe('contrato: lo que ya devuelven las pantallas no trae el reporte', () => {
  const MARCA = 'marca-de-contrato-dibujo'

  it('la lista de aparatos, editar un aparato, la ficha de organización y las dos del SUPERADMIN', async () => {
    await guardarDiagnostico(posId, reporte(A, 2, { cpu: MARCA }), T1)
    expect(JSON.stringify((await leer()).deviceDiagnostics)).toContain(MARCA)

    const respuestas = {
      lista: await getTerminalsData(venueId, 1, 10, {}),
      editar: await updateTpv(venueId, posId, { name: 'PC renombrada' } as Parameters<typeof updateTpv>[2]),
      organizacion: await getTerminalForOrg(orgId, posId),
      superadminLista: await getAllTerminals({ venueId }),
      superadminFicha: await getTerminalById(posId),
    }

    for (const [cual, respuesta] of Object.entries(respuestas)) {
      const texto = JSON.stringify(respuesta)
      expect({ cual, trae: texto.includes(posId) }).toEqual({ cual, trae: true })
      expect({ cual, campo: texto.includes('deviceDiagnostics'), marca: texto.includes(MARCA) }).toEqual({
        cual,
        campo: false,
        marca: false,
      })
    }
  })

  it('la ficha de UN aparato sí lo trae, tal cual está guardado', async () => {
    await guardarDiagnostico(posId, reporte(A, 7, { cpu: MARCA }), T1)
    await guardarDiagnostico(posId, reporte(B, 1, { cpu: MARCA }), T2)
    const guardado = (await leer()).deviceDiagnostics
    expect(guardado).toMatchObject({ proc: B, rev: 1, cpu: MARCA })

    const ficha = await getTpvById(venueId, posId)
    expect(ficha.id).toBe(posId)
    expect(ficha.deviceDiagnostics).toEqual(guardado)

    // Sin reporte, la ficha lo dice con null (no lo esconde).
    await poner(Prisma.DbNull)
    expect((await getTpvById(venueId, posId)).deviceDiagnostics).toBeNull()
  })
})
