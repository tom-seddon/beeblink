# Build and run server (Windows/OS X/Linux)

Prerequisites:

* [node.js 10.13.0 or later](https://nodejs.org/en/download/)

Linux package prerequisites:

* `apt-get install libusb-dev` ([libusb](https://libusb.info/))
* `apt-get install libudev-dev`

Steps:

0. Change to `server` folder

1. Run `npm install` (note that on Windows, a build error mentioning
   `sys/ioctl.h` is expected - this is benign, and can be ignored)

2. Run `npm start -- OPTIONS` to start the server, - where `OPTIONS`
   are the command line options for it - see
   [the server docs](./docs/server.md)
