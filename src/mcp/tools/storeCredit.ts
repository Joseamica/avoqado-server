import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import AppError, { NotFoundError } from '@/errors/AppError'
import { updateVenueSettings } from '@/services/dashboard/venueSettings.dashboard.service'
import { cambiarTelefonoDeSaldoAFavor } from '@/services/giftCards/giftCardCuenta.service'
import { esSobreDeSaldoAFavor } from '@/services/giftCards/giftCardLedger'
import { storeCreditDeClientes } from '@/services/storeCredit/customerStoreCreditBalance'
import { storeCreditAvailable } from '@/services/storeCredit/storeCreditTender'
import prisma from '@/utils/prismaClient'
import { createGuard } from '../guard'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { text } from '../respond'
import type { McpScope } from '../scope'

const venueInput = z
  .string({ required_error: 'Indica la sucursal', invalid_type_error: 'La sucursal debe ser texto' })
  .min(1, 'Indica la sucursal')
  .describe('Identificador de una sucursal a la que tienes acceso')

/** Saldo a favor (spec 2026-10-30): ajuste «Sólo saldo a favor», saldo de un cliente y teléfono con que se gasta. Sólo modo libre. */
export function registerStoreCreditTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)

  const readSetting = async (venueId: string) => {
    const row = await prisma.venueSettings.findUnique({ where: { venueId }, select: { storeCreditOnly: true } })
    return { storeCreditOnly: row?.storeCreditOnly ?? false, disponible: storeCreditAvailable() }
  }

  server.tool(
    'get_store_credit_settings',
    'Consulta el ajuste «Sólo saldo a favor» de una sucursal (storeCreditOnly: true = las devoluciones salen como saldo a favor del cliente y no a la tarjeta, salvo defecto, cobro por error o fraudulento y cuenta cancelada) y si el servidor sabe dar saldo a favor (disponible). El saldo a favor nunca se paga en efectivo, transferencia ni tarjeta bancaria: sólo se gasta en la misma sucursal. Requiere permiso para consultar la sucursal. Sólo lectura.',
    { venueId: venueInput },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('venues:read', venueId)
      return text({ venueId, ...(await readSetting(venueId)) })
    },
  )

  server.tool(
    'set_store_credit_only',
    'Prende o apaga «Sólo saldo a favor» en una sucursal: prendido, las devoluciones de ventas ya cobradas se abonan como saldo a favor del cliente y no a la tarjeta (con las excepciones de defecto, cobro por error o fraudulento y cuenta cancelada). No mueve dinero ni cambia saldos ya abonados; el saldo a favor nunca se paga en efectivo. Requiere permiso para editar la sucursal y conexión con escritura. Primero muestra actual → nuevo; sólo tras confirmación expresa del operador repite confirmationArguments con confirm:true y el confirmationToken firmado. Guarda la elección y su bitácora.',
    {
      venueId: venueInput,
      storeCreditOnly: z.boolean({
        required_error: 'Indica si quieres prender «Sólo saldo a favor»',
        invalid_type_error: 'Indica true o false',
      }),
      confirm: z.boolean({ invalid_type_error: 'La confirmación debe ser true o false' }).optional(),
    },
    async ({ venueId, storeCreditOnly, confirm }) => {
      guard.venueFilter(venueId)
      requireWriteScopeAlways(scope, 'venues:update', 'cambia el ajuste «Sólo saldo a favor»')
      guard.requirePermission('venues:update', venueId)
      if (!confirm) {
        const actual = (await readSetting(venueId)).storeCreditOnly
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { actual, nuevo: storeCreditOnly },
          message: `«Sólo saldo a favor»: ${actual ? 'Prendido' : 'Apagado'} → ${storeCreditOnly ? 'Prendido' : 'Apagado'}. Confirma con el operador antes de guardar.`,
        })
      }
      // El servicio compartido registra al actor y los valores de antes y después.
      await updateVenueSettings(venueId, { storeCreditOnly }, scope.staffId)
      return text({ ok: true, venueId, ...(await readSetting(venueId)) })
    },
  )

  server.tool(
    'get_customer_store_credit',
    'Consulta el saldo a favor de UN cliente de la sucursal: storeCredit = { balanceCents (centavos), phoneLast4 (últimos 4 del teléfono con que se gasta), giftCardId, blocked (true si el saldo está congelado) } o null si nunca tuvo saldo a favor; saldo = el mismo importe en pesos. Es la misma lectura de la ficha del cliente. No devuelve el código ni el teléfono completo, y el saldo a favor nunca se paga en efectivo. Requiere permiso para consultar clientes. Sólo lectura.',
    {
      venueId: venueInput,
      customerId: z
        .string({ required_error: 'Indica el cliente', invalid_type_error: 'El cliente debe ser texto' })
        .min(1, 'Indica el cliente')
        .describe('Identificador del cliente (de find_customer)'),
    },
    async ({ venueId, customerId }) => {
      const base = guard.venueFilter(venueId)
      guard.requirePermission('customers:read', venueId)
      const customer = await prisma.customer.findFirst({ where: { ...base, id: customerId }, select: { id: true } })
      if (!customer) throw new NotFoundError('No se encontró el cliente')
      const storeCredit = (await storeCreditDeClientes(prisma, venueId, [customerId])).get(customerId) ?? null
      return text({ venueId, customerId, storeCredit, saldo: (storeCredit?.balanceCents ?? 0) / 100 })
    },
  )

  server.tool(
    'change_store_credit_phone',
    'Cambia el teléfono con que un cliente gasta su saldo a favor (sólo sobres de saldo a favor: una tarjeta de regalo vendida responde STORE_CREDIT_PHONE_NOT_ALLOWED). No manda la página ni el código, no mueve el saldo y los códigos ya enviados al número anterior dejan de servir. Pasa expectedPhoneLast4 (los últimos 4 que viste, de get_customer_store_credit o de la vista previa) para no pisar un cambio más nuevo: si ya es otro, responde STORE_CREDIT_PHONE_OUTDATED sin escribir. Requiere giftCards:manage y conexión con escritura. Primero muestra el teléfono actual (últimos 4); sólo tras confirmación expresa del operador repite confirmationArguments con confirm:true y el confirmationToken firmado. Deja bitácora con ambos teléfonos enmascarados.',
    {
      venueId: venueInput,
      giftCardId: z
        .string({ required_error: 'Indica el saldo a favor', invalid_type_error: 'El saldo debe ser texto' })
        .min(1, 'Indica el saldo a favor')
        .describe('giftCardId del saldo a favor (de get_customer_store_credit)'),
      phone: z
        .string({ required_error: 'Indica el teléfono nuevo', invalid_type_error: 'El teléfono debe ser texto' })
        .min(7, 'El teléfono no es válido')
        .max(20, 'El teléfono no es válido')
        .describe('Teléfono nuevo con que se gastará el saldo'),
      expectedPhoneLast4: z
        .string({ invalid_type_error: 'Los últimos 4 deben ser texto' })
        .regex(/^\d{4}$/, 'Son los últimos 4 dígitos del teléfono actual')
        .optional()
        .describe('Últimos 4 del teléfono actual que viste; si ya cambió, no se escribe'),
      confirm: z.boolean({ invalid_type_error: 'La confirmación debe ser true o false' }).optional(),
    },
    async ({ venueId, giftCardId, phone, expectedPhoneLast4, confirm }) => {
      const base = guard.venueFilter(venueId)
      requireWriteScopeAlways(scope, 'giftCards:manage', 'cambia el teléfono de un saldo a favor')
      guard.requirePermission('giftCards:manage', venueId)
      if (confirm) {
        try {
          const r = await cambiarTelefonoDeSaldoAFavor(venueId, giftCardId, { telefono: phone, staffId: scope.staffId, expectedPhoneLast4 })
          return text({ ok: true, giftCardId, phoneLast4: r.phoneLast4 })
        } catch (error) {
          if (error instanceof AppError && error.code) return text({ ok: false, code: error.code, error: error.message })
          throw error
        }
      }
      const card = await prisma.giftCard.findFirst({
        where: { ...base, id: giftCardId, status: { in: ['ACTIVE', 'BLOCKED'] } },
        select: { id: true, status: true, recipientPhone: true },
      })
      if (!card) throw new NotFoundError('No se encontró el saldo a favor')
      if (!(await esSobreDeSaldoAFavor(prisma as never, card.id))) {
        return text({
          ok: false,
          code: 'STORE_CREDIT_PHONE_NOT_ALLOWED',
          error: 'Esta tarjeta no es un saldo a favor: su destino se cambia desde Tarjetas de regalo.',
        })
      }
      const actual = (card.recipientPhone ?? '').slice(-4) || null
      return text({
        ok: false,
        requiresConfirmation: true,
        preview: {
          giftCardId: card.id,
          estado: card.status,
          telefonoActualUltimos4: actual,
          telefonoNuevoUltimos4: phone.replace(/\D/g, '').slice(-4),
        },
        message: `Vas a cambiar el teléfono con que se gasta este saldo a favor: ahora termina en ${actual ?? '(sin teléfono)'} y pasará a terminar en ${phone.replace(/\D/g, '').slice(-4)}. No manda la página ni el código ni mueve el saldo. Confirma con el operador antes de continuar${expectedPhoneLast4 ? '' : '; para no pisar un cambio más nuevo, repite la llamada con expectedPhoneLast4 igual a ' + (actual ?? 'vacío')}.`,
      })
    },
  )
}
