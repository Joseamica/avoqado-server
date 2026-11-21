/**
 * Apagador del SDK propio (fase 3, bloque 2a): `Terminal.inHouseSdkEnabled` dice si una PAX cobra con nuestro motor.
 * `cambiarSdkPropioDeTerminal` es la ÚNICA función que lo escribe (la ruta REST del SUPERADMIN y la herramienta MCP la
 * llaman). Ningún camino de dinero lee la columna todavía. El disparador de Postgres la apaga solo si cambia la identidad
 * física (serie, tipo o marca) o la terminal se muda de negocio (`venueId`); por eso este escritor nunca toca la identidad ni
 * el negocio en el mismo UPDATE.
 *
 * Orden de candados del escritor: primero la fila del ACTOR (`Staff … FOR KEY SHARE`), después la terminal
 * (`Terminal … FOR NO KEY UPDATE`). La bitácora necesita la fila del actor (llave foránea), y la limpieza de una demo y el
 * borrado de personal toman `Staff` y luego `Terminal`: con el orden contrario, las dos transacciones podrían abrazarse.
 */
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { isProviderCompatibleWithBrand } from '@/lib/providerDeviceCompatibility'
import { getEffectivePaymentConfig } from '@/services/organization-payment-config.service'

/** D3: sobre la serie GUARDADA (ya normalizada). `AVQD-UNKNOWN` y el respaldo de Android `AVQD-0000ABCD…` no pasan. */
export const SERIE_FISICA_DE_PAX = /^AVQD-\d{10}$/

export type ElegibilidadDelSdkPropio = { elegible: true } | { elegible: false; razon: string }

/**
 * Las afiliaciones que `GET /tpv/terminals/:serial/config` le entrega a la terminal, con la MISMA regla de
 * `getTerminalConfig` (terminal.tpv.controller.ts): las asignadas activas o, sin asignadas, las heredadas del negocio o la
 * organización, filtradas con `isProviderCompatibleWithBrand(provider.code || 'BLUMON', brand)`. Sin reordenar: aquí sólo
 * importa el conjunto. Si /config cambia su regla, la prueba de paridad lo detecta.
 */
export async function afiliacionesQueEntregaConfig(
  tx: Prisma.TransactionClient,
  terminal: { venueId: string; brand: string | null; assignedMerchantIds: string[] },
): Promise<{ id: string; provider: { code: string } }[]> {
  let ids = terminal.assignedMerchantIds
  if (ids.length === 0) {
    const efectiva = await getEffectivePaymentConfig(terminal.venueId, tx)
    ids = efectiva
      ? ([efectiva.config.primaryAccount?.id, efectiva.config.secondaryAccount?.id, efectiva.config.tertiaryAccount?.id].filter(
          Boolean,
        ) as string[])
      : []
  }
  if (ids.length === 0) return []
  const cuentas = await tx.merchantAccount.findMany({
    where: { id: { in: ids }, active: true },
    take: ids.length, // cada id es único: caben todas las coincidencias
    select: { id: true, provider: { select: { code: true } } },
  })
  return cuentas.filter(ma => isProviderCompatibleWithBrand(ma.provider?.code || 'BLUMON', terminal.brand))
}

/** Sólo se pregunta al prender; apagar siempre se puede. Acepta `prisma` o una transacción. */
export async function elegibilidadDelSdkPropio(tx: Prisma.TransactionClient, terminalId: string): Promise<ElegibilidadDelSdkPropio> {
  const terminal = await tx.terminal.findUnique({
    where: { id: terminalId },
    select: { venueId: true, type: true, brand: true, serialNumber: true, assignedMerchantIds: true },
  })
  if (!terminal) throw new NotFoundError('Terminal no encontrada')
  if (terminal.type !== 'TPV_ANDROID') return { elegible: false, razon: 'No es una terminal Android' }
  // EXACTO, como lo compara /config (Codex r1 #4): «pax» en minúsculas no pasa.
  if (terminal.brand !== 'PAX') return { elegible: false, razon: `No es una PAX (marca guardada: ${terminal.brand ?? 'ninguna'})` }
  if (!terminal.serialNumber || !SERIE_FISICA_DE_PAX.test(terminal.serialNumber)) {
    return { elegible: false, razon: 'La serie no tiene el formato de una PAX' }
  }
  const afiliaciones = await afiliacionesQueEntregaConfig(tx, terminal)
  if (!afiliaciones.some(ma => ma.provider.code === 'BLUMON')) {
    return { elegible: false, razon: 'No tiene una afiliación de Blumon activa que le llegue a la terminal' }
  }
  return { elegible: true }
}

/**
 * La huella del ESTADO de una terminal que una vista previa enseñó (ronda 2 · R2-2): exactamente lo que vigila el disparador
 * (`venueId`, `serialNumber`, `type`, `brand`) más el propio ajuste (`inHouseSdkEnabled`). La confirmación del MCP se ata a esto y
 * no a un campo suelto: si cualquiera cambió entre la vista previa y el «confirmar», no se prende. Con el ajuste dentro, una vista
 * sacada con la terminal YA prendida nunca puede prender nada (para prender tiene que estar apagada, y esa huella dice «prendida»).
 */
export function huellaDeLaTerminal(t: {
  venueId: string
  serialNumber: string | null
  type: string
  brand: string | null
  inHouseSdkEnabled: boolean
}): string {
  const estado = JSON.stringify([t.venueId, t.serialNumber, t.type, t.brand, t.inHouseSdkEnabled])
  return createHash('sha256').update(estado).digest('hex').slice(0, 16)
}

