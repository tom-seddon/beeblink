# BeebLink Tools

The BeebLink tools can be found in the `beeblink` volume. You can
select this volume and do a SHIFT+BREAK to run the menu.

For quick access, do a B+T+BREAK (hold B and T, and tap BREAK) to run
the menu. (This doesn't change the current volume, handy if there's a
file on it you want to use with Disk Imager or ROM Tool.)

## Disk Imager

Create a disk image on a BeebLink volume from a disk, or write a disk
image on a BeebLink volume to a formatted disk. Supports
single-density DFS, ADFS, and Opus DDOS/Challenger.

Select `R` to read a disk, creating a disk image, or `W` to write a
disk from a disk image.

Select `A` to read/write all of the disk, or `U` to read/write only
the used areas.

Pick the drive to read from or write to.

Select the disk type - Acorn DFS, ADFS, or Opus DDOS/Challenger.

For DFS or Opus you'll need to specify single or double sided.

For ADFS, BeebLink will detect the disk type automatically: ADFS L if
640 KB, or some other ADFS type if not. (For historical reasons, ADFS
L images are special. And this also means that 640 KB hard disk images
are not currently supported.)

Finally, specify the image to read from or write to. (You can also
enter * commands at this point by entering a line starting with `*` -
e.g., to change volume, or get a catalogue.)

Notes:

- protected disks are not supported

- when writing a disk image, the target disk must be formatted and of
  the appropriate capacity. There are some checks, but they aren't
  particularly thorough
  
- Opus DDOS/Challenger support is a bit flaky - if you get unexpected
  disk faults, try doing a `*CAT` of the target disk then re-running
  the imager. This is a BeebLink bug:
  https://github.com/tom-seddon/beeblink/issues/42
  
- used areas mode isn't actually supported with Opus DDOS/Challenger
  (yet?), and the whole disk is always read or written
  
- 62-file single-density Watford DFS disks aren't specifically
  supported, but if you treat them as a DFS disk and read/write the
  whole disk it might work!
  
- The used areas option writes whole tracks on DFS and 4 KB chunks on
  ADFS. It always reads or writes the whole area even if only part of
  it is used - so the disk image can end up with actually unused data
  in it. This mode is intended as a timesaving measure, not a way of
  creating a perfectly tidy disk image

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
