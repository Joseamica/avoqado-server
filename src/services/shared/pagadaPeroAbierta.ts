import { Prisma, type PrismaClient } from '@prisma/client'
import { DEFAULT_TIMEZONE } from '../../utils/datetime'
import { BUSINESS_DAY_START_HOUR } from './cashDrawerAutoClose'
import { utcTs } from '../../utils/sqlDates'

/**
 * Qué cobro CUENTA para cubrir la cuenta. Vive una sola vez porque lo usan lugares que NO
 * pueden divergir: la comparación del criterio, la columna `pagado` que reporta el barrido y
 * la que reporta el vigilante de dinero (check «PAGADA PERO ABIERTA», por eso se exporta). Si
 * uno sumara distinto del otro, el número que explica por qué se eligió una orden no sería
 * el que la eligió.
 *
 * 🔴 Los REFUND no restan. Misma regla que `summarizeRefunds` en `orderBalance.ts` (decisión
 * del founder 2026-08-18: «un reembolso NO reabre saldo») porque es exactamente lo que usa el
 * camino que cierra, `updateOrderTotalsForStandalonePayment`. Si esta suma restara los
 * reembolsos, una orden pagada y luego devuelta por completo sería `isFullyPaid` para quien
 * cierra y NO candidata para nosotros: el barrido nunca la alcanzaría.
 */
export const COBRO_QUE_CUBRE = `p.status = 'COMPLETED' AND p.type IS DISTINCT FROM 'REFUND'`

/**
 * Lo que la cuenta DEBE: `max(0, subtotal − descuento) + cargo por servicio + max(0, IVA)`.
 *
 * Vive una sola vez por el mismo motivo que `COBRO_QUE_CUBRE` —es el OTRO lado de la misma
 * comparación— y lo usan tres sitios que no pueden divergir: el criterio, la columna `base`
 * del barrido y el detalle del vigilante de dinero. Cuando se re-derivaba a mano, el
 * vigilante explicaba una alerta con una cifra distinta de la que la disparó.
 *
 * 🔴 El cargo por servicio entra y la propina NO. El schema define
 * `Order.serviceChargeAmount` como «INGRESO GRAVABLE del negocio: SUMA al total y entra al
 * corte y al CFDI», mientras la propina pasa al mesero; y `computeOrderBalance`
 * (`shared/orderBalance.ts`) —la aritmética canónica del saldo— pone la propina a los DOS
 * lados (entra al total y entra a lo pagado), de modo que se cancela y la comparación se
 * reduce exactamente a ésta. El cargo va DESPUÉS del clamp: un descuento excedente se come
 * la mercancía, nunca los cargos.
 *
 * 🔴 El IVA entra SÓLO cuando va separado, y `Order.taxAmount` es el que lo dice — el mismo
 * discriminador que lee el CFDI (memoria `iva-el-precio-de-catalogo-es-final`): `0` ⇒ «el
 * precio ya trae el IVA» (convención mexicana, los 8 caminos de venta nativos; no suma nada);
 * `> 0` ⇒ «el IVA va separado y SUMA al total» (así nacen las órdenes de SoftRestaurant —
 * Testarudo—, y `total = subtotal − descuento + cargo + IVA`). El arreglo del 5-sep-2026 quitó
 * el IVA de aquí por la primera convención y se llevó la segunda por delante: el 7-sep el
 * vigilante pasó de 41 a 31,283 alarmas, 31,241 de Testarudo con el «exceso» igual al IVA al
 * centavo — clientes que pagaron exactamente lo que decía la cuenta. Y por esta misma base el
 * barrido habría elegido como «pagada» una cuenta de Testarudo con sólo el subtotal cobrado.
 * Va CLAMPADO: un `taxAmount` negativo (`estimateAverageTaxRate` lo deja así sobre una orden
 * con IVA incluido) nunca baja lo que la cuenta debe — ésa era la cortesía total que salía
 * como SOBREPAGO de $300 con $0 cobrados.
 */
