# BeebLink

A file storage system for the BBC Micro. Make your PC do something
useful for a change: have it act as a file server for your BBC.

No more swapping discs, no more noisy drives, no more 31 file limit,
file access is very fast, and it's super-easy to share BBC files with
your PC.

If you've got multiple BBCs, they can all connect at once.

["Action" screen grabs](./docs/screens.md)

I use this as the default filing system for my BBC Master and my BBC
B, and will be improving it over time...

# Setting up

Pre-built files are available from
[the BeebLink releases page](https://github.com/tom-seddon/beeblink/releases).
GitHub should highlight the latest release that has files attached -
use that one!

You'll need a PC running Windows, OS X or Linux. If using Windows or
OS X, download the ROMs zip and the appropriate server zip; if using
Linux, download the ROMs zip, and follow
[the building instructions](./docs/build-server.md).

You'll need a BBC B/B+/Master 128, ideally with some kind of EEPROM
module or battery-backed write-protectable sideways RAM - it's no fun
having to reload the ROM each time you power on, or have it zapped by
careless programs!

You'll need a Tube USB serial adapter and FT232H module - see
https://stardot.org.uk/forums/viewtopic.php?f=8&t=14849. (You'll need
the full kit with the PLD.)

Connect the Tube serial board to the BBC's Tube connector, connect any
second processor to the Tube serial board, use the jumper to select
Comms mode, and connect the device to your PC. If using Windows,
you'll need to
[tweak one of the device settings](./docs/ftdi_latency_timer.md).

If you've got some way of getting files to your BBC already, copy
`beeblink_tube_serial.rom` from the ROMs zip and load it on your BBC;
otherwise, use the [bootstrap process](./docs/bootstrap.md), and get
the file that way.

# Use

See [the filing system docs](./docs/fs.md) for some info about how to
use it from the BBC side.

[The server docs](./docs/server.md) have some information about useful
command line options, and a few notes about sharing files between BBC
and PC.

[If you use git, some notes on git interop](./docs/git.md).

# Building it yourself

[How to build the server](./docs/build-server.md).

[How to build the ROM](./docs/build-rom.md).
