/**
 * hz:381780f0:D1 (Codex r4 #2 de D25): un interbloqueo que agota `withDeadlockRetry` sale de la base envuelto — `P2010` en una
 * consulta cruda (el SQLSTATE en `meta.code`) o, en una consulta de modelo, `PrismaClientUnknownRequestError` sin código con el
 * SQLSTATE sólo en el mensaje (forma medida el 28-sep, `serializableRetry.test.ts`). Es tan pasajero como un `P2034`: la cola
 * lo reintenta. Un `P2010` con cualquier otro código (un SQL roto) sigue siendo definitivo.
 */
import { Prisma } from '@prisma/client'
import { esErrorTransitorio } from '@/services/shared/erroresTransitorios'

const crudo = (sqlState: string) =>
  new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${sqlState}\`. Message: \`ERROR: algo\``, {
    code: 'P2010',
    clientVersion: '6.19.3',
    meta: { code: sqlState, message: 'ERROR: algo' },
  })

const deModelo = (sqlState: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    '\nInvalid `prisma.order.update()` invocation:\n\n\nError occurred during query execution:\n' +
      `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlState}", message: "algo", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
    { clientVersion: '6.19.3' },
  )

describe('esErrorTransitorio — el SQLSTATE que Prisma deja adentro', () => {
  it.each(['40P01', '40001', '55P03'])('P2010 con %s adentro (consulta cruda) es transitorio', sqlState => {
    expect(esErrorTransitorio(crudo(sqlState))).toBe(true)
  })

  it.each(['40P01', '55P03'])('error de modelo sin código con %s en el mensaje es transitorio', sqlState => {
    expect(esErrorTransitorio(deModelo(sqlState))).toBe(true)
  })

  it.each(['42601', '23505', '23503', '57014'])(
    'P2010 con %s adentro (SQL roto, único, llave, statement_timeout) NO es transitorio',
    sqlState => {
      expect(esErrorTransitorio(crudo(sqlState))).toBe(false)
    },
  )

  it('un error de modelo sin código con otro SQLSTATE NO es transitorio', () => {
    expect(esErrorTransitorio(deModelo('42P01'))).toBe(false)
  })

  it('un código de dominio manda: no se reinterpreta por lo que traiga adentro', () => {
    expect(esErrorTransitorio({ errorCode: 'TABLE_OWNED_BY_OTHER', code: 'P2010', meta: { code: '40P01' } })).toBe(false)
  })

  // Regresión: lo que ya era transitorio (o no) sigue igual.
  it.each(['P2034', 'P2028', 'P2024', 'VERSION_CONFLICT', 'ECONNRESET'])('%s sigue siendo transitorio', code => {
    expect(esErrorTransitorio({ code })).toBe(true)
  })

  it('un error de negocio, un error sin código y la nada siguen sin ser transitorios', () => {
    expect(esErrorTransitorio({ code: 'BUSINESS_RULE' })).toBe(false)
    expect(esErrorTransitorio(new Error('raro'))).toBe(false)
    expect(esErrorTransitorio(null)).toBe(false)
    expect(esErrorTransitorio(undefined)).toBe(false)
  })
})
