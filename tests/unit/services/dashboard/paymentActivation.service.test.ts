/**
 * S10 — «Activar cobros» (spec 2026-09-17 § 4.2).
 *
 * 🔴 Las tres cosas que se guardan: quién puede tocarlo, que la respuesta NO lleve la CLABE ni
 * el RFC completos, y que la dirección del LOCAL se escriba de verdad — es la única captura que
 * queda en todo el producto una vez que el alta corta la retira.
 */
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import {
  assertPaymentActivationAccess,
  getPaymentActivation,
  updatePaymentActivationProfile,
} from '@/services/dashboard/paymentActivation.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '@tests/__helpers__/setup'

const CLABE_BUENA = '002010077777777771'

function venue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'venue-1',
    organizationId: 'org-1',
    kycStatus: 'NOT_SUBMITTED',
    entityType: 'PERSONA_FISICA',
    legalName: 'Juan Pérez',
    rfc: 'XAXX010101000',
    address: 'Calle 1',
    city: 'CDMX',
    state: 'CDMX',
    zipCode: '01000',
    idDocumentUrl: 'u1',
    rfcDocumentUrl: null,
    comprobanteDomicilioUrl: null,
    caratulaBancariaUrl: null,
    actaDocumentUrl: null,
    poderLegalUrl: null,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
  prismaMock.venue.findUnique.mockResolvedValue(venue() as never)
  prismaMock.venue.update.mockResolvedValue({} as never)
  prismaMock.onboardingProgress.findUnique.mockResolvedValue({
    v2SetupData: { step5: { curp: 'PEPJ800101HDFRRN09', legalAddress: 'Calle 2' }, step7: { clabe: CLABE_BUENA, bankName: 'BBVA' } },
    step8_paymentInfo: null,
  } as never)
  prismaMock.onboardingProgress.update.mockResolvedValue({} as never)
  prismaMock.terminal.count.mockResolvedValue(0 as never)
  prismaMock.ecommerceMerchant.findFirst.mockResolvedValue(null as never)
})

describe('quién puede activar cobros', () => {
  it.each([['CASHIER'], ['MANAGER'], ['WAITER']])('🔴 un %s recibe 403', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null as never)
    await expect(assertPaymentActivationAccess('venue-1', 'staff-1', 'CASHIER')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('OWNER o ADMIN activos de ESE local pasan', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' } as never)
    await expect(assertPaymentActivationAccess('venue-1', 'staff-1', 'OWNER')).resolves.toEqual({ organizationId: 'org-1' })
    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith({
      where: { venueId: 'venue-1', staffId: 'staff-1', active: true, role: { in: ['OWNER', 'ADMIN'] } },
      select: { id: true },
    })
  })

  it('SUPERADMIN pasa sin consultar la asignación', async () => {
    await expect(assertPaymentActivationAccess('venue-1', 'sa', 'SUPERADMIN')).resolves.toEqual({ organizationId: 'org-1' })
    expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
  })
})

describe('la respuesta va enmascarada', () => {
  it('🔴 NUNCA lleva la CLABE ni el RFC completos', async () => {
    const r = await getPaymentActivation('venue-1')
    const texto = JSON.stringify(r)
    expect(texto).not.toContain(CLABE_BUENA)
    expect(texto).not.toContain('XAXX010101000')
    expect(r.profile.clabeLast4).toBe('7771')
    expect(r.profile.rfcMasked).toBe('XAX•••••••000')
    // La CURP es un booleano, nunca el valor.
    expect(r.profile.curpPresent).toBe(true)
    expect(texto).not.toContain('PEPJ800101HDFRRN09')
  })

  it('🔴 sin la dirección del LOCAL el perfil NO está completo', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(venue({ address: null, city: null, state: null, zipCode: null }) as never)
    const r = await getPaymentActivation('venue-1')
    expect(r.profile.venueAddressPresent).toBe(false)
    expect(r.profile.complete).toBe(false)
  })

  it('con todo capturado, el perfil está completo', async () => {
    const r = await getPaymentActivation('venue-1')
    expect(r.profile.complete).toBe(true)
  })

  it('el respaldo de `step8_paymentInfo` sirve cuando no hay step7', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      v2SetupData: { step5: { legalAddress: 'Calle 2' } },
      step8_paymentInfo: { clabe: CLABE_BUENA, bankName: 'Banorte' },
    } as never)
    const r = await getPaymentActivation('venue-1')
    expect(r.profile.clabeLast4).toBe('7771')
    expect(r.profile.bankName).toBe('Banorte')
  })
})

