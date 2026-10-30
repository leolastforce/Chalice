# Chalice AUR package

This recipe packages the published npm release for x86_64. It has not yet been published to the AUR.

## Build and test

Install `base-devel`, `nodejs` (22.19 or newer), and `npm`, then run:

```sh
cd packaging/aur
makepkg --cleanbuild
sudo pacman -U ./chalice-1.0.7-1-x86_64.pkg.tar.zst
chalice --version
```

The package archive compression extension may differ with local makepkg settings. Test the installed CLI from outside this repository. To uninstall it, run `sudo pacman -R chalice`. Avoid using `chalice update self` for an AUR installation; update through pacman or an AUR helper instead.

The release tarball is SHA-256 verified and includes npm's shrinkwrap. npm fetches dependencies during packaging, so the build needs network access. Most locked dependencies have integrity hashes, but the 1.0.7 shrinkwrap lacks hashes for six internal packages; this build is therefore not fully integrity-pinned or reproducible. npm lifecycle scripts are disabled. Only x86_64 has been tested; do not add architectures without testing their native modules.

## Publish

Create an AUR account and add an SSH public key. Confirm that `chalice` is still available, then clone its AUR repository and copy `PKGBUILD`, `.SRCINFO`, and `LICENSE` into it. Replace the maintainer comment in `PKGBUILD` with your AUR maintainer identity. Run `makepkg --printsrcinfo > .SRCINFO`, build and test, then commit those three files and push to the AUR repository. `PUBLISHING.md` is for the Chalice repository and need not be uploaded.

```sh
git clone ssh://aur@aur.archlinux.org/chalice.git
# Copy PKGBUILD, .SRCINFO and LICENSE into the clone; edit the maintainer comment.
cd chalice
makepkg --printsrcinfo > .SRCINFO
git add PKGBUILD .SRCINFO LICENSE
git commit -m 'Initial package'
git push
```

## Update a release

Update `pkgver`, reset `pkgrel` to 1, download the matching npm tarball and update its SHA-256 checksum. Review the release's shrinkwrap, lifecycle script requirements, license and native dependencies. If the license changes, update the local `LICENSE` and its checksum too. Regenerate `.SRCINFO`, build and test, then commit and push the AUR files. Increment `pkgrel` for packaging-only changes to the same version.
