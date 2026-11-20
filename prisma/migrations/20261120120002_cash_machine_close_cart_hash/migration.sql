-- Máquina de efectivo (fase 1a, Codex servidor r2 #5): la huella de los ARTÍCULOS del pedido con que se registró el folio, para que una
-- repetición o la carrera P2002 con otro carrito por el mismo importe sea un 409 y no la misma venta. Columna nueva y opcional: la
-- tabla nació en 20261120120000 y nada lee esta columna en clientes viejos.

-- AlterTable
ALTER TABLE "CashMachineClose" ADD COLUMN     "cartHash" VARCHAR(64);
