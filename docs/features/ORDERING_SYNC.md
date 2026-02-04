# Ordering Sync Semantics (TPV)

> Scope: `PATCH /tpv/venues/{venueId}/orders/{orderId}/items`

## Purpose

This endpoint supports **local-first TPV ordering** with optimistic concurrency.
It is used for:
- **Adding items** to an order (fast taps).
- **Updating quantities** when the TPV merges items locally.

## Matching Rules (When an item already exists)

Items are matched by:
- `productId`
- **Modifiers** (sorted by modifier ID)
- **Notes** (trimmed; empty string → `null`)

If all three match, the item is considered the same line.

## Duplicate Entries in a Single Request

If the same item appears multiple times in a single request (same product + modifiers + notes):
- The backend **merges** them into one.
- The merged quantity is the **sum** of the duplicates.
- A warning is logged to indicate the normalization.

If a matching item already exists:
- **Single entry** → treated as an **absolute quantity** (used by TPV quantity edits).
- **Duplicates merged** → treated as **additive** (existing quantity + merged quantity).

This prevents rapid taps from being lost while keeping quantity edits correct.

## Notes

- Modifiers are compared by **ID only** (order-independent).
- Notes are normalized (`trim()` and empty → `null`) to avoid false mismatches.



## Idempotency (externalId)

TPV now sends `externalId` per item (stable line ID).
- If `externalId` is present, backend **upserts by externalId** (safe retries).
- If missing, backend falls back to matching by product + modifiers + notes.

For order creation, TPV can send `externalId` (client order ID) to avoid duplicate orders on retries.
