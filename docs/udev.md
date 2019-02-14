# Set up Linux udev rules

Linux appears to come with built-in udev rules for the Minimus and
Leonardo/Pro Micro devices when in bootloader mode, so with any luck
you'll have no difficulty programming them. You'll need to create a
separate entry for the BeebLink firmware proper, though.

Create a new beeblink group:

    sudo groupadd beeblink
	
Add yourself to the beeblink group:

    sudo usermod -a -G beeblink $(whoami)
	
Add a new udev rules file, `/etc/udev/rules.d/beeblink.rules`, with the following contents:

    ATTR{idVendor}=="1209", ATTR{idProduct}=="beeb", MODE="660", GROUP="beeblink"

Get udev to reinitialise:

    sudo udevadm control --reload-rules
	sudo udevadm trigger
