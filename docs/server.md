# Useful server command line options

(You can get a list of the basic command line options with `--help`; a
full list is available with `--verbose --help`.)

The server searches for volumes in the folders you specify on the
command line. You can specify multiple folders, and they'll be
searched for volumes in that order.

Folders are searched recursively to find volumes, but a volume's
folder, once found, isn't itself searched further. You can prevent a
folder from being searched further by creating a file called
`.beeblink-ignore` (contents irrelevant - only the name is checked)
inside that folder.

(When creating a volume with `*NEWVOL`, it will always be created in
the first folder listed. Create one manually on the PC if you want a
new one somewhere else.)

Use `--default-volume` to get the server to load a specific volume on
startup (following the same rules in case of ambiguity). The default
is `65boot`.

## Serial device autodetect

The server will autodetect and open any FTDI devices thet look like
they might be a Tube serial board, or the specific type of FTDI USB
serial adapter I've tested the UPURS cable with (vendor id 0403,
product id 6001).

To see a list of the serial devices the server is finding, run with
`--serial-list-devices`. It will show all the serial devices it can
find, and some info for each about why it's going to use (or not) that
device.

To exclude a device, use `--serial-exclude`, passing the path from the
serial devices list.

To exclude all devices, use `--serial-exclude-all`. Use
`--serial-include` to specify which devices to use - again, passing
the path from the serial devices list for each one.

# Using a config file

You can create a JSON config file to avoid having to specify folders
on the command line each time. The config file stores the settings for
the following command-line flags:

* list of folders to search for volumes
* `--git`
* `--default-volume`
* `--avr-rom`
* `--serial-rom`
* `--serial-exclude`

The server can create the config file for you based on the command
line options you provide. Use the `--save-config` option to do this.
It will save the options to `beeblink_config.json`, which is the file
it tries to load on startup each time.

You can also specify config file names manually if you prefer - see
the help.

# How BBC files are stored

BBC files are stored in the standard .inf format: one file holding the
file contents, and a second file, with the same name and a .inf
extension, holding the BBC file name and load/execution addresses.

There are various tools available for creating such files from DFS
disc images:

* https://www.stairwaytohell.com/essentials/index.html?page=homepage
* https://github.com/tom-seddon/beeb/tree/master/bin#ssd_extract

# PC/BBC interop

## Accessing BBC files from the server

The server does its best to name the PC file after the BBC file when
creating a file, so it should be easy to find. A simple escaping
syntax (`#xx`, where `xx` is the ASCII value) is used for BBC
characters that aren't valid in PC names.

In principle, the BBC name (as stored in the .inf file) can be
unrelated to the PC name, but the server tries not to do this itself.

While a file is open on the BBC, it is buffered in RAM. Changes won't
be seen on disk until the file is closed or flushed with OSARGS A=&FF.

## Creating BBC files on the server

You can create BBC files on the server, e.g., when using your PC to
develop BBC software. Create the file with a DFS-like file name: a
directory character, a `.`, then a name (max 10 chars). (For example:
`$.!BOOT`.)

If the name is valid, the BBC will see it, under exactly the name it
has on the PC.

The following rules apply to files with no associated .inf file, or an
empty .inf file:

* the name seen on the BBC will be exactly the name it has on the PC
* load and execution addresses will both be &FFFFFFFF (see the `Won't`
  error)
* the file will be unlocked
  
The .inf file will be created or updated automatically if any of its
properties change.

When creating a folder for an alphabetic drive on a case-sensitive
filing system, use a lower-case letter - the server doesn't promise to
behave well otherwise.

## Accessing PC files on the BBC

You can access PC files by copying them to a BBC volume, and giving
them a BBC name, as described above, and this is pretty convenient in
most cases. But you can also access them directly, with some
limitations, under their usual PC names.

Use the `--pc` option when running the server to do this, specifying a
folder to make available as a read-only PC volume. This doesn't make
any great effort to work like any existing type of BBC filing system,
nor does it make any real effort at being super-useful in general:
it's designed for getting quick access to PC files for use with
`*WRITE`, `*EXEC`, and BASIC's `LOAD` - nothing more.

Limitations and oddities of PC volumes:

* only files with names <=31 chars are available - this to ensure that
  `*INFO`/`*EX` is practical in Mode 7
* only files smaller than 16 MBytes are available
* the folder is read only
* there are no drives or directories - every drive is a bad drive, and
  every dir is a bad dir. This also means there's no library, and
  `*DEFAULTS` does nothing
* the file names seen on the BBC are exactly the names they have on
  the PC
* PC files don't have load and execution addresses - both are
  effectively always &FFFFFFFF (see the `Won't` error)
* a file's extension is `.txt`, it will be treated as a text file (see
  below)
* valid file name chars are at the discretion of the server's filing
  system
* file name matching is case-insensitive (as you'll probably have caps
  lock on...), which may cause issues with case-sensitive server
  filing systems
* `*OPT 4` and `*TITLE` are not supported

## Text files

The standard BBC Micro newline is a single CR, making it incompatible
with Windows- or Unix-style text files. If a file is treated as text,
the server can perform newline translation when the file is opened for
random access. This is a hack to make it easy to use PC-style text
files with `*EXEC`, e.g., after downloading from the web.

When opened for random access, double-/single-byte newlines will be
converted to ASCII 13, and an ASCII 13 will be added to the end if
necessary. This affects data read from `OSBGET`/`OSGBPB`, and the
value of `EXT#`.

`OSFILE` access is unaffected, and SHA1 hashes printed by `*LOCATE`
ignore the file's text status.

Correct results in general are far from guaranteed.

This mechanism may improve over time...