export function baseQueDebeCubrirseSql(alias = 'o'): string {
  return `GREATEST(0, ${alias}.subtotal - COALESCE(${alias}."discountAmount", 0)) + COALESCE(${alias}."serviceChargeAmount", 0) + GREATEST(0, COALESCE(${alias}."taxAmount", 0))`
}

/**
 * Criterio ÚNICO de «orden cobrada que sigue abierta». Lo consumen el barrido
 * (`paid-order-reconciler.job.ts`) y el vigilante de dinero (check #6): si alguna vez
 * divergen, uno de los dos miente. Caso semilla: ORD-1788276418170 (Testarudo, 1-sep-2026).
 *
 * Reglas:
 *  - la orden no está en estado terminal;
 *  - la suma de sus cobros que cuentan (ver `COBRO_QUE_CUBRE`) cubre lo que la cuenta DEBE,
 *    `max(0, subtotal − descuento) + cargo por servicio + max(0, IVA)` (`baseQueDebeCubrirseSql`;
 *    el IVA sólo pesa cuando `taxAmount > 0`, o sea cuando va separado), con un centavo de
 *    tolerancia;
 *  - 🔴 el CARGO POR SERVICIO entra y la PROPINA no, y no es una asimetría arbitraria: el
 *    schema define `Order.serviceChargeAmount` como «INGRESO GRAVABLE del negocio: SUMA al
 *    total y entra al corte y al CFDI», mientras la propina pasa al mesero. Es exactamente
 *    lo que hace `computeOrderBalance` (`shared/orderBalance.ts`), la aritmética canónica
 *    del saldo: `total = mercancía + cargo + propinas` contra `pagado = Σ(amount + tip)`, de
 *    modo que la propina se cancela a los dos lados y la comparación se reduce a esta misma
 *    —`Σ amount >= mercancía + cargo`—. Omitiendo el cargo, una cuenta de $100 + $10 con
 *    $100 cobrados salía elegida como pagada: el barrido la cerraba, le reescribía el total
 *    hacia abajo y liberaba la mesa. $10 perdidos, en silencio (auditoría Codex 2-sep-2026);
 *  - la suma es CIEGA AL TIPO salvo REFUND: los TEST y los ADJUSTMENT cuentan, igual que
 *    en el camino de cierre. No se filtra por `type` más allá de excluir la devolución;
 *  - existe al menos un cobro REGULAR o FAST positivo — así una cuenta de $0 sin cobro
 *    (cortesía total) NO se marca pagada: ésa la cierra el cajero cobrando $0. Excepción: plataforma aceptada y PAID con
 *    venta y saldo exactamente cero; la ingesta puede liquidarla con descuento total sin crear Payment;
 *  - asimetría deliberada con `type` NULL: la puerta del EXISTS lo RECHAZA (un NULL no
 *    entra en un `IN (...)`) pero la suma sí lo CUENTA (`IS DISTINCT FROM` conserva los
 *    NULL). Es el lado conservador: un tipo desconocido no basta para declarar cobrada una
 *    orden, pero tampoco se ignora al sumar lo que ya entró.
 *
 * `alias` es texto de confianza (código propio), nunca entrada de usuario: se interpola
 * sin parametrizar y acaba dentro de un `$queryRawUnsafe`.
 */
export function criterioPagadaPeroAbiertaSql(alias = 'o'): string {
  const o = alias
  return `
    ${o}.status NOT IN ('COMPLETED', 'CANCELLED', 'DELETED')
    AND (EXISTS (
      SELECT 1 FROM "Payment" p
      WHERE p."orderId" = ${o}.id AND p.status = 'COMPLETED'
        AND p.type IN ('REGULAR', 'FAST') AND p.amount > 0
    ) OR (${pedidoDePlataformaPagadoYAceptadoSql(o)}
      AND ${o}.total = 0 AND ${o}."remainingBalance" = 0 AND (${baseQueDebeCubrirseSql(o)}) = 0))
    AND (
      SELECT COALESCE(SUM(p.amount), 0) FROM "Payment" p
      WHERE p."orderId" = ${o}.id AND ${COBRO_QUE_CUBRE}
    ) >= ${baseQueDebeCubrirseSql(o)} - 0.01`
}

