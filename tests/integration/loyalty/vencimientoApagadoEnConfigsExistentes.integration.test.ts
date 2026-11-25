/**
 * D27, decisión del founder (25-nov): el vencimiento queda APAGADO en las configuraciones que ya existían. Todas traían 365 días, el valor
 * de origen que nadie eligió; con los puntos venciendo de verdad, dejarlo así habría prendido el vencimiento sin que nadie lo pidiera.
 * La migración `20261125190100_lealtad_vencimiento_apagado_en_configs_existentes` pone en null SÓLO las de 365.
 *
 * La prueba corre el SQL de esa migración dentro de una transacción que se deshace al final: así no toca configuraciones de otras pruebas
 * que corren en la misma base.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import prisma from '@/utils/prismaClient'
import { vencerPuntosDelNegocio } from '@/services/loyalty/vencimientoDePuntos'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

const MIGRACION = join(
  __dirname,
  '../../../prisma/migrations/20261125190100_lealtad_vencimiento_apagado_en_configs_existentes/migration.sql',
)
const DIA = 86_400_000
const venues: string[] = []
class Deshacer extends Error {}

async function negocioConDias(prefijo: string, dias: number | null, active = true) {
  const { venueId } = await crearNegocioDePrueba(prefijo)
  venues.push(venueId)
  await prisma.loyaltyConfig.create({ data: { venueId, active, pointsPerDollar: 1, pointsPerVisit: 0, pointsExpireDays: dias } })
  return venueId
}

afterAll(async () => {
  for (const venueId of venues) {
    if (!venueId) continue // sin negocio no se borra nada
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
    await limpiarNegocioDePrueba(venueId)
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  }
  await prisma.$disconnect()
})

describe('D27 · el vencimiento queda apagado en las configuraciones que ya existían', () => {
  it('la migración pone en null SÓLO los 365 de origen (activos o apagados); otros valores y los null no cambian', async () => {
    const con365 = await negocioConDias('venc-365', 365)
    const con365Apagado = await negocioConDias('venc-365-off', 365, false)
    const con30 = await negocioConDias('venc-30', 30)
    const sinDias = await negocioConDias('venc-null', null)
    const sql = readFileSync(MIGRACION, 'utf8')

    let despues: Record<string, { dias: number | null; activo: boolean }> = {}
    await expect(
      prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(sql)
        const filas = await tx.loyaltyConfig.findMany({
          where: { venueId: { in: [con365, con365Apagado, con30, sinDias] } },
          select: { venueId: true, pointsExpireDays: true, active: true },
        })
        despues = Object.fromEntries(filas.map(f => [f.venueId, { dias: f.pointsExpireDays, activo: f.active }]))
        throw new Deshacer('se deshace a propósito')
      }),
    ).rejects.toBeInstanceOf(Deshacer)

    // Sólo cambian los días: el programa sigue prendido o apagado como estaba.
    expect(despues).toEqual({
      [con365]: { dias: null, activo: true },
      [con365Apagado]: { dias: null, activo: false },
      [con30]: { dias: 30, activo: true },
      [sinDias]: { dias: null, activo: true },
    })
  })

  it('con la expiración en null, el negocio no vence a nadie ni arranca su reloj', async () => {
    const venueId = await negocioConDias('venc-apagado', null)
    const { id: customerId } = await prisma.customer.create({
      data: { venueId, firstName: 'Inactivo', phone: '+525566990001', loyaltyPoints: 500 },
    })

    const r = await vencerPuntosDelNegocio(venueId, () => new Date(Date.now() + 1000 * DIA))

    expect(r).toEqual(expect.objectContaining({ customersAffected: 0, pointsExpired: 0, anclaFijada: false }))
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).loyaltyPoints).toBe(500)
    expect((await prisma.loyaltyConfig.findUniqueOrThrow({ where: { venueId } })).pointsExpireSince).toBeNull()
  })
})
