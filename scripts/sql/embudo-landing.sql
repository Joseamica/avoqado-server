-- Embudo de las cuentas creadas desde una landing (avoqado.io/restaurants y hermanas).
--
-- Contesta la pregunta "¿donde se traba la gente?" sin depender de GA4: todo
-- sale de la propia base. Cada columna es una etapa; el salto que mas cae es
-- donde hay que trabajar.
--
--   PGPASSWORD=… psql -h localhost -U postgres -d av-db-25 -f scripts/sql/embudo-landing.sql
--
-- Ojo: solo cuenta cuentas SIN contrasena inicial, que es la firma del alta por
-- landing. Las de dashboard/signup nacen con contrasena y no entran aqui.

WITH altas AS (
  SELECT
    s.id,
    s.email,
    s."createdAt",
    s."resetTokenUsedAt",
    so."organizationId",
    op."currentStep",
    op."completedSteps",
    EXISTS (
      SELECT 1 FROM "ActivityLog" al
      WHERE al."staffId" = s.id AND al.action = 'ONBOARDING_MAGIC_LINK_CLICKED'
    ) AS hizo_clic
  FROM "Staff" s
  LEFT JOIN "StaffOrganization" so ON so."staffId" = s.id AND so."isPrimary"
  LEFT JOIN "OnboardingProgress" op ON op."organizationId" = so."organizationId"
  WHERE s."createdAt" >= NOW() - INTERVAL '30 days'
    AND s.password IS NULL          -- firma del alta por landing
)
SELECT
  COUNT(*)                                                        AS "1 cuenta creada",
  COUNT(*) FILTER (WHERE hizo_clic)                               AS "2 abrio el link",
  COUNT(*) FILTER (WHERE "resetTokenUsedAt" IS NOT NULL)          AS "3 puso contrasena",
  COUNT(*) FILTER (WHERE "currentStep" > 0)                       AS "4 avanzo el wizard",
  COUNT(*) FILTER (WHERE jsonb_array_length("completedSteps") >= 6)  AS "5 termino onboarding",
  ROUND(100.0 * COUNT(*) FILTER (WHERE hizo_clic) / NULLIF(COUNT(*), 0), 1)              AS "% clic",
  ROUND(100.0 * COUNT(*) FILTER (WHERE "resetTokenUsedAt" IS NOT NULL) / NULLIF(COUNT(*), 0), 1) AS "% activo"
FROM altas;

-- Detalle: quien se quedo en el camino y hace cuanto
WITH altas AS (
  SELECT
    s.id,
    s.email,
    s."createdAt",
    s."resetTokenUsedAt",
    so."organizationId",
    op."currentStep",
    op."completedSteps",
    EXISTS (
      SELECT 1 FROM "ActivityLog" al
      WHERE al."staffId" = s.id AND al.action = 'ONBOARDING_MAGIC_LINK_CLICKED'
    ) AS hizo_clic
  FROM "Staff" s
  LEFT JOIN "StaffOrganization" so ON so."staffId" = s.id AND so."isPrimary"
  LEFT JOIN "OnboardingProgress" op ON op."organizationId" = so."organizationId"
  WHERE s."createdAt" >= NOW() - INTERVAL '30 days'
    AND s.password IS NULL          -- firma del alta por landing
)
SELECT
  email,
  "createdAt"::date AS alta,
  CASE
    WHEN "completedSteps" IS NOT NULL AND jsonb_array_length("completedSteps") >= 6 THEN 'terminó'
    WHEN "currentStep" > 0                THEN 'a medio wizard (paso ' || "currentStep" || ')'
    WHEN "resetTokenUsedAt" IS NOT NULL   THEN 'puso contraseña, no empezó'
    WHEN hizo_clic                        THEN 'abrió el link, no puso contraseña'
    ELSE                                       'nunca abrió el correo'
  END AS "se quedó en"
FROM altas
ORDER BY "createdAt" DESC
LIMIT 40;
