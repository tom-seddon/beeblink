ifeq ($(OS),Windows_NT)
TASS?=..\tools\64tass.exe
PYTHON?=py -3
else
TASS?=64tass
PYTHON?=python3
endif

##########################################################################
##########################################################################

ifeq ($(VERBOSE),1)
_V:=
_TASSQUIET:=
else
_TASSQUIET:=--quiet
_V:=@
endif

##########################################################################
##########################################################################

# https://stackoverflow.com/a/665045/1618406

lcase = $(subst A,a,$(subst B,b,$(subst C,c,$(subst D,d,$(subst E,e,$(subst F,f,$(subst G,g,$(subst H,h,$(subst I,i,$(subst J,j,$(subst K,k,$(subst L,l,$(subst M,m,$(subst N,n,$(subst O,o,$(subst P,p,$(subst Q,q,$(subst R,r,$(subst S,s,$(subst T,t,$(subst U,u,$(subst V,v,$(subst W,w,$(subst X,x,$(subst Y,y,$(subst Z,z,$1))))))))))))))))))))))))))

ucase = $(subst a,A,$(subst b,B,$(subst c,C,$(subst d,D,$(subst e,E,$(subst f,F,$(subst g,G,$(subst h,H,$(subst i,I,$(subst j,J,$(subst k,K,$(subst l,L,$(subst m,M,$(subst n,N,$(subst o,O,$(subst p,P,$(subst q,Q,$(subst r,R,$(subst s,S,$(subst t,T,$(subst u,U,$(subst v,V,$(subst w,W,$(subst x,X,$(subst y,Y,$(subst z,Z,$1))))))))))))))))))))))))))

##########################################################################
##########################################################################

DEST:=.build
TASSCMD:=$(TASS) --m65xx -Wall -Wno-implied-reg -Wno-portable -C --line-numbers --long-branch $(_TASSQUIET)
GIT_VER:=$(shell git log -1 '--format=%cd-%h' '--date=format:%Y%m%d-%H%M%S')
SHELLCMD:=$(PYTHON) ../submodules/shellcmd.py/shellcmd.py
SMLOAD_JOIN:=$(PYTHON) ../submodules/beeb/bin/smload_join.py
PRG2BBC:=$(PYTHON) ../submodules/beeb/bin/prg2bbc.py
COMMIT:=$(shell git log -1 '--format=%H')

# The ROMs are also copied to drive z on the example beeblink volume.
BEEB_DEST:=../volumes/beeblink/z

# Mashup of git log -1 and git describe --dirty, which git doesn't
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

##########################################################################
##########################################################################

ifneq ($(OS),Windows_NT)
ifeq ($(shell whoami),tom)
MY_PCS:=tmbp.local tmbp15.local
ifneq ($(filter-out $(MY_PCS),$(shell uname -sn)),$(MY_PCS))
TOM_LAPTOP:=1
endif
endif
endif

##########################################################################
##########################################################################

BUILD_TIME:=$(shell $(SHELLCMD) strftime -d _ '_Y-_m-_d _H:_M:_S')

.PHONY : all
all : programs roms

.PHONY : programs
programs: _uputest_program

.PHONY : roms
roms : _avr_rom _tube_serial_rom _upurs_rom _tube_serial_electron_rom
	@echo ---
	$(_V)cd "$(DEST)" && $(PYTHON) ../../tools/sha1sum.py --size -x "$(VER)" -x "$(BUILD_TIME)" -x "$(COMMIT)" beeblink_tube_serial.rom beeblink_tube_serial_safe.rom beeblink_avr_fe60.rom beeblink_upurs_fe60.rom beeblink_tube_serial_electron.rom beeblink_tube_serial_safe_electron.rom

##########################################################################
##########################################################################

.PHONY : _dest
_dest:
	$(_V)$(SHELLCMD) mkdir $(DEST)
	$(_V)$(SHELLCMD) mkdir ../volumes/beeblink/z

##########################################################################
##########################################################################

$(DEST)/beeblink_constants.s65 : ../server/beeblink.ts ../tools/make_constants.py
	$(_V)$(PYTHON) ../tools/make_constants.py -o "$@" "$<" 6502

##########################################################################
##########################################################################

.PHONY : _uputest_program
_uputest_program: _dest $(DEST)/beeblink_constants.s65
	$(_V)$(MAKE) _program "BUILD_TIME=$(BUILD_TIME)" STEM=uputest IO=1 DRIVE=z

##########################################################################
##########################################################################

.PHONY : _avr_rom
_avr_rom : _dest $(DEST)/beeblink_constants.s65
# 65120 = $fe60 - can't figure out how to get the $ through without
# making a mess...	
	$(_V)$(MAKE) _rom "BUILD_TIME=$(BUILD_TIME)" ROM_SUFFIX=avr_fe60 ROM_BEEB_NAME=AVRFE60 LINK=avr CMD_PREFIX=AVR "EXTRA_ARGS=-Dlink_avr_via=65120"

