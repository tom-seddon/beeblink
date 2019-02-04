# -*- mode:makefile-gmake; -*-

# The LUFA Makefile seems to be set up for building one target
# platform at a time. So this driver Makefile has phony targets for
# building and cleaning that call make again on the main Makefile to
# do whatever for supported target platform in turn.
#
# The programming targets also defer to the main Makefile to run the
# actual commands, because that has all the variables set.
#
# There's also a ctags target. This isn't dependent on the target
# platform, but again, it defers to the main Makefile, because that
# has all the info to hand. The main Makefile has some error-checking
# for the target platform variables, so the tags target supplies some
# arbitrary values for those - though it doesn't make much of a
# difference.

LEONARDO_VARS=MCU=atmega32u4 ARCH=AVR8 BOARD=LEONARDO
MINIMUS_VARS=MCU=atmega32u2 ARCH=AVR8 BOARD=MINIMUS

.PHONY:all
all:
	$(MAKE) -f Makefile.beeblink $(LEONARDO_VARS) hex lss
	$(MAKE) -f Makefile.beeblink $(MINIMUS_VARS) hex lss

.PHONY:tags
tags:
	$(MAKE) -f Makefile.beeblink $(MINIMUS_VARS) tags

.PHONY:clean
clean:
	$(MAKE) -f Makefile.beeblink $(LEONARDO_VARS) clean
	$(MAKE) -f Makefile.beeblink $(MINIMUS_VARS) clean
	rm -f TAGS

.PHONY:program_minimus
program_minimus:
	$(MAKE) -f Makefile.beeblink $(MINIMUS_VARS) dfu2

# There doesn't seem to be any good solution to the AVRDUDE_PORT thing
# :( - this just assumes there's one connected device in the 8 second
# post-reset programming window, that's named as mine is when plugged
# into my Macbook Pro, and tries to figure it out on that basis :(
#
# If your device doesn't present itself with the same sort of name as
# mine did, edit the wildcard.
#
# (On my Linux PC, it looked like
# /dev/ttyACM* might be the wildcard to use.)
#
# (I couldn't get avrdude working on Windows at all, but the Arduino
# IDE said the device was COM4, but the best result I got was a
# different error message with -p COM4 than with -p
# COM-something-else...)

.PHONY:program_leonardo
program_leonardo: AVRDUDE_PORT:=$(wildcard /dev/cu.usbmodem*)
program_leonardo:
	$(MAKE) -f Makefile.beeblink $(LEONARDO_VARS) AVRDUDE_PROGRAMMER=avr109 AVRDUDE_PORT=$(AVRDUDE_PORT) AVRDUDE_BAUD=57600 dfu2
