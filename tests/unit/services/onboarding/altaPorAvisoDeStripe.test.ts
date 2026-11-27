/**
 * H0 (28-oct-2026): el aviso de factura pagada de Stripe termina el alta en ~30 s si el navegador no lo hizo (el cliente
 * autorizó con su banco y cerró la página, o pagó y cerró antes de «Entrar»). Es un atajo: la garantía es el barrido
 * `altas-a-medio-pago`. Nunca cobra ni anula: sólo dispara los dos cierres que ya existen.
 */
jest.mock('@/services/onboarding/planActivation.service', () => ({ __esModule: true, cerrarAltaSinNavegador: jest.fn() }))
jest.mock('@/services/onboarding/terminarAltaCobrada', () => ({ __esModule: true, terminarAltaCobradaSinRomper: jest.fn() }))

import { cerrarAltaPorAvisoDeStripe, programarCierreDelAltaPorAviso } from '@/services/onboarding/altaPorAvisoDeStripe'
import { cerrarAltaSinNavegador } from '@/services/onboarding/planActivation.service'
import { terminarAltaCobradaSinRomper } from '@/services/onboarding/terminarAltaCobrada'
import { prismaMock } from '@tests/__helpers__/setup'

beforeEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()
  ;(cerrarAltaSinNavegador as jest.Mock).mockResolvedValue('CERRADA')
  ;(terminarAltaCobradaSinRomper as jest.Mock).mockResolvedValue(undefined)
})

