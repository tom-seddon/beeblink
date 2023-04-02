# BeebLink

A file storage system for the BBC Micro. Make your PC do something
useful for a change: have it act as a file server for your BBC.

No more swapping discs, no more noisy drives, no more 31 file limit,
file access is very fast, and it's super-easy to share BBC files with
your PC.

If you've got multiple BBCs, they can all connect at once and share
files.

["Action" screen grabs](./docs/screens.md)

# Installing the server

## Windows

Get the latest release from
https://github.com/tom-seddon/beeblink/releases/latest. Download the
Windows zip and unzip it somewhere.

## macOS

Get the latest release from
https://github.com/tom-seddon/beeblink/releases/latest. Download the
macOS zip and unzip it somewhere.

The macOS version is not notarized. To bypass any Gatekeeper dialogs:
open Terminal, change to the folder to which you unzipped the server,
and run the following command:

    xattr -dr com.apple.quarantine beeblink-server bindings.node prebuilds/darwin-x64+arm64/node.napi.node

## Linux

Follow [the build instructions](#building-it-yourself) to build the
server.

You can build the ROM yourself, or get a prebuilt copy from the
Windows or macOS release:
https://github.com/tom-seddon/beeblink/releases/latest (you can use
either; they are equivalent, though not currently bit-identical)

# Setting up the Beeb

You'll need a BBC B/B+/Master 128, ideally with some kind of EEPROM
module or battery-backed write-protectable sideways RAM - it's no fun
having to reload the ROM each time you power on, or have it zapped by
careless programs!

You can connect BBC and PC using a Tube USB serial adapter or a UPURS
cable.

## Tube USB serial adapter

See https://stardot.org.uk/forums/viewtopic.php?f=8&t=14849. You'll
need the full kit with the PLD.

Connect the Tube serial board to the BBC's Tube connector, connect any
second processor to the Tube serial board, use the jumper to select
Comms mode, and connect the device to your PC.

If using Windows, you'll need to
[tweak one of the device settings](./docs/ftdi_latency_timer.md).

If using macOS, you're good to go straight away!

If you've got some way of getting files to your BBC already, copy
`beeblink_tube_serial.rom` from the ROMs zip and load it on your BBC;
otherwise, use the [bootstrap process](./docs/bootstrap.md), and get
the file that way.

## UPURS cable

See https://www.retro-kit.co.uk/UPURS/. You'll also need a FTDI FT232
USB serial adapter. Connect UPURS cable to BBC's user port connector
and USB serial adapter, connect USB serial adapter to PC.

If using Windows, you'll need to
[tweak one of the device settings](./docs/ftdi_latency_timer.md).

If using macOS 10.15 Catalina, you'll need to install
[the FTDI virtual COM port driver](https://www.ftdichip.com/Drivers/VCP.htm).
[**UPURS BeebLink does not currently work on macOS 11 Big Sur**](https://github.com/tom-seddon/beeblink/issues/79) -
apologies.

There's no bootstrap process for the UPURS cable. Use the UPURS tools
to get `beeblink_upurs_fe60.rom` copied onto your BBC.

[There are some notes about using BeebLink with the UPURS cable](./docs/upurs.md).

# Use

See [the filing system docs](./docs/fs.md) for some info about how to
use it from the BBC side.

[The server docs](./docs/server.md) have some information about useful
command line options, and a few notes about sharing files between BBC
and PC.

[If you use git, some notes on git interop](./docs/git.md).

[Some notes about using BeebLink with the UPURS cable](./docs/upurs.md).

# Building it yourself

This repo has submodules. Clone it with `--recursive`:

	git clone --recursive https://github.com/tom-seddon/beeblink/

Or, after cloning, use `git submodule` from inside the working copy to
set the submodules up:

	git submodule init
	git submodule update
	
`master` is the branch used to build the latest release, so it should
be good. `wip/tom` is for whatever I'm working on currently, and will
probably work pretty well. Other branches are undocumented and
probably only temporary.

After switching branch, you'll need to do a `git submodule update`.

[How to build the server](./docs/build-server.md).

[How to build the ROM](./docs/build-rom.md).

# Problems?

Please
[file a GitHub issue](https://github.com/tom-seddon/beeblink/issues)
or
[post in the StarDot BeebLink thread](https://stardot.org.uk/forums/viewtopic.php?f=53&t=15605)
if you run into any difficulties!

# Licence

Copyright (C) 2018-2023 by Tom Seddon

Licence: GPL v3

-----

[![Build status](https://ci.appveyor.com/api/projects/status/ubldrfvsg04smo50/branch/master?svg=true)](https://ci.appveyor.com/project/tom-seddon/beeblink/branch/master)

[![Pre-release build status](https://ci.appveyor.com/api/projects/status/ubldrfvsg04smo50/branch/wip/tom?svg=true)](https://ci.appveyor.com/project/tom-seddon/beeblink/branch/wip/tom)
