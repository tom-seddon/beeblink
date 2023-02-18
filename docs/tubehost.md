# TubeHost support

TubeHost can be found here: https://github.com/sweharris/TubeHost -
it's along the same lines as BeebLink, but with a slightly different
metaphor.

BeebLink now has experimental support for TubeHost interop. You can
point the BeebLink server at your TubeHost files, and access them via
BeebLink on your BBC.

To do this, use the `--tube-host` command line option, and point it at
your disk base folder, which will be `~/Beeb_Disks` by default (unless
you've changed it). For example:

    ./beeblink_server --tube-host ~/Beeb_Disks ./volumes
	
This will add an additional volume, named after the folder (here,
`Beeb_Disks`), containing all your TubeHost disks. To access them, use
`*VOL`, e.g.:

	*VOL BEEB_DISKS
	
One a TubeHost volume is selected, things work a bit more like
TubeHost: you have 10 numbered drives, you can "insert" new "disks"
into the drive using `*DIN`, see which disks are available with
`*DCAT`, navigate the folder structure with `*HCF` and `*HFOLDERS` -
and so on.

## TubeHost limitations

(These will get improved over time.)

- direct access to TubeHost files using the `::VOLUME` syntax is not
  currently possible, as files don't inherently have a BBC-syntax name
  until you've selected the disk with `*DIN`.

  Relatedly, while `*LOCATE` will find files in TubeHost volumes, the
  output is not a valid BBC name: the drive number is invalid (as the
  drive is unknown), and the server path is printed separately(so you
  can guess with host folder/disk it's on).
  
- `*DIN` assignments are only retained while the volume is selected,
  and will be lost if you switch volume

- looks like TubeHost has no specific file name limited, but the
  BeebLink 10 char limit currently still applies
  
- the library drive L is not yet supported
