-- Módulo VENUE_DUPLICATION (sólo datos; sin VenueModule/OrganizationModule no hay acceso)
INSERT INTO "Module" ("id", "code", "name", "description", "scope", "defaultConfig", "active", "createdAt", "updatedAt")
VALUES ('cmvenuedup0000modulefase1', 'VENUE_DUPLICATION', 'Duplicar tiendas',
        'Permite al dueño de la organización (sólo el dueño) crear tiendas copiando una suya (misma cuenta de cobro, tarifa y configuración).',
        'ORGANIZATION_ONLY'::"ModuleScope", '{}'::jsonb, true, NOW(), NOW())
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "description" = EXCLUDED."description", "scope" = EXCLUDED."scope", "updatedAt" = NOW();
