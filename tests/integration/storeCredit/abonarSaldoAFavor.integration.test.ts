/**
 * Saldo a favor en la libreta contra Postgres REAL (spec 2026-10-30-saldo-a-favor §5.2, tarea S2). Lo que un mock no puede probar:
 * el candado por clienta serializa a dos cajas que le dan su PRIMER saldo a la misma clienta a la vez (queda UN sobre), y el predicado
 * separa su sobre de saldo de una tarjeta regalada que ella ya tenía guardada (customerId sin refundPaymentId).
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "abonarSaldoAFavor" --ci
 *
 * La libreta no se puede borrar (trigger): la base es desechable y este archivo no limpia; usa nombres únicos.
 */
import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { abonarSaldoAFavorEnTx, esSobreDeSaldoAFavor, prepararSobreDeSaldoAFavorEnTx } from '@/services/giftCards/giftCardLedger'
import { esperarAQueAlguienEspereA, pidDe } from '../giftCards/sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

const SUF = `saldo-a-favor-${process.pid}-${Date.now()}`
const PRESUPUESTO = { timeout: 15_000, maxWait: 5_000 }
const D = (v: number) => new Prisma.Decimal(v)
const staffId = cuid()
let orgId: string
let venueId: string
let n = 0

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: SUF, email: `${SUF}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: SUF, slug: SUF } })).id
})

async function clienta(telefono: string) {
  return (await prisma.customer.create({ data: { venueId, firstName: 'Ana', lastName: 'López', phone: telefono } })).id
}

/** Una tarjeta REGALADA ya activada y guardada en la cartera de la clienta: su ACTIVATE no trae refundPaymentId. */
async function tarjetaRegaladaGuardada(customerId: string, telefono: string) {
  n += 1
  const t = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId: orgId,
      codeHash: `${SUF}-h${n}`,
      codeEnc: 'cifrado-de-prueba',
      codeLast4: 'ABCD',
      pageToken: `${SUF}-p${n}`,
      initialAmount: D(1000),
      balance: D(1000),
      status: 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: 'WHATSAPP',
      deliveryStatus: 'SENT',
      recipientPhone: telefono,
      customerId,
    },
  })
  await prisma.giftCardActivity.create({
    data: { giftCardId: t.id, venueId, type: 'ACTIVATE', amount: D(1000), balanceAfter: D(1000), orderId: cuid() },
  })
  return t
}

const abonar = (tx: Prisma.TransactionClient, preparado: Awaited<ReturnType<typeof prepararSobreDeSaldoAFavorEnTx>>, monto: number) =>
  abonarSaldoAFavorEnTx(tx, {
    preparado,
    monto: D(monto),
    staffId,
    origen: { orderId: cuid(), refundPaymentId: cuid() },
    folio: `F-${monto}`,
    tipo: 'CAMBIO',
  })

describe('saldo a favor en la libreta · Postgres real', () => {
  it('🔴 dos abonos a la misma clienta desde dos ventas distintas, con otra tarjeta ya activada en la sucursal, dejan UN sobre con la suma', async () => {
    const telefono = '+525512340001'
    const customerId = await clienta(telefono)
    const regalada = await tarjetaRegaladaGuardada(customerId, telefono)
    let avisarQueTieneCandado!: () => void
    const cajaUnoTieneElCandado = new Promise<void>(resolve => (avisarQueTieneCandado = resolve))

    const cajaUno = prisma.$transaction(async tx => {
      const preparado = await prepararSobreDeSaldoAFavorEnTx(tx, { venueId, customerId })
      avisarQueTieneCandado()
      // La caja dos de verdad espera el candado de la clienta (no la suerte de un setTimeout).
      await esperarAQueAlguienEspereA(await pidDe(tx))
      return { vio: preparado.sobre, abono: await abonar(tx, preparado, 200) }
    }, PRESUPUESTO)
    const cajaDos = cajaUnoTieneElCandado.then(() =>
      prisma.$transaction(async tx => {
        const preparado = await prepararSobreDeSaldoAFavorEnTx(tx, { venueId, customerId })
        return { vio: preparado.sobre, abono: await abonar(tx, preparado, 150) }
      }, PRESUPUESTO),
    )

    const [uno, dos] = await Promise.all([cajaUno, cajaDos])
    // La tarjeta regalada NO es su sobre de saldo: la caja uno no la vio y creó uno; la dos vio el que creó la uno.
    expect(uno.vio).toBeNull()
    expect(dos.vio?.id).toBe(uno.abono.giftCardId)
    expect(dos.abono).toMatchObject({ giftCardId: uno.abono.giftCardId, telefonoNoCoincide: false })
    expect(dos.abono.saldoNuevo.toFixed(2)).toBe('350.00')

    const suyas = await prisma.giftCard.findMany({
      where: { venueId, customerId },
      select: { id: true, balance: true, status: true, deliveryChannel: true, deliveryStatus: true, recipientPhone: true, expiresAt: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    })
    // Dos tarjetas: la regalada intacta y UN sobre de saldo a favor con $350.
    expect(suyas).toHaveLength(2)
    const saldo = suyas.find(t => t.id === uno.abono.giftCardId)!
    expect(saldo).toMatchObject({
      status: 'ACTIVE',
      deliveryChannel: 'WHATSAPP',
      deliveryStatus: 'SENT',
      recipientPhone: telefono,
      expiresAt: null,
    })
    expect(saldo.balance.toFixed(2)).toBe('350.00')
    expect(suyas.find(t => t.id === regalada.id)!.balance.toFixed(2)).toBe('1000.00')

    const libreta = await prisma.giftCardActivity.findMany({
      where: { giftCardId: saldo.id },
      select: { type: true, amount: true, balanceAfter: true, reason: true, note: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 10,
    })
    expect(libreta.map(m => [m.type, m.amount.toFixed(2), m.balanceAfter.toFixed(2), m.reason])).toEqual([
      ['ACTIVATE', '200.00', '200.00', null],
      ['ADJUST_INCREMENT', '150.00', '350.00', 'OTHER'],
    ])
    expect(libreta.map(m => m.note)).toEqual(['Saldo a favor · Cambio F-200', 'Saldo a favor · Cambio F-150'])

    // El predicado único, contra la base.
    await expect(esSobreDeSaldoAFavor(prisma, saldo.id)).resolves.toBe(true)
    await expect(esSobreDeSaldoAFavor(prisma, regalada.id)).resolves.toBe(false)
  })

  it('la misma operationKey (el mismo renglón de devolución) dos veces abona una sola', async () => {
    const customerId = await clienta('+525512340002')
    const origen = { orderId: cuid(), refundPaymentId: cuid() }
    const abonarUnaVez = () =>
      prisma.$transaction(async tx => {
        const preparado = await prepararSobreDeSaldoAFavorEnTx(tx, { venueId, customerId })
        return abonarSaldoAFavorEnTx(tx, { preparado, monto: D(50), staffId, origen, folio: 'R-1', tipo: 'REEMBOLSO' })
      }, PRESUPUESTO)

    const primera = await abonarUnaVez()
    const segunda = await abonarUnaVez()

    expect(segunda.giftCardId).toBe(primera.giftCardId)
    expect(segunda.saldoNuevo.toFixed(2)).toBe('50.00')
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: primera.giftCardId } })).balance.toFixed(2)).toBe('50.00')
    const conLaLlave = await prisma.giftCardActivity.findMany({
      where: { venueId, operationKey: `saldo-a-favor:${origen.refundPaymentId}` },
      take: 10,
    })
    expect(conLaLlave).toHaveLength(1)
  })
})
