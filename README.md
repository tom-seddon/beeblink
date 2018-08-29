**This repo has submodules** - clone it with `git clone --recursive`,
or do `git submodule init && git submodule update` from the working
copy after a normal clone.

# BeebLink

A file storage system for the BBC Micro. Make your PC do something
useful for a change: have it act as a file server for your BBC. No
more swapping discs, no more noisy drives, no more 31 file limit.

This is all 100% self-assembly at the moment, and the system
requirements are a bit specific. But this will improve...

# Requirements

* Minimus AVR 32K microcontroller board (used to connect BBC's user
  port and PC's USB port)
* PC running Mac OS X 
* BBC Micro with some good way of loading the ROM image (i.e., with
  something like EEPROM or write-protected battery-backed sideways
  RAM... it's no fun having to reload it on each boot and/or have it
  zapped by careless programs)

# Installation and setup

[Setup instructions](./docs/setup.md)

[Filing system docs](./docs/fs.md)

[Useful server command line options](./docs/server.md)
