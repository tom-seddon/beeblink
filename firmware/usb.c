//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
// Copyright (C) 2018 Tom Seddon
// 
// This program is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
// 
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with this program. If not, see
// <https://www.gnu.org/licenses/>.
//
//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#include <LUFA/Common/Common.h>
#include <LUFA/Drivers/Board/LEDs.h>
#include <LUFA/Drivers/USB/USB.h>
#include <setjmp.h>
#include "usb.h"

#ifndef USB_PRODUCT_STRING
#error must define USB_PRODUCT_STRING
#endif

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

enum
{
    NUM_DPRAM_BYTES=FIXED_CONTROL_ENDPOINT_SIZE+EA_INPUT_PACKET_SIZE*EA_INPUT_NUM_BUFFERS+EA_OUTPUT_PACKET_SIZE*EA_OUTPUT_NUM_BUFFERS,
};
typedef char CheckDPRAMUsage[NUM_DPRAM_BYTES<=176?1:-NUM_DPRAM_BYTES];
    
//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

enum StringDescriptorIndex
{
    SDI_LANGUAGE,
    SDI_MANUFACTURER,
    SDI_PRODUCT,
    SDI_SERIAL,
};

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define USB_STRING(NAME,STR) const USB_Descriptor_String_t PROGMEM NAME={.Header={.Size=USB_STRING_LEN(sizeof STR/2-1),.Type=DTYPE_String},.UnicodeString={STR}};

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static const USB_Descriptor_String_t PROGMEM LANGUAGE_STRING={
    .Header={
	.Size=USB_STRING_LEN(1),
	.Type=DTYPE_String,
    },
    .UnicodeString={
	LANGUAGE_ID_ENG,
    },
};

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define WC(X) WC2(X)
#define WC2(X) L##X

static const USB_STRING(MANUFACTURER_STRING,L"Tom Seddon");
static const USB_STRING(PRODUCT_STRING,WC(USB_PRODUCT_STRING));
static const USB_STRING(SERIAL_STRING,WC(__DATE__) L" at " WC(__TIME__));

static const USB_Descriptor_String_t *const STRINGS[] PROGMEM={
    [SDI_LANGUAGE]=&LANGUAGE_STRING,
    [SDI_MANUFACTURER]=&MANUFACTURER_STRING,
    [SDI_PRODUCT]=&PRODUCT_STRING,
    [SDI_SERIAL]=&SERIAL_STRING,
};

enum
{
    NUM_STRINGS=sizeof STRINGS/sizeof STRINGS[0],
};

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// https://github.com/pbatard/libwdi/wiki/WCID-Devices#Implementation

#define WCID_VENDOR_ID (0x65)

static const uint8_t WCID_STRING_DESCRIPTOR[] PROGMEM={
    0x12,//size
    0x03,//type
    'M',0,'S',0,'F',0,'T',0,'1',0,'0',0,'0',0,//"MSFT100" signature
    WCID_VENDOR_ID,//vendor code
    0x00,//padding
};
typedef char CheckWCIDStringDescriptorSize[sizeof(WCID_STRING_DESCRIPTOR)==0x12?1:-1];

static const uint8_t WCID_FEATURE_DESCRIPTOR[] PROGMEM={
    0x28,0x00,0x00,0x00,//length
    0x00,0x01,//version
    0x04,0x00,//compatibility ID descriptor index
    0x01,//# sections
    0,0,0,0,0,0,0,//reserved
    0x00,//interface number
    0x01,//reserved
    'W','I','N','U','S','B',0,0,//compatible ID
    0,0,0,0,0,0,0,0,//sub-compatible ID (unused)
    0,0,0,0,0,0,//reserved
};
typedef char CheckWCIDFeatureDescriptorSize[sizeof WCID_FEATURE_DESCRIPTOR==0x28?1:-1];

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static const USB_StdDescriptor_Device_t PROGMEM DEVICE_DESCRIPTOR={
    .bLength=sizeof(USB_StdDescriptor_Device_t),
    .bDescriptorType=DTYPE_Device,
    .bcdUSB=VERSION_BCD(2,0,0),
    .bDeviceClass=0xFF,
    .bDeviceSubClass=0xFF,
    .bDeviceProtocol=0xFF,
    .bMaxPacketSize0=FIXED_CONTROL_ENDPOINT_SIZE,
    .idVendor=USB_VID,
    .idProduct=USB_PID,
    .bcdDevice=VERSION_BCD(1,0,0),
    .iManufacturer=SDI_MANUFACTURER,
    .iProduct=SDI_PRODUCT,
    .iSerialNumber=SDI_SERIAL,
    .bNumConfigurations=1,
};

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

