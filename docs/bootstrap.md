# Tube serial bootstrap process

If you've got no other way of getting files from your PC to your BBC,
you can run a short BBC BASIC program on your BBC and use terminal
software on your PC to send a copy of the ROM to the BBC.

If you use a second processor, switch it off and press CTRL+BREAK.
Then type in the following program at the BASIC prompt.

    10S%=&FEFF:D%=&FEFE
    20IF?(S%AND8)=0:STOP
    30MODE128:MODE135:HIMEM=HIMEM-&4000:A%=HIMEM:REPEAT:V%=?D%:UNTIL(?S%AND1)=0:PRINT;~HIMEM:REPEATREPEATUNTIL(?S%AND1)<>0:?A%=?D%:A%=A%+1:PRINTCHR$13;~A%;:UNTILFALSE

Run it with `RUN`. If you get a `STOP at line 20`, the Tube Serial
device wasn't detected - make sure everything is connected!

Wait until the display reads `3C00` or similar. Then send the file
from your PC or Mac. (See below for the details.)

As the file transfers, you'll see another hex number count up. When it
stops counting up, the transfer is complete. Press ESCAPE to get back
to BASIC.

If you've got a disk drive, note the addresses printed and use `*SAVE`
to save from the first address to the second. For example, if the
first address is `4000`, and the second is `5F62`, `*SAVE BLFS 4000
5F62`. Then use your usual tools to get this loaded into ROM.

If you use [RTOOL](http://www.boobip.com/software/rom-tool), the ROM
is hopefully already at the right address for use with its `P`
command.

# Sending the file from your Windows PC

Download Hercules from
http://www.hw-group.com/products/hercules/index_en.html

Select the appropriate port, set `Handshake` to `RTS/CTS`, then click
Open.

Right click the window, and select `Send File` > `Send File...`. Find
the Tube Serial ROM and click OK.

# Sending the file from your Mac

Download CoolTerm from https://freeware.the-meiers.org/.

Run it and click `Options` on the tool bar. Select the appropriate
port from the list, set `Flow Control` is set to `CTS`, and click
`OK`.

Click `Connect` on the tool bar.

Click `Connection` > `Send Text/Binary File...`, select the Tube
Serial ROM, and click `OK`.
