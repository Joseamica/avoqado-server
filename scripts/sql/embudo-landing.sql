-- Embudo de las cuentas creadas desde una landing (avoqado.io/restaurants y hermanas).
--
-- Contesta la pregunta "¿donde se traba la gente?" sin depender de GA4: todo
-- sale de la propia base. Cada columna es una etapa; el salto que mas cae es
-- donde hay que trabajar.
--
--   PGPASSWORD=… psql -h localhost -U postgres -d av-db-25 -f scripts/sql/embudo-landing.sql
--
-- 🔴 El alta por landing se reconoce por el ActivityLog `LANDING_SIGNUP_CREATED`,
-- NUNCA por `password IS NULL`. La primera version usaba eso ultimo y estaba
-- mal de raiz: esa condicion deja de cumplirse justo cuando la persona fija su
-- contrasena — o sea, en la conversion que se quiere medir. El embudo contaba
-- solo a los que NO convirtieron y las etapas 3, 4 y 5 salian siempre en cero.
-- Se descubrio corriendo el flujo completo (2026-08-18).

WITH altas AS (
  SELECT
    s.id,
    s.email,
    alta."createdAt",
    alta.data->>'source' AS origen,
    s."resetTokenUsedAt",
    (s.password IS NOT NULL) AS ya_tiene_contrasena,
    so."organizationId",
    op."currentStep",
    op."completedSteps",
    EXISTS (
      SELECT 1 FROM "ActivityLog" al
      WHERE al."staffId" = s.id AND al.action = 'ONBOARDING_MAGIC_LINK_CLICKED'
    ) AS hizo_clic
  FROM "ActivityLog" alta
  JOIN "Staff" s ON s.id = alta."staffId"
  LEFT JOIN "StaffOrganization" so ON so."staffId" = s.id AND so."isPrimary"
  LEFT JOIN "OnboardingProgress" op ON op."organizationId" = so."organizationId"
  WHERE alta.action = 'LANDING_SIGNUP_CREATED'
    AND alta."createdAt" >= NOW() - INTERVAL '30 days'
)
SELECT
  COALESCE(origen, 'sin origen')                                  AS "landing",
  COUNT(*)                                                        AS "1 cuenta creada",
  COUNT(*) FILTER (WHERE hizo_clic)                               AS "2 abrio el link",
  -- Fijar la contrasena es la conversion. Se detecta por CUALQUIERA de las dos
  -- senales: el sello del canje, o simplemente que ya tenga contrasena (por si
  -- la puso por otra via, como "olvide mi contrasena").
  COUNT(*) FILTER (WHERE "resetTokenUsedAt" IS NOT NULL OR ya_tiene_contrasena) AS "3 puso contrasena",
  COUNT(*) FILTER (WHERE "currentStep" > 0)                       AS "4 avanzo el wizard",
  COUNT(*) FILTER (WHERE jsonb_array_length("completedSteps") >= 6) AS "5 termino onboarding",
  ROUND(100.0 * COUNT(*) FILTER (WHERE hizo_clic) / NULLIF(COUNT(*), 0), 1) AS "% clic",
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE "resetTokenUsedAt" IS NOT NULL OR ya_tiene_contrasena)
    / NULLIF(COUNT(*), 0), 1
  ) AS "% activo"
FROM altas
GROUP BY ROLLUP (origen)
ORDER BY origen NULLS LAST;

-- Detalle: quien se quedo en el camino y hace cuanto
WITH altas AS (
  SELECT
    s.id,
    s.email,
    alta."createdAt",
    alta.data->>'source' AS origen,
    s."resetTokenUsedAt",
    (s.password IS NOT NULL) AS ya_tiene_contrasena,
    so."organizationId",
    op."currentStep",
    op."completedSteps",
    EXISTS (
      SELECT 1 FROM "ActivityLog" al
      WHERE al."staffId" = s.id AND al.action = 'ONBOARDING_MAGIC_LINK_CLICKED'
    ) AS hizo_clic
  FROM "ActivityLog" alta
  JOIN "Staff" s ON s.id = alta."staffId"
  LEFT JOIN "StaffOrganization" so ON so."staffId" = s.id AND so."isPrimary"
  LEFT JOIN "OnboardingProgress" op ON op."organizationId" = so."organizationId"
  WHERE alta.action = 'LANDING_SIGNUP_CREATED'
    AND alta."createdAt" >= NOW() - INTERVAL '30 days'
)
SELECT
  email,
  COALESCE(origen, '—')  AS landing,
  "createdAt"::date      AS alta,
  CASE
    WHEN "completedSteps" IS NOT NULL AND jsonb_array_length("completedSteps") >= 6 THEN 'terminó'
    WHEN "currentStep" > 0                                        THEN 'a medio wizard (paso ' || "currentStep" || ')'
    WHEN "resetTokenUsedAt" IS NOT NULL OR ya_tiene_contrasena    THEN 'puso contraseña, no empezó'
    WHEN hizo_clic                                                THEN 'abrió el link, no puso contraseña'
    ELSE                                                               'nunca abrió el correo'
  END AS "se quedó en"
FROM altas
ORDER BY "createdAt" DESC
LIMIT 40;
