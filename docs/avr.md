# Prerequisites

* Minimus AVR 32K board
* AVR toolchain
* DFU programming tool
* GNU Make (comes with Xcode)

For MacPorts, you can get these with `sudo port install avr-binutils
   avr-gcc avr-libc dfu-programmer`.

# Program AVR

0. Connect AVR to PC via USB

1. Ready AVR for programming: hold RESET, hold HWB, release RESET,
   release HWB. There may be no obvious indication that this has done
   anything, but the programming tool will complain if the AVR is in
   the wrong state, so you'll know to retry
   
2. Change to `firmware` in the working copy and run `make`. This
   compiles the code and programs the device. You should get a bunch
   of output, and no obvious errors, and a message at the end along
   the lines of `7022 bytes used (24.49%)`
   
3. Tap RESET on the AVR. The red and blue LEDs should both light up

# Connect AVR to BBC

Connect AVR to BBC's user port as follows:

| User Port | AVR |
|----
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

# Connet AVR to PC's serial port (optional) #

If you've got a serial port that can accept +5V, you can connect the
AVR's PC4 to its Receive Data pin and get debug serial output.

The serial output is 115200 baud, no parity, 1 stop bit.
