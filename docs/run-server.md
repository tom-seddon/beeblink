# Prerequisites

* [node.js](https://nodejs.org/en/download/)

# Install

Change to `server` in the working copy and run `npm install`. You
should get some output and no obvious errors.

# Run

There are various possible options, but for starters run it like this
in the `server` folder from the command line:

    npm start -- --rom ../rom/.build/beeblink.rom --mount beeblink ../volumes
	
After a moment you should get a `Server running...` message.