struct Descriptor
{
    USB_StdDescriptor_Configuration_Header_t header;
    USB_StdDescriptor_Interface_t interface;
    USB_StdDescriptor_Endpoint_t data_in,data_out;
};

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static const struct Descriptor PROGMEM CONFIGURATION_DESCRIPTOR={
    .header={
	.bLength=sizeof(USB_StdDescriptor_Configuration_Header_t),
	.bDescriptorType=DTYPE_Configuration,
	.wTotalLength=sizeof(struct Descriptor),
	.bNumInterfaces=1,
	.bConfigurationValue=1,
	.iConfiguration=NO_DESCRIPTOR,
	.bmAttributes=USB_CONFIG_ATTR_RESERVED,
	.bMaxPower=USB_CONFIG_POWER_MA(100),
    },
    .interface={
	.bLength=sizeof(USB_StdDescriptor_Interface_t),
	.bDescriptorType=DTYPE_Interface,
	.bInterfaceNumber=0,
	.bAlternateSetting=0,
	.bNumEndpoints=2,
	.bInterfaceClass=0xFF,
	.bInterfaceSubClass=0xFF,
	.bInterfaceProtocol=0xFF,
	.iInterface=NO_DESCRIPTOR,
    },

    // IN writes TO the pc
    .data_in={
	.bLength=sizeof(USB_StdDescriptor_Endpoint_t),
	.bDescriptorType=DTYPE_Endpoint,
	.bEndpointAddress=EA_INPUT,
	.bmAttributes=EP_TYPE_BULK,
	.wMaxPacketSize=EA_INPUT_PACKET_SIZE,
	.bInterval=1,
    },

    // OUT reads FROM the pc 
    .data_out={
	.bLength=sizeof(USB_StdDescriptor_Endpoint_t),
	.bDescriptorType=DTYPE_Endpoint,
	.bEndpointAddress=EA_OUTPUT,
	.bmAttributes=EP_TYPE_BULK,
	.wMaxPacketSize=EA_OUTPUT_PACKET_SIZE,
	.bInterval=1,
    },
};

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

uint16_t CALLBACK_USB_GetDescriptor(const uint16_t wValue,
				    const uint16_t wIndex,
				    const void **const DescriptorAddress,
				    uint8_t *const DescriptorMemorySpace)
{
    uint8_t type=wValue>>8,index=wValue&0xFF;

    if(type==DTYPE_String)
    {
	if(index<NUM_STRINGS)
	{
	    *DescriptorAddress=(void *)pgm_read_word(&STRINGS[index]);
	    *DescriptorMemorySpace=MEMSPACE_FLASH;
	    return pgm_read_byte(*DescriptorAddress);
	}
	else if(index==0xEE)
	{
	    // WCID.
	    *DescriptorAddress=(void *)WCID_STRING_DESCRIPTOR;
	    *DescriptorMemorySpace=MEMSPACE_FLASH;
	    return pgm_read_byte(WCID_STRING_DESCRIPTOR);
	}
    }
    else if(type==DTYPE_Device)
    {
	*DescriptorAddress=&DEVICE_DESCRIPTOR;
	*DescriptorMemorySpace=MEMSPACE_FLASH;
	return sizeof DEVICE_DESCRIPTOR;
    }
    else if(type==DTYPE_Configuration)
    {
	*DescriptorAddress=&CONFIGURATION_DESCRIPTOR;
	*DescriptorMemorySpace=MEMSPACE_FLASH;
	return sizeof CONFIGURATION_DESCRIPTOR;
    }

    return NO_DESCRIPTOR;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

void EVENT_USB_Device_ConfigurationChanged(void)
{
    Endpoint_ConfigureEndpoint(EA_INPUT,EP_TYPE_BULK,EA_INPUT_PACKET_SIZE,EA_INPUT_NUM_BUFFERS);
    Endpoint_ConfigureEndpoint(EA_OUTPUT,EP_TYPE_BULK,EA_OUTPUT_PACKET_SIZE,EA_OUTPUT_NUM_BUFFERS);
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

void usb_init(void)
{
    USB_Init(USB_DEVICE_OPT_FULLSPEED);
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

void usb_handle_control_request(void)
{
    if((USB_ControlRequest.bmRequestType&(CONTROL_REQTYPE_TYPE|CONTROL_REQTYPE_RECIPIENT|CONTROL_REQTYPE_DIRECTION))==(REQTYPE_VENDOR|REQREC_DEVICE|REQDIR_DEVICETOHOST))
    {
	if(USB_ControlRequest.bRequest==WCID_VENDOR_ID&&USB_ControlRequest.wIndex==0x0004)
	{
	    Endpoint_ClearSETUP();
	    Endpoint_Write_Control_PStream_LE(WCID_FEATURE_DESCRIPTOR,sizeof WCID_FEATURE_DESCRIPTOR);
	    Endpoint_ClearStatusStage();
	    return;
	}
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
