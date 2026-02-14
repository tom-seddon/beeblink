# BeebLink Tools

The BeebLink tools can be found in the `beeblink` volume. You can
select this volume and do a SHIFT+BREAK to run the menu.

For quick access, do a B+T+BREAK (hold B and T, and tap BREAK) to run
the menu. (This doesn't change the current volume, handy if there's a
file on it you want to use with Disk Imager or ROM Tool.)

## Disk Imager

Create a disk image on a BeebLink volume from a disk, or write a disk
image on a BeebLink volume to a formatted disk. Supports
single-density Acorn DFS (and compatible systems), ADFS, and double
density disks from Opus DDOS/Challenger or Watford DDFS.

Select `R` to read a disk, creating a disk image, or `W` to write a
disk from a disk image.

Next, pick to drive to read from or write to.

Next, select the disk type and other settings, as follows.

### Acorn DFS

Handles single- or double-sided Acorn DFS disks. Also covers
single-density disks from Acorn compatible DFSs: Opus, Watford,
Solidisk, etc.

Select `S` for a single-sided disk or `D` for a double-sided disk.

Select `A` to read or write the entire disk, or `U` to have BeebLink
scan the catalogue and transfer only the tracks that are actualrly
used.

(Note: the used areas option only looks at the standard 31 Acorn
DFS-style files. For 62-file Watford DFS disks, always use the `A`
option.)

Usual PC file extensions:

- `.ssd` - single sided
- `.dsd` - double sided

### ADFS

Handle ADFS S/M/L disks, or hard disks.

Select `A` to autodetect the disk type, which will almost certainly do
the right thing. (If you have a hard disk formatted to exactly 640 KB,
select `H`.)

Usual PC file extensions:

- `.ads` - ADFS S
- `.adm` - ADFS M
- `.adl` - ADFS L
- `.dat` - ADFS hard disk

### Opus Challenger (DD)

Handles double-density Opus DDOS/Challenger disks. (Use this option if
you have the Challenger ROM installed.)

Usual PC file extensions:

- `.sdd` - single sided
- `.ddd` - double sided

### Opus DDOS (DD)

Handles double-density Opus DDOS/Challenger disks. (Use this option if
you have the Opus DDOS ROM installed.)

Select `S` for a single-sided disk or `D` for a double-sided disk.

Usual PC file extensions:

- `.sdd` - single sided
- `.ddd` - double sided

### Watford DDFS (DD)

Handles double density Watford DDFS disks.

Select `S` for a single-sided disk or `D` for a double-sided disk.

(Unlike the single density case, there's no used areas option. So no
special consideration required for 62-file disks.)

Usual PC file extensions:

- `.sdd` - single sided
- `.ddd` - double sided

### Other disk imager notes

- when creating a disk image file, you can use any BBC-friendly name
  you like. The idea is that it can get subsequently renamed on the
  server

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