describe('guardar el perfil', () => {
  it('🔴 una CLABE con dígito verificador malo se rechaza (no basta el largo)', async () => {
    await expect(
      updatePaymentActivationProfile('venue-1', 'org-1', { bank: { clabe: '002010077777777779', accountHolder: 'Juan' } }, 'staff-1'),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CLABE' })
    expect(prismaMock.onboardingProgress.update).not.toHaveBeenCalled()
  })

  it('🔴 la CLABE se ESPEJA en step8_paymentInfo, que es lo que lee la revisión de KYC', async () => {
    await updatePaymentActivationProfile('venue-1', 'org-1', { bank: { clabe: CLABE_BUENA, accountHolder: 'Juan Pérez' } }, 'staff-1')

    const data = prismaMock.onboardingProgress.update.mock.calls[0][0].data
    expect((data.step8_paymentInfo as Record<string, unknown>).clabe).toBe(CLABE_BUENA)
    expect(((data.v2SetupData as Record<string, unknown>).step7 as Record<string, unknown>).clabe).toBe(CLABE_BUENA)
  })

  it('🔴 NO mueve `currentStep` ni `completedSteps`: este checklist vive DESPUÉS del alta', async () => {
    await updatePaymentActivationProfile('venue-1', 'org-1', { bank: { clabe: CLABE_BUENA, accountHolder: 'Juan' } }, 'staff-1')
    const data = prismaMock.onboardingProgress.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty('currentStep')
    expect(data).not.toHaveProperty('completedSteps')
  })

  it('🔴 `venueAddress` escribe las cuatro columnas del local', async () => {
    await updatePaymentActivationProfile(
      'venue-1',
      'org-1',
      { venueAddress: { address: 'Av. Reforma 1', city: 'CDMX', state: 'CDMX', zipCode: '06600' } },
      'staff-1',
    )
    expect(prismaMock.venue.update).toHaveBeenCalledWith({
      where: { id: 'venue-1' },
      data: { address: 'Av. Reforma 1', city: 'CDMX', state: 'CDMX', zipCode: '06600' },
    })
  })

  it('una dirección a medias se rechaza', async () => {
    await expect(
      updatePaymentActivationProfile('venue-1', 'org-1', { venueAddress: { address: 'X', city: '', state: 'CDMX', zipCode: '06600' } }, 'staff-1'),
    ).rejects.toMatchObject({ code: 'INVALID_VENUE_ADDRESS' })
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
  })

  it.each([
    ['RFC', { identity: { legalFirstName: 'J', legalLastName: 'P', rfc: 'NOPE' } }, 'INVALID_RFC'],
    ['CURP', { identity: { legalFirstName: 'J', legalLastName: 'P', curp: 'NOPE' } }, 'INVALID_CURP'],
  ])('un %s mal formado se rechaza antes de escribir', async (_c, input, code) => {
    await expect(updatePaymentActivationProfile('venue-1', 'org-1', input as never, 'staff-1')).rejects.toMatchObject({ code })
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
  })

  it('🔴 la bitácora registra las SECCIONES, nunca los valores fiscales', async () => {
    await updatePaymentActivationProfile(
      'venue-1',
      'org-1',
      { bank: { clabe: CLABE_BUENA, accountHolder: 'Juan' }, identity: { legalFirstName: 'Juan', legalLastName: 'Pérez', rfc: 'XAXX010101000' } },
      'staff-1',
    )
    const asiento = (logAction as jest.Mock).mock.calls[0][0]
    expect(asiento.data).toEqual({ sections: expect.arrayContaining(['identity', 'bank']) })
    expect(JSON.stringify(asiento)).not.toContain(CLABE_BUENA)
    expect(JSON.stringify(asiento)).not.toContain('XAXX010101000')
  })

  it('un cuerpo vacío no escribe nada', async () => {
    await expect(updatePaymentActivationProfile('venue-1', 'org-1', {}, 'staff-1')).rejects.toMatchObject({ code: 'NOTHING_TO_UPDATE' })
    expect(prismaMock.onboardingProgress.update).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 El BANCO. `kycReview.service.ts:227` hace `bankName: paymentInfo?.bankName || null`, así que
 * si este endpoint no lo guarda, TODO local nacido del alta corta llega a la revisión de KYC —y a
 * la hoja de Blumon— con el banco vacío. Este endpoint existe precisamente para que ese dato no se
 * pierda cuando el alta corta retira los pasos 7 y 8 (§4.2).
 *
 * La regla elegida: se respeta lo que mande el cliente (el campo es EDITABLE en el
 * `BankAccountStep`), y si no manda nada se DERIVA de los tres primeros dígitos de la CLABE, que
 * **son** el código de banco de Banxico. Fuera del catálogo se guarda `null`, nunca un texto
 * inventado: el revisor prefiere un hueco a un banco equivocado.
 */
const CLABE_BBVA = '012180012345678909' //   012 → BBVA México
const CLABE_SIN_CATALOGO = '999180012345678909' // 999 → no está en MEXICAN_BANK_CODES

function mirrorDe(): { step7: Record<string, unknown>; step8: Record<string, unknown> } {
  const data = prismaMock.onboardingProgress.update.mock.calls[0][0].data
  return {
    step7: (data.v2SetupData as Record<string, unknown>).step7 as Record<string, unknown>,
    step8: data.step8_paymentInfo as Record<string, unknown>,
  }
}

describe('el banco llega hasta la revisión de KYC', () => {
  it('🔴 el `bankName` que manda el dashboard se GUARDA en los dos sitios', async () => {
    await updatePaymentActivationProfile(
      'venue-1',
      'org-1',
      { bank: { clabe: CLABE_BBVA, accountHolder: 'Juan Pérez', bankName: 'BBVA México' } },
      'staff-1',
    )
    const { step7, step8 } = mirrorDe()
    expect(step8.bankName).toBe('BBVA México')
    expect(step7.bankName).toBe('BBVA México')
  })

  it('🔴 sin `bankName`, se DERIVA de los 3 primeros dígitos de la CLABE (son el código del banco)', async () => {
    await updatePaymentActivationProfile('venue-1', 'org-1', { bank: { clabe: CLABE_BBVA, accountHolder: 'Juan Pérez' } }, 'staff-1')
    const { step7, step8 } = mirrorDe()
    expect(step8.bankName).toBe('BBVA México')
    expect(step7.bankName).toBe('BBVA México')
  })

  it('🔴 un código fuera del catálogo guarda `null`, NUNCA «Unknown»', async () => {
    await updatePaymentActivationProfile('venue-1', 'org-1', { bank: { clabe: CLABE_SIN_CATALOGO, accountHolder: 'Juan' } }, 'staff-1')
    const { step8 } = mirrorDe()
    expect(step8.bankName).toBeNull()
    expect(JSON.stringify(step8)).not.toContain('Unknown')
  })

  it('🔴 al cambiar la CLABE, el banco VIEJO no sobrevive: el espejo describe la cuenta de HOY', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      v2SetupData: { step7: { clabe: CLABE_BUENA, bankName: 'Banorte' } },
      step8_paymentInfo: { clabe: CLABE_BUENA, bankName: 'Banorte', accountHolder: 'Juan' },
    } as never)

    await updatePaymentActivationProfile('venue-1', 'org-1', { bank: { clabe: CLABE_BBVA, accountHolder: 'Juan' } }, 'staff-1')
    const { step7, step8 } = mirrorDe()
    expect(step8.bankName).toBe('BBVA México')
    expect(step7.bankName).toBe('BBVA México')
  })

  // ── REGRESIÓN ──────────────────────────────────────────────────────────────
  it('la CLABE y el titular se siguen espejando igual, y el banco no se cuela en la bitácora', async () => {
    await updatePaymentActivationProfile(
      'venue-1',
      'org-1',
      { bank: { clabe: CLABE_BBVA, accountHolder: 'Juan Pérez', accountType: 'checking', bankName: 'BBVA México' } },
      'staff-1',
    )
    const { step8 } = mirrorDe()
    expect(step8).toMatchObject({ clabe: CLABE_BBVA, accountHolder: 'Juan Pérez', accountType: 'checking' })
    expect((logAction as jest.Mock).mock.calls[0][0].data).toEqual({ sections: ['bank'] })
  })
})
