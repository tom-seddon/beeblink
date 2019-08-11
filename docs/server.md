# Useful server command line options

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

With multiple folders, or a nested folder structure, you can end up
with multiple volumes with the same name this way - something you can
see from the `*VOLS` output or in the volume browser. When loading a
volume with `*VOL`, the first one matched will be used, but you can
use the volume browser to be explicit.

Use `--default-volume` to get the server to load a specific volume on
startup (following the same rules in case of ambiguity). The default
is `65boot`.

Use `--serial-rom` to tell the server where to find the BLFS ROM
image. It will then try to load it from this location, not the current
folder, when using the bootstrap program or `*BLSELFUPDATE`.

The server will autodetect and open any FTDI devices thet look like
they might be a Tube serial board. If it's opening any such devices
that you aren't using for BeebLink, use `--serial-exclude` to have
them excluded. The exclusion is by device name, so watch out for
changes in COM port assignment.

You can get a full list of the command line options with `npm start --
-h`.

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
* if the directory name is `!`, it will be treated as a text file (see
  below)
  
The .inf file will be created or updated automatically if any of its
properties change. This will affect the interpretation of files in the
`!` directory.

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

`OSFILE` access is unaffected.

Correct results in general are far from guaranteed.

This mechanism may improve over time...
