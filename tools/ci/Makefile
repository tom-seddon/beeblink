# Intended for use on the Github CI runners, but

MAKEFLAGS+=--no-print-directory

##########################################################################
##########################################################################

ifeq ($(OS),Windows_NT)
PYTHON3:=py -3
NPROC:=$(NUMBER_OF_PROCESSORS)
UNAME:=Windows_NT
else
UNAME:=$(shell uname -s)
PYTHON3:=python3
ifeq ($(UNAME),Darwin)
NPROC:=$(shell sysctl -n hw.ncpu)
else
NPROC:=$(shell nproc)
endif
endif

##########################################################################
##########################################################################

WORKSPACE_ROOT_PATH:=$(shell $(PYTHON3) "../../submodules/shellcmd.py/shellcmd.py" realpath "../..")

SHELLCMD:=$(PYTHON3) "$(WORKSPACE_ROOT_PATH)/submodules/shellcmd/shellcmd.py"

TMP_PATH:=$(WORKSPACE_ROOT_PATH)/tmp

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
	$(_V)$(MAKE) _debug_output
	$(_V)$(MAKE) _roms
	$(_V)$(MAKE) _server TARGET=node$(NODE_VERSION)-win-x64

.PHONY: github_ci_macos_intel
github_ci_macos_intel:
	$(_V)$(MAKE) _debug_output
	$(_V)$(MAKE) _install_prerequisites_macos
	$(_V)$(MAKE) _compile_64tass
	$(_V)$(MAKE) _roms
	$(_V)$(MAKE) _server TARGET=node$(NODE_VERSION)-macos-x64

.PHONY: github_ci_macos_arm
github_ci_macos_arm:
	$(_V)$(MAKE) _debug_output
	$(_V)$(MAKE) _install_prerequisites_macos
	$(_V)$(MAKE) _compile_64tass
	$(_V)$(MAKE) _roms
	$(_V)$(MAKE) _server TARGET=node$(NODE_VERSION)-macos-arm64

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

.PHONY:_debug_output
_debug_output:
	$(_V)echo WORKSPACE_ROOT_PATH: $(WORKSPACE_ROOT_PATH)
	$(_V)ECHO SHELLCMD: $(SHELLCMD)
	$(_V)echo OS: $(OS)
	$(_V)echo UNAME: $(UNAME)
	$(_V)echo SHELL: $(SHELL)
	$(_V)echo BUILD_SUFFIX: $(BUILD_SUFFIX)
	$(_V)echo TMP_PATH: $(TMP_PATH)
	$(_V)echo TASS_PATH: $(TASS_PATH)

##########################################################################
##########################################################################

# only done on Unix, so assumes POSIX-style tools.
.PHONY:_compile_64tass
_compile_64tass:
	@echo XXX
	@echo XXX Build 64tass
	@echo XXX

	$(_V)rm -Rf "$(TASS_PATH)"
	$(_V)mkdir -p "$(TMP_PATH)"
	$(_V)cd "$(TMP_PATH)" && svn checkout $(if $(VERBOSE),,--quiet) https://svn.code.sf.net/p/tass64/code/trunk tass64-code
	$(_V)cd "$(TASS_PATH)" && make -j $(NPROC)

