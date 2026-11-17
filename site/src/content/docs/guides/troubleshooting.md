---
title: Troubleshooting
description: A rig that does not answer, a busy port, Linux permissions, and how to report a problem.
---

## The rig does not answer

`open()` checks that the rig answered and rejects with `HAMLIB_ERROR` when it
did not. In order of likelihood:

- **Baud rate.** A rig behind a real UART answers only at the rate set in its
  own menu. Pass that rate as `baudRate`, or search the declared range with
  `detectBaudRate()`; `RIG_UNRESPONSIVE` means no rate answered. See
  [Baud rate](../rig-api/#baud-rate).
- **The rig is off**, or its CAT interface is disabled in the menu.
- **The wrong port.** A radio can enumerate more than one serial interface;
  grant or pass the one that carries CAT.

## The port is busy or access is denied

A serial port has one owner. When WSJT-X, flrig, `rigctld` or another program
holds it, `open()` rejects with `HAMLIB_ERROR` (an I/O error or access denied).
Close the other program and open again.

## Linux permissions

Serial devices belong to the `dialout` group (`uucp` on Arch). Add your user
and log in again:

```sh
sudo usermod -aG dialout "$USER"
```

The browser runs as your user and needs the same access to the device node;
if udev gives the device another group or mode, add a udev rule for it.

## Firefox

Web Serial needs Firefox 151 or later and a secure context: HTTPS or
`localhost`. See [Where it runs](../../getting-started/#where-it-runs).

## Icom: a non-default CI-V address

An Icom rig whose CI-V address was changed from the factory default stays
silent at the default. Pass the address as a Hamlib config token:

```ts
const rig = await hamlib.open({ modelId, port, conf: { civaddr: '0x94' } });
```

## PTT over RTS or DTR

An interface that keys the transmitter with a serial control line, not a CAT
command, needs Hamlib's PTT type:

```ts
const rig = await hamlib.open({ modelId, port, conf: { ptt_type: 'RTS' } });
```

## A call hangs: `RIG_TIMEOUT`, then `RIG_HUNG`

Every call runs under a watchdog, `callTimeoutMs` (30 s by default, an option
of `createHamlib()`). A call that overruns cannot be cancelled: it rejects with
`RIG_TIMEOUT`, and every later call on the instance with `RIG_HUNG`. Call
`dispose()`, which still closes the port, and create a new instance.

## Reporting a problem

Turn on Hamlib's debug output and reproduce the problem:

```ts
const hamlib = await createHamlib({ debug: { level: 'trace' } });
```

Then open a rig report on GitHub and paste the diagnostics: the
"Copy diagnostics" button in the [live demo](../../demo/), or
`JSON.stringify(hamlib.diagnostics(), null, 2)` from your app. A rig that
misbehaves the same way with native Hamlib (`rigctl`) is an upstream bug; report
it to [Hamlib](https://github.com/Hamlib/Hamlib/issues).
