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
#include <LUFA/Drivers/Board/Buttons.h>
#include <LUFA/Drivers/USB/USB.h>
#include <avr/wdt.h>
#include <avr/power.h>
#include <setjmp.h>
#include <avr/pgmspace.h>
#include "usb.h"
#include <util/atomic.h>
#include <avr/cpufunc.h>
#include <setjmp.h>
#include "serial.h"

#include ".build/beeblink_constants.h"

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define WARN_UNUSED __attribute__((warn_unused_result))
#define NOINLINE __attribute__((noinline))

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define BBC_CB1 (1<<6)
#define BBC_CB2 (1<<7)          /* Data Ready from the Beeb */

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define LEDS_BLUE (LEDS_LED1)
#define LEDS_RED (LEDS_LED2)

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

/* if true, log every payload byte in
 * SendPacketHeaderAndForwardPayload. */
#define VERBOSE_FORWARD_PAYLOAD 1

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

struct PacketTypeBits {
    uint8_t c:7;
    uint8_t v:1;
};
typedef struct PacketTypeBits PacketTypeBits;

union PacketType {
    PacketTypeBits bits;
    uint8_t all;
};
typedef union PacketType PacketType;

_Static_assert(sizeof(PacketType)==1,"");

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define ERRORS                                                  \
    /* No error */                                              \
    ERROR(None,0)                                               \
                                                                \
    /* BBC didn't do its side of the handshake in time */       \
    ERROR(NoBeebHandshake)                                      \
                                                                \
    /* BBC requested a reset */                                 \
    ERROR(Reset)                                                \
                                                                \
    /* These map to the LUFA Endpoint_WaitUntilReady results */ \
    ERROR(USBEndpointStalled)                                   \
    ERROR(USBDeviceDisconnected)                                \
    ERROR(USBBusSuspended)                                      \
    ERROR(USBTimeout)                                           \
    ERROR(USB)

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

enum Error {
#define ERROR(NAME,...) Error_##NAME,
    ERRORS
#undef ERROR
};
typedef enum Error Error;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define ERROR(NAME,...) static const char g_error_##NAME##_name_pstr[] PROGMEM=#NAME;
ERRORS
#undef ERROR

static const char *const g_error_name_pstrs[] PROGMEM={
#define ERROR(NAME,...) [Error_##NAME]=g_error_##NAME##_name_pstr,
    ERRORS
#undef ERROR
};

#define GetErrorNamePStr(ERROR) (pgm_read_ptr(&g_error_name_pstrs[ERROR]))

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static const char wait_for_bbc_msg[] PROGMEM="\n.. Recv request from BBC...\n";

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static uint8_t g_num_loops=0;
static uint8_t g_num_wait_for_CB2_high_loops=0;
static uint8_t g_last_WUR_result=0;
static PacketType g_last_request_type={0,};

