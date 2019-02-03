# Setup

Unzip the firmware release zip. There are .hex files, one for each
supported type of AVR board (pick the one corresponding to the board
you have...), and a .rom file for the BBC.

# Set up SparkFun Pro Micro/Arduino Leonardo

## Program AVR

You'll need
[AVRDUDE](https://www.nongnu.org/avrdude/user-manual/avrdude.html#Top)
and [the Arduino IDE](https://www.arduino.cc/en/main/software).

To program the AVR:

0. Follow the
   [annoying installation process](https://learn.sparkfun.com/tutorials/pro-micro--fio-v3-hookup-guide).
   Once your device appears in the Arduino IDE, take a note of its
   serial port name

1. Enter the programmer command line, replacing `XXX` with the serial
   port name from the Arduino IDE, but don't press Return just yet:

       avrdude -p atmega32u4 -P XXX -c avr109 -U flash:w:beeblink.hex 

2. Briefly connect GND and RESET to reset the AVR and put it into
   programming mode for the next 8 seconds

3. Press Return on the PC

If it works, you should get a bunch of output and a message along
these lines:

    avrdude: verifying ...
    avrdude: 11462 bytes of flash verified
    
    avrdude: safemode: Fuses OK (E:C0, H:D8, L:FF)
    
    avrdude done.  Thank you.

The AVR should then reboot. Once the BeebLink firmware is running,
both LEDs should light up.

## Connect AVR to BBC

Connect AVR to BBC's user port as follows:

| User Port | AVR |
| --- | --- |
| GND | GND | 
| PB0 | 3 |
| PB1 | 2 |
| PB2 | RXI |
| PB3 | TX0 |
| PB4 | A3 |
| PB5 | A2 |
| PB6 | A1 |
| PB7 | A0 |
| CB1 | 10 |
| CB2 | 16 |

## Connect AVR to PC's serial port (optional) ##

AVR pin 14.

# Set up Minimus AVR

## Program AVR ##

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

AVR pin PC4.
