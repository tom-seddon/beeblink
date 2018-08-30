# BeebLink filing system

The BeebLink filing system, or BLFS, stores files on your PC and lets
you access them from your BBC using a DFS-style interface. Compared to
your average DFS however it is much faster and has far fewer
limitations.

# Try it out

## Run server on PC

Unzip the server zip file somewhere on your PC. There are various
options, but for starters run it like this from the command line:

OS X/Linux: `./beeblink_server --mount beeblink ./volumes`

Windows: `beeblink_server --mount beeblink ./volumes`

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

To do this, look in the server's folder and find the `volumes` folder.

Create a new folder there called `newvol` (the folder name on the PC
is how you'll refer to it from the BBC), and create a folder inside it
called `0` (this is where the files for drive 0 will go).

Then on the BBC type `*VOLS` to see the list of available volumes.

    >*VOLS
	Matching volumes: beeblink newvol
	>
	
Use `*VOL` to load `newvol`.

    >*VOL newvol
	Volume: newvol
	Path: /Users/tom/beeb/beeblink/volumes/newvol
	>

Creating a new folder in the right place like thisis enough to create
a volume. The server will automatically create folders for any
additional drives on demand.

(You can have the server find volumes from multiple folders. See the
list of [server command line options](./server.md).)

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

The name seen on the BBC will be exactly the name it has on the PC.

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

# Command reference

## Commands available with any filing system

### `BLCONFIG`

Change ROM options. See below.

### `BLFS`

Activate BLFS.

### `BLSELFUPDATE`

Attempt to update the ROM, if it's loaded into sideways RAM or a
write-protected ABR cartridge. The server must have been started with
the `--rom` option.

This is mainly for my benefit when working on the ROM code.

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

### `ACCESS <afsp> (<mode>)`

Lock or unlock file(s). `<mode>` can be blank to unlock, or `L` to
lock.

### `DIR (<dir>)`

Change directory and/or drive.

### `DRIVE (<drive>)`

Change drive.

### `FILES`

Show the list of currently open files.

### `LIB (<dir>)`

Change library drive and directory.

### `RENAME <old fsp> <new fsp>`

Rename file.

### `TITLE <title>`

Set drive's title.

### `VOL (<avsp>)`

With no argument, prints the name and path of the current volume.

With argument, change to that volume. Wildcards are acceptable - the
first matching volume found will be selected.

### `VOLS (<avsp>)`

Show a list of available volumes. Use wildcards to narrow the list
down.

### `DUMP <fsp>`, `LIST <fsp>`, `TYPE <fsp>`, `WDUMP <fsp>`

As per the standard DFS UTILS commands, along with the new `WDUMP`,
which produces `*DUMP`-style output but in 80 columns.

Note that unlike the UTILS commands in the DFS, these only operate
when the BLFS is active; and on the Master, the built-in MOS `DUMP`,
`LIST` and `TYPE` will always be used.

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

# `BLCONFIG` options

To switch an option on, use `*BLCONFIG X+`, where `X` is that option's
code (see below). Use `-` to switch it off. You can specify multiple
options on the command line.

The current ROM options are as follows.

## `V` - debug verbosity

I find it best to leave this switched off.

## `*` - trap *DISC

Some programs do `*DISC` in their loader or `!BOOT`, which is no good
if you're trying to run from the BLFS.

If you don't have a DFS installed, or your DFS is installed in a
lower-priority ROM, there should be no problem. The BLFS ROM responds
to `*DISC` by activating itself.

If you have a DFS installed in a higher-priority ROM slot, normally
the DFS will get the `*DISC`. Use the trap *DISC option in this case
to have the BLFS ROM sneak in and grab `*DISC` instead.

When this option is active, the BLFS is always watching, even in other
filing systems. This can make it a bit hard to select the actual DFS.

(All the above applies to `*DISK` as well.)

## `D` - act as DFS

With act as DFS active, the BLFS will report itself to be filing
system 4 (DFS) when called upon to identify itself via
[OSARGS A=0 Y=0](http://beebwiki.mdfs.net/OSARGS#Functions.2C_handle.3D0).

On a Master 128 it will also install temporary filing system entries
for `DISC` and `DISK` (which will just be ignored if the DFS is also
present).

# Non-standard errors

Most of the errors you'll see when using the BLFS will be the usual
BBC ones, but there are a couple of non-standard ones too.

## `Exists on server` (same code as `Exists`)

Occurs when trying to create a BBC file with the same name as one on
the server, that the BBC can't see because it has no corresponding
`.inf` file.

There's not much you can do about this at the BBC end. You'll need to
move the offending file out of the folder on the server. (Well, that
or pick a different name...)

## `POSIX error: XXX` (same code as `Disc fault`)

The server encountered an unexpected error while doing something.
`XXX` is the POSIX error codes.

## `Too big` (same code as `Disc full`)

The file is too large, or the requested operation would make it too
large. There's a (fairly arbitrary) size limit of 16MBytes.
