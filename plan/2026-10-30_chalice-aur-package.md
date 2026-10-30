# Chalice AUR package

## Context
Chalice publishes `@leolastforce/chalice` with a `chalice` CLI and requires Node.js 22.19 or newer. This machine has `makepkg`; the npm package includes native dependencies and built-in extension assets that need validation on Arch.

## Approach
1. Check AUR name availability and Arch packaging guidance; choose an unambiguous name such as `chalice-coding-agent`. Inspect the published npm tarball, its dependency lock, licenses, and supported native architectures. Determine a reproducible, checksum-verified dependency acquisition strategy before selecting npm-release or source-based packaging.
2. Add an AUR recipe in a dedicated repository directory (for example, `packaging/aur/PKGBUILD`) and generate its `.SRCINFO`. Declare build/runtime dependencies, pin the release sources and checksums, install under the package staging directory, and avoid modifying the host during the build. Document release update and AUR publishing steps in a separate packaging document, without editing the README.
3. Build on Arch with `makepkg` and, where feasible, a clean chroot; run `namcap` if available. Inspect package contents and test installation, `chalice --version` or equivalent, built-in extension loading from another working directory, native dependencies, and removal. Ask before installing a package or changing the host. Run `npm run check` if application code changes.
4. Explain how to create the AUR repository, push the recipe and `.SRCINFO`, and update both on each release. Do not publish or change user accounts without explicit approval.

## Open decisions
Confirm the package name is available and identify which architectures and dependency acquisition method can actually be supported by the chosen release artifacts. Existing unrelated changes to `package.json` and `package-lock.json` must remain untouched.
