/**
 * Fixture compartido de las pruebas del checkpoint 1 (webhook como primer confirmador). NO es una suite: jest sólo
 * corre `*.test.ts`. Arma un negocio completo con la forma de PRODUCCIÓN: terminal Nexgo con serial con prefijo,
 * llave normalizada en las solicitudes, cajero con membresía, proveedor AngelPay, login de AngelPay dueño del
 * merchant (así el webhook resuelve el venue) y el payload REST exacto de la terminal (importes en centavos).
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { terminalIdentityKey } from '@/utils/terminalSerial'

/**
 * Una fila que la prueba EXIGE que exista: su ausencia es una ASERCIÓN caída (`not.toBeNull`), no un error de Prisma
 * (`findUniqueOrThrow`). El runner de sabotajes certificado (Codex R7 (l)) sólo cuenta caídas por aserción: un mutante que deja
 * de crear la fila tiene que caer por lo que la prueba afirma, no por una excepción que escapa.
 */
export async function exigir<T>(consulta: Promise<T | null>): Promise<T> {
  const fila = await consulta
  expect(fila).not.toBeNull()
  return fila as T
}

// Los actores en vuelo de una carrera (Codex R8/R9 (l)) viven en `./actores.ts`: puro, con prueba unitaria propia.

export function exigirBaseDesechable(): void {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(url.pathname)) {
    throw new Error(`TEST_DATABASE_URL no apunta a una base local desechable: ${url.hostname}${url.pathname}`)
  }
}

/**
 * Purga los fixtures HUÉRFANOS del mismo prefijo (una corrida matada a medias deja su `afterAll(destruir)` sin correr) que lleven
 * más de 20 min en la base: sus filas quedan a la vista del resto de suites de la MISMA base desechable —`claimPaymentEffects` no
 * filtra por venue— y una obligación PENDING ajena reclamada por otra suite produce fallos que no son del código bajo prueba
 * (medido el 15-sep: un `s0-…` de una pasada abortada, con dos TRANSACTION_COST pendientes, tumbó un sabotaje de costo real con
 * «Venue … has no payment configuration»). El umbral de 20 min protege a un fixture VIVO de otra suite con el mismo prefijo que
 * corra en paralelo (ninguna suite dura tanto). Mismo orden que `limpiar()` + `destruir()`. Sólo en base desechable.
 */
async function purgarFixturesHuerfanos(prefijo: string): Promise<void> {
  const limite = new Date(Date.now() - 20 * 60_000)
  const huerfanas = await prisma.organization.findMany({
    where: { id: { startsWith: `${prefijo}-` }, createdAt: { lt: limite } },
    select: { id: true },
  })
  for (const { id } of huerfanas) {
    const venueId = id
    const logins = await prisma.angelPayUserAccount.findMany({ where: { venueId }, select: { id: true } })
    const merchants = await prisma.merchantAccount.findMany({
      where: { angelpayUserAccountId: { in: logins.map(l => l.id) } },
      select: { id: true },
    })
    await prisma.providerEventLog.deleteMany({ where: { eventId: { startsWith: `angelpay-${id}` } } })
    const sesionesDeVales = await prisma.areaTicketCheckoutSession.findMany({ where: { venueId }, select: { id: true } })
    if (sesionesDeVales.length > 0) {
      await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSessionId: { in: sesionesDeVales.map(s => s.id) } } })
      await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
    }
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
    await prisma.shift.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venuePricingStructure.deleteMany({ where: { venueId } })
    await prisma.venuePaymentConfig.deleteMany({ where: { venueId } })
    await prisma.providerCostStructure.deleteMany({ where: { merchantAccountId: { in: merchants.map(m => m.id) } } })
    await prisma.merchantAccount.deleteMany({ where: { id: { in: merchants.map(m => m.id) } } })
    await prisma.angelPayUserAccount.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.staffOrganization.deleteMany({ where: { organizationId: id } })
    await prisma.staff.deleteMany({ where: { email: `${id}-cajero@example.test` } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id } })
  }
  if (huerfanas.length > 0) console.warn(`[fixture] purgados ${huerfanas.length} fixture(s) huérfano(s) con prefijo «${prefijo}»`)
}

export interface IntentoRest {
  attemptId: string
  requestId?: string | null
  auth?: string
  ref?: string
  sinLlave?: boolean
  sinMerchant?: boolean
  /** `undefined` = el serial de la terminal del fixture (lo que pondría el controlador desde el JWT); `null` = sin identidad. */
  serialAutenticado?: string | null
  amount?: number
  tip?: number
  tarjeta?: { cardBrand?: string; maskedPan?: string; entryMode?: string; last4?: string; typeOfCard?: string; bank?: string }
}

