---
title: Supported rigs
description: Which models work, what "verified" means, and the known limitations.
---

Hamlib reports several hundred serial models, and every one of them is in the
catalogue (`hamlib.models`). Being in the catalogue only says the backend goes
through Hamlib's common serial port layer, so each `RigModel` also says how far
it is supported:

| Field | Meaning |
| --- | --- |
| `support` | `"verified"` when a browser test in this package drives the model through an emulated serial port; otherwise `"candidate"` |
| `limitation` | Set when this build cannot drive the model, with the reason |
| `serialRateMin`, `serialRateMax` | The baud range the backend declares |
| `serialDataBits`, `serialStopBits`, `serialParity`, `serialHandshake` | The line settings the backend declares |

`VERIFIED_MODELS` lists the verified models with the tests that cover them, and
`UNUSABLE_MODELS` the models that cannot work in this build and why.

:::caution
"Verified" means covered by an emulator-backed test in this repository - the
Kenwood TS-480, the Icom IC-703 over CI-V and the Yaesu FT-710 over newcat. It never means tested
against hardware. Every other model is a candidate: worth trying, not promised.
:::

## Line settings

Both transports accept the same line settings: 7 or 8 data bits, 1 or 2 stop
bits, none/even/odd parity, and no flow control or hardware handshake. A model
that declares anything else fails with `-RIG_ECONF` before the port is opened,
so a user never ends up on a silently downgraded port. Its `limitation` field
says so up front, and the [live demo](../../demo/) shows it when you pick the
model.

## Baud rate

No field can carry the rate the radio itself is set to: a backend declares a
range, and the radio's menu picks the value inside it. A "verified" model can
still be opened at the wrong rate, which produces silence rather than an error.
`open()` therefore checks that the rig answered and rejects with the rate it
tried; `detectBaudRate()` searches the declared range. See
[Baud rate](../rig-api/#baud-rate).

## Other limitations

- **Serial only.** Network (`rigctld`, TCP) and USB-HID rigs are not reachable
  over a serial transport.
- **One call at a time per module.** The module is single-threaded; calls
  serialize on one queue. Several rigs can share a module, but their calls
  take turns.
- **No cancellation of a stuck call.** A call that overruns `callTimeoutMs`
  leaves the module unusable (`RIG_HUNG`); dispose it and create a new one.
- **Browser support.** Web Serial exists only in desktop Chromium-based
  browsers and Firefox 151+, in a secure context; see
  [Where it runs](../../getting-started/#where-it-runs).
