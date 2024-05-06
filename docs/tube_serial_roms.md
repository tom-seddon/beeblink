# Tube Serial ROMs

There are four Tube Serial ROM images, two for the BBC B/B+/Master and
two for the Electron. One is the so-called safe ROM, widely
compatible, and the other is the ordinary ROM, which only promises to
work if the Tube Serial device's PLD has been updated to version 3 or
later.

Use the safe ROM if you're not sure which to use.

For some info about updating the PLD, see here:
[../devices/tube_serial](../devices/tube_serial)

# Speed test results

Representative throughput measurements from the speed test tool. Some
notes:

- Save throughput is measurably worse with the safe ROMs, but load
  throughput is unaffected

- Electron results are mode-dependent. (Mode 4 figures will also be
  reached in modes 5 and 6; mode 0 figures will also be obtained in
  modes 1 and 2; and mode 3 is its own thing)

- When used with internal coprocessor on a Master 128, performance is
  unavoidably worse when transferring to the coprocessor memory
 

## `beeblink_tube_serial_safe.rom`

Tested on Master Turbo with external 6502 second processor.

No Tube:

    Host<->server: 178,176 bytes in 8 tests
        BBC->PC: 60.7 KBytes/sec
        PC->BBC: 91.9 KBytes/sec
    	
External Tube:

    Host<->server: 178,176 bytes in 8 tests
        BBC->PC: 60.5 KBytes/sec
        PC->BBC: 91.7 KBytes/sec
    Parasite<->server: 196,608 bytes in 8 tests
        BBC->PC: 57.4 KBytes/sec
        PC->BBC: 87.8 KBytes/sec
    	
Internal Tube (Master only):

    Host<->server: 178,176 bytes in 8 tests
        BBC->PC: 58.0 KBytes/sec
        PC->BBC: 85.9 KBytes/sec
    Parasite<->server: 196,608 bytes in 8 tests
        BBC->PC: 45.0 KBytes/sec
        PC->BBC: 68.2 KBytes/sec	

## `beeblink_tube_serial.rom`

Tested on Master Turbo with external 6502 second processor.

No Tube:

    Host<->server: 178,176 bytes in 8 tests
        BBC->PC: 96.4 KBytes/sec
        PC->BBC: 92.0 KBytes/sec
    
External Tube:

    Host<->server: 178,176 bytes in 8 tests
        BBC->PC: 96.3 KBytes/sec
        PC->BBC: 91.8 KBytes/sec
    Parasite<->server: 196,608 bytes in 8 tests
        BBC->PC: 88.8 KBytes/sec
        PC->BBC: 88.0 KBytes/sec
    
Internal Tube (Master only):

    Host<->server: 178,176 bytes in 8 tests
        BBC->PC: 90.2 KBytes/sec
        PC->BBC: 86.0 KBytes/sec
    Parasite<->server: 196,608 bytes in 8 tests
        BBC->PC: 62.2 KBytes/sec
        PC->BBC: 68.2 KBytes/sec
    	
## `beeblink_tube_serial_safe_electron.rom`

Tested on Electron with AP5+6502 second processor.

No Tube, Mode 4:

    Host<->server: 178,176 bytes in 8 tests
        Electron->PC: 42.8 KBytes/sec
        PC->Electron: 61.4 KBytes/sec
    
No Tube, Mode 3:

    Host<->server: 178,176 bytes in 8 tests
        Electron->PC: 26.4 KBytes/sec
        PC->Electron: 40.3 KBytes/sec
    
No Tube, Mode 0:

    Host<->server: 178,176 bytes in 8 tests
        Electron->PC: 21.7 KBytes/sec
        PC->Electron: 34.9 KBytes/sec
    	
External Tube, Mode 4:

    Host<->server: 178,176 bytes in 8 tests
        Electron->PC: 42.8 KBytes/sec
        PC->Electron: 61.3 KBytes/sec
    Parasite<->server: 196,608 bytes in 8 tests
        Electron->PC: 43.2 KBytes/sec
        PC->Electron: 70.4 KBytes/sec
    
External Tube, Mode 3:

    Host<->server: 178,176 bytes in 8 tests
        Electron->PC: 26.4 KBytes/sec
        PC->Electron: 40.3 KBytes/sec
    Parasite<->server: 196,608 bytes in 8 tests
        Electron->PC: 28.8 KBytes/sec
        PC->Electron: 64.2 KBytes/sec

External Tube, Mode 0:

    Host<->server: 178,176 bytes in 8 tests
        Electron->PC: 21.7 KBytes/sec
        PC->Electron: 34.9 KBytes/sec
    Parasite<->server: 196,608 bytes in 8 tests
        Electron->PC: 24.8 KBytes/sec
        PC->Electron: 61.1 KBytes/sec	

## `beeblink_tube_serial_electron.rom`

Tested on Electron with AP5+6502 second processor.

No Tube, Mode 4:

    Host<->server: 172,032 bytes in 8 tests
        Electron->PC: 63.9 KBytes/sec
        PC->Electron: 60.4 KBytes/sec

No Tube, Mode 3:

    Host<->server: 172,032 bytes in 8 tests
        Electron->PC: 41.5 KBytes/sec
        PC->Electron: 40.1 KBytes/sec

No Tube, Mode 0:

    Host<->server: 172,032 bytes in 8 tests
        Electron->PC: 35.8 KBytes/sec
        PC->Electron: 34.2 KBytes/sec

External Tube, Mode 4:

    Host<->server: 172,032 bytes in 8 tests
        Electron->PC: 64.0 KBytes/sec
        PC->Electron: 60.0 KBytes/sec
    Parasite<->server: 196,608 bytes in 8 tests
        Electron->PC: 69.1 KBytes/sec
        PC->Electron: 69.4 KBytes/sec

External Tube, Mode 3:

    Host<->server: 172,032 bytes in 8 tests
        Electron->PC: 42.3 KBytes/sec
        PC->Electron: 40.1 KBytes/sec
    Parasite<->server: 196,608 bytes in 8 tests
        Electron->PC: 64.1 KBytes/sec
        PC->Electron: 62.8 KBytes/sec

External Tube, Mode 0:

    Host<->server: 172,032 bytes in 8 tests
        Electron->PC: 35.8 KBytes/sec
        PC->Electron: 34.2 KBytes/sec
    Parasite<->server: 196,608 bytes in 8 tests
        Electron->PC: 61.0 KBytes/sec
        PC->Electron: 59.6 KBytes/sec
