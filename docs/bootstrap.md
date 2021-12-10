# Tube serial bootstrap process

If you've got no other way of getting files from your PC to your BBC,
you can run a short BBC BASIC program on your BBC and use terminal
software on your PC to send a copy of the ROM to the BBC.

If you use a second processor, switch it off. Then type in the
following program.

    10S%=&FEFF:D%=&FEFE:M%=1:Z%=0
    20IF(?S%AND8)=Z%:STOP
    30MODE&87:A%=HIMEM-&4000:MODE1:COLOUR129:CLS:VDU28,0,3,39,0:COLOUR128:CLS
    40PRINT"FLUSHING...":REPEATUNTIL(?S%ANDM%)=Z%
    50CLS:PRINT"ADDR: &";~A%;
    60REPEATREPEATUNTIL(?S%ANDM%)<>Z%:?A%=?D%:A%=A%+1:UNTILFALSE

Run it with `RUN`. If you get a `STOP at line 20`, the Tube Serial
device wasn't detected - make sure everything is connected!

Wait until the display reads `ADDR: &3C00` or similar. (There may be a
`FLUSHING...` step to wait for first.) Then send the file from your PC
or Mac. (See below for the details.)

As the file transfers, the screen should fill with junk. When it
stops, the transfer is complete. Press ESCAPE to get back to BASIC.

If you've got a disk drive, note the address printed - probably &4000
or &3C00 - and use `*SAVE` to save 16 KB from that address. For
example, `*SAVE BLFS 3C00+4000`. Then use your usual tools to get this
loaded into ROM.

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
