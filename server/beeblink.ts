//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
// Copyright (C) 2018 Tom Seddon
// 
// This program is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
// 
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with this program. If not, see
// <https://www.gnu.org/licenses/>.
//
//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////
//
// The authoritative location for various constants. It's not especially obvious
// how to add more steps to the TypeScript build process, so that's where this
// stuff goes...
//
// To keep everything in one place, this also includes constants for the
// AVR-specific bits that don't apply to the server.
//
// Notes
// -----
//
// - These constants are not in any rational order. I just added each one as I
//   found the need for it and/or got round to writing it
//
// - There don't need to be so many different response types, but there appears
//   to be no risk (yet) of running out
//
// - Requests don't mention ERROR as a possible response, because the server can
//   always send it back in response to anything
//
/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Expected AVR version. Updated when the protocol changes. If there's a
// mismatch between server, AVR and ROM then the problem parties will refuse to
// connect.
export const AVR_PROTOCOL_VERSION = 1;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// response is 1 byte: the protocol version.
export const CR_GET_PROTOCOL_VERSION = 1;

// wValue is the verbose flag: 0 = not verbose, other = verbose.
export const CR_SET_VERBOSE = 2;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export const FIRST_FILE_HANDLE = 0xB0;
export const NUM_FILE_HANDLES = 16;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// AVR presence check. **SPECIAL SYNTAX** **BBC->AVR only**
//
// The AVR accepts the $01 byte with the usual handshaking, but does nothing
// with it, does not expect any payload, and sends no response. Use this (in
// conjunction with a timeout) to check whether the AVR is actually connected to
// the user port.
export const REQUEST_AVR_PRESENCE = 0x00;

// Make a request of the AVR specifically. It deals with these itself and
// doesn't pass them on to the server.
//
// P = one of the REQUEST_AVR_READY values
export const REQUEST_AVR = 0x01;

// Get the BeebLink support ROM.
//
// Response is DATA where P = the ROM data.
//
// P = unused
export const REQUEST_GET_ROM = 0x02;

// Indicate that the BBC was reset.
//
// Response is YES.
//
// P = reset type as per OSBYTE 253 (AUG p244)
export const REQUEST_RESET = 0x03;

// Request an echo'd DATA response with whatever payload accompanies this
// request.
//
// P = whatever.
export const REQUEST_ECHO_DATA = 0x04;

// Get next char from the current string.
//
// Response is DATA with chars (up to the max requested - don't send more, the
// ROM won't deal with it gracefully) if there are chars left, or NO if the
// string has been consumed.
//
// The string is accessed in small pieces so that the response can be buffered
// entirely before an OSWRCH is issued - this so that *SPOOL (etc.) can work.
// Don't allow nested requests.
//
// P = 1 byte, max number of chars to return (0 = return 1 char)
export const REQUEST_READ_STRING = 0x05;

// Do a *CAT. Sets the current string to the text to output.
//
// Response is YES.
//
// P = remainder of command line
export const REQUEST_STAR_CAT = 0x06;

// Sets the current string to the *HELP BLFS text.
//
// Response is TEXT.
export const REQUEST_HELP_BLFS = 0x07;

// Exactly as REQUEST_READ_STRING, but it's OK to print debug logging if it's
// compiled in.
export const REQUEST_READ_STRING_VERBOSE = 0x08;

// Do a *RUN or */.
//
// Response is TEXT or RUN.
//
// P = command line
export const REQUEST_STAR_RUN = 0x09;

// Do a * command.
//
// Response is TEXT, RUN or SPECIAL.
//
// P = command line
export const REQUEST_STAR_COMMAND = 0x0a;

// Do an OSFILE.
//
// P = A; 16 byte parameter block; CR-terminated file name. Additionally, when
// A=0: file data.
//
// Response is OSFILE.
export const REQUEST_OSFILE = 0x0b;

