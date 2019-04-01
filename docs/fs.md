# BeebLink filing system

The BeebLink filing system, or BLFS, stores files on your PC and lets
you access them from your BBC using a DFS-style interface. Compared to
your average DFS however it is much faster and has far fewer
limitations.

# Try it out

## Run server on PC

Unzip the server zip file somewhere on your PC. There are various
options, but for starters run it like this from the command line:

OS X/Linux: `./beeblink_server --default-volume beeblink ./volumes`

Windows: `beeblink_server --default-volume beeblink ./volumes`

After a moment you should get a `Server running...` message.

## Load ROM on BBC

If you've got some way of getting files onto your BBC already, copy
the ROM across and load it into sideways RAM or EEPROM or what have
you.

Otherwise, you can use the [bootstrap process](./bootstrap.md).

## Whirlwind tour

With the server running and the ROM installed, press CTRL+B+BREAK.
Assuming it's all working, you should get the usual message, and a
BeebLink banner.

    Acorn MOS
	
	BeebLink - OK
	
	BASIC
	
	>

The suggested command line for the server will make some files
accessible. Do a `*.` to see them.

    >*.
    Volume: beeblink
    Drive 0 (3 - EXEC)  Dir :0.$  Lib :0.$
    
        !BOOT               BOOTSTRAP
        BOOTSTRAP2          FS-TEST
        HELLO               ROMS
	
    >

Try Shift+BREAK, or `CH."ROMS"`.

It's supposed to feel fairly familiar.

## Creating and changing volumes

The BLFS stores files in volumes, which are groups of drives, each
drive containing files. The server comes with a default volume (the
`beeblink` one shown above), but you can easily create more.

Create new volumes from the BBC using the `*NEWVOL` command.

    >*NEWVOL newvol
	Created: /Users/tom/beeb/beeblink/volumes/newvol
	>
	
The new volume is automatically loaded, so you can start using it
straight away.

You can also create volumes on the server. Look in the server's
folder, and find the `volumes` folder. Create a new folder there
called `newvol2` (the folder name on the PC is how you'll refer to it
from the BBC), and create a folder inside it called `0` (this is where
the files for drive 0 will go, and it's how the server distingushes a
volume from just an ordinary folder).

On the BBC, type `*VOLS` to see the list of available volumes. The new
volume will be included.

    >*VOLS
	Matching volumes: beeblink newvol newvol2
	>
	
Use `*VOL` to load `newvol2`.

    >*VOL newvol2
	Volume: newvol2
	Path: /Users/tom/beeb/beeblink/volumes/newvol2
	>

Creating a new folder in the right place like this is enough to create
a volume. The server will automatically create folders for any
additional drives on demand.

Volume names may only contain non-space printable ASCII characters
(i.e., >=33 and <=126). `*NEWVOL` will produce an error if invalid
characters are used; or, if you create a volume on the server with an
invalid name, it will just be ignored.

(You can have the server find volumes from multiple folders. See the
list of [server command line options](./server.md).)

## Naming volumes

By default, a volume is named after the folder that contains it.

Add a file called `.volume` to the volume folder to give it some other
name. The first line of this file should be the name to use.

If the `.volume` name is invalid, the volume will be ignored, just as
if the volume's folder name were itself invalid.

## Using existing BBC files with BLFS

Files are stored on the PC in the standard .inf format. Copy such
files into a drive's folder to make them visible to BLFS.

There are tools available for extracting files from DFS disc images:
https://www.stairwaytohell.com/essentials/index.html?page=homepage

## Creating BBC files on the server

You can create BBC files on the server, e.g., when using your PC to
develop BBC software. Create the file with a DFS-like file name: a
directory character, a `.`, then the name. Then create a 0-byte file
with the same name, and a `.inf` extension.

For example: `$.!BOOT` and `$.!BOOT.inf`.

The following rules apply to files with a 0-byte .inf file:

* the name seen on the BBC will be exactly the name it has on the PC
* load and execution addresses wil both be &FFFFFFFF (see `Won't`
  below)
* the file will be unlocked
* if the directory name is `!`, it is treated as a PC-style text file:
  when opened for random access, double-/single-byte newlines will be
  converted to ASCII 13, and an ASCII 13 will be added to the end if
  necessary. This affects data read from `OSBGET`/`OSGBPB`, and the
  value of `EXT#`. `OSFILE` access is unaffected.

  (This is a hack to make it easy to use PC-style text files with
  `*EXEC`, e.g., after downloading from the web, or saving copied and
  pasted data, and it is no cleverer than necessary! Correct results
  in general are far from guaranteed, and there is deliberately no
  other way to have a file interpreted this way. This may improve over
  time)

The .inf file will be updated automatically if any of its properties
change. This will affect the interpretation of files in the `!`
directory.

## Accessing BBC files on the server

The server does its best to name the PC file after the BBC file when
creating a file, so it should be easy to find. A simple escaping
syntax (`#xx`, where `xx` is the ASCII value) is used for BBC
characters that aren't valid in PC names.

