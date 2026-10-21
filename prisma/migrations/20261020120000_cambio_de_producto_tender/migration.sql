-- Product exchange (spec 2026-10-20, block A, task 1): new system tender kind «Crédito de cambio».
-- Alone in its own migration on purpose: a new enum value cannot be used in the transaction that creates it, and nothing
-- in 20261020120100_cambio_de_producto may share a batch with it. Sorts after 20261020090000_tarjetas_de_regalo_1b.

-- AlterEnum
ALTER TYPE "TenderSystemKind" ADD VALUE 'EXCHANGE_CREDIT';
