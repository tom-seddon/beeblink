# UPURS notes

1. The UPURS support uses the NMI area in page &D to load data.
   Loading into that region won't cause a crash, as it might with
   disks, but the results will probably be nonsense.
   
2. The serial connection can be a bit sensitive to programs accessing
   the user VIA. The filing system will try to rescue itself if it
   looks like things have got into trouble - this process should be
   transparent, and hopefully all you'll notice is a slight delay.
   
   One example is Exile, which writes to the user VIA as part of its
   sideways RAM detection.

# UPURS auto-detection

If you are using the specific type of FTDI USB serial adapter I tested
the UPURS cable with - USB vendor id 0403, product id 6001 - the
server will auto-detect it on startup.

Otherwise, you will have to specify the serial device to use on the
command line. If you know its device name already, use
`--serial-include` to include it, e.g.:

    beeblink-server --serial-include /dev/tty.usbserial-FT93T5RD
	
If you don't know its device name, run the server with
`--list-serial-devices` to have the server print all the devices it
knows about:

    beeblink-server --list-serial-devices
	
For each device, it shows the path (this is what you should pass to
`--serial-include`), info about the USB device it corresponds to, and
a note about whether the device will be used or not and why.
