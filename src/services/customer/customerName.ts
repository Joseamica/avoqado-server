import type { Customer, Prisma } from '@prisma/client'

/** Primera palabra → `firstName`; el resto → `lastName`. */
export function splitName(name?: string | null): { firstName?: string; lastName?: string } {
  if (!name) return {}
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return {}
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined }
}

// Nombre del alta (spec 2026-10-14 §3.3). 🔴 Nunca pisa uno existente: el cliente que el negocio dio de alta como «Daniela
// Ruiz» no se vuelve «Dany» porque escribió otra cosa en su teléfono. El apellido sólo se llena si estaba vacío.
// Lo usan el alta por OTP (reservas) y el pedido en línea (ronda final, S3): los dos dentro de su transacción.
export async function ponerNombreSiFalta(tx: Prisma.TransactionClient, customer: Customer, nombre?: string | null): Promise<Customer> {
  if (customer.firstName?.trim()) return customer
  const partes = splitName(nombre)
  if (!partes.firstName) return customer
  return tx.customer.update({
    where: { id: customer.id },
    data: { firstName: partes.firstName, ...(partes.lastName && !customer.lastName?.trim() ? { lastName: partes.lastName } : {}) },
  })
}
