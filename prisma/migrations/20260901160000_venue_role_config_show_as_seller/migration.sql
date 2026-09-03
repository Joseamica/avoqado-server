-- ¿Este rol aparece en el selector de "Vendedor" del POS? Default TRUE (todos
-- salen, como siempre); el venue lo apaga para roles que no venden (p.ej. un
-- VIEWER renombrado a "Investor"). Aditivo y con default: cero impacto en
-- filas existentes. Escrita a mano porque la base local es COMPARTIDA y
-- `migrate dev` puede proponer un reset (precedente 2026-08-29).
ALTER TABLE "VenueRoleConfig" ADD COLUMN "showAsSeller" BOOLEAN NOT NULL DEFAULT true;
