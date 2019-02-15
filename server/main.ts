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

import * as argparse from 'argparse';
import * as utils from './utils';
import * as usb from 'usb';
import * as path from 'path';
import * as assert from 'assert';
import * as beeblink from './beeblink';
import * as beebfs from './beebfs';
import { Server } from './server';
import { Chalk } from 'chalk';
import chalk from 'chalk';
import * as gitattributes from './gitattributes';
import * as http from 'http';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// pain to do this properly with argparse.
const DEFAULT_USB_VID = 0x1209;
const DEFAULT_USB_PID = 0xbeeb;

const DEVICE_RETRY_DELAY_MS = 1000;

const DEFAULT_BEEBLINK_ROM = './beeblink.rom';

const DEFAULT_CONFIG_FILE_NAME = "beeblink_config.json";

const HTTP_LISTEN_PORT = 48875;//0xbeeb;

const BEEBLINK_SENDER_ID = 'beeblink-sender-id';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IConfigFile {
    folders: string[] | undefined;
    defaultVolume: string | undefined;
    rom: string | undefined;
    git: boolean | undefined;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface ICommandLineOptions {
    verbose: boolean;
    device: number[];
    rom: string | null;
    fs_verbose: boolean;
    server_verbose: boolean;
    default_volume: string | null;
    no_retry_device: boolean;
    send_verbose: boolean;
    fatal_verbose: boolean;
    folders: string[];
    avr_verbose: boolean;
    load_config: string | null;
    save_config: string | null;
    usb_verbose: boolean;
    set_serial: number | null;
    git: boolean;
    git_verbose: boolean;
    http: boolean;
    packet_verbose: boolean;
    http_all_interfaces: boolean;
    libusb_debug_level: number | null;
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

function getEndpointDescription(endpoint: usb.Endpoint): string {
    return 'bEndpointAddress=' + utils.hexdec(endpoint.descriptor.bEndpointAddress) + ', wMaxPacketSize=' + endpoint.descriptor.wMaxPacketSize;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IBeebLinkDevice {
    usbDevice: usb.Device;
    usbSerial: string;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

let gBeebLinkDeviceVID = DEFAULT_USB_VID;
let gBeebLinkDevicePID = DEFAULT_USB_PID;

async function findBeebLinkUSBDevices(): Promise<IBeebLinkDevice[]> {
    const usbDevices = usb.getDeviceList().filter((device) => {
        return device.deviceDescriptor.idVendor === gBeebLinkDeviceVID && device.deviceDescriptor.idProduct === gBeebLinkDevicePID;
    });

    const devices: IBeebLinkDevice[] = [];
    for (const usbDevice of usbDevices) {
        try {
            usbDevice.open(false);
        } catch (error) {
            continue;
        }

        let buffer: Buffer | undefined;
        try {
            buffer = await new Promise<Buffer | undefined>((resolve, reject) => {
                usbDevice.getStringDescriptor(usbDevice.deviceDescriptor.iSerialNumber,
                    (error, buf) => {
                        if (error !== undefined) {
                            reject(error);
                        } else {
                            resolve(buf);
                        }
                    });
            });
        } catch (error) {
            usbDevice.close();
            continue;
        }

        if (buffer === undefined) {
            continue;
        }

        devices.push({
            usbDevice,
            usbSerial: buffer.toString('utf16le'),
        });
    }

    return devices;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function delayMS(ms: number) {
    await new Promise((resolve, reject) => setTimeout(() => resolve(), ms));
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function loadConfig(options: ICommandLineOptions, filePath: string, mustExist: boolean): Promise<void> {
    let data;
    try {
        data = await utils.fsReadFile(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            if (!mustExist) {
                return;
            }
        }

        throw error;
    }

    const str = data.toString('utf-8');
    const config = JSON.parse(str) as IConfigFile;

    if (config.defaultVolume !== undefined && options.default_volume === null) {
        options.default_volume = config.defaultVolume;
    }

    // Keep config folders first.
    if (config.folders !== undefined) {
        for (let i = 0; i < config.folders.length; ++i) {
            options.folders.splice(i, 0, config.folders[i]);
        }
    }

    // Eliminate duplicate folders.
    {
        let i = 0;
        while (i < options.folders.length) {
            let j = i + 1;

            while (j < options.folders.length) {
                if (path.relative(options.folders[i], options.folders[j]) === '') {
                    options.folders.splice(j, 1);
                } else {
                    ++j;
                }
            }

            ++i;
        }
    }

    if (options.rom === null) {
        if (config.rom !== undefined) {
            options.rom = config.rom;
        } else {
            options.rom = DEFAULT_BEEBLINK_ROM;
        }
    }

    options.git = options.git || config.git === true;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function maybeSaveConfig(options: ICommandLineOptions): Promise<void> {
    if (options.save_config === null) {
        return;
    }

    const config: IConfigFile = {
        defaultVolume: options.default_volume !== null ? options.default_volume : undefined,
        folders: options.folders,
        rom: options.rom !== null ? options.rom : undefined,
        git: options.git !== null ? options.git : undefined,
    };

    await utils.fsMkdirAndWriteFile(options.save_config, JSON.stringify(config, undefined, '  '));
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function createServer(
    options: ICommandLineOptions,
    connectionId: number,
    defaultVolume: beebfs.BeebVolume | undefined,
    colours: Chalk,
    gaManipulator: gitattributes.Manipulator | undefined): Promise<Server> {

    const bfsLogPrefix = options.fs_verbose ? 'FS' + connectionId : undefined;
    const serverLogPrefix = options.server_verbose ? 'SRV' + connectionId : undefined;

    const bfs = new beebfs.BeebFS(bfsLogPrefix, options.folders, colours, gaManipulator);

    if (defaultVolume !== undefined) {
        await bfs.mount(defaultVolume);
    }

    const server = new Server(options.rom!, bfs, serverLogPrefix, colours, options.packet_verbose);
    return server;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class Connection {
    public static async create(
        options: ICommandLineOptions,
        defaultVolume: beebfs.BeebVolume | undefined,
        connectionId: number,
        usbSerial: string,
        colours: Chalk,
        gaManipulator: gitattributes.Manipulator | undefined): Promise<Connection> {

        const server = await createServer(options, connectionId, defaultVolume, colours, gaManipulator);

        return new Connection(usbSerial, connectionId, server, options.avr_verbose, options.usb_verbose, colours);
    }

    public readonly usbSerial: string;
    public readonly connectionId: number;
    private usbDevice: usb.Device | undefined;
    private usbInEndpoint: usb.InEndpoint | undefined;
    private usbOutEndpoint: usb.OutEndpoint | undefined;
    private server: Server;
    private log: utils.Log;
    private avrVerbose: boolean;

    private constructor(usbSerial: string, connectionId: number, server: Server, avrVerbose: boolean, verbose: boolean, colours: Chalk) {
        this.usbSerial = usbSerial;
        this.connectionId = connectionId;

        this.server = server;

        this.avrVerbose = avrVerbose;
        this.log = new utils.Log('USBCONN', process.stdout, verbose);
        this.log.colours = colours;
    }

    public async run(): Promise<void> {
        let done = false;
        let stalled = false;
        let hello = false;

        while (!done) {
            try {
                await this.findDevice();

                if (stalled) {
                    this.log.pn('Clearing any in endpoint stall condition...');

                    await deviceControlTransfer(this.usbDevice!,
                        usb.LIBUSB_REQUEST_TYPE_STANDARD | usb.LIBUSB_RECIPIENT_ENDPOINT,//bmRequestType - 00000010
                        usb.LIBUSB_REQUEST_CLEAR_FEATURE,//bRequest
                        0,//wValue - ENDPOINT_HALT
                        this.usbInEndpoint!.descriptor.bEndpointAddress,//wIndex
                        undefined);

                    this.log.pn('Clearing any out endpoint stall condition...');

                    await deviceControlTransfer(this.usbDevice!,
                        usb.LIBUSB_REQUEST_TYPE_STANDARD | usb.LIBUSB_RECIPIENT_ENDPOINT,//bmRequestType - 00000010
                        usb.LIBUSB_REQUEST_CLEAR_FEATURE,//bRequest
                        0,//wValue - ENDPOINT_HALT
                        this.usbOutEndpoint!.descriptor.bEndpointAddress,//wIndex
                        undefined);

                    this.log.pn('Stall condition cleared.');
                    stalled = false;
                }

                const reader = new InEndpointReader(this.usbInEndpoint!);

                if (!hello) {
                    process.stdout.write('Server running...\n');
                    hello = true;
                }

                //log.pn('Waiting for header...');
                const t = await reader.readUInt8();

                let payload: Buffer;
                if ((t & 0x80) === 0) {
                    payload = Buffer.alloc(1);
                    payload[0] = await reader.readUInt8();
                } else {
                    if (t === 0xff) {
                        process.stderr.write('WARNING: BBC and server have gone out of sync. This is almost always due to a bug in the BLFS ROM...\n');
                        process.stderr.write('CTRL+BREAK the BBC, reset the AVR, restart the server, then CTRL+BREAK the BBC again.');

                        throw new Error('out of sync');

                        // Probably better: do an AVR soft reset, go back to
                        // waiting, wait for BBC to be reset.

                        //process.exit(1);
                    }

                    const payloadSize = await reader.readUInt32LE();
                    payload = await reader.readBytes(payloadSize);
                }

                //const r = t & 0x7f;

                //const writer = new OutEndpointWriter(beebLink.outEndpoint);

                const response = await this.server.handleRequest(t & 0x7f, payload);

                let data: Buffer;
                if (response.data.length === 1) {
                    data = Buffer.alloc(2);

                    data[0] = response.c;
                    data[1] = response.data[0];
                } else {
                    data = Buffer.alloc(1 + 4 + response.data.length);
                    let i = 0;

                    data[i++] = response.c | 0x80;

                    data.writeUInt32LE(response.data.length, i);
                    i += 4;

                    for (const byte of response.data) {
                        data[i++] = byte;
                    }
                }

                await new Promise((resolve, reject) => {
                    this.usbOutEndpoint!.transfer(data, (error) => error !== undefined ? reject(error) : resolve());
                });

                // if (!writer.wasEverWritten()) {
                //     throw new Error('Server didn\'t handle request: 0x' + utils.hex2(t & 0x7f));
                // }

                // await writer.flush();

                //log.pn('All done (probably)');
            } catch (anyError) {
                const error = anyError as Error;
                if (error.message === 'LIBUSB_TRANSFER_STALL') {
                    this.log.pn('endpoint stalled');
                    stalled = true;
                } else if (error.message === 'LIBUSB_ERROR_PIPE') {
                    gError.pn('device went away - will try to find it again...');
                    this.usbDevice = undefined;

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

    private async findDevice(): Promise<void> {
        if (this.usbDevice !== undefined && this.usbInEndpoint !== undefined && this.usbOutEndpoint !== undefined) {
            // probably OK...
            return;
        }

        let numAttempts = 0;

        this.log.pn('Waiting for device with serial: ' + this.usbSerial);

        // freaky loop.
        for (; ;) {
            if (numAttempts++ > 0) {
                await delayMS(DEVICE_RETRY_DELAY_MS);
            }

            if (this.usbDevice !== undefined) {
                try {
                    this.usbDevice.close();
                    this.usbDevice = undefined;
                } catch (error) {
                    // With a bit of luck, this is just the "Can't close device
                    // with a pending request" error, and the request will
                    // eventually go away...
                    this.log.pn('Failed to close device: ' + error);
                    continue;
                }
            }

            this.usbInEndpoint = undefined;
            this.usbOutEndpoint = undefined;

            this.usbDevice = undefined;
            for (const device of await findBeebLinkUSBDevices()) {
                if (device.usbSerial === this.usbSerial) {
                    this.usbDevice = device.usbDevice;
                    break;
                }
            }

            if (this.usbDevice === undefined) {
                continue;
            }

            try {
                this.usbDevice.open(false);
            } catch (error) {
                this.log.pn('Failed to open device: ' + error);
                continue;
            }

            this.log.pn('Setting configuration...');
            // ! is to silence a spurious (?) 'may be undefined' warning
            await new Promise((resolve, reject) => this.usbDevice!.setConfiguration(1, (error) => error !== undefined ? reject(error) : resolve()));

            this.log.pn('Claiming interface...');

            let interf;
            try {
                interf = this.usbDevice.interface(0);
                interf.claim();
            } catch (error) {
                this.log.pn('Failed to claim interface: ' + error);
                continue;
            }

            this.log.pn('Finding endpoints...');
            this.usbInEndpoint = this.findSingleEndpoint(interf, 'in') as usb.InEndpoint;
            this.usbOutEndpoint = this.findSingleEndpoint(interf, 'out') as usb.OutEndpoint;
            if (this.usbInEndpoint === undefined || this.usbOutEndpoint === undefined) {
                this.log.pn('Failed to find 1 input endpoint and 1 output endpoint');
                continue;
            }

            this.log.pn('Checking protocol version...');
            try {
                const buffer = await deviceControlTransfer(this.usbDevice,
                    usb.LIBUSB_REQUEST_TYPE_CLASS | usb.LIBUSB_RECIPIENT_DEVICE | usb.LIBUSB_ENDPOINT_IN,
                    beeblink.CR_GET_PROTOCOL_VERSION,
                    0,
                    0,
                    1);

                this.log.pn('AVR version: ' + buffer![0]);
                if (buffer![0] !== beeblink.AVR_PROTOCOL_VERSION) {
                    this.log.pn('Wrong protocol version: ' + utils.hex2(buffer![0]) + ' (want: ' + utils.hex2(beeblink.AVR_PROTOCOL_VERSION));
                    continue;
                }
            } catch (error) {
                this.log.pn('Failed to get protocol version: ' + error);
                continue;
            }

            this.log.pn('Setting AVR verbose: ' + (this.avrVerbose ? 'yes' : 'no'));

            try {
                await deviceControlTransfer(this.usbDevice,
                    usb.LIBUSB_REQUEST_TYPE_CLASS | usb.LIBUSB_RECIPIENT_DEVICE | usb.LIBUSB_ENDPOINT_OUT,
                    beeblink.CR_SET_VERBOSE,
                    this.avrVerbose ? 1 : 0,
                    0,
                    undefined);
            } catch (error) {
                this.log.pn('Failed to set AVR verbose: ' + error);
                continue;
            }

            break;
        }
    }

    private findSingleEndpoint(interf: usb.Interface, direction: string): usb.Endpoint | undefined {
        const endpoints = interf.endpoints.filter((endpoint) => endpoint.direction === direction);
        if (endpoints.length !== 1) {
            return undefined;
        }

        return endpoints[0];
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function setDeviceSerialNumber(serial: number): Promise<void> {
    // This is a 16-bit number, i.e., 4 hex digits. This is entirely because
    // LUFA makes it a bit of a faff to have variable-length strings... the USB
    // serial number is just a string, and you can put anything in it.
    if (serial < 0 || serial >= 65536) {
        throw new Error('serial number must be between 0 and 65535 inclusive');
    }

    const devices = await findBeebLinkUSBDevices();

    if (devices.length === 0) {
        throw new Error('no BeebLink devices found');
    } else if (devices.length > 1) {
        throw new Error('multiple BeebLink devices found - serial number can only be set when a single device is plugged in');
    }

    const usbDevice = devices[0].usbDevice;

    usbDevice.open(false);

    await new Promise((resolve, reject) => usbDevice.setConfiguration(1, (error) => error !== undefined ? reject(error) : resolve()));

    usbDevice.interface(0).claim();

    await deviceControlTransfer(usbDevice,
        usb.LIBUSB_REQUEST_TYPE_CLASS | usb.LIBUSB_RECIPIENT_DEVICE | usb.LIBUSB_ENDPOINT_OUT,
        beeblink.CR_SET_SERIAL,
        serial,
        0,
        undefined);

    process.stderr.write('Serial number set. Please remove and reinsert the device.');
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function isGit(folderPath: string): Promise<boolean> {
    for (; ;) {
        const gitPath = path.join(folderPath, '.git');

        const stat = await utils.tryStat(gitPath);
        if (stat !== undefined) {
            if (stat.isDirectory()) {
                return true;
            }
        }

        const newFolderPath = path.normalize(path.join(folderPath, '..'));

        // > path.posix.normalize('/..')
        // '/'
        // > path.win32.normalize('C:\\..')
        // 'C:\\'

        if (newFolderPath === folderPath) {
            break;
        }

        folderPath = newFolderPath;
    }

    return false;
}

async function main(options: ICommandLineOptions) {
    const log = new utils.Log('', process.stderr, options.verbose);
    //gSendLog.enabled = options.send_verbose;

    if (options.set_serial !== null) {
        await setDeviceSerialNumber(options.set_serial);
        return;
    }

    log.pn('libusb_debug_level: ``' + options.libusb_debug_level + '\'\'');
    if (options.libusb_debug_level !== null) {
        usb.setDebugLevel(options.libusb_debug_level);
    }

    log.pn('cwd: ``' + process.cwd() + '\'\'');

    if (options.load_config === null) {
        await loadConfig(options, DEFAULT_CONFIG_FILE_NAME, false);
    } else {
        await loadConfig(options, options.load_config, true);
    }

    //log.pn('load_config: ``' + options.load_config + '\'\'');
    log.pn('save_config: ``' + options.save_config + '\'\'');

    if (Number.isNaN(options.device[0]) || Number.isNaN(options.device[1])) {
        throw new Error('invalid USB VID/PID specified');
    }

    gBeebLinkDeviceVID = options.device[0];
    gBeebLinkDevicePID = options.device[1];
    log.pn('BeebLink device VID: 0x' + utils.hex4(gBeebLinkDeviceVID));
    log.pn('BeebLink device PID: 0x' + utils.hex4(gBeebLinkDevicePID));

    if (options.folders.length === 0) {
        throw new Error('no folders specified');
    }

    if (options.folders.length > 1) {
        process.stderr.write('Note: new volumes will be created in: ' + options.folders[0] + '\n');
    }

    if (!await utils.fsExists(options.rom!)) {
        process.stderr.write('ROM image not found for *BLSELFUPDATE/bootstrap: ' + options.rom + '\n');
    }

    if (!options.http) {
        if ((await findBeebLinkUSBDevices()).length === 0) {
            throw new Error('no BeebLink devices found');
        }
    }

    let gaManipulator: gitattributes.Manipulator | undefined;

    const volumes = await beebfs.BeebFS.findAllVolumes(options.folders, log);

    if (options.git === true) {
        gaManipulator = new gitattributes.Manipulator(options.git_verbose);

        process.stderr.write('Checking for .gitattributes...\n');

        // Find all the paths first, then set the gitattributes manipulator
        // going once they've all been collected, in the interests of doing one
        // thing at a time. (Noticeably faster startup on OS X with lots of
        // volumes, even on an SSD.)

        const allDrives: beebfs.BeebDrive[] = [];
        let numFolders = 0;
        for (const volume of volumes) {
            const drives = await beebfs.BeebFS.findDrivesForVolume(volume);
            for (const drive of drives) {
                ++numFolders;
                if (await isGit(path.join(drive.volume.path, drive.name))) {
                    allDrives.push(drive);
                }
            }
        }
        process.stderr.write('Found ' + allDrives.length + '/' + numFolders + ' git drive(s) in ' + volumes.length + ' volume(s)\n');

        for (const drive of allDrives) {
            const drivePath = path.join(drive.volume.path, drive.name);

            gaManipulator.makeFolderNotText(drivePath);
            gaManipulator.scanForBASIC(drive);
        }

        gaManipulator.whenQuiescent(() => {
            process.stderr.write('Finished scanning for BASIC files.\n');
        });
    }

    let defaultVolume: beebfs.BeebVolume | undefined;
    if (options.default_volume !== null) {
        for (const volume of volumes) {
            if (volume.name === options.default_volume) {
                defaultVolume = volume;
                break;
            }
        }

        if (defaultVolume === undefined) {
            process.stderr.write('Default volume not found: ' + options.default_volume);
        }
    }

    // 
    const logPalette = [
        chalk.red,
        chalk.blue,
        chalk.yellow,
        chalk.green,
        chalk.black,
    ];

    // The USB connections and the HTTP connections just don't work in anything
    // like the same ways, so there's been no attempt at all made to unify them.
    let connectionId = 1;
    const usbConnections: Connection[] = [];
    const serverBySenderId = new Map<string, Server>();

    let httpServer: http.Server | undefined;
    if (options.http) {
        httpServer = http.createServer(async (request, response): Promise<void> => {
            async function endResponse(): Promise<void> {
                await new Promise((resolve, reject) => {
                    response.end(() => resolve());
                });
            }

            async function writeData(data: Buffer): Promise<void> {
                await new Promise<void>((resolve, reject) => {
                    response.write(data, 'binary', (error) => error === undefined ? resolve() : reject(error));
                });
            }

            async function errorResponse(statusCode: number, message: string | undefined): Promise<void> {
                response.statusCode = statusCode;
                response.setHeader('Content-Type', 'text/plain');
                response.setHeader('Content-Encoding', 'utf-8');
                if (message !== undefined && message.length > 0) {
                    await writeData(Buffer.from(message, 'utf-8'));
                }
                await endResponse();
            }

            if (request.url === '/request') {
                //process.stderr.write('method: ' + request.method + '\n');
                if (request.method !== 'POST') {
                    return await errorResponse(405, 'only POST is permitted');
                }

                // const packetTypeString = request.headers[BEEBLINK_PACKET_TYPE];
                // if (packetTypeString === undefined || packetTypeString === null || typeof (packetTypeString) !== 'string' || packetTypeString.length === 0) {
                //     return errorResponse(response, 400, 'missing header: ' + BEEBLINK_PACKET_TYPE);
                // }

                // const packetType = Number(packetTypeString);
                // if (!isFinite(packetType)) {
                //     return errorResponse(response, 400, 'invalid ' + BEEBLINK_PACKET_TYPE + ': ' + packetTypeString);
                // }

                const senderId = request.headers[BEEBLINK_SENDER_ID];
                if (senderId === undefined || senderId === null || senderId.length === 0 || typeof (senderId) !== 'string') {
                    return await errorResponse(400, 'missing header: ' + BEEBLINK_SENDER_ID);
                }

                const body = await new Promise<Buffer>((resolve, reject) => {
                    const bodyChunks: Buffer[] = [];
                    request.on('data', (chunk: Buffer) => {
                        bodyChunks.push(chunk);
                    }).on('end', () => {
                        resolve(Buffer.concat(bodyChunks));
                    }).on('error', (error: Error) => {
                        reject(error);
                    });
                });

                if (body.length === 0) {
                    return await errorResponse(400, 'missing body: ' + BEEBLINK_SENDER_ID);
                }

                // Find the Server for this sender id.
                let server = serverBySenderId.get(senderId);
                if (server === undefined) {
                    const colours = logPalette[(connectionId - 1) % logPalette.length];//-1 as IDs are 1-based
                    server = await createServer(options, connectionId++, defaultVolume, colours, gaManipulator);
                    serverBySenderId.set(senderId, server);
                }

                const packet = await server.handleRequest(body[0] & 0x7f, body.slice(1));

                response.setHeader('Content-Type', 'application/binary');

                await writeData(Buffer.alloc(1, packet.c));

                if (packet.data.length > 0) {
                    await writeData(packet.data);
                }

                await endResponse();
            } else if (request.url === '/beeblink.rom') {
                if (request.method !== 'GET') {
                    return await errorResponse(405, 'only GET is permitted');
                }

                if (options.rom === null) {
                    return await errorResponse(404, undefined);
                }

                const rom = await utils.tryReadFile(options.rom);
                if (rom === undefined) {
                    return await errorResponse(501, undefined);
                }

                response.setHeader('Content-Type', 'application/binary');

                await writeData(rom);

                await endResponse();
            } else {
                return await errorResponse(404, undefined);
            }
        });

        let listenHost: string | undefined = '127.0.0.1';
        if (options.http_all_interfaces) {
            listenHost = undefined;
        }

        httpServer.listen(HTTP_LISTEN_PORT, listenHost);
        process.stderr.write('HTTP server listening on ' + (listenHost === undefined ? 'all interfaces' : listenHost) + ', port ' + HTTP_LISTEN_PORT + '\n');
    }

    function removeConnection(usbConnection: Connection): void {
        for (let i = 0; i < usbConnections.length; ++i) {
            if (usbConnections[i] === usbConnection) {
                usbConnections.splice(i, 1);
                break;
            }
        }
    }

    // Keep polling for new devices, while watching for all existing connections
    // going away. This is not super clever, but there you go.
    do {
        const devices = await findBeebLinkUSBDevices();
        for (const device of devices) {
            if (usbConnections.find((usbConnection) => usbConnection.usbSerial === device.usbSerial) === undefined) {
                const colours = logPalette[(connectionId - 1) % logPalette.length];//-1 as IDs are 1-based
                const usbConnection = await Connection.create(options, defaultVolume, connectionId++, device.usbSerial, colours, gaManipulator);
                usbConnections.push(usbConnection);
                usbConnection.run().then(() => {
                    removeConnection(usbConnection);
                }).catch((error) => {
                    throw error;
                });
            }
        }

        await delayMS(1000);
    } while (options.http || usbConnections.length > 0);
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

// argparse calls parseInt with a radix of 10.
function integer(s: string): number {
    const x = parseInt(s, undefined);
    if (Number.isNaN(x)) {
        throw new Error('invalid number provided: "' + s + '"');
    }

    return x;
}

{
    const epi =
        'VOLUME-FOLDER and DEFAULT-VOLUME settings will be loaded from "' + DEFAULT_CONFIG_FILE_NAME + '" if present. ' +
        'Use --load-config to load from a different file. Use --save-config to save all options (both those loaded from file ' +
        'and those specified on the command line) to the given file.';

    const parser = new argparse.ArgumentParser({
        addHelp: true,
        description: 'BeebLink server',
        epilog: epi,
    });

    parser.addArgument(['-v', '--verbose'], { action: 'storeTrue', help: 'extra output' });
    parser.addArgument(['--device'], { nargs: 2, metavar: 'ID', type: usbVIDOrPID, defaultValue: [DEFAULT_USB_VID, DEFAULT_USB_PID], help: 'set USB device VID/PID. Default: 0x' + utils.hex4(DEFAULT_USB_VID) + ' 0x' + utils.hex4(DEFAULT_USB_PID) });
    parser.addArgument(['--rom'], { metavar: 'FILE', defaultValue: null, help: 'read BeebLink ROM from %(metavar)s. Default: ' + DEFAULT_BEEBLINK_ROM });
    parser.addArgument(['--fs-verbose'], { action: 'storeTrue', help: 'extra filing system-related output' });
    parser.addArgument(['--server-verbose'], { action: 'storeTrue', help: 'extra request/response output' });
    parser.addArgument(['--packet-verbose'], { action: 'storeTrue', help: 'dump incoming/outgoing request data' });
    parser.addArgument(['--usb-verbose'], { action: 'storeTrue', help: 'extra USB-related output' });
    parser.addArgument(['--libusb-debug-level'], { type: integer, metavar: 'LEVEL', help: 'if provided, set libusb debug logging level to %(metavar)s' });
    // don't use the argparse default mechanism here - this makes it easier to
    // later detect the absence of --default-volume.
    parser.addArgument(['--default-volume'], { metavar: 'DEFAULT-VOLUME', help: 'load volume %(metavar)s on startup' });
    parser.addArgument(['--no-retry-device'], { action: 'storeTrue', help: 'don\'t try to rediscover device if it goes away' });
    parser.addArgument(['--send-verbose'], { action: 'storeTrue', help: 'dump data sent to device' });
    parser.addArgument(['--fatal-verbose'], { action: 'storeTrue', help: 'print debugging info on a fatal error' });
    parser.addArgument(['--avr-verbose'], { action: 'storeTrue', help: 'enable AVR serial output' });
    parser.addArgument(['--load-config'], { metavar: 'FILE', help: 'load config from %(metavar)s' });
    parser.addArgument(['--save-config'], { metavar: 'FILE', nargs: '?', constant: DEFAULT_CONFIG_FILE_NAME, help: 'save config to %(metavar)s (%(constant)s if not specified)' });
    parser.addArgument(['--set-serial'], { metavar: 'SERIAL', type: integer, help: 'set device\'s USB serial number to %(metavar)s and exit' });
    parser.addArgument(['folders'], { nargs: '*', metavar: 'VOLUME-FOLDER', help: 'folder to search for volumes' });
    parser.addArgument(['--git'], { action: 'storeTrue', help: 'enable git-related functionality' });
    parser.addArgument(['--git-verbose'], { action: 'storeTrue', help: 'extra git-related output' });
    parser.addArgument(['--http'], { action: 'storeTrue', help: 'enable HTTP server' });
    parser.addArgument(['--http-all-interfaces'], { action: 'storeTrue', help: 'at own risk, make HTTP server listen on all interfaces, not just localhost' });
    //parser.addArgument(['--http-verbose'], { action: 'storeTrue', help: 'extra HTTP-related output' });

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
