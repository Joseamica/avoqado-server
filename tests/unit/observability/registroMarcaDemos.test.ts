/**
 * Los 6 negocios demo de prospectos se llaman normal («Café Tostado», «Lunaria Boutique») y escriben en el mismo registro
 * que los negocios reales. El founder (1-nov): «cuidado con las alertas de los demos, que no se confundan con productivas».
 * El inventario de Codex encontró 26 tipos de aviso que un demo puede disparar (sobrepago, comanda atorada, tarjeta de regalo
 * no entregada, caja cerrada sola…). El formateador del registro marca «🧪 DEMO ·» y `demo: true` toda línea de un negocio
 * `LIVE_DEMO`: por el id del emisor, por el negocio que fija un job o por la sesión (nunca la de un SUPERADMIN, nunca por nombre).
 */
import type { Logform } from 'winston'
import prisma from '@/utils/prismaClient'
import { contextFormat } from '@/observability/logContext'
import { runWithContext } from '@/observability/executionContext'
import { primeVenueNames, marcarNegocioDemo, __resetVenueNameCacheForTests } from '@/observability/venueNames'

const prismaMock = prisma as unknown as { venue: { findMany: jest.Mock } }

const apply = (info: Partial<Logform.TransformableInfo>): Record<string, unknown> =>
  contextFormat().transform(info as Logform.TransformableInfo) as unknown as Record<string, unknown>

const DEMO = 'cdemo000000000000000000aa'
const REAL = 'creal000000000000000000aa'
const ctx = (venueId: string, venueName: string) => ({ correlationId: 'c', source: 'job' as const, entrypoint: 'x', venueId, venueName })

beforeEach(async () => {
  __resetVenueNameCacheForTests()
  prismaMock.venue.findMany.mockReset()
  prismaMock.venue.findMany.mockResolvedValue([
    { id: DEMO, name: 'Café Tostado', status: 'LIVE_DEMO' },
    { id: REAL, name: 'Testarudo Cafe', status: 'ACTIVE' },
    { id: 'cdemo000000000000000000bb', name: 'Lunaria Boutique', status: 'LIVE_DEMO' },
  ])
  await primeVenueNames()
})

it('🔴 una línea de un negocio demo (por el contexto) sale marcada', () => {
  runWithContext(ctx(DEMO, 'Café Tostado'), () => {
    const r = apply({ level: 'error', message: '🚨 [KDS] comanda sin armar' })
    expect(r.demo).toBe(true)
    expect(r.message).toBe('🧪 DEMO · 🚨 [KDS] comanda sin armar')
  })
})

it('🔴 también cuando el emisor pasa el negocio en sus campos y no hay contexto', () => {
  const r = apply({ level: 'warn', message: 'Caja cerrada automáticamente', venueId: DEMO })
  expect(r.demo).toBe(true)
  expect(r.message).toBe('🧪 DEMO · Caja cerrada automáticamente')
})

it('🔴 sólo el NOMBRE no basta: un negocio real puede llamarse igual que un demo (Codex r1)', () => {
  for (const venueName of ['Café Tostado', 'Lunaria Boutique']) {
    const r = apply({ level: 'error', message: '🚨 sobrepago', venueName })
    expect(r.demo).toBeUndefined()
    expect(r.message).toBe('🚨 sobrepago')
  }
})

it('🔴 la sesión de un SUPERADMIN que está en un demo no marca lo que hace en otro negocio (Codex r1)', () => {
  runWithContext({ ...ctx(DEMO, 'Café Tostado'), role: 'SUPERADMIN' }, () => {
    expect(apply({ level: 'error', message: 'Error al aprobar el KYC de Testarudo' }).demo).toBeUndefined()
  })
})

it('pero lo que un job fija para un negocio demo sí se marca, aunque corra con sesión de SUPERADMIN', () => {
  runWithContext({ ...ctx(DEMO, 'Café Tostado'), role: 'SUPERADMIN', negocioFijado: DEMO }, () => {
    expect(apply({ level: 'error', message: '❌ [CLEANUP] Could not delete abandoned order CAFE-0012' }).demo).toBe(true)
  })
})

it('regresión: una línea de un negocio real no cambia', () => {
  runWithContext(ctx(REAL, 'Testarudo Cafe'), () => {
    const r = apply({ level: 'error', message: '🚨 sobrepago' })
    expect(r.demo).toBeUndefined()
    expect(r.message).toBe('🚨 sobrepago')
  })
})

it('el campo del emisor manda sobre el contexto: un real dentro de un contexto demo no se marca', () => {
  runWithContext(ctx(DEMO, 'Café Tostado'), () => {
    expect(apply({ level: 'error', message: 'x', venueId: REAL }).demo).toBeUndefined()
  })
})

it('no se marca dos veces un mensaje que ya dice que es demo', () => {
  runWithContext(ctx(DEMO, 'Café Tostado'), () => {
    expect(apply({ level: 'error', message: '🚨 Negocio demo «Café Tostado» no se pudo sembrar' }).message).toBe(
      '🚨 Negocio demo «Café Tostado» no se pudo sembrar',
    )
  })
})

it('🔴 el negocio que crea el reinicio de las 3:00 se marca desde su primera línea, sin esperar la recarga', () => {
  const NUEVO = 'cnuevo00000000000000000aa'
  marcarNegocioDemo(NUEVO)
  runWithContext({ ...ctx(NUEVO, 'Café Tostado'), negocioFijado: NUEVO }, () => {
    expect(apply({ level: 'error', message: 'x' }).demo).toBe(true)
  })
})

it('lo marcado por la semilla no lo borra una recarga que ya había salido antes de crearlo', async () => {
  const NUEVO = 'cnuevo00000000000000000bb'
  marcarNegocioDemo(NUEVO)
  await primeVenueNames() // la consulta simulada no trae el negocio nuevo
  expect(apply({ level: 'error', message: 'x', venueId: NUEVO }).demo).toBe(true)
})