export async function cambiarSdkPropioDeTerminal(entrada: {
  terminalId: string
  enabled: boolean
  /** Obligatoria al PRENDER: la serie que vio quien prende (la vista previa o la ficha), ya recortada de espacios. Se compara
   *  LITERAL con la serie guardada, bajo el candado. Al apagar no hace falta. */
  serieEsperada?: string
  /** Opcional (sólo el MCP lo manda): `huellaDeLaTerminal` de lo que enseñó la vista previa. Al PRENDER, si viene, se compara bajo el
   *  candado con la fila. La ruta REST no lo manda: su pantalla envía en el mismo clic lo que acaba de leer. */
  estadoEsperado?: string
  staffId: string
  reason?: string | null
  procedencia: 'superadmin-rest' | 'mcp'
  extra?: Record<string, string>
}): Promise<{ changed: boolean; enabled: boolean }> {
  const { terminalId, enabled } = entrada

  // Apagar una ya apagada no toma candado (Codex r2 #2): una lectura ordinaria no espera al latido ni a nadie.
  if (!enabled) {
    const actual = await prisma.terminal.findUnique({ where: { id: terminalId }, select: { inHouseSdkEnabled: true } })
    if (!actual) throw new NotFoundError('Terminal no encontrada')
    if (!actual.inHouseSdkEnabled) return { changed: false, enabled: false }
  }

  return prisma.$transaction(async tx => {
    // Primero el ACTOR (Codex b2a r1 #4): la bitácora necesita su fila (llave foránea `staffId`), y la limpieza de una demo y
    // el borrado de personal toman `Staff` y después `Terminal`. Tomarlo aquí, antes de la terminal, deja un solo orden
    // (Staff, luego Terminal) y nunca un abrazo. `FOR KEY SHARE` es lo mismo que tomaría la llave foránea: no choca con quien
    // sólo edita la ficha de la persona (`FOR NO KEY UPDATE`), pero SÍ espera a un `FOR UPDATE` de `Staff` (la baja de personal,
    // la liga de soporte) hasta que termine. Sólo espera: como el orden es el mismo, no hay abrazo.
    const [actor] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Staff" WHERE id = ${entrada.staffId} FOR KEY SHARE`
    if (!actor) throw new NotFoundError('Usuario no encontrado')

    // FOR NO KEY UPDATE (Codex r1 #2): ordena a dos escritores y choca con los UPDATE de la ficha, pero NO con el
    // FOR KEY SHARE que toma Postgres al revisar la llave foránea `terminalId` del alta de una orden o un pago.
    const [fila] = await tx.$queryRaw<
      { id: string; venueId: string; serialNumber: string | null; type: string; brand: string | null; inHouseSdkEnabled: boolean }[]
    >`SELECT id, "venueId", "serialNumber", type::text AS type, brand, "inHouseSdkEnabled" FROM "Terminal" WHERE id = ${terminalId} FOR NO KEY UPDATE`
    if (!fila) throw new NotFoundError('Terminal no encontrada')
    if (fila.inHouseSdkEnabled === enabled) return { changed: false, enabled }

    if (enabled) {
      // Literal y antes de la elegibilidad (Codex r1 #1, r2 #1): una serie guardada nula siempre cae aquí.
      if (fila.serialNumber == null) {
        throw new ConflictError('La terminal no tiene serie guardada; corrígela en la ficha.', 'TERMINAL_SERIAL_MISMATCH')
      }
      if (entrada.serieEsperada == null || entrada.serieEsperada !== fila.serialNumber) {
        throw new ConflictError('La serie de la terminal cambió desde que la viste. Vuelve a consultarla.', 'TERMINAL_SERIAL_MISMATCH')
      }
      // La huella sale de la MISMA fila leída bajo el candado (R2-2): negocio, aparato o ajuste distintos ⇒ no se prende.
      if (entrada.estadoEsperado !== undefined && entrada.estadoEsperado !== huellaDeLaTerminal(fila)) {
        throw new ConflictError(
          'La terminal cambió desde la vista previa (aparato, negocio o ajuste). Pide una vista previa nueva.',
          'TERMINAL_STATE_MISMATCH',
        )
      }
      const elegibilidad = await elegibilidadDelSdkPropio(tx, terminalId)
      if (!elegibilidad.elegible) throw new ConflictError(elegibilidad.razon, 'TERMINAL_NOT_ELIGIBLE_FOR_IN_HOUSE_SDK')
    }

    // Sólo el apagador: si este UPDATE tocara la identidad, el disparador lo apagaría en la misma sentencia.
    await tx.terminal.update({ where: { id: terminalId }, data: { inHouseSdkEnabled: enabled } })
    await tx.activityLog.create({
      data: {
        action: enabled ? 'TERMINAL_IN_HOUSE_SDK_ENABLED' : 'TERMINAL_IN_HOUSE_SDK_DISABLED',
        entity: 'Terminal',
        entityId: terminalId,
        staffId: entrada.staffId,
        venueId: fila.venueId,
        // `extra` primero: no puede pisar la razón, la procedencia ni la serie.
        data: { ...entrada.extra, reason: entrada.reason ?? null, procedencia: entrada.procedencia, serialNumber: fila.serialNumber },
      },
    })
    return { changed: true, enabled }
  })
}
