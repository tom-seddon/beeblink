# BeebLink Tools

The BeebLink tools can be found in the `beeblink` volume. You can
select this volume and do a SHIFT+BREAK to run the menu.

For quick access, do a B+T+BREAK (hold B and T, and tap BREAK) to run
the menu. (This doesn't change the current volume, handy if there's a
file on it you want to use with Disk Imager or ROM Tool.)

## Disk Imager

Create a disk image on a BeebLink volume from a disk, or write a disk
image on a BeebLink volume to a formatted disk. Supports
single-density DFS, ADFS, and double density disks from Opus
DDOS/Challenger or Watford DDFS.

Select `R` to read a disk, creating a disk image, or `W` to write a
disk from a disk image.

Select `A` to read/write all of the disk, or `U` to read/write only
the used areas.

Pick the drive to read from or write to.

Select the disk type (see below), then specify the image to read from
or write to. (You can also enter * commands at this point by entering
a line starting with `*` - e.g., to change volume, or get a
catalogue.)

### Disk types

#### Acorn DFS

Use this for reading or writing ordinary single density Acorn
DFS-style disks. DFS type shouldn't matter and this should hopefully
work with just about everything.

You'll need to specify single or double sided. The track count is
detected by reading the disk.

Watford DFS 62-file disks are not yet fully supported. If you have a
62-file disk, be sure to read/write all of the disk to ensure all the
data is transfercred.

#### ADFS

Use this for reading or writing ADFS disks or hard disks.

You'll need to specify the disk type: auto-detect, or hard disk.
Select auto-detect, which will do the right thing in every useful
case. (The explicit hard disk option is there to accommodate the
unlikely corner case of a hard disk formatted to 640 KB.)

#### Opus DDOS

Use this for reading or writing double density Opus DDOS or Challenger
disks when you have the Opus DDOS ROM installed. (For single density
disks, use the Acorn DFS option.)

You'll need to specify single or double sided. The track count is
detected by reading the disk.

The used areas option is not yet supported, and the whole disk is
always read or written.

#### Opus Challenger

Use this for reading or writing double density Opus DDOS or Challenger
disks when you have the Challenger ROM installed. (For single density
disks, use the Acorn DFS option.)

You'll need to specify single or double sided. The track count is
detected by reading the disk.

The used areas option is not yet supported, and the whole disk is
always read or written.

#### Watford DDFS

Use this for reading or writing double density Watford DDFS disks when
you have Watford DDFS installed. (For single density disks, use the
Acorn DFS option.)

You'll need to specify single or double sided. The track count is
detected by reading the disk.

The used areas option is not yet supported, and the whole disk is
always read or written. There's currently no special consideration
required for 62-file disks.

### Disk imager notes

- protected disks are not supported

- when writing a disk image to a disk, the target disk must be
  formatted and of the appropriate capacity. There are some checks,
  but they aren't particularly thorough
  
- The used areas option works in units of whole tracks on DFS, and
  chunks of some number of KBytes on ADFS. It always reads or writes
  the whole area, even if only part of it is used - so unused data can
  end up being read or written. This mode is intended as a timesaving
  measure, not a way of creating a perfectly tidy disk or disk image

## Speed Test

Transfers data to and from the server repeatedly to get a rough
estimate of throughput. Main memory and (when active) second processor
memory are both tested, and on Electron it'll do separate tests in
modes 0, 3 and 4 to monitor the overhead.

Speed Test will ask you how many iterations you want to run, then do
its thing. While testing transfers to main memory, you'll see the
screen fill with junk; for transfers to second processor memory,
you'll see nothing obvious.

Results are printed to the screen, and also saved to a text file on
drive Z on the BeebLink volume.

## ROM Self-Update _(not Tube-compatible)_

Gets a copy of the appropriate filing system ROM from the server, and
(if possible) uses it to update the current ROM.

If you have the ROM in sideways RAM, the tool will find it and update
it automatically. Switch off any write protection first.

Otherwise, the update program will place the ROM image in memory for
you to save to disk - copy the command line displayed to do this. Or
run `RTOOL` (supplied) and use its `P` command straight away. The ROM
image is downloaded to the address `RTOOL` expects.

## BooBip ROM Tool _(not Tube-compatible, not on Electron)_

Useful sideways ROM tool.

Official documentation here: http://www.boobip.com/software/rom-tool