/* static uint32_t g_num_bytes_sent_host_to_beeb=0; */
/* static uint32_t g_num_bytes_sent_beeb_to_host=0; */

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static void WaitForBeebReady(void *context) {
    uint16_t counter=0;
    
    while(PINC&BBC_CB2) {
        USB_USBTask();

        ++counter;
        if(counter==0) {
            if(context) {
                uint8_t *flag=context;

                if(!*flag) {
                    serial_ps(wait_for_bbc_msg);
                    *flag=1;
                }
            }
        }
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static Error WARN_UNUSED AckAndCheck(void) {
    Error result=Error_None;
    
    PORTC&=~BBC_CB1;

    /* in handshake mode, CB2 ought to go high within 1-2usec, so
     * _delay_us(1.0) followed by a check of PINC ought to be enough.
     * This appeared to be 100% unreliable for me, even with a 10usec
     * delay, so here's a spin loop instead - that of course always
     * seems to finish within 1 iteration :-|
     */
    g_num_wait_for_CB2_high_loops=0;
    while(!(PINC&BBC_CB2)) {
        ++g_num_wait_for_CB2_high_loops;
        if(g_num_wait_for_CB2_high_loops>10) {
            SERIAL_PSTR("!! AckAndCheck: CB2 still low.\n");

            /* Error. */
            while(!(PINC&BBC_CB2)) {
                USB_USBTask();
            }

            result=Error_NoBeebHandshake;
        }
    }
    
    PORTC|=BBC_CB1;

    return result;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static Error WARN_UNUSED NOINLINE ReceiveByteFromBeeb(uint8_t *value,
                                                      void *context)
{
    Error err;
    
    /* Things seem a bit unreliable unless DDRB is set somewhat in
     * advance of the read. */
    DDRB=0;
    
    WaitForBeebReady(context);

    *value=PINB;

    err=AckAndCheck();
    if(err!=Error_None) {
        return err;
    }

    return Error_None;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static Error WARN_UNUSED SendByteToBeeb(uint8_t value,
                                        void *context)
{
    Error err;
    
    /* Things seem a bit unreliable unless DDRB is set somewhat in
     * advance of the write. */
    DDRB=255;
    
    WaitForBeebReady(context);

    PORTB=value;

    err=AckAndCheck();
    if(err!=Error_None) {
        return err;
    }

    return Error_None;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static Error WARN_UNUSED WaitUntilEndpointReady(void) {
    do {
        g_last_WUR_result=Endpoint_WaitUntilReady();
    } while(g_last_WUR_result==ENDPOINT_READYWAIT_Timeout);

    switch(g_last_WUR_result) {
    case ENDPOINT_READYWAIT_NoError:
        return Error_None;
        
    case ENDPOINT_READYWAIT_EndpointStalled:
        return Error_USBEndpointStalled;
        
    case ENDPOINT_READYWAIT_DeviceDisconnected:
        return Error_USBDeviceDisconnected;

    case ENDPOINT_READYWAIT_BusSuspended:
        return Error_USBBusSuspended;
        
    case ENDPOINT_READYWAIT_Timeout:
        return Error_USBTimeout;

    default:
        /* Better suggestions welcome. */
        return Error_USB;
    }
}

static Error WARN_UNUSED ReceiveByteFromHost(uint8_t *value,
                                             void *context)
{
    Error err;
    
    if(!Endpoint_IsReadWriteAllowed()) {
        err=WaitUntilEndpointReady();
        if(err!=Error_None) {
            return err;
        }
    }

    *value=Endpoint_Read_8();

    if(!Endpoint_IsReadWriteAllowed()) {
        Endpoint_ClearOUT();
    }

    return Error_None;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static Error WARN_UNUSED SendByteToHost(uint8_t value,
                                        void *context)
{
    Error err;
    
    if(!Endpoint_IsReadWriteAllowed()) {
        Endpoint_ClearIN();

        err=WaitUntilEndpointReady();
        if(err!=Error_None) {
            return err;
        }
    }
        
    Endpoint_Write_8(value);

    return Error_None;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

struct PacketHeader {
    PacketType t;
    uint8_t p;                  /* if !h.v */
    uint8_t p_size[4];          /* if h.v */
};
typedef struct PacketHeader PacketHeader;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static void serial_PacketHeader(const char *prefix_pstr,
                                const PacketHeader *ph)
{
    if(prefix_pstr) {
        serial_ps(prefix_pstr);
    }

    SERIAL_PSTR("t={v=");
    serial_ch(ph->t.bits.v?'1':'0');
    SERIAL_PSTR(" c=");
    serial_x8(ph->t.bits.c);
    SERIAL_PSTR("} ");

    if(ph->t.bits.v) {
        SERIAL_PSTR("p_size=0x");
        serial_x8(ph->p_size[3]);
        serial_x8(ph->p_size[2]);
        serial_x8(ph->p_size[1]);
        serial_x8(ph->p_size[0]);
    } else {
        SERIAL_PSTR("p=0x");
        serial_x8(ph->p);
    }

    serial_ch('\n');
}

#define SERIAL_PACKET_HEADER(PREFIX,PH)         \
    (serial_PacketHeader(PSTR(PREFIX),PH))

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static Error WARN_UNUSED NOINLINE ReceivePacketHeader(
    PacketHeader *ph,
    Error WARN_UNUSED (*recv_fn)(uint8_t *,void *),
    void *recv_context,
    uint8_t receiving_from_beeb,
    uint8_t leds_state)
{
    Error err;

    err=(*recv_fn)(&ph->t.all,recv_context);
    if(err!=Error_None) {
        if(receiving_from_beeb&&
           err==Error_NoBeebHandshake)
        {
            /* Minor fudge... */
            err=Error_Reset;
        }
        
        return err;
    }

    LEDs_SetAllLEDs(leds_state);
    
    if(receiving_from_beeb) {
        if(ph->t.bits.c==REQUEST_AVR_PRESENCE) {
            /* AVR presence check. Just ignore. */
            return Error_None;
        }
    }

    if(ph->t.bits.v) {
        for(uint8_t i=0;i<4;++i) {
            err=(*recv_fn)(&ph->p_size[i],recv_context);
            if(err!=Error_None) {
                return err;
            }
        }
    } else {
        err=(*recv_fn)(&ph->p,recv_context);
        if(err!=Error_None) {
            return err;
        }

        /* set p_size in this case?? */
    }

    return Error_None;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static void SetPayloadSize(PacketHeader *ph,uint32_t p_size) {
    ph->p_size[0]=p_size>>0;
    ph->p_size[1]=p_size>>8;
    ph->p_size[2]=p_size>>16;
    ph->p_size[3]=p_size>>24;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static uint32_t GetPayloadSize(const PacketHeader *ph) {
    return (ph->p_size[0]|
            ph->p_size[1]<<8|
            (uint32_t)ph->p_size[2]<<16|
            (uint32_t)ph->p_size[3]<<24);
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static int IsVerboseRequestType(PacketType t) {
    switch(t.bits.c) {
    case REQUEST_READ_STRING:
    case REQUEST_OSBGET:
    case REQUEST_OSBPUT:
        /* Stay quiet - these tend to come in bunches. */
        return 0;
        
    case REQUEST_OSFILE:
    case REQUEST_OSGBPB:
        /* Stay quiet - these involve a lot of data. */
        return 0;

    default:
        return 1;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static int IsVerboseRequest(const PacketHeader *ph) {
    if(ph) {
        return IsVerboseRequestType(ph->t);
    } else {
        return 0;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define MAX_NUM_DUMP_BYTES (50)

/* Bit 12 of the counter will toggle about 10-20 times/second. */
#define LED_FLICKER_MASK (1<<12)

const uint16_t toggle_mask=1<<12;
        

static Error WARN_UNUSED NOINLINE SendPacketHeaderAndForwardPayload(
    const PacketHeader *request_ph,
    const PacketHeader *response_ph,
    Error WARN_UNUSED (*send_fn)(uint8_t,void *),void *send_context,
    Error WARN_UNUSED (*recv_fn)(uint8_t *,void *),void *recv_context,
    uint8_t led_constant,uint8_t led_flicker)
{
    Error err;

    err=(*send_fn)(response_ph->t.all,send_context);
    if(err!=Error_None) {
        return err;
    }

    if(response_ph->t.bits.v) {
        for(uint8_t i=0;i<4;++i) {
            err=(*send_fn)(response_ph->p_size[i],send_context);
            if(err!=Error_None) {
                return err;
            }
        }

        uint32_t p_size=GetPayloadSize(response_ph);

#if VERBOSE_FORWARD_PAYLOAD
        int initially_verbose=IsVerboseRequest(request_ph);
        int verbose=initially_verbose;
#endif

#if VERBOSE_FORWARD_PAYLOAD
        if(verbose) {
            SERIAL_PSTR("-- p_size=");
            serial_u32(p_size);
            serial_ch('\n');
        }
#endif

        for(uint32_t i=0;i<p_size;++i) {
            uint8_t x;

#if VERBOSE_FORWARD_PAYLOAD
            /* The output usually isn't very interesting past the
             * first hundred bytes or so... */
            if(p_size>MAX_NUM_DUMP_BYTES) {
                if(i==MAX_NUM_DUMP_BYTES/2) {
                    if(verbose) {
                        SERIAL_PSTR("-- (eliding transfer)\n");
                    }
                    verbose=0;
                } else if(i==p_size-MAX_NUM_DUMP_BYTES/2) {
                    verbose=initially_verbose;
                }
            }
                
            if(verbose) {
                SERIAL_PSTR("-- ");
                serial_u32(i);
                serial_ch('/');
                serial_u32(p_size);
                SERIAL_PSTR("; recv ");
            }
#endif

            if((led_constant|led_flicker)!=0) {
                LEDs_SetAllLEDs(led_constant|
                                (i&LED_FLICKER_MASK?led_flicker:0));
            }
            
            err=(*recv_fn)(&x,recv_context);
            if(err!=Error_None) {
                return err;
            }

#if VERBOSE_FORWARD_PAYLOAD
            if(verbose) {
                serial_x8(x);
                if(x>=32&&x<127) {
                    SERIAL_PSTR(" '");
                    serial_ch(x);
                    SERIAL_PSTR("', ");
                } else {
                    SERIAL_PSTR(",     ");
                }
                SERIAL_PSTR(" send ");
            }
#endif

            err=(*send_fn)(x,send_context);
            if(err!=Error_None) {
                return err;
            }

#if VERBOSE_FORWARD_PAYLOAD
            if(verbose) {
                SERIAL_PSTR("done.\n");
            }
#endif
        }
    } else {
        err=(*send_fn)(response_ph->p,send_context);
        if(err!=Error_None) {
            return err;
        }
    }

    return Error_None;
}    

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

/* static Error WARN_UNUSED SendPacket( */
/*     uint8_t c, */
/*     uint8_t p, */
/*     Error WARN_UNUSED (*send_fn)(uint8_t,void *), */
/*     void *send_context) */
/* { */
/* } */

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

struct ReceiveErrorByteContext {
    uint8_t code;
    const char *text_ps;
    size_t index;
};
typedef struct ReceiveErrorByteContext ReceiveErrorByteContext;

static Error WARN_UNUSED ReceiveErrorByte(uint8_t *value,
                                          void *context_)
{
    ReceiveErrorByteContext *context=context_;

    if(context->index==0) {
        *value=0;
    } else if(context->index==1) {
        *value=context->code;
    } else {
        *value=pgm_read_byte(context->text_ps+context->index-2);
    }
    ++context->index;
    
    return Error_None;
}    

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static Error SendErrorToBeeb(uint8_t code,
                             const char *text_ps)
{
    Error err;

    SERIAL_PSTR("!! AVR ERROR response: ");
    serial_u8(code);
    serial_ch(' ');
    serial_ps(text_ps);
    serial_ch('\n');

    PacketHeader ph;
    ph.t.bits.v=1;
    ph.t.bits.c=RESPONSE_ERROR;

    SetPayloadSize(&ph,1+1+strlen_P(text_ps)+1);

    ReceiveErrorByteContext context={.code=code,.text_ps=text_ps};
    err=SendPacketHeaderAndForwardPayload(NULL,
                                          &ph,
                                          &SendByteToBeeb,NULL,
                                          &ReceiveErrorByte,&context,
                                          0,0);
    return err;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static Error WARN_UNUSED NOINLINE HandleRequestAVR(
    const PacketHeader *request)
{
    Error err;
    uint8_t p;

    if(request->t.bits.v) {
        /* Accept a 1-byte variable-sized payload. */
        uint32_t p_size=GetPayloadSize(request);

        if(p_size!=1) {
            return SendErrorToBeeb(255,
                                   PSTR("Bad REQUEST_AVR payload size"));
        }

        err=ReceiveByteFromBeeb(&p,NULL);
        if(err!=Error_None) {
            return err;
        }
    } else {
        p=request->p;
    }

    switch(p) {
    default:
        return SendErrorToBeeb(255,PSTR("Bad REQUEST_AVR payload"));
        
    case REQUEST_AVR_READY:
        {
            uint8_t ready=1;
        
            /* uint8_t old_endpoint=Endpoint_GetCurrentEndpoint(); */

            /* if(ready) { */
            /*     Endpoint_SelectEndpoint(EA_INPUT); */
            /*     if(Endpoint_IsStalled()) { */
            /*         ready=0; */
            /*     } */
            /* } */

            /* if(ready) { */
            /*     Endpoint_SelectEndpoint(EA_OUTPUT); */
            /*     if(Endpoint_IsStalled()) { */
            /*         ready=0; */
            /*     } */
            /* } */

            /* /\* At some point, once it's all working, it'll use the USB */
            /*  * timeout to figure out that the PC has gone away. *\/ */

            /* Endpoint_SelectEndpoint(old_endpoint); */

            SERIAL_PSTR("-- REQUEST_AVR_READY: ");
            serial_ch(ready?'1':'0');
            serial_ch('\n');

            PacketHeader ph={
                .t={.bits={.v=0,.c=ready?RESPONSE_YES:RESPONSE_NO},},
                .p=AVR_PROTOCOL_VERSION,
            };

            /* Since the payload is fixed-size, the receive callback
             * won't get called. */
            return SendPacketHeaderAndForwardPayload(NULL,
                                                     &ph,
                                                     &SendByteToBeeb,NULL,
                                                     NULL,NULL,
                                                     0,0);
        }

    case REQUEST_AVR_ERROR:
        return SendErrorToBeeb(255,PSTR("As requested"));
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static void serial_error(Error err,const char *prefix_pstr) {
    SERIAL_PSTR("!! Error: ");
    if(prefix_pstr) {
        serial_ps(prefix_pstr);
        SERIAL_PSTR(": ");
    }
    serial_ps(GetErrorNamePStr(err));
    serial_ch('\n');
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static void StallDeviceToHost(void) {
    Endpoint_StallTransaction();
    Endpoint_AbortPendingIN();
    Endpoint_ClearIN();
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static void StallHostToDevice(void) {
    Endpoint_StallTransaction();
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

static void NOINLINE MainLoop(void) {
    ++g_num_loops;

    LEDs_SetAllLEDs(LEDS_RED|LEDS_BLUE); /* Idle */

    Endpoint_SelectEndpoint(EA_INPUT); /* Device->Host */

    PacketHeader request;
    Error err;
    
    uint8_t waiting_message_printed=0;

    if(IsVerboseRequestType(g_last_request_type)) {
        serial_ps(wait_for_bbc_msg);
        waiting_message_printed=1;
    }

    g_last_request_type.all=0;
    err=ReceivePacketHeader(&request,
                            &ReceiveByteFromBeeb,&waiting_message_printed,
                            1,
                            LEDS_RED);
    if(err!=Error_None) {
        if(err==Error_Reset) {
            SERIAL_PSTR("!! BBC requested a reset.\n");
        } else {
            serial_error(err,PSTR("receive header from beeb"));
            StallDeviceToHost();
        }
        
        return;
    }

    g_last_request_type=request.t;

    if(IsVerboseRequest(&request)) {
        SERIAL_PACKET_HEADER("-- BBC Request: ",&request);
    }

    /* There are 2 cases that need dealing with straight away. */
    switch(request.t.bits.c) {
    case REQUEST_AVR_PRESENCE:
        SERIAL_PSTR("-- Accepting REQUEST_AVR_PRESENCE\n");
        return;
            
    case REQUEST_AVR:
        err=HandleRequestAVR(&request);
        if(err!=Error_None) {
            serial_error(err,PSTR("handle AVR request"));
            /* Don't bother telling the host (though something has
             * certainly gone wrong...) */
            return;
        }
        return;
    }
    
    err=SendPacketHeaderAndForwardPayload(&request,
                                          &request,
                                          &SendByteToHost,NULL,
                                          &ReceiveByteFromBeeb,NULL,
                                          LEDS_RED,LEDS_BLUE);
    if(err!=Error_None) {
        serial_error(err,PSTR("send beeb->host"));
        StallDeviceToHost();
        return;
    }
    
    /* Flush any half-filled device->host packet. */
    if(Endpoint_BytesInEndpoint()>0) {
        Endpoint_ClearIN();
    }

    Endpoint_SelectEndpoint(EA_OUTPUT); /* Host->Device */

    PacketHeader response;

    if(IsVerboseRequest(&request)) {
        SERIAL_PSTR(".. Receive request from PC...\n");
    }

    err=ReceivePacketHeader(&response,
                            &ReceiveByteFromHost,NULL,
                            0,
                            LEDS_BLUE);
    if(err!=Error_None) {
        serial_error(err,PSTR("receive header from host"));
        StallHostToDevice();
        return;
    }

    if(IsVerboseRequest(&request)) {
        SERIAL_PACKET_HEADER("-- PC Response: ",&response);
    }

    err=SendPacketHeaderAndForwardPayload(&request,
                                          &response,
                                          &SendByteToBeeb,NULL,
                                          &ReceiveByteFromHost,NULL,
                                          LEDS_BLUE,LEDS_RED);
    if(err!=Error_None) {
        serial_error(err,PSTR("send host->beeb"));
        StallHostToDevice();
        return;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

void EVENT_USB_Device_ControlRequest(void){
    if((USB_ControlRequest.bmRequestType&(CONTROL_REQTYPE_TYPE|CONTROL_REQTYPE_RECIPIENT))==(REQTYPE_CLASS|REQREC_DEVICE))
    {
        if((USB_ControlRequest.bmRequestType&CONTROL_REQTYPE_DIRECTION)==REQDIR_DEVICETOHOST)
        {
            if(USB_ControlRequest.bRequest==CR_GET_PROTOCOL_VERSION) {
		Endpoint_ClearSETUP();
		Endpoint_Write_8(AVR_PROTOCOL_VERSION);
		Endpoint_ClearIN();
		Endpoint_ClearStatusStage();
		return;
            }
        }
    }
    
    usb_handle_control_request();
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define LOGOn "------------------------------------------------------"

#define LOGO0 "---- XXXX ------------ X --- X ---- X ------ X -------"
#define LOGO1 "---- X - X ----------- X --- X ------------- X -------"
#define LOGO2 "---- X - X  XXX   XXX  X XX  X --- XX  X XX  X  X ----"
#define LOGO3 "---- XXXX  X - X X - X XX  X X ---- X  XX  X X X -----"
#define LOGO4 "---- X - X XXXXX XXXXX X - X X ---- X  X - X XX ------"
#define LOGO5 "---- X - X X --- X --- X - X X ---- X  X - X X X -----"
#define LOGO6 "---- XXXX   XXX - XXX  XXXX  XXXXX XXX X - X X  X ----"

static void StartupBanner(void) {
    /* This is objectively stupid, and a total waste of space, but
     * it's dead easy to spot in the TTY. */

    SERIAL_PSTR(LOGOn "\n");
    SERIAL_PSTR(LOGO0 "\n");    /* firmware version? */
    SERIAL_PSTR(LOGO1 "\n");
    SERIAL_PSTR(LOGO2 "  Build date:\n");
    SERIAL_PSTR(LOGO3 "  " __DATE__ "\n");
    SERIAL_PSTR(LOGO4 "  at " __TIME__ "\n");
    SERIAL_PSTR(LOGO5 "\n");
    /* stupid me puts brackets round number #defines, which STRINGIFY
     * dutifully includes... */
    SERIAL_PSTR(LOGO6 "  Protocol "); serial_x8(AVR_PROTOCOL_VERSION); serial_ch('\n');
    SERIAL_PSTR(LOGOn "\n");
}    

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

int main(void) {
    MCUSR&=~(1<<WDRF);
    wdt_disable();

    clock_prescale_set(clock_div_1);

    LEDs_Init();
    LEDs_SetAllLEDs(LEDS_RED|LEDS_BLUE);

    Buttons_Init();
    
    GlobalInterruptEnable();

    serial_init();
    
    usb_init();

    DDRB=0b00000000;
    PORTB=0b11111111;

    DDRC=BBC_CB1;               /* CB1 output, CB2 input */
    PORTC|=BBC_CB2;             /* CB2 pull-up resistor */
    PORTC|=BBC_CB1;             /* CB1 high */

    StartupBanner();

    SERIAL_PSTR(".. Wait for USB config\n");

    LEDs_SetAllLEDs(LEDS_RED|LEDS_BLUE);
    
    while(USB_DeviceState!=DEVICE_STATE_Configured) {
        USB_USBTask();
    }

    SERIAL_PSTR("-- USB configured\n");

    for(int i=0;i<3;++i) {
        LEDs_SetAllLEDs(LEDS_RED);
        _delay_us(50000);
        LEDs_SetAllLEDs(0);
        _delay_us(50000);
        LEDs_SetAllLEDs(LEDS_BLUE);
        _delay_us(50000);
        LEDs_SetAllLEDs(0);
        _delay_us(50000);
    }

    for(;;) {
        /* if(g_need_reset) { */
        /*     ResetLoop(); */
        /*     g_need_reset=0; */
        /* } */
        
        LEDs_SetAllLEDs(LEDS_RED|LEDS_BLUE);
    
        MainLoop();
        
        USB_USBTask();          /* don't comment this out */
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////


