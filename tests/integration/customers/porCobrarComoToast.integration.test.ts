/**
 * 🔴 «Por cobrar» como Toast (founder 26-oct, hz:898a8a42:D1): sólo es deuda del cliente lo que el cajero mandó a «Pagar
 * después». Amaena: un cobro con tarjeta que el banco rechazó (o con la terminal ocupada) dejaba la cuenta abierta con su
 * cliente y salía como deuda en «Cuentas por cobrar», en el saldo del cliente y en su «Liquidar todo», que la habría
 * marcado como pagada en efectivo sin que nadie pagara.
 *
 * Un mismo cliente con tres cuentas abiertas: «Pagar después» (payLater = true), un cobro con tarjeta que falló
 * (payLater = false) y una vieja sin marca (null, la regla de antes). Contra Postgres real.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { getCustomers, settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { getPayLaterAgingReport } from '@/services/dashboard/reports.dashboard.service'
import { getOrders } from '@/services/tpv/order.tpv.service'
import { mergeOrders, splitOrderBySeat, splitOrderItems } from '@/services/mobile/order.mobile.service'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({ socketManager: { broadcastToVenue: jest.fn() } }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
  postCashRefundToDrawer: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))

describe('«Por cobrar» sólo lo que el cajero mandó a «Pagar después» (integración)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let clienteId: string
  const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const cuentas: Record<'fiado' | 'tarjetaFallida' | 'vieja', string> = { fiado: '', tarjetaFallida: '', vieja: '' }

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: 'ITEST PorCobrar', email: `itest-porcobrar-${sello}@test.com`, phone: '5550000000' } })
    ).id
    venueId = (
      await prisma.venue.create({
        data: { name: `itest-porcobrar-${sello}`, slug: `itest-porcobrar-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
      })
    ).id
    clienteId = (await prisma.customer.create({ data: { venueId, firstName: 'Eva', lastName: 'Fiado' } })).id
    let k = 0
    const cuenta = async (payLater: boolean | null, saldo: number) => {
      const o = await prisma.order.create({
        data: {
          venueId: venueId!,
          orderNumber: `ITEST-PORCOBRAR-${sello}-${++k}`,
          subtotal: saldo,
          taxAmount: 0,
          total: saldo,
          remainingBalance: saldo,
          paymentStatus: 'PENDING',
          status: 'CONFIRMED',
          customerId: clienteId,
          payLater,
        },
      })
      await prisma.orderCustomer.create({ data: { orderId: o.id, customerId: clienteId, isPrimary: true } })
      return o.id
    }
    cuentas.fiado = await cuenta(true, 100)
    cuentas.tarjetaFallida = await cuenta(false, 577.5)
    cuentas.vieja = await cuenta(null, 50)
  })

  afterAll(async () => {
    // 🔴 Sin fixture no se limpia NADA.
    if (!venueId || !orgId) return
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('el reporte «Cuentas por cobrar» lista el fiado y la vieja, no la tarjeta que falló', async () => {
    const reporte = await getPayLaterAgingReport(venueId!)
    const ids = reporte.orders.aging_0_30.map(o => o.id).sort()
    expect(ids).toEqual([cuentas.fiado, cuentas.vieja].sort())
    expect(reporte.summary.total_balance).toBe(150)
  })

  it('el saldo pendiente del cliente no suma la tarjeta que falló (Prisma y SQL)', async () => {
    const conFiltro = await getCustomers(venueId!, 1, 20, undefined, undefined, undefined, undefined, 'createdAt', 'desc', true)
    const eva = conFiltro.data.find(c => c.id === clienteId)
    expect(eva).toMatchObject({ pendingOrderCount: 2, pendingBalance: 150 })
    // Con búsqueda pasa por el prefiltro en SQL crudo (`sqlDeFiltrosDeClientes`).
    const buscando = await getCustomers(venueId!, 1, 20, 'Eva', undefined, undefined, undefined, 'createdAt', 'desc', true)
    expect(buscando.data.map(c => c.id)).toEqual([clienteId])
  })

  it('la TPV: «pagar después» trae el fiado y la vieja; la lista normal trae la tarjeta que falló', async () => {
    const fiados = await getOrders(venueId!, orgId, { onlyPayLater: true })
    expect(fiados.map(o => o.id).sort()).toEqual([cuentas.fiado, cuentas.vieja].sort())
    const normales = await getOrders(venueId!, orgId)
    expect(normales.map(o => o.id)).toEqual([cuentas.tarjetaFallida])
  })

  it('🔴 «Liquidar todo» paga el fiado y la vieja, y deja abierta la tarjeta que falló', async () => {
    const r = await settleCustomerBalance(venueId!, clienteId, 'Pagó su fiado', null)
    expect(r).toMatchObject({ settledOrderCount: 2, settledAmount: 150 })
    const estados = await prisma.order.findMany({ where: { venueId }, select: { id: true, paymentStatus: true } })
    const de = (id: string) => estados.find(o => o.id === id)?.paymentStatus
    expect(de(cuentas.fiado)).toBe('PAID')
    expect(de(cuentas.vieja)).toBe('PAID')
    expect(de(cuentas.tarjetaFallida)).toBe('PENDING')
  })
})

/**
 * Dividir o juntar una cuenta conserva la MARCA de fiado: la parte separada la hereda y, al juntar, el fiado gana
 * (`combinarPayLater`). Que conserve también al CLIENTE se prueba en el bloque siguiente (hz:01185fe7:D2).
 */
