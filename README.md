# BeebLink

A file storage system for the BBC Micro and Acorn Electron. Make your
PC do something useful for a change: have it act as a file server for
your BBC.

No more swapping discs, no more noisy drives, no more file count
limits, and file access is very fast. You get very quick turnaround
when developing BBC software using your PC, and it's super-easy to get
access to you BBC files. Also: very easy backups!

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

(If upgrading: you're advised to run the same version of ROM and
server, but if both server and ROM are from a 2024 (or later) release
then they don't have to match exactly. But not every combination will
have been tested!)

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

If you've got some way of getting files to your BBC already, copy
[the appropriate ROM image](./docs/tube_serial_roms.md) from the zip
and load it on your BBC; otherwise, use the
[bootstrap process](./docs/bootstrap.md), and get the file that way.

## UPURS cable

See https://www.retro-kit.co.uk/UPURS/. You'll also need a FTDI FT232
USB serial adapter. Connect UPURS cable to BBC's user port connector
and USB serial adapter, connect USB serial adapter to PC.

If using Windows, you'll need to
[tweak one of the device settings](./docs/ftdi_latency_timer.md).

If using macOS, [UPURS is currently
unsupported](https://github.com/tom-seddon/beeblink/issues/79), but
reports are welcome.

If using Linux, there should be nothing to do!

There's no bootstrap process for the UPURS cable. Use the UPURS tools
to get `beeblink_upurs_fe60.rom` copied onto your BBC.

[There are some notes about using BeebLink with the UPURS cable](./docs/upurs.md).

# Setting up the Electron

**DIY required**

You'll need an Electron with Plus 1 (or equivalent - I'm uing an Acorn
Plus 1) and Advanced Plus 5 (or equivalent - I'm using the Retro
Hardware New AP5).

You'll need a Tube USB serial adapter (see above). The PLD needs to be
updated to V3 or later, as per the instructions here:
[./devices/tube_serial](./devices/tube_serial)

Once set up, connect the Tube serial board to the AP5's Tube
connector, use the jumper to select Comms mode, and connect the device
to your PC.

If using Windows, you'll need to
[tweak one of the device settings](./docs/ftdi_latency_timer.md).

There's not currently a bootstrap process for the Electron. I used my
Master to get [the appropriate ROM image](./docs/tube_serial_roms.md)
onto a cartridge, then plugged the cartridge into the Electron.

# Use

See [the filing system docs](./docs/fs.md) for some info about how to
use it.

[The server docs](./docs/server.md) have some additional information
about useful command line options, and a few notes about sharing files
between BBC and PC.

If you also use [TubeHost](https://github.com/sweharris/TubeHost), you
can [access your TubeHost files via BeebLink](./docs/tubehost.md).

There is experimental support for [ADFS-like hierarchical
volumes](./docs/adfs.md) - a bit of DIY required. **ADFS-like volumes
are experimental!**

[If you use git, some notes on git interop](./docs/git.md).

# Building it yourself

This repo has submodules. Clone it with `--recursive`:

	git clone --recursive https://github.com/tom-seddon/beeblink/

Or, after cloning, use `git submodule` from inside the working copy to
set the submodules up:

	git submodule init
	git submodule update

(Note that you'll also need to do a `git submodule update` after
switching branch.)

Build the `master` branch to get the latest release, or `wip/master`
to get the latest prerelease. Both should work well, though the
prerelease will have had less testing.

[How to build the server](./docs/build-server.md).

[How to build the ROM](./docs/build-rom.md).

# Problems?

Please
[file a GitHub issue](https://github.com/tom-seddon/beeblink/issues)
or
[post in the StarDot BeebLink thread](https://stardot.org.uk/forums/viewtopic.php?f=53&t=15605)
if you run into any difficulties!

# Credits

Copyright (C) 2018-2024 by Tom Seddon

Many thanks are due to [Chris
Morley](https://www.stardot.org.uk/forums/memberlist.php?mode=viewprofile&u=10711)
for the development of the Tube Serial board, and for providing some
excellent suggestions and comments.

# Licence

Licence: GPL v3

-----

[Build status: ![status](https://ci.appveyor.com/api/projects/status/ubldrfvsg04smo50/branch/master?svg=true)](https://ci.appveyor.com/project/tom-seddon/beeblink/branch/master)

[Pre-release build status: ![status](https://ci.appveyor.com/api/projects/status/ubldrfvsg04smo50/branch/wip/tom?svg=true)](https://ci.appveyor.com/project/tom-seddon/beeblink/branch/wip/tom)
