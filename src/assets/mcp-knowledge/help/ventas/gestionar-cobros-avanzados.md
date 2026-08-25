---
title: Gestionar cobros avanzados
description: Revisa configuracion de pagos, cuentas merchant, terminal virtual y disputas.
product: dashboard
category: ventas
featureCode: AVOQADO_PAYMENTS
dashboardRoutes:
  - merchant-accounts
  - payment-config
  - virtual-terminal
  - disputes
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-05-21
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - ver-pagos
  - crear-liga-pago
  - comprar-addons-suscripciones
---

## Antes de empezar

Cobros avanzados cubre pantallas sensibles: configuracion de pagos, cuentas merchant, terminal virtual y disputas. Algunas opciones aparecen solo para superadmin o soporte porque pueden afectar procesamiento, liquidaciones o cumplimiento. Si eres OWNER o ADMIN y no ves **Payment Config** o **Merchant Accounts**, no asumas que esta roto: puede estar restringido por rol.

Antes de cambiar cualquier configuracion, identifica si el objetivo es activar cobros, revisar una cuenta procesadora, cobrar manualmente o responder una disputa. Cada caso requiere informacion distinta.

## Pasos

1. Abre **Ventas > Transacciones** para confirmar el estado actual de cobros.
2. Usa **Payment Config** solo si tienes acceso autorizado para revisar readiness, proveedor, reglas o asignacion de cuenta.
3. Usa **Merchant Accounts** para validar cuentas procesadoras vinculadas al venue cuando soporte te lo solicite.
4. Entra a **Terminal Virtual** si el local tiene habilitado el flujo de cobro manual o si la pantalla muestra estado de proximamente.
5. Revisa **Disputas** cuando un cliente desconozca un cargo o exista seguimiento de contracargo.
6. Documenta cualquier cambio con fecha, usuario y motivo.

## Problemas frecuentes

Si una ruta te redirige o no aparece en el menu, revisa rol, permisos, KYC y si la funcion esta activa para el local. Si una cuenta merchant aparece incompleta, no intentes crear otra sin validar con soporte. Si una disputa no tiene evidencia suficiente, recopila recibo, orden, fecha, monto y comprobante de entrega o consumo antes de responder.

## Que datos tener listos

Para configuracion de pagos, prepara venue, proveedor, moneda, estado KYC y metodo de liquidacion esperado. Para terminal virtual, valida si el local esta autorizado a hacer cobros manuales. Para disputas, prepara informacion que demuestre que el cargo fue valido, sin compartir datos sensibles completos del cliente.

Las pantallas de cobros avanzados tienen mayor riesgo operativo que un reporte. Un cambio incorrecto puede dejar de procesar pagos o afectar conciliacion, asi que cualquier ajuste debe tener aprobacion interna.

## Cuando pedir ayuda

Escala a soporte si una cuenta merchant esta bloqueada, si la configuracion de pagos muestra errores, si terminal virtual no esta disponible despues de activarse o si una disputa requiere respuesta formal. Incluye venue, ruta, proveedor, monto, fecha y captura del estado.
