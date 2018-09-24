# Serving files to multiple BBCs

With a small amount of additional setup, the server can serve files to
multiple BBCs simultaneously. You'll need one AVR per BBC, and that
many USB ports on your PC.

You'll also need to assign each AVR a unique USB serial number, so the
server can correctly tell them apart. Do this for each AVR in turn:

1. Plug AVR into the PC, and remove any other ones (the serial number
   can only be set when a single AVR is plugged in)
   
2. Run the server with the `--set-serial` command line option,
   supplying the serial number: a number between 0 and 65535
   inclusive. (Pick any you like; all are equally valid, and there are
   no special values.)
   
       npm start -- --set-serial 1
	   
3. Remove and reinsert device to ensure the OS's device information is
   up to date

Duplicate serial numbers are not supported! Only one of the duplicates
will be recognised, and there's no guarantee which one...
