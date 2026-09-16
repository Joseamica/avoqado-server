/**
 * 🔴 UN `null` DEL POS NO PUEDE REBOTAR DONDE EL CAMPO ES OPCIONAL.
 *
 * Misma familia que el defecto que dejó a Testarudo sin poder reembolsar el 2026-09-11: el
 * POS Android serializa con kotlinx y `encodeDefaults = true`, así que un campo opcional que
 * no aplica viaja como `"intendedOrderId": null` — en JSON no existe `undefined`.
 *
 * `z.string().optional()` acepta la llave AUSENTE pero **rechaza `null`** con un 400
 * «Expected string, received null», y el cliente ni siquiera llega al servicio. Lo encontró
 * una auditoría adversarial (Codex gpt-6-astra, xhigh) mientras revisaba el arreglo del
 * reembolso: el mismo error, latente, en otro endpoint.
 *
 * 🔑 Y la lección que decidió DÓNDE arreglarlo: «null ≡ ausente» es una propiedad de cada
 * endpoint, no del cliente. Se pensó silenciar todos los nulos de golpe en el converter
 * compartido de Android y habría roto `PrintJob.error`, donde el nulo SÍ significa algo
 * («borra el error viejo»). Así que el cliente sigue mandando lo que manda y es el esquema
 * el que declara que aquí los dos valores quieren decir lo mismo.
 */
import { ValidateReferralCodeSchema, CaptureReferralSchema } from '@/schemas/dashboard/referrals.schemas'

describe('Referidos · un `intendedOrderId` nulo es lo mismo que no mandarlo', () => {
  const baseValidar = { referralCode: 'ABC123', newCustomerId: 'cust-1' }
  const baseCapturar = { ...baseValidar, capturedByStaffVenueId: 'sv-1' }

  it('validar: acepta el nulo explícito que manda el POS', () => {
    const r = ValidateReferralCodeSchema.safeParse({
      params: { venueId: 'venue-1' },
      body: { ...baseValidar, intendedOrderId: null },
    })
    expect(r.success).toBe(true)
  })

  it('capturar: acepta el nulo explícito que manda el POS', () => {
    const r = CaptureReferralSchema.safeParse({
      params: { venueId: 'venue-1' },
      body: { ...baseCapturar, intendedOrderId: null },
    })
    expect(r.success).toBe(true)
  })

  it('la llave ausente sigue valiendo, como siempre', () => {
    expect(ValidateReferralCodeSchema.safeParse({ params: { venueId: 'venue-1' }, body: baseValidar }).success).toBe(true)
    expect(CaptureReferralSchema.safeParse({ params: { venueId: 'venue-1' }, body: baseCapturar }).success).toBe(true)
  })

  it('y un id de verdad sigue llegando entero', () => {
    const r = CaptureReferralSchema.safeParse({
      params: { venueId: 'venue-1' },
      body: { ...baseCapturar, intendedOrderId: 'order-9' },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.intendedOrderId).toBe('order-9')
  })

  /** Aflojar el tipo no puede aflojar lo que de verdad identifica al referido. */
  it('lo obligatorio sigue siendo obligatorio', () => {
    expect(
      CaptureReferralSchema.safeParse({
        params: { venueId: 'venue-1' },
        body: { ...baseCapturar, referralCode: null },
      }).success,
    ).toBe(false)
    expect(
      CaptureReferralSchema.safeParse({
        params: { venueId: 'venue-1' },
        body: { ...baseCapturar, newCustomerId: null },
      }).success,
    ).toBe(false)
  })
})
