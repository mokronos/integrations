# Releasing

The six public packages are one coordinated release. Their versions must
match the `vX.Y.Z` Git tag, and the release workflow publishes them in dependency
order before verifying a clean registry install of `i` and `ii`.

The npm organization must configure this repository's
`.github/workflows/release.yml` as a trusted publisher for every public package.
The workflow uses GitHub's short-lived OIDC identity and npm provenance; no
long-lived npm token belongs in repository secrets.

To release:

1. Update every public package to the same version and commit it.
   Update `gatewayVersion` in `apps/integrations/gateway/src/version.ts` too;
   release CI rejects drift.
2. Run `bun run verify` locally and wait for CI on `main`.
3. Push an annotated `vX.Y.Z` tag.
4. Watch the protected `npm` GitHub environment approve and publish the graph.

If a publish is interrupted, do not reuse a published version. Bump all public
packages together and issue a new tag so the supported package set remains
unambiguous.
