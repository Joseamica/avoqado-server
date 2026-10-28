/**
 * H0 (28-oct-2026), contra Postgres de verdad (Codex r2: las pruebas unitarias simulan la base y no demuestran la carrera
 * ni el todo-o-nada). El alta con el plan confirmado se termina sola desde el cobro, el aviso de Stripe, el barrido o el
 * botón «Entrar», y pueden llegar A LA VEZ: gana uno, los demás ven «ya terminada», y el alta queda con sus tres marcas
 * (progreso, negocio y organización) y UNA sola entrada en la bitácora.
 * Promesa: Avoqado/docs/audit/2026-10-28-alta-pagada-se-termina-sola/promesa.md.
 */
import prisma from '@/utils/prismaClient'
import { terminarAltaCobrada } from '@/services/onboarding/terminarAltaCobrada'
// La integración simula la bitácora para TODAS las suites (tests/__helpers__/integration-setup.ts): se cuentan sus
// llamadas por organización, no filas.
import { logAction } from '@/services/dashboard/activity-log.service'

const SUFIJO = `alta${Date.now().toString(36)}`
const organizaciones: string[] = []
let n = 0

async function crearAlta(
  opciones: { plan?: 'ACTIVE' | 'IN_PROGRESS' | 'NONE'; progresoTerminado?: boolean; hybridPurchaseId?: string } = {},
) {
  n += 1
  const org = await prisma.organization.create({
    data: { name: `Org ${SUFIJO} ${n}`, email: `o${n}-${SUFIJO}@test.local`, phone: '5500000000' },
  })
  organizaciones.push(org.id)
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: `Tacos ${SUFIJO} ${n}`, slug: `tacos-${SUFIJO}-${n}`, status: 'ONBOARDING' },
  })
  await prisma.onboardingProgress.create({
    data: {
      organizationId: org.id,
      completedSteps: [],
      wizardVersion: 2,
      planActivationStatus: opciones.plan ?? 'ACTIVE',
      termsAcceptedAt: new Date(),
      ...(opciones.progresoTerminado ? { completedAt: new Date(), currentStep: 7 } : {}),
      v2SetupData: {
        step2: { businessName: `Tacos ${SUFIJO} ${n}` },
        plan: {
          tier: 'PRO',
          interval: 'monthly',
          payNow: true,
          ...(opciones.hybridPurchaseId ? { hybridPurchaseId: opciones.hybridPurchaseId } : {}),
        },
      },
    },
  })
  return { orgId: org.id, venueId: venue.id }
}

async function marcas(orgId: string, venueId: string) {
  const [p, o, v] = await Promise.all([
    prisma.onboardingProgress.findUnique({ where: { organizationId: orgId }, select: { completedAt: true } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { onboardingCompletedAt: true } }),
    prisma.venue.findUnique({ where: { id: venueId }, select: { status: true } }),
  ])
  const bitacora = (logAction as jest.Mock).mock.calls.filter(
    ([a]) => a?.organizationId === orgId && a?.action === 'ONBOARDING_COMPLETED',
  ).length
  return { progreso: !!p?.completedAt, organizacion: !!o?.onboardingCompletedAt, negocio: v?.status, bitacora }
}

/** `logAction` va sin esperar: se le da un respiro antes de contar sus llamadas. */
const bitacoraAlDia = () => new Promise(r => setTimeout(r, 50))

afterAll(async () => {
  if (organizaciones.length === 0) return
  await prisma.onboardingProgress.deleteMany({ where: { organizationId: { in: organizaciones } } })
  await prisma.venue.deleteMany({ where: { organizationId: { in: organizaciones } } })
  await prisma.organization.deleteMany({ where: { id: { in: organizaciones } } })
  await prisma.$disconnect()
})

describe('terminarAltaCobrada contra Postgres', () => {
  it('🔴 seis cierres a la vez: gana UNO, el alta queda con sus tres marcas y una sola entrada en la bitácora', async () => {
    const { orgId, venueId } = await crearAlta()

    const resultados = await Promise.all(
      (['cobro', 'aviso-stripe', 'barrido', 'navegador', 'cobro', 'barrido'] as const).map(via =>
        terminarAltaCobrada(orgId, { via, repararParcial: via === 'barrido' }),
      ),
    )
    await bitacoraAlDia()

    expect(resultados.filter(r => r.estado === 'TERMINADA')).toHaveLength(1)
    for (const r of resultados) expect(['TERMINADA', 'YA_TERMINADA', 'NADA']).toContain(r.estado)
    expect(await marcas(orgId, venueId)).toEqual({ progreso: true, organizacion: true, negocio: 'ACTIVE', bitacora: 1 })
  })

  it('después de terminar, un cierre más contesta YA_TERMINADA sin escribir', async () => {
    const { orgId, venueId } = await crearAlta()
    await terminarAltaCobrada(orgId, { via: 'cobro' })
    const r = await terminarAltaCobrada(orgId, { via: 'navegador' })
    await bitacoraAlDia()
    expect(r.estado).toBe('YA_TERMINADA')
    expect((await marcas(orgId, venueId)).bitacora).toBe(1)
  })

  it('🔴 un cierre a medias (progreso marcado, organización y negocio no) sólo lo repara el barrido', async () => {
    const { orgId, venueId } = await crearAlta({ progresoTerminado: true })

    expect(await terminarAltaCobrada(orgId, { via: 'cobro' })).toEqual({ estado: 'NADA', motivo: 'CIERRE_EN_CURSO' })
    expect(await marcas(orgId, venueId)).toMatchObject({ organizacion: false, negocio: 'ONBOARDING' })

    const r = await terminarAltaCobrada(orgId, { via: 'barrido', repararParcial: true })
    expect(r.estado).toBe('TERMINADA')
    expect(await marcas(orgId, venueId)).toMatchObject({ progreso: true, organizacion: true, negocio: 'ACTIVE' })
  })

  it.each(['IN_PROGRESS', 'NONE'] as const)('🔴 con el plan en %s no toca nada', async plan => {
    const { orgId, venueId } = await crearAlta({ plan })
    const r = await terminarAltaCobrada(orgId, { via: 'barrido', repararParcial: true })
    expect(r).toEqual({ estado: 'NADA', motivo: 'PLAN_NO_CONFIRMADO' })
    expect(await marcas(orgId, venueId)).toEqual({ progreso: false, organizacion: false, negocio: 'ONBOARDING', bitacora: 0 })
  })

  it('🔴 si la guardia de compra híbrida rechaza dentro del candado, no queda NADA escrito', async () => {
    const { orgId, venueId } = await crearAlta({ hybridPurchaseId: 'cnoexiste000000000000000000' })
    await expect(terminarAltaCobrada(orgId, { via: 'cobro' })).rejects.toMatchObject({ code: 'HYBRID_ACTIVATION_PENDING' })
    expect(await marcas(orgId, venueId)).toEqual({ progreso: false, organizacion: false, negocio: 'ONBOARDING', bitacora: 0 })
  })
})
