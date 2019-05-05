# BeebLink

A file storage system for the BBC Micro. Make your PC do something
useful for a change: have it act as a file server for your BBC. No
more swapping discs, no more noisy drives, no more 31 file limit. Got
multiple BBCs? No problem. The PC will serve to all of them at once.

["Action" screen grabs](./docs/screens.md)

I use this as the default filing system for my BBC Master and my BBC
B, and will be improving it over time...

# Requirements

* [Tube 6502decode FTDI232H board](https://stardot.org.uk/forums/viewtopic.php?f=3&t=14398) -
  see https://stardot.org.uk/forums/viewtopic.php?f=8&t=14849 (you'll
  need the CPLD installed and the jumper set for comms mode)
* PC running OS X, Windows or Linux
* BBC B/B+/Master 128 with some good way of loading the ROM image
  (i.e., with something like EEPROM or write-protected battery-backed
  sideways RAM... it's no fun having to reload it on each boot and/or
  having it zapped by careless programs)

# Getting the files

Pre-built files are available from
[the BeebLink releases page](https://github.com/tom-seddon/beeblink/releases).

Download the latest ROMs ZIP to get the ROM for use with your BBC.

If using OS X or Windows, download the latest server ZIP for your OS.

If using Linux, follow
[the Building it yourself instructions below](#building-it-yourself)
to get set up with a version of the server - there are no binary
server releases for Linux.

## Tube serial setup

Connect Tube serial board to BBC's Tube connector, use the jumper to
select Comms mode, and connect the device to your PC.

If using Windows,
[you'll want to tweak the device settings](./docs/ftdi_latency_timer.md).

If using a B/B+, ensure the device is powered before switching the BBC
on. 

## BBC setup

If you've got some way of getting files onto your BBC already, copy
`beeblink_tube_serial.rom` from the ROMs zip to your BBC, and load
it into sideways RAM or EEPROM or what have you.

Otherwise, you can use the [bootstrap process](./docs/bootstrap.md).

# Using BeebLink

The [filing system docs](./docs/fs.md) give some notes about running
the server and using the filing system.

[Useful server command line options](./docs/server.md).

[If you use git, some notes on git interop](./docs/git.md).

# Building it yourself

**This repo has submodules** - if you're going to build it, clone it
with `git clone --recursive`, or do `git submodule init && git
submodule update` from the working copy after a normal clone.

[Building instructions](./docs/build.md)
