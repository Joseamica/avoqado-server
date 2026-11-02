/**
 * El formulario del alta no se pisa entre pestañas (20-oct-2026, deuda de la campaña 3DS, Codex r2 #1).
 *
 * `saveV2StepData`, el cierre del plan y el checklist de cobros leían `v2SetupData` ENTERO y lo reescribían: si dos
 * escrituras se cruzaban, la segunda borraba lo de la primera. El caso caro: una pestaña guarda un paso mientras otra
 * cierra el plan ⇒ el plan cobrado desaparece, «Terminar alta» dice «Falta elegir tu plan» y volver a activarlo da 409.
 *
 * Aquí se reproduce de verdad contra Postgres: una transacción toma la fila (como otra pestaña a media escritura), las
 * escrituras se forman detrás del candado, y al soltar se revisa que TODO sobreviva.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { acceptV2Terms, fusionarV2SetupData, saveV2StepData } from '@/services/onboarding/onboardingProgress.service'

const stamp = `${Date.now()}${process.pid}`
let organizationId: string

/** Espera a que `n` sesiones estén formadas detrás de un candado de fila (no un tiempo fijo). */
async function esperarEnLaFila(n: number) {
  for (let i = 0; i < 100; i++) {
    const [{ esperando }] = await prisma.$queryRaw<{ esperando: number }[]>`
      SELECT count(*)::int AS esperando FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (esperando >= n) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`nunca hubo ${n} escrituras esperando el candado`)
}

/**
 * Toma la fila del alta y la suelta cuando se le pide; `antesDeSoltar` escribe con la fila tomada. Hay que esperar
 * `tomada` ANTES de lanzar las escrituras: si no, en un CI cargado una escritura corría antes del FOR UPDATE, terminaba
 * sin formarse y `esperarEnLaFila` agotaba su espera (main, 22-oct-2026, tres intentos seguidos).
 */
function tomarLaFila(antesDeSoltar?: (tx: any) => Promise<unknown>) {
  let soltar!: () => void
  let marcarTomada!: () => void
  const suelta = new Promise<void>(r => (soltar = r))
  const tomada = new Promise<void>(r => (marcarTomada = r))
  const listo = prisma.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT id FROM "OnboardingProgress" WHERE "organizationId" = ${organizationId} FOR UPDATE`
      marcarTomada()
      await suelta
      if (antesDeSoltar) await antesDeSoltar(tx)
    },
    { timeout: 20_000 },
  )
  return { soltar, listo, tomada: Promise.race([tomada, listo.then(() => {})]) }
}

const leer = () => prisma.onboardingProgress.findUniqueOrThrow({ where: { organizationId } })

