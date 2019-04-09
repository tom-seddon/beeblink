# Tube serial bootstrap process

If you've got no way of getting files from your PC to your BBC, copy
the `beeblink_tube_serial.rom` file to the same place you run the
server from, type in the following program, and run it (with Tube
off) to get a copy of the ROM transferred from the server.

This assumes you've got a disc drive, so it just saves the ROM (max
16K) to a file for use with your usual ROM tools.

    10REM>B.TUBE
    20MODE1:VDU28,0,5,39,0:DEST%=&3F00
    30P%=&80:[STA&FEFE:RTS:]
    40DEFPROCPSEND(A%):IF(?&FEFF AND2)<>0:CALL&80:ENDPROC
    50DEFPROCSEND(A%):REPEAT:UNTIL?(&FEFF AND2)<>0:CALL&80:ENDPROC
    60DEFFNPRECV:IF(?&FEFF AND1)<>0:=?&FEFE:ELSE:=-1
    70DEFFNRECV:REPEAT:UNTIL(?&FEFF AND1)<>0:=?&FEFE
    80PRINT"WAITING FOR DEVICE"
    90REPEAT:UNTIL(?&FEFF AND8)<>0
    100PRINT"SYNC 1"
    110PROCSEND(&80)
    120N%=0:R%=300
    130REPEAT
    140PROCPSEND(0)
    150V%=FNPRECV:IFV%>=0:IFV%=0:N%=N%+1:ELSE:N%=0
    160UNTILN%=R%
    170PRINT"SYNC 2"
    180REPEAT
    190PROCPSEND(0)
    200V%=FNPRECV
    210UNTILV%<>0
    220IFV%<>1:PRINT"SYNC FAILED - RESTARTING":GOTO100
    230PRINT"SYNC 3"
    240PROCSEND(1)
    250:
    260PRINT"REQUEST ROM"
    270PROCSEND(&02)
    280PROCSEND(&00)
    290PROCSEND(&01)
    300:
    310PRINT"AWAIT RESPONSE"
    320C%=FNRECV:IFC%<>&83:PRINT"UNEXPECTED RESPONSE: &";~C%:STOP
    330FORI%=0TO3:I%?&70=FNRECV:NEXT:N%=!&70:PRINT"RECEIVING ";N%" BYTES"
    340N%!DEST%=-1
    350O%=-(N%-1)
    360FORI%=0TON%-1
    370IF((-(N%-1-I%))AND255)=0:X%=FNRECV
    380I%?DEST%=FNRECV
    390NEXT
    400O$="SAVE R.TS "+STR$~DEST%+"+"+STR$~N%+" 0 0"
    410PRINTO$
    420OSCLIO$

# AVR bootstrap process

If you've got no way of getting files from your PC to your BBC, copy
the `beeblink_avr_fe60.rom` file to the same place you run the server
from, type in the following program, and run it to get a copy of the
ROM transferred from the server.

This assumes you've got a disc drive, so it just saves the ROM (max
16K) to a file for use with your usual ROM tools.

    10REM>B.AVR
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
    280O$="SAVE R.AVR "+STR$~B%+"+"+STR$~!&70+" 0 0"
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
