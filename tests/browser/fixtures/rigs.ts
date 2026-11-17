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
      /* Raw TS-480 meters: `SM0` carries four digits and `RM;` returns all
       * three meter readings at once.  The values sit on calibration points in
       * the backend's own tables (S9+? no: raw 11 is 0 dB, raw 4 is SWR 1.5),
       * so the decoded readings are exact rather than interpolated. */
      strengthRaw: 11,
      swrRaw: 4,
      compRaw: 0,
      alcRaw: 0,
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
          case 'SM':
            /* `SM0;` (the TS-480 S-meter); the reply echoes the prefix and
             * adds four digits, which is the shape the backend parses. */
            return command + pad(state.strengthRaw, 4);
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
        case 'RM':
          /* SWR, COMP and ALC in one reply, exactly 24 bytes including the
           * terminator the caller appends. */
          return 'RM1' + pad(state.swrRaw, 4)
            + ';RM2' + pad(state.compRaw, 4)
            + ';RM3' + pad(state.alcRaw, 4);
        case 'FR':
          return 'FR0';
        case 'FT':
          return 'FT0';
        case 'KY':
          /* Keyer buffer has room; `KY <text>` itself is a set, unanswered. */
          return 'KY0';
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
   *
   * `radioAddress` is the rig's own bus address, so one protocol serves every
   * CI-V model the fixtures need: the IC-703 answers at 0x68, the IC-746 at
   * 0x56 and the IC-746PRO at 0x66, each backend's default address.
   */
  function createIcomCiv(radioAddress: number, name: string): FakeRig {
    var PREAMBLE = [0xfe, 0xfe];
    var CONTROLLER = 0xe0; /* host */
    var RADIO = radioAddress;

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
      name: name,
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

          var to = buffer[2];
          var body = buffer.slice(4, end);
          buffer = buffer.slice(end + 1);

          if (body.length === 0) { continue; }

          /* A radio ignores frames for another bus address; 0x00 is the
           * broadcast every radio hears. */
          if (to !== RADIO && to !== 0x00) { continue; }

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
   * Yaesu FT-710: the ASCII "newcat" CAT dialect, `;` terminated.
   *
   * Every command and every reply here was recorded from the radio itself
   * (`rigctl -m 1049 -r <port> -s 38400 -vvvv`) rather than guessed: the open
   * sequence is `PS;`, `AI;`, `ID;`, `VS;`, `IF;`, `FA;` and the state reads
   * that follow are `MD0;`, `SH0;` and `TX;`.  Note the sizes - this rig's `IF`
   * reply is 27 characters, not the 37 a Kenwood sends.
   *
   * `baudRate` is set, so the emulator is silent at every other rate: the
   * FT-710 is a real UART behind a CP2105 bridge, and its CAT rate is a menu
   * setting on the radio.  That is what makes it the fixture for a wrong rate
   * (silence, not an error) and for the rate scan.
   */
  function createFt710(): FakeRig {
    var CAT_RATE = 38400;
    var MODE_LSB = 1;

    var state = {
      frequency: 7175000,
      modeDigit: MODE_LSB,
      filterValue: 0,
      transmitting: false,
      silent: false,
    };

    var commands: string[] = [];
    var buffer = '';

    /** The 27 character IF payload, exactly as the radio spells it. */
    function ifPayload(): string {
      return 'IF'
        + pad(state.frequency, 12)
        + '+'
        + '000000'
        + (state.transmitting ? '1' : '0')
        + '00000';
    }

    /**
     * The reply to `command`, terminator included, or null for a command the
     * rig answers with silence (a set command, or ``AI0;``).
     */
    function replyFor(command: string): string | null {
      switch (command) {
        case 'PS;':
          return 'PS1;';
        case 'AI;':
          return 'AI0;';
        case 'ID;':
          return 'ID0800;';
        case 'VS;':
          return 'VS0;';
        case 'IF;':
          return ifPayload() + ';';
        case 'KS;':
          return 'KS020;';
        case 'FA;':
          return 'FA' + pad(state.frequency, 9) + ';';
        case 'MD0;':
        case 'MD1;':
          return 'MD0' + String(state.modeDigit) + ';';
        case 'SH0;':
        case 'SH1;':
          return 'SH0020;';
        case 'TX;':
          return state.transmitting ? 'TX1;' : 'TX0;';
        default:
          break;
      }

      if (/^FA\d+;$/.test(command)) {
        state.frequency = Number(command.slice(2, -1));
        return null;
      }

      if (/^MD\d\d;$/.test(command)) {
        state.modeDigit = Number(command[3]);
        return null;
      }

      if (/^SH\d+;$/.test(command)) {
        state.filterValue = Number(command.slice(2, -1));
        return null;
      }

      if (command === 'TX1;') { state.transmitting = true; return null; }

      if (command === 'TX0;' || command === 'RX;') { state.transmitting = false; return null; }

      /* A command this rig does not implement, or one its current state
       * rejects, is answered with `?;`. */
      return '?;';
    }

    return {
      name: 'yaesu-ft710',
      state: state,
      baudRate: CAT_RATE,
      commands: commands,
      reset: function (): void {
        buffer = '';
      },
      feed: function (chunk: Uint8Array): Uint8Array[] {
        for (var i = 0; i < chunk.length; i++) {
          buffer += String.fromCharCode(chunk[i]!);
        }

        var replies: Uint8Array[] = [];

        /* Commands are `;` terminated and may arrive split or batched. */
        for (;;) {
          var end = buffer.indexOf(';');

          if (end < 0) { break; }

          var command = buffer.slice(0, end + 1);
          buffer = buffer.slice(end + 1);
          commands.push(command);

          var reply = replyFor(command);

          if (reply !== null) { replies.push(ascii(reply)); }
        }

        return replies;
      },
    };
  }

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

  // ------------------------------------------------------- Yaesu FRG-100

  /**
   * Yaesu FRG-100 receiver: fixed five octet binary frames.
   *
   * Its backend declares frequency only - no `get_mode`, no `get_ptt`, no
   * `set_ptt` - which is what makes it the capability-limited fixture: the
   * catalogue reports a serial model whose telemetry is one field.
   *
   * `00 00 00 00 0e` opens (the backend only writes it, so the emulator stays
   * quiet), and `00 00 00 02 10` reads the 19 octet operating data block whose
   * receive frequency is the three little-endian octets at offset 2, in tens
   * of hertz, exactly as `frg100_read_freq_from_buf()` decodes it.  Every
   * setter is write-only for this backend too.
   */
  function createFrg100(): FakeRig {
    var FRAME_LENGTH = 5;
    var READ_OP_DATA = [0x00, 0x00, 0x00, 0x02, 0x10];
    var OP_DATA_LENGTH = 19;
    var SET_FREQ = 0x0a;
    var SET_MODE = 0x0c;
    var READ_STATUS = 0xf7;

    var state = {
      frequency: 7050000,
      modeDigit: 0,
      filterValue: 0,
      transmitting: false,
      silent: false,
    };

    var commands: string[] = [];
    var buffer: number[] = [];

    /** True when `candidate` is `frame`. */
    function sameFrame(candidate: number[], frame: number[]): boolean {
      for (var i = 0; i < FRAME_LENGTH; i++) {
        if (candidate[i] !== frame[i]) { return false; }
      }

      return true;
    }

    /** One BCD byte as its decimal value (0x71 is 71). */
    function bcdByte(byte: number): number {
      return ((byte >> 4) * 10) + (byte & 0x0f);
    }

    /** The operating data block, receive frequency in octets 2..4. */
    function opData(): Uint8Array {
      var units = Math.round(state.frequency / 10);
      var block = new Uint8Array(OP_DATA_LENGTH);

      block[2] = units & 0xff;
      block[3] = (units >> 8) & 0xff;
      block[4] = (units >> 16) & 0xff;
      /* Octet 7 is the hardware mode; zero is a plausible LSB. */
      return block;
    }

    return {
      name: 'yaesu-frg100',
      state: state,
      commands: commands,
      reset: function (): void {
        buffer = [];
      },
      feed: function (chunk: Uint8Array): Uint8Array[] {
        for (var i = 0; i < chunk.length; i++) { buffer.push(chunk[i]!); }

        var replies: Uint8Array[] = [];

        while (buffer.length >= FRAME_LENGTH) {
          var frame = buffer.slice(0, FRAME_LENGTH);
          buffer = buffer.slice(FRAME_LENGTH);

          var text = '';

          for (var j = 0; j < FRAME_LENGTH; j++) {
            text += ' ' + pad(frame[j]!.toString(16).toUpperCase(), 2);
          }

          commands.push(text.trim());

          if (sameFrame(frame, READ_OP_DATA)) {
            replies.push(opData());
          } else if (frame[4] === SET_FREQ) {
            /* The backend writes the tuning step in BCD, least significant
             * byte first; the emulator applies it so a later read reports the
             * frequency that was actually set. */
            var units = bcdByte(frame[2]!) * 10000
              + bcdByte(frame[1]!) * 100
              + bcdByte(frame[0]!);

            state.frequency = units * 10;
          } else if (frame[4] === SET_MODE) {
            state.modeDigit = frame[3]!;
          } else if (frame[4] === READ_STATUS) {
            /* Meter-only status: one byte, accepted by the backend's read of
             * up to five. */
            replies.push(new Uint8Array([0x30]));
          }
        }

        return replies;
      },
    };
  }

  /** One CI-V factory per bus address. */
  function civRig(address: number, name: string): () => FakeRig {
    return function (): FakeRig { return createIcomCiv(address, name); };
  }

  window.__fakeRigRegistry = {
    'kenwood-ts480': createTs480,
    'icom-ic703': civRig(0x68, 'icom-ic703'),
    'icom-ic746': civRig(0x56, 'icom-ic746'),
    'icom-ic746pro': civRig(0x66, 'icom-ic746pro'),
    'yaesu-ft710': createFt710,
    'yaesu-ft757gx2': createFt757gx2,
    'yaesu-frg100': createFrg100,
  };
})();
