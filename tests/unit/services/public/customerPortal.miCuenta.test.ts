/**
 * S13 (P2-6): «Mi cuenta» en el portal y sus listas por páginas (pedidos, tarjetas, descuentos). Lo que filtra la base (vigencia,
 * sucursal, saldo a favor fuera) lo prueba la integración contra Postgres; aquí: forma, paginación con tope del servidor, cursor,
 * código sólo con contacto probado y revalidado bajo el candado (R1/R1'), estados (R6), el aviso firmado de otra ficha (R7') y que
 * una sección rota no tumba el portal (un 401 sí sube).
 */
jest.mock('@/services/wallet/stampLedger.service', () => ({ __esModule: true, getStampCardStatus: jest.fn() }))

import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { generateCustomerSession, verifyCustomerSession, type ContactoProbado } from '@/jwt.service'
import { encryptGiftCardCode, generateGiftCardCode } from '@/services/giftCards/giftCardCode'
import {
  getCustomerPortal,
  listarMisDescuentos,
  listarMisPedidos,
  listarMisTarjetas,
  tamanoDePagina,
} from '@/services/public/customerPortal.public.service'
import { respuestaDeEntrada, tapar } from '@/services/public/sesionDeCliente.service'
import { authenticateCustomer, authenticateOrderingCustomerOptional, type CustomerAuthContext } from '@/middlewares/customerAuth.middleware'
import { toActiveCursor } from '@/services/online-ordering/inbox.service'

const VENUE = 'cvenue000000000000000000a'
const ELLA = 'cficha00000000000000000a1'
const FICHA = {
  id: ELLA,
  firstName: 'Ana',
  lastName: null,
  email: 'ana@gmail.com',
  phone: '+525511112222',
  loyaltyPoints: 240,
  totalVisits: 2,
}
const TEL: ContactoProbado = { tipo: 'PHONE', valor: '+525511112222', metodo: 'WHATSAPP', probadoEn: 1_800_000_000 }
const CON_CONTACTO: CustomerAuthContext = {
  customerId: ELLA,
  venueId: VENUE,
  tipo: 'SESION',
  contactos: [TEL],
  accountActivatedAt: null,
  verifiedPhone: TEL.valor,
  v: 0,
}
const SIN_CONTACTO: CustomerAuthContext = { ...CON_CONTACTO, contactos: [], verifiedPhone: undefined }

/** Una consulta cruda como `{ sql, values }`, venga como plantilla (`tx.$queryRaw\`…\``, con sus fragmentos) o como `Prisma.sql`. */
const comoSql = (a: any, vals: unknown[] = []): { sql: string; values: unknown[] } =>
  Array.isArray(a)
    ? {
        sql: a.reduce((t: string, s: string, i: number) => t + s + (i < a.length - 1 ? ((vals[i] as any)?.sql ?? '?') : ''), ''),
        values: vals,
      }
    : { sql: a?.sql ?? '', values: a?.values ?? [] }
const texto = (a?: { sql: string }): string => a?.sql ?? ''
const valores = (a?: { values: unknown[] }): unknown[] => a?.values ?? []
/** Las consultas crudas hechas, en orden. */
const hechas = (): Array<{ sql: string; values: unknown[] }> => prismaMock.$queryRaw.mock.calls.map((c: any[]) => comoSql(c[0], c.slice(1)))

type Respuestas = {
  pedidos?: any[][]
  totalPedidos?: number
  tarjetas?: any[][]
  totalTarjetas?: number
  descuentos?: any[][]
  totalDescuentos?: number
  saldo?: any[]
  ficha?: any[]
}
/** Despacha cada consulta cruda por lo que dice su SQL. Las páginas se entregan en orden (primera llamada, segunda…). */
function crudas(r: Respuestas) {
  const colas = { pedidos: [...(r.pedidos ?? [[]])], tarjetas: [...(r.tarjetas ?? [[]])], descuentos: [...(r.descuentos ?? [[]])] }
  prismaMock.$queryRaw.mockReset().mockImplementation(async (a: any, ...vals: unknown[]) => {
    const sql = comoSql(a, vals).sql
    if (sql.includes('FOR SHARE')) return r.ficha ?? [{ active: true, versionDeSesion: 0, phone: FICHA.phone, email: FICHA.email }]
    if (sql.includes('candidatos AS (')) {
      return sql.includes('count(*)::int AS total FROM uno') ? [{ total: r.totalDescuentos ?? 0 }] : (colas.descuentos.shift() ?? [])
    }
    if (sql.includes('"OnlineOrder"')) {
      return sql.includes('count(*)') ? [{ total: r.totalPedidos ?? 0 }] : (colas.pedidos.shift() ?? [])
    }
    if (sql.includes('g.status IN')) return r.saldo ?? []
    if (sql.includes('"GiftCard" g')) {
      return sql.includes('count(*)') ? [{ total: r.totalTarjetas ?? 0 }] : (colas.tarjetas.shift() ?? [])
    }
    throw new Error(`consulta cruda no esperada: ${sql.slice(0, 80)}`)
  })
}

