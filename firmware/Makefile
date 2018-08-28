# COMPILER_PATH:=@
WC:=..
MCU:=atmega32u2
ARCH:=AVR8
BOARD:=MINIMUS
F_CPU:=16000000
F_USB:=$(F_CPU)
OPTIMIZATION:=s
TARGET:=beeblink
SRC=beeblink.c usb.c serial.c $(LUFA_SRC_USB)
LUFA_PATH:=$(WC)/submodules/lufa/LUFA/
CC_FLAGS:=-Wall -std=c99 -DFIXED_CONTROL_ENDPOINT_SIZE=32 -DUSB_DEVICE_ONLY '-DUSB_PRODUCT_STRING="BeebLink"' -DUSB_VID=0x3eb -DUSB_PID=0x206c -Werror=implicit-function-declaration -DUSB_TIMEOUT_MS=500
# CC_FLAGS:=$(CC_FLAGS) -DEA_INPUT_PACKET_SIZE=8 -DEA_OUTPUT_PACKET_SIZE=8
LD_FLAGS:=
CTAGS:=exuberant-ctags
CTAGS_OPTS:=--C-kinds=+px -e --totals=yes
OBJDIR:=./.build
TYPESCRIPT_CONSTANTS:=$(WC)/server2/beeblink.ts
C_CONSTANTS:=$(OBJDIR)/beeblink_constants.h

# Don't call this `all'. LUFA unhelpfully has an `all' target of its
# own, which if made phony adds a bunch of (rather verbose) stuff to
# the build.
.PHONY:beeblink_all
beeblink_all: $(C_CONSTANTS) lss tags dfu2 

$(C_CONSTANTS) : $(TYPESCRIPT_CONSTANTS) $(WC)/tools/make_constants.py
	python $(WC)/tools/make_constants.py -o $@ $(TYPESCRIPT_CONSTANTS) c

# Programs in the target FLASH memory using DFU-PROGRAMMER
dfu2: $(TARGET).hex $(MAKEFILE_LIST)
	@echo $(MSG_DFU_CMD) Programming FLASH with dfu-programmer using \"$<\"
	dfu-programmer $(MCU) erase
	dfu-programmer $(MCU) flash $<
#	dfu-programmer $(MCU) reset

include $(LUFA_PATH)/Build/lufa_core.mk
include $(LUFA_PATH)/Build/lufa_sources.mk
include $(LUFA_PATH)/Build/lufa_build.mk
include $(LUFA_PATH)/Build/lufa_cppcheck.mk
include $(LUFA_PATH)/Build/lufa_doxygen.mk
include $(LUFA_PATH)/Build/lufa_dfu.mk
include $(LUFA_PATH)/Build/lufa_hid.mk
include $(LUFA_PATH)/Build/lufa_avrdude.mk
include $(LUFA_PATH)/Build/lufa_atprogram.mk

.PHONY:tags
tags:
	@$(CTAGS) $(CTAGS_OPTS) -R $(SRC) . /opt/local/avr/include
	@$(CTAGS) $(CTAGS_OPTS) -R --append=yes $(LUFA_PATH)Common/*.h $(LUFA_PATH)Drivers/Board/AVR8/MINIMUS/*.h $(LUFA_PATH)CodeTemplates/*.h $(LUFA_PATH)CodeTemplates/DeviceTemplate/*.h $(LUFA_PATH)CodeTemplates/DriverStubs/*.h $(LUFA_PATH)CodeTemplates/HostTemplate/*.h $(LUFA_PATH)Common/*.h $(LUFA_PATH)Drivers/Board/*.h $(LUFA_PATH)Drivers/Board/AVR8/MINIMUS/*.h $(LUFA_PATH)Drivers/Misc/*.h $(LUFA_PATH)Drivers/Peripheral/*.h $(LUFA_PATH)Drivers/Peripheral/AVR8/*.h $(LUFA_PATH)Drivers/USB/*.h $(LUFA_PATH)Drivers/USB/Class/*.h $(LUFA_PATH)Drivers/USB/Class/Common/*.h $(LUFA_PATH)Drivers/USB/Class/Device/*.h $(LUFA_PATH)Drivers/USB/Class/Host/*.h $(LUFA_PATH)Drivers/USB/Core/*.h $(LUFA_PATH)Drivers/USB/Core/AVR8/*.h $(LUFA_PATH)Platform/*.h

clean: beeblink_clean

.PHONY:beeblink_clean
beeblink_clean:
	@echo $(MSG_REMOVE_CMD) Removing BeebLink constants file
	rm -f $(C_CONSTANTS)

