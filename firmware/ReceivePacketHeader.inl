#ifndef RECV
#error RECV must be defined
#endif

#ifndef RECEIVING_FROM_BEEB
#error RECEIVING_FROM_BEEB must be defined
#endif

#ifndef LEDS_STATE
#error LEDS_STATE must be defined
#endif

{
    Error err;

    RECV(&ph->t.all);
    if(err!=Error_None) {
        if((RECEIVING_FROM_BEEB)&&err==Error_NoBeebHandshake) {
            /* Minor fudge... */
            err=Error_Reset;
        }

        return err;
    }

    LEDs_SetAllLEDs(LEDS_STATE);

    if(RECEIVING_FROM_BEEB) {
        if(ph->t.bits.c==REQUEST_AVR_PRESENCE) {
            /* AVR presence check. Just ignore. */
            return Error_None;
        }
    }

    if(ph->t.bits.v) {
        for(uint8_t i=0;i<4;++i) {
            RECV(&ph->p_size[i]);
            if(err!=Error_None) {
                return err;
            }
        }
    } else {
        RECV(&ph->p);
        if(err!=Error_None) {
            return err;
        }

        /* set p_size in this case?? */
    }

    return Error_None;

}

#undef RECV
#undef RECEIVING_FROM_BEEB
#undef LEDS_STATE
