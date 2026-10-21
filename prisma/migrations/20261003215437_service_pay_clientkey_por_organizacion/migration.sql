-- La clave de idempotencia de un devengo es única POR ORGANIZACIÓN, no global (Task A7, ronda 1): con el índice global, la
-- misma clave usada por otro negocio hacía fallar el insert (500) y revelaba que existía allá.
DROP INDEX "ServiceEarning_clientKey_unico";
CREATE UNIQUE INDEX "ServiceEarning_clientKey_unico" ON "ServiceEarning"("organizationId", "clientKey") WHERE "clientKey" IS NOT NULL;
