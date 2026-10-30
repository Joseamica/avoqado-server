/**
 * Candado de los negocios demo (`Venue.status = LIVE_DEMO`): nada sale al mundo real.
 * Plan: Avoqado/docs/audit/2026-10-28-negocios-demo/plan.md, sección B. Rondas de Codex: codex-r1.md y codex-r2.md.
 */
import type { Request } from 'express'
import { runWithContext, type ExecutionContext } from '@/observability/executionContext'
import prisma from '@/utils/prismaClient'
import {
  CODIGO_NEGOCIO_DEMO,
  CODIGO_SIN_CONFIRMAR,
  esCorreoDemo,
  esNegocioDemo,
  omitirPorDemo,
  revisarCandadoDemo,
  rutaNormalizada,
  __olvidarNegociosDemoParaPruebas,
} from '@/services/demo/candadoDemo'

const db = prisma as unknown as { venue: { findUnique: jest.Mock }; staff: { findUnique: jest.Mock } }

const DEMO = 'cdemo0000000000000000000a'
const REAL = 'creal0000000000000000000a'
const USUARIO_DEMO = 'cusrdemo00000000000000000'
const USUARIO_REAL = 'cusrreal00000000000000000'

function estados(mapa: Record<string, string>) {
  db.venue.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    mapa[where.id] ? { status: mapa[where.id] } : null,
  )
}

const ctx = (venueId?: string): ExecutionContext => ({ correlationId: 'c', source: 'http', entrypoint: 'test', venueId })

const req = (
  method: string,
  originalUrl: string,
  opts: { venue?: string; user?: string; role?: string; body?: unknown; header?: string } = {},
): Request =>
  ({
    method,
    originalUrl,
    authContext: { venueId: opts.venue ?? REAL, userId: opts.user ?? USUARIO_REAL, role: opts.role ?? 'OWNER' },
    headers: opts.header ? { 'x-venue-id': opts.header } : {},
    body: opts.body ?? {},
  }) as unknown as Request

beforeEach(() => {
  __olvidarNegociosDemoParaPruebas()
  db.venue.findUnique.mockReset()
  db.staff.findUnique.mockReset()
  estados({ [DEMO]: 'LIVE_DEMO', [REAL]: 'ACTIVE' })
  db.staff.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === USUARIO_DEMO ? { email: 'salon@demo.avoqado.io' } : { email: 'dueno@negocio.mx' },
  )
})

describe('esCorreoDemo', () => {
  it('reconoce el dominio de los demos sin importar mayúsculas ni espacios', () => {
    expect(esCorreoDemo('Salon@Demo.Avoqado.io ')).toBe(true)
  })
  it('no confunde correos reales ni dominios que sólo se parecen', () => {
    expect(esCorreoDemo('jose@avoqado.io')).toBe(false)
    expect(esCorreoDemo('x@demo.avoqado.io.evil.com')).toBe(false)
    expect(esCorreoDemo('x@notdemo.avoqado.io')).toBe(false)
    expect(esCorreoDemo(null)).toBe(false)
  })
})

describe('esNegocioDemo', () => {
  it('sólo LIVE_DEMO es negocio demo (TRIAL es gente real probando)', async () => {
    estados({ a: 'LIVE_DEMO', b: 'TRIAL', c: 'ACTIVE' })
    expect(await esNegocioDemo('a')).toBe(true)
    expect(await esNegocioDemo('b')).toBe(false)
    expect(await esNegocioDemo('c')).toBe(false)
    expect(await esNegocioDemo('no-existe')).toBe(false)
    expect(await esNegocioDemo(undefined)).toBe(false)
  })
  it('guarda la respuesta en memoria: la segunda vez no consulta la base', async () => {
    await esNegocioDemo(DEMO)
    await esNegocioDemo(DEMO)
    expect(db.venue.findUnique).toHaveBeenCalledTimes(1)
  })
  it('un tropiezo de la base se reintenta una vez; dos seguidos suben como error', async () => {
    db.venue.findUnique.mockRejectedValueOnce(new Error('P1001')).mockResolvedValueOnce({ status: 'LIVE_DEMO' })
    expect(await esNegocioDemo(DEMO)).toBe(true)
    __olvidarNegociosDemoParaPruebas()
    db.venue.findUnique.mockRejectedValue(new Error('P1001'))
    await expect(esNegocioDemo(DEMO)).rejects.toThrow('P1001')
  })
})

