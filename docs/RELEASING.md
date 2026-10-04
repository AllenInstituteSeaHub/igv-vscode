# Releasing igv-vscode

Audience: the maintainer and any coding agent helping with a release.

## Versioning

- Semantic versioning. Before 1.0: bump the **minor** for new features (`0.2.0`), the **patch** for fixes (`0.1.1`).
- The version lives in one place, `package.json` → `"version"`. `package-lock.json` carries it too (`npm version <new> --no-git-tag-version` updates both).
- Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` and move the `[Unreleased]` entries under it.
- Record anything notable in `PROGRESS.md` (what shipped, test results) and design choices in `docs/DECISIONS.md`.

## Pre-flight

```sh
npm ci
npm run check                 # typecheck + lint + unit
npm run test:contract         # Playwright, pins igv.js behaviour
npm run test:integration      # launches VS Code (needs network + fixtures)
```

CI runs the same plus the code-server end-to-end on every push; `main` must be green before a release.

## Build the package

```sh
npm run package               # -> igv-vscode-<version>.vsix (16 files, ~620 KB, no vsce warnings expected)
```

Sanity check: `code --install-extension igv-vscode-<version>.vsix`, reload, open a fixture BAM, run `igv-vscode ping` in a new terminal.

## Publish

### VS Marketplace (desktop VS Code)

Publisher: `alleninstituteseahub` (owned by will.hannon@alleninstitute.org). Extension id: `alleninstituteseahub.igv-vscode`.

Manual (current method): sign in at <https://marketplace.visualstudio.com/manage>, pick the publisher, then **New extension → Visual Studio Code** for the first release or **⋯ → Update** on the listing for later ones, and upload the `.vsix`. The listing is generated from `package.json`, `README.md` and `media/icon.png`; relative image links in the README are rewritten to the GitHub repo by `vsce`.

Automated (once a token exists): a Personal Access Token from Azure DevOps with scope **Marketplace: Manage**, all accessible organizations, stored as the repository secret `VSCE_PAT`. Creating the token requires membership in an Azure DevOps organization (blocked by IT policy as of 2026-10-04; request pending).

### Open VSX (code-server, CodeOcean, VSCodium)

Namespace: `alleninstituteseahub` (to be created). Sign in at <https://open-vsx.org> with GitHub, create the namespace, sign the publisher agreement, generate an access token.

```sh
npx ovsx publish igv-vscode-<version>.vsix -p <token>
```

or store the token as the repository secret `OVSX_PAT` for the automated job.

### GitHub Release

Tagging builds the `.vsix` and drafts a release with notes:

```sh
git tag v<version> && git push origin v<version>
```

`.github/workflows/release.yml` refuses to run if `publisher` is still a placeholder. After the GitHub Release, its `publish` job publishes to each marketplace whose secret is set and skips the others with a message, so it never fails for lack of a token. The job can also be started by hand (Actions → Release → Run workflow → publish = true).

## Checklist

1. `main` green on CI.
2. `npm version <new> --no-git-tag-version`; update `CHANGELOG.md`, `PROGRESS.md`.
3. Commit and push; wait for CI.
4. `npm run package`; install locally and smoke-test.
5. `git tag v<new> && git push origin v<new>`: builds the VSIX, drafts the GitHub Release, publishes to Open VSX (`OVSX_PAT` is set) and to the VS Marketplace once `VSCE_PAT` exists.
6. Until `VSCE_PAT` exists, upload the same `.vsix` to the VS Marketplace by hand.
7. Verify the Marketplace listing renders the README and icon.

## Secrets and safety

- No publishing credentials are stored in the repository or on the development machine. Tokens, when they exist, go into GitHub repository secrets only.
- `~/.igv-vscode/instances/*.json` holds the extension's own control-channel token: random per VS Code window, mode 0600, valid only for talking to that window on that machine. It is not a publishing credential and must never be committed or pasted.
- The `.vsix` contains only `dist/`, `media/`, `agent/SKILL.md`, README, CHANGELOG, LICENSE and `package.json` (see `.vscodeignore`).
