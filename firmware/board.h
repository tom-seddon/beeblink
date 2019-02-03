#if BOARD==BOARD_MINIMUS

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#define CB1_PORT_NAME C
#define CB1_BIT 6

#define CB2_PORT_NAME C
#define CB2_BIT 7

#define DDR_BBC_TO_AVR() (DDRB=0,(void)0)
#define BBC_TO_AVR() (PINB)

#define DDR_AVR_TO_BBC() (DDRB=255,(void)0)
#define AVR_TO_BBC(X) (PORTB=(X),(void)0)

#define LEDS_BLUE (LEDS_LED1)
#define LEDS_RED (LEDS_LED2)

#define SERIAL_PORT_NAME C
#define SERIAL_BIT 4

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#elif BOARD==BOARD_LEONARDO

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

/* CB1 = pin 10 */
#define CB1_PORT_NAME B
#define CB1_BIT 6

/* CB2 = pin 16 */
#define CB2_PORT_NAME B
#define CB2_BIT 2

/* For reasons not quite clear, the Leonardo board doesn't have any
 * single full port's-worth of GPIO pins. Also, none of the pin names
 * bear any relation to the AVR port/pin assignments...
 *
 * PB7 = pin A0   +
 * PB6 = pin A1   | AVR
 * PB5 = pin A2   | port F
 * PB4 = pin A3   +
 * PB3 = pin TX0  +
 * PB2 = pin RXI  | AVR
 * PB1 = pin 2    | port D
 * PB0 = pin 3    +
 */

/* clear bits of interest */
#define DDR_BBC_TO_AVR() (DDRF&=0x0f,DDRD&=0xf0,(void)0)

/* set bits of interest */
#define DDR_AVR_TO_BBC() (DDRF|=0xf0,DDRD|=0x0f,(void)0)

#define BBC_TO_AVR() ((PINF&0xf0)|(PIND&0x0f))

#define AVR_TO_BBC(X)                           \
    do {                                        \
        uint8_t tmp=(X);                        \
                                                \
        PORTF=(PORTF&0x0f)|(tmp&0xf0);          \
        PORTD=(PORTD&0xf0)|(tmp&0x0f);          \
    } while(0)

#define LEDS_BLUE (LEDS_LED1)
#define LEDS_RED (LEDS_LED2)

/* Serial output = pin 14 */
#define SERIAL_PORT_NAME B
#define SERIAL_BIT 3

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#else

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#error unknown board

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

#endif

#define CB1_DDR CONCAT_EXPANDED(DDR,CB1_PORT_NAME)
#define CB1_PIN CONCAT_EXPANDED(PIN,CB1_PORT_NAME)
#define CB1_PORT CONCAT_EXPANDED(PORT,CB1_PORT_NAME)

#define CB2_DDR CONCAT_EXPANDED(DDR,CB2_PORT_NAME)
#define CB2_PIN CONCAT_EXPANDED(PIN,CB2_PORT_NAME)
#define CB2_PORT CONCAT_EXPANDED(PORT,CB2_PORT_NAME)

#define CB1_MASK (1<<CB1_BIT)
#define CB2_MASK (1<<CB2_BIT)

#define SERIAL_MASK (1<<SERIAL_BIT)
#define SERIAL_DDR CONCAT_EXPANDED(DDR,SERIAL_PORT_NAME)
#define SERIAL_PORT CONCAT_EXPANDED(PORT,SERIAL_PORT_NAME)
