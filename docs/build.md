# Build AVR firmware

Prerequisites:

* AVR toolchain
* Usual Unix stuff (GNU make + GNU tools)
* Python 2.x on PATH

Steps:

0. Change to `firmware` folder

1. Run `make`

# Build BBC ROM

Prerequisites:

* GNU make
* [64tass](https://sourceforge.net/projects/tass64/) on the PATH
* Python 2.x on PATH

Steps:

0. Change to `rom` folder

1. Run `make`

The ROM is built to `rom/.build/beeblink.rom`.

# Build and run server

Prerequisites:

* [node.js 10.13.0 or later](https://nodejs.org/en/download/)

Linux package prerequisites:

* `apt-get install libusb-dev` ([libusb](https://libusb.info/))
* `apt-get install libudev-dev`

Steps:

0. Change to `server` folder

1. Run `npm install`

2. Run `npm start -- OPTIONS` to start the server, - where `OPTIONS`
   are the command line options for it.

# Programming the firmware

If you're doing the above as a one-off, carry on with the Installation
and setup instructions...

The Makefile has programming targets that can be used when iterating
on the firmware, basically slightly automated versions of the steps described in the [the setup docs](./setup.md).

Run `make program_minimus` to then program a Minimus board via
dfu-programmer.

Or, run `make program_leonardo` to then program a Leonardo/Pro Micro
board via avrdude.
[The Makefile tries to guess the right device name automatically](https://github.com/tom-seddon/beeblink/blob/8056fbbcebde5f509bb45bf87208eacd18f142c0/firmware/Makefile#L40),
under the assumption there's only one device at a time that's in
bootloader mode, and it's supposed to work as-is on OS X and Linux...
but it is a guess, and I've only tried it on my PCs...
