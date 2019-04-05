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
import { Request } from './request';
import { Response } from './response';
import * as SerialPort from 'serialport';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// pain to do this properly with argparse.
const DEFAULT_USB_VID = 0x1209;
const DEFAULT_USB_PID = 0xbeeb;

const DEVICE_RETRY_DELAY_MS = 1000;

const DEFAULT_BEEBLINK_AVR_ROM = './beeblink_avr_fe60.rom';
const DEFAULT_BEEBLINK_SERIAL_ROM = './beeblink_tube_serial.rom';

const DEFAULT_CONFIG_FILE_NAME = "beeblink_config.json";

const HTTP_LISTEN_PORT = 48875;//0xbeeb;

const BEEBLINK_SENDER_ID = 'beeblink-sender-id';

const DEFAULT_SERIAL_BAUD_RATE = 115200;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IConfigFile {
    folders: string[] | undefined;
    defaultVolume: string | undefined;
    avr_rom: string | undefined;
    serial_rom: string | undefined;
    git: boolean | undefined;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface ICommandLineOptions {
    verbose: boolean;
    device: number[];
    avr_rom: string | null;
    serial_rom: string | null;
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
    serial_device: string[] | null;
    serial_verbose: boolean;
    list_serial_devices: boolean;
}

//const gLog = new utils.Log('', process.stderr);
const gError = new utils.Log('ERROR', process.stderr);
//const gSendLog = new utils.Log('SEND', process.stderr);


// don't shift to do this!
//
// > 255*16777216
// 4278190080
// > 255<<24
// -16777216
//
// :(
function UInt32(b0: number, b1: number, b2: number, b3: number): number {
    assert.ok(b0 >= 0 && b0 <= 255);
    assert.ok(b1 >= 0 && b1 <= 255);
    assert.ok(b2 >= 0 && b2 <= 255);
    assert.ok(b3 >= 0 && b3 <= 255);

    return b0 + b1 * 0x100 + b2 * 0x10000 + b3 * 0x1000000;
}

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

        return UInt32(b0, b1, b2, b3);
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

function isBeebLinkDevice(device: usb.Device): boolean {
    return device.deviceDescriptor.idVendor === gBeebLinkDeviceVID && device.deviceDescriptor.idProduct === gBeebLinkDevicePID;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function getDeviceDescription(device: usb.Device, serial?: string): string {
    let description = 'Bus ' + device.busNumber.toString().padStart(3, '0') + ' Device ' + device.deviceAddress.toString().padStart(3, '0');

    if (serial !== undefined) {
        description += ' Serial ' + serial;
    }

    return description;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function delayMS(ms: number) {
    await new Promise((resolve, reject) => setTimeout(() => resolve(), ms));
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

async function findBeebLinkUSBDevices(log: utils.Log | undefined): Promise<IBeebLinkDevice[]> {
    const usbDevices = usb.getDeviceList().filter((device) => {
        return device.deviceDescriptor.idVendor === gBeebLinkDeviceVID && device.deviceDescriptor.idProduct === gBeebLinkDevicePID;
    });

    const devices: IBeebLinkDevice[] = [];
    for (const usbDevice of usbDevices) {
        try {
            usbDevice.open(false);
        } catch (error) {
            if (log !== undefined) {
                log.pn(getDeviceDescription(usbDevice) + ': failed to open: ' + error);
            }
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
            if (log !== undefined) {
                log.pn(getDeviceDescription(usbDevice) + ': failed to get serial number: ' + error);
            }
            usbDevice.close();
        }

        // let open = true;
        // let numCloseAttempts = 0;
        // while (open) {
        //     try {
        //         ++numCloseAttempts;
        //         usbDevice.close();
        //         open = false;
        //     } catch (error) {
        //         if (log !== undefined) {
        //             log.pn(getDeviceDescription(usbDevice) + ': failed to close on attempt ' + numCloseAttempts + ' (will retry): ' + error);
        //         }

        //         // hopefully very transient...
        //         await delayMS(10);
        //     }
        // }
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

    function getROM(optionValue: string | null, configValue: string | undefined, defaultValue: string): string {
        if (optionValue !== null) {
            return optionValue;
        } else {
            if (configValue !== undefined) {
                return configValue;
            } else {
                return defaultValue;
            }
        }
    }

    options.avr_rom = getROM(options.avr_rom, config.avr_rom, DEFAULT_BEEBLINK_AVR_ROM);
    options.serial_rom = getROM(options.serial_rom, config.serial_rom, DEFAULT_BEEBLINK_SERIAL_ROM);

    options.git = options.git || config.git === true;
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

    const devices = await findBeebLinkUSBDevices(undefined);

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

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class BeebLinkDevice {
    public static async create(device: usb.Device, avrVerbose: boolean, log: utils.Log): Promise<BeebLinkDevice | undefined> {
        assert.ok(isBeebLinkDevice(device));

        let d = getDeviceDescription(device);

        try {
            device.open(false);
        } catch (error) {
            process.stderr.write(d + ': failed to open device: ' + error + '\n');
            return undefined;
        }

        async function closeDevice(error: Error | undefined, what: string): Promise<undefined> {
            process.stderr.write(d + ': ' + what);

            if (error !== undefined) {
                process.stderr.write(': ' + error);
            }

            process.stderr.write('\n');

            device.close();

            return undefined;
        }

        // The callback for usb.Device.getStringDescription returns a string, but
        // the typings have it as a buffer. Anyway, it seems to work as it is...
        let usbSerialBuffer: Buffer | undefined;
        try {
            usbSerialBuffer = await new Promise<Buffer | undefined>((resolve, reject) => {
                device.getStringDescriptor(device.deviceDescriptor.iSerialNumber, (error, buffer) => {
                    if (error !== undefined && error !== null) {
                        reject(error);
                    } else {
                        resolve(buffer);
                    }
                });
            });

            if (usbSerialBuffer === undefined) {
                throw new Error('usb.Device.getStringDescriptor returned nothing');
            }
        } catch (error) {
            return await closeDevice(error, 'failed to get serial number');
        }

        const usbSerial = usbSerialBuffer.toString('utf16le');

        d = getDeviceDescription(device, usbSerial);

        log.pn(d + ': setting configuration...');
        await new Promise((resolve, reject) => device.setConfiguration(1, (error) => error !== undefined ? reject(error) : resolve()));

        log.pn(d + ': claiming interface...');

        let interf;
        try {
            interf = device.interface(0);
            interf.claim();
        } catch (error) {
            return await closeDevice(error, 'failed to claim interface');
        }

        log.pn(d + ': finding endpoints...');
        const inEndpoint = findSingleEndpoint(interf, 'in') as usb.InEndpoint;
        const outEndpoint = findSingleEndpoint(interf, 'out') as usb.OutEndpoint;
        if (inEndpoint === undefined || outEndpoint === undefined) {
            return await closeDevice(undefined, 'failed to find 1 input endpoint and 1 output endpoint');
        }

        // log.pn(d + ': clearing endpoint stalls...');
        // await clearEndpointHalt(inEndpoint);
        // await clearEndpointHalt(outEndpoint);

        log.pn(d + ': checking protocol version...');
        try {
            const buffer = await deviceControlTransfer(device,
                usb.LIBUSB_REQUEST_TYPE_CLASS | usb.LIBUSB_RECIPIENT_DEVICE | usb.LIBUSB_ENDPOINT_IN,
                beeblink.CR_GET_PROTOCOL_VERSION,
                0,
                0,
                1);

            log.pn(d + ': AVR version: ' + buffer![0]);
            if (buffer![0] !== beeblink.AVR_PROTOCOL_VERSION) {
                return await closeDevice(undefined, ': wrong protocol version: ' + utils.hex2(buffer![0]) + ' (want: ' + utils.hex2(beeblink.AVR_PROTOCOL_VERSION));
            }
        } catch (error) {
            return await closeDevice(error, 'failed to get protocol version');
        }

        log.pn(d + ': setting AVR verbose: ' + (avrVerbose ? 'yes' : 'no'));

        try {
            await deviceControlTransfer(device,
                usb.LIBUSB_REQUEST_TYPE_CLASS | usb.LIBUSB_RECIPIENT_DEVICE | usb.LIBUSB_ENDPOINT_OUT,
                beeblink.CR_SET_VERBOSE,
                avrVerbose ? 1 : 0,
                0,
                undefined);
        } catch (error) {
            return await closeDevice(error, 'failed to set AVR verbose');
        }

        return new BeebLinkDevice(device, usbSerial, inEndpoint, outEndpoint, log.enabled);
    }

    public readonly usbDevice: usb.Device;
    public readonly usbSerial: string;
    public readonly usbInEndpoint: usb.InEndpoint;
    public readonly usbOutEndpoint: usb.OutEndpoint;
    public readonly description: string;
    public readonly log: utils.Log;

    private constructor(
        usbDevice: usb.Device,
        usbSerial: string,
        usbInEndpoint: usb.InEndpoint,
        usbOutEndpoint: usb.OutEndpoint,
        logEnabled: boolean) {
        this.usbDevice = usbDevice;
        this.usbSerial = usbSerial;
        this.usbInEndpoint = usbInEndpoint;
        this.usbOutEndpoint = usbOutEndpoint;

        this.description = getDeviceDescription(this.usbDevice, this.usbSerial);

        this.log = new utils.Log('USB: ' + this.description, process.stdout, logEnabled);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function handleStallError(blDevice: BeebLinkDevice, endpoint: usb.Endpoint): Promise<boolean> {
    assert.ok(endpoint === blDevice.usbInEndpoint || endpoint === blDevice.usbOutEndpoint);

    const dir = endpoint === blDevice.usbInEndpoint ? 'in' : 'out';

    blDevice.log.pn('device ' + dir + ' endpoint stalled - attempting to clear...');
    try {
        await new Promise((resolve, reject) => {
            (endpoint as any).clearHalt((error: any) => {
                if (error !== undefined && error !== null) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });

        process.stderr.write(blDevice.description + ': stall cleared.\n');

        // treat this as a reset.
        return true;
    } catch (error) {
        blDevice.log.pn('failed to clear stall: ' + error);

        // device is borked... have to close.
        return false;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function handleCommandLineOptions(options: ICommandLineOptions, log: utils.Log): Promise<boolean> {
    if (options.set_serial !== null) {
        await setDeviceSerialNumber(options.set_serial);
        return false;
    }

    if (options.list_serial_devices) {
        const portInfos = await SerialPort.list();
        process.stdout.write(portInfos.length + ' serial devices:\n');
        for (let i = 0; i < portInfos.length; ++i) {
            process.stdout.write('  ' + i + '. ' + portInfos[i].comName + '\n');
        }

        return false;
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

    if (!await utils.fsExists(options.avr_rom!)) {
        process.stderr.write('AVR ROM image not found for *BLSELFUPDATE/bootstrap: ' + options.avr_rom + '\n');
    }

    if (!await utils.fsExists(options.serial_rom!)) {
        process.stderr.write('Serial ROM image not found for *BLSELFUPDATE/bootstrap: ' + options.serial_rom + '\n');
    }

    if (options.save_config !== null) {
        const config: IConfigFile = {
            defaultVolume: options.default_volume !== null ? options.default_volume : undefined,
            folders: options.folders,
            avr_rom: options.avr_rom !== null ? options.avr_rom : undefined,
            serial_rom: options.serial_rom !== null ? options.serial_rom : undefined,
            git: options.git !== null ? options.git : undefined,
        };

        await utils.fsMkdirAndWriteFile(options.save_config, JSON.stringify(config, undefined, '  '));
    }

    if (!options.http) {
        if ((await findBeebLinkUSBDevices(undefined)).length === 0) {
            throw new Error('no BeebLink devices found');
        }
    }

    return true;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function createGitattributesManipulator(options: ICommandLineOptions, volumes: beebfs.BeebVolume[]): Promise<gitattributes.Manipulator | undefined> {
    if (!options.git) {
        return undefined;
    } else {
        const gaManipulator = new gitattributes.Manipulator(options.git_verbose);

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

        return gaManipulator;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function findDefaultVolume(options: ICommandLineOptions, volumes: beebfs.BeebVolume[]): beebfs.BeebVolume | undefined {
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

    return defaultVolume;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function handleHTTP(options: ICommandLineOptions, createServer: () => Promise<Server>): void {
    if (!options.http) {
        return;
    }

    const serverBySenderId = new Map<string, Server>();

    const httpServer = http.createServer(async (httpRequest, httpResponse): Promise<void> => {
        async function endResponse(): Promise<void> {
            await new Promise((resolve, reject) => {
                httpResponse.end(() => resolve());
            });
        }

        async function writeData(data: Buffer): Promise<void> {
            await new Promise<void>((resolve, reject) => {
                httpResponse.write(data, 'binary', (error) => error === undefined ? resolve() : reject(error));
            });
        }

        async function errorResponse(statusCode: number, message: string | undefined): Promise<void> {
            httpResponse.statusCode = statusCode;
            httpResponse.setHeader('Content-Type', 'text/plain');
            httpResponse.setHeader('Content-Encoding', 'utf-8');
            if (message !== undefined && message.length > 0) {
                await writeData(Buffer.from(message, 'utf-8'));
            }
            await endResponse();
        }

        if (httpRequest.url === '/request') {
            //process.stderr.write('method: ' + httpRequest.method + '\n');
            if (httpRequest.method !== 'POST') {
                return await errorResponse(405, 'only POST is permitted');
            }

            // const packetTypeString = httpRequest.headers[BEEBLINK_PACKET_TYPE];
            // if (packetTypeString === undefined || packetTypeString === null || typeof (packetTypeString) !== 'string' || packetTypeString.length === 0) {
            //     return errorResponse(httpResponse, 400, 'missing header: ' + BEEBLINK_PACKET_TYPE);
            // }

            // const packetType = Number(packetTypeString);
            // if (!isFinite(packetType)) {
            //     return errorResponse(httpResponse, 400, 'invalid ' + BEEBLINK_PACKET_TYPE + ': ' + packetTypeString);
            // }

            const senderId = httpRequest.headers[BEEBLINK_SENDER_ID];
            if (senderId === undefined || senderId === null || senderId.length === 0 || typeof (senderId) !== 'string') {
                return await errorResponse(400, 'missing header: ' + BEEBLINK_SENDER_ID);
            }

            const body = await new Promise<Buffer>((resolve, reject) => {
                const bodyChunks: Buffer[] = [];
                httpRequest.on('data', (chunk: Buffer) => {
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
                server = await createServer();
                serverBySenderId.set(senderId, server);
            }

            const response = await server.handleRequest(new Request(body[0] & 0x7f, body.slice(1)));

            httpResponse.setHeader('Content-Type', 'application/binary');

            await writeData(Buffer.alloc(1, response.c));

            if (response.p.length > 0) {
                await writeData(response.p);
            }

            await endResponse();
        } else if (httpRequest.url === '/beeblink.rom') {
            if (httpRequest.method !== 'GET') {
                return await errorResponse(405, 'only GET is permitted');
            }

            if (options.avr_rom === null) {
                return await errorResponse(404, undefined);
            }

            const rom = await utils.tryReadFile(options.avr_rom);
            if (rom === undefined) {
                return await errorResponse(501, undefined);
            }

            httpResponse.setHeader('Content-Type', 'application/binary');

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

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function handleUSB(options: ICommandLineOptions, createServer: () => Promise<Server>): Promise<void> {
    const usbLog = new utils.Log('USB', process.stdout, options.usb_verbose);

    const blUSBDevices: usb.Device[] = [];
    const serversByUSBSerial = new Map<string, Server>();

    async function handleDevice(usbDevice: usb.Device): Promise<void> {
        const blDevice = await BeebLinkDevice.create(usbDevice, options.avr_verbose, usbLog);
        if (blDevice === undefined) {
            return;
        }

        process.stderr.write(blDevice.description + ': serving.\n');

        for (; ;) {
            blDevice.log.pn('Waiting for request from BBC...');
            const reader = new InEndpointReader(blDevice.usbInEndpoint);

            // read incoming request.
            let request: Request;
            try {
                let c = await reader.readUInt8();
                blDevice.log.pn('Got request: V=' + ((c & 0x80) !== 0 ? '1' : '0') + ', C=' + utils.getRequestTypeName(c & 0x7f));

                let pSize: number;
                if ((c & 0x80) === 0) {
                    pSize = 1;
                } else {
                    c &= 0x7f;
                    pSize = await reader.readUInt32LE();
                }

                blDevice.log.pn('Waiting for payload of ' + pSize + ' byte(s)...');

                const p = Buffer.alloc(pSize);
                for (let i = 0; i < p.length; ++i) {
                    p[i] = await reader.readUInt8();
                }

                request = new Request(c, p);
            } catch (error) {
                process.stderr.write(blDevice.description + ': receive error: ' + error + '\n');
                if (error.message === 'LIBUSB_TRANSFER_STALL') {
                    if (await handleStallError(blDevice, blDevice.usbInEndpoint)) {
                        continue;
                    } else {
                        break;
                    }
                } else if (error.message === 'LIBUSB_ERROR_PIPE') {
                    blDevice.log.pn('device lost...');

                    // have to close.
                    break;
                } else {
                    // pass it on.
                    throw error;
                }
            }

            blDevice.log.pn('Got request: ' + request);

            // try to find the server. Make a new one, if none found.
            let server = serversByUSBSerial.get(blDevice.usbSerial);
            if (server === undefined) {
                server = await createServer();
                serversByUSBSerial.set(blDevice.usbSerial, server);
            }

            // field incoming request.
            const response = await server.handleRequest(request);

            blDevice.log.pn('Got response: ' + response);

            let responseData: Buffer;

            if (response.p.length === 1) {
                responseData = Buffer.alloc(2);

                responseData[0] = response.c & 0x7f;
                responseData[1] = response.p[0];
            } else {
                responseData = Buffer.alloc(1 + 4 + response.p.length);

                let i = 0;

                responseData[i++] = response.c | 0x80;

                responseData.writeUInt32LE(response.p.length, i);
                i += 4;

                for (const byte of response.p) {
                    responseData[i++] = byte;
                }
            }

            try {
                await new Promise((resolve, reject) => {
                    blDevice.usbOutEndpoint.transfer(responseData, (error) => {
                        if (error !== undefined && error !== null) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    });
                });
            } catch (error) {
                process.stderr.write(blDevice.description + ': send error: ' + error + '\n');
                if (error.message === 'LIBUSB_TRANSFER_STALL') {
                    if (await handleStallError(blDevice, blDevice.usbOutEndpoint)) {
                        continue;
                    } else {
                        break;
                    }
                } else if (error.message === 'LIBUSB_ERROR_PIPE') {
                    blDevice.log.pn('device lost...');

                    // have to close.
                    break;
                } else {
                    // pass it on.
                    throw error;
                }
            }
        }

        process.stderr.write(blDevice.description + ': closing device...\n');

        let closed = false;
        while (!closed) {
            try {
                blDevice.usbDevice.close();
                closed = true;
            } catch (error) {
                blDevice.log.pn('failed to close (but will retry): ' + error);
                await delayMS(1000);
            }
        }

        process.stderr.write(blDevice.description + ': device closed.\n');
    }

    usbLog.pn('initialisation done.');

    for (; ;) {
        // Add new devices as they appear.
        //
        // Any devices that become invalid will (hopefully...) be caught by
        // exceptions in the handleDevice function.
        const newBLUSBDevices: usb.Device[] = [];

        for (const usbDevice of usb.getDeviceList()) {
            if (isBeebLinkDevice(usbDevice)) {
                let found = false;

                for (const blUSBDevice of blUSBDevices) {
                    if (blUSBDevice.busNumber === usbDevice.busNumber && blUSBDevice.deviceAddress === usbDevice.deviceAddress) {
                        found = true;
                        break;
                    }
                }

                if (!found) {
                    newBLUSBDevices.push(usbDevice);
                }
            }
        }

        for (const newBLUSBDevice of newBLUSBDevices) {
            // indicate that this one is being handled.
            blUSBDevices.push(newBLUSBDevice);

            handleDevice(newBLUSBDevice).then(() => {
                // indicate this one is no longer being handled.
                const blUSBDeviceIdx = blUSBDevices.indexOf(newBLUSBDevice);
                assert.ok(blUSBDeviceIdx !== -1);
                blUSBDevices.splice(blUSBDeviceIdx, 1);
            }).catch((error) => {
                throw error;
            });
        }

        await delayMS(1000);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface ISerialDevice {
    deviceName: string;
    baud: number;
}

function getSerialDevices(options: ICommandLineOptions): ISerialDevice[] {
    const serialDevices: ISerialDevice[] = [];

    if (options.serial_device !== null) {
        for (const serialDeviceString of options.serial_device) {
            const parts = serialDeviceString.split(':');

            let serialDevice: ISerialDevice;
            if (parts.length === 1) {
                serialDevice = { deviceName: parts[0], baud: DEFAULT_SERIAL_BAUD_RATE };
            } else if (parts.length === 2) {
                const baud = parseInt(parts[1], undefined);
                if (Number.isNaN(baud)) {
                    throw new Error('invalid baud rate: ' + parts[1]);
                }

                serialDevice = { deviceName: parts[0], baud };
            } else {
                throw new Error('invalid serial device syntax: ' + serialDeviceString);
            }

            serialDevices.push(serialDevice);
        }
    }

    return serialDevices;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// class SerialRequestBuilder {
//     private c: number;
//     private p: Buffer | undefined;
//     private negativeOffset: number;

//     public constructor() {
//     this.c = 0;
//     this.negativeOffset = 0;
//     this.p = undefined;
// }

//     // Returns Request if completed request received, true for more data, or false if cancelled.
//     public addByte(x: number): Request | boolean {

// }
// }

// class SerialReader {
//     private port: SerialPort;
//     private buffers: Buffer[];
//     private bufferPos: number;//always points into this.buffers[0]

//     public constructor(port: SerialPort) {
//         this.port = port;
//         this.buffers = [];
//         this.bufferPos = 0;
//     }

//     public async readUInt8(): Promise<number> {
//         if (this.buffers.length === 0) {

//         }
//     }
// }

interface IReadWaiter {
    resolve: (() => void) | undefined;
    reject: ((error: any) => void) | undefined;
}

async function handleSerialDevice(serialDevice: ISerialDevice, createServer: () => Promise<Server>, serialLog: utils.Log): Promise<void> {
    serialLog.pn('Creating server...');
    const server = await createServer();

    serialLog.pn('Initialising serial device ``' + serialDevice.deviceName + '\'\', ' + serialDevice.baud + ' baud');

    const port: SerialPort = new SerialPort(serialDevice.deviceName, { baudRate: serialDevice.baud, autoOpen: false });

    await new Promise<void>((resolve, reject) => {
        port.open((error) => {
            if (error !== undefined && error !== null) {
                reject(error);
            } else {
                resolve();
            }
        });
    });

    let readWaiter: IReadWaiter | undefined;
    const readBuffers: Buffer[] = [];
    let readIndex: 0;

    port.on('data', (data: Buffer): void => {
        readBuffers.push(data);
        if (readWaiter !== undefined) {
            const waiter = readWaiter;
            readWaiter = undefined;

            if (waiter.resolve !== undefined) {
                waiter.resolve();
            }
        }
    });

    port.on('error', (error: any): void => {
        if (readWaiter !== undefined) {
            const waiter = readWaiter;
            readWaiter = undefined;

            if (waiter.reject !== undefined) {
                waiter.reject(error);
            }
        }
    });

    async function readByte(): Promise<number> {
        if (readBuffers.length === 0) {
            await new Promise<void>((resolve, reject): void => {
                readWaiter = { resolve, reject };
            });
        }

        const byte = readBuffers[0][readIndex++];

        if (readIndex === readBuffers[0].length) {
            readBuffers.splice(0, 1);
            readIndex = 0;
        }

        return byte;
    }

    async function readConfirmationByte(): Promise<boolean> {
        const byte = await readByte();
        return byte !== 0;
    }

    const numSyncZerosRequired = 500;

    let synced = false;
    for (; ;) {
        // Sync loop.
        port.removeAllListeners('drain');

        // Sync steps 1 and 2 are carefully delineated in the notes, because
        // it's relevant for the 6502. But for the server, because of all the
        // buffering, the distinction isn't so important. Just write a pile of
        // 0s, then a 1, and let it get sent at its own pace. Then just keep
        // reading until it's clear the BBC is ready too.

        const syncData = Buffer.alloc(numSyncZerosRequired + 1);
        syncData[numSyncZerosRequired] = 1;

        sync_loop:
        do {
            serialLog.pn(`Starting sync...`);

            await new Promise((resolve, reject): void => {
                function writeSyncZeros(): boolean {
                    // Despite what the TypeScript definitions appear to say,
                    // the JS code actually only seems to call the callback with
                    // a single argument: an error, or undefined.
                    return port.write(syncData, (error: any): void => {
                        if (error !== undefined && error !== null) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    });
                }

                if (!writeSyncZeros()) {
                    port.once('drain', writeSyncZeros);
                }
            });

            let numZeros = 0;
            while (numZeros < numSyncZerosRequired) {
                const x = await readByte();
                if (x !== 0) {
                    numZeros = 0;
                } else {
                    ++numZeros;
                }
            }

            serialLog.pn(`Received ${numZeros} 0 bytes.`);

            // eat remaining sync 0s.
            {
                let x;
                do {
                    x = await readByte();
                } while (x === 0);

                if (x === 1) {
                    synced = true;
                } else {
                    serialLog.pn(`No sync - bad sync value: ${x} (0x${utils.hex2(x)})`);
                }
            }
        } while (!synced);

        // Response/request loop.
        response_request_loop:
        for (; ;) {
            const c = await readByte();

            if (c === 0) {
                // Special syntax.
                continue;
            }

            let p: Buffer;
            if ((c & 0x80) === 0) {
                // 1-byte payload.
                p = Buffer.alloc(1);
                p[0] = await readByte();
            } else {
                // Variable-size payload.
                const b0 = await readByte();
                const b1 = await readByte();
                const b2 = await readByte();
                const b3 = await readByte();
                const size = UInt32(b0, b1, b2, b3);

                p = Buffer.alloc(size + (size >> 8) + 1);

                for (let i = 0; i < size; ++i) {
                    if (((size - i) & 0xff) === 0) {
                        if (!await readConfirmationByte()) {
                            break response_request_loop;
                        }
                    }

                    p[i] = await readByte();
                }
            }

            if (!await readConfirmationByte()) {
                break response_request_loop;
            }

            const request = new Request(c & 0x7f, p);

            const response = await server.handleRequest(request);

            let responseData: Buffer;

            if (response.p.length === 1) {
                responseData = Buffer.alloc(3);

                responseData[0] = response.c & 0x7f;
                responseData[1] = response.p[1];
                responseData[2] = 1;//confirmation byte
            } else {
                responseData = Buffer.alloc(1 + 4 + p.length + (p.length >> 8) + 1);

                let destIdx = 0;

                responseData[destIdx++] = response.c | 0x80;

                responseData.writeUInt32LE(p.length, destIdx);
                destIdx += 4;

                for (let srcIdx = 0; srcIdx < p.length; ++srcIdx) {
                    if (((p.length - srcIdx) & 0xff) === 0) {
                        responseData[destIdx++] = 1;//confirmation byte
                    }

                    responseData[destIdx++] = p[srcIdx];
                }

                responseData[destIdx++] = 1;//confirmation byte

                assert.strictEqual(destIdx, responseData.length);
            }

            {
                const maxChunkSize = 512;//arbitrary.
                let srcIdx = 0;
                while (srcIdx < responseData.length) {
                    const chunk = responseData.slice(srcIdx, srcIdx + maxChunkSize);

                    let resolveResult: ((result: boolean) => void) | undefined;

                    function callResolveResult(result: boolean): void {
                        if (resolveResult !== undefined) {
                            const r = resolveResult;
                            resolveResult = undefined;

                            r(result);
                        }
                    }

                    readWaiter = {
                        reject: undefined,
                        resolve: (): void => {
                            callResolveResult(false);
                        },
                    };

                    const ok = await new Promise<boolean>((resolve, reject) => {
                        resolveResult = resolve;

                        function write(): boolean {
                            return port.write(chunk, (error: any): void => {
                                if (error !== null && error !== undefined) {
                                    reject(error);
                                } else {
                                    callResolveResult(true);
                                }
                            });
                        }

                        if (!write()) {
                            port.once('drain', write);
                        }
                    });

                    if (!ok) {
                        break response_request_loop;
                    }

                    srcIdx += maxChunkSize;
                }
            }
        }
    }
}

async function handleSerial(options: ICommandLineOptions, serialDevices: ISerialDevice[], createServer: () => Promise<Server>): Promise<void> {
    if (serialDevices.length === 0) {
        return;
    }

    const serialLog = new utils.Log('SERIAL', process.stdout, options.serial_verbose);

    for (const serialDevice of serialDevices) {
        void handleSerialDevice(serialDevice, createServer, serialLog);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function main(options: ICommandLineOptions) {
    const log = new utils.Log('', process.stderr, options.verbose);
    //gSendLog.enabled = options.send_verbose;

    if (!await handleCommandLineOptions(options, log)) {
        return;
    }

    const volumes = await beebfs.BeebFS.findAllVolumes(options.folders, log);

    const gaManipulator = await createGitattributesManipulator(options, volumes);

    const defaultVolume = findDefaultVolume(options, volumes);

    const serialDevices = getSerialDevices(options);

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
    let nextConnectionId = 1;

    async function createServer(): Promise<Server> {
        const connectionId = nextConnectionId++;
        const colours = logPalette[(connectionId - 1) % logPalette.length];//-1 as IDs are 1-based

        const bfsLogPrefix = options.fs_verbose ? 'FS' + connectionId : undefined;
        const serverLogPrefix = options.server_verbose ? 'SRV' + connectionId : undefined;

        const bfs = new beebfs.BeebFS(bfsLogPrefix, options.folders, colours, gaManipulator);

        if (defaultVolume !== undefined) {
            await bfs.mount(defaultVolume);
        }

        const server = new Server(options.avr_rom, bfs, serverLogPrefix, colours, options.packet_verbose);
        return server;
    }

    handleHTTP(options, createServer);

    void handleUSB(options, createServer);

    void handleSerial(options, serialDevices, createServer);
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
    parser.addArgument(['--avr-rom'], { metavar: 'FILE', defaultValue: null, help: 'read BeebLink AVR ROM from %(metavar)s. Default: ' + DEFAULT_BEEBLINK_AVR_ROM });
    parser.addArgument(['--serial-rom'], { metavar: 'FILE:', defaultValue: null, help: 'read BeebLink serial ROM from %(metavar)s. Default: ' + DEFAULT_BEEBLINK_SERIAL_ROM });
    parser.addArgument(['--fs-verbose'], { action: 'storeTrue', help: 'extra filing system-related output' });
    parser.addArgument(['--server-verbose'], { action: 'storeTrue', help: 'extra request/response output' });
    parser.addArgument(['--packet-verbose'], { action: 'storeTrue', help: 'dump incoming/outgoing request data (requires --server-verbose)' });
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
    parser.addArgument(['--serial-device'], { action: 'append', metavar: 'DEVICE(:BAUD)', help: 'listen on serial port DEVICE (optionally, with baud rate BAUD - default is ' + DEFAULT_SERIAL_BAUD_RATE + ')' });
    parser.addArgument(['--serial-verbose'], { action: 'storeTrue', help: 'extra serial-related output' });
    parser.addArgument(['--list-serial-devices'], { action: 'storeTrue', help: 'list available serial devices, then exit' });
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
