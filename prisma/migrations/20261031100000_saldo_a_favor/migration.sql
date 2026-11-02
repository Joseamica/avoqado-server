-- Saldo a favor (spec 2026-10-30-saldo-a-favor §5.1, §5.3, §5.4). Aditiva.
-- Postgres >= 12 admite ADD VALUE dentro de la transacción de la migración; los valores nuevos no se usan aquí.

-- AlterEnum: el medio de sistema «Saldo a favor» (destino de una devolución abonada al sobre del cliente).
ALTER TYPE "TenderSystemKind" ADD VALUE 'STORE_CREDIT';

-- AlterEnum: el cambio también puede devolver la diferencia como saldo a favor.
ALTER TYPE "ExchangeSettlementMethod" ADD VALUE 'STORE_CREDIT';

-- AlterTable: «Sólo saldo a favor» (default false: ningún negocio amanece con el interruptor prendido).
ALTER TABLE "VenueSettings" ADD COLUMN     "storeCreditOnly" BOOLEAN NOT NULL DEFAULT false;
