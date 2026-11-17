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
later builds reuse `.cache`. `mise run check` is what CI runs; a pull request
should pass it.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/);
semantic-release derives the version from them, and the hook `bootstrap`
installs checks them. Scopes are limited to `hamlib`, `api`, `build`, `deps`,
`docs`, `ci`, `tests` and `release`.

A change to the `release:` block of `packages/hamlib-wasm/hamlib.config.yaml`
pins a different Hamlib release, so it must be `feat` or `fix` (with `!` when it
breaks consumers); `mise run release-guard` checks this. See
[`RELEASING.md`](RELEASING.md).

## Testing on a real rig

The hardware suite in `tests/hardware` is opt-in and read-only by default. A
new rig is a new profile in `tests/hardware/devices.ts`, never a change to the
tests: its catalogue manufacturer and model, the USB ids `listPorts()` reports,
the rate set in the rig's menu (omit it to let `detectBaudRate()` search) and a
frequency for the write test.

```sh
HAMLIB_WASM_HARDWARE_DEVICE=qmx mise run test-hardware
HAMLIB_WASM_HARDWARE_DEVICE=ft-710 HAMLIB_WASM_HARDWARE_PORT=/dev/ttyUSB0 mise run test-hardware
```

`HAMLIB_WASM_HARDWARE_PORT` is needed when the profile has no `usb` block, and
`HAMLIB_WASM_HARDWARE_WRITE=1` adds the frequency round-trip.

## Reporting rig problems

Open a rig report and paste the diagnostics: the "Copy diagnostics" button in
the live demo, or `JSON.stringify(hamlib.diagnostics(), null, 2)` from your app.
Bugs in a Hamlib backend or protocol belong
[upstream](https://github.com/Hamlib/Hamlib/issues).
