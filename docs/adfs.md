# ADFS-like volume support

**ADFS volumes are experimental!**

BeebLink supports hierarchical ADFS-like volumes. To create one,
create an ordinary volume, and create a file called `.adfs` (contents
irrelevant) in its folder, next to the `0` folder.

ADFS volumes deliberately behave a lot like an ordinary ADFS floppy
disk or hard disk.

**ADFS volumes are experimental!**

## Improvements over ADFS

- No limit to number of entries in a directory

- Each directory has an independent boot option

## Missing ADFS features

- The following ADFS commands are not supported: `BACKUP`, `COMPACT`,
  `BYE`, `DESTROY`, `DISMOUNT`, `FREE`, `FORMAT`, `MAP`, `MOUNT`,
  `VERIFY`

- Directory attributes are ignored

- The `E` attribute is ignored (but you can set it, and it will be
  retained)

- There are no sequence numbers

# Extracting ADFS disk contents

I've done this using [my adf_extract
script](https://github.com/tom-seddon/beeb/tree/master/bin#adf_extract)
or [Disc Image
Manager](https://github.com/geraldholdsworth/DiscImageManager/releases).

## Disc Image Manager

Load ADFS disk in, right click on the root directory, use `Extract
File...` to save the contents somewhere.

To create a new BeebLink drive holding the contents of the disk, save
it to a folder with a suitable name (`0` to `9`, `A` to `Z`) inside
the volume folder. To create a new directory inside an existing drive,
extract it to the appropriate place.

## `adf_extract`

Use `-o` to put the output somewhere in an existing drive. The tool
will create a suitably-named folder for it automatically. For example:

    adf_extract mwelcome.adl -o my_volume\0
	
This will create `my_volume\0\mwelcome`, and
`my_volume\0\mwelcome.inf`, meaning the disk will appear as a
directory called `mwelcome` in the root directory.

You can't directly use `adf_extract` to create a drive folder, but you
can rename the output.

# Creating ADFS disks

The BeebLink files are intended to be generally compatible with other
tools, Disc Image Manager included, if you want to create an ADFS disk
image.

(The BeebLink *OPT4 setting probably won't come across... apologies.
You'll have to set this by hand.)