/**
 * 🔴 ¿El dinero de esta orden lo liquida una PLATAFORMA de reparto (Uber, Rappi, DiDi, Deliverect)? Sólo la ingesta de reparto
 * escribe `originSystem = DELIVERY_PLATFORM` (`deliveryOrderIngestion.service.ts`; la ingesta vieja de Uber hacía lo mismo).
 *
 * Su `Order.total` es el BLOQUE del proveedor —venta + cargos del comercio (el envío del repartidor propio, los cargos de Uber)
 * − descuento, sin la propina (`deliveryReconciliation.service.ts#reprecio`)— y esos cargos no viven en ninguna columna que lea
 * `baseQueDebeCubrirseSql`. El reparador del cobro (`reconcileOrderFromPayments`) reescribe el total con
 * `subtotal − descuento + cargo por servicio + propina`: a un Rappi de 20 + 35 de envío + 20 de propina le dejaba 40 en vez de
 * 55 y denunciaba un sobrepago de $35 que no existe (Codex b1 #1, Rappi fase 2; a Uber le pasaba igual con sus cargos). El
 * dinero de estas órdenes lo cuida el núcleo de reparto: el barrido NUNCA lo recalcula.
 *
 * `originSystem` es NOT NULL (default AVOQADO), así que su negación (`NOT (…)`) no deja fuera órdenes por un NULL.
 */
export function esDeUnaPlataformaSql(alias = 'o'): string {
  return `${alias}."originSystem" = 'DELIVERY_PLATFORM'`
}

/**
 * 🔴 Un pedido de plataforma ACEPTADO: CONFIRMED o más adelante (la ingesta lo deja así cuando ya le dijimos que sí al
 * proveedor: modo AUTO, y Rappi siempre) o PENDING con la aceptación acreditada (`providerAcceptedAt`, modo MANUAL). Un PENDING
 * sin esa marca todavía espera a la cocina: el barrido lo cerraba a los 5-15 min, el tablero dejaba de pedir «aceptar» (sólo lo
 * pide con la venta PENDING) y Uber lo cancelaba solo a los ~11.5 min. El barrido nunca cierra uno así.
 */
export function pedidoDePlataformaAceptadoSql(alias = 'o'): string {
  return `(${alias}.status <> 'PENDING' OR ${alias}."providerAcceptedAt" IS NOT NULL)`
}

/**
 * El AHORA de una corrida como literal del reloj de pared UTC (`TIMESTAMP 'YYYY-MM-DD HH:MM:SS.mmm'`), comparable contra
 * cualquier columna DateTime (guardan UTC sin zona). Va INLINE, igual que el corte del vigilante (`corteDeAlerta`): así la MISMA
 * condición de CUÁNDO cabe en el `$queryRaw` del barrido y en el texto del vigilante, y ninguno depende de la zona de la sesión
 * (un bind de `Date` llega como `timestamptz` y se corre seis horas en la Mac; ver `utils/sqlDates.ts`). Sale de un `Date`: no
 * hay texto externo que escapar.
 */
export function instanteUtcSql(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new Error('instanteUtcSql: fecha inválida')
  return `TIMESTAMP '${d.toISOString().replace('T', ' ').replace('Z', '')}'`
}

