# ADFS-like volume support

BeebLink supports hierarchical ADFS-like volumes. To create one,
create an ordinary volume, and create a file called `.adfs` (contents
irrelevant) in its folder, next to the `0` folder.

General behaviour is much like ADFS. There are a few bits missing:

- The following commands are not supported: `BACKUP`, `COMPACT`,
  `BYE`, `DISMOUNT`, `FREE`, `FORMAT`, `MAP`, `MOUNT`, `VERIFY`

- Directory attributes are ignored

- The `E` attribute is ignored

- There are no sequence numbers

There are some additions:

- Every directory has a separate boot option

- No limit to the number of entries in a directory

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
the volume folder.

To create a new directory inside an existing drive, extract it to the
appropriate place. In this case, you'll have to delete the .inf file
that Disc Image Manager creates, as it's a slightly different format
that's only supported for a root directory. (This does mean you lose
the directory title and boot option.)

## `adf_extract`

Use `-o` to put the output somewhere in an existing drive. The tool
will create a suitably-named folder for it automatically. For example:

    adf_extract MasterWelcome.adl -o my_volume\0
	
This will create `my_volume\0\MasterWelcome`, and
`my_volume\0\MasterWelcome.inf`, meaning the disk will appear as a
directory called `MasterWelcome` in the root directory.

You can't directly use `adf_extract` to create a drive folder. You can
rename the output.

# Creating ADFS disks

The BeebLink files are intended to be generally compatible with other
tools, Disc Image Manager included, if you want to create an ADFS disk
image.