export async function crearFixture(prefijo: string) {
  exigirBaseDesechable()
  await purgarFixturesHuerfanos(prefijo)
  const fixture = `${prefijo}-${randomUUID()}`
  const venueId = fixture
  const serialCrudo = `N86${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
  const serial = `AVQD-${serialCrudo}`
  const llaveTerminal = terminalIdentityKey(serial)
  let eventos = 0

  await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({
    data: { id: venueId, organizationId: fixture, name: fixture, slug: fixture, timezone: 'America/Mexico_City', currency: 'MXN' },
  })
  await prisma.terminal.create({ data: { venueId, name: 'N86 de prueba', serialNumber: serial, type: 'TPV_ANDROID' } })
  const staff = await prisma.staff.create({
    data: {
      email: `${fixture}-cajero@example.test`,
      firstName: 'Cajero',
      lastName: 'Webhook',
      phone: '5550000001',
      organizations: { create: { organizationId: fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
      venues: { create: { venueId, role: 'CASHIER', active: true } },
    },
  })
  const provider = await prisma.paymentProvider.upsert({
    where: { code: 'ANGELPAY' },
    update: {},
    create: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  const login = await prisma.angelPayUserAccount.create({
    data: { venueId, email: `${fixture}@angelpay.test`, environment: 'QA', status: 'ACTIVE' },
  })
  const merchantExternalId = `${prefijo}-${randomUUID().slice(0, 8)}`
  const merchant = await prisma.merchantAccount.create({
    data: {
      providerId: provider.id,
      externalMerchantId: merchantExternalId,
      alias: 'AngelPay de prueba',
      credentialsEncrypted: {},
      angelpayUserAccountId: login.id,
    },
  })

  const nuevaVenta = (total = 100) =>
    prisma.order.create({
      data: {
        venueId,
        orderNumber: `${fixture}-${randomUUID().slice(0, 8)}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: new Prisma.Decimal(total),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(total),
        createdById: staff.id,
      },
    })

  /** Solicitud POS → terminal en vuelo (SENT) de ESTA terminal, con o sin orden. Una en vuelo por terminal (índice). */
  const solicitud = (overrides: Record<string, unknown> = {}) =>
    prisma.terminalPaymentRequest.create({
      data: {
        requestId: randomUUID(),
        venueId,
        terminalId: llaveTerminal,
        orderId: null,
        amountCents: 10000,
        tipCents: 0,
        status: 'SENT',
        expiresAt: new Date(Date.now() + 5 * 60_000),
        ...overrides,
      } as Prisma.TerminalPaymentRequestUncheckedCreateInput,
    })

  /** Payload REST exacto de la terminal (`/tpv/orders/:id/payments` y `/tpv/fast`), importes en centavos. */
  const registroDeLaTerminal = (intento: IntentoRest) =>
    ({
      venueId,
      amount: intento.amount ?? 10000,
      tip: intento.tip ?? 0,
      status: 'COMPLETED',
      method: 'CREDIT_CARD',
      source: 'TPV',
      splitType: 'FULLPAYMENT',
      staffId: staff.id,
      // Codex R4: la autorización del banco pertenece al CARGO (misma referencia ⇒ misma auth en un reintento real); con otra
      // autorización ya no es un reintento sino otro cargo (colisión). Por defecto se deriva de la referencia.
      authorizationNumber: intento.auth ?? `AUTH-${(intento.ref ?? intento.attemptId).slice(-8)}`,
      referenceNumber: intento.ref ?? `REF-${intento.attemptId.slice(0, 12)}`,
      ...(intento.sinLlave ? {} : { idempotencyKey: intento.attemptId }),
      ...(intento.sinMerchant ? {} : { merchantAccountId: merchant.id }),
      ...(intento.tarjeta ?? {}),
      paidProductsId: [],
      currency: 'MXN',
      isInternational: false,
      deviceSerialNumber: serial,
      authenticatedTerminalSerial: intento.serialAutenticado === undefined ? serial : intento.serialAutenticado,
      ...(intento.requestId ? { terminalPaymentRequestId: intento.requestId } : {}),
    }) as any

  const eventoAngelPay = (attemptId: string | undefined, over: Record<string, unknown> = {}) => ({
    event_type: 'send_transaction',
    payload: {
      amount: '000000010000',
      description: 'APROBADA',
      status: 'approved',
      ...(attemptId ? { integratorReference: attemptId } : {}),
      transactionId: `${Date.now()}${++eventos}`,
      terminalSerial: serialCrudo,
      timestamp: new Date().toISOString(),
      ...over,
    },
  })

  const nuevoEventId = () => `${fixture}-ev-${++eventos}`

  // ─── Codex R3: tarifas REALES (proveedor, precio al negocio por slot, liquidación) para calcular el costo sin fakes ───
  type Tasas = {
    debitRate?: number
    creditRate?: number
    amexRate?: number
    internationalRate?: number
    fixed?: number
  }
  const VIGENTE_DESDE = new Date('2025-01-01T00:00:00Z')
  const secundarias: { id: string; loginId: string }[] = []
  const tasasBase = { debitRate: 0.02, creditRate: 0.025, amexRate: 0.035, internationalRate: 0.045, fixed: 0.5 }

  /** Configuración de liquidación (los cuatro tipos de tarjeta) para una afiliación. Idempotente. */
  const conLiquidacion = async (merchantAccountId = merchant.id) => {
    for (const cardType of ['CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL'] as const) {
      await prisma.settlementConfiguration.upsert({
        where: { merchantAccountId_cardType_effectiveFrom: { merchantAccountId, cardType, effectiveFrom: VIGENTE_DESDE } },
        update: {},
        create: {
          merchantAccountId,
          cardType,
          settlementDays: 1,
          settlementDayType: 'CALENDAR_DAYS',
          cutoffTime: '23:00',
          cutoffTimezone: 'America/Mexico_City',
          effectiveFrom: VIGENTE_DESDE,
        },
      })
    }
  }
  const sinLiquidacion = (merchantAccountId = merchant.id) => prisma.settlementConfiguration.deleteMany({ where: { merchantAccountId } })

  /** Una SEGUNDA afiliación de AngelPay del mismo venue (con su login, así el webhook también resuelve el venue por ella). */
  const afiliacionSecundaria = async () => {
    const loginM2 = await prisma.angelPayUserAccount.create({
      data: { venueId, email: `${fixture}-m2-${secundarias.length}@angelpay.test`, environment: 'QA', status: 'ACTIVE' },
    })
    const externalMerchantId = `${prefijo}-m2-${randomUUID().slice(0, 8)}`
    const m2 = await prisma.merchantAccount.create({
      data: {
        providerId: provider.id,
        externalMerchantId,
        alias: 'AngelPay secundaria de prueba',
        credentialsEncrypted: {},
        angelpayUserAccountId: loginM2.id,
      },
    })
    secundarias.push({ id: m2.id, loginId: loginM2.id })
    return { id: m2.id, externalMerchantId }
  }

  /**
   * Tarifas vigentes: configuración de pago del venue (PRIMARY = la afiliación del fixture, SECONDARY opcional), costo del
   * proveedor por afiliación, precio al negocio por slot y liquidación. Las tasas son «con IVA incluido» (se aplican tal cual).
   */
  const conTarifas = async (opciones: { primary?: Tasas; secundaria?: { merchantAccountId: string; tasas?: Tasas } } = {}) => {
    await conLiquidacion()
    if (opciones.secundaria) await conLiquidacion(opciones.secundaria.merchantAccountId)
    await prisma.venuePaymentConfig.upsert({
      where: { venueId },
      update: { primaryAccountId: merchant.id, secondaryAccountId: opciones.secundaria?.merchantAccountId ?? null },
      create: { venueId, primaryAccountId: merchant.id, secondaryAccountId: opciones.secundaria?.merchantAccountId ?? null },
    })
    const proveedor = async (merchantAccountId: string) =>
      prisma.providerCostStructure.create({
        data: {
          providerId: provider.id,
          merchantAccountId,
          debitRate: 0.015,
          creditRate: 0.02,
          amexRate: 0.03,
          internationalRate: 0.035,
          includesTax: true,
          fixedCostPerTransaction: 0.3,
          effectiveFrom: VIGENTE_DESDE,
          active: true,
        },
      })
    const negocio = async (accountType: 'PRIMARY' | 'SECONDARY', tasas: Tasas = {}) => {
      const t = { ...tasasBase, ...tasas }
      return prisma.venuePricingStructure.create({
        data: {
          venueId,
          accountType,
          debitRate: t.debitRate,
          creditRate: t.creditRate,
          amexRate: t.amexRate,
          internationalRate: t.internationalRate,
          includesTax: true,
          fixedFeePerTransaction: t.fixed,
          effectiveFrom: VIGENTE_DESDE,
          active: true,
        },
      })
    }
    await proveedor(merchant.id)
    await negocio('PRIMARY', opciones.primary)
    if (opciones.secundaria) {
      await proveedor(opciones.secundaria.merchantAccountId)
      await negocio('SECONDARY', opciones.secundaria.tasas)
    }
  }
  /** El negocio RETIRA una afiliación de su configuración (la tarifa contratada entonces sigue congelada en cada Payment). */
  const quitarDeLaConfiguracion = async (merchantAccountId: string) => {
    const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId } })
    if (!config) return
    await prisma.venuePaymentConfig.update({
      where: { venueId },
      data: {
        ...(config.secondaryAccountId === merchantAccountId ? { secondaryAccountId: null } : {}),
        ...(config.tertiaryAccountId === merchantAccountId ? { tertiaryAccountId: null } : {}),
      },
    })
  }
  const devolverALaConfiguracion = (merchantAccountId: string) =>
    prisma.venuePaymentConfig.update({ where: { venueId }, data: { secondaryAccountId: merchantAccountId } })
  const sinTarifas = async () => {
    const ids = [merchant.id, ...secundarias.map(s => s.id)]
    await prisma.venuePricingStructure.deleteMany({ where: { venueId } })
    await prisma.venuePaymentConfig.deleteMany({ where: { venueId } })
    await prisma.providerCostStructure.deleteMany({ where: { merchantAccountId: { in: ids } } })
    await prisma.settlementConfiguration.deleteMany({ where: { merchantAccountId: { in: ids } } })
  }

  // ─── Codex R3: barrera de carrera IDENTIFICADA — quién espera un candado MARCADO y quién lo bloquea, por pid ───
  /** Espera acotada para lo que corre fuera de la petición (fire-and-forget) o para una condición observable en la base. */
  const esperar = async (condicion: () => Promise<boolean>, ms = 4000): Promise<boolean> => {
    const hasta = Date.now() + ms
    while (Date.now() < hasta) {
      if (await condicion()) return true
      await new Promise(r => setTimeout(r, 40))
    }
    return condicion()
  }
  /** Conexiones que ESPERAN un candado cuyo SQL lleva el marcador en comentario (`arbitraje`, `consolidacion`) y sus bloqueadores (pids). */
  const bloqueadosEn = async (marcador: string): Promise<{ pid: number; bloqueadoPor: number[] }[]> => {
    if (!/^[a-z]+$/.test(marcador)) throw new Error(`marcador inválido: ${marcador}`)
    return prisma.$queryRawUnsafe(
      `SELECT pid, pg_blocking_pids(pid) AS "bloqueadoPor" FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%/* ${marcador} */%'`,
    )
  }
  /**
   * Espera a que AL MENOS `cuantos` conexiones NUEVAS (fuera de la línea base de pids) estén detenidas en el candado marcado;
   * devuelve quiénes y por quién. La línea base evita leer como propia una espera que dejó otra prueba.
   */
  const esperarBloqueados = async (marcador: string, cuantos = 1, ms = 5000, lineaBase: Iterable<number> = []) => {
    const base = new Set(lineaBase)
    let vistos: { pid: number; bloqueadoPor: number[] }[] = []
    await esperar(async () => {
      vistos = (await bloqueadosEn(marcador)).filter(e => !base.has(e.pid))
      return vistos.length >= cuantos
    }, ms)
    return vistos
  }
  /** Los pids que YA esperan ese candado (para la línea base de `esperarBloqueados`). */
  const pidsQueEsperan = async (marcador: string) => (await bloqueadosEn(marcador)).map(e => e.pid)

  /** Entre pruebas: todo lo que nace de un cobro. Los vínculos caen con la solicitud (cascade). */
  const limpiar = async () => {
    await prisma.providerEventLog.deleteMany({ where: { eventId: { startsWith: `angelpay-${fixture}` } } })
    const sesionesDeVales = await prisma.areaTicketCheckoutSession.findMany({ where: { venueId }, select: { id: true } })
    if (sesionesDeVales.length > 0) {
      await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSessionId: { in: sesionesDeVales.map(s => s.id) } } })
      await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
    }
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
    await prisma.shift.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
  }

  const destruir = async () => {
    await limpiar()
    await sinTarifas()
    await prisma.merchantAccount.deleteMany({ where: { id: { in: [merchant.id, ...secundarias.map(s => s.id)] } } })
    await prisma.angelPayUserAccount.deleteMany({ where: { id: { in: [login.id, ...secundarias.map(s => s.loginId)] } } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.staffOrganization.deleteMany({ where: { organizationId: fixture } })
    await prisma.staff.deleteMany({ where: { id: staff.id } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
  }

  return {
    fixture,
    venueId,
    serial,
    serialCrudo,
    llaveTerminal,
    staffId: staff.id,
    merchantId: merchant.id,
    merchantExternalId,
    nuevaVenta,
    solicitud,
    registroDeLaTerminal,
    eventoAngelPay,
    nuevoEventId,
    limpiar,
    destruir,
    conLiquidacion,
    sinLiquidacion,
    afiliacionSecundaria,
    conTarifas,
    sinTarifas,
    quitarDeLaConfiguracion,
    devolverALaConfiguracion,
    esperar,
    bloqueadosEn,
    esperarBloqueados,
    pidsQueEsperan,
  }
}

export type Fixture = Awaited<ReturnType<typeof crearFixture>>
