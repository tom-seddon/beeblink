# Intended for use on the Github CI runners, but

MAKEFLAGS+=--no-print-directory

##########################################################################
##########################################################################

ifeq ($(OS),Windows_NT)
PYTHON3:=py -3
NPROC:=$(NUMBER_OF_PROCESSORS)
UNAME:=Windows_NT
EXE_EXT:=.exe
else
UNAME:=$(shell uname -s)
PYTHON3:=python3
ifeq ($(UNAME),Darwin)
NPROC:=$(shell sysctl -n hw.ncpu)
else
NPROC:=$(shell nproc)
endif
EXE_EXT:=
endif

##########################################################################
##########################################################################

WORKSPACE_ROOT_PATH:=$(shell $(PYTHON3) "../../submodules/shellcmd.py/shellcmd.py" realpath "../..")

SHELLCMD:=$(PYTHON3) "$(WORKSPACE_ROOT_PATH)/submodules/shellcmd.py/shellcmd.py"

TMP_PATH:=$(WORKSPACE_ROOT_PATH)/tmp/ci

ifeq ($(UNAME),Windows_NT)

# don't bother setting the 64tass path. The ROMs makefile will find
# the repo's copy.

else

TASS_PATH:=$(TMP_PATH)/tass64-code
TASS:=$(TASS_PATH)/64tass

endif


##########################################################################
##########################################################################

BUILD_SUFFIX:=$(shell git log -1 --format=%cd-%h --date=format:%Y%m%d-%H%M%S)

ifneq ($(shell git branch --show-current),master)
BUILD_SUFFIX:=$(BUILD_SUFFIX)-prerelease
endif

ZIP_PATH:=$(TMP_PATH)/beeblink-$(BUILD_SUFFIX)$(NAME_SUFFIX).zip

NODE_VERSION:=22

##########################################################################
##########################################################################

_V:=$(if $(VERBOSE),,@)

##########################################################################
##########################################################################

.PHONY:default
default:
	$(error Must specify target)

##########################################################################
##########################################################################

.PHONY: github_ci_windows
github_ci_windows:
	$(_V)$(MAKE) _init
	$(_V)$(MAKE) _roms
	$(_V)$(MAKE) _server TARGET=node$(NODE_VERSION)-win-x64
	$(_V)$(MAKE) _create_zip

.PHONY: github_ci_macos_intel
github_ci_macos_intel:
	$(_V)$(MAKE) _init
	$(_V)$(MAKE) _install_prerequisites_macos
	$(_V)$(MAKE) _compile_64tass
	$(_V)$(MAKE) _roms
	$(_V)$(MAKE) _server TARGET=node$(NODE_VERSION)-macos-x64
	$(_V)$(MAKE) _create_zip

.PHONY: github_ci_macos_arm
github_ci_macos_arm:
	$(_V)$(MAKE) _init
	$(_V)$(MAKE) _install_prerequisites_macos
	$(_V)$(MAKE) _compile_64tass
	$(_V)$(MAKE) _roms
	$(_V)$(MAKE) _server TARGET=node$(NODE_VERSION)-macos-arm64
	$(_V)$(MAKE) _create_zip

##########################################################################
##########################################################################

# Currently no need - there's a prebuilt copy of svn in the repo
# already.

# .PHONY:_install_prerequisites_windows
# _install_prerequisites_windows:
# ifdef INSTALL_PREREQUISITES
# 	@echo XXX
# 	@echo XXX Install prerequisites
# 	@echo XXX
# 	$(_V)choco install svn
# else
# 	@echo XXX
# 	@echo XXX (Skipping prerequisites)
# 	@echo XXX
# endif

##########################################################################
##########################################################################

.PHONY:_install_prerequisites_macos
_install_prerequisites_macos:
ifdef INSTALL_PREREQUISITES
	@echo XXX
	@echo XXX Install prerequisites
	@echo XXX
	$(_V)brew install subversion
else
	@echo XXX
	@echo XXX (Skipping prerequisites)
	@echo XXX
endif

##########################################################################
##########################################################################

.PHONY:_server
_server:
	@echo XXX
	@echo XXX Build server
	@echo XXX

	$(_V)cd "$(WORKSPACE_ROOT_PATH)/server" && npm install
	$(_V)cd "$(WORKSPACE_ROOT_PATH)/server" && npm run compile
	$(_V)cd "$(WORKSPACE_ROOT_PATH)/server" && "./node_modules/.bin/pkg" -t $(TARGET) --out-path "$(TMP_PATH)" .

##########################################################################
##########################################################################

.PHONY:_roms
_roms:
	@echo XXX
	@echo XXX Build ROMs
	@echo XXX
	$(_V)cd "$(WORKSPACE_ROOT_PATH)/beeb" && $(MAKE) roms CI_BUILD=1 $(if $(TASS),TASS=$(TASS),)

.PHONY:_init
_init:
	@echo BUILD_SUFFIX: $(BUILD_SUFFIX)
	@echo OS: $(OS)
	@echo SHELL: $(SHELL)
	@echo SHELLCMD: $(SHELLCMD)
	@echo TASS_PATH: $(TASS_PATH)
	@echo TMP_PATH: $(TMP_PATH)
	@echo UNAME: $(UNAME)
	@echo WORKSPACE_ROOT_PATH: $(WORKSPACE_ROOT_PATH)
	@echo ZIP_PATH: $(ZIP_PATH)

	$(_V)$(SHELLCMD) rm-tree "$(TMP_PATH)"
	$(_V)$(SHELLCMD) mkdir "$(TMP_PATH)"

##########################################################################
##########################################################################

# only done on Unix, so can assume POSIX-style tools.
.PHONY:_compile_64tass
_compile_64tass:
	@echo XXX
	@echo XXX Build 64tass
	@echo XXX

	$(_V)cd "$(TMP_PATH)" && svn checkout $(if $(VERBOSE),,--quiet) https://svn.code.sf.net/p/tass64/code/trunk tass64-code
	$(_V)cd "$(TASS_PATH)" && make -j $(NPROC)

##########################################################################
##########################################################################

# testing with some random build, using -mx=9 saved ~270 KBytes, with
# total archive size being ~21 MBytes. And it took quite a lot longer.

.PHONY:_create_zip
_create_zip: _ARGS:=
_create_zip:
	@echo XXX
	@echo XXX Create .zip
	@echo XXX
	$(_V)cd "$(WORKSPACE_ROOT_PATH)/beeb/.build" && 7z a $(_ARGS) "$(ZIP_PATH)" "beeblink_avr_fe60.rom" "beeblink_tube_serial.rom" "beeblink_tube_serial_safe.rom" "beeblink_upurs_fe60.rom" "beeblink_tube_serial_electron.rom" "beeblink_tube_serial_safe_electron.rom" "beeblink_b2.rom"
	$(_V)cd "$(TMP_PATH)" && 7z a $(_ARGS) "$(ZIP_PATH)" "beeblink-server$(EXE_EXT)"
	$(_V)cd "$(WORKSPACE_ROOT_PATH)" && 7z a "$(ZIP_PATH)" $(_ARGS) "volumes" "COPYING.txt"