function armar(config: Record<string, unknown> | null = null) {
  prismaMock.customer.findFirst.mockReset().mockResolvedValue(FICHA as any)
  prismaMock.creditPackPurchase.findMany.mockResolvedValue([])
  prismaMock.reservation.findMany.mockReset().mockResolvedValue([])
  prismaMock.loyaltyConfig.findUnique.mockReset().mockResolvedValue(config as any)
  prismaMock.stampReward.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.venue.findUnique.mockReset().mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.$transaction.mockClear()
}

const base = Date.UTC(2026, 10, 10, 18, 0, 0)
/** `n` filas de pedido, de la más nueva a la más vieja (como las ordena el SQL). */
const pedidos = (n: number, desde = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `conline${String(desde + i).padStart(18, '0')}`,
    createdAt: new Date(base - (desde + i) * 60_000),
    status: 'COMPLETED',
    trackingToken: `tok${desde + i}`,
    orderNumber: `F-${desde + i}`,
    total: new Prisma.Decimal('125.50'),
    paymentStatus: (desde + i) % 2 ? 'PENDING' : 'PAID',
  }))
const codigo = generateGiftCardCode()
const tarjeta = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `cgift${String(i).padStart(20, '0')}`,
  createdAt: new Date(base - i * 60_000),
  codeLast4: codigo.last4,
  codeEnc: encryptGiftCardCode(codigo.normalized),
  balance: new Prisma.Decimal('300.00'),
  status: 'ACTIVE',
  expiresAt: null,
  ...extra,
})

beforeEach(() => armar())

