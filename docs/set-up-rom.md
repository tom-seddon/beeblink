# Prerequisites

* 16K sideways RAM
* disk system on your BBC in case something goes wrong later

EEPROM or battery-backed sideways RAM (ideally with write protection)
is recommended...

# Set up ROM on BBC

The ROM is built into `rom/.build/beeblink.rom` in the working copy.
If you've got some way of getting files to your BBC already, you can
just do that and move on.

If not, type in the following BASIC program and save it to disc. It
will transfer the ROM from the server and *SAVE it to disc. You can
then load this into sideways RAM somehow.

    10REM>L.BSTRAP2
    20MODE7
    30A%=130:IF(USR(&FFF4)AND&FFFF00)=0:PRINT"I/O PROCESSOR ONLY":STOP
    40:
    50VIA%=&FE60
    60VIA%?12=&E0:*FX19
    70VIA%?12=&C0:*FX19
    80VIA%?12=&E0:*FX19
    90:
    100PROCSEND(1,0)
    110R%=FNRECV:V%=FNRECV
    120IFR%<>2:PRINT"AVR NOT READY":STOP
    130IFV%<>1:PRINT"UNKNOWN AVR VERSION: ";V%:STOP
    140:
    150PROCSEND(2,0)
    160T%=FNRECV:IFT%<>&83:PRINT"UNEXPECTED RESPONSE: &";~T%:STOP
    170FORI%=0TO3:I%?&70=FNRECV:NEXT
    180IF!&70=0:PRINT"PAYLOAD EMPTY":END
    190IF!&70>16384:PRINT"PAYLOAD UNEXPECTEDLY LARGE: ";!NBYTES:STOP
    200PRINT"RECEIVING ";!&70" BYTES"
    210:
    220N%=!&70-1:DIMB%N%
    230V%=VIA%:W%=VIA%+13:M%=&10
    240TIME=0
    250FORI%=0TON%:?V%=0:REPEATUNTIL(?W%ANDM%)<>FALSE:B%?I%=?V%:NEXT
    260BPS=!&70/(TIME/100)
    270PRINT;BPS" BYTES/SEC"
    280O$="SAVE BLFSROM "+STR$~B%+"+"+STR$~!&70+" 0 0"
    290PRINTO$
    300OSCLIO$
    310END
    320:
    330DEFPROCSEND(A%,B%)
    340VIA%?14=&18:VIA%?13=&18:VIA%?11=VIA%?11OR2:VIA%?12=&E0:VIA%?12=&80:VIA%?2=255
    350?VIA%=A%:REPEAT:UNTIL(VIA%?13AND&10)<>0
    360?VIA%=B%:REPEAT:UNTIL(VIA%?13AND&10)<>0
    370ENDPROC
    380:
    390DEFFNRECV:VIA%?2=0:?VIA%=0:REPEAT:UNTIL(VIA%?13AND&10)<>0:=?VIA%

Once things are up and running, you have other options, but the above
ought to be enough to get you out of a pickle.

