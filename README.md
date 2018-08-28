# BeebLink

A file storage system for the BBC Micro. Make your PC do something
useful for a change: have it act as a file server for your BBC. No
more swapping discs, no more noisy drives, no more 31 file limit.

# Installation and setup

This is all 100% self-assembly at the moment, and the system
requirements are a bit specific, but this will improve...

Requirements:

* Minimus AVR 32K microcontroller board
* BBC Micro with sideways RAM (Master 128 recommended)
* PC running Mac OS X

**This repo has submodules** - clone it with `git clone --recursive`,
or do `git submodule init && git submodule update` from the working
copy after a normal clone.

Steps:

1. [AVR setup and wiring instructions](./docs/avr.md)

2. [Assemble filing system ROM for BBC Micro](./docs/build-rom.md)

3. [Run server on PC](./docs/run-server.md)

4. [Get ROM running on BBC](./docs/run-rom.md)

5. [Try filing system on BBC](./docs/fs.md)
