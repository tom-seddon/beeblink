# BeebLink technical documentation

Some random notes about stuff.

# Design goals

Goals for the BeebLink protocol:

0. Simple flow control. The data transfer is either client to server
   or server to client, and it's easy to say which.
   
   (This is to allow the use of a half duplex link.)

1. Straightforwardly snoopable. A device sitting between server and
   client should be able to monitor the data flow closely enough to
   ensure that the data is transferred correctly, without needing to
   know all the possible types of data that could be sent.
   
   (This is to avoid a situation where any such device needs upgrading
   every time a new feature is added.)

2. Low bandwidth demands. The Beeb can transmit and receive data only
   so quickly. Try not to send more bytes than necessary, and try to
   minimize overhead.
   
   (Current link types haven't really stress-tested this, but I had
   19200 baud serial port support in mind.)

3. Minimize client processing. It's OK to waste server resources to do
   this, or have the client assume that data is the right size.

   (The server is running on a PC (or similar) with tons of RAM and
   lots of MHz.)
   
4. Must handle BREAK cleanly and promptly, cancelling any data that's
   in flight and putting things back in a known state. Any delay
   should be as short as possible.

   (You can press BREAK at any time. The system should become useable
   again promptly.)
   
5. Ensure nested requests don't happen. Should be able to spool server
   output to a file, for example.
   
   (Not a major issue, but I've previously used systems that would
   deadlock from this, and it's a bit annoying when it happens.)
   
Non-goals:

0. High latency support. Assume server and client are connected via a
   cable or something, and that the round trip time for a
   latency-bound request is ~2 ms.

   (This means the system can hopefully get away with minimal
   buffering, something for which there's not much room in 32 KB.)
   
1. Server->client requests. The client is strictly a client, and can
   only accept data in response to a request it's made of the server.
   
   (For some link types, there's no interrupt option.)
   
2. Gracefully handling server disconnection.

# Layering

This could probably be mapped to the OSI 7-layer model, in that
there's sort of separate link/protocol/application layers, but the
link and protocol layers are not separated very cleanly. 

# Basic flow

The flow is very simple:

0. Client sends entire request message to server

1. Server sends entire response message to client

There is no support for the server sending anything to the client
other than in response to a request. 

No response is sent until the entire request is received, and any
response is prepared ahead of time so it can be sent completely. The
server is not allowed to send partial responses.

# Message format

The format is deliberately simple: each message consists of a 7-bit
message type, and an N-byte payload, where N is a 32 bit value.

Messages type 0 is reserved for link-specific uses.

# Message types

Mostly out of scope for this doc... the best "documentation" is the
.ts file that is the authoritative list of numbers and payload
formats, along with a few notes: [beeblink.ts](../server/beeblink.ts).
This file is used as-is by the TypeScript code, and
[preprocessed](../tools/make_constants.py) to create an include file
useable by the 6502 ROM code.

Request types are 7-bit numbers, divided up as follows:

- $00 - $01 - link-specific requests with unspecified behaviour
- $02...$5f - ordinary requests. Beeb sends request and waits for
  server to send expected response back
- $60...$6f - fire-and-forget requests that produce no ordinary
  response. Beeb sends request, then (when possible for link type)
  continues immediately, under the assumption the server will receive
  the request in due course
- $70...$7e - reserved for additional future expansion
- $7f - always invalid

Response types are 7-bit numbers, divided up as follows:

- $00 - reserved
- $01...$5f - ordinary response, sent in response to an ordinary
  request
- $70...$7f - speculative responses, sent following on from an
  ordinary response, sent in advance to be cached or held in a FIFO or
  something. These responses are not guaranteed to arrive

Response type $04 is the error response, indicating that the BBC
should produce a BRK message containin the supplied text.

Speculative responses are speculative, so they may just get thrown
away sight unseen at the client end if the situation changes. Also,
not all link types support speculative responses, so they may get
dropped by the server internally. The protocol just has to be
resistant to their non-arrival. (Perhaps obviously: speculative
responses should be short. It will take time to throw them away.)

Notes:

- text produced by the server is retrieved in parts, one
  request/response per part. Each part is buffered on the stack, then
  printed out, so that there's never a request/response in flight when
  `OSWRCH` is called. This ensures you can spool server output

- any non-fire-and-forget request can always return ERROR. The
  request/response routine in the ROM looks after this by
  automatically issuing an appropriate BRK
  
- the HTTP link type doesn't support fire-and-forget requests yet

- the request/response type values are entirely arbitrary, and in no
  particular order. They're just assigned in the order I wrote the
  code for them

## Versioning

There isn't any versioning mechanism, other than being a bit careful.

## Message sub-types

Some of the earlier message types have 2-layer type mechanism, with
the first byte of the payload being a kind of message sub-type. The
idea here was to avoid exhausting the 7-bit message type space.

But it looks like there's little danger of this, and it's a bit more
hassle to code. So the later message types don't do this.

# Link types

There are two supported link types: HTTP, and serial (which covers
both UPURS and Tube Serial).

There's also a 3rd, unsupported type, AVR, which lives on because
that's what's emulated in
[b2, my BBC Micro emulator](https://github.com/tom-seddon/b2) -
something I haven't got round to updating yet.

## HTTP

The protocol maps fairly cleanly to HTTP, aside from the latency.

All requests are in the form of an HTTP `POST` to the `/request`
endpoint.

HTTP being stateless, the header must include a `beeblink-sender-id`
value, an arbitrary string that identifies the client making the
request. (This should be different for every Beeb connecting.)

The request body must be `application/binary`, a sequence of bytes:
the 1-byte message type (bit 7 ignored), and the N-byte payload.

To handle BREAK, forcibly close the open TCP connection, if there is
one.

(The HTTP protocol is currently used only by b2. The emulated BBC
appears to have an AVR attached, and the emulator handles the
communication with the HTTP server.)

New endpoint name(s) will be added when this mechanism needs extending
or improving.

## Serial

These serial link types are quite different from the Beeb side (see
the driver code: [tube_serial.s65](../rom/tube_serial.s65),
[upurs.s65](../rom/upurs.s65)), but they're treated the same on the
server as they present themselves as USB COM ports.

The only fiddly part about supporting the serial link is handling
resets. There's no out-of-band mechanism for closing the connection,
and the link could be buffering some unknown amount of data.

The way BeebLink handles this is to add additional so-called status
bytes during transfers. These have 2 purposes:

0. indicate that the ongoing transfer is still valid, and hasn't been
   cancelled

1. ensure that certain sequences of bytes will never occur during
   ordinary transmission. Such sequences can be used to reset the link

### Status bytes

Non-empty request payloads include status bytes at particular points,
based on the LSB of the byte's negative offset, i.e.,
`-((payload_size)-1-(offset of byte))`. (The first byte's negative
offset is `-((payload_size)-1)`, and the last byte's is `0`.)

When the LSB of the byte's negative offset is `0x00`, the byte sent
should be followed by a status byte.

(This makes a lot more sense in 6502 than it does in text! When
transferring data, the LSB of the byte's negative offset can be found
in `scratch_payload_size+0`.)

For client->server payloads, the status bytes indicate whether the
request was cancelled or not. To indicate a non-cancelled request,
send `0x01`; to indicate cancellation, send `0x00` or `0x80`.

For server->client payloads, the status bytes are never `0x00` or
`0x80`, as the server isn't allowed to cancel responses. But status
bytes are still sent, as they fulfil purpose 1 above.

There are two valid status byte values:

- `0x01` - ordinary non-zero status byte
- `0x02` - if the last status byte of a response, indicates an
  additional speculative response follows 

The client uses status byte `0x02` to correctly discard unwanted
speculative responses without having to worry about the timing.

### Sync mode

Sync mode allows both sides to flush all buffers (serial device
buffer, server OS buffers...) and get themselves in a known state.

The client initiates sync mode simply by doing it. If the server
receives data while sending, it switches to sync mode; otherwise, the
sync bytes are status bytes that indicate the current transfer is
being cancelled, and message type bytes that indicate the server
should embark on sync mode. So the server will end up in sync mode,
whatever type of data it might be expecting.

From the client side:

0. emit 1 `0x80` byte

1. emit continuous `0x00` bytes while reading from the server. Count
   runs of `0x00` received, and discard everything else. Repeat until
   `NUM_SERIAL_SYNC_ZEROS` consecutive `0x00` bytes have been received
   
2. continuie emitting `0x00` bytes while reading from the server. A
   `0x01` from the server indicates sync complete; `0x00` bytes can be
   ignored; any other value is an error
   
3. emit a single `0x01` byte to indicate that sync is complete

The server enters sync mode after a request is cancelled, or when it
receives a byte indicating a message type of 0 (i.e., `0x00` or
`0x80`), or when it receives data while sending a response.

From its side:

0. flush serial port buffers, to hopefully minimize the amount of data
   the client has to discard

1. read client data, counting runs of `0x00`, and discarding
   everything else, until `NUM_SERIAL_SYNC_ZEROS` consective `0x00`
   bytes have been received
   
2. emit `NUM_SERIAL_SYNC_ZEROS` x `0x00` bytes, followed by a single
   `0x01` byte. (This can be done as one lump, at the start of the
   process; the data will be buffered up and will appear at the client
   end in due course)

3. read client data: a `0x01` indicates sync complete, and it's done;
   `0x00` bytes should be ignored; any other value is an error, so go
   back to step 0

(Client sync step 0 exists to get the server out of server sync step
3, if it's stuck there.)

`NUM_SERIAL_SYNC_ZEROS` is currently 300 - something like 0.05 seconds
at the UPURS transfer rate. (This is slightly generous. The worst case
run of `0x00` bytes is 258, I think: a message with a 255 byte
payload that's entirely `0x00`.)

### 1-byte payloads

There is a special shorter encoding for requests and responses with
1-byte payloads. This isn't essential, but it doesn't hurt (it's not
much code, and there are a lot of 1-byte payloads), and it makes
BeebLink's terrible OSBGET performance a bit less terrible.

Messages with arbitrary-sized payloads have the following format:

```
      7   6   5   4   3   2   1   0
   +---+---+---+---+---+---+---+---+
+0 | 1 | type                      |
   +---+---+---+---+---+---+---+---+
+1 | payload size bits 0-7         |
   +---+---+---+---+---+---+---+---+
+2 | payload size bits 8-15        |
   +---+---+---+---+---+---+---+---+
+3 | payload size bits 16-23       |
   +---+---+---+---+---+---+---+---+
+4 | payload size bits 24-31       |
   +---+---+---+---+---+---+---+---+
+5 | payload first byte            |
   +...                            +
+N | payload last byte             |
   +---+---+---+---+---+---+---+---+
```

Messages with 1-byte payloads have the following format:

```
      7   6   5   4   3   2   1   0
   +---+---+---+---+---+---+---+---+
+0 | 0 | type                      |
   +---+---+---+---+---+---+---+---+
+1 | payload, 1 byte               |
   +---+---+---+---+---+---+---+---+
```

Notes:

- a 0-byte payload has to be encoded using the N-byte format, even
  though that's more bytes than an optimal 1-byte payload

- a 1-byte payload may use either the 1-byte or N-byte format. Both
  are equally valid
  
- OSBPUT needs a 2-byte packet :( - but you should be using OSGBPB
  anyway

## AVR

Early versions of BeebLink handled BBC to PC communication with an AVR
microcontroller that connected to the PC's USB port and the BBC's user
port.

Last BeebLink commit that supported this:
https://github.com/tom-seddon/beeblink/commit/1344cafc18a47b80e00018c13f05e15395ab7c80
(5 May 2019)

Some indication of how it worked can also be gleaned from the b2
source:
[BeebLink.cpp](https://github.com/tom-seddon/b2/blob/a0b8957cda511dbedc36703e09421d4787864a67/src/beeb/src/BeebLink.cpp)

The AVR version also uses the shorter message format for 1-byte
payloads.

The user port is half duplex. The device firmware watches the messages
so it knows whether transmission will be client->server or
server->client.

The device uses the user port write handshaking to manage transmission
of bytes to the BBC. BREAK is handled by disabling the write
handshaking, something the firmware can detect and report to the
server via a USB stall.

# Adding new link types

## 6502 side

See `beeblink.s65`. Follow the existing examples to include the driver
code for the new type.

There are a bunch of symbols to define in the driver code, and some
64tass sections for reserving space in zero page.

The existing driver code should serve as an example.

### Zero page ###

To reserve temporary zero page space for the link startup code, create
a `.section` called `link_startup_workspace`. This consumes space
somewhere in the $a8...$af area.

To reserve persistent zero page space for the link, create a
`.section` called `link_workspace`. This goes somewhere in $c0...$cf -
fitted around whatever the rest of the code needs - so it will be
preserved as long as the BLFS is active.

If using the NMI region, the `nmi_workspace` section reserves space in
the NMI zero page area ($a0...$a7) and the `nmi_area` section reserves
space in the NMI area starting at $d00. Call `claim_nmi` and
`release_nmi` to claim and release the NMI area. (The UPURS driver
would serve as an example of this.)

There'll be an assembly error if any of these sections are too large.

### `link_name` ###

Name of the link, a string, as included in the ROM name.

### `link_subtype` ###

Link subtype, a byte. Used to distinguish links that aren't otherwise
distinguishable from the PC end, e.g., UPURS vs Tube Serial.

### `link_begin_send_with_restart`, `link_begin_send_without_restart`

Prepare to send a request. A is the request type, and
`payload_counter` holds the payload size. Send appropriate header and
prepare for sending the given number of payload bytes.

If it's possible to check the link status reasonably quickly
(milliseconds...), `link_begin_send_with_restart` should do that, and
re-initialise the link if anything has gone wrong, returning with
carry clear. If the reinitialise fails, return with carry set as per
`link_startup`.

`link_begin_send_with_restart` could also initialise values in
`link_workspace` for subsequent use by
`link_begin_send_without_restart`.

The FS uses the `_with_restart` entry point for pretty much every
request, except for a few where throughput is important or the risk of
programs having trampled on the relevant hardware is low:

- `OSBPUT`/`OSBGET`/`EOF#` (performance in a loop is bad enough as it
  stands, no point making it worse...),

- some of the `*` command stuff (if it's happening, it was because the
  server responded to a `REQUEST_STAR_COMMAND`, so the link is good)

- `print_server_string` (same justification as the `*` commands, and
  it helps a bit with throughput)

It's fine for both routines to be the same, but make sure then that
`link_begin_send_with_restart` returns with carry clear...

Preserve X/Y. Preserve `payload_counter`.

### `link_send_payload_byte` ###

Send 1 byte over the link as part of the payload. `payload_counter`
holds the byte's negated offset.

Preserve X/Y.

### `link_begin_recv` ###

Prepare to receive a response. Return the response header in A.
Initialize `payload_counter` to the response payload size.

### `link_recv_payload_byte` ###

Receive 1 byte over the link as part of the payload. `payload_counter`
holds the byte's negated offset.

Preserve X/Y.

### `link_unprepare` ###

Unrepare link after a request/response sequence. Do whatever's
necessary.

Preserve X/Y.

### `link_startup`, `link_status_text` ###

Initialise link and determine status.

On exit, if link OK, carry clear.

If link not OK, carry set, and `X` holds offset into
`link_status_text` of 0-terminated string describing status.
               
### `link_send_file_data_parasite`, `link_send_file_data_host`, `link_recv_file_data_parasite`, `link_recv_file_data_host` ###

Send/receive file data from/to host/parasite memory.

File data is whatever's left in the current message according to
`payload_counter`, a non-zero negated number of bytes left. The data
is read/written starting at `payload_addr` (a 32-bit address that's
already known to point into host/parasite memory as appropriate for
the routine called).

May modify `payload_counter`.

These are weak symbols. If not defined, link-agnostic code will be
used, that simply calls `link_(send|recv)_payload_byte` repeatedly.
This works, but you probably won't get max throughput...

## Server side

TBD...

# New OSWORD call

OSWORD $99 - perform BeebLink call

Parameter block `B` on entry:

| Value | Description |
| --- | --- |
| `B?0` | Length of input parameter block - must be 22 |
| `B?1` | Length of output parameter block - must be 22 |
| `B?2` | Request code |
| `B?3` | Space for response code - set to $00 |
| `B?4` | Reserved - must be $00 |
| `B?5` | Reserved - set to $00 |
| `B!6` | Address of request payload |
| `B!10` | Size of request payload |
| `B!14` | Address for response payload |
| `B!18` | Max size of response payload |

Parameter block `B` on exit:

| Value | Description |
| --- | --- |
| `B?0` | 22 |
| `B?1` | 22 |
| `B?2` | Request code |
| `B?3` | Response code |
| `B?4` | Reserved |
| `B?5` | FS ID of BeebLink ROM that handled the request |
| `B!6` | Address of request payload |
| `B!10` | Size of request payload |
| `B!14` | Address for response payload |
| `B!18` | Total size of response payload |

Addresses are the standard Acorn 32-bit addresses - so when running
over the Tube, $FFFFxxxx is the I/O processor and other addresses are
the parasite.

The total size of response payload on exit is the amount the server
tried to send. If it is greater than the max requested, the data was
truncated.

## Request codes

| Code | Description |
| --- | --- |
| $00 | ROM presence check |
| $01...$7f | Server request |
| $80...$ff | Reserved |

To check for the BeebLink ROM, set `B?3` to 0 before making request
$00, then check `B?3` on exit - it will be non-zero if the ROM is
present.

## Response codes

| Code | Description |
| --- | --- |
| $00 | Reserved |
| $01...$7f | Server response |
| $80...$fe | Reserved |
| $ff | Error |

## Notes

- it's OK for request and response payload to overlap. The request is
  sent in its entirety before the response is stored

- don't call this from an interrupt or event handler!

- if the BeebLink FS is inactive at the time of the call, it will
  sneak in, temporarily initialize itself behind the active filing
  system's back, do the thing, then try to put things back the way
  they were afterwards. (It does things this way to prevent the DFS
  re-seeking the disk to track 0 on next use, something that's a real
  pain if trying to read or write disk images.) This seems to be
  reliable, but... YMMV
  
- the ROM checks `B?0` and `B?1`, and the call will fail if they're
  wrong. Current intention is to use these values for API versioning