describe('S13 · paginación con tope del servidor', () => {
  it('tamaño: 20 por omisión, 500 ⇒ 50, 0 y negativos ⇒ 1, basura ⇒ 20', () => {
    expect(tamanoDePagina(undefined)).toBe(20)
    expect(tamanoDePagina(500)).toBe(50)
    expect(tamanoDePagina(0)).toBe(1)
    expect(tamanoDePagina(-3)).toBe(1)
    expect(tamanoDePagina(Number.NaN)).toBe(20)
    expect(tamanoDePagina(7.9)).toBe(7)
  })

  it('con 21 pedidos el portal trae 20, total 21 y un nextCursor; listarMisPedidos con ese cursor trae el 21 y nextCursor null', async () => {
    armar()
    const todas = pedidos(21)
    crudas({ pedidos: [todas, todas.slice(20)], totalPedidos: 21 })
    const r: any = await getCustomerPortal(VENUE, ELLA, SIN_CONTACTO)
    expect(r.pedidos.items).toHaveLength(20)
    expect(r.pedidos.total).toBe(21)
    expect(r.pedidos.nextCursor).toBe(toActiveCursor(todas[19]))
    expect(r.pedidos.items[0]).toEqual({
      folio: 'F-0',
      estado: 'COMPLETED',
      pagado: true,
      total: 125.5,
      trackingToken: 'tok0',
      creadoEl: todas[0].createdAt.toISOString(),
    })
    expect(r.pedidos.items[1].pagado).toBe(false)

    const siguiente = await listarMisPedidos(VENUE, ELLA, { cursor: r.pedidos.nextCursor })
    expect(siguiente.items.map(p => p.folio)).toEqual(['F-20'])
    expect(siguiente.nextCursor).toBeNull()
    expect(siguiente.total).toBe(21)
    // El cursor viaja al SQL como (createdAt, id) del último de la página anterior, y la página pide tamaño + 1.
    const consultaDeLaSegunda = hechas().filter((a: any) => !texto(a).includes('count'))
    const ultima = consultaDeLaSegunda[consultaDeLaSegunda.length - 1]
    expect(texto(ultima)).toContain('(t."createdAt", t.id) <')
    expect(valores(ultima)).toEqual(expect.arrayContaining([todas[19].createdAt, todas[19].id, 21]))
  })

  it('limit 500 ⇒ la consulta pide 51 (50 + 1); sin pedidos ⇒ vacío y nextCursor null', async () => {
    crudas({ pedidos: [[]], totalPedidos: 0 })
    const r = await listarMisPedidos(VENUE, ELLA, { limit: 500 })
    expect(r).toEqual({ items: [], total: 0, nextCursor: null })
    const pagina = hechas().find((a: any) => !texto(a).includes('count'))
    expect(valores(pagina)).toContain(51)
    // Sólo sus pedidos: parte de su `Order` en esta sucursal y busca su `OnlineOrder` por `orderId`.
    expect(texto(pagina)).toContain('o."customerId" =')
    expect(valores(pagina)).toEqual(expect.arrayContaining([ELLA, VENUE]))
  })

  it.each(['basura', '2026-11-10T18:00:00.000Z', '2026-13-45T99:99:99.999Z_cid'])('cursor mal formado %p ⇒ 400 en español', async c => {
    crudas({})
    await expect(listarMisPedidos(VENUE, ELLA, { cursor: c })).rejects.toMatchObject({ statusCode: 400, message: 'Cursor inválido' })
    await expect(listarMisTarjetas(VENUE, ELLA, SIN_CONTACTO, { cursor: c })).rejects.toMatchObject({ statusCode: 400 })
    await expect(listarMisDescuentos(VENUE, ELLA, { cursor: c })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('con 21 tarjetas guardadas el portal trae 20, total 21 y nextCursor; listarMisTarjetas con ese cursor trae la 21', async () => {
    const todas = Array.from({ length: 21 }, (_, i) => tarjeta(i))
    crudas({ tarjetas: [todas, todas.slice(20)], totalTarjetas: 21 })
    const r: any = await getCustomerPortal(VENUE, ELLA, SIN_CONTACTO)
    expect(r.tarjetas.items).toHaveLength(20)
    expect(r.tarjetas.total).toBe(21)
    expect(r.tarjetas.nextCursor).toBe(toActiveCursor(todas[19]))
    const siguiente = await listarMisTarjetas(VENUE, ELLA, SIN_CONTACTO, { cursor: r.tarjetas.nextCursor, limit: 500 })
    expect(siguiente.items.map(t => t.id)).toEqual([todas[20].id])
    expect(siguiente.nextCursor).toBeNull()
    const paginas = hechas().filter((a: any) => texto(a).includes('ORDER BY t."createdAt"'))
    expect(valores(paginas[paginas.length - 1])).toContain(51)
  })

  it('descuentos: primera página con su vigencia, total y nextCursor; limit 500 ⇒ 51', async () => {
    const hasta = new Date('2026-12-31T05:59:59.000Z')
    const filas = Array.from({ length: 3 }, (_, i) => ({
      id: `cdesc${i}`,
      name: `Desc ${i}`,
      type: 'PERCENTAGE',
      value: new Prisma.Decimal('10.0000'),
      createdAt: new Date(base - i * 1000),
      hasta: i === 0 ? hasta : null,
    }))
    crudas({ descuentos: [filas], totalDescuentos: 5 })
    const r = await listarMisDescuentos(VENUE, ELLA, { limit: 2 })
    expect(r.items).toEqual([
      { nombre: 'Desc 0', tipo: 'PERCENTAGE', valor: 10, vigenteHasta: hasta.toISOString() },
      { nombre: 'Desc 1', tipo: 'PERCENTAGE', valor: 10, vigenteHasta: null },
    ])
    expect(r.total).toBe(5)
    expect(r.nextCursor).toBe(toActiveCursor(filas[1]))
    crudas({ descuentos: [[]] })
    await listarMisDescuentos(VENUE, ELLA, { limit: 500 })
    const pagina = hechas().find((a: any) => !texto(a).includes('AS total FROM uno'))
    expect(valores(pagina)).toContain(51)
  })
})

describe('S13 · descuentos (R3): una sola consulta con la vigencia de la asignación Y del catálogo', () => {
  it('asignados y de su grupo, con la intersección de fechas, activos y no agotados', async () => {
    crudas({ descuentos: [[]] })
    await listarMisDescuentos(VENUE, ELLA, {})
    const sql = texto(hechas()[0])
    expect(sql).toContain('LEAST(cd."validUntil", d."validUntil")')
    expect(sql).toContain('cd."validFrom" IS NULL OR cd."validFrom" <=')
    expect(sql).toContain('d."validUntil" IS NULL OR d."validUntil" >=')
    expect(sql).toContain('d."customerGroupId" = c."customerGroupId"')
    expect(sql).toContain('cd."usageCount" < cd."maxUses"')
    expect(sql).toContain('d."currentUses" < d."maxTotalUses"')
    expect(sql).toContain('DISTINCT ON (id)')
  })

  it('codex-s13-r2 #2: una asignación sin límite propio hereda el límite por clienta del catálogo, contado con SUS usos', async () => {
    crudas({ descuentos: [[]] })
    await listarMisDescuentos(VENUE, ELLA, {})
    const sql = texto(hechas()[0])
    // El override de la asignación manda; sin él, el del catálogo (schema: `maxUses` «Override discount maxUsesPerCustomer»).
    expect(sql).toMatch(
      /WHEN cd\."maxUses" IS NOT NULL THEN cd\."usageCount" < cd\."maxUses"\s+WHEN d\."maxUsesPerCustomer" IS NOT NULL THEN COALESCE\(\(SELECT u\.n FROM usos u/,
    )
    // Sus usos se cuentan UNA vez, desde SUS órdenes (nunca desde las aplicaciones del descuento, que son de todas las clientas).
    expect(sql).toContain('WITH usos AS MATERIALIZED')
    expect(sql).toMatch(
      /FROM "Order" o\s+CROSS JOIN LATERAL \(\s+SELECT od\."discountId" FROM "OrderDiscount" od WHERE od\."orderId" = o\.id/,
    )
    expect(sql).not.toContain('WHERE od."discountId" = d.id')
  })
})

describe('S13 · el portal', () => {
  it('puntos prendidos ⇒ saldo y su valor; apagados ⇒ null', async () => {
    armar({ active: true, stampsEnabled: false, redemptionRate: new Prisma.Decimal('0.05') })
    crudas({})
    const r: any = await getCustomerPortal(VENUE, ELLA, SIN_CONTACTO)
    expect(r.puntos).toEqual({ saldo: 240, valor: 12 })
    armar({ active: false, stampsEnabled: true, redemptionRate: new Prisma.Decimal('0.05') })
    crudas({})
    expect(((await getCustomerPortal(VENUE, ELLA, SIN_CONTACTO)) as any).puntos).toBeNull()
    armar(null)
    crudas({})
    expect(((await getCustomerPortal(VENUE, ELLA, SIN_CONTACTO)) as any).puntos).toBeNull()
  })

  it('premio disponible sólo con lealtad y sellos prendidos: el PENDING vigente más viejo', async () => {
    armar({ active: true, stampsEnabled: true, redemptionRate: new Prisma.Decimal('0.05') })
    crudas({})
    prismaMock.stampReward.findFirst.mockResolvedValue({ id: 'cpremio', rewardLabel: 'Un café gratis' } as any)
    const r: any = await getCustomerPortal(VENUE, ELLA, SIN_CONTACTO)
    expect(r.premioDisponible).toEqual({ id: 'cpremio', etiqueta: 'Un café gratis' })
    const q = prismaMock.stampReward.findFirst.mock.calls[0][0]
    expect(q.where).toMatchObject({ venueId: VENUE, customerId: ELLA, status: 'PENDING' })
    expect(q.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])

    armar({ active: true, stampsEnabled: false, redemptionRate: new Prisma.Decimal('0.05') })
    crudas({})
    expect(((await getCustomerPortal(VENUE, ELLA, SIN_CONTACTO)) as any).premioDisponible).toBeNull()
    expect(prismaMock.stampReward.findFirst).not.toHaveBeenCalled()
  })

  it('tarjetas: sólo las guardadas por ella (su customerId) y NUNCA un saldo a favor; el saldo a favor sale aparte y no ocupa lugar', async () => {
    crudas({
      tarjetas: [[tarjeta(0)]],
      totalTarjetas: 1,
      saldo: [{ codeLast4: '9876', balance: new Prisma.Decimal('80.00'), status: 'ACTIVE', expiresAt: null }],
    })
    const r: any = await getCustomerPortal(VENUE, ELLA, SIN_CONTACTO)
    expect(r.tarjetas.total).toBe(1)
    expect(r.tarjetas.items).toHaveLength(1)
    expect(r.saldoAFavor).toEqual({ last4: '9876', saldo: 80, codigo: null, venceEl: null, estado: 'ACTIVA', disponible: true })
    const llamadas = hechas()
    const deTarjetas = llamadas.filter((a: any) => texto(a).includes('"GiftCard" g') && !texto(a).includes('g.status IN'))
    expect(deTarjetas).toHaveLength(2) // la página y su total
    for (const q of deTarjetas) {
      expect(texto(q)).toContain('g."customerId" =')
      expect(texto(q)).toContain('AND NOT (SELECT EXISTS (SELECT 1 FROM "GiftCardActivity" saldo_a_favor_act')
      expect(valores(q)).toEqual(expect.arrayContaining([VENUE, ELLA]))
    }
    const delSaldo = llamadas.find((a: any) => texto(a).includes('g.status IN'))
    expect(texto(delSaldo)).toContain('refundPaymentId" IS NOT NULL')
    expect(texto(delSaldo)).toContain('ORDER BY g."createdAt" ASC, g.id ASC')
  })

  it('código sólo con un contacto probado: con él, dentro de una tx que toma la ficha FOR SHARE ANTES de leer la página', async () => {
    crudas({ tarjetas: [[tarjeta(0)]], totalTarjetas: 1 })
    const sin: any = await getCustomerPortal(VENUE, ELLA, SIN_CONTACTO)
    expect(sin.tarjetas.items[0].codigo).toBeNull()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(hechas().some(a => texto(a).includes('FOR SHARE'))).toBe(false)

    crudas({ tarjetas: [[tarjeta(0)]], totalTarjetas: 1 })
    const con: any = await getCustomerPortal(VENUE, ELLA, CON_CONTACTO)
    expect(con.tarjetas.items[0]).toMatchObject({ codigo: codigo.display, estado: 'ACTIVA', disponible: true, saldo: 300 })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    const orden = hechas().map(texto)
    const candado = orden.findIndex(s => s.includes('FOR SHARE'))
    const pagina = orden.findIndex(s => s.includes('ORDER BY t."createdAt"') && s.includes('"GiftCard" g'))
    expect(candado).toBeGreaterThanOrEqual(0)
    expect(candado).toBeLessThan(pagina)
    expect(orden[candado]).toContain('"venueId" =')

    // El token de reservas de hoy no prueba un contacto.
    crudas({ tarjetas: [[tarjeta(0)]], totalTarjetas: 1 })
    const reservas = await listarMisTarjetas(VENUE, ELLA, { ...CON_CONTACTO, tipo: 'RESERVAS_DE_HOY' }, {})
    expect(reservas.items[0].codigo).toBeNull()
  })

  it('R6: bloqueada, vencida y desactivada muestran su saldo, pero no como disponible y sin código', async () => {
    const ayer = new Date(Date.now() - 86_400_000)
    crudas({
      tarjetas: [
        [
          tarjeta(0, { status: 'BLOCKED' }),
          tarjeta(1, { expiresAt: ayer }),
          tarjeta(2, { status: 'DEACTIVATED' }),
          tarjeta(3, { expiresAt: new Date('2027-02-01T06:00:00.000Z') }),
        ],
      ],
      totalTarjetas: 4,
      saldo: [{ codeLast4: '9876', balance: new Prisma.Decimal('80.00'), status: 'BLOCKED', expiresAt: null }],
    })
    const r: any = await getCustomerPortal(VENUE, ELLA, CON_CONTACTO)
    expect(r.tarjetas.items.map((t: any) => [t.estado, t.disponible, t.codigo === null, t.saldo])).toEqual([
      ['BLOQUEADA', false, true, 300],
      ['VENCIDA', false, true, 300],
      ['DESACTIVADA', false, true, 300],
      ['ACTIVA', true, false, 300],
    ])
    expect(r.tarjetas.items[3].venceEl).toBe('2027-02-01') // en la zona del negocio, sin hora
    expect(r.saldoAFavor).toMatchObject({ estado: 'BLOQUEADA', disponible: false, saldo: 80, codigo: null })
  })

  it.each([
    ['la versión de la sesión quedó vieja (S8)', { active: true, versionDeSesion: 1, phone: FICHA.phone, email: FICHA.email }],
    ['el teléfono probado ya no es el de la ficha', { active: true, versionDeSesion: 0, phone: '+525599998888', email: FICHA.email }],
    ["la ficha se desactivó (R1')", { active: false, versionDeSesion: 0, phone: FICHA.phone, email: FICHA.email }],
  ])('R1: %s bajo el candado ⇒ 401 CUSTOMER_REAUTH_REQUIRED y el portal no esconde el 401 ni revela un código', async (_c, ficha) => {
    crudas({ tarjetas: [[tarjeta(0)]], totalTarjetas: 1, ficha: [ficha] })
    await expect(getCustomerPortal(VENUE, ELLA, CON_CONTACTO)).rejects.toMatchObject({
      statusCode: 401,
      code: 'CUSTOMER_REAUTH_REQUIRED',
    })
    await expect(listarMisTarjetas(VENUE, ELLA, CON_CONTACTO, {})).rejects.toMatchObject({ code: 'CUSTOMER_REAUTH_REQUIRED' })
    expect(hechas().some(a => texto(a).includes('ORDER BY t."createdAt"') && texto(a).includes('"GiftCard"'))).toBe(false)
  })

  it("R1': la ficha no existe en ESTA sucursal ⇒ 401 (el candado filtra por id y sucursal)", async () => {
    crudas({ tarjetas: [[tarjeta(0)]], ficha: [] })
    await expect(listarMisTarjetas(VENUE, ELLA, CON_CONTACTO, {})).rejects.toMatchObject({ code: 'CUSTOMER_REAUTH_REQUIRED' })
    const candado = hechas().find((a: any) => texto(a).includes('FOR SHARE'))
    expect(texto(candado)).toContain('"venueId" =')
  })

  it('una sección que falla sale null y el resto del portal sigue', async () => {
    crudas({})
    prismaMock.$queryRaw.mockRejectedValue(new Error('se cayó la base'))
    const r: any = await getCustomerPortal(VENUE, ELLA, SIN_CONTACTO)
    expect(r.customer.id).toBe(ELLA)
    expect(r.reservations).toBeDefined()
    expect(r.pedidos).toBeNull()
    expect(r.tarjetas).toBeNull()
    expect(r.descuentos).toBeNull()
    expect(r.saldoAFavor).toBeNull()
  })
})

describe("S13 (R7') · el aviso de otra ficha sobrevive al volver a «Mi cuenta», firmado en la sesión", () => {
  const ficha = { id: ELLA, firstName: 'Ana', lastName: null, email: FICHA.email, phone: FICHA.phone, versionDeSesion: 0 } as any
  const otraFicha = { contacto: 'EMAIL' as const, enmascarado: 'a•••@gmail.com' }

  async function portalCon(token: string) {
    prismaMock.customer.findFirst.mockReset()
    prismaMock.customer.findFirst.mockResolvedValueOnce({
      id: ELLA,
      venueId: VENUE,
      active: true,
      versionDeSesion: 0,
      phone: FICHA.phone,
      email: FICHA.email,
      accountActivatedAt: new Date(),
    } as any)
    const req: any = { headers: { authorization: `Bearer ${token}` }, publicVenue: { id: VENUE, slug: 'ana' } }
    const res: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()
    await authenticateCustomer(req, res, next)
    expect(next).toHaveBeenCalledWith()
    prismaMock.customer.findFirst.mockResolvedValue(FICHA as any)
    crudas({})
    return { auth: req.customerAuth as CustomerAuthContext, portal: (await getCustomerPortal(VENUE, ELLA, req.customerAuth)) as any }
  }

  it('entrar con dos fichas ⇒ el token lleva otraFicha tapada ⇒ el middleware la pasa en auth ⇒ el portal la devuelve', async () => {
    const r: any = respuestaDeEntrada(VENUE, TEL, { nueva: false, ficha, contactos: [TEL], avisos: [], otraFicha })
    expect(verifyCustomerSession(r.token).otraFicha).toEqual(otraFicha)
    const { auth, portal } = await portalCon(r.token)
    expect(auth.otraFicha).toEqual(otraFicha)
    expect(auth.contactos).toEqual([TEL]) // nunca el contacto rechazado
    expect(portal.otraFicha).toEqual(otraFicha)
  })

  it('entrar sin conflicto ⇒ sin aviso; un token de antes (sin el campo) tampoco lo muestra', async () => {
    const r: any = respuestaDeEntrada(VENUE, TEL, { nueva: false, ficha, contactos: [TEL], avisos: [], otraFicha: null })
    expect(verifyCustomerSession(r.token).otraFicha).toBeUndefined()
    expect((await portalCon(r.token)).portal.otraFicha).toBeNull()
    const viejo = generateCustomerSession({ sub: ELLA, venueId: VENUE, v: 0, contactos: [TEL] })
    expect((await portalCon(viejo)).portal.otraFicha).toBeNull()
  })

  it('codex-s13-r3 #1: un otraFicha mal formado (o de esta ronda, sin acotar) dentro de un token firmado se IGNORA: la sesión sirve', async () => {
    const jwt = require('jsonwebtoken')
    const firmar = (otra: unknown) =>
      jwt.sign(
        { sub: ELLA, venueId: VENUE, type: 'customer_session', v: 0, contactos: [TEL], otraFicha: otra },
        process.env.ACCESS_TOKEN_SECRET,
        {
          expiresIn: 60,
          algorithm: 'HS256',
        },
      )
    for (const malo of [
      { contacto: 'X', enmascarado: 'a•••@x.com' },
      { contacto: 'EMAIL', enmascarado: '' },
      { contacto: 'EMAIL', enmascarado: 'a'.repeat(131) },
      'basura',
    ]) {
      const token = firmar(malo)
      const sesion = verifyCustomerSession(token)
      expect(sesion.sub).toBe(ELLA)
      expect(sesion.otraFicha).toBeUndefined()
      const { auth, portal } = await portalCon(token)
      expect(auth.otraFicha).toBeUndefined()
      expect(portal.otraFicha).toBeNull()
    }
    // Una firma mala sigue siendo una sesión inválida.
    const ajeno = jwt.sign({ sub: ELLA, venueId: VENUE, type: 'customer_session', v: 0, contactos: [TEL] }, 'otra-llave', {
      expiresIn: 60,
      algorithm: 'HS256',
    })
    expect(() => verifyCustomerSession(ajeno)).toThrow()
  })

  it('codex-s13-r3 #1: un correo válido de 128 caracteres (tres etiquetas de 40 y .com) ⇒ el aviso sale recortado con «…» y la sesión sirve para reservar, pedir y abrir «Mi cuenta»', async () => {
    const correo = `a@${'b'.repeat(40)}.${'c'.repeat(40)}.${'d'.repeat(40)}.com`
    expect(correo).toHaveLength(128)
    const completo = tapar({ tipo: 'EMAIL', valor: correo, metodo: 'EMAIL_CODE', probadoEn: 1_800_000_000 })
    expect(completo.enmascarado.length).toBeGreaterThan(120) // lo que antes invalidaba la sesión entera
    const r: any = respuestaDeEntrada(VENUE, TEL, { nueva: false, ficha, contactos: [TEL], avisos: [], otraFicha: completo })
    const firmado = verifyCustomerSession(r.token).otraFicha!
    expect(firmado.contacto).toBe('EMAIL')
    expect(firmado.enmascarado.length).toBeLessThanOrEqual(120)
    expect(firmado.enmascarado.endsWith('…')).toBe(true)
    expect(firmado.enmascarado.startsWith('a•••@bbbb')).toBe(true)

    // Reservar (sesión obligatoria) y pedir (sesión opcional de pedidos): la misma sesión pasa por los dos middlewares.
    for (const middleware of [authenticateCustomer, authenticateOrderingCustomerOptional]) {
      prismaMock.customer.findFirst.mockReset().mockResolvedValueOnce({
        id: ELLA,
        venueId: VENUE,
        active: true,
        versionDeSesion: 0,
        phone: FICHA.phone,
        email: FICHA.email,
        accountActivatedAt: new Date(),
      } as any)
      const req: any = { headers: { authorization: `Bearer ${r.token}` }, publicVenue: { id: VENUE, slug: 'ana' } }
      const res: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() }
      const next = jest.fn()
      await middleware(req, res, next)
      expect(next).toHaveBeenCalledWith()
      expect(res.status).not.toHaveBeenCalled()
      expect(req.customerAuth.otraFicha).toEqual(firmado)
    }
    // «Mi cuenta» lo devuelve recortado.
    expect((await portalCon(r.token)).portal.otraFicha).toEqual(firmado)
  })
})
