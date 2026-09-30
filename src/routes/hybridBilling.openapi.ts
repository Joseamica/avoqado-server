/**
 * @openapi
 * components:
 *   schemas:
 *     HybridTerms:
 *       type: object
 *       required: [currency, interval, price, taxIncluded, promotionCycles, renewal]
 *       properties: {currency: {type: string, enum: [MXN]}, interval: {type: string, enum: [MONTHLY]}, price: {type: number, minimum: 10, maximum: 100000, multipleOf: 0.01, description: Pesos MXN con IVA incluido}, taxIncluded: {type: boolean, enum: [true]}, promotionCycles: {type: integer, minimum: 1, maximum: 24, nullable: true}, renewal: {oneOf: [{type: object, required: [kind], properties: {kind: {type: string, enum: [SAME_PRICE, END]}}}, {type: object, required: [kind, price], properties: {kind: {type: string, enum: [REPRICE]}, price: {type: number, minimum: 10, maximum: 100000, multipleOf: 0.01}}}]}}
 *     HybridDefinition:
 *       oneOf: [{type: object, additionalProperties: false, required: [schemaVersion, kind, terms, planTier], properties: {schemaVersion: {type: integer, enum: [1]}, terms: {$ref: '#/components/schemas/HybridTerms'}, kind: {type: string, enum: [PLAN]}, planTier: {type: string, enum: [PRO, PREMIUM]}}}, {type: object, additionalProperties: false, required: [schemaVersion, kind, terms, featureCodes], properties: {schemaVersion: {type: integer, enum: [1]}, terms: {$ref: '#/components/schemas/HybridTerms'}, kind: {type: string, enum: [FEATURES]}, featureCodes: {type: array, maxItems: 100, uniqueItems: true, items: {type: string, pattern: '^[A-Z][A-Z0-9_]{0,63}$'}, minItems: 1}}}, {type: object, additionalProperties: false, required: [schemaVersion, kind, terms, choiceCount, eligibleFeatureCodes], properties: {schemaVersion: {type: integer, enum: [1]}, terms: {$ref: '#/components/schemas/HybridTerms'}, kind: {type: string, enum: [CHOICE_BUNDLE]}, choiceCount: {type: integer, minimum: 1, maximum: 100}, eligibleFeatureCodes: {type: array, maxItems: 100, uniqueItems: true, items: {type: string, pattern: '^[A-Z][A-Z0-9_]{0,63}$'}, minItems: 1}}}]
 *     HybridCampaignInput:
 *       type: object
 *       additionalProperties: false
 *       required: [code, slug, name, startsAt, endsAt, capacity, audience, definition]
 *       properties: {code: {type: string, pattern: '^[A-Z0-9][A-Z0-9_-]{2,31}$'}, slug: {type: string, minLength: 3, maxLength: 60, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$'}, name: {type: string, minLength: 3, maxLength: 120}, startsAt: {type: string, format: date-time}, endsAt: {type: string, format: date-time}, capacity: {type: integer, minimum: 1, maximum: 100000}, audience: {type: string, enum: [ALL, NEW_ORGANIZATIONS, ORGANIZATIONS]}, eligibleOrganizationIds: {type: array, maxItems: 100, items: {type: string}}, listed: {type: boolean, default: false}, definition: {$ref: '#/components/schemas/HybridDefinition'}}
 *     HybridCampaignUpdate:
 *       type: object
 *       additionalProperties: false
 *       required: [code, slug, name, startsAt, endsAt, capacity, audience, definition, expectedRevision]
 *       properties: {code: {type: string, pattern: '^[A-Z0-9][A-Z0-9_-]{2,31}$'}, slug: {type: string, minLength: 3, maxLength: 60, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$'}, name: {type: string, minLength: 3, maxLength: 120}, startsAt: {type: string, format: date-time}, endsAt: {type: string, format: date-time}, capacity: {type: integer, minimum: 1, maximum: 100000}, audience: {type: string, enum: [ALL, NEW_ORGANIZATIONS, ORGANIZATIONS]}, eligibleOrganizationIds: {type: array, maxItems: 100, items: {type: string}}, listed: {type: boolean, default: false}, definition: {$ref: '#/components/schemas/HybridDefinition'}, expectedRevision: {type: integer, minimum: 1}}
 *     HybridQuoteInput:
 *       type: object
 *       additionalProperties: false
 *       required: [lines]
 *       properties: {lines: {type: array, minItems: 1, maxItems: 8, items: {type: object, additionalProperties: false, required: [publicationId], properties: {publicationId: {type: string}, selectedFeatureCodes: {type: array, maxItems: 100, uniqueItems: true, items: {type: string, pattern: '^[A-Z][A-Z0-9_]{0,63}$'}}}}}, replaceSubscriptionIds: {type: array, maxItems: 8, items: {type: string, pattern: '^sub_[A-Za-z0-9]+$'}}, dropFeatureCodes: {type: array, maxItems: 100, uniqueItems: true, items: {type: string, pattern: '^[A-Z][A-Z0-9_]{0,63}$'}}}
 *     HybridRevision:
 *       type: object
 *       additionalProperties: false
 *       required: [expectedRevision]
 *       properties: {expectedRevision: {type: integer, minimum: 1}}
 *     HybridSelection:
 *       type: object
 *       additionalProperties: false
 *       required: [expectedRevision, featureCodes]
 *       properties: {expectedRevision: {type: integer, minimum: 1}, featureCodes: {type: array, maxItems: 100, uniqueItems: true, items: {type: string, pattern: '^[A-Z][A-Z0-9_]{0,63}$'}, nullable: true}}
 *     HybridAcceptance:
 *       type: object
 *       additionalProperties: false
 *       required: [quoteHash, clientKey]
 *       properties: {quoteHash: {type: string, pattern: '^[a-f0-9]{64}$'}, clientKey: {type: string, minLength: 8, maxLength: 120, pattern: '^[A-Za-z0-9_-]+$', description: 'Llave estable: conservar en reintentos del mismo intento'}}
 *     HybridStatus:
 *       type: object
 *       additionalProperties: false
 *       required: [expectedRevision, status]
 *       properties: {expectedRevision: {type: integer, minimum: 1}, status: {type: string, enum: [ACTIVE, PAUSED, ENDED]}}
 *   responses:
 *     HybridResult:
 *       description: 'Resultado. success:true; data contiene el recurso o una página items,total,page,pageSize. Consultar la compra confirma el estado; el retorno del pago no activa funciones.'
 *     HybridInvalid:
 *       description: 'Formato, mecánica o selección no admitida.'
 *     HybridForbidden:
 *       description: 'Permiso, organización o elegibilidad insuficiente.'
 *     HybridNotFound:
 *       description: Recurso no disponible en este alcance.
 *     HybridConflict:
 *       description: 'Versión obsoleta, cupo agotado, oferta cerrada, compra pendiente o proveedor por verificar; conservar llave e intento.'
 *     HybridRateLimited:
 *       description: Esperar antes de retomar.
 * paths:
 *   '/api/v1/dashboard/venues/{venueId}/hybrid-billing/quotes':
 *     post:
 *       tags: [Hybrid billing]
 *       summary: Cotizar una composición; vigencia máxima cinco minutos
 *       description: 'No cobra ni activa funciones. Sólo publicaciones vigentes; precio y accesos los resuelve el servidor. Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere membresía en venueId y billing:subscriptions:manage.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: venueId, in: path, required: true, schema: {type: string}}]
 *       responses: {'201': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *       requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/HybridQuoteInput'}}}}
 *   '/api/v1/dashboard/venues/{venueId}/hybrid-billing/purchases/current':
 *     get:
 *       tags: [Hybrid billing]
 *       summary: Recuperar el intento aceptado aún pendiente
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere membresía en venueId y billing:subscriptions:read.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: venueId, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *   '/api/v1/dashboard/venues/{venueId}/hybrid-billing/replacement-options':
 *     get:
 *       tags: [Hybrid billing]
 *       summary: Consultar obligaciones reemplazables y funciones ya incluidas
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere membresía en venueId y billing:subscriptions:read.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: venueId, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *   '/api/v1/dashboard/venues/{venueId}/hybrid-billing/purchases/{id}':
 *     get:
 *       tags: [Hybrid billing]
 *       summary: Consultar la compra y su cotización inmutable
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere membresía en venueId y billing:subscriptions:read.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: venueId, in: path, required: true, schema: {type: string}}, {name: id, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *   '/api/v1/dashboard/venues/{venueId}/hybrid-billing/purchases/{id}/accept':
 *     post:
 *       tags: [Hybrid billing]
 *       summary: Aceptar condiciones y abrir el pago del mismo intento
 *       description: 'Reservar antes del pago no concede acceso. El webhook verifica el pago real; una URL de retorno no lo confirma. Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere membresía en venueId y billing:subscriptions:manage.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: venueId, in: path, required: true, schema: {type: string}}, {name: id, in: path, required: true, schema: {type: string}}]
 *       responses: {'202': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *       requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/HybridAcceptance'}}}}
 *   '/api/v1/dashboard/venues/{venueId}/hybrid-billing/purchases/{id}/resume':
 *     post:
 *       tags: [Hybrid billing]
 *       summary: Retomar la compra conservando intento y condiciones
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere membresía en venueId y billing:subscriptions:manage.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: venueId, in: path, required: true, schema: {type: string}}, {name: id, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *   '/api/v1/dashboard/venues/{venueId}/hybrid-billing/purchases/{id}/cancel':
 *     post:
 *       tags: [Hybrid billing]
 *       summary: Cancelar sólo después de verificar que no existe pago confirmado
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere membresía en venueId y billing:subscriptions:manage.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: venueId, in: path, required: true, schema: {type: string}}, {name: id, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *   '/api/v1/dashboard/venues/{venueId}/hybrid-billing/contracts':
 *     get:
 *       tags: [Hybrid billing]
 *       summary: Consultar contratos y cambios futuros
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere membresía en venueId y billing:subscriptions:read.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: venueId, in: path, required: true, schema: {type: string}}, {name: page, in: query, schema: {type: integer, minimum: 1, default: 1}}, {name: pageSize, in: query, schema: {type: integer, minimum: 1, maximum: 100, default: 25}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *   '/api/v1/dashboard/venues/{venueId}/hybrid-billing/contracts/{id}/selection':
 *     post:
 *       tags: [Hybrid billing]
 *       summary: Programar selección para la próxima renovación pagada
 *       description: 'featureCodes:null retira el cambio futuro. No cambia accesos del período vigente. Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere membresía en venueId y billing:subscriptions:manage.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: venueId, in: path, required: true, schema: {type: string}}, {name: id, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *       requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/HybridSelection'}}}}
 *   '/api/v1/dashboard/venues/{venueId}/hybrid-billing/contracts/{id}/cancel':
 *     post:
 *       tags: [Hybrid billing]
 *       summary: Cancelar renovación al terminar el período pagado
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere membresía en venueId y billing:subscriptions:manage.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: venueId, in: path, required: true, schema: {type: string}}, {name: id, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *       requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/HybridRevision'}}}}
 *   /api/v1/superadmin/hybrid-campaigns:
 *     get:
 *       tags: [Hybrid billing]
 *       summary: Listar campañas
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere SUPERADMIN vigente.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: page, in: query, schema: {type: integer, minimum: 1, default: 1}}, {name: pageSize, in: query, schema: {type: integer, minimum: 1, maximum: 100, default: 25}}, {name: q, in: query, schema: {type: string, maxLength: 120}}, {name: status, in: query, schema: {type: string, enum: [DRAFT, ACTIVE, PAUSED, ENDED]}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *     post:
 *       tags: [Hybrid billing]
 *       summary: Crear borrador sin activar ventas
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere SUPERADMIN vigente.'
 *       security: [{bearerAuth: []}]
 *       parameters: []
 *       responses: {'201': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *       requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/HybridCampaignInput'}}}}
 *   /api/v1/superadmin/hybrid-campaigns/catalog:
 *     get:
 *       tags: [Hybrid billing]
 *       summary: Consultar catálogo completo de capacidades
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere SUPERADMIN vigente.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: page, in: query, schema: {type: integer, minimum: 1, default: 1}}, {name: pageSize, in: query, schema: {type: integer, minimum: 1, maximum: 100, default: 25}}, {name: q, in: query, schema: {type: string, maxLength: 120}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *   '/api/v1/superadmin/hybrid-campaigns/{id}':
 *     get:
 *       tags: [Hybrid billing]
 *       summary: Consultar campaña y publicaciones inmutables
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere SUPERADMIN vigente.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: id, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *     put:
 *       tags: [Hybrid billing]
 *       summary: Editar el borrador conservando compras anteriores
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere SUPERADMIN vigente.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: id, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *       requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/HybridCampaignUpdate'}}}}
 *   '/api/v1/superadmin/hybrid-campaigns/{id}/publish':
 *     post:
 *       tags: [Hybrid billing]
 *       summary: Congelar condiciones; publicación inicialmente pausada
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere SUPERADMIN vigente.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: id, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *       requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/HybridRevision'}}}}
 *   '/api/v1/superadmin/hybrid-campaigns/{id}/status':
 *     post:
 *       tags: [Hybrid billing]
 *       summary: 'Activar, pausar o terminar nuevas ventas'
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere SUPERADMIN vigente.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: id, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *       requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/HybridStatus'}}}}
 *   '/api/v1/superadmin/hybrid-campaigns/{id}/redemptions':
 *     get:
 *       tags: [Hybrid billing]
 *       summary: 'Consultar reservas, compras e incidencias'
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Requiere SUPERADMIN vigente.'
 *       security: [{bearerAuth: []}]
 *       parameters: [{name: id, in: path, required: true, schema: {type: string}}, {name: page, in: query, schema: {type: integer, minimum: 1, default: 1}}, {name: pageSize, in: query, schema: {type: integer, minimum: 1, maximum: 100, default: 25}}, {name: q, in: query, schema: {type: string, maxLength: 120}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *   /api/v1/public/hybrid-offers:
 *     get:
 *       tags: [Hybrid billing]
 *       summary: Listar ofertas publicadas
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Lectura pública; sin reserva de cupo ni autorización de pago.'
 *       security: []
 *       parameters: [{name: page, in: query, schema: {type: integer, minimum: 1, default: 1}}, {name: pageSize, in: query, schema: {type: integer, minimum: 1, maximum: 100, default: 25}}, {name: q, in: query, schema: {type: string, maxLength: 120}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 *   '/api/v1/public/hybrid-offers/{slug}':
 *     get:
 *       tags: [Hybrid billing]
 *       summary: Consultar una oferta y sus funciones localizadas
 *       description: ' Importes en pesos MXN. Respuesta {success:true,data:...}; listas con items,total,page,pageSize. Lectura pública; sin reserva de cupo ni autorización de pago.'
 *       security: []
 *       parameters: [{name: slug, in: path, required: true, schema: {type: string}}]
 *       responses: {'200': {$ref: '#/components/responses/HybridResult'}, '400': {$ref: '#/components/responses/HybridInvalid'}, '403': {$ref: '#/components/responses/HybridForbidden'}, '404': {$ref: '#/components/responses/HybridNotFound'}, '409': {$ref: '#/components/responses/HybridConflict'}, '429': {$ref: '#/components/responses/HybridRateLimited'}}
 */
export {}
