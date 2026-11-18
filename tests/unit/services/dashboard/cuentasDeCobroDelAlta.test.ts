// tests/unit/services/dashboard/cuentasDeCobroDelAlta.test.ts
// D25 (15-nov): en el alta avanzada, una cuenta de cobro que no existe (id equivocado o borrado) hacía tronar la llave foránea
// dentro de la transacción: 500 con el texto de Prisma. Ahora se revisa antes y sale un 400 en español; la transacción se
// deshace igual, así que no queda un negocio a medias.
import {
  asegurarCuentasDeCobroDelAlta,
  TEXTO_CUENTA_DE_COBRO_AJENA,
  TEXTO_CUENTA_DE_COBRO_INEXISTENTE,
} from '../../../../src/services/dashboard/cuentasDeCobroDelAlta'
import { BadRequestError, ForbiddenError } from '../../../../src/errors/AppError'

const A = 'cm00000000000000000000000a'
const B = 'cm00000000000000000000000b'
const C = 'cm00000000000000000000000c'

const ORG = 'cm0000000000000000000org01'
/** Superadmin: sólo se revisa que existan (lo de D25). */
const SA = { organizationId: ORG, esSuperadmin: true }
/** Dueño o administrador de un negocio de ORG. */
const DE_ORG = { organizationId: ORG, esSuperadmin: false }

/** `existentes`: cuentas que hay en la plataforma. `deLaOrg`: las que ya están en una posición de un negocio (o de la configuración)
 *  de ORG. La consulta de pertenencia es la que trae `OR`. */
const txCon = (existentes: string[], deLaOrg: string[] = []) => {
  const findMany = jest.fn(async ({ where }: any) =>
    (where.id.in as string[]).filter(id => existentes.includes(id) && (!where.OR || deLaOrg.includes(id))).map(id => ({ id })),
  )
  return { tx: { merchantAccount: { findMany } }, findMany }
}

describe('asegurarCuentasDeCobroDelAlta (D25)', () => {
  it('🔴 la principal no existe ⇒ 400 en español, sin crear nada', async () => {
    const { tx } = txCon([])
    const p = asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A }, SA)
    await expect(p).rejects.toBeInstanceOf(BadRequestError)
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A }, SA)).rejects.toThrow(TEXTO_CUENTA_DE_COBRO_INEXISTENTE)
  })

  it('🔴 la principal existe pero la secundaria no ⇒ también 400', async () => {
    const { tx } = txCon([A])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: B }, SA)).rejects.toThrow(
      TEXTO_CUENTA_DE_COBRO_INEXISTENTE,
    )
  })

  it('🔴 la terciaria no existe ⇒ 400', async () => {
    const { tx } = txCon([A, B])
    await expect(
      asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: B, tertiaryAccountId: C }, SA),
    ).rejects.toThrow(TEXTO_CUENTA_DE_COBRO_INEXISTENTE)
  })

  it('control — las tres existen ⇒ pasa, con UNA sola consulta acotada', async () => {
    const { tx, findMany } = txCon([A, B, C])
    await expect(
      asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: B, tertiaryAccountId: C }, SA),
    ).resolves.toBeUndefined()
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: [A, B, C] } }, take: 3 })
  })

  it('control — sólo la principal, existente ⇒ pasa (secundaria y terciaria vacías no se buscan)', async () => {
    const { tx, findMany } = txCon([A])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: '' }, SA)).resolves.toBeUndefined()
    expect(findMany.mock.calls[0][0].where.id.in).toEqual([A])
  })

  it('control — la misma cuenta en dos posiciones cuenta una vez (no es «inexistente»)', async () => {
    const { tx, findMany } = txCon([A])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: A }, SA)).resolves.toBeUndefined()
    expect(findMany.mock.calls[0][0].where.id.in).toEqual([A])
  })
})

// hz:nube0000:na5adb84 (1b): `MerchantAccount` no tiene dueño. El alta ligaba la cuenta que le mandaran: un dueño con
// `venues:manage` podía poner la cuenta de cobro de OTRO negocio en el suyo (sus cobros caerían en la cuenta ajena). Default
// pendiente de confirmar con el founder: sólo cuentas que ya están en una posición de un negocio (o de la configuración) de su
// MISMA organización; el superadmin, cualquiera.
describe('asegurarCuentasDeCobroDelAlta · cuentas de otra organización (1b)', () => {
  it('🔴 la principal existe pero no es de su organización ⇒ 403 en español, con código', async () => {
    const { tx } = txCon([A], [])
    const p = asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A }, DE_ORG)
    await expect(p).rejects.toBeInstanceOf(ForbiddenError)
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A }, DE_ORG)).rejects.toMatchObject({
      statusCode: 403,
      message: TEXTO_CUENTA_DE_COBRO_AJENA,
      code: 'CUENTA_DE_COBRO_AJENA',
    })
  })

  it('🔴 principal de su organización pero secundaria ajena ⇒ 403', async () => {
    const { tx } = txCon([A, B], [A])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: B }, DE_ORG)).rejects.toThrow(
      TEXTO_CUENTA_DE_COBRO_AJENA,
    )
  })

  it('🔴 terciaria ajena ⇒ 403', async () => {
    const { tx } = txCon([A, B, C], [A, B])
    await expect(
      asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: B, tertiaryAccountId: C }, DE_ORG),
    ).rejects.toThrow(TEXTO_CUENTA_DE_COBRO_AJENA)
  })

  it('la pertenencia se pregunta por ESA organización: posiciones de sus negocios o de su configuración, acotada a los ids', async () => {
    const { tx, findMany } = txCon([A, B], [A, B])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: B }, DE_ORG)).resolves.toBeUndefined()
    const pertenencia = findMany.mock.calls.find(([args]: any) => args.where.OR)![0]
    expect(pertenencia.where.id.in).toEqual([A, B])
    expect(pertenencia.take).toBe(2)
    expect(pertenencia.where.OR).toEqual(
      expect.arrayContaining([
        { venueConfigsPrimary: { some: { venue: { organizationId: ORG } } } },
        { venueConfigsSecondary: { some: { venue: { organizationId: ORG } } } },
        { venueConfigsTertiary: { some: { venue: { organizationId: ORG } } } },
        { orgConfigsPrimary: { some: { organizationId: ORG } } },
        { orgConfigsSecondary: { some: { organizationId: ORG } } },
        { orgConfigsTertiary: { some: { organizationId: ORG } } },
      ]),
    )
  })

  it('una cuenta que no existe sigue siendo 400 (no se disfraza de 403)', async () => {
    const { tx } = txCon([], [])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A }, DE_ORG)).rejects.toBeInstanceOf(BadRequestError)
  })

  it('control — superadmin puede usar una cuenta de cualquier organización (no se pregunta la pertenencia)', async () => {
    const { tx, findMany } = txCon([A], [])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A }, SA)).resolves.toBeUndefined()
    expect(findMany.mock.calls.some(([args]: any) => args.where.OR)).toBe(false)
  })

  it('control — sin cuentas no se consulta nada', async () => {
    const { tx, findMany } = txCon([], [])
    await expect(asegurarCuentasDeCobroDelAlta(tx, {}, DE_ORG)).resolves.toBeUndefined()
    expect(findMany).not.toHaveBeenCalled()
  })
})
