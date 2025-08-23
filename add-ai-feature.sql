-- Primero, verificar si existe la feature AI_ASSISTANT_BUBBLE
SELECT * FROM "Feature" WHERE code = 'AI_ASSISTANT_BUBBLE';

-- Si no existe, crearla (ajusta los valores según necesites)
INSERT INTO "Feature" (id, code, name, description, category, "monthlyPrice", active)
VALUES (
  'ai-assistant-bubble-id', 
  'AI_ASSISTANT_BUBBLE', 
  'Asistente IA Bubble', 
  'Chat bubble con asistente de inteligencia artificial', 
  'AI_TOOLS', 
  0, 
  true
) ON CONFLICT (code) DO NOTHING;

-- Luego, obtener el ID de tu venue (Avoqado Centro)
SELECT id, name FROM "Venue" WHERE name = 'Avoqado Centro';

-- Asignar la feature al venue (reemplaza 'tu-venue-id' con el ID real)
-- Primero busca el venue ID ejecutando la query anterior
INSERT INTO "VenueFeature" (id, "venueId", "featureId", active, "monthlyPrice", "startDate")
SELECT 
  gen_random_uuid(),
  v.id,
  f.id,
  true,
  0,
  NOW()
FROM "Venue" v, "Feature" f
WHERE v.name = 'Avoqado Centro' 
  AND f.code = 'AI_ASSISTANT_BUBBLE'
  AND NOT EXISTS (
    SELECT 1 FROM "VenueFeature" vf 
    WHERE vf."venueId" = v.id AND vf."featureId" = f.id
  );