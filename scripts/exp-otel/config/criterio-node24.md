# Node 24 vs Node 20 — criterio FIJADO ANTES de medir (16-oct-2026)

Sólo el brazo A (server tal cual, sin OTel ni A+). Cada repetición es UN job: las dos versiones corren en el MISMO
runner, una después de la otra, en orden alternado (rep impar 20→24, rep par 24→20). Cuatro repeticiones. Cada versión
se compila con `npm ci && npm run build` EN esa versión y su server corre en `node:<v>-bookworm` con `--cpus=1
--memory=2g`; Postgres, actores y generador son idénticos (los del árbol de Node 20).

Métricas (ventana ALTA a la tasa congelada de 2.75 cobros/s, salvo que se diga): p95 de TODAS las peticiones HTTP,
CPU por 1,000 peticiones (cgroup), RSS pico (proceso node), arranque = ms desde `docker run` hasta la primera respuesta
AUTENTICADA (promedio del bloque de humo y del de carga). Se reportan además p50/p99, la ventana baja (1 cobro/s),
RSS en reposo, retraso del event loop p99 y errores.

Por métrica, con la diferencia PAREADA d = Node24 − Node20 de cada repetición:
- umbrales: Δp95 ≤ mín(5 % del p95 de Node 20, 10 ms) · CPU por petición ≤ +10 % · RSS pico ≤ +30 MB · arranque ≤ +3 s;
- PASA si todas las d cumplen el umbral; FALLA si ninguna lo cumple; si unas sí y otras no ⇒ INCONCLUSO (el ruido entre
  repeticiones es mayor que la diferencia);
- MEJORA si todas las d van a favor de Node 24 (d < 0); EMPEORA si todas van en contra (d > 0), aunque estén dentro del
  umbral.

Además: humo 5/5 en las dos versiones en cada repetición, y 0 errores NUEVOS (peticiones con error HTTP 5xx/0 que en
Node 20 no hubo, y mensajes de nivel `error` en el log del server que no aparecen con Node 20).

Veredicto:
- «NO ACEPTABLE» si alguna métrica FALLA, el humo no es 5/5 o aparecen errores nuevos (se dice con el dato);
- si no, «INCONCLUSO» si alguna métrica queda INCONCLUSO (se dice cuál);
- si no, «ACEPTABLE»; y «MEJOR» si además alguna métrica MEJORA y ninguna EMPEORA.
