# Intended for use on the Github CI runners, but

MAKEFLAGS+=--no-print-directory

##########################################################################
##########################################################################

WORKSPACE_ROOT_PATH:=$(abspath ../..)

##########################################################################
##########################################################################

ifeq ($(OS),Windows_NT)

PYTHON3:=py -3

NPROC:=$(NUMBER_OF_PROCESSORS)

# don't bother setting the 64tass path. The ROMs makefile will find
# the repo's copy.

else

UNAME:=$(shell uname -s)

PYTHON3:=python3

ifeq ($(UNAME),Darwin)
NPROC:=$(shell sysctl -n hw.ncpu)
else
NPROC:=$(shell nproc)
endif

TMP_PATH:=$(WORKSPACE_ROOT_PATH)/tmp
TASS_PATH:=$(TMP_PATH)/tass64-code
TASS:=$(TASS_PATH)/64tass

endif

##########################################################################
##########################################################################

_V:=$(if $(VERBOSE),,@)

BUILD_SUFFIX:=$(shell git log -1 --format=%cd-%h --date=format:%Y%m%d-%H%M%S)

##########################################################################
##########################################################################

.PHONY:default
default:
	$(error Must specify target)

##########################################################################
##########################################################################

.PHONY: github_ci_windows
github_ci_windows:
	$(_V)$(MAKE) _debug_output
	$(_V)$(MAKE) _install_prerequisites_windows
	$(_V)$(MAKE) _compile_64tass
	$(_V)$(MAKE) _roms
	$(_V)$(MAKE) _server TARGET=win-x64

.PHONY: github_ci_macos_intel
github_ci_macos_intel:
	$(_V)$(MAKE) _debug_output
	$(_V)$(MAKE) _install_prerequisites_macos
	$(_V)$(MAKE) _compile_64tass
	$(_V)$(MAKE) _roms
	$(_V)$(MAKE) _server TARGET=macos-x64

.PHONY: github_ci_macos_arm
github_ci_macos_arm:
	$(_V)$(MAKE) _debug_output
	$(_V)$(MAKE) _install_prerequisites_macos
	$(_V)$(MAKE) _compile_64tass
	$(_V)$(MAKE) _roms
	$(_V)$(MAKE) _server TARGET=macos-arm64

##########################################################################
##########################################################################

.PHONY:_install_prerequisites_windows
_install_prerequisites_windows:
ifdef INSTALL_PREREQUISITES
	@echo "***"
	@echo "*** Install prerequisites"
	@echo "***"
	$(_V)choco install svn
else
	@echo "***"
	@echo "*** (Skipping prerequisites)"
	@echo "***"
endif

##########################################################################
##########################################################################

.PHONY:_install_prerequisites_macos
_install_prerequisites_macos:
ifdef INSTALL_PREREQUISITES
	@echo "***"
	@echo "*** Install prerequisites"
	@echo "***"
	$(_V)sudo brew install subversion
else
	@echo "***"
	@echo "*** (Skipping prerequisites)"
	@echo "***"
endif

##########################################################################
##########################################################################

.PHONY:_server
_server:
	@echo "***"
	@echo "*** Build server"
	@echo "***"

	$(_V)cd "$(WORKSPACE_ROOT_PATH)/server" && npm install
	$(_V)cd "$(WORKSPACE_ROOT_PATH)/server" && npm run compile
	$(_V)cd "$(WORKSPACE_ROOT_PATH)/server" && ./node_modules/.bin/pkg -t $(TARGET) --out-path "$(TMP_PATH)" .

##########################################################################
##########################################################################

.PHONY:_roms
_roms:
	@echo "***"
	@echo "*** Build ROMs"
	@echo "***"

	$(_V)cd "$(WORKSPACE_ROOT_PATH)/beeb" && $(MAKE) roms CI_BUILD=1 "TASS=$(TASS)"

.PHONY:_debug_output
_debug_output:
	$(_V)echo SHELL: $(SHELL)
	$(_V)echo BUILD_SUFFIX: $(BUILD_SUFFIX)
	$(_V)echo TMP_PATH: $(TMP_PATH)
	$(_V)echo TASS_PATH: $(TASS_PATH)

##########################################################################
##########################################################################

# only done on Unix, so assumes POSIX-style tools.
.PHONY:_compile_64tass
_compile_64tass:
	@echo "***"
	@echo "*** Build 64tass"
	@echo "***"

	$(_V)rm -Rf "$(TASS_PATH)"
	$(_V)mkdir -p "$(TMP_PATH)"
	$(_V)cd "$(TMP_PATH)" && svn checkout $(if $(VERBOSE),,--quiet) https://svn.code.sf.net/p/tass64/code/trunk tass64-code
	$(_V)cd "$(TASS_PATH)" && make -j $(NPROC)

