-- El permiso de correo también lo puede dar el equipo (alta a mano / importación): la entrada de la landing ya no es obligatoria
-- y se guarda quién marcó la casilla. Aditiva y compatible: nada se borra ni se renombra.
ALTER TABLE "CrmEmailConsent" ALTER COLUMN "entryId" DROP NOT NULL;
ALTER TABLE "CrmEmailConsent" ADD COLUMN "grantedById" TEXT;