beforeAll(async () => {
  if (!/test/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  const org = await prisma.organization.create({
    data: { name: `alta-${stamp}`, email: `alta-${stamp}@example.test`, phone: '5550000000' },
  })
  organizationId = org.id
})

beforeEach(async () => {
  await prisma.onboardingProgress.upsert({
    where: { organizationId },
    create: {
      organizationId,
      currentStep: 2,
      completedSteps: [1, 2],
      wizardVersion: 2,
      v2SetupData: { step2: { businessName: 'Café Ámbar' } },
    },
    update: { currentStep: 2, completedSteps: [1, 2], v2SetupData: { step2: { businessName: 'Café Ámbar' } } },
  })
})

afterAll(async () => {
  if (!organizationId) return
  await prisma.onboardingProgress.deleteMany({ where: { organizationId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
})

describe('el formulario del alta no se pisa entre pestañas', () => {
  it('🔴 dos pestañas guardan pasos distintos al mismo tiempo: los dos sobreviven, y los dos quedan como hechos', async () => {
    const fila = tomarLaFila()
    await fila.tomada
    const pestanaA = saveV2StepData(organizationId, 3, { businessType: 'CAFE' })
    const pestanaB = saveV2StepData(organizationId, 4, { entityType: 'PERSONA_FISICA' })
    await esperarEnLaFila(2)
    fila.soltar()
    await Promise.all([fila.listo, pestanaA, pestanaB])

    const p = await leer()
    expect(p.v2SetupData).toEqual({
      step2: { businessName: 'Café Ámbar' },
      step3: { businessType: 'CAFE' },
      step4: { entityType: 'PERSONA_FISICA' },
    })
    expect([...(p.completedSteps as number[])].sort()).toEqual([1, 2, 3, 4])
  })

  it('🔴 cerrar el plan mientras otra pestaña guarda un paso: el plan ya cobrado NO desaparece', async () => {
    const plan = { tier: 'PRO', interval: 'monthly', payNow: false, acceptedAt: '2026-10-20T10:00:00.000Z' }
    // El cierre del plan escribe con la fila tomada; el guardado del paso ya está formado detrás.
    const fila = tomarLaFila(tx => fusionarV2SetupData(tx, organizationId, { plan }))
    await fila.tomada
    const pestana = saveV2StepData(organizationId, 5, { rfc: 'XAXX010101000' })
    await esperarEnLaFila(1)
    fila.soltar()
    await Promise.all([fila.listo, pestana])

    const v2 = (await leer()).v2SetupData as Record<string, unknown>
    expect(v2.plan).toEqual(plan)
    expect(v2.step5).toEqual({ rfc: 'XAXX010101000' })
    expect(v2.step2).toEqual({ businessName: 'Café Ámbar' })
  })

  it('guardar el mismo paso otra vez lo reemplaza (como siempre) y no lo duplica en los pasos hechos', async () => {
    await saveV2StepData(organizationId, 3, { businessType: 'CAFE', viejo: true })
    await saveV2StepData(organizationId, 3, { businessType: 'BAR' })

    const p = await leer()
    expect((p.v2SetupData as Record<string, unknown>).step3).toEqual({ businessType: 'BAR' })
    expect(p.completedSteps).toEqual([1, 2, 3])
    expect(p.currentStep).toBe(4)
  })

  it('fusionar DENTRO de una sección conserva sus otros campos y las demás secciones (checklist de cobros)', async () => {
    await saveV2StepData(organizationId, 7, { clabe: '002180000000000000', accountHolder: 'Ana', bankName: 'Banamex' })

    await fusionarV2SetupData(prisma, organizationId, {}, { step7: { accountHolder: 'Ana Pérez' }, step4: { entityType: 'PERSONA_MORAL' } })

    const v2 = (await leer()).v2SetupData as Record<string, unknown>
    expect(v2.step7).toEqual({ clabe: '002180000000000000', accountHolder: 'Ana Pérez', bankName: 'Banamex' })
    expect(v2.step4).toEqual({ entityType: 'PERSONA_MORAL' })
    expect(v2.step2).toEqual({ businessName: 'Café Ámbar' })
  })

  it('con el formulario vacío (null) empieza desde {} y no truena', async () => {
    await prisma.onboardingProgress.update({ where: { organizationId }, data: { v2SetupData: Prisma.DbNull } })

    await fusionarV2SetupData(prisma, organizationId, { plan: { tier: 'PRO' } }, { step7: { clabe: '1' } })

    expect((await leer()).v2SetupData).toEqual({ plan: { tier: 'PRO' }, step7: { clabe: '1' } })
  })

  it('🔴 aceptar términos con una lectura VIEJA (antes de que otra pestaña guardara el paso 7) no borra el 7 (Codex r1)', async () => {
    // La carrera real: «aceptar términos» leyó [1,2], otra pestaña agregó el 7 y después términos escribió su copia.
    // Se fuerza esa lectura vieja para que la prueba no dependa de quién gane la carrera.
    await saveV2StepData(organizationId, 7, { clabe: '002180000000000000' })
    const fotoVieja = { ...(await leer()), completedSteps: [1, 2] }
    const lectura = jest.spyOn(prisma.onboardingProgress, 'upsert').mockResolvedValueOnce(fotoVieja as any)

    await acceptV2Terms(organizationId, 'v1', '127.0.0.1')
    lectura.mockRestore()

    const p = await leer()
    expect([...(p.completedSteps as number[])].sort((a, b) => a - b)).toEqual([1, 2, 6, 7])
    expect(p.termsAcceptedAt).not.toBeNull()
  })

  it('🔴 la hora del último cambio se guarda tal cual, sin el desfase de la zona de la base (Codex r1)', async () => {
    // El revisor de altas a medio pago usa `updatedAt` para saber si un alta lleva 15 min quieta: 6 h de desfase la
    // haría parecer abandonada (o recién tocada) según la zona del Postgres.
    const antes = Date.now()
    await saveV2StepData(organizationId, 3, { businessType: 'CAFE' })
    await fusionarV2SetupData(prisma, organizationId, { plan: { tier: 'PRO' } })
    const despues = Date.now()

    const { updatedAt } = await leer()
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(antes - 2_000)
    expect(updatedAt.getTime()).toBeLessThanOrEqual(despues + 2_000)
  })
})
