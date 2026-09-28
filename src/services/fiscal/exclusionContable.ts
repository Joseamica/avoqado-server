/**
 * IVA por producto, plan 4: en una organización con IVA mixto la contabilidad se PAUSA y lo dice.
 *
 * `Organization.ivaMixtoAlgunaVez` (pegajosa, plan 1) dice que alguna vez hubo un producto o un renglón facturado con
 * IVA ≠ 16 %. Con ella nadie crea pólizas ni cierra periodos: la contabilidad calcula el IVA con el producto vivo y una
 * venta sin factura cambia de tasa cuando cambia su producto.
 *
 * El candado son FILAS en el orden del catálogo —organización y después negocio—, `FOR SHARE`: choca con todo UPDATE de
 * la fila y, en Serializable, aborta con 40001 si cambió después de la foto. `FOR KEY SHARE` no sirve (un UPDATE de la
 * marca es de columna no llave) y un advisory se tomaría después de la foto.
 */
import { Prisma } from '@prisma/client'
import { ConflictError } from '@/errors/AppError'
import { isDeadlockError, isModelLockTimeoutError, isRetryableDbError } from '@/utils/serializableRetry'
import prisma from '@/utils/prismaClient'

export const CONTABILIDAD_IVA_MIXTO = 'CONTABILIDAD_IVA_MIXTO'
export const CONTABILIDAD_OCUPADA = 'CONTABILIDAD_OCUPADA'
export const IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION = 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION'
export const MOTIVO_CONTABILIDAD_IVA_MIXTO =
  'La contabilidad de Avoqado todavía no maneja ventas con IVA distinto de 16 %. Como esta organización ya tuvo productos con otra tasa, las pólizas y el cierre de periodo están pausados. Escríbenos a hola@avoqado.io si lo necesitas.'

export const contabilidadPausadaError = (): ConflictError => new ConflictError(MOTIVO_CONTABILIDAD_IVA_MIXTO, CONTABILIDAD_IVA_MIXTO)
const negocioCambioDeOrganizacionError = (): ConflictError =>
  new ConflictError('Este negocio acaba de cambiar de organización. Vuelve a intentarlo.', IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION)
export const contabilidadOcupadaError = (): ConflictError =>
  new ConflictError('La contabilidad está ocupada en este momento. Vuelve a intentarlo en unos segundos.', CONTABILIDAD_OCUPADA)

export function esExclusionContable(e: unknown): boolean {
  return e instanceof ConflictError && e.code === CONTABILIDAD_IVA_MIXTO
}

/** Lectura SIN candado, sólo para avisar antes de trabajar. La verdad la decide `exigirContabilidadDisponible`. */
export async function contabilidadPausada(organizationId: string): Promise<boolean> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { ivaMixtoAlgunaVez: true } })
  return org?.ivaMixtoAlgunaVez === true
}

/** DENTRO de la transacción que crea la póliza o cierra el periodo. Orden global: organización → negocio. */
export async function exigirContabilidadDisponible(
  tx: Prisma.TransactionClient,
  p: { venueId: string; organizationId: string },
): Promise<void> {
  const [org] = await tx.$queryRaw<Array<{ ivaMixtoAlgunaVez: boolean }>>`
    SELECT "ivaMixtoAlgunaVez" FROM "Organization" WHERE id = ${p.organizationId} FOR SHARE`
  const [venue] = await tx.$queryRaw<Array<{ organizationId: string }>>`
    SELECT "organizationId" FROM "Venue" WHERE id = ${p.venueId} FOR SHARE`
  if (!venue || venue.organizationId !== p.organizationId) throw negocioCambioDeOrganizacionError()
  if (org?.ivaMixtoAlgunaVez) throw contabilidadPausadaError()
}

/**
 * Antes de escribir IVA en un producto, en la MISMA transacción y ANTES del cerco de gobierno del catálogo
 * (`assertLegacyCatalogGovernanceForVenue` en altas, `assertLegacyCatalogProductUpdateGovernance` en ediciones): la
 * organización va primero (el orden del catálogo); el cerco bloquea después el negocio y el producto.
 */
export async function bloquearParaCambiarIva(tx: Prisma.TransactionClient, p: { venueId: string }): Promise<void> {
  const [antes] = await tx.$queryRaw<Array<{ organizationId: string }>>`SELECT "organizationId" FROM "Venue" WHERE id = ${p.venueId}`
  if (!antes) return
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${antes.organizationId} FOR NO KEY UPDATE`
  const [venue] = await tx.$queryRaw<Array<{ organizationId: string }>>`
    SELECT "organizationId" FROM "Venue" WHERE id = ${p.venueId} FOR SHARE`
  if (venue?.organizationId !== antes.organizationId) throw negocioCambioDeOrganizacionError()
}

const INTENTOS = 5

/** Transacción Serializable de la contabilidad: 15 s, candados de 5 s, reintento y un 409 claro al agotarse. */
export async function conReintentoContable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let intento = 1; ; intento++) {
    try {
      return await prisma.$transaction(
        async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`
          return fn(tx)
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000, maxWait: 5_000 },
      )
    } catch (e) {
      const choque = isRetryableDbError(e) || isDeadlockError(e) || isModelLockTimeoutError(e)
      if (choque && intento < INTENTOS) {
        await new Promise(resolve => setTimeout(resolve, 50 * 2 ** (intento - 1)))
        continue
      }
      if (choque || (e as { code?: string })?.code === 'P2028') throw contabilidadOcupadaError()
      throw e
    }
  }
}