/**
 * 🔴 Decisión B, primera señal: «la cocina lo terminó». El pedido tiene comanda y NINGUNA sigue en la cocina (NEW o PREPARING).
 *
 * Es el MISMO «comanda abierta» que ya usa el sistema, en los tres sitios que leen el fin de la cocina:
 *  - el tablero de cocina (`services/mobile/kdsCapacidades.ts`, `COMANDA_ABIERTA = {NEW, PREPARING}`), que con READY/COMPLETED
 *    deja de ofrecer acciones sobre el pedido;
 *  - el «listo» al proveedor, que sale con READY o COMPLETED (`kds.mobile.service.ts#updateKdsOrderStatus`, el bump y el lote);
 *  - su reintento (`delivery-line-action-reconciler.job.ts`, `k.status IN ('READY', 'COMPLETED')`).
 * Es una fila del servidor que escriben TODOS los aparatos: el KDS de Android e iOS (estado y bump), el «listo sin red» de la
 * cola (`KDS_TICKET_MARK`) y la preparación por producto (`kitchenPreparation.service.ts`, que deriva el estado de la comanda).
 * Varias comandas (una por estación): terminadas TODAS. Sin ninguna comanda (negocio sin cocina, o un programado que aún no
 * llega a la cocina) no hay señal: sólo lo cierra el fin del día.
 *
 * Usa el índice `KdsOrder(orderId)`; el `venueId` amarra la comanda al negocio de la venta.
 */
export function laCocinaLoTerminoSql(alias = 'o'): string {
  const o = alias
  return `(EXISTS (SELECT 1 FROM "KdsOrder" k WHERE k."orderId" = ${o}.id AND k."venueId" = ${o}."venueId")
      AND NOT EXISTS (
        SELECT 1 FROM "KdsOrder" k WHERE k."orderId" = ${o}.id AND k."venueId" = ${o}."venueId" AND k.status IN ('NEW', 'PREPARING')
      ))`
}

/**
 * 🔴 Decisión B, segunda señal: «se acabó su día del negocio». El día del negocio de la venta y el de `ahora`, los DOS en la zona
 * del negocio (`Venue.timezone`), nunca en la del servidor ni en UTC a secas.
 *
 * 🔴 El «día del negocio» es el de la CAJA (decisión del controlador, Ronda de arreglo 1 de la Tarea 22): empieza a las
 * `BUSINESS_DAY_START_HOUR` (04:00) de la zona del venue, el MISMO corte de `businessDayStart` (`cashDrawerAutoClose.ts`) con el
 * que el sistema ya cierra cosas solas (la caja olvidada). NO es la medianoche de los reportes: un bar que cierra a las 2 am no
 * pierde «Cancelar» a las 00:00 con el pedido todavía en la cocina, y Toast también corta su día de madrugada. En SQL: el día de
 * un instante es la FECHA de su hora local menos el corte (las 03:59 todavía son de la víspera). Así:
 *  - uno aceptado a las 23:50 sigue abierto a las 00:30 y a las 03:59, y se cierra a las 04:00;
 *  - uno aceptado a las 02:00 es del día de la víspera: se cierra a las 04:00 de ESE mismo día, no del siguiente.
 *
 * El día de la venta es el ÚLTIMO de: cuándo llegó, cuándo se aceptó (MANUAL) y para cuándo se programó (`scheduledFor`): un
 * programado para mañana no se cierra al acabar hoy.
 *
 * La zona sale del negocio de ESA venta (correlacionada por llave primaria). Una zona que Postgres no reconoce caería en error
 * y tumbaría la pasada entera (barrido y vigilante, de todos los negocios): cae en la de default (`DEFAULT_TIMEZONE`). El
 * `IN (SELECT name FROM pg_timezone_names)` se resuelve UNA vez por consulta (subplan con hash; medido: ~25 ms, ~240 ms en frío).
 *
 * `ahora` es una expresión SQL del reloj de pared UTC (`instanteUtcSql`).
 */
