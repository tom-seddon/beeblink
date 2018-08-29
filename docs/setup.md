# Setup

# Prerequisites

* AVR toolchain
* DFU programming tool
* GNU Make (comes with Xcode)
* [64tass](https://sourceforge.net/projects/tass64/) (I found this
  built from source out of the box)
* [node.js](https://nodejs.org/en/download/)

For MacPorts, you can get the AVR toolchain with `sudo port install
avr-libc` and the DFU programmer with `sudo port install
dfu-programmer`.

# Set up AVR

## Program AVR ##

0. Connect AVR to PC via USB

1. Ready AVR for programming: hold RESET, hold HWB, release RESET,
   release HWB. There may be no obvious indication that this has done
   anything, but the programming tool will complain if the AVR is in
   the wrong state, so you'll know to retry
   
2. Change to `firmware` in the working copy and run `make`. This
   compiles the code and programs the device. You should get a bunch
   of output, and no obvious errors, and a message at the end along
   the lines of `7022 bytes used (24.49%)`
   
3. Tap RESET on the AVR. The red and blue LEDs should both light up

## Connect AVR to BBC ##

Connect AVR to BBC's user port as follows:

| User Port | AVR |
| --- | --- |
| GND | GND | 
| PB0 | PB0 |
| PB1 | PB1 |
| PB2 | PB2 |
| PB3 | PB3 |
| PB4 | PB4 |
| PB5 | PB5 |
| PB6 | PB6 |
| PB7 | PB7 |
| CB1 | PC6 |
| CB2 | PC7 |

## Connect AVR to PC's serial port (optional) ##

If you've got a serial port that can accept +5V, you can connect the
AVR's PC4 to its Receive Data pin to see its debug serial output.

The serial output is 115200 baud, no parity, 1 stop bit.

# Build ROM

Change to `rom` in the working copy and run `make`. You should get
some output and no obvious errors.

The ROM is built to `rom/.build/beeblink.rom` in the working copy. If
you've got some way of getting files over to your BBC already, easiest
to copy it over using that - but if not, you can sort it out in a
moment.

# Set up server

Change to `server` in the working copy and run `npm install`. You
should get some output and no obvious errors.

