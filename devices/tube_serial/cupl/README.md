# Prerequisites

The build process only works out of the box on Windows. You'll need to
install WinCUPL:
https://www.microchip.com/en-us/products/fpgas-and-plds/spld-cplds/pld-design-resources

Let it install it in the default path: `C:\WINCUPL`. Yes, this
software is old...

# Build

You can build the code from the .pld file using the WinCUPL GUI - at
your own risk.

Alternatively, run `make` from inside this folder. This will produce a
.jed file that you can use to reprogram the PLD, plus some other
output files from the compiler.
