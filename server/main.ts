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

// npm start -- -v --rom ../rom/.build/beeblink.rom --retry-device --mount beeblink ~/beeb/beeblink/bbc_tests ~/beeb/beeb-files/stuff
// npm start -- -v --rom ../rom/.build/beeblink.rom --retry-device --fs-verbose --mount beeblink c:\tom\github\beeblink\bbc_tests

import * as argparse from 'argparse';
import * as utils from './utils';
import * as usb from 'usb';
import * as util from 'util';
import * as assert from 'assert';
import * as beeblink from './beeblink';
import * as beebfs from './beebfs';
import { Server } from './server';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// pain to do this properly with argparse.
const DEFAULT_USB_VID = 0x3eb;
const DEFAULT_USB_PID = 0x206c;

const DEVICE_RETRY_DELAY_MS = 1000;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface ICommandLineOptions {
    verbose: boolean;
    device: number[];
    rom: string | undefined;
    fs_verbose: boolean;
    mount: string;
    retry_device: boolean;
    send_verbose: boolean;
    fatal_verbose: boolean;
    folders: string[];
}

//const gLog = new utils.Log('', process.stderr);
const gError = new utils.Log('ERROR', process.stderr);
//const gSendLog = new utils.Log('SEND', process.stderr);

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class InEndpointReader {
    private endpoint: usb.InEndpoint;
    private buffers: Buffer[];
    private bufferPos: number;//always points into this.buffers[0]

    public constructor(endpoint: usb.InEndpoint) {
        this.endpoint = endpoint;
        this.buffers = [];
        this.bufferPos = 0;
    }

    public async readUInt8(): Promise<number> {
        if (this.buffers.length === 0) {
            this.buffers.push(await new Promise<Buffer>((resolve, reject) => {
                this.endpoint.transfer(this.endpoint.descriptor.wMaxPacketSize, (error, data) => {
                    if (error !== undefined) {
                        reject(error);
                    } else {
                        resolve(data);
                    }
                });
            }));

            assert.strictEqual(this.bufferPos, 0);
        }

        const value = this.buffers[0][this.bufferPos++];
        if (this.bufferPos >= this.buffers[0].length) {
            this.buffers.splice(0, 1);
            this.bufferPos = 0;
        }

        return value;
    }

    public async readUInt32LE(): Promise<number> {
        const b0 = await this.readUInt8();
        const b1 = await this.readUInt8();
        const b2 = await this.readUInt8();
        const b3 = await this.readUInt8();

        return b0 | b1 << 8 | b2 << 16 | b3 << 24;
    }

    public async readBytes(size: number): Promise<Buffer> {
        // There's probably not much point trying to be any cleverer than
        // this...
        const data = Buffer.alloc(size);

        for (let i = 0; i < size; ++i) {
            data[i] = await this.readUInt8();
        }

        return data;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function findSingleEndpoint(interf: usb.Interface, direction: string): usb.Endpoint | undefined {
    const endpoints = interf.endpoints.filter((endpoint) => endpoint.direction === direction);
    if (endpoints.length !== 1) {
        return undefined;
        //throw new Error('failed to find exactly 1 ' + direction + ' endpoint');
    }

    return endpoints[0];
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function deviceControlTransfer(device: usb.Device, bmRequestType: number, bRequest: number, wValue: number, wIndex: number, dataOrLength: number | Buffer | undefined): Promise<Buffer | undefined> {
    return await new Promise<Buffer | undefined>((resolve, reject) => {
        if (dataOrLength === undefined) {
            dataOrLength = Buffer.alloc(0);
        }
        device.controlTransfer(bmRequestType, bRequest, wValue, wIndex, dataOrLength, (error, buffer) => {
            if (error !== undefined) {
                reject(error);
            } else {
                resolve(buffer);
            }
        });
    });
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// async function inEndpointTransfer(endpoint: usb.InEndpoint, numBytes: number): Promise<Buffer> {
//     return await new Promise<Buffer>((resolve, reject) => {
//         endpoint.transfer(numBytes, (error, data) => {
//             if (error !== undefined) {
//                 reject(error);
//             } else {
//                 resolve(data);
//             }
//         });
//     });
// }

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function getEndpointDescription(endpoint: usb.Endpoint): string {
    return 'bEndpointAddress=' + utils.hexdec(endpoint.descriptor.bEndpointAddress) + ', wMaxPacketSize=' + endpoint.descriptor.wMaxPacketSize;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IBeebLinkDevice {
    device: usb.Device;
    inEndpoint: usb.InEndpoint;
    outEndpoint: usb.OutEndpoint;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function findBeebLinkDevice(vid: number, pid: number, log: utils.Log): Promise<IBeebLinkDevice | undefined> {
    const device = usb.findByIds(vid, pid);
    if (device === undefined) {
        gError.pn('Device not found: VID=0x' + utils.hex4(vid) + ' PID=0x' + utils.hex4(pid));
        return undefined;
    }

    device.open(false);

    // util.promisify doesn't seem to be compatible with
    // Device.setConfiguration, seemingly because the callback is
    // (error?:string)=>Void rather than (error|null)=>Void.
    await new Promise((resolve, reject) => device.setConfiguration(1, (error) => error !== undefined ? reject(error) : resolve()));

    const interf = device.interface(0);
    interf.claim();

    log.pn('Searching for endpoints...');
    const inEndpoint = findSingleEndpoint(interf, 'in');// as usb.InEndpoint;
    const outEndpoint = findSingleEndpoint(interf, 'out');// as usb.OutEndpoint;
    if (inEndpoint === undefined || outEndpoint === undefined) {
        gError.pn('Failed to find 1 input and 1 output endpoint');
        return undefined;
    }

    const buffer = await deviceControlTransfer(device, usb.LIBUSB_REQUEST_TYPE_CLASS | usb.LIBUSB_RECIPIENT_DEVICE | usb.LIBUSB_ENDPOINT_IN, beeblink.CR_GET_PROTOCOL_VERSION, 0, 0, 1);

    log.pn('AVR version: ' + buffer![0]);

    if (buffer![0] !== beeblink.AVR_PROTOCOL_VERSION) {
        gError.pn('Wrong protocol version: ' + utils.hex2(buffer![0]) + ' (want: ' + utils.hex2(beeblink.AVR_PROTOCOL_VERSION));
        return undefined;
    }

    return { device, inEndpoint: inEndpoint as usb.InEndpoint, outEndpoint: outEndpoint as usb.OutEndpoint };
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function delayMS(ms: number) {
    await new Promise((resolve, reject) => setTimeout(() => resolve(), ms));
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function main(options: ICommandLineOptions) {
    const log = new utils.Log('', process.stderr, options.verbose);
    //gSendLog.enabled = options.send_verbose;

    if (Number.isNaN(options.device[0]) || Number.isNaN(options.device[1])) {
        throw new Error('invalid USB VID/PID specified');
    }

    if (options.folders.length === 0) {
        throw new Error('no folders specified');
    }

    log.pn('USB Recv Test');
    log.pn('Device VID/PID: ' + options.device);

    let beebLink: IBeebLinkDevice | undefined;

    let done = false;
    let stalled = false;

    const bfs = new beebfs.BeebFS(options.fs_verbose, options.folders);

    const mountError = await bfs.mountByName(options.mount);
    if (mountError !== undefined) {
        throw new Error('Failed to mount initial volume: ' + mountError);
    }

    const server = new Server(options.rom, bfs);

    while (!done) {
        try {
            let message = false;
            while (beebLink === undefined) {
                beebLink = await findBeebLinkDevice(options.device[0], options.device[1], log);
                if (beebLink !== undefined) {
                    break;
                }

                if (!options.retry_device) {
                    throw new Error('No device found');
                }

                if (!message) {
                    gError.pn('Device not found. Will keep trying.');
                    message = true;
                }

                await delayMS(DEVICE_RETRY_DELAY_MS);
            }

            if (stalled) {
                log.pn('Clearing any in endpoint stall condition...');

                await deviceControlTransfer(beebLink.device,
                    usb.LIBUSB_REQUEST_TYPE_STANDARD | usb.LIBUSB_RECIPIENT_ENDPOINT,//bmRequestType - 00000010
                    usb.LIBUSB_REQUEST_CLEAR_FEATURE,//bRequest
                    0,//wValue - ENDPOINT_HALT
                    beebLink.inEndpoint.descriptor.bEndpointAddress,//wIndex
                    undefined);

                log.pn('Clearing any out endpoint stall condition...');

                await deviceControlTransfer(beebLink.device,
                    usb.LIBUSB_REQUEST_TYPE_STANDARD | usb.LIBUSB_RECIPIENT_ENDPOINT,//bmRequestType - 00000010
                    usb.LIBUSB_REQUEST_CLEAR_FEATURE,//bRequest
                    0,//wValue - ENDPOINT_HALT
                    beebLink.outEndpoint.descriptor.bEndpointAddress,//wIndex
                    undefined);

                log.pn('Stall condition cleared.');
                stalled = false;
            }

            const reader = new InEndpointReader(beebLink.inEndpoint);

            //log.pn('Waiting for header...');
            const t = await reader.readUInt8();

            let payload: Buffer;
            if ((t & 0x80) === 0) {
                payload = Buffer.alloc(1);
                payload[0] = await reader.readUInt8();
            } else {
                const payloadSize = await reader.readUInt32LE();
                payload = await reader.readBytes(payloadSize);
            }

            //const r = t & 0x7f;

            //const writer = new OutEndpointWriter(beebLink.outEndpoint);

            const response = await server.handleRequest(t & 0x7f, payload);

            await new Promise((resolve, reject) => {
                beebLink!.outEndpoint.transfer(response.getData(), (error) => error !== undefined ? reject(error) : resolve());
            });

            // if (!writer.wasEverWritten()) {
            //     throw new Error('Server didn\'t handle request: 0x' + utils.hex2(t & 0x7f));
            // }

            // await writer.flush();

            //log.pn('All done (probably)');
        } catch (anyError) {
            const error = anyError as Error;
            if (error.message === 'LIBUSB_TRANSFER_STALL') {
                gError.pn('endpoint stalled');
                stalled = true;
            } else if (error.message === 'LIBUSB_ERROR_PIPE' && options.retry_device) {
                gError.pn('device went away - will try to find it again...');
                beebLink = undefined;

                // This is a bodge to give the device a bit of time to reset and
                // sort itself out.
                await delayMS(DEVICE_RETRY_DELAY_MS);
            } else {
                gError.pn(anyError.stack);
                gError.pn(error.toString());
                done = true;
            }
        }
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// crap name for it, but argparse pops the actual function name in the error
// string, so it would be nice to have something meaningful.
//
// https://github.com/nodeca/argparse/pull/45
function usbVIDOrPID(s: string): number {
    const x = parseInt(s, undefined);
    if (Number.isNaN(x)) {
        throw new Error('invalid number provided: "' + s + '"');
    }

    return x;
}

{
    const parser = new argparse.ArgumentParser({
        addHelp: true,
        description: 'BeebLink server',
    });

    parser.addArgument(['-v', '--verbose'], { action: 'storeTrue', defaultValue: false, help: 'extra output' });
    parser.addArgument(['--device'], { nargs: 2, metavar: 'ID', type: usbVIDOrPID, defaultValue: [DEFAULT_USB_VID, DEFAULT_USB_PID], help: 'set USB device VID/PID. Default: 0x' + utils.hex4(DEFAULT_USB_VID) + ' 0x' + utils.hex4(DEFAULT_USB_PID) });
    parser.addArgument(['--rom'], { metavar: 'FILE', help: 'read BeebLink ROM from %(metavar)s' });
    parser.addArgument(['--fs-verbose'], { action: 'storeTrue', defaultValue: false, help: 'extra filing system-related output' });
    parser.addArgument(['--mount'], { metavar: 'VOLUME', defaultValue: '65boot', help: 'mount %(metavar)s when starting. Default: %(defaultValue)s' });
    parser.addArgument(['--retry-device'], { action: 'storeTrue', defaultValue: false, help: 'if device not found, try again after a short delay' });
    parser.addArgument(['--send-verbose'], { action: 'storeTrue', defaultValue: false, help: 'dump data sent to device' });
    parser.addArgument(['--fatal-verbose'], { action: 'storeTrue', help: 'print debugging info on a fatal error' });
    parser.addArgument(['folders'], { nargs: '*', metavar: 'FOLDER', help: 'folder to search for volumes' });

    const options = parser.parseArgs();

    main(options).then(() => {
        //process.('main promise completed');
    }).catch((error) => {
        if (options.fatal_verbose) {
            process.stderr.write('Stack trace:\n');
            process.stderr.write(error.stack + '\n');
        }
        process.stderr.write('FATAL: ' + error + '\n');
        process.exit(1);
    });
}