The corresponding .inf file contains BBC name, load address, execution
address, and lock flag. (In principle, the BBC name can be unrelated
to the PC name, but the server tries not to do this itself.)

While a file is open on the BBC, it is buffered in RAM. Changes won't
be seen on disk until the file is closed or flushed with OSARGS A=&FF.

## Quitting the server

Press Ctrl+C.

The error checking for a broken connection is not so great, so if you
do this (or reset the AVR) then the BBC will just hang up on the next
filing system operation.

CTRL+BREAK should sort it out. The startup message will say something
like `BeebLink - no AVR`.

## Running from sideways RAM

If you're running the filing system from writeable sideways RAM, the
banner will read `BeebLink <SWR>`. There's no problem doing this, but
the ROM is intended for use from EEPROM or write-protected sideways
RAM, so it doesn't have to be reloaded each time.

The message is mainly there for my benefit, in case I switch off the
write protection and then forget...

## Accessing other volumes

A volume is roughly analogous to a disc, so by default file names
refer to files in drives on the current volume.

You can use the new `::` syntax to access other volumes.

To get a catalogue of another volume, use `::VOLUME:DRIVE`:

    *.::OTHERVOLUME:0
	
To access a file on another volume, use `::VOLUME:DRIVE:DIR.FILE`:

    CH."::65BOOT:0.$.STARTUP"

With this syntax, the drive and directory are mandatory (the current
drive and directory only apply to the current volume). You may use
wildcards in the volume name, but it's an error if it matches more
than one volume.

This syntax is not supported as widely as maybe it should be. (For
example, you can't change volume using `*DRIVE`.) But apart from that,
files on other volumes are treated the same as files on the current
volume. Aside from the inconvenient, verbose names there should be
nothing particular to bear in mind when accessing them.

## Wildcard OSFILE names for `LOAD`, `*LOAD`, etc.

OSFILE A=255 supports wildcard names, when the wildcards only match
one file. This can save typing when using BASIC's `LOAD` or the
`*LOAD` command.

An `Ambiguous name` error will be given if multiple files match.

Wildcards are not supported for other OSFILE commands; this is
designed to be purely for convenience when using `LOAD`/`*LOAD`.

# Command reference

## Commands available in any filing system

### `BLCONFIG`

Change ROM options. See below.

### `BLFS`

Activate BLFS.

### `BLSELFUPDATE`

**If you answer `Y` to the prompt, it will overwrite I/O processor
memory from &3000 onwards!**

Attempt to update the ROM, if it's loaded into sideways RAM. If it
looks like it might be loaded into a write-protected ABR cartridge, it
will attempt to unlock the ABR and lock it again afterwards.

The server must be able to find the ROM file - see
[the bootstrap process](./bootstrap.md).

This is mainly for my benefit when working on the ROM code.

### `BLVERSION`

Shows BeebLink ROM version, Git commit and build date/time.

The BeebLink ROM version has a `*` suffix if the ROM was built with a
modified working copy rather than the exact contents of that commit.

### `BUILD <fsp>`

Create a text file line by line. Designed for creating `!BOOT`, but
not much else...

### `DISC`, `DISK`

Activate BLFS.

These commands handle the case where there is no DFS installed, for
compatibility with (the large amount of) software that does a `*DISC`
at some point.

(If you have a DFS installed, you can still have BLFS handle `*DISC`,
if you prefer. See the `BLCONFIG options` section.)

## Commands available with BLFS selected ##

If another ROM is stealing a command, you can also access it by
spelling it out in full with a `BLFS_` prefix, e.g., `*BLFS_FILES`.

It's usual for BBC DFSs to make `*DUMP`, `*TYPE*` and `*LIST`
available in all filing systems, but the BLFS versions of these
commands are handled on the server, and so are only available when the
BLFS is selected.

(Commands marked *B/B+* only get used on model B or B+ - on the
Master, the built-in OS command of the same name is used instead. This
isn't supposed to make a meaningful difference, but it's possible the
output could be slightly different.)

### `ACCESS <afsp> (<mode>)`

Lock or unlock file(s). `<mode>` can be blank to unlock, or `L` to
lock.

### `DELETE <fsp>` (*B/B+*)

Delete a file.

### `DIR (<dir>)`

Change directory and/or drive on the current volume.

### `DRIVE (<drive>)`

Change drive on the current volume.

### `DRIVES`

Shows the list of drives in the current volume.

### `DUMP <fsp>` (*B/B+*)

Produce hex dump of file.

### `FILES`

Show the list of currently open files.

### `*INFO <afsp>` (*B/B+*)

Show metadata of the file(s) specified - lock status, load address,
execution address and size.

### `LIB (<dir>)`

Change library drive and directory on the current volume.

### `LIST <fsp>` (*B/B+*)

Show contents of text file, with lines numbered.

### `LOCATE <afsp>`

Print names of any file(s) in any volumes matching `<afsp>`. (`<afsp>`
may not contain volume or drive specifiers.)

### `NEWVOL <vsp>`

Create a new volume.

### `RENAME <old fsp> <new fsp>`

Rename file.

### `SPEEDTEST`

Performs a benchmark.

### `TITLE <title>`

Set current drive's title.

### `TYPE <fsp>` (*B/B+*) ###

Show contents of text file.

### `VOL (<avsp>)`

With no argument, prints the name and path of the current volume.

With argument, change to that volume. Wildcards are acceptable, as are
names that match more than one volume - the first matching volume
found will be selected.

### `VOLS (<avsp>)`

Show a list of available volumes. Use wildcards to narrow the list
down.

### `VOLBROWSER`

Activate the volume browser: an interactive method of loading a
volume.

The list of available volumes is shown. Use the cursor keys to
navigate. Press ESCAPE to cancel, RETURN to load that volume, or
SHIFT+RETURN to load that volume and attempt to auto-boot it.

Press SPACE to display the volume's path on the server. (If you try
hard enough, you can have multiple volumes with the same name. This
lets you figure out which is which. The one you have selected will be
the one loaded.)

