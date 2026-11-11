-- La autorización de gerente puede quedar atada a UNA operación (retiro de caja con cola sin red).
ALTER TABLE "PermissionOverride" ADD COLUMN "operationKey" TEXT;
