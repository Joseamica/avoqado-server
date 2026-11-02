// tests/integration/customer-display/customerDisplayAck.integration.test.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  acknowledgeCustomerDisplay,
  armarAcuse,
  getMobileCustomerDisplay,
  type AckInput,
} from '@/services/customer-display/customerDisplayMobile.service'
import { getEffectiveDesign, invalidateCustomerDisplayCache } from '@/services/customer-display/customerDisplayDesign.service'
import { esperarBloqueado, retenerTerminal } from './barrera'

/**
 * El ack contra Postgres: la lectura como texto y la escritura condicionada (binding + instalación + el acuse leído, tal cual)
 * sólo se prueban con la base; las carreras, con la barrera de la fila (`barrera.ts`).
 */
const suffix = `ack-${Date.now()}`
const DEVICE = `dev-${suffix}`
let orgId: string
let venueId: string
let otroVenueId: string
let terminalId: string

const acuse = (over: Partial<AckInput> = {}): AckInput => ({
  installationId: 'inst-1',
  fingerprint: 'a'.repeat(32),
  seq: 1,
  storedAt: new Date(Date.now() - 1_000).toISOString(),
  shownAt: null,
  surface: null,
  imagesReady: 0,
  imagesPending: 0,
  imagesFailed: 0,
  unsupportedSchema: false,
  ...over,
})
const guardado = async () =>
  (await prisma.terminal.findUniqueOrThrow({ where: { id: terminalId }, select: { customerDisplayAck: true } })).customerDisplayAck as any

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  const venue = (n: string) =>
    prisma.venue.create({
      data: { organizationId: orgId, name: `${n} ${suffix}`, slug: `${n}-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  venueId = (await venue('a')).id
  otroVenueId = (await venue('b')).id
  terminalId = (
    await prisma.terminal.create({
      data: {
        venueId,
        name: 'Caja',
        type: 'POS_ANDROID',
        deviceUid: DEVICE,
        customerDisplayDesignVersion: 1,
        customerDisplayInstallationId: 'inst-1',
      },
      select: { id: true },
    })
  ).id
})

beforeEach(async () => {
  if (!terminalId) return
  invalidateCustomerDisplayCache(terminalId)
  await prisma.terminal.update({
    where: { id: terminalId },
    data: { customerDisplayAck: Prisma.DbNull, customerDisplayInstallationId: 'inst-1' },
  })
})

afterAll(async () => {
  if (!venueId || !otroVenueId) return // sin esta guarda, un id undefined vaciaría tablas enteras (8-oct)
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, otroVenueId] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

it('la ficha móvil sale por el binding exacto y deja su huella para el poll', async () => {
  const r = await getMobileCustomerDisplay(venueId, DEVICE)
  expect(r.terminalId).toBe(terminalId)
  expect(r.imageOrigins).toHaveLength(2)
  expect((await getEffectiveDesign(venueId, terminalId, { cache: true })).ficha.fingerprint).toBe(r.ficha.fingerprint)
})

it('sin binding (otro negocio, u otro aparato): 404 idéntico', async () => {
  await expect(getMobileCustomerDisplay(otroVenueId, DEVICE)).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_FOUND' })
  await expect(getMobileCustomerDisplay(venueId, 'otro-aparato')).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_FOUND' })
  await expect(acknowledgeCustomerDisplay(otroVenueId, DEVICE, acuse())).rejects.toMatchObject({ statusCode: 404 })
})

// 🔴 Codex r1 #12: la versión anterior nunca cambiaba la base después de llenar la caché, así que pasaba leyendo la caché.
it('🔴 current se decide CONTRA LA BASE, con la caché del poll atrasada a propósito', async () => {
  // 1. La caché del poll se llena con la ficha de hoy…
  const vieja = (await getEffectiveDesign(venueId, terminalId, { cache: true })).ficha.fingerprint
  // 2. …y el diseño cambia en la base SIN pasar por el servicio: nadie invalida esa caché.
  await prisma.customerDisplayDesign.create({ data: { terminalId, welcomeText: 'Hola de nuevo' } })
  try {
    const fresca = (await getEffectiveDesign(venueId, terminalId)).ficha.fingerprint // `cache: false`
    expect(fresca).not.toBe(vieja)
    expect((await getEffectiveDesign(venueId, terminalId, { cache: true })).ficha.fingerprint).toBe(vieja) // sí está atrasada
    // 3. El ack no le cree a la caché…
    expect(await acknowledgeCustomerDisplay(venueId, DEVICE, acuse({ fingerprint: fresca, seq: 1 }))).toEqual({
      accepted: true,
      current: true,
    })
    expect(await acknowledgeCustomerDisplay(venueId, DEVICE, acuse({ fingerprint: vieja, seq: 2 }))).toEqual({
      accepted: true,
      current: false,
      currentFingerprint: fresca,
    })
    expect((await guardado()).seq).toBe(2) // `accepted` = guardado, aunque no sea lo vigente
    // 4. …ni la ficha móvil.
    invalidateCustomerDisplayCache(terminalId)
    await getEffectiveDesign(venueId, terminalId, { cache: true }) // se vuelve a llenar…
    await prisma.customerDisplayDesign.update({ where: { terminalId }, data: { welcomeText: 'Otra vez' } }) // …y se atrasa
    const ultima = (await getEffectiveDesign(venueId, terminalId)).ficha.fingerprint
    expect((await getMobileCustomerDisplay(venueId, DEVICE)).ficha.fingerprint).toBe(ultima)
  } finally {
    await prisma.customerDisplayDesign.deleteMany({ where: { terminalId } })
  }
})

it('seq: uno viejo o igual se rechaza sin tocar lo guardado', async () => {
  await acknowledgeCustomerDisplay(venueId, DEVICE, acuse({ seq: 5 }))
  const antes = await guardado()
  expect(await acknowledgeCustomerDisplay(venueId, DEVICE, acuse({ seq: 4 }))).toEqual({ accepted: false, reason: 'STALE_SEQ' })
  expect(await acknowledgeCustomerDisplay(venueId, DEVICE, acuse({ seq: 5, fingerprint: 'c'.repeat(32) }))).toEqual({
    accepted: false,
    reason: 'STALE_SEQ',
  })
  expect(await guardado()).toEqual(antes)
})

// 🔴 Codex r1 #3 y #12: el reenvío es el MISMO objeto (la versión anterior volvía a llamar `acuse()`, que estrena hora).
it('🔴 un REENVÍO del mismo acuse se acepta sin escribir nada, ni la hora de llegada', async () => {
  const mismo = acuse({ seq: 5, shownAt: new Date(Date.now() - 500).toISOString() })
  await acknowledgeCustomerDisplay(venueId, DEVICE, mismo)
  const antes = await guardado()
  expect(await acknowledgeCustomerDisplay(venueId, DEVICE, mismo, new Date(Date.now() + 2_000))).toMatchObject({ accepted: true })
  expect(await guardado()).toEqual(antes)
})

it.each([
  ['otra hora de «mostrado»', { shownAt: '2026-01-01T00:00:00.000Z' }],
  ['otro unsupportedSchema', { unsupportedSchema: true }],
  ['otra superficie', { surface: 'kiosk' as const }],
])('🔴 misma huella y seq pero %s NO es un reenvío: STALE_SEQ y nada cambia', async (_caso, cambio) => {
  const original = acuse({ seq: 5 })
  await acknowledgeCustomerDisplay(venueId, DEVICE, original)
  const antes = await guardado()
  expect(await acknowledgeCustomerDisplay(venueId, DEVICE, { ...original, ...cambio })).toEqual({ accepted: false, reason: 'STALE_SEQ' })
  expect(await guardado()).toEqual(antes)
})

it('🔴 un acuse más nuevo que llega ENTRE la lectura y la escritura de otro gana: el CAS no lo pisa', async () => {
  const { pid, soltar, transaccion } = await retenerTerminal(terminalId)
  const viejo = acknowledgeCustomerDisplay(venueId, DEVICE, acuse({ seq: 2 })) // lee «sin acuse» y espera para escribir
  expect(await esperarBloqueado(pid, viejo)).toBe('bloqueada')
  const nuevo = JSON.stringify(armarAcuse(acuse({ seq: 3 }), new Date()))
  soltar(async tx => {
    await tx.$executeRaw`UPDATE "Terminal" SET "customerDisplayAck" = ${nuevo}::jsonb WHERE id = ${terminalId}`
  })
  await transaccion
  expect(await viejo).toEqual({ accepted: false, reason: 'STALE_SEQ' }) // releyó: ya hay un 3
  expect((await guardado()).seq).toBe(3)
})

it('🔴 un ack TARDÍO de otra instalación no ocupa el estado que el reporte de la nueva limpió', async () => {
  await prisma.terminal.update({ where: { id: terminalId }, data: { customerDisplayInstallationId: 'inst-nueva' } })
  expect(await acknowledgeCustomerDisplay(venueId, DEVICE, acuse({ installationId: 'inst-1', seq: 99 }))).toEqual({
    accepted: false,
    reason: 'OTHER_INSTALLATION',
  })
  expect(await guardado()).toBeNull()
})

it('una fila sin instalación registrada (recién mudada) también contesta OTHER_INSTALLATION: primero el reporte', async () => {
  await prisma.terminal.update({ where: { id: terminalId }, data: { customerDisplayInstallationId: null } })
  expect(await acknowledgeCustomerDisplay(venueId, DEVICE, acuse())).toEqual({ accepted: false, reason: 'OTHER_INSTALLATION' })
})

it('las horas adelantadas de la tablet se acotan a la de llegada y quedan marcadas', async () => {
  const ahora = new Date()
  await acknowledgeCustomerDisplay(venueId, DEVICE, acuse({ seq: 1, shownAt: new Date(ahora.getTime() + 3_600_000).toISOString() }), ahora)
  const a = await guardado()
  expect(a).toMatchObject({ receivedAt: ahora.toISOString(), shownAt: ahora.toISOString(), clientClockSkew: true })
})

// 🔴 Codex r1 #3 y #12 (Review Focus 2): lo que F1 y el MCP leen como «sin acuse» nunca bloquea — con un seq MENOR que el
// guardado, para que la prueba no pase por la comparación normal (la versión anterior reemplazaba un 3 con un 4).
it.each([
  ['un seq que no es número', { seq: 'no-es-numero' }],
  [
    'un receivedAt que no es ISO (el now()::text de una QA a mano), con seq 9',
    { fingerprint: 'x', seq: 9, receivedAt: '2026-10-14 10:00:00.123456-06' },
  ],
  [
    'un seq de 2^53, fuera del rango seguro: ningún seq válido lo supera',
    { fingerprint: 'a'.repeat(32), seq: 9007199254740992, receivedAt: '2026-10-14T16:00:00.000Z' },
  ],
  ['un arreglo', ['raro']],
])('🔴 un acuse guardado ilegible (%s) no bloquea: el siguiente lo reemplaza aunque su seq sea MENOR', async (_caso, basura) => {
  await prisma.terminal.update({ where: { id: terminalId }, data: { customerDisplayAck: basura as Prisma.InputJsonValue } })
  expect(await acknowledgeCustomerDisplay(venueId, DEVICE, acuse({ seq: 4 }))).toMatchObject({ accepted: true })
  const a = await guardado()
  expect(a.seq).toBe(4)
  expect(a.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

it('🔴 Review Focus 2: las horas se guardan en ISO-8601 con Z — F1 descarta todo acuse sin receivedAt ISO', async () => {
  await acknowledgeCustomerDisplay(
    venueId,
    DEVICE,
    acuse({ seq: 1, storedAt: '2026-01-01T09:00:00-06:00', shownAt: '2026-01-01T09:00:01.5-06:00' }),
  )
  const a = await guardado()
  const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  expect(a.receivedAt).toMatch(ISO_Z)
  expect(a.storedAt).toBe('2026-01-01T15:00:00.000Z')
  expect(a.shownAt).toBe('2026-01-01T15:00:01.500Z')
})

it('🔴 Review Focus 3: la ventana de Windows reporta su superficie y se guarda tal cual', async () => {
  expect(
    await acknowledgeCustomerDisplay(venueId, DEVICE, acuse({ seq: 1, surface: 'window', shownAt: new Date().toISOString() })),
  ).toMatchObject({
    accepted: true,
  })
  expect((await guardado()).surface).toBe('window')
})
