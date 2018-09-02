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

        uint8_t leds=0;
        uint8_t x=0;

        for(uint32_t i=0;i<p_size;++i) {

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

            if((LED_CONSTANT|LED_FLICKER)!=0) {
                uint8_t new_leds=(LED_CONSTANT|
                                  (i&LED_FLICKER_MASK?LED_FLICKER:0));
                if(new_leds!=leds) {
                    LEDs_SetAllLEDs(new_leds);
                    leds=new_leds;
                }
            }
            
            RECV(&x);
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

            SEND(x);
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
