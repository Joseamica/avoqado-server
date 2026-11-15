// tests/unit/services/dashboard/cuentasDeCobroDelAlta.test.ts
// D25 (15-nov): en el alta avanzada, una cuenta de cobro que no existe (id equivocado o borrado) hacía tronar la llave foránea
// dentro de la transacción: 500 con el texto de Prisma. Ahora se revisa antes y sale un 400 en español; la transacción se
// deshace igual, así que no queda un negocio a medias.
import { asegurarCuentasDeCobroDelAlta, TEXTO_CUENTA_DE_COBRO_INEXISTENTE } from '../../../../src/services/dashboard/cuentasDeCobroDelAlta'
import { BadRequestError } from '../../../../src/errors/AppError'

const A = 'cm00000000000000000000000a'
const B = 'cm00000000000000000000000b'
const C = 'cm00000000000000000000000c'

const txCon = (existentes: string[]) => {
  const findMany = jest.fn(async ({ where }: any) => (where.id.in as string[]).filter(id => existentes.includes(id)).map(id => ({ id })))
  return { tx: { merchantAccount: { findMany } }, findMany }
}

describe('asegurarCuentasDeCobroDelAlta (D25)', () => {
  it('🔴 la principal no existe ⇒ 400 en español, sin crear nada', async () => {
    const { tx } = txCon([])
    const p = asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A })
    await expect(p).rejects.toBeInstanceOf(BadRequestError)
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A })).rejects.toThrow(TEXTO_CUENTA_DE_COBRO_INEXISTENTE)
  })

  it('🔴 la principal existe pero la secundaria no ⇒ también 400', async () => {
    const { tx } = txCon([A])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: B })).rejects.toThrow(
      TEXTO_CUENTA_DE_COBRO_INEXISTENTE,
    )
  })

  it('🔴 la terciaria no existe ⇒ 400', async () => {
    const { tx } = txCon([A, B])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: B, tertiaryAccountId: C })).rejects.toThrow(
      TEXTO_CUENTA_DE_COBRO_INEXISTENTE,
    )
  })

  it('control — las tres existen ⇒ pasa, con UNA sola consulta acotada', async () => {
    const { tx, findMany } = txCon([A, B, C])
    await expect(
      asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: B, tertiaryAccountId: C }),
    ).resolves.toBeUndefined()
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: [A, B, C] } }, take: 3 })
  })

  it('control — sólo la principal, existente ⇒ pasa (secundaria y terciaria vacías no se buscan)', async () => {
    const { tx, findMany } = txCon([A])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: '' })).resolves.toBeUndefined()
    expect(findMany.mock.calls[0][0].where.id.in).toEqual([A])
  })

  it('control — la misma cuenta en dos posiciones cuenta una vez (no es «inexistente»)', async () => {
    const { tx, findMany } = txCon([A])
    await expect(asegurarCuentasDeCobroDelAlta(tx, { primaryAccountId: A, secondaryAccountId: A })).resolves.toBeUndefined()
    expect(findMany.mock.calls[0][0].where.id.in).toEqual([A])
  })
})
