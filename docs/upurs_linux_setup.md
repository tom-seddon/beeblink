# Linux setup

If the server prints repeated `Permission denied, cannot open` errors,
you probably need to add yourself to the right user group to access
the serial port.

Note the path to the device it's trying to open. Use `stat` to find
out which group it's owned by, shown in the `Access` line. For
example, from my PC:

    Access: (0660/crw-rw----)  Uid: (    0/    root)   Gid: (   20/ dialout)

Then use `usermod` (as root) to add your user to that group. For
example, assuming the device's group id is `dialout`, as above:

    sudo usermod -a -G dialout $USER
	
Check the status by running `id`, and look for `dialout` in the groups
list. I had to reboot the computer for the change to take effect.
