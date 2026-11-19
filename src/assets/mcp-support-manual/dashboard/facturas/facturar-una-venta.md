---
title: Facturar una venta a un cliente en el panel
description: Emite la factura (CFDI) de una venta cerrada desde Facturación › Facturas › Nueva factura, con los datos fiscales del cliente.
product: dashboard
category: facturas
task: facturar-una-venta
requiredPermissions:
  - cfdi:view
  - cfdi:issue
  - orders:read
featureCode: CFDI
gateKind: FEATURE
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - facturar
  - factura de una venta
  - el cliente me pide factura
  - emitir factura
  - cfdi
  - timbrar
---

## Antes de empezar

Necesitas permiso para facturar y para ver pedidos, y que tu plan incluya facturación. Si a la configuración de facturación del negocio le falta algo, el panel lo dice al tocar *Nueva factura* o al elegir la venta.

## Pasos

1. En *Facturación* › *Facturas*, toca *Nueva factura*.
2. Busca la venta por folio, monto, o nombre o teléfono del cliente, y toca *Facturar* en su renglón.
3. Llena *RFC*, *Código postal*, *Razón social* (como está ante el SAT, sin «S.A. de C.V.»), *Régimen fiscal* y *Uso del CFDI*. Si escribes un correo, se le intenta mandar la factura ahí.
4. Toca *Emitir factura*. Si sale «Factura emitida correctamente.», ya quedó.

## Problemas frecuentes

- Una venta que dice *Ya facturada* no se puede elegir.
- *Nueva factura* sólo lista ventas cerradas: una venta pagada que sigue abierta se factura desde *Pedidos*.
- Si sale «No se pudo facturar:» con una lista, corrige lo que dice y vuelve a tocar *Emitir factura*.
- Si sale «Esta venta todavía no se puede facturar», lee la razón debajo; con permiso sale *Ir a Configuración* para arreglarla.
- «Factura emitida correctamente.» no confirma que el correo haya llegado. Si no le llega, no la vuelvas a emitir: reenvíala o descárgala con el botón ⋯ de la factura en *Facturas*.
- Si dice que la venta es de antes de que el negocio marcara el IVA por producto, alguien con permiso para configurar la facturación toca *Confirmar que el precio ya incluía IVA*, revisa la venta y toca *Sí, el precio incluía IVA*; sin ese permiso, pídeselo al dueño o a un administrador.
- Si sale «No hubo respuesta clara del PAC», no la vuelvas a emitir: la factura quedó en espera de confirmación. Si no aparece timbrada en *Facturas*, pide que lo revise una persona del equipo de Avoqado.
- Si sale «No puedes facturar desde aquí…», a tu usuario le falta el permiso o el plan del negocio no incluye facturación.
