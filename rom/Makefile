ifeq ($(OS),Windows_NT)
TASS?=..\tools\64tass.exe
else
TASS?=64tass
endif

PYTHON?=python

##########################################################################
##########################################################################

DEST:=.build
TASSCMD:=$(TASS) --m65xx --nostart -Wall -Wno-implied-reg -C --line-numbers --long-branch
GIT_VER:=$(shell git log -1 '--format=%cd-%h' '--date=format:%Y%m%d-%H%M%S')

SHELLCMD:=$(PYTHON) ../tools/shellcmd.py

# mashup of git log -1 and git describe --dirty, which git doesn't
# seem to be able to do on its own :(
#
# '.' indicates clean working copy, '*' indicates dirty. There's just
# not quite room for the '-dirty' suffix as part of the *BLSELFUPDATE
# output.
#
# Both types of version string must be the same length, so that the
# rest of the code can be compared bytewise with sha1sum.py.
ifeq ($(shell git status --porcelain),)
VER:=$(GIT_VER).
else
VER:=$(GIT_VER)*
endif

COMMIT:=$(shell git log -1 '--format=%H')

.PHONY:build
build: BUILD_TIME:=$(shell $(SHELLCMD) strftime -d _ '_Y-_m-_d _H:_M:_S')
build:
	$(SHELLCMD) mkdir $(DEST)
	$(PYTHON) ../tools/make_constants.py -o $(DEST)/beeblink_constants.s65 ../server/beeblink.ts 6502

# 65120 = $fe60 - can't figure out how to get the $ through without
# making a mess...
	$(MAKE) _rom "BUILD_TIME=$(BUILD_TIME)" SUFFIX=avr_fe60 "EXTRA_ARGS=-Dlink_avr=true -Dlink_avr_via=65120"

# 160 = $a0
# 192 = $c0
	$(MAKE) _rom "BUILD_TIME=$(BUILD_TIME)" SUFFIX=tube_serial "EXTRA_ARGS=-Dlink_tube_serial=true -Dblfs_prefix=\\\"TSBL\\\" -Dblfs_fs_number=94 -Dblfs_first_handle=160 -Ddefault_von=false"

	$(SHELLCMD) mkdir ../volumes/beeblink/1/

	$(SHELLCMD) copy-file .build/beeblink_tube_serial.rom ../volumes/beeblink/1/R.TS
	$(SHELLCMD) touch ../volumes/beeblink/1/R.TS.inf

	$(SHELLCMD) copy-file .build/beeblink_avr_fe60.rom ../volumes/beeblink/1/R.AVR-FE60
	$(SHELLCMD) touch ../volumes/beeblink/1/R.AVR-FE60.inf

	@echo ---
	@$(PYTHON) ../tools/sha1sum.py -x '$(VER)' -x '$(BUILD_TIME)' -x '$(COMMIT)' .build/beeblink_tube_serial.rom .build/beeblink_avr_fe60.rom

.PHONY:_rom
_rom:
	$(TASSCMD) beeblink.s65 -L$(DEST)/beeblink_$(SUFFIX).lst -o$(DEST)/beeblink_$(SUFFIX).rom "-DVERSION=\"$(VER)\"" "-DBUILD_TIME=\"$(BUILD_TIME)\"" "-DCOMMIT=\"$(COMMIT)\"" $(EXTRA_ARGS)

# # (Hack, for my benefit, on my computer - make a second copy of the
# # BeebLink ROM for my BBC B that has some extra stuff in it.)
# ifneq ($(OS),Windows_NT)
# ifeq ($(shell uname -sn),Darwin tmbp.local)
# ifeq ($(shell whoami),tom)
# 	smload_join $(DEST)/beeblink.rom $(HOME)/beeb/beeb-files/stuff/65boot/0/$$.TUBEROM '../../startup_rom/.build/.tmp/startup_module.rom' -o $(DEST)/beeblink_b.rom
# 	cp $(DEST)/beeblink_b.rom ../../startup_rom/.build/startup_rom/0/R.BEEBLINK
# 	touch ../../startup_rom/.build/startup_rom/0/R.BEEBLINK.inf
# endif
# endif
# endif

.PHONY:clean
clean:
	$(SHELLCMD) rm-tree $(DEST)
