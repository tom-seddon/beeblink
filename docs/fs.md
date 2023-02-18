# Using the BeebLink FS

## Run server on PC

Unzip the server zip file somewhere on your PC.

If using the Tube serial device, run it just like this from the
command line; if using a UPURS cable, see
[the UPURS notes](./upurs.md) for advice about additional command line
parameters you may need to supply.

OS X: `./beeblink_server --default-volume beeblink ./volumes`

Windows: `beeblink_server --default-volume beeblink ./volumes`

However you run it, after a moment you should get a message along the
lines of `/dev/tty.usbserial-FT33WLVU: serving.`, indicating that the
server is ready.

## Checking that it works

With the server ready and the ROM installed, press CTRL+B+BREAK on the
BBC. Assuming it's all working, you should get the usual message, and
a BeebLink banner.

    Acorn MOS
	
	BeebLink (Tube Serial) - OK
	
	BASIC
	
	>

The suggested command line for the server will make the BeebLink tools
volume accessible. Do a `*.` to get a catalagoue. (Exact output may
differ.)

    >*.
    Volume: beeblink
    Drive 0 (3 - EXEC)  Dir :0.$  Lib :0.$
    
        !BOOT               BOOTSTRAP
        BOOTSTRAP2          FS-TEST
        HELLO               ROMS
	
    >

Do a SHIFT+BREAK to launch the tools menu.
[For more about the tools, see the tools documentation](./tools.md).

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
a volume. 

Volume names may only contain non-space printable ASCII characters
(i.e., >=33 and <=126). `*NEWVOL` will produce an error if invalid
characters are used; or, if you create a volume on the server with an
invalid name, it will just be ignored.

(You can have the server find volumes from multiple folders. See the
list of [server command line options](./server.md).)

## Drives

Like a DFS disk, each volume is divided into drives. Disks have 2
sides... but there's no such restriction with BLFS, where every volume
can have up to 36 drives. There are 10 numbered drives, named `0`-`9`
inclusive, and 26 additional alphabetic drives, named `A`-`Z`
inclusive.

(Alphabetic drive names are case-insensitive. Drives `A` and `a` are
equivalent, for example.)

Drives are created on demand as files are saved to them.

## Naming volumes

By default, a volume is named after the folder that contains it.

Add a file called `.volume` to the volume folder to give it some other
name. The first line of this file should be the name to use.

If the `.volume` name is invalid, the volume will be ignored, just as
if the volume's folder name were itself invalid.

A volume doesn't have to have a unique name, but if you have multiple
volumes with the same name there's no way to control which one `*VOL`
will select.

## Quitting the server

Press Ctrl+C.

The error checking for a broken connection is not so great, so if you
do this then the BBC will just hang up on the next filing system
operation.

CTRL+BREAK should sort it out. The startup message will say something
like `BeebLink (Tube Serial) - Sync timed out`.

## Running from sideways RAM

If you're running the filing system from writeable sideways RAM, the
banner will read `BeebLink <SWR>`. There's no problem doing this, but
the ROM is intended for use from EEPROM, or battery-backed
write-protected sideways RAM, so it doesn't have to be reloaded each
time and won't get overwritten by careless programs.

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

## Wildcard names

Unlike the DFS, wildcard names are supported in most cases where a
file is going to be read: `OSFILE` (`LOAD`, `*LOAD`, etc.), `OSFILE`
when opening for read (`OPENIN`), and various OS/FS commands (`*DUMP`,
`*TYPE`, etc.).

This doesn't do anything clever, and is intended purely to save typing
on the command line. The wildcard name must match exactly one file,
and an `Ambiguous name` error will be given if multiple files match.
(If no names match, the behaviour is the same as if a non-wildcard
name was given: `File not found` for `*LOAD`, a result of 0 from
`OPENIN`, etc.)

Wildcards are not permitted when saving, deleting or renaming files.

# Command reference

## Commands available in any filing system

### `BLCONFIG`

Change ROM options. See below.

### `BLFS`

Activate BLFS.

### `BLVERSION`

Shows BeebLink ROM version, Git commit and build date/time.

The BeebLink ROM version has a `*` suffix if the ROM was built with a
modified working copy rather than the exact contents of that commit.

### `BUILD <fsp>` (*B/B+*)

Create a text file line by line. Designed for creating `!BOOT`, but
not much else - there's a limit of 64 bytes per line.

### `DISC`, `DISK`

Activate BLFS.

These commands handle the case where there is no DFS installed, for
compatibility with software that does a `*DISC` at some point.

(If you have a DFS installed, you can still have BLFS handle `*DISC`,
if you prefer. See the `BLCONFIG options` section.)

## Commands available with BLFS selected ##

If another ROM is stealing a command, you can also access it by
spelling it out in full with a `BLFS_` prefix, e.g., `*BLFS_FILES`.

It's usual for BBC DFSs to make `*DUMP`, `*TYPE*` and `*LIST`
available in all filing systems, but the BLFS versions of these
commands are handled on the server, and so are only available when the
BLFS is selected.

