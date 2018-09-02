#ifndef RECV
#error RECV must be defined
#endif

#ifndef SEND
#error SEND must be defined
#endif

#ifndef LED_CONSTANT
#error LED_CONSTANT must be defined
#endif

#ifndef LED_FLICKER
#error LED_FLICKER must be defined
#endif

#if LED_CONSTANT!=0&&LED_FLICKER!=0

#define FLICKER_LEDS()                                                  \
    do {                                                                \
        uint8_t new_leds=LED_CONSTANT|(i&LED_FLICKER_MASK?LED_FLICKER:0); \
        if(new_leds!=leds) {                                            \
            LEDs_SetAllLEDs(new_leds);                                  \
            leds=new_leds;                                              \
        }                                                               \
    } while(0)

#else

#define FLICKER_LEDS() ((void)0)

#endif

#define RECV_BYTE()                             \
    do {                                        \
        RECV(&x);                               \
        if(err!=Error_None) {                   \
            return err;                         \
        }                                       \
    } while(0)

#define SEND_BYTE()                             \
    do {                                        \
        SEND(x);                                \
        if(err!=Error_None) {                   \
            return err;                         \
        }                                       \
    } while(0)

#define PRE_RECV_MESSAGE()                      \
    do {                                        \
        SERIAL_PSTR("-- ");                     \
        serial_u32(i);                          \
        serial_ch('/');                         \
        serial_u32(p_size);                     \
        SERIAL_PSTR("; recv ");                 \
    } while(0)

#define POST_RECV_MESSAGE()                     \
    do {                                        \
        serial_x8(x);                           \
        if(x>=32&&x<127) {                      \
            SERIAL_PSTR(" '");                  \
            serial_ch(x);                       \
            SERIAL_PSTR("', ");                 \
        } else {                                \
            SERIAL_PSTR(",     ");              \
        }                                       \
        SERIAL_PSTR(" send ");                  \
    } while(0)

#define POST_SEND_MESSAGE() \
    do {                                        \
        SERIAL_PSTR("done.\n");                 \
    } while(0)

{
    Error err;

    SEND(response_ph->t.all);
    if(err!=Error_None) {
        return err;
    }

    if(response_ph->t.bits.v) {
        for(uint8_t i=0;i<4;++i) {
            SEND(response_ph->p_size[i]);
            if(err!=Error_None) {
                return err;
            }
        }

        uint32_t p_size=GetPayloadSize(response_ph);

        uint8_t verbose=IsVerboseRequest(request_ph)&&serial_is_enabled();

        if(verbose) {
            SERIAL_PSTR("-- p_size=");
            serial_u32(p_size);
            serial_ch('\n');
        }

#if LED_CONSTANT!=0&&LED_FLICKER!=0
        uint8_t leds=0;
#endif
        
        uint8_t x=0;
        uint32_t i;

        if(!verbose) {
            for(i=0;i<p_size;++i) {
                FLICKER_LEDS();
                RECV_BYTE();
                SEND_BYTE();
            }
        } else {
            uint32_t v_end,v_restart;
            if(p_size<=MAX_NUM_DUMP_BYTES) {
                v_end=p_size;
                v_restart=p_size;
            } else {
                v_end=MAX_NUM_DUMP_BYTES/2;
                v_restart=p_size-MAX_NUM_DUMP_BYTES/2;
            }

            for(i=0;i<v_end;++i) {
                FLICKER_LEDS();
                PRE_RECV_MESSAGE();
                RECV_BYTE();
                POST_RECV_MESSAGE();
                SEND_BYTE();
                POST_SEND_MESSAGE();
            }

            if(i<p_size) {
                SERIAL_PSTR("-- (eliding transfer)\n");
            }

            for(;i<v_restart;++i) {
                FLICKER_LEDS();
                RECV_BYTE();
                SEND_BYTE();
            }

            for(;i<p_size;++i) {
                FLICKER_LEDS();
                PRE_RECV_MESSAGE();
                RECV_BYTE();
                POST_RECV_MESSAGE();
                SEND_BYTE();
                POST_SEND_MESSAGE();
            }
        }
    } else {
        SEND(response_ph->p);
        if(err!=Error_None) {
            return err;
        }
    }

    return Error_None;
}

#undef RECV
#undef SEND
#undef LED_CONSTANT
#undef LED_FLICKER
#undef FLICKER_LEDS

#undef RECV_BYTE
#undef SEND_BYTE
#undef PRE_RECV_MESSAGE
#undef POST_RECV_MESSAGE
#undef POST_SEND_MESSAGE
