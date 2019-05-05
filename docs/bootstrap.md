# Tube serial bootstrap process

If you've got no other way of getting files from your PC to your BBC,
you can copy `beeblink_tube_serial.rom` to the same place you run the
server from, and run a program on the BBC to get a copy of the ROM
transferred over.

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