export function seAcaboSuDiaDelNegocioSql(alias: string, ahora: string): string {
  const o = alias
  if (!Number.isInteger(BUSINESS_DAY_START_HOUR) || BUSINESS_DAY_START_HOUR < 0 || BUSINESS_DAY_START_HOUR > 23) {
    throw new Error(`seAcaboSuDiaDelNegocioSql: hora de corte inválida (${BUSINESS_DAY_START_HOUR})`)
  }
  // El día del negocio de una hora local: su fecha, una vez descontado el corte de la caja.
  const diaDelNegocio = (instanteUtc: string) =>
    `(((${instanteUtc} AT TIME ZONE 'UTC') AT TIME ZONE z.tz) - INTERVAL '${BUSINESS_DAY_START_HOUR} hours')::date`
  return `EXISTS (
        SELECT 1 FROM "Venue" vz
        CROSS JOIN LATERAL (
          SELECT CASE WHEN vz.timezone IN (SELECT name FROM pg_timezone_names) THEN vz.timezone ELSE '${DEFAULT_TIMEZONE}' END AS tz
        ) z
        WHERE vz.id = ${o}."venueId"
          AND ${diaDelNegocio(`GREATEST(${o}."createdAt", ${o}."providerAcceptedAt", ${o}."scheduledFor")`)} < ${diaDelNegocio(ahora)}
      )`
}

/**
 * 🔴 CUÁNDO se da por cerrado un pedido de plataforma aceptado y pagado. Decisión «B» del founder (22-oct-2026; Codex b1 #5,
 * opciones en `.superpowers/sdd/2026-10-20-rappi-fase-2/codex-b1-fix-B-report.md`): **cuando la cocina lo termina, o al acabar
 * el día del negocio, lo que pase primero**. Es lo que hacen Square y Toast (help 6649; «Close Out Day»).
 *
 * Mientras no pase ninguna de las dos, el pedido sigue abierto: la cocina conserva «Cancelar» (y, con Rappi, las instrucciones de
 * F2), y el vigilante no lo cuenta como «pagada pero abierta» (`pedidoDePlataformaQueBDejaAbiertoSql`).
 *
 * La decisión se escribe AQUÍ y en ningún otro sitio: la leen el barrido (`findPedidosDePlataformaPorCerrar`) y, negada, la
 * invariante 6 del vigilante. Nunca NULL (`COALESCE`): su negación no puede dejar una fila fuera por un NULL.
 */
export function momentoDeCerrarUnPedidoDePlataformaSql(alias: string, ahora: string): string {
  return `COALESCE((${laCocinaLoTerminoSql(alias)} OR ${seAcaboSuDiaDelNegocioSql(alias, ahora)}), FALSE)`
}

/** Pedido de plataforma que el núcleo de reparto dio por PAGADO y que ya está aceptado: el universo de la decisión B. */
function pedidoDePlataformaPagadoYAceptadoSql(alias: string): string {
  return `${esDeUnaPlataformaSql(alias)}
      AND ${alias}."paymentStatus" = 'PAID'
      AND ${pedidoDePlataformaAceptadoSql(alias)}`
}

/**
 * Lo que la decisión B deja ABIERTO a propósito: pedido de plataforma pagado y aceptado al que todavía no le toca cerrarse (la
 * cocina lo prepara y su día no ha terminado). Es el complemento EXACTO, dentro del mismo universo, de lo que el barrido cierra:
 * la invariante 6 del vigilante lo resta y sigue gritando por lo que ya tocaba cerrar y sigue abierto.
 */
export function pedidoDePlataformaQueBDejaAbiertoSql(alias: string, ahora: string): string {
  return `(${pedidoDePlataformaPagadoYAceptadoSql(alias)}
      AND NOT ${momentoDeCerrarUnPedidoDePlataformaSql(alias, ahora)})`
}

export interface CandidataPagadaAbierta {
  id: string
  venueId: string
  orderNumber: string
  status: string
  paymentStatus: string
  base: string
  pagado: string
  paymentIds: string[]
}

type Db = Pick<PrismaClient, '$queryRaw'> | Pick<Prisma.TransactionClient, '$queryRaw'>

