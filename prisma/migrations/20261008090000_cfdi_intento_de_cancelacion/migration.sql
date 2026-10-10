-- C2 (IVA por producto, §4.5): cada intento de cancelación tiene número; su envío al PAC deja un token antes de la consulta y del POST;
-- y se anota cuándo el PAC acusó ESE intento (lo vio en trámite). Cada intento se envía UNA vez (v5: nunca se reenvía solo).
-- ADITIVA: tres columnas nuevas (una con default) y un backfill acotado a las cancelaciones en trámite.
ALTER TABLE "Cfdi" ADD COLUMN "cancelIntento" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Cfdi" ADD COLUMN "cancelEnviadaAt" TIMESTAMP(3);
ALTER TABLE "Cfdi" ADD COLUMN "cancelAcusadaAt" TIMESTAMP(3);

-- Backfill (C2, Ruling G5b / pre-flight M7): el código anterior sólo escribía `cancelStatus = 'REQUESTED'` DESPUÉS de que el PAC
-- contestara «en trámite», así que toda cancelación `REQUESTED` de antes de este despliegue ya se ENVIÓ (una vez) y el PAC la ACUSÓ.
-- Sin esto quedarían «anotadas y sin enviar»: el barrido cerraría sus negativos con «No se llegó a enviar» (falso: el receptor la
-- rechazó) y un «Cancelar» ganaría el envío del intento 0 y mandaría un SEGUNDO DELETE tras un rechazo (Codex C2-24).
-- Quedan como el intento 1, enviado y acusado (EN_TRAMITE): sólo se consultan, nunca se reenvían. Medido en producción el 8-oct: 0 filas.
UPDATE "Cfdi"
SET "cancelIntento" = 1,
    "cancelEnviadaAt" = COALESCE("cancelRequestedAt", "updatedAt"),
    "cancelAcusadaAt" = COALESCE("cancelRequestedAt", "updatedAt")
WHERE "cancelStatus" = 'REQUESTED';
