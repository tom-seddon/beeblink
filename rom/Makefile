DEST:=.build
TASS:=64tass --m65xx --nostart -Wall -Wno-implied-reg -C
OLDROM:=~/beeb/beeb-files/stuff/65boot/4/RROM
VER?=$(shell date '+%Y-%m-%d %H:%M:%S')

.PHONY:build
build:
	mkdir -p $(DEST)
	python ../tools/make_constants.py -o $(DEST)/beeblink_constants.s65 ../server/beeblink.ts 6502
	$(TASS) beeblink.s65 -L$(DEST)/beeblink.lst -o$(DEST)/beeblink.rom "-DVERSION=\"$(VER)\""

.PHONY:clean
clean:
	rm -Rf $(DEST)