/**
 * Candidatas, del más viejo al más nuevo, sin tocar órdenes actualizadas hace menos de `graceMs`.
 *
 * `base` y `pagado` reproducen los DOS lados de la comparación del criterio —el cargo por
 * servicio incluido— para que los números que explican por qué se eligió una orden sean los
 * que la eligieron; `pagado` aplica el MISMO filtro (`COBRO_QUE_CUBRE`). `paymentIds` en cambio
 * trae TODOS los COMPLETED, reembolsos incluidos: es rastro de auditoría, no la suma que manda
 * — nunca se suma.
 *
 * 🔴 `since` acota por `Order.createdAt` y es lo que hace barato el tic del barrido: el
 * criterio no tiene índice que sirva (`status NOT IN (...)`, `updatedAt <`), así que sin tope
 * cada pasada recorrería la historia entera de órdenes no terminales. El barrido periódico
 * pasa una ventana corta; el rezago viejo lo alcanza el script a mano, que pide la suya.
 *
 * 🔴 Una cuenta con el IVA SEPARADO (`taxAmount > 0`) nunca se propone para reparar, aunque cumpla
 * el criterio. El reparador (`reconcileOrderFromPayments`) reescribe el total con la convención
 * mexicana —el IVA viene DENTRO del precio, `total = subtotal − descuento + cargo + propina`—, así
 * que a una cuenta de $100 + $16 de IVA aparte cobrada en $116 le dejaría el total en $100 y el
 * cobro exacto se leería como sobrepago de $16. Esa forma sólo existe en el histórico importado
 * de SoftRestaurant (Testarudo, sin órdenes nuevas desde el 12-ago-2026) y en datos viejos de
 * prueba: toda venta nativa nace con `taxAmount = 0` (los presupuestos sumaban el 16 % encima
 * hasta el 28-sep-2026, con 0 en producción; `estimate.mobile.service.ts` ya no). El filtro va
 * por la FORMA de los importes y no por el origen: lo que decide si el reparador la corrompería
 * es que guarde el IVA aparte. Vive aquí y NO en el criterio compartido: el vigilante (check #6)
 * la sigue reportando como pagada pero abierta, y la decide una persona.
 *
 * 🔴 Y por la misma razón —la FORMA de los importes— nunca propone una orden cuyo dinero liquida una plataforma de reparto
 * (`esDeUnaPlataformaSql`): su total lleva cargos que el reparador no ve y se los quitaba (Codex b1 #1). Ésas las cierra, sólo de
 * estado y sin tocar su dinero, `findPedidosDePlataformaPorCerrar` + `cerrarPedidoDePlataformaSoloDeEstado`.
 */
export async function findPaidButOpenOrders(
  db: Db,
  opts: { graceMs: number; limit: number; now?: Date; since?: Date },
): Promise<CandidataPagadaAbierta[]> {
  const now = opts.now ?? new Date()
  const antesDe = new Date(now.getTime() - opts.graceMs)
  // `$queryRaw` con template: sólo los valores van parametrizados; el fragmento es texto fijo.
  const rows = await db.$queryRaw<CandidataPagadaAbierta[]>`
    SELECT o.id, o."venueId", o."orderNumber", o.status::text AS status, o."paymentStatus"::text AS "paymentStatus",
           (${Prisma.raw(baseQueDebeCubrirseSql('o'))})::text AS base,
           (SELECT COALESCE(SUM(p.amount), 0) FROM "Payment" p
             WHERE p."orderId" = o.id AND ${Prisma.raw(COBRO_QUE_CUBRE)})::text AS pagado,
           ARRAY(SELECT p.id FROM "Payment" p WHERE p."orderId" = o.id AND p.status = 'COMPLETED' ORDER BY p."createdAt") AS "paymentIds"
    FROM "Order" o
    WHERE ${Prisma.raw(criterioPagadaPeroAbiertaSql('o'))}
      AND COALESCE(o."taxAmount", 0) <= 0
      AND NOT (${Prisma.raw(esDeUnaPlataformaSql('o'))})
      AND o."updatedAt" < ${utcTs(antesDe)}
      ${opts.since ? Prisma.sql`AND o."createdAt" >= ${utcTs(opts.since)}` : Prisma.empty}
    ORDER BY o."createdAt" ASC
    LIMIT ${opts.limit}
  `
  return rows
}

export interface PedidoDePlataformaPorCerrar {
  id: string
  venueId: string
  orderNumber: string
  status: string
}

