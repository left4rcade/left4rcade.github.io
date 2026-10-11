# Arcade voting API integration

This note describes the endpoints expected by `arcade.html`. The website can browse the JSON catalogue without these endpoints; voting stays disabled until the Worker changes are deployed.

## D1

Apply `migrations/0001_arcade_votes.sql` to the existing D1 database `left4rcade`. It creates only `arcade_votes`; it does not alter existing tables.

## GET /api/arcade-votes

Use the same `getVoterHash(request)` helper as the existing Worker. Return active ROM aggregates and the requesting visitor's current vote:

```json
{
  "votes": [
    { "rom_id": "sf2ce", "up_votes": 12, "down_votes": 3, "my_vote": 1 }
  ]
}
```

Only include ROM IDs with at least one active vote. A vote of `0` means withdrawn and must not count.

## POST /api/arcade/:romId/vote

Accept JSON `{"direction":"up"}` or `{"direction":"down"}`. Validate the ROM ID against the catalogue allowlist (or a dedicated table of valid ROM IDs), apply a distinct `arcade-vote` rate-limit action, and atomically toggle the visitor's vote:
- no row or current vote 0 -> set requested direction
- same direction -> set vote 0 (withdraw)
- opposite direction -> change to requested direction

Use a parameterized UPSERT keyed by `(rom_id, voter_hash)`. Return the updated aggregate and current vote, or a clear error response. Keep existing request and pricing-poll routes unchanged.

## Important deployment detail

The current Worker code is managed separately in the Cloudflare dashboard; it is not present in either of the two inspected GitHub repositories. The frontend deliberately handles a missing endpoint gracefully, but voting will not work until these Worker routes are added.
