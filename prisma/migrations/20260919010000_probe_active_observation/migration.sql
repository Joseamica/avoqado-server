-- La observación de la sonda, fuera del sobre reemplazable (Codex ronda 2, 19-sep).
--
-- Escrita A MANO a propósito: `prisma migrate dev` arrastra deriva ajena de `av-db-25` (un DROP INDEX y dos
-- cambios de DEFAULT que no son de este trabajo). Aditiva y sin datos.
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "probeActiveAt" TIMESTAMP(3);
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "probeResolvedAt" TIMESTAMP(3);
