/**
 * Emulated rigs for the Web Serial double.
 *
 * Each entry in `window.__fakeRigRegistry` is a factory that returns:
 *
 *   name      the protocol name, for diagnostics
 *   state     emulated state, always carrying `frequency`, `modeDigit`,
 *             `filterValue`, `transmitting` and `silent`
 *   commands  every request the emulator decoded, as readable text
 *   feed(bytes)  consume a chunk of host bytes and return reply chunks
 *   reset()   forget the partial frame, keeping the state
 *
 * `silent` is honoured by the transport, not here: commands are still decoded
 * and recorded while the emulator is silent, which is what the timeout tests
 * assert against.
 *
 * This file is compiled to `generated/rigs.js` by the neighbouring
 * tsconfig.json and injected into the page as *text* (see
 * tests/browser/fixtures.ts).  The emitted script is a standalone script that
 * runs in the page's global scope, so it never imports anything.
 */

(function installFakeRigs() {
  var ACK = 0xfb;
  var NAK = 0xfa;

  /** The ASCII octets of `text`. */
  function ascii(text: string): Uint8Array {
    var bytes = new Uint8Array(text.length);

    for (var i = 0; i < text.length; i++) { bytes[i] = text.charCodeAt(i); }

    return bytes;
  }

  /**
   * `value`, left-padded with zeroes to `width`.  The BCD and hex helpers hand
   * it an already-spelled digit pair, so it takes text as well as numbers.
   */
  function pad(value: number | string, width: number): string {
    var text = String(value);

    while (text.length < width) { text = '0' + text; }

    return text;
  }

  // ---------------------------------------------------------------- Kenwood

  /**
   * Kenwood TS-480: ASCII CAT commands terminated by ';'.
   *
   * Set commands are not answered; the backend verifies them with the
   * following `ID;` transaction, so replying would corrupt the protocol.
   */
  function createTs480(): FakeRig {
    var TERMINATOR = ';';
    var MODE_USB = 2;

    var state = {
      frequency: 14074000,
      modeDigit: MODE_USB,
      filterValue: 0,
      transmitting: false,
      silent: false,
    };

    var commands: string[] = [];
    var buffer = '';

    /** The 37 character IF status payload, terminator excluded. */
    function ifPayload(): string {
      var status = '000000000'
        + (state.transmitting ? '1' : '0')
        + String(state.modeDigit)
        + '00'
        + '0'
        + '000';

      return 'IF'
        + pad(state.frequency, 11)
        + '     '
        + '+'
        + status
        + ' ';
    }

    /** The reply to `command`, without its terminator, or null for none. */
    function replyFor(command: string): string | null {
      var prefix = command.slice(0, 2);
      var argument = command.slice(2);

      if (argument.length > 0) {
        switch (prefix) {
          case 'FA':
            state.frequency = Number(argument);
            return null;
          case 'MD':
            state.modeDigit = Number(argument);
            return null;
          case 'FW':
            state.filterValue = Number(argument);
            return null;
          case 'TX':
            state.transmitting = true;
            return null;
          default:
            return null;
        }
      }

      switch (command) {
        case 'TX':
          state.transmitting = true;
          return null;
        case 'RX':
          state.transmitting = false;
          return null;
        case 'ID':
          return 'ID020'; /* TS-480 id digits */
        case 'PS':
          return 'PS1';
        case 'AI':
          return 'AI0';
        case 'FA':
        case 'FB':
          return command + pad(state.frequency, 11);
        case 'MD':
          return 'MD' + String(state.modeDigit);
        case 'FW':
          return 'FW' + pad(state.filterValue, 4);
        case 'IF':
          return ifPayload();
        case 'FR':
          return 'FR0';
        case 'FT':
          return 'FT0';
        default:
          return '?';
      }
    }

    return {
      name: 'kenwood-ts480',
      state: state,
      commands: commands,
      reset: function (): void {
        buffer = '';
      },
      feed: function (chunk: Uint8Array): Uint8Array[] {
        var replies: Uint8Array[] = [];

        for (var i = 0; i < chunk.length; i++) {
          buffer += String.fromCharCode(chunk[i]!);
        }

        for (;;) {
          var end = buffer.indexOf(TERMINATOR);

          if (end < 0) { break; }

          var command = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);

          if (command.length === 0) { continue; }

          commands.push(command);

          var reply = replyFor(command);

          if (reply !== null) { replies.push(ascii(reply + TERMINATOR)); }
        }

        return replies;
      },
    };
  }

  // ------------------------------------------------------------------- Icom

  /**
   * Icom CI-V: binary frames `FE FE <to> <from> <command> [data] FD`, with the
   * radio answering from its own address and acknowledging writes with 0xFB.
   *
   * The frequency is five little-endian BCD octets, least significant pair
   * first, which is the CI-V convention the backend decodes.
   */
  function createIc703(): FakeRig {
    var PREAMBLE = [0xfe, 0xfe];
    var CONTROLLER = 0xe0; /* host */
    var RADIO = 0x68; /* IC-703 */

    var C_READ_FREQ = 0x03;
    var C_READ_MODE = 0x04;
    var C_SET_FREQ = 0x05;
    var C_SET_MODE = 0x06;
    var C_SELECT_VFO = 0x07;
    var C_PTT = 0x1c;

    var MODE_USB = 0x01;

    var state = {
      frequency: 14074000,
      modeDigit: MODE_USB,
      filterValue: 0,
      transmitting: false,
      silent: false,
    };

    var commands: string[] = [];
    var buffer: number[] = [];

    /** The five little-endian BCD octets of `hz`. */
    function encodeFrequency(hz: number): number[] {
      var text = pad(hz, 10);
      var out: number[] = [];

      for (var i = 9; i > 0; i -= 2) {
        /* Each octet carries two BCD digits: the pair is already the hex
         * spelling, because every character is a decimal digit. */
        out.push(parseInt(text.slice(i - 1, i + 1), 16));
      }

      return out;
    }

    /** A frame from the radio to the host. */
    function radio(payload: number[]): Uint8Array {
      return new Uint8Array(PREAMBLE.concat([RADIO, CONTROLLER], payload, [0xfd]));
    }

    function acknowledge(): Uint8Array {
      return radio([ACK]);
    }

    /** The replies to a command `body`, the command and its data. */
    function commandFor(body: number[]): Uint8Array[] {
      var command = body[0];
      var data = body.slice(1);

      switch (command) {
        case C_READ_FREQ:
          return [radio([C_READ_FREQ].concat(encodeFrequency(state.frequency)))];

        case C_SET_FREQ:
          if (data.length !== 5) { return [radio([NAK])]; }

          state.frequency = decodeFrequency(data);
          return [acknowledge()];

        case C_READ_MODE:
          return [radio([C_READ_MODE, state.modeDigit, state.filterValue])];

        case C_SET_MODE:
          if (data.length < 2) { return [radio([NAK])]; }

          state.modeDigit = data[0]!;
          state.filterValue = data[1]!;
          return [acknowledge()];

        case C_SELECT_VFO:
          return [acknowledge()];

        case C_PTT:
          /* `1C 00` reads the transmit state; `1C 00 01` sets it. */
          if (data.length <= 1) {
            return [radio([C_PTT, 0x00, state.transmitting ? 0x01 : 0x00])];
          }

          state.transmitting = data[1]! !== 0;
          return [acknowledge()];

        default:
          /* An unhandled command is refused the way a real radio refuses it,
           * so the backend reports the failure instead of timing out. */
          return [radio([NAK])];
      }
    }

    return {
      name: 'icom-ic703',
      state: state,
      commands: commands,
      reset: function (): void {
        buffer = [];
      },
      feed: function (chunk: Uint8Array): Uint8Array[] {
        for (var i = 0; i < chunk.length; i++) { buffer.push(chunk[i]!); }

        var replies: Uint8Array[] = [];

        for (;;) {
          /* Drop anything before the preamble. */
          while (buffer.length > 0 && !(buffer[0] === 0xfe && buffer[1] === 0xfe)) {
            buffer.shift();
          }

          if (buffer.length < 2) { break; }

          var end = buffer.indexOf(0xfd, 2);

          if (end < 0) { break; }

          var body = buffer.slice(4, end);
          buffer = buffer.slice(end + 1);

          if (body.length === 0) { continue; }

          commands.push(describe(body));

          var produced = commandFor(body);

          for (var j = 0; j < produced.length; j++) { replies.push(produced[j]!); }
        }

        return replies;
      },
    };

    /** The command and its data, as readable text. */
    function describe(body: number[]): string {
      var text = pad(body[0]!.toString(16).toUpperCase(), 2);
      var rest = '';

      for (var i = 1; i < body.length; i++) {
        rest += ' ' + pad(body[i]!.toString(16).toUpperCase(), 2);
      }

      return text + rest;
    }

    /** The frequency spelled by five little-endian BCD octets. */
    function decodeFrequency(data: number[]): number {
      var text = '';

      for (var i = data.length - 1; i >= 0; i--) {
        text += String(data[i]! >> 4) + String(data[i]! & 0x0f);
      }

      return Number(text);
    }
  }

  // ------------------------------------------------------------------ Yaesu

  /**
   * Yaesu FT-757GXII: fixed five octet binary frames, no terminator.
   *
   * Open reads the 75 octet status block; everything else in this test only
   * needs the CAT port for push-to-talk, which the backend drives with the DTR
   * line rather than with a frame.
   */
  function createFt757gx2(): FakeRig {
    var STATUS_COMMAND = [0x00, 0x00, 0x00, 0x00, 0x10];
    var STATUS_LENGTH = 75;
    var FRAME_LENGTH = 5;

    var state = {
      frequency: 14074000,
      modeDigit: 0,
      filterValue: 0,
      transmitting: false,
      silent: false,
    };

    var commands: string[] = [];
    var buffer: number[] = [];

    /** True when the buffered frame is `frame`. */
    function sameFrame(frame: number[]): boolean {
      for (var i = 0; i < FRAME_LENGTH; i++) {
        if (buffer[i] !== frame[i]) { return false; }
      }

      return true;
    }

    return {
      name: 'yaesu-ft757gx2',
      state: state,
      commands: commands,
      reset: function (): void {
        buffer = [];
      },
      feed: function (chunk: Uint8Array): Uint8Array[] {
        for (var i = 0; i < chunk.length; i++) { buffer.push(chunk[i]!); }

        var replies: Uint8Array[] = [];

        while (buffer.length >= FRAME_LENGTH) {
          var text = '';

          for (var j = 0; j < FRAME_LENGTH; j++) {
            text += ' ' + pad(buffer[j]!.toString(16).toUpperCase(), 2);
          }

          commands.push(text.trim());

          if (sameFrame(STATUS_COMMAND)) {
            var block = new Uint8Array(STATUS_LENGTH);

            /* A little of the status block, so a read of the frequency looks
             * like a plausible radio rather than a blank one. */
            block[0] = 0x00;
            replies.push(block);
          }

          buffer = buffer.slice(FRAME_LENGTH);
        }

        return replies;
      },
    };
  }

  window.__fakeRigRegistry = {
    'kenwood-ts480': createTs480,
    'icom-ic703': createIc703,
    'yaesu-ft757gx2': createFt757gx2,
  };
})();