describe('dividir y juntar conservan la marca «Pagar después» (integración)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  let k = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: 'ITEST Fiado Dividido', email: `itest-fiado-div-${sello}@test.com`, phone: '5550000000' } })
    ).id
    venueId = (
      await prisma.venue.create({
        data: { name: `itest-fiado-div-${sello}`, slug: `itest-fiado-div-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
      })
    ).id
  })

  afterAll(async () => {
    // 🔴 Sin fixture no se limpia NADA.
    if (!venueId || !orgId) return
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  /** Una cuenta con `n` renglones de $50 y su marca. */
  async function cuenta(n: number, payLater: boolean | null) {
    const o = await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `ITEST-FIADO-DIV-${sello}-${++k}`,
        subtotal: 50 * n,
        taxAmount: 0,
        total: 50 * n,
        remainingBalance: 50 * n,
        paymentStatus: 'PENDING',
        status: 'CONFIRMED',
        payLater,
      },
    })
    for (let i = 0; i < n; i++) {
      await prisma.orderItem.create({
        data: { orderId: o.id, productName: `Artículo ${i + 1}`, quantity: 1, unitPrice: 50, taxAmount: 0, total: 50 },
      })
    }
    const items = await prisma.orderItem.findMany({ where: { orderId: o.id }, select: { id: true }, orderBy: { id: 'asc' } })
    return { id: o.id, itemIds: items.map(i => i.id) }
  }
  const marca = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id }, select: { payLater: true } })).payLater

  it.each([true, false, null])('separar un artículo: la cuenta nueva hereda la marca (%p)', async payLater => {
    const origen = await cuenta(2, payLater)
    const { created } = await splitOrderItems(venueId!, origen.id, [origen.itemIds[0]])
    expect(await marca(created.id)).toBe(payLater)
  })

  it('🔴 juntar un fiado en una cuenta de cobro del momento: lo que queda es fiado', async () => {
    const fiado = await cuenta(1, true)
    const mostrador = await cuenta(1, false)
    await mergeOrders(venueId!, mostrador.id, fiado.id)
    expect(await marca(mostrador.id)).toBe(true)
  })

  it('juntar dos cobros del momento: sigue siendo cobro del momento', async () => {
    const a = await cuenta(1, false)
    const b = await cuenta(1, false)
    await mergeOrders(venueId!, a.id, b.id)
    expect(await marca(a.id)).toBe(false)
  })
})

/**
 * 🔴 Un fiado no pierde a su cliente al dividir o juntar (hz:01185fe7:D2, founder 27-oct). Los lectores de deuda piden un
 * `OrderCustomer`: la parte separada de un «Pagar después» de Ana sin ese vínculo se borraba de su saldo, y juntar su fiado
 * en una cuenta sin cliente lo desaparecía entero. Si la otra cuenta es de OTRA persona no se juntan (founder: «a»).
 * Las cuentas que no son fiado se dividen como antes, sin copiar al cliente.
 */
describe('un fiado conserva a su cliente al dividir o juntar (integración)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  let k = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: 'ITEST Fiado Cliente', email: `itest-fiado-cli-${sello}@test.com`, phone: '5550000000' } })
    ).id
    venueId = (
      await prisma.venue.create({
        data: { name: `itest-fiado-cli-${sello}`, slug: `itest-fiado-cli-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
      })
    ).id
  })

  afterAll(async () => {
    // 🔴 Sin fixture no se limpia NADA.
    if (!venueId || !orgId) return
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  const cliente = async (nombre: string) => (await prisma.customer.create({ data: { venueId: venueId!, firstName: nombre, lastName: sello } })).id

  /**
   * Una cuenta con un renglón de $50 por asiento (1, 2, …). `dueno`: con «vinculo» lleva `customerId` y su `OrderCustomer`
   * primario, como la crea el POS; con «soloCustomerId», sólo `customerId`, como la deja «Detalles de la cuenta».
   */
  async function cuenta(asientos: number, payLater: boolean | null, dueno?: { id: string; forma: 'vinculo' | 'soloCustomerId' }) {
    const o = await prisma.order.create({
      data: {
        venueId: venueId!,
        orderNumber: `ITEST-FIADO-CLI-${sello}-${++k}`,
        subtotal: 50 * asientos,
        taxAmount: 0,
        total: 50 * asientos,
        remainingBalance: 50 * asientos,
        paymentStatus: 'PENDING',
        status: 'CONFIRMED',
        payLater,
        customerId: dueno?.id ?? null,
      },
    })
    if (dueno?.forma === 'vinculo') await prisma.orderCustomer.create({ data: { orderId: o.id, customerId: dueno.id, isPrimary: true } })
    for (let i = 0; i < asientos; i++) {
      await prisma.orderItem.create({
        data: { orderId: o.id, productName: `Artículo ${i + 1}`, quantity: 1, unitPrice: 50, taxAmount: 0, total: 50, seat: i + 1 },
      })
    }
    const items = await prisma.orderItem.findMany({ where: { orderId: o.id }, select: { id: true }, orderBy: { seat: 'asc' } })
    return { id: o.id, itemIds: items.map(i => i.id) }
  }

  /** Lo que el SERVIDOR le cuenta como deuda al cliente (el mismo lector del saldo y de «Liquidar todo»). */
  async function deuda(customerId: string) {
    const r = await getCustomers(venueId!, 1, 50, undefined, undefined, undefined, undefined, 'createdAt', 'desc', true)
    const c = r.data.find(x => x.id === customerId)
    return c ? { cuentas: c.pendingOrderCount, saldo: Number(c.pendingBalance) } : { cuentas: 0, saldo: 0 }
  }
  const vinculos = async (orderId: string) =>
    prisma.orderCustomer.findMany({ where: { orderId }, select: { customerId: true, isPrimary: true }, orderBy: { customerId: 'asc' } })

  it('🔴 separar un artículo de un fiado: las dos partes siguen siendo deuda del cliente', async () => {
    const ana = await cliente('AnaSep')
    const fiado = await cuenta(2, true, { id: ana, forma: 'vinculo' })
    const { created } = await splitOrderItems(venueId!, fiado.id, [fiado.itemIds[1]])
    expect(await vinculos(created.id)).toEqual([{ customerId: ana, isPrimary: true }])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: created.id } })).customerId).toBe(ana)
    expect(await deuda(ana)).toEqual({ cuentas: 2, saldo: 100 })
  })

  it('🔴 dividir un fiado por asiento: cada cheque sigue siendo deuda del cliente', async () => {
    const ana = await cliente('AnaAsiento')
    const fiado = await cuenta(3, true, { id: ana, forma: 'vinculo' })
    await splitOrderBySeat(venueId!, fiado.id)
    expect(await deuda(ana)).toEqual({ cuentas: 3, saldo: 150 })
  })

  it('separar una cuenta que NO es fiado no copia al cliente (como antes)', async () => {
    const leo = await cliente('LeoNoFiado')
    const normal = await cuenta(2, false, { id: leo, forma: 'vinculo' })
    const { created } = await splitOrderItems(venueId!, normal.id, [normal.itemIds[1]])
    expect(await vinculos(created.id)).toEqual([])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: created.id } })).customerId).toBeNull()
  })

  it('🔴 juntar el fiado de Ana en una cuenta sin cliente: la deuda entera queda a nombre de Ana', async () => {
    const ana = await cliente('AnaJunta')
    const fiado = await cuenta(2, true, { id: ana, forma: 'vinculo' })
    const sinCliente = await cuenta(1, null)
    await mergeOrders(venueId!, sinCliente.id, fiado.id)
    expect(await vinculos(sinCliente.id)).toEqual([{ customerId: ana, isPrimary: true }])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: sinCliente.id } })).customerId).toBe(ana)
    expect(await deuda(ana)).toEqual({ cuentas: 1, saldo: 150 })
  })

  it('juntar el fiado de Ana en una cuenta que sólo tiene a Ana en «Detalles»: le pone su vínculo', async () => {
    const ana = await cliente('AnaDetalles')
    const fiado = await cuenta(1, true, { id: ana, forma: 'vinculo' })
    const destino = await cuenta(1, null, { id: ana, forma: 'soloCustomerId' })
    await mergeOrders(venueId!, destino.id, fiado.id)
    expect(await vinculos(destino.id)).toEqual([{ customerId: ana, isPrimary: true }])
    expect(await deuda(ana)).toEqual({ cuentas: 1, saldo: 100 })
  })

  it.each(['vinculo', 'soloCustomerId'] as const)(
    '🔴 juntar el fiado de Ana en la cuenta de Bruno (%s) se rechaza y no cambia nada',
    async forma => {
      const ana = await cliente(`AnaVsBruno${forma}`)
      const bruno = await cliente(`Bruno${forma}`)
      const fiado = await cuenta(2, true, { id: ana, forma: 'vinculo' })
      const deBruno = await cuenta(1, null, { id: bruno, forma })
      await expect(mergeOrders(venueId!, deBruno.id, fiado.id)).rejects.toMatchObject({ code: 'MERGE_FIADO_DE_OTRO_CLIENTE' })
      const origen = await prisma.order.findUniqueOrThrow({ where: { id: fiado.id }, select: { status: true, _count: { select: { items: true } } } })
      expect(origen).toMatchObject({ status: 'CONFIRMED', _count: { items: 2 } })
      expect(await deuda(ana)).toEqual({ cuentas: 1, saldo: 100 })
    },
  )

  it('🔴 juntar al revés (la cuenta de Bruno dentro del fiado de Ana) también se rechaza', async () => {
    const ana = await cliente('AnaReves')
    const bruno = await cliente('BrunoReves')
    const fiado = await cuenta(1, true, { id: ana, forma: 'vinculo' })
    const deBruno = await cuenta(1, null, { id: bruno, forma: 'vinculo' })
    await expect(mergeOrders(venueId!, fiado.id, deBruno.id)).rejects.toMatchObject({ code: 'MERGE_FIADO_DE_OTRO_CLIENTE' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: deBruno.id } })).status).toBe('CONFIRMED')
    expect(await deuda(ana)).toEqual({ cuentas: 1, saldo: 50 })
  })

  it('juntar una cuenta SIN cliente dentro del fiado de Ana: se suma a su deuda (como antes)', async () => {
    const ana = await cliente('AnaRecibe')
    const fiado = await cuenta(1, true, { id: ana, forma: 'vinculo' })
    const sinCliente = await cuenta(1, null)
    await mergeOrders(venueId!, fiado.id, sinCliente.id)
    expect(await deuda(ana)).toEqual({ cuentas: 1, saldo: 100 })
  })

  it('🔴 un fiado con un cliente en «Detalles» y otro en su vínculo no se divide ni se junta (no se adivina)', async () => {
    const ana = await cliente('AnaDos')
    const bruno = await cliente('BrunoDos')
    const fiado = await cuenta(2, true, { id: ana, forma: 'vinculo' })
    await prisma.order.update({ where: { id: fiado.id }, data: { customerId: bruno } }) // lo que hace «Detalles de la cuenta»
    await expect(splitOrderItems(venueId!, fiado.id, [fiado.itemIds[1]])).rejects.toMatchObject({ code: 'FIADO_CON_DOS_CLIENTES' })
    const sinCliente = await cuenta(1, null)
    await expect(mergeOrders(venueId!, sinCliente.id, fiado.id)).rejects.toMatchObject({ code: 'FIADO_CON_DOS_CLIENTES' })
    expect(await prisma.orderItem.count({ where: { orderId: fiado.id } })).toBe(2)
  })

  it('🔴 un fiado con el cliente sólo en «Detalles»: al separarlo, las DOS partes salen como su deuda', async () => {
    const ana = await cliente('AnaSoloDetalles')
    const fiado = await cuenta(2, true, { id: ana, forma: 'soloCustomerId' })
    const { created } = await splitOrderItems(venueId!, fiado.id, [fiado.itemIds[1]])
    expect(await vinculos(created.id)).toEqual([{ customerId: ana, isPrimary: true }])
    expect(await vinculos(fiado.id)).toEqual([{ customerId: ana, isPrimary: true }])
    expect(await deuda(ana)).toEqual({ cuentas: 2, saldo: 100 })
  })

  it('🔴 un fiado con el cliente sólo en «Detalles» recibe una cuenta sin cliente: toda la deuda sale a su nombre', async () => {
    const ana = await cliente('AnaDestinoDetalles')
    const fiado = await cuenta(1, true, { id: ana, forma: 'soloCustomerId' })
    const sinCliente = await cuenta(1, null)
    await mergeOrders(venueId!, fiado.id, sinCliente.id)
    expect(await deuda(ana)).toEqual({ cuentas: 1, saldo: 100 })
  })

  it('🔴 juntar un fiado en una cuenta normal con un cliente en «Detalles» y otro en su vínculo: se rechaza', async () => {
    const ana = await cliente('AnaNormalDos')
    const bruno = await cliente('BrunoNormalDos')
    const fiado = await cuenta(1, true, { id: ana, forma: 'vinculo' })
    const normal = await cuenta(1, null, { id: ana, forma: 'vinculo' })
    await prisma.order.update({ where: { id: normal.id }, data: { customerId: bruno } }) // «Detalles» cambia a Bruno
    await expect(mergeOrders(venueId!, normal.id, fiado.id)).rejects.toMatchObject({ code: 'FIADO_CON_DOS_CLIENTES' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: fiado.id } })).status).toBe('CONFIRMED')
  })

  it('🔴 dividir un fiado mientras se borran los datos de prueba del negocio no se interbloquea (Codex r1 de D2)', async () => {
    const ana = await cliente('AnaLimpieza')
    const fiado = await cuenta(2, true, { id: ana, forma: 'vinculo' })
    // La limpieza (`demoCleanup`): aparta el Negocio (FOR UPDATE) y después borra clientes (toca su fila en exclusiva).
    let soltar!: () => void
    const espera = new Promise<void>(r => (soltar = r))
    let apartado!: () => void
    const negocioApartado = new Promise<void>(r => (apartado = r))
    const limpieza = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT 1 FROM "Venue" WHERE id = ${venueId} FOR UPDATE`
        apartado()
        await espera
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${ana} FOR UPDATE`
      },
      { timeout: 20000 },
    )
    await negocioApartado
    const dividir = splitOrderItems(venueId!, fiado.id, [fiado.itemIds[1]])
    await new Promise(r => setTimeout(r, 1500))
    soltar()
    await expect(Promise.all([limpieza, dividir])).resolves.toBeDefined()
    expect(await deuda(ana)).toEqual({ cuentas: 2, saldo: 100 })
  })

  it('🔴 juntar mientras el cobro actualiza las métricas del cliente no se interbloquea (Codex r3)', async () => {
    const ana = await cliente('AnaCandado')
    const fiado = await cuenta(1, true, { id: ana, forma: 'vinculo' })
    const destino = await cuenta(1, null)
    // Las métricas del cobro: apartan al Cliente (FOR UPDATE) y después tocan la cuenta (FK → FOR KEY SHARE).
    let soltarMetricas!: () => void
    const metricasEsperan = new Promise<void>(r => (soltarMetricas = r))
    let clienteApartado!: () => void
    const clienteYaApartado = new Promise<void>(r => (clienteApartado = r))
    const metricas = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${ana} FOR UPDATE`
        clienteApartado()
        await metricasEsperan
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${destino.id} FOR KEY SHARE`
      },
      { timeout: 20000 },
    )
    await clienteYaApartado
    const juntar = mergeOrders(venueId!, destino.id, fiado.id)
    // Tiempo para que la fusión llegue a donde se forma el ciclo si aparta las cuentas antes que al cliente.
    await new Promise(r => setTimeout(r, 1500))
    soltarMetricas()
    await expect(Promise.all([metricas, juntar])).resolves.toBeDefined()
    expect(await deuda(ana)).toEqual({ cuentas: 1, saldo: 100 })
  })
})
