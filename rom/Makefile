DEST:=.build
TASS:=64tass --m65xx --nostart -Wall -Wno-implied-reg -C --line-numbers --long-branch
GIT_VER:=$(shell git log -1 '--format=%cd-%h' '--date=format:%Y%m%d-%H%M%S')

ifeq ($(shell git status --porcelain),)
VER:=$(GIT_VER)
else
# mashup of git log -1 and git describe --dirty, which git doesn't
# seem to be able to do on its own :(
#
# '*' indicates dirty working copy. There's just not quite room for
# the '-dirty' suffix as part of the *BLSELFUPDATE output.
VER:=$(GIT_VER)*
endif

.PHONY:build
build:
	mkdir -p $(DEST)
	python ../tools/make_constants.py -o $(DEST)/beeblink_constants.s65 ../server/beeblink.ts 6502
	$(TASS) beeblink.s65 -L$(DEST)/beeblink.lst -o$(DEST)/beeblink.rom "-DVERSION=\"$(VER)\"" "-DCOMMIT=\"$(COMMIT)\""

# (Hack, for my benefit, on my computer - make a second copy of the
# BeebLink ROM for my BBC B that has some extra stuff in it.)
ifneq ($(OS),Windows_NT)
ifeq ($(shell uname -sn),Darwin tmbp.local)
ifeq ($(shell whoami),tom)
	smload_join $(DEST)/beeblink.rom $(HOME)/beeb/beeb-files/stuff/65boot/0/$$.TUBEROM '../../startup_rom/.build/.tmp/startup_module.rom' -o $(DEST)/beeblink_b.rom
	cp $(DEST)/beeblink_b.rom ../../startup_rom/.build/startup_rom/0/R.BEEBLINK
	touch ../../startup_rom/.build/startup_rom/0/R.BEEBLINK.inf
endif
endif
endif

.PHONY:clean
clean:
	rm -Rf $(DEST)