.PHONY : _tube_serial_rom
_tube_serial_rom : _dest $(DEST)/beeblink_constants.s65
	$(_V)$(MAKE) _rom "BUILD_TIME=$(BUILD_TIME)" ROM_SUFFIX=tube_serial ROM_BEEB_NAME=TS LINK=tube_serial CMD_PREFIX=TS
	$(_V)$(MAKE) _rom "BUILD_TIME=$(BUILD_TIME)" ROM_SUFFIX=tube_serial_safe ROM_BEEB_NAME=TSS LINK=tube_serial CMD_PREFIX=TS "EXTRA_ARGS=-Dtube_serial_safe=true"

.PHONY : _upurs_rom
_upurs_rom : _dest $(DEST)/beeblink_constants.s65
	$(_V)$(MAKE) _rom "BUILD_TIME=$(BUILD_TIME)" ROM_SUFFIX=upurs_fe60 ROM_BEEB_NAME=UPUFE60 LINK=upurs CMD_PREFIX=U "EXTRA_ARGS=-Dlink_upurs_via=65120"

.PHONY : _tube_serial_electron_rom
_tube_serial_electron_rom: _dest $(DEST)/beeblink_constants.s65
	$(_V)$(MAKE) _rom "BUILD_TIME=$(BUILD_TIME)" ROM_SUFFIX=tube_serial_electron ROM_BEEB_NAME=ETS LINK=tube_serial CMD_PREFIX=TS "EXTRA_ARGS=-Dtarget_electron=true"
	$(_V)$(MAKE) _rom "BUILD_TIME=$(BUILD_TIME)" ROM_SUFFIX=tube_serial_safe_electron ROM_BEEB_NAME=ETSS LINK=tube_serial CMD_PREFIX=TS "EXTRA_ARGS=-Dtarget_electron=true -Dtube_serial_safe=true"

##########################################################################
##########################################################################

.PHONY : _program
_program :
	$(_V)$(TASSCMD) --cbm-prg $(STEM).s65 -L$(DEST)/$(STEM).lst -o$(DEST)/$(STEM).prg
	$(_V)$(PRG2BBC) $(if $(IO),--io) $(DEST)/$(STEM).prg ../volumes/beeblink/$(DRIVE)/$$.$(call ucase,$(STEM))

##########################################################################
##########################################################################
#
# Builds two copies of the ROM:
#
# FS ROM: beeblink_$(ROM_SUFFIX).rom - file handles starting from $b0,
# FS number 93, unprefixed commands, intended for use as the main FS
# ROM
#
# Test ROM: beeblink_$(ROM_SUFFIX)-test.rom - file handles starting
# from $a0, FS number of 94, commands with a prefix of $(CMD_PREFIX),
# intended for use as a WIP ROM for testing purposes that can coexist
# cleanly with the main FS ROM
#
# Then copies FS ROM to $(BEEB_DEST)/R.$(ROM_BEEB_NAME), and test ROM
# to $(BEEB_DEST)/T.$(ROM_BEEB_NAME).
#
# (TODO: the test ROM maybe doesn't need a configurable command
# prefix? - under the assumption there'll be exactly one FS ROM loaded
# (the one normally in use) and one test ROM loaded (the one being
# worked on), every test ROM could have the same command prefix,
# saving on an option. But then, it probably doesn't hurt to be
# explicit.)
# 
.PHONY : _rom
_rom : _EXTRA_ARGS:="-DVERSION=\"$(VER)\"" "-DBUILD_TIME=\"$(BUILD_TIME)\"" "-DCOMMIT=\"$(COMMIT)\"" -Dlink_$(LINK)=true $(EXTRA_ARGS)
_rom : STEM:=$(DEST)/beeblink_$(ROM_SUFFIX)
_rom :
	$(_V)$(TASSCMD) --nostart beeblink.s65 -L$(STEM).lst -o$(STEM).rom $(_EXTRA_ARGS)

	$(_V)$(TASSCMD) --nostart beeblink.s65 -L$(STEM)-test.lst -o$(STEM)-test.rom $(_EXTRA_ARGS) -Dblfs_fs_number=94 -Dblfs_first_handle=160 -Dblfs_prefix=\"$(CMD_PREFIX)\"

	$(_V)$(SHELLCMD) mkdir $(BEEB_DEST)
	$(_V)$(SHELLCMD) copy-file $(STEM).rom $(BEEB_DEST)/R.$(ROM_BEEB_NAME)
	$(_V)$(SHELLCMD) copy-file $(STEM)-test.rom $(BEEB_DEST)/T.$(ROM_BEEB_NAME)

# ifdef TOM_LAPTOP

# # Create a third copy of the ROM: the FS ROM, but with some extra
# # stuff added in. This is for use in my BBC B.

# 	$(_V)$(SMLOAD_JOIN) $(STEM).rom $(HOME)/beeb/beeb-files/stuff/65boot/0/$$.TUBEROM '../../startup_rom/.build/.tmp/startup_module.rom' -o $(BEEB_DEST)/B.$(ROM_BEEB_NAME)
# 	$(_V)touch $(BEEB_DEST)/B.$(ROM_BEEB_NAME).inf

# endif

##########################################################################
##########################################################################

.PHONY : clean
clean :
	$(_V)$(SHELLCMD) rm-tree $(DEST)

##########################################################################
##########################################################################
#
# Hack, for my benefit, on my laptop. Make a second copy of the
# BeebLink ROM, specifically for my BBC B, that has some extra stuff
# in it.
# 

.PHONY : tom
tom :
