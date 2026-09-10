-- Investigación de sólo lectura, Testarudo. Horas de consulta UTC.

-- Los resultados son logs del servidor; no equivalen a recepción o ejecución por el dispositivo.

WITH
JSONExtract(raw,'message','message','Nullable(String)') AS msg,
JSONExtract(raw,'message','requestId','Nullable(String)') AS rid,
JSONExtract(raw,'message','venueId','Nullable(String)') AS vid,
JSONExtract(raw,'message','terminalId','Nullable(String)') AS tid,
JSONExtract(raw,'message','url','Nullable(String)') AS url
SELECT dt,msg,rid,tid,url,
JSONExtract(raw,'message','correlationId','Nullable(String)') AS cid,
JSONExtract(raw,'message','method','Nullable(String)') AS method,
JSONExtract(raw,'message','statusCode','Nullable(Int64)') AS httpStatus,
JSONExtract(raw,'message','durationMs','Nullable(Float64)') AS durationMs,
JSONExtract(raw,'message','status','Nullable(String)') AS status,
JSONExtract(raw,'message','reason','Nullable(String)') AS reason
FROM s3Cluster(primary,t284025_render_log_stream_s3)
WHERE _row_type=1 AND JSONExtract(raw,'syslog','host','Nullable(String)')='avoqado-server'
AND dt>=toDateTime('2026-09-08 14:06:00','UTC') AND dt<toDateTime('2026-09-08 21:42:00','UTC')
AND (rid IN ('39176505-33c1-49f5-9c75-ce652c9e24cb','b54b3239-b9a3-4ce2-9d27-99b0a842b3a6','5da91c49-c073-42b9-a714-1a9e7a0443f6','6fa9cf3c-7939-4e0b-b9fe-2924114ef65f','bf771ca0-0b43-4f2f-accf-c52cffed5be0')
OR (url LIKE '/api/v1/mobile/venues/cmiowv1yu000aqa27mhhxrdqe/terminal-payment%' AND (
(dt>=toDateTime('2026-09-08 14:06:00','UTC') AND dt<toDateTime('2026-09-08 14:10:00','UTC')) OR
(dt>=toDateTime('2026-09-08 15:47:00','UTC') AND dt<toDateTime('2026-09-08 15:51:00','UTC')) OR
(dt>=toDateTime('2026-09-08 19:59:00','UTC') AND dt<toDateTime('2026-09-08 20:04:00','UTC')) OR
(dt>=toDateTime('2026-09-08 20:30:00','UTC') AND dt<toDateTime('2026-09-08 20:34:00','UTC')) OR
(dt>=toDateTime('2026-09-08 21:13:00','UTC') AND dt<toDateTime('2026-09-08 21:21:00','UTC'))
)))
ORDER BY dt LIMIT 160;

WITH JSONExtract(raw,'message','message','Nullable(String)') AS msg,
JSONExtract(raw,'message','terminalId','Nullable(String)') AS tid,
JSONExtract(raw,'message','correlationId','Nullable(String)') AS cid
SELECT dt,msg,tid,cid,
JSONExtract(raw,'message','requestId','Nullable(String)') AS rid,
JSONExtract(raw,'message','socketId','Nullable(String)') AS socketId,
JSONExtract(raw,'message','reason','Nullable(String)') AS reason,
JSONExtract(raw,'message','orderId','Nullable(String)') AS orderId,
JSONExtract(raw,'message','amountCents','Nullable(Int64)') AS amountCents,
JSONExtract(raw,'message','blockingRequestId','Nullable(String)') AS blockingRequestId
FROM s3Cluster(primary,t284025_render_log_stream_s3) WHERE _row_type=1 AND JSONExtract(raw,'syslog','host','Nullable(String)')='avoqado-server'
AND dt>=toDateTime('2026-09-08 21:12:00','UTC') AND dt<toDateTime('2026-09-08 21:41:00','UTC')
AND (cid IN ('d59185e3-1786-4b18-aaa0-29c46080cb35','a7b6a561-140a-4e11-90bd-5a0841e8153d','fb5333ab-d997-43d6-86ef-4a1ad6f98426')
OR (tid IN ('n860w173400','N860W173400','AVQD-N860W173400') AND (positionCaseInsensitive(msg,'socket')>0 OR positionCaseInsensitive(msg,'connect')>0 OR positionCaseInsensitive(msg,'busy')>0))
OR (position(msg,'0kOc7pgmJNyxn4NGAAAD')>0 AND (positionCaseInsensitive(msg,'socket')>0 OR positionCaseInsensitive(msg,'disconnect')>0)))
ORDER BY dt LIMIT 80;

WITH JSONExtract(raw,'message','message','Nullable(String)') AS msg,
JSONExtract(raw,'message','correlationId','Nullable(String)') AS cid,
JSONExtract(raw,'message','terminalId','Nullable(String)') AS tid
SELECT dt,msg,cid,tid,
JSONExtract(raw,'message','requestId','Nullable(String)') AS rid,
JSONExtract(raw,'message','socketId','Nullable(String)') AS socketId,
JSONExtract(raw,'message','event','Nullable(String)') AS event
FROM s3Cluster(primary,t284025_render_log_stream_s3)
WHERE _row_type=1 AND JSONExtract(raw,'syslog','host','Nullable(String)')='avoqado-server'
AND dt>=toDateTime('2026-09-08 19:59:00','UTC') AND dt<toDateTime('2026-09-08 20:04:00','UTC')
AND (position(msg,'CfWfzp4wqeKZp_ISAAb2')>0 OR cid='b44477df-b104-460a-a2ad-ab9f6eaf6067' OR
(tid IN ('2841653112','AVQD-2841653112') AND (positionCaseInsensitive(msg,'connect')>0 OR positionCaseInsensitive(msg,'socket')>0)))
ORDER BY dt LIMIT 40;

WITH JSONExtract(raw,'message','message','Nullable(String)') AS msg,
JSONExtract(raw,'message','durationMs','Nullable(Float64)') AS duration
SELECT if(startsWith(msg,'Request End:'),'finished','closed_prematurely') AS outcome,
JSONExtract(raw,'message','statusCode','Nullable(Int64)') AS httpStatus,count() AS n,
round(quantileExact(0.5)(duration),3) AS p50ms,round(quantileExact(0.95)(duration),3) AS p95ms,round(max(duration),3) AS maxms
FROM s3Cluster(primary,t284025_render_log_stream_s3) WHERE _row_type=1 AND JSONExtract(raw,'syslog','host','Nullable(String)')='avoqado-server'
AND dt>=toDateTime('2026-09-08 06:00:00','UTC') AND dt<toDateTime('2026-09-09 06:00:00','UTC')
AND JSONExtract(raw,'message','method','Nullable(String)')='POST'
AND JSONExtract(raw,'message','url','Nullable(String)')='/api/v1/mobile/venues/cmiowv1yu000aqa27mhhxrdqe/terminal-payment'
AND (startsWith(msg,'Request End:') OR startsWith(msg,'Request Closed Prematurely:'))
GROUP BY outcome,httpStatus ORDER BY outcome,httpStatus LIMIT 12;
