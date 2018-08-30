# Setup

Unzip the firmware release zip. There's two files: a .hex file for the
AVR, and a .rom file for the BBC.

# Set up AVR

For Windows (untested), try the FLIP tool, but you're on your own:
http://www.microchip.com/developmenttools/ProductDetails/PartNo/flip

On OS X or Linux, get dfu-programmer via the package manager (the
package seems to be `dfu-programmer` everywhere).

To program the Minimus:

0. Connect to PC via USB

1. Ready for programming: hold RESET, hold HWB, release RESET, release
   HWB
   
2. Erase and program:

       dfu-programmer atmega32u2 erase
       dfu-programmer atmega32u2 flash beeblink.hex
	
   If it works, you get a message along the lines of `7022 bytes used
   (24.49%)`

3. Press RESET. Both LEDs should light up

## Connect AVR to BBC ##

Connect AVR to BBC's user port as follows:

| User Port | AVR |
| --- | --- |
| GND | GND | 
| PB0 | PB0 |
| PB1 | PB1 |
| PB2 | PB2 |
| PB3 | PB3 |
| PB4 | PB4 |
| PB5 | PB5 |
| PB6 | PB6 |
| PB7 | PB7 |
| CB1 | PC6 |
| CB2 | PC7 |

## Connect AVR to PC's serial port (optional) ##

If you've got a serial port that can accept +5V, you can connect the
AVR's PC4 to its Receive Data pin to see its debug serial output.

The serial output is 115200 baud, no parity, 1 stop bit.
