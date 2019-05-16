# FTDI latency timer (Windows only)

The default settings for the FTDI serial device mean terrible
performance for OSBGET and OSBPUT, affecting `*SPOOL*`, `*EXEC`,
`*DUMP`, and so on. The `*CAT` output speed is also slightly affected.

On OS X and Linux, the server can sort this out for you; on Windows,
unfortunately, you need to do to it by hand. But it's easy enough, and
it seems to be persistent:

1. Find device in Device Manager (mine appears as `USB Serial Port
   (COM5)` in the `Ports (COM & LPT)` section)
   
2. Right click device and select `Properties` from the popup menu

3. In the properties dialog, select `Port Settings` tab and click
   `Advanced...` button
   
4. In the advanced settings dialog, find the `Latency Timer (msec)`
   option and set it to `1`
   
5. Click OK and back out of all the dialogs

The default values for all the other options are fine.

Rebooting appears to be optional even if Windows tells you it's
required.
