# Build AVR firmware

Prerequisites:

* AVR toolchain
* dfu-programmer
* Usual Unix stuff (GNU make + GNU tools)
* Python 2.x on PATH

0. Change to `firmware` folder

1. Run `make`

The dfu-programmer step is included in the build process.

# Build BBC ROM

Prerequisites:

* GNU make
* [64tass](https://sourceforge.net/projects/tass64/) on the PATH
* Python 2.x on PATH

0. Change to `rom` folder

1. Run `make`

The ROM is built to `rom/.build/beeblink.rom`.

# Build and run server

Prerequisites:

* [node.js](https://nodejs.org/en/download/)

0. Change to `server` folder

1. Run `npm install`

2. Run `npm start -- OPTIONS` - where `OPTIONS` are the command line
   options for it.
