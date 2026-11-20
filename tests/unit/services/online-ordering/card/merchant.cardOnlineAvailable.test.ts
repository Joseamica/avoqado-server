// tests/unit/services/online-ordering/card/merchant.cardOnlineAvailable.test.ts
/**
 * D661 (r1 #7, #10): «¿la tarjeta se ofrece?» en «Nadie» tiene su PROPIO interruptor (`cardOnlineNadie`, apagado de fábrica) y exige
 * una caja capaz de avisar que consultó en los últimos 15 min. «Mi equipo» sigue con su preferencia de siempre (`acceptsCardOnline`).
 * El `db` es el que recibe la regla (puede ser el `tx` de quien llama): nunca el cliente raíz.
 */
import { cardOnlineAvailable } from '@/services/online-ordering/card/merchant'
import { prismaMock } from '@tests/__helpers__/setup'

const STRIPE = { id: 'm1', chargesEnabled: true, providerCredentials: { connectAccountId: 'acct_1' }, provider: { code: 'STRIPE_CONNECT' } }
const MIN = 60_000
const hace = (ms: number) => new Date(Date.now() - ms)

/** Un `db` explícito: el comercio Stripe y el último aviso de una caja capaz (la columna `lastCardAlertPollAt` de los ajustes). */
const db = (lastCardAlertPollAt: Date | null, merchants: object[] = [STRIPE]) =>
  ({
    ecommerceMerchant: { findMany: jest.fn(async () => merchants) },
    onlineOrderingSettings: { findUnique: jest.fn(async () => ({ lastCardAlertPollAt })) },
  }) as any

const NADIE = { requiresAcceptance: false, acceptsCardOnline: true }

describe('cardOnlineAvailable en «Nadie» (D661)', () => {
  it('«Nadie» sin cardOnlineNadie: cardOnline false aunque acceptsCardOnline sea true', async () => {
    for (const cardOnlineNadie of [false, undefined, null]) {
      const d = db(hace(1 * MIN))
      await expect(cardOnlineAvailable({ ...NADIE, cardOnlineNadie }, d, 'v1')).resolves.toBe(false)
      // Las banderas se miden primero: apagada, ni la caja ni el comercio se consultan.
      expect(d.onlineOrderingSettings.findUnique).not.toHaveBeenCalled()
      expect(d.ecommerceMerchant.findMany).not.toHaveBeenCalled()
    }
  })

  it('«Nadie» sin caja capaz en 15 min: false', async () => {
    for (const ultimoAviso of [null, hace(15 * MIN + 1_000), hace(3 * 60 * MIN)]) {
      const d = db(ultimoAviso)
      await expect(cardOnlineAvailable({ ...NADIE, cardOnlineNadie: true }, d, 'v1')).resolves.toBe(false)
      expect(d.ecommerceMerchant.findMany).not.toHaveBeenCalled()
    }
    // Sin fila de ajustes tampoco hay caja que avise.
    const sinFila = { ...db(null), onlineOrderingSettings: { findUnique: jest.fn(async () => null) } } as any
    await expect(cardOnlineAvailable({ ...NADIE, cardOnlineNadie: true }, sinFila, 'v1')).resolves.toBe(false)
  })

  it('«Nadie» con todo: true', async () => {
    const d = db(hace(14 * MIN))
    await expect(cardOnlineAvailable({ ...NADIE, cardOnlineNadie: true }, d, 'v1')).resolves.toBe(true)
    // La caja se lee con el `db` recibido y del negocio pedido.
    expect(d.onlineOrderingSettings.findUnique).toHaveBeenCalledWith({ where: { venueId: 'v1' }, select: { lastCardAlertPollAt: true } })
    // La preferencia de «Mi equipo» no cuenta en «Nadie»: apagada, la tarjeta de «Nadie» sigue.
    await expect(
      cardOnlineAvailable({ requiresAcceptance: false, acceptsCardOnline: false, cardOnlineNadie: true }, db(hace(MIN)), 'v1'),
    ).resolves.toBe(true)
  })

  it('«Nadie» con todo menos un Stripe que hoy cobre: false', async () => {
    await expect(cardOnlineAvailable({ ...NADIE, cardOnlineNadie: true }, db(hace(MIN), []), 'v1')).resolves.toBe(false)
    const sinCuenta = { ...STRIPE, providerCredentials: {} }
    await expect(cardOnlineAvailable({ ...NADIE, cardOnlineNadie: true }, db(hace(MIN), [sinCuenta]), 'v1')).resolves.toBe(false)
  })

  it('«Mi equipo» no mira cardOnlineNadie', async () => {
    // Su preferencia prendida y Stripe listo: true, aunque el interruptor de «Nadie» esté apagado y ninguna caja avise.
    const d = db(null)
    await expect(cardOnlineAvailable({ requiresAcceptance: true, acceptsCardOnline: true, cardOnlineNadie: false }, d, 'v1')).resolves.toBe(
      true,
    )
    expect(d.onlineOrderingSettings.findUnique).not.toHaveBeenCalled()
    // Su preferencia apagada: false, aunque el interruptor de «Nadie» esté prendido y una caja haya avisado.
    await expect(
      cardOnlineAvailable({ requiresAcceptance: true, acceptsCardOnline: false, cardOnlineNadie: true }, db(hace(MIN)), 'v1'),
    ).resolves.toBe(false)
    // Un ajuste sin el campo de modo es «Mi equipo» (sólo `=== false` es «Nadie»).
    await expect(cardOnlineAvailable({ acceptsCardOnline: true }, db(null), 'v1')).resolves.toBe(true)
    expect(prismaMock.onlineOrderingSettings.findUnique).not.toHaveBeenCalled()
  })
})
