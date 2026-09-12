WITH
  JSONExtract(raw, 'message', 'message', 'Nullable(String)') AS msg,
  JSONExtract(raw, 'message', 'method', 'Nullable(String)') AS method,
  JSONExtract(raw, 'message', 'url', 'Nullable(String)') AS url,
  JSONExtract(raw, 'message', 'durationMs', 'Nullable(Float64)') AS duration
SELECT
  toDate(dt, 'America/Mexico_City') AS day,
  if(startsWith(msg, 'Request End:'), 'finished', 'closed_prematurely') AS outcome,
  count() AS n,
  round(quantileExact(0.5)(duration), 3) AS p50_ms,
  round(quantileExact(0.95)(duration), 3) AS p95_ms,
  round(max(duration), 3) AS max_ms,
  countIf(duration >= 9500) AS at_least_9500ms,
  countIf(JSONExtract(raw, 'message', 'statusCode', 'Nullable(Int64)') >= 500) AS server_errors
FROM
  s3Cluster(primary, t284025_render_log_stream_s3)
WHERE
  _row_type = 1
  AND dt >= toDateTime('2026-09-05 06:00:00', 'UTC')
  AND dt < toDateTime('2026-09-09 03:00:00', 'UTC')
  AND JSONExtract(raw, 'syslog', 'host', 'Nullable(String)') = 'avoqado-server'
  AND method = 'POST'
  AND match(url, '^/api/v1/tpv/venues/cmiowv1yu000aqa27mhhxrdqe/orders/[^/?]+([?].*)?$')
  AND (startsWith(msg, 'Request End:') OR startsWith(msg, 'Request Closed Prematurely:'))
  AND duration IS NOT NULL
GROUP BY
  day,
  outcome
ORDER BY
  day,
  outcome
LIMIT 20;

-- Agrupación por correlación: marcador de creación frente a respuesta sin creación.
SELECT
  toDate(started, 'America/Mexico_City') AS day,
  if(has_new_payment > 0, 'payment_created_marker', 'without_creation_marker') AS request_kind,
  countIf(finished > 0) AS finished_n,
  countIf(closed > 0) AS closed_n,
  round(quantileExactIf(0.5)(response_ms, finished > 0),3) AS finished_p50_ms,
  round(quantileExactIf(0.95)(response_ms, finished > 0),3) AS finished_p95_ms,
  round(quantileExactIf(0.5)(commit_ms, has_new_payment > 0),3) AS creation_marker_p50_ms,
  round(quantileExactIf(0.5)(done_ms-commit_ms, has_new_payment > 0 AND has_done > 0),3) AS post_creation_p50_ms
FROM
  (
  SELECT
    JSONExtract(raw, 'message', 'correlationId', 'Nullable(String)') AS correlation,
    min(dt) AS started,
    countIf(JSONExtract(raw, 'message', 'message', 'Nullable(String)') = 'VenueTransaction created for payment') AS has_new_payment,
    countIf(JSONExtract(raw, 'message', 'message', 'Nullable(String)') = 'Payment recorded successfully') AS has_done,
    countIf(startsWith(JSONExtract(raw, 'message', 'message', 'Nullable(String)'), 'Request End:')) AS finished,
    countIf(startsWith(JSONExtract(raw, 'message', 'message', 'Nullable(String)'), 'Request Closed Prematurely:')) AS closed,
    maxIf(JSONExtract(raw, 'message', 'durationMs', 'Nullable(Float64)'), startsWith(JSONExtract(raw, 'message', 'message', 'Nullable(String)'), 'Request End:')) AS response_ms,
    maxIf(JSONExtract(raw, 'message', 'elapsedMs', 'Nullable(Float64)'), JSONExtract(raw, 'message', 'message', 'Nullable(String)') = 'VenueTransaction created for payment') AS commit_ms,
    maxIf(JSONExtract(raw, 'message', 'elapsedMs', 'Nullable(Float64)'), JSONExtract(raw, 'message', 'message', 'Nullable(String)') = 'Payment recorded successfully') AS done_ms,
    countIf(JSONExtract(raw, 'message', 'method', 'Nullable(String)') = 'POST' AND match(JSONExtract(raw, 'message', 'url', 'Nullable(String)'), '^/api/v1/tpv/venues/cmiowv1yu000aqa27mhhxrdqe/orders/[^/?]+([?].*)?$')) AS target_count
  FROM
    s3Cluster(primary, t284025_render_log_stream_s3)
  WHERE
    _row_type = 1
    AND dt >= toDateTime('2026-09-06 06:00:00', 'UTC')
    AND dt < toDateTime('2026-09-09 03:00:00', 'UTC')
    AND JSONExtract(raw, 'syslog', 'host', 'Nullable(String)') = 'avoqado-server'
    AND (JSONExtract(raw, 'message', 'message', 'Nullable(String)') IN ('VenueTransaction created for payment', 'Payment recorded successfully') OR position(raw, '/api/v1/tpv/venues/cmiowv1yu000aqa27mhhxrdqe/orders/') > 0)
  GROUP BY
    correlation
  HAVING
    target_count > 0
  )
GROUP BY
  day,
  request_kind
ORDER BY
  day,
  request_kind
LIMIT 20;
