/**
 * S10 — el ESQUEMA de «Activar cobros» (spec 2026-09-17 § 4.2).
 *
 * 🔴 EL DEFECTO QUE ESTO CIERRA: el bloque `bank` no declaraba `bankName`, y Zod **descarta en
 * silencio** lo que no declara. El `BankAccountStep` del dashboard —que §4.2 reutiliza SIN
 * cambios— sí lo manda (`onNext({ clabe, bankName, accountHolder, accountType })`), así que el
 * banco se perdía en la puerta: llegaba vacío a la revisión de KYC (`kycReview.service.ts:227`)
 * y por tanto a la hoja de Blumon. Este endpoint existe justamente para que ese dato no se
 * pierda cuando el alta corta retira los pasos 7 y 8.
 */
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { paymentActivationProfileSchema } from '@/controllers/dashboard/paymentActivation.controller'

const CLABE_BBVA = '012180012345678909'

describe('paymentActivationProfileSchema — el bloque `bank`', () => {
  it('🔴 CONSERVA `bankName`: es lo que manda el BankAccountStep del dashboard', () => {
    const r = paymentActivationProfileSchema.parse({
      bank: { clabe: CLABE_BBVA, accountHolder: 'Juan Pérez', accountType: 'checking', bankName: 'BBVA México' },
    })
    expect(r.bank?.bankName).toBe('BBVA México')
  })

  it('`bankName` es OPCIONAL: un banco fuera del catálogo del dashboard no puede tumbar la captura de la CLABE', () => {
    const r = paymentActivationProfileSchema.safeParse({ bank: { clabe: CLABE_BBVA, accountHolder: 'Juan Pérez' } })
    expect(r.success).toBe(true)
  })

  // ── REGRESIÓN: el resto del contrato de §4.2 no se movió ───────────────────
  it('las demás secciones siguen aceptándose igual', () => {
    const r = paymentActivationProfileSchema.safeParse({
      entity: { entityType: 'PERSONA_FISICA', commercialName: 'Café' },
      identity: { legalFirstName: 'Juan', legalLastName: 'Pérez', rfc: 'XAXX010101000' },
      venueAddress: { address: 'Av. Reforma 1', city: 'CDMX', state: 'CDMX', zipCode: '06600' },
    })
    expect(r.success).toBe(true)
  })

  it('sigue exigiendo el titular de la cuenta', () => {
    expect(paymentActivationProfileSchema.safeParse({ bank: { clabe: CLABE_BBVA, accountHolder: '' } }).success).toBe(false)
  })
})