/**
 * Los pedidos de PLATAFORMA que el barrido cierra sólo de estado, del más viejo al más nuevo, con la misma gracia y la misma
 * ventana que las candidatas a reparar. Cumplen el criterio compartido (el vigilante ve el mismo conjunto) y además:
 *  - el núcleo de reparto ya los dio por pagados (`paymentStatus = PAID`). El barrido no decide si están pagados: uno con
 *    efectivo por cobrar no se cierra aquí (lo cobra la caja, que lo cierra);
 *  - están aceptados (`pedidoDePlataformaAceptadoSql`): uno que espera a la cocina nunca se cierra;
 *  - y ya es momento de cerrarlos (`momentoDeCerrarUnPedidoDePlataformaSql`, decisión B): la cocina lo terminó o se acabó su día
 *    del negocio, medido con el MISMO `now` de la pasada (el de su gracia), no con el reloj de la sesión.
 *
 * Todo va en la condición: dos `EXISTS` sobre `KdsOrder(orderId)` y uno sobre `Venue` por llave primaria, correlacionados con
 * cada fila que ya cumple el resto del filtro (el mismo tope de antes). Ninguna consulta extra por pedido.
 */
export async function findPedidosDePlataformaPorCerrar(
  db: Db,
  opts: { graceMs: number; limit: number; now?: Date; since?: Date },
): Promise<PedidoDePlataformaPorCerrar[]> {
  const now = opts.now ?? new Date()
  const antesDe = new Date(now.getTime() - opts.graceMs)
  return db.$queryRaw<PedidoDePlataformaPorCerrar[]>`
    SELECT o.id, o."venueId", o."orderNumber", o.status::text AS status
    FROM "Order" o
    WHERE ${Prisma.raw(criterioPagadaPeroAbiertaSql('o'))}
      AND ${Prisma.raw(pedidoDePlataformaPagadoYAceptadoSql('o'))}
      AND ${Prisma.raw(momentoDeCerrarUnPedidoDePlataformaSql('o', instanteUtcSql(now)))}
      AND o."updatedAt" < ${utcTs(antesDe)}
      ${opts.since ? Prisma.sql`AND o."createdAt" >= ${utcTs(opts.since)}` : Prisma.empty}
    ORDER BY o."createdAt" ASC
    LIMIT ${opts.limit}
  `
}

/**
 * Cierra UN pedido de plataforma sólo de estado: `COMPLETED` + `completedAt`, y nada más. Ni `total`, ni `tipAmount`, ni
 * `paidAmount`, ni `remainingBalance`, ni el estado de cobro: ese dinero es del núcleo de reparto (Codex b1 #1). No hay efectos
 * que se pierdan: el vale de inventario y los sobres nacieron en la ingesta, y no tiene mesa.
 *
 * Repite la decisión B EN el UPDATE: «Deshacer» puede reabrir la cocina sin cambiar el estado de la venta entre selección y
 * cierre. El CAS conserva también el negocio y el estado leído, y vuelve a exigir el cobro vigente.
 */
export async function cerrarPedidoDePlataformaSoloDeEstado(
  db: Pick<PrismaClient, '$executeRaw'>,
  p: Pick<PedidoDePlataformaPorCerrar, 'id' | 'venueId' | 'status'>,
  ahora: Date,
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE "Order" o
    SET status = 'COMPLETED', "completedAt" = ${utcTs(ahora)}, "updatedAt" = ${utcTs(ahora)}
    WHERE o.id = ${p.id} AND o."venueId" = ${p.venueId} AND o.status = ${p.status}::"OrderStatus"
      AND ${Prisma.raw(criterioPagadaPeroAbiertaSql('o'))}
      AND ${Prisma.raw(pedidoDePlataformaPagadoYAceptadoSql('o'))}
      AND ${Prisma.raw(momentoDeCerrarUnPedidoDePlataformaSql('o', instanteUtcSql(ahora)))}
  `
  return count === 1
}