You can filter the list by just typing stuff in. Press ESCAPE to
cancel, or RETURN to narrow the list down to the discs whose names
contain the string you entered. When looking at a filtered list, press
ESCAPE to remove the filters.

(You can enter multiple filter strings, narrowing the existing list
down each time.)

The volume browser isn't recommended in 20-column modes.

### `WDUMP <fsp>`

Produce wide hex dump of file, for use in 80 column modes.

### `WRITE <fsp> <drive> <type> ###

**Overwrites I/O processor memory from OSHWM onwards!**

Write a DFS/ADFS disk image to a formatted disk.

`<drive>` is the drive to write to.

`<type>` is the type of image:

* `S`: .ssd
* `D`: .dsd, track order
* `A`: ADFS S/M/L (ADFS L images must be track order) (image size must
  match the disk to be written to)

# `BLCONFIG` options

To switch an option on, use `*BLCONFIG X+`, where `X` is that option's
code (see below). Use `-` to switch it off. You can specify multiple
options on the command line.

If any options are active, their codes will be displayed in the ROM
startup banner.

The current ROM options are as follows.

## `V` - debug verbosity

I find it best to leave this switched off.

## `*` - trap *DISC

Some programs do `*DISC` in their loader or `!BOOT`, which is no good
if you're trying to run from the BLFS.

If you don't have a DFS installed, or your DFS is installed in a
lower-priority ROM, there should be no problem. The BLFS ROM responds
to `*DISC` by activating itself. (You can configure this using the
`ignore *DISC` option mentioned below.)

If you have a DFS installed in a higher-priority ROM slot, normally
the DFS will get the `*DISC`. Use the trap *DISC option in this case
to have the BLFS ROM sneak in and grab `*DISC` instead.

When this option is active, the BLFS is always watching, even in other
filing systems. This can make it a bit hard to select the actual DFS.

(All the above applies to `*DISK` as well.)

## `I` - ignore *DISC

If set, the ROM will ignore `*DISC`/`*DISK`. Use this when the BLFS is
in a higher-priority ROM slot and you want to be able to select DFS
too.

The trap *DISC option takes priority.

## `D` - act as DFS

With act as DFS active, the BLFS will report itself to be filing
system 4 (DFS) when called upon to identify itself via
[OSARGS A=0 Y=0](http://beebwiki.mdfs.net/OSARGS#Functions.2C_handle.3D0).

On a Master 128 it will also install temporary filing system entries
for `DISC` and `DISK` (which will just be ignored if the DFS is also
present).

# Non-standard errors

Most of the errors you'll see when using the BLFS will be the usual
DFS ones, but there are some non-standard ones too.

## `Ambiguous name` (same code as `Bad name`)

A wildcard name was used to load a file, and it matches multiple
files. To fix this, be more precise - e.g., by supplying the full
name.

## `Ambiguous volume` (same code as `Bad name`)

The volume name supplied when using the `::` syntax is ambiguous.
Supply the same name to the `*VOLS` command to see which volumes it
matches.

## `Exists on server` (same code as `Exists`)

Occurs when trying to create a BBC file with the same name as one on
the server, that the BBC can't see because it has no corresponding
`.inf` file.

There's not much you can do about this at the BBC end. You'll need to
move the offending file out of the folder on the server. (Well, that
or pick a different name...)

## `No volume` (same code as `Disc fault`)

The default volume was not found, so there is no volume currently
loaded. Use `*VOL` to load one.

## `POSIX error: XXX` (same code as `Disc fault`)

The server encountered an unexpected error while doing something.
`XXX` is one of the
[POSIX error codes](http://pubs.opengroup.org/onlinepubs/000095399/basedefs/errno.h.html).

## `Too big` (same code as `Disc full`)

The file is too large, or the requested operation would make it too
large. There's a (fairly arbitrary) size limit of 16MBytes.

## `Volume not found` (same code as `File not found`)

The name supplied to `*VOL` didn't match any volumes.

## `Won't` (&93) (as seen on ADFS)

The file has a load address of &FFFFFFFF, and no explicit load address
was provided; for `*RUN` this may also mean the file's execution
address is &FFFFFFFF.

(This usually means the file has a 0-byte .inf file, but these
addresses can also be assigned manually.)