describe('omitirPorDemo (red de seguridad de los mensajes)', () => {
  it('omite si el negocio de la operación es demo', async () => {
    await expect(runWithContext(ctx(DEMO), () => omitirPorDemo('correo', ['cliente@gmail.com']))).resolves.toBe('negocio demo')
  })
  it('el negocio explícito (fila de outbox, factura) gana sobre el del contexto', async () => {
    await expect(runWithContext(ctx(REAL), () => omitirPorDemo('correo', 'cliente@gmail.com', DEMO))).resolves.toBe('negocio demo')
    await expect(runWithContext(ctx(DEMO), () => omitirPorDemo('correo', 'cliente@gmail.com', REAL))).resolves.toBeNull()
  })
  it('omite si algún destinatario es del dominio demo, aunque no haya negocio en el contexto (jobs)', async () => {
    await expect(omitirPorDemo('correo', ['dueno@real.mx', 'salon@demo.avoqado.io'])).resolves.toBe('destinatario demo')
    await expect(omitirPorDemo('correo', 'salon@demo.avoqado.io')).resolves.toBe('destinatario demo')
  })
  it('un negocio real manda normal', async () => {
    await expect(runWithContext(ctx(REAL), () => omitirPorDemo('correo', ['cliente@gmail.com']))).resolves.toBeNull()
    await expect(omitirPorDemo('whatsapp')).resolves.toBeNull()
  })
  it('🔴 si la base no contesta, NO se manda (sin confirmar), para que quien llama lo reintente', async () => {
    db.venue.findUnique.mockRejectedValue(new Error('P1001'))
    await expect(runWithContext(ctx(REAL), () => omitirPorDemo('correo', ['cliente@gmail.com']))).resolves.toBe('sin confirmar')
  })
})

describe('omitirPorDemo: casos de la ronda 3', () => {
  it('🔴 un mensaje cargado antes del reinicio (negocio demo ya borrado) no sale (Codex r3, 2)', async () => {
    await expect(omitirPorDemo('correo', 'cliente@gmail.com', 'cnegociobor0000000000000a')).resolves.toBe('negocio borrado')
  })
  it('un id que no parece de negocio (p. ej. un slug) no frena a nadie', async () => {
    await expect(omitirPorDemo('correo', 'cliente@gmail.com', 'studio-bloom')).resolves.toBeNull()
  })
  it('🔴 una ruta pública que no pudo confirmar su negocio no manda nada (Codex r3, 1)', async () => {
    const sinConfirmar = { ...ctx(undefined), negocioSinConfirmar: true as const }
    await expect(runWithContext(sinConfirmar, () => omitirPorDemo('WhatsApp'))).resolves.toBe('sin confirmar')
  })
})

describe('rutaNormalizada', () => {
  it('quita la query, decodifica cada segmento y baja a minúsculas, como Express', () => {
    expect(rutaNormalizada('/api/v1/dashboard/venues/%63abc/TEAM/?x=1')).toEqual({
      ruta: '/api/v1/dashboard/venues/cabc/team/',
      decodificada: '/api/v1/dashboard/venues/cabc/TEAM/',
    })
    expect(rutaNormalizada('/api/%E0%A4%A/x').ruta).toBe('/api/%e0%a4%a/x')
  })
})