// Do an OSFIND that opens a file.
//
// Response is OSFIND.
//
// P = A; file name
export const REQUEST_OSFIND_OPEN = 0x0c;

// Do an OSFIND that closes a file.
//
// Response is OSFIND.
//
// P = file handle
export const REQUEST_OSFIND_CLOSE = 0x0d;

// Do an OSARGS.
//
// Response is OSARGS.
//
// P = A; Y; 4-byte control block
export const REQUEST_OSARGS = 0x0e;

// Check EOF.
//
// Response is EOF.
//
// P = handle
export const REQUEST_EOF = 0x0f;

// Do an OSBGET.
//
// Response is OSBGET or OSBGET_EOF.
//
// P = handle
export const REQUEST_OSBGET = 0x10;

// Do an OSBPUT.
//
// Response is YES.
//
// This is sadly not as efficient as OSBGET. In fact, it's as bad as it can
// possibly be.
//
// P = handle; byte
export const REQUEST_OSBPUT = 0x11;

// Do a *INFO or *EX due to Master 128 OSFSC call.
//
// Response is TEXT.
//
// P = command line following *INFO or *EX
export const REQUEST_STAR_INFO = 0x12;
export const REQUEST_STAR_EX = 0x13;

// Do an OSGBPB.
//
// Response is OSGBPB.
//
// P = A; 13 byte parameter block; data as appropriate
export const REQUEST_OSGBPB = 0x14;

// Do a *OPT.
//
// Response is YES.
//
// P = X; Y
export const REQUEST_OPT = 0x15;

// Get boot option for current drive.
//
// Response is BOOT_OPTION.
//
// P = unused
export const REQUEST_BOOT_OPTION = 0x16;

// Make a volume browser-related request.
//
// P = 1 byte, the request sub-type; then additional payload, as described in
// the comments below.
export const REQUEST_VOLUME_BROWSER = 0x17;

// Make a speed test-related request.
//
// P = 1 byte, the request sub-type; then additional payload, as described in
// the comments below.
export const REQUEST_SPEED_TEST = 0x18;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// REQUEST_AVR types.

// Check if AVR is ready. Response (if present) is YES or NO with a payload of
// AVR_PROTOCOL_VERSION.
export const REQUEST_AVR_READY = 0;

// Produce an error.
export const REQUEST_AVR_ERROR = 1;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// REQUEST_VOLUME_BROWSER sub-types.

// Request a reset.
//
// Response is TEXT.
//
// P = 1 byte, display memory type (as per &34f); 1 byte, text display width; 1
// byte, text display height
export const REQUEST_VOLUME_BROWSER_RESET = 0;

// A key was pressed, so do something.
//
// Response is VOLUME_BROWSER with additional info.
//
// As a bit of a hack, if the response is TEXT, the first byte of the payload -
// ordinarily unused - is 0 if the keyboard buffer should be flushed, and non-0
// otherwise. Sometimes when updating the UI it's best to flush the keyboard
// buffer, and sometimes it isn't.
//
// P = 1 byte, SHIFT pressed flag (0=no, yes otherwise); 1 byte, the ASCII key
// value assuming *FX4,1
export const REQUEST_VOLUME_BROWSER_KEYPRESS = 1;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// REQUEST_SPEED_TEST sub-types.

// Start speed test.
//
// Response is YES.
//
// P = none
export const REQUEST_SPEED_TEST_RESET = 0;

// Run one round of the test.
//
// Response is DATA with the N bytes of data to send next time.
//
// P = 1 byte, parasite memory flag (0 = host memory, else = parasite); then N
// bytes of data.
export const REQUEST_SPEED_TEST_TEST = 1;

// Submit stats for the previous round of the test.
//
// Response is YES.
//
// P = 1 byte, parasite memory flag (0 = host memory, else = parasite); 4 bytes,
// number of bytes; 2 bytes, transmit centiseconds; 2 bytes, receive
// centiseconds
//
// (65535 centiseconds = ~10 minutes...)
export const REQUEST_SPEED_TEST_STATS = 2;

