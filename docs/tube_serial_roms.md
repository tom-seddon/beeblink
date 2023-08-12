# Tube Serial ROMs

There are four Tube Serial ROM images, two for the BBC B/B+/Master and
two for the Electron: a safe ROM, which is more widely compatible, and
an ordinary ROM, which gives better performance.

If using a BBC B, use `beeblink_tube_serial_safe.rom`. (The ordinary
ROM may also work, but unfortunately this isn't guaranteed.)

For BBC B+ or Master, use `beeblink_tube_serial.rom`. (The safe ROM is
unnecessary, but it'll also work.)

For Electron+Plus 1+AP5, use `beeblink_tube_serial_safe_electron.rom`.
(The ordinary ROM may also work, but unfortunately this isn't
guaranteed.)

## `beeblink_tube_serial_safe.rom`

Compatible with BBC B/B+/Master.

Representative throughput measurements from the speed test tool,
running on Master Turbo with external 6502 second processor.

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

Lower performance using the internal 2nd processor is unfortunately
inevitable, as the software has to switch between internal and
external while transferring.

## `beeblink_tube_serial.rom`

Compatible with BBC B+/Master.

May be compatible with BBC B - but not guaranteed! (For whatever it's
worth, it does work with my own BBC B.)

Representative throughput measurements from Master Turbo with external
6502 second processor.

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

Compatible with Electron+Plus 1+AP5.

Representative throughput measurements from Electron with 6502 second
processor. As is typical with the Electron, performance is
mode-dependent. (Mode 4 figures will also be reached in modes 5 and 6;
mode 0 figures will also be obtained in modes 1 and 2; and mode 3 is
its own thing.)

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

May be compatible with Electron+Plus 1+AP5. At your own risk... it
doesn't work on my own Electron :(
