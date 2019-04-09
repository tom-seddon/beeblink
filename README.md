# BeebLink

A file storage system for the BBC Micro. Make your PC do something
useful for a change: have it act as a file server for your BBC. No
more swapping discs, no more noisy drives, no more 31 file limit.

["Action" screen grabs](./docs/screens.md)

I use this as the default filing system for my BBC Master and my BBC
B, and will be improving it over time...

# Requirements

* [Tube 6502decode FTDI232H board](https://stardot.org.uk/forums/viewtopic.php?f=3&t=14398) -
  see https://stardot.org.uk/forums/viewtopic.php?f=8&t=14849 (you'll
  need the CPLD so it can operate in serial mode)
  
  **Recommended - this is beta functionality, so there may be minor
  issues, but it's super easy to set up**

  OR

  5V-tolerant AVR-based microcontroller board (used to connect BBC's
  user port and PC's USB port). Supported types so far are the Minimus
  AVR 32K and the SparkFun Pro Micro/Arduino Leonardo
  
* PC running OS X, Windows or Linux
* BBC Micro(s) with some good way of loading the ROM image (i.e., with
  something like EEPROM or write-protected battery-backed sideways
  RAM... it's no fun having to reload it on each boot and/or have it
  zapped by careless programs)

# Installation and setup

If using OS X or 64-bit Windows, download latest release from
[the BeebLink releases page](https://github.com/tom-seddon/beeblink/releases) -
you'll need the firmware ZIP, and a server ZIP for your OS.

(If using Linux or 32-bit Windows, follow the DIY instructions below
to build firmware and get set up with a version of the server you can
run. There are no binary releases for these platforms.)

## Tube serial setup

Connect Tube serial board to BBC's Tube connector and connect the
device to your PC.

If using a B/B+, ensure the device is powered before switching the BBC
on. 

## AVR setup

Follow [the AVR setup instructions](./docs/setup.md) to set up the
AVR. (You can optionally get [debug serial output](./docs/serial.md) from
the AVR.)

If using Linux, you'll need to
[set up udev rules for the BeebLink device](./docs/udev.md).

# Using BeebLink

The [filing system docs](./docs/fs.md) give some notes about running
the server and using the filing system.

[Useful server command line options](./docs/server.md).

[Got multiple BBCs? No problem](./docs/multi.md). 

[If you use git, some notes on git interop](./docs/git.md).

# Building it yourself

**This repo has submodules** - if you're going to build it, clone it
with `git clone --recursive`, or do `git submodule init && git
submodule update` from the working copy after a normal clone.

[Building instructions](./docs/build.md)
