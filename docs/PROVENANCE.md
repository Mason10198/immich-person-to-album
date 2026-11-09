# Shared-album reconciliation provenance

The optional full-scan album reconciliation adapts the matching/current-album
set-comparison approach in `mafr95/immich-person-to-album`, itself a fork of
`laikenny/immich-person-to-album` and `alangrainger/immich-person-to-album`.
It is not a wholesale import or a claim of behavioral equivalence.

- Source repository: `https://github.com/mafr95/immich-person-to-album`
- Immutable source commit: `646ab4949f33c22a608170436fcb2f399b6eba3d`
- Source path: `app/src/function.ts`
- Pristine source-file SHA-256: `4e965f94cb9f3872e1e3fd99126ff3d3395f1077f4446885751b9ae8617fddbc`
- License: AGPL-3.0; the repository's existing `LICENSE` is retained unchanged
  and byte-identical to that source revision's license.
- License SHA-256: `ce3fb82d9ee80a1cb0e548f9b0560ead52378ee2b4e826fd9459b4acf7075d89`

## Deliberate adaptations

- Reconcile the union of all configured users/rules for an album, not each
  contributor separately. Preserve matches belonging to the other account.
- Make membership removal opt-in with `sync: true` on every contributing rule;
  keep normal albums add-only and preserve the existing logical-rule filters.
- Do not perform album writes until every contributor's full scan succeeds.
- Add each contributor's missing assets with that contributor's credentials;
  perform cleanup with the first participant's credentials (album owner first).
- Validate batched add/remove results, prevent cleanup after failed additions,
  and independently read back the resulting complete album.
- Guard overlapping scheduler runs and reject incomplete/looping pagination.
- No original-media deletion endpoint is used.

Tests exercise the modified implementation, including multi-account ownership,
scan failures, partial writes, pagination, empty unions and idempotent repeats.
Build with the committed lockfile using `npm ci` and `npm run test:unit` in
`app`, or use the existing Dockerfile. This records source provenance; it does
not claim a bit-for-bit reproducible image or an offline dependency build.
