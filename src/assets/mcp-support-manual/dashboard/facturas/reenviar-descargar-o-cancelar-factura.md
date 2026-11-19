---
title: Reenviar, descargar o cancelar una factura en el panel
description: Desde Facturación › Facturas baja el XML o el PDF de una factura, reenvíala por correo o pide al SAT cancelarla.
product: dashboard
category: facturas
task: reenviar-descargar-o-cancelar-factura
requiredPermissions:
  - cfdi:view
featureCode: CFDI
gateKind: FEATURE
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - reenviar factura
  - descargar factura
  - pdf de la factura
  - xml
  - cancelar factura
  - el cliente no recibió su factura
---

## Antes de empezar

Bajar una factura sólo pide ver facturas; reenviarla, permiso para facturar; cancelarla, permiso para configurar la facturación (por omisión, administrador o dueño). Una cancelación ante el SAT no se deshace.

## Pasos

1. En *Facturación* › *Facturas*, abre el menú ⋯ de la factura.
2. Para bajarla, toca *Descargar XML* o *Descargar PDF*.
3. Para mandarla otra vez, toca *Reenviar por correo*. Deja vacío *Otro correo (opcional)* para usar el del cliente, o escribe otro, y toca *Enviar*.
4. Para cancelarla, toca *Cancelar*, elige el *Motivo de cancelación* y toca *Cancelar factura*. Con el motivo 01 también pide el UUID de la factura que la sustituye.

## Problemas frecuentes

- *Reenviar por correo* y *Cancelar* sólo salen en una factura timbrada sin una cancelación en curso.
- Después de «Cancelación solicitada.» la factura puede seguir vigente mientras el SAT responde; en el menú sale *Consultar estado*, que sólo pregunta.
- Si sale «No quedó cancelada», la factura sigue vigente; debajo sale la razón del SAT, si la dio.
- Si el importe de una factura de venta está mal, el menú trae *Corregir importe (sustituir)*: su ventana explica lo que va a pasar antes de confirmar.