describe('revisarCandadoDemo: reglas por negocio', () => {
  const bloqueadas: Array<[string, string]> = [
    ['POST', `/api/v1/dashboard/venues/${DEMO}/plan/checkout`],
    ['PUT', `/api/v1/dashboard/venues/${DEMO}/payment-method`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/setup-intent`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/features`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/hybrid-billing/quotes`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/tpv-orders`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/ecommerce-merchants/x/stripe-onboard`],
    ['PUT', `/api/v1/dashboard/venues/${DEMO}/ecommerce-merchants/x`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/kyc/submit`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/fiscal/emisores/e1/csd`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/cfdi/f1/email`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/shopify/connect/start`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/integrations/google/init-oauth`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/financial-connections`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/pass-integrations/totalpass/connect`],
    ['PUT', `/api/v1/dashboard/venues/${DEMO}/pass-integrations/wellhub/products`],
    ['POST', `/api/v1/delivery-channels/venues/${DEMO}/channels`],
    ['GET', `/api/v1/delivery-channels/venues/${DEMO}/channels/rappi/connect-url`],
    ['DELETE', `/api/v1/dashboard/venues/${DEMO}`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/team`],
    ['PATCH', `/api/v1/dashboard/venues/${DEMO}/team/s1`],
    ['DELETE', `/api/v1/dashboard/venues/${DEMO}/team/s1/hard-delete`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/campaigns/k1/publish`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/payment-links/l1/share-whatsapp`],
    ['POST', `/api/v1/dashboard/venues/${DEMO}/payments/p1/send-receipt`],
    ['POST', `/api/v1/mobile/venues/${DEMO}/receipts/send-email`],
    ['POST', `/api/v1/mobile/venues/${DEMO}/receipts/send-whatsapp`],
  ]
  it.each(bloqueadas)('%s %s en un negocio demo → 403 NEGOCIO_DEMO con su razón', async (method, url) => {
    const r = await revisarCandadoDemo(req(method, url, { venue: DEMO }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe(CODIGO_NEGOCIO_DEMO)
      expect(r.message).toMatch(/demostración/)
    }
  })

  it.each(bloqueadas)('%s %s en un negocio REAL pasa sin tocarlo', async (method, url) => {
    expect(await revisarCandadoDemo(req(method, url.replace(DEMO, REAL)))).toEqual({ ok: true })
  })

  it('🔴 mayúsculas, un id codificado o la diagonal final no se saltan la lista (Codex r2, 2)', async () => {
    const codificado = `%63${DEMO.slice(1)}`
    for (const url of [
      `/api/v1/dashboard/venues/${DEMO}/TEAM/s1`,
      `/API/V1/Dashboard/Venues/${DEMO}/Plan/Checkout`,
      `/api/v1/dashboard/venues/${codificado}/team/s1`,
      `/api/v1/dashboard/venues/${DEMO}/team/`,
    ]) {
      expect((await revisarCandadoDemo(req('PATCH', url, { venue: DEMO }))).ok).toBe(false)
    }
    expect((await revisarCandadoDemo(req('POST', `/api/v1/dashboard/venues/${codificado}/plan/checkout`, { venue: REAL }))).ok).toBe(false)
  })

  it('🔴 las dos entradas para crear sucursal, desde un demo (Codex r2, 3)', async () => {
    expect((await revisarCandadoDemo(req('POST', '/api/v1/dashboard/venues', { venue: DEMO }))).ok).toBe(false)
    expect((await revisarCandadoDemo(req('POST', '/api/v1/dashboard/venues/enhanced', { venue: DEMO }))).ok).toBe(false)
    expect(await revisarCandadoDemo(req('POST', '/api/v1/dashboard/venues/enhanced', { venue: REAL }))).toEqual({ ok: true })
  })

  it('🔴 SUPERADMIN que visitó un demo y administra un negocio real: no lo frena su token (Codex r2, 1)', async () => {
    const sa = { venue: DEMO, role: 'SUPERADMIN' }
    expect(await revisarCandadoDemo(req('POST', `/api/v1/dashboard/notifications/venue/${REAL}`, sa))).toEqual({ ok: true })
    expect(await revisarCandadoDemo(req('POST', '/api/v1/dashboard/notifications', { ...sa, header: REAL }))).toEqual({ ok: true })
    expect((await revisarCandadoDemo(req('POST', '/api/v1/dashboard/notifications', sa))).ok).toBe(false)
  })

  it('alguien que NO es superadmin no se salta el candado mandando otro negocio en el encabezado', async () => {
    expect((await revisarCandadoDemo(req('POST', '/api/v1/dashboard/notifications', { venue: DEMO, header: REAL }))).ok).toBe(false)
  })

  it('apuntar el negocio demo a una cuenta de Stripe se bloquea; editar su nombre no', async () => {
    const url = `/api/v1/dashboard/venues/${DEMO}`
    expect((await revisarCandadoDemo(req('PUT', url, { venue: DEMO, body: { stripeAccountId: 'acct_x' } }))).ok).toBe(false)
    expect(await revisarCandadoDemo(req('PUT', url, { venue: DEMO, body: { name: 'Mi salón' } }))).toEqual({ ok: true })
  })

  it('lo normal del demo sigue: vender, cobrar en efectivo, editar productos, leer reportes', async () => {
    for (const [method, url] of [
      ['POST', `/api/v1/mobile/venues/${DEMO}/orders`],
      ['POST', `/api/v1/dashboard/venues/${DEMO}/products`],
      ['GET', `/api/v1/dashboard/venues/${DEMO}/plan`],
      ['GET', `/api/v1/dashboard/venues/${DEMO}/features`],
      ['GET', `/api/v1/dashboard/venues/${DEMO}/team`],
      ['POST', `/api/v1/dashboard/venues/${DEMO}/orders/o1/cfdi`],
      ['GET', `/api/v1/delivery-channels/venues/${DEMO}/channels`],
    ]) {
      expect(await revisarCandadoDemo(req(method, url, { venue: DEMO }))).toEqual({ ok: true })
    }
  })

  it('lo que no está en la lista ni siquiera consulta la base (cero costo para el resto)', async () => {
    await revisarCandadoDemo(req('POST', `/api/v1/mobile/venues/${DEMO}/orders`, { venue: DEMO }))
    expect(db.venue.findUnique).not.toHaveBeenCalled()
    expect(db.staff.findUnique).not.toHaveBeenCalled()
  })

  it('🔴 si la base no contesta en una acción de la lista: 503 «intenta de nuevo», nunca deja pasar (Codex r2, 8)', async () => {
    db.venue.findUnique.mockRejectedValue(new Error('P1001'))
    const r = await revisarCandadoDemo(req('POST', `/api/v1/dashboard/venues/${DEMO}/plan/checkout`, { venue: DEMO }))
    expect(r).toMatchObject({ ok: false, status: 503, code: CODIGO_SIN_CONFIRMAR })
  })
})

describe('revisarCandadoDemo: en un demo sólo se escribe en lo permitido (Codex r5)', () => {
  it.each([
    ['PUT', 'fiscal-profile'],
    ['POST', 'chat/activation-code'],
    ['POST', 'reviews/r1/respond'],
    ['POST', 'credit-offer/accept'],
    ['POST', 'seccion-que-nadie-clasifico'],
  ])('🔴 %s /dashboard/venues/DEMO/%s → bloqueado (lo no permitido está cerrado por defecto)', async (method, resto) => {
    const r = await revisarCandadoDemo(req(method, `/api/v1/dashboard/venues/${DEMO}/${resto}`, { venue: DEMO }))
    expect(r).toMatchObject({ ok: false, code: CODIGO_NEGOCIO_DEMO })
  })

  it('🔴 en la app, Rappi/Uber y registrar terminales se bloquean en el demo', async () => {
    expect((await revisarCandadoDemo(req('POST', `/api/v1/mobile/venues/${DEMO}/delivery/o1/ready`, { venue: DEMO }))).ok).toBe(false)
    expect((await revisarCandadoDemo(req('POST', `/api/v1/mobile/venues/${DEMO}/terminals`, { venue: DEMO }))).ok).toBe(false)
  })

  it('lo permitido sigue: vender, catálogo, inventario, caja, clientes, reservas', async () => {
    for (const [method, url] of [
      ['POST', `/api/v1/mobile/venues/${DEMO}/orders`],
      ['POST', `/api/v1/mobile/venues/${DEMO}/cash-drawer/open`],
      ['POST', `/api/v1/dashboard/venues/${DEMO}/products`],
      ['PATCH', `/api/v1/dashboard/venues/${DEMO}/inventory/i1`],
      ['POST', `/api/v1/dashboard/venues/${DEMO}/customers`],
      ['POST', `/api/v1/dashboard/venues/${DEMO}/reservations`],
      ['PUT', `/api/v1/dashboard/venues/${DEMO}`],
    ]) {
      expect(await revisarCandadoDemo(req(method, url, { venue: DEMO }))).toEqual({ ok: true })
    }
  })

  it('regresión: en un negocio REAL nada de esto se bloquea', async () => {
    for (const resto of ['fiscal-profile', 'chat/activation-code', 'reviews/r1/respond', 'seccion-que-nadie-clasifico']) {
      expect(await revisarCandadoDemo(req('POST', `/api/v1/dashboard/venues/${REAL}/${resto}`))).toEqual({ ok: true })
    }
  })

  it('🔴 el usuario demo no escribe fuera de su negocio, su sesión y la app (asistente, reseñas, terminales…)', async () => {
    const demo = { venue: DEMO, user: USUARIO_DEMO }
    for (const url of ['/api/v1/dashboard/assistant/chat', '/api/v1/dashboard/reviews/r1/reply', '/api/v1/dashboard/testing/x', '/api/v1/consumer/x']) {
      expect((await revisarCandadoDemo(req('POST', url, demo))).ok).toBe(false)
    }
    expect(await revisarCandadoDemo(req('POST', '/api/v1/dashboard/auth/logout', demo))).toEqual({ ok: true })
    expect(await revisarCandadoDemo(req('PATCH', '/api/v1/dashboard/notifications/n1/read', demo))).toEqual({ ok: true })
  })
})

describe('revisarCandadoDemo: reglas por usuario compartido', () => {
  it('🔴 el usuario demo no cambia su cuenta ni la borra, aunque su sesión apunte a un negocio que ya no existe (Codex r2, 5)', async () => {
    const viejo = { venue: 'cnegociobor0000000000000a', user: USUARIO_DEMO }
    expect((await revisarCandadoDemo(req('PATCH', '/api/v1/dashboard/cnegociobor0000000000000a/account', viejo))).ok).toBe(false)
    expect((await revisarCandadoDemo(req('DELETE', '/api/v1/mobile/account', viejo))).ok).toBe(false)
  })

  it('🔴 el usuario demo no puede usar el alta (ni su tarjeta) (Codex r2, 4)', async () => {
    const r = await revisarCandadoDemo(req('POST', '/api/v1/onboarding/setup-intent', { user: USUARIO_DEMO }))
    expect(r).toMatchObject({ ok: false, code: CODIGO_NEGOCIO_DEMO })
    expect((await revisarCandadoDemo(req('POST', '/api/v1/onboarding/organizations/o1/complete', { user: USUARIO_DEMO }))).ok).toBe(false)
  })

  it('🔴 con una sesión vieja (negocio ya borrado), el usuario demo tampoco crea sucursales ni compra (Codex r2, 5)', async () => {
    const viejo = { venue: 'cnegociobor0000000000000a', user: USUARIO_DEMO }
    expect((await revisarCandadoDemo(req('POST', '/api/v1/dashboard/venues', viejo))).ok).toBe(false)
    expect((await revisarCandadoDemo(req('POST', '/api/v1/dashboard/tokens/purchase', viejo))).ok).toBe(false)
    expect((await revisarCandadoDemo(req('POST', '/api/v1/dashboard/notifications', viejo))).ok).toBe(false)
  })

  it('🔴 el usuario demo no escribe en la organización (su PIN por esa ruta), terminales ni integraciones (Codex r3, 3 y 4)', async () => {
    const demo = { venue: DEMO, user: USUARIO_DEMO }
    for (const [method, url] of [
      ['PATCH', '/api/v1/dashboard/organizations/corg/team/cstaff/pin'],
      ['PUT', '/api/v1/organizations/corg/settings'],
      ['POST', `/api/v1/tpv/venues/${DEMO}/crypto/initiate`],
      ['POST', '/api/v1/invitations/accept'],
      ['POST', '/api/v1/google-calendar/connections'],
    ]) {
      expect((await revisarCandadoDemo(req(method, url, demo))).ok).toBe(false)
    }
  })

  it('🔴 cripto (B4Bit) y la API de terminales se bloquean en el negocio demo para cualquiera (Codex r3, 4)', async () => {
    expect((await revisarCandadoDemo(req('PUT', `/api/v1/dashboard/venues/${DEMO}/crypto/setup`, { venue: DEMO }))).ok).toBe(false)
    expect((await revisarCandadoDemo(req('POST', `/api/v1/tpv/venues/${DEMO}/crypto/initiate`, { venue: DEMO }))).ok).toBe(false)
    expect(await revisarCandadoDemo(req('POST', `/api/v1/tpv/venues/${REAL}/crypto/initiate`))).toEqual({ ok: true })
  })

  it('regresión: una persona real escribe en su organización y en su terminal como siempre', async () => {
    expect(await revisarCandadoDemo(req('PATCH', '/api/v1/dashboard/organizations/corg/team/cstaff/pin'))).toEqual({ ok: true })
    expect(await revisarCandadoDemo(req('POST', `/api/v1/tpv/venues/${REAL}/payments`))).toEqual({ ok: true })
  })

  it('regresión: una persona real cambia su cuenta y usa el alta como siempre', async () => {
    expect(await revisarCandadoDemo(req('PATCH', `/api/v1/dashboard/${REAL}/account`))).toEqual({ ok: true })
    expect(await revisarCandadoDemo(req('DELETE', '/api/v1/mobile/account'))).toEqual({ ok: true })
    expect(await revisarCandadoDemo(req('POST', '/api/v1/onboarding/setup-intent'))).toEqual({ ok: true })
  })
})