describe('cerrarAltaPorAvisoDeStripe', () => {
  it('busca sólo el alta SIN terminar que apunta a esa suscripción', async () => {
    prismaMock.onboardingProgress.findFirst.mockResolvedValue(null)
    await cerrarAltaPorAvisoDeStripe('sub_1')
    expect(prismaMock.onboardingProgress.findFirst).toHaveBeenCalledWith({
      where: { planStripeSubscriptionId: 'sub_1', completedAt: null },
      select: { organizationId: true, planActivationStatus: true },
    })
    expect(cerrarAltaSinNavegador).not.toHaveBeenCalled()
    expect(terminarAltaCobradaSinRomper).not.toHaveBeenCalled()
  })

  it('esperando al banco (IN_PROGRESS) → el cierre sin navegador de R2, que sólo recupera lo ya cobrado', async () => {
    prismaMock.onboardingProgress.findFirst.mockResolvedValue({ organizationId: 'org-1', planActivationStatus: 'IN_PROGRESS' })
    await cerrarAltaPorAvisoDeStripe('sub_1')
    expect(cerrarAltaSinNavegador).toHaveBeenCalledWith('org-1', 'aviso-stripe')
    expect(terminarAltaCobradaSinRomper).not.toHaveBeenCalled()
  })

  it('plan ya ACTIVE sin terminar → el cierre todo-o-nada', async () => {
    prismaMock.onboardingProgress.findFirst.mockResolvedValue({ organizationId: 'org-1', planActivationStatus: 'ACTIVE' })
    await cerrarAltaPorAvisoDeStripe('sub_1')
    expect(terminarAltaCobradaSinRomper).toHaveBeenCalledWith('org-1', { via: 'aviso-stripe' })
    expect(cerrarAltaSinNavegador).not.toHaveBeenCalled()
  })

  it('🔴 aviso de factura pagada de una suscripción cuyo id no se guardó, con su metadata de versión e intento → registra el id y cierra; sin esa metadata, nada (como hoy)', async () => {
    // Nadie apunta a esa suscripción: la respuesta del create se perdió antes de guardar su id (b2-r1 #1).
    prismaMock.onboardingProgress.findFirst.mockResolvedValue(null)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      organizationId: 'org-1',
      completedAt: null,
      planActivationStatus: 'IN_PROGRESS',
      planActivationAttempt: 3,
      planStripeSubscriptionId: null,
    } as never)
    prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
    const metadata = { organizationId: 'org-1', planActivationKey: 'plan-activation:org-1:3', planOfferVersion: '2' }

    await cerrarAltaPorAvisoDeStripe('sub_1', metadata)

    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', planActivationAttempt: 3, planActivationStatus: 'IN_PROGRESS', planStripeSubscriptionId: null },
      data: { planStripeSubscriptionId: 'sub_1' },
    })
    expect(cerrarAltaSinNavegador).toHaveBeenCalledWith('org-1', 'aviso-stripe')

    // Sin esa metadata (sin versión, de otro intento u otra organización, o ya sin IN_PROGRESS): lo de hoy, nada.
    for (const otra of [
      undefined,
      null,
      {},
      { organizationId: 'org-1', planActivationKey: 'plan-activation:org-1:3' },
      { ...metadata, planActivationKey: 'plan-activation:org-1:2' },
      { ...metadata, planActivationKey: 'plan-activation:org-2:3' },
    ]) {
      jest.clearAllMocks()
      await cerrarAltaPorAvisoDeStripe('sub_1', otra as Record<string, string> | null | undefined)
      expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
      expect(cerrarAltaSinNavegador).not.toHaveBeenCalled()
    }

    // El CAS no tocó la fila (otro camino ya registró su id o el intento cambió): no se cierra desde aquí.
    jest.clearAllMocks()
    prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 0 } as never)
    await cerrarAltaPorAvisoDeStripe('sub_1', metadata)
    expect(cerrarAltaSinNavegador).not.toHaveBeenCalled()

    // Ya no está a medio pago: nada.
    jest.clearAllMocks()
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      organizationId: 'org-1',
      completedAt: null,
      planActivationStatus: 'DECLINED',
      planActivationAttempt: 3,
      planStripeSubscriptionId: null,
    } as never)
    await cerrarAltaPorAvisoDeStripe('sub_1', metadata)
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(cerrarAltaSinNavegador).not.toHaveBeenCalled()
  })

  it('programarCierreDelAltaPorAviso pasa la metadata de la factura al cierre', async () => {
    jest.useFakeTimers()
    prismaMock.onboardingProgress.findFirst.mockResolvedValue(null)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      organizationId: 'org-1',
      completedAt: null,
      planActivationStatus: 'IN_PROGRESS',
      planActivationAttempt: 1,
      planStripeSubscriptionId: null,
    } as never)
    prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)

    programarCierreDelAltaPorAviso('sub_1', {
      organizationId: 'org-1',
      planActivationKey: 'plan-activation:org-1:1',
      planOfferVersion: '2',
    })
    await jest.advanceTimersByTimeAsync(30_000)

    expect(cerrarAltaSinNavegador).toHaveBeenCalledWith('org-1', 'aviso-stripe')
  })

  it.each(['NONE', 'DECLINED'])('con el plan en %s no hace nada', async estado => {
    prismaMock.onboardingProgress.findFirst.mockResolvedValue({ organizationId: 'org-1', planActivationStatus: estado })
    await cerrarAltaPorAvisoDeStripe('sub_1')
    expect(cerrarAltaSinNavegador).not.toHaveBeenCalled()
    expect(terminarAltaCobradaSinRomper).not.toHaveBeenCalled()
  })
})

describe('programarCierreDelAltaPorAviso', () => {
  it('espera 30 s (para no pelear con el navegador que vuelve del banco) y luego cierra', async () => {
    jest.useFakeTimers()
    prismaMock.onboardingProgress.findFirst.mockResolvedValue({ organizationId: 'org-1', planActivationStatus: 'ACTIVE' })

    programarCierreDelAltaPorAviso('sub_1')
    await jest.advanceTimersByTimeAsync(29_000)
    expect(prismaMock.onboardingProgress.findFirst).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(1_000)
    expect(terminarAltaCobradaSinRomper).toHaveBeenCalledWith('org-1', { via: 'aviso-stripe' })
  })

  it('un fallo al cerrar no se escapa del temporizador', async () => {
    jest.useFakeTimers()
    prismaMock.onboardingProgress.findFirst.mockRejectedValue(new Error('base caída'))
    programarCierreDelAltaPorAviso('sub_1')
    await expect(jest.advanceTimersByTimeAsync(30_000)).resolves.not.toThrow()
  })
})
