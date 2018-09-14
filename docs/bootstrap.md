# Bootstrap process

If you've got no way of getting files from your PC to your BBC, copy
the `beeblink.rom` file to the same place you run the server from,
type in the following program, and run it to get a copy of the ROM
transferred from the server.

This assumes you've got a disc drive, so it just saves the ROM (max
8K) to a file for use with your usual ROM tools.

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
