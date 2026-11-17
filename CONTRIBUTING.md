<!-- SPDX-License-Identifier: MIT -->

# Contributing

## Setup and checks

Everything runs through the toolchain pinned in `mise.toml`:

```sh
mise install && mise run bootstrap   # toolchain, locked npm deps, Playwright browsers, commit hook
mise run check                       # the local gate: lint, types, generated files, unit + browser tests
mise tasks                           # every other task, with its description
```

The first build downloads the pinned Hamlib release, verifies its SHA-256,
applies the patches `hamlib.config.yaml` lists and compiles it with Emscripten;
later builds reuse `.cache`. CI runs `mise run check-release`, which adds the
packed-tarball audit and the backend audit to `check`; a pull request should
pass it.

The site's link-preview image, `site/public/social.png`, is a capture of the
landing hero; run `mise run social-image` after a change to what the hero shows.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
with the scopes `.commitlintrc.json` allows; semantic-release derives the
version from them, and the hook `bootstrap` installs checks them. A change to
the pinned Hamlib release must publish: see
[the release-block rule](RELEASING.md#the-release-block-rule).

## Testing on a real rig

The hardware suite in `tests/hardware` is opt-in and read-only by default. A
new rig is a new profile in `tests/hardware/devices.ts`, never a change to the
tests: its catalogue manufacturer and model, the USB ids `listPorts()` reports,
the rate set in the rig's menu (omit it to let `detectBaudRate()` search), a
frequency for the write test and, optionally, a mode in which PTT alone keys a
carrier.

```sh
HAMLIB_WASM_HARDWARE_DEVICE=qmx mise run test-hardware
HAMLIB_WASM_HARDWARE_DEVICE=ft-710 HAMLIB_WASM_HARDWARE_WRITE=1 HAMLIB_WASM_HARDWARE_TRANSMIT=dummy-load mise run test-hardware
```

`HAMLIB_WASM_HARDWARE_PORT=<path>` is needed when the profile has no `usb`
block. `HAMLIB_WASM_HARDWARE_WRITE=1` adds the frequency round-trip.
`HAMLIB_WASM_HARDWARE_TRANSMIT=dummy-load` adds a one-second PTT test at low
power: set it only with a dummy load connected.

## Reporting rig problems

Open a rig report and paste the diagnostics: the "Copy diagnostics" button in
the live demo, or `JSON.stringify(hamlib.diagnostics(), null, 2)` from your app.
Bugs in a Hamlib backend or protocol belong
[upstream](https://github.com/Hamlib/Hamlib/issues).