// Get server to calculate the stats and fill in the server string with the
// result.
//
// Response is TEXT.
export const REQUEST_SPEED_TEST_DONE = 3;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Reserved for future expansion.
export const RESPONSE_RESERVED = 0x00;

// Simple yes/no response.
export const RESPONSE_NO = 0x01;
export const RESPONSE_YES = 0x02;

// Response with data.
//
// P = the data
export const RESPONSE_DATA = 0x03;

// Indicates a BRK should be produced.
//
// P = the full BRK data: BRK, error byte, error text, BRK
export const RESPONSE_ERROR = 0x04;

// Indicates the server has responded by setting up its string. Use READ_STRING
// requests to get it.
//
// P = unused
export const RESPONSE_TEXT = 0x05;

// Indicates the server has responded with something to *RUN.
//
// P = 1 byte command line tail offset, 4 bytes LE load address, 4 bytes LE
// execution address, N bytes to store starting from load address
export const RESPONSE_RUN = 0x06;

// Respond to an OSFILE.
//
// P = result A; 16 new bytes for the parameter block. Additionally, when A=$ff:
// 4 bytes data load address, then file data.
export const RESPONSE_OSFILE = 0x07;

// Respond to an OSFIND.
//
// If the result is a file handle, it is a 1-based server handle.
//
// P = new value for accumulator.
export const RESPONSE_OSFIND = 0x08;

// Respond to an OSARGS.
//
// P = 4 bytes, new value for the zero page control block.
export const RESPONSE_OSARGS = 0x09;

// Respond to an EOF.
//
// P = 0xFF if EOF, 0x00 if not.
export const RESPONSE_EOF = 0x0a;

// Respond to an OSBGET.
//
// If OSBGET, P = byte read, and C clear on exit.
//
// If OSBGET_EOF, P = (bogus) byte read, and C set on exit.
export const RESPONSE_OSBGET = 0x0b;
export const RESPONSE_OSBEGT_EOF = 0x0c;

// Respond to an OSGBPB.
//
// P = result (1/0 - value for C); 13 new bytes for the parameter block; the data, if appropriate.
export const RESPONSE_OSGBPB = 0x0d;

// Respond to a BOOT_OPTION.
//
// P = boot option
export const RESPONSE_BOOT_OPTION = 0x0e;

// Indicates the server wants the ROM to do something special. This is just a
// hack so that all FS-specific * commands can be interpreted on the server as
// part of the OSFSC handling, including ones that actually need to be handled
// by the ROM.
//
// Uncertain how much use this will actually get...
//
// P = 1 byte special action type, then whatever other stuff.
export const RESPONSE_SPECIAL = 0x0f;

// Some kind of volume browser-related response.
//
// P = 1 byte, the exact respones type.
export const RESPONSE_VOLUME_BROWSER = 0x10;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// RESPONSE_SPECIAL types.

// Do the volume browser.
export const RESPONSE_SPECIAL_VOLUME_BROWSER = 0;

// Do the speed test.
export const RESPONSE_SPECIAL_SPEED_TEST = 1;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// RESPONSE_VOLUME_BROWSER types.

// Volume browser was canceled.
export const RESPONSE_VOLUME_BROWSER_CANCELED = 0;

// Disc was mounted.
export const RESPONSE_VOLUME_BROWSER_MOUNTED = 1;

// Disc was mounted, and ROM should try to auto-boot it.
export const RESPONSE_VOLUME_BROWSER_BOOT = 2;

// The keypress was ignored.
export const RESPONSE_VOLUME_BROWSER_KEY_IGNORED = 3;

// ROM should print the server's string.
export const RESPONSE_VOLUME_BROWSER_PRINT_STRING = 4;

// ROM should print the server's string and flush the keyboard buffer.
export const RESPONSE_VOLUME_BROWSER_PRINT_STRING_AND_FLUSH_KEYBOARD_BUFFER = 5;