(Commands marked *B* or *B/B+* only get used on the models mentioned -
on other models, the built-in command of the same name is used
instead. This isn't supposed to make a meaningful difference, but it's
possible the behaviour won't be identical.)

### `ACCESS <afsp> (<mode>)`

Lock or unlock file(s). `<mode>` can be blank to unlock, or `L` to
lock.

### `DEFAULTS ([SF])`

Manage filing system defaults for use after a hard reset (CTRL+BREAK
or power on).

By default, after a hard reset, the dir is `:0.$` and the library is
`:0.$`. Use `*DEFAULTS` to set the current dir/library as the defaults
instead - this can save a bit of time when doing something that
requires pressing CTRL+BREAK a lot.

Use `*DEFAULTS` or `*DEFAULTS S` - `S` for "set" - to save the
current values.

Use `*DEFAULTS R` - `R` for "reset" - to reset the saved defaults to
the default defaults.

This command never affects the current settings - it just selects the
values to be used after the next hard reset.

The defaults are reset when changing volume.

The `*HSTATUS` output shows the current defaults.

### `DELETE <fsp>` (*B/B+*)

Delete a file.

### `DIR (<dir>)`

Change directory and/or drive on the current volume.

### `DRIVE (<drive>)`

Change drive on the current volume.

### `DUMP <fsp>` (*B/B+*)

Produce hex dump of file.

### `HSTATUS ([HFD]+)`

Show current status: general info (current volume, current defaults),
currently open files, and currently available drives.

Supply codes on the command line to restrict the output: `H` to show
the status, `F` to show open files, and `D` to show drives.

### `INFO <afsp>` (*B/B+*)

Show metadata of the file(s) specified - lock status, load address,
execution address and size.

### `LIB (<dir>)`

Change library drive and directory on the current volume.

### `LIST <fsp>` (*B/B+*)

Show contents of text file, with lines numbered.

### `LOCATE <afsp> (<format>)`

Print info for any file(s) in any volumes matching `<afsp>`. (`<afsp>`
may not contain volume or drive specifiers.)

`<format>`, if specified, is a list of codes indicating what info to
print out for each file: (codes are not case-sensitive)

* `N` - file name, fully qualified
* `A` - attributes
* `L` - load address
* `E` - exec address
* `S` - file size
* `H` - SHA1 hash
* `C` - server creation time
* `M` - server modification time

If not specified, the format is `N` - just the name.

SHA1 hashes are a bit wide for the Beeb's screen; only enough digits
are printed to disambiguate files in the set found.

The lines are sorted textually before being printed, so you can use
the format to put the attributes of interest first. For example, `HN`
might be useful if you're looking at potentially duplicated files.

### `NEWVOL <vsp>`

Create a new volume.

### `RENAME <old fsp> <new fsp>`

Rename file.

### `SRLOAD <fsp> <addr> <bank> (Q)` (*B*)

Load ROM image into a sideways RAM bank.

The operation will only write to addresses between &8000 and &BFFF,
and will fail if it would have to write outside that range. It will
also refuse to overwrite the bank containing the BLFS.

The `Q` parameter is included for compatibility with the B+/Master
syntax, and is ignored. The operation never uses main memory.

### `TITLE <title>`

Set current drive's title.

### `TYPE <fsp>` (*B/B+*) ###

Show contents of text file.

### `VOL (<avsp>) (R)`

With no argument, prints the name and path of the current volume.

With argument, change to that volume. Wildcards are acceptable, as are
names that match more than one volume - the first matching volume
found will be selected.

Specify `R` to mount the volume read-only.

### `VOLS (<avsp>)`

Show a list of available volumes. Use wildcards to narrow the list
down.

### `VOLBROWSER`

Activate the volume browser: an interactive method of loading a
volume.

The list of available volumes is shown. Use the cursor keys to
navigate. Press ESCAPE to cancel, RETURN to load that volume, or
SHIFT+RETURN to load that volume and attempt to auto-boot it.

Press SPACE to display the volume's path on the server. (If you have
multiple volumes with the same name, this lets you figure out which is
which. The specific volume selected will be the one loaded.)

You can filter the list by just typing stuff in. Press ESCAPE to
cancel, or RETURN to narrow the list down to the discs whose names
contain the string you entered. When looking at a filtered list, press
ESCAPE to remove the filters.

(You can enter multiple filter strings, narrowing the existing list
down each time.)

The volume browser isn't recommended in 20-column modes.

### `WDUMP <fsp>`

Produce wide hex dump of file, for use in 80 column modes.

### `WINFO <afsp>`

Produce wide *INFO output showing server modification time of each
file. Designed for use in 80 column modes, but readable in 40.

# `BLCONFIG` options

To switch an option on, use `*BLCONFIG X+`, where `X` is that option's
code (see below). Use `-` to switch it off. You can specify multiple
options on the command line.

If any options are active, their codes will be displayed in the ROM
startup banner.

The current ROM options are as follows.

## `V` - debug verbosity

The ROM will print debug messages when the `V` option is on. This is
handy when working on the ROM, but you probably don't want it
otherwise!

**Debug verbosity is not designed for use in conjunction
with `*SPOOL`.**

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
large. There's a size limit of 16MBytes for all files.

## `Volume not found` (same code as `File not found`)

The volume name supplied didn't match any volumes.

## `Won't` (&93) (as seen on ADFS)

The request operation won't be performed.

When running a file with `*RUN` or loading a file with `*LOAD` and not
providing an explicit load address, this occurs when the file has a
load address of &FFFFFFFF. For `*RUN` this will also occur when the
execution address is &FFFFFFFF. (This usually means the file has a
0-byte .inf file, but these addresses can also be assigned manually.)

`*SRLOAD` produces this error if trying to load a ROM image over the
BLFS itself, or if the address range would be outside the ROM area of
&8000-&BFFF.
