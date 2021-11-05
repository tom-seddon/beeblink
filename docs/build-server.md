# Build and run server (Windows/OS X/Linux)

Prerequisites:

* [node.js 10.13.0 or later](https://nodejs.org/en/download/)

# Build and run on Windows

Additional rerequisites:

* Visual Studio

0. Launch the appropriate native tools command prompt - search for
   `x64 native tools` in the Start menu
   
1. Change to the `server` folder in the working copy

2. Run `npm install`. A build error mentioning `sys/ioctl.h` is
   expected - this is benign, and can be ignored
   
3. Run `run OPTIONS` to start the server, where `OPTIONS` are the
   command line options for it - see
   [the server docs](./docs/server.md)
   
# Build and run on macOS/Linux

Additional macOS prerequisites:

* Xcode

Additional Linux Ubuntu package prerequisites: (you're on your own for
other distros - reports welcome)

* `apt-get install libusb-dev` ([libusb](https://libusb.info/))
* `apt-get install libudev-dev`

Steps:

0. Go to terminal
   
1. Change to the `server` folder in the working copy

2. Run `npm install`

2. Run `npm start -- OPTIONS` to start the server, where `OPTIONS` are
   the command line options for it - see
   [the server docs](./docs/server.md)
