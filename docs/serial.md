# Debug serial output

The AVR firmware can produce debug serial output, viewable with any
serial terminal software.

You'll need a serial port that can accept +5V - which seems to be
common for most modern USB serial dongles. Connect the ground pin to
the AVR ground, and the RX pin to the AVR as described in
[the setup notes](./setup.md).

Run the server with `--avr-verbose` to enable serial output on all
attached AVRs. This introduces some overhead, so performance may well
be affected.

The serial output is 115200 baud, no parity, 1 stop bit.
