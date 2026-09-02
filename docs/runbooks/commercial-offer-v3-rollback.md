# Commercial Offer v3 rollback rehearsal

Commercial Offer v3 is an expand-only, LAB_ONLY schema. It has no activation,
claim, quote, checkout, Stripe or outbox authority. A runtime rollback therefore
means deploying the last compatible Server while preserving every immutable v3
row; it never means editing or deleting a published offer.

## Preconditions

1. Keep commercial rollout and checkout in `OFF`.
2. Run `npm run commercial:release:preflight` and require zero v3 operational
   references.
3. Record the count of `CommercialCampaignVersion` rows whose `schemaVersion`
   is `3` and the active migration set.
4. Do not reverse the migration while that count is non-zero.

## Safe rollback

- Repoint application code to the previous compatible Server revision.
- Leave the additive discriminator, benefit table, immutable publications and
  fail-closed operational-reference triggers installed.
- Re-run release preflight. Existing v1/v2 readers continue rejecting schema 3,
  and the previous runtime does not select or activate those rows.

This is analogous to closing a new room while leaving its sealed archive in the
building: old hallways continue working, but the archive is not destroyed just
to hide the room.

## Destructive rollback guard

Narrowing `CommercialCampaignVersion_schema_version_check` back to `(1, 2)` is
expected to fail with SQLSTATE `23514` when any v3 publication exists. The
PostgreSQL integration suite exercises that failure inside a transaction and
then proves the original `(1, 2, 3)` constraint survived the rollback.

Dropping v3 rows, disabling immutability, or removing the operational-reference
triggers is not an authorized rollback. It requires a separately reviewed data
retirement plan after the feature has no retained business or audit value.
