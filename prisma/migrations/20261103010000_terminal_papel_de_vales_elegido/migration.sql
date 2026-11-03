-- D3 (2-nov-2026): cuándo se eligió el papel de un aparato en los vales por área.
ALTER TABLE "Terminal" ADD COLUMN "areaRoleChosenAt" TIMESTAMP(3);

-- Los aparatos que ya existen no se preguntan: cuentan como ya elegidos (promesa D3).
UPDATE "Terminal" SET "areaRoleChosenAt" = (NOW() AT TIME ZONE 'UTC') WHERE "selfRegistered" = true;
