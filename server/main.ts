//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
// Copyright (C) 2018, 2019, 2020 Tom Seddon
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
import chalk from 'chalk';
import * as gitattributes from './gitattributes';
import * as http from 'http';
import Request from './Request';
import * as SerialPort from 'serialport';
import * as os from 'os';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function getIOCTL(): ((fd: number, request: number, data?: Buffer | number) => void) | undefined {
    if (process.platform === 'linux') {
        // work around lack of type definitions.
        return require('ioctl');
    } else {
        return undefined;
    }
}

const ioctl = getIOCTL();

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

const DEVICE_RETRY_DELAY_MS = 1000;

const DEFAULT_BEEBLINK_AVR_ROM = './beeblink_avr_fe60.rom';
const DEFAULT_BEEBLINK_TUBE_SERIAL_ROM = './beeblink_tube_serial.rom';
const DEFAULT_BEEBLINK_UPURS_ROM = './beeblink_upurs_fe60.rom';

const DEFAULT_CONFIG_FILE_NAME = "beeblink_config.json";

const HTTP_LISTEN_PORT = 48875;//0xbeeb;

const BEEBLINK_SENDER_ID = 'beeblink-sender-id';

interface IUSBSerialDevice {
    description: string;
    vid: number;
    pid: number;
}

function isSerialPortUSBDevice(portInfo: SerialPort.PortInfo, usbDevice: IUSBSerialDevice): boolean {
    if (portInfo.vendorId !== undefined && utils.strieq(portInfo.vendorId, utils.hex4(usbDevice.vid))) {
        if (portInfo.productId !== undefined && utils.strieq(portInfo.productId, utils.hex4(usbDevice.pid))) {
            return true;
        }
    }

    return false;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// FTDI devices that I've tested it with.
const TUBE_SERIAL_DEVICE: IUSBSerialDevice = { description: 'Tube Serial', vid: 0x0403, pid: 0x6014 };
const FTDI_USB_SERIAL_DEVICE: IUSBSerialDevice = { description: 'FTDI USB Serial', vid: 0x0403, pid: 0x6001 };

const SUPPORTED_USB_SERIAL_DEVICES: IUSBSerialDevice[] = [
    TUBE_SERIAL_DEVICE,
    FTDI_USB_SERIAL_DEVICE,

    // No good - though, annoyingly, it does work fine with Hercules and the
    // standard UPURS tools. So clearly there's something screwy.

    //{ description: 'CH34x USB Serial', vid: 0x1a86, pid: 0x7523 },
];

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IConfigFile {
    folders: string[] | undefined;
    pc_folders: string[] | undefined;
    tube_host_folders: string[] | undefined;
    default_volume: string | undefined;
    avr_rom: string | undefined;
    tube_serial_rom: string | undefined;
    upurs_rom: string | undefined;
    git: boolean | undefined;
    serial_include: string[] | undefined;
    serial_exclude: string[] | undefined;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface ICommandLineOptions {
    verbose: boolean;
    avr_rom: string | null;
    tube_serial_rom: string | null;
    upurs_rom: string | null;
    fs_verbose: boolean;
    server_verbose: boolean;
    default_volume: string | null;
    fatal_verbose: boolean;
    locate_verbose: boolean;
    folders: string[];
    load_config: string | null;
    save_config: string | null;
    git: boolean;
    git_verbose: boolean;
    http: boolean;
    server_data_verbose: boolean;
    http_all_interfaces: boolean;
    libusb_debug_level: number | null;
    serial_verbose: string[] | null;
    serial_sync_verbose: string[] | null;
    serial_data_verbose: string[] | null;
    list_serial_devices: boolean;
    serial_exclude: string[] | null;
    pcFolders: string[];
    tubeHostFolders: string[];
    serial_test_pc_to_bbc: boolean;
    serial_test_bbc_to_pc: boolean;
    serial_full_size_messages: boolean;
    serial_include: string[] | null;
    serial_test_send_file: string | null;
    excludeVolumeRegExps: string[];
}

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

async function delayMS(ms: number): Promise<void> {
    await new Promise<void>((resolve, reject) => setTimeout(() => resolve(), ms));
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

// async function getUSBDeviceStringDescriptor(device: usb.Device, iIdentifier: number): Promise<string | undefined> {
//     if (iIdentifier === 0) {
//         return undefined;
//     }

//     let value: string | undefined;
//     try {
//         value = await new Promise<string | undefined>((resolve, reject) => {
//             device.getStringDescriptor(iIdentifier, (error, buffer) => {
//                 //tslint:disable-next-line strict-type-predicates
//                 if (error !== undefined && error !== null) {
//                     reject(error);
//                 } else {
//                     resolve(buffer);
//                 }
//             });
//         });
//     } catch (error) {
//         return undefined;//`<<usb.Device.getStringDescriptor failed: ${error}>>`;
//     }

//     if (value === undefined) {
//         return undefined;//`<<usb.Device.getStringDescriptor retured nothing>>`;
//     }

//     return value;
// }

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function loadConfig(options: ICommandLineOptions, filePath: string, mustExist: boolean): Promise<void> {
    let data;
    try {
        data = await utils.fsReadFile(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            if (!mustExist) {
                return;
            }
        }

        throw error;
    }

    const str = data.toString('utf-8');
    const config = JSON.parse(str) as IConfigFile;

    if (options.default_volume === null) {
        if (config.default_volume !== undefined) {
            options.default_volume = config.default_volume;
        } else {
            // Handle inconsistent spelling that didn't get fixed for a while.
            if ((config as any).defaultVolume !== undefined) {
                options.default_volume = (config as any).defaultVolume;
            }
        }
    }

    function loadFolders(optionsFolders: string[], configFolders: string[] | undefined): void {
        // Keep config folders first.
        if (configFolders !== undefined) {
            for (let i = 0; i < configFolders.length; ++i) {
                optionsFolders.splice(i, 0, configFolders[i]);
            }
        }

        // Eliminate duplicates.
        {
            let i = 0;
            while (i < optionsFolders.length) {
                let j = i + 1;

                while (j < optionsFolders.length) {
                    if (path.relative(optionsFolders[i], optionsFolders[j]) === '') {
                        optionsFolders.splice(j, 1);
                    } else {
                        ++j;
                    }
                }

                ++i;
            }
        }
    }

    loadFolders(options.folders, config.folders);
    loadFolders(options.pcFolders, config.pc_folders);
    loadFolders(options.tubeHostFolders, config.tube_host_folders);

    options.git = options.git || config.git === true;

    if (config.serial_exclude !== undefined) {
        if (options.serial_exclude === null) {
            options.serial_exclude = [];
        }

        for (const e of config.serial_exclude) {
            options.serial_exclude.push(e);
        }
    }

    if (options.avr_rom === null) {
        if (config.avr_rom !== undefined) {
            options.avr_rom = config.avr_rom;
        }
    }

    if (options.tube_serial_rom === null) {
        if (config.tube_serial_rom !== undefined) {
            options.tube_serial_rom = config.tube_serial_rom;
        }
    }

    if (options.upurs_rom === null) {
        if (config.upurs_rom !== undefined) {
            options.upurs_rom = config.upurs_rom;
        }
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function isGit(folderPath: string): Promise<boolean> {
    for (; ;) {
        const gitPath = path.join(folderPath, '.git');

        // TODO: utils.isFolder
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

async function listSerialDevices(options: ICommandLineOptions): Promise<void> {
    const devices = await getAllSerialDevices(options);
    process.stdout.write(devices.length + ' serial devices:\n');

    for (let deviceIdx = 0; deviceIdx < devices.length; ++deviceIdx) {
        const device = devices[deviceIdx];

        const attrs: string[] = [];

        function attr(value: string | undefined, name: string): void {
            if (value !== undefined) {
                attrs.push(`${name}: ${value}`);
            }
        }

        attr(device.portInfo.manufacturer, `Manufacturer`);
        attr(device.portInfo.serialNumber, `Serial number`);
        attr(device.portInfo.vendorId, `Vendor ID`);
        attr(device.portInfo.productId, `Product ID`);
        attr(device.portInfo.locationId, `Location ID`);
        attr(device.portInfo.pnpId, `PNP ID`);

        const prefix = `${deviceIdx}. `;

        const indent = ` `.repeat(prefix.length);

        process.stdout.write(`${prefix}Path: ${getSerialPortPath(device.portInfo)}\n`);
        if (attrs.length > 0) {
            process.stdout.write(`${indent}(${attrs.join('; ')})\n`);
        }

        if (device.shouldOpen) {
            process.stdout.write(`${indent}Will use device: ${device.shouldOpenReason}\n`);
        } else {
            process.stdout.write(`${indent}Will not use device: ${device.shouldOpenReason}\n`);
        }
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// The OS X location ID is a 32-bit number. There doesn't seem to be any actual
// documentation about how this value is formed, but it appears to be the
// device's busNumber in bits 24-31, then first portNumber entry in bits 20-23,
// second portNumber entry in bits 16-19, and so on. (No idea what happens if
// you run out of bits.)
//
// This is easy enough to do as a string operation. The serial device list
// returns it as a string anyway.
//
// (I don't know how alpha hex digit come through in the serial device list, as
// there are none on my system. So this just does the comparison
// case-insensitively.)
function getOSXLocationId(d: usb.Device): string {
    let locationId = utils.hex2(d.busNumber);

    for (let i = 0; i < 6; ++i) {
        //tslint:disable-next-line strict-type-predicates
        if (d.portNumbers !== undefined && i < d.portNumbers.length) {
            locationId += d.portNumbers[i].toString(16);
        } else {
            locationId += '0';
        }
    }

    return locationId;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// async function listUSBDevices(): Promise<void> {
//     const devices = usb.getDeviceList();

//     process.stdout.write(`${devices.length} USB devices:\n`);
//     for (let i = 0; i < devices.length; ++i) {
//         const device: usb.Device = devices[i];

//         process.stdout.write(`${i}.BusNumber: ${device.busNumber}, DeviceAddress: ${device.deviceAddress}`);
//         if (process.platform === 'darwin') {
//             process.stdout.write(` (LocationId: 0x${getOSXLocationId(device)}/${device.deviceAddress})`);
//         }

//         process.stdout.write(`\n`);

//         process.stdout.write(`    PID: ${utils.hex4(device.deviceDescriptor.idProduct)}, VID: ${utils.hex4(device.deviceDescriptor.idVendor)}\n`);
//         process.stdout.write(`    PortNumbers: ${device.portNumbers}\n`);

//         let parentIndex: number | undefined;
//         for (let j = 0; j < devices.length; ++j) {
//             if (device.parent === devices[j]) {
//                 parentIndex = j;
//                 break;
//             }
//         }
//         if (parentIndex === undefined) {
//             process.stdout.write(`    No parent device.\n`);
//         } else {
//             process.stdout.write(`    Parent: ${parentIndex}\n`);
//         }

//         try {
//             device.open(false);

//             process.stdout.write(`    Serial: ${await getUSBDeviceStringDescriptor(device, device.deviceDescriptor.iSerialNumber)}\n`);
//             process.stdout.write(`    Product: ${await getUSBDeviceStringDescriptor(device, device.deviceDescriptor.iProduct)}\n`);
//             process.stdout.write(`    Manufacturer: ${await getUSBDeviceStringDescriptor(device, device.deviceDescriptor.iManufacturer)}\n`);

//             device.close();
//         } catch (error) {
//             process.stdout.write(`   Failed to open device: ${error}\n`);
//         }
//     }
// }

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface ISerialDevice {
    portInfo: SerialPort.PortInfo;
    shouldOpen: boolean;
    shouldOpenReason: string;
}

// SerialPort ver 8 changed a field name, from `comName' to 'path', in such a
// way that there's a deprecation warning each time `comName' is used.
//
// I still have no idea how to update TypeScript typings, so... this.
function getSerialPortPath(portInfo: SerialPort.PortInfo): string {
    return (portInfo as any).path;
}

function isSameDevice(a: SerialPort.PortInfo, b: SerialPort.PortInfo): boolean {
    if (a.locationId !== undefined && b.locationId !== undefined) {
        if (a.locationId === b.locationId) {
            return true;
        }

        // Any more conditions?
    }

    return false;
}

function isSerialPortPathInList(portInfo: SerialPort.PortInfo, paths: string[] | null): boolean {
    if (paths !== null) {
        for (const p of paths) {
            if (utils.getSeparatorAndCaseNormalizedPath(getSerialPortPath(portInfo)) === utils.getSeparatorAndCaseNormalizedPath(p)) {
                return true;
            }
        }
    }

    return false;
}

async function getAllSerialDevices(options: ICommandLineOptions): Promise<ISerialDevice[]> {
    const portInfos = await SerialPort.list();
    const ports: ISerialDevice[] = [];

    for (const portInfo of portInfos) {
        let shouldOpen: boolean | undefined;
        let reason = '';

        // Explicit include/exclude takes priority over anything else.
        if (isSerialPortPathInList(portInfo, options.serial_exclude)) {
            shouldOpen = false;
            reason = 'explicitly excluded';
        } else if (isSerialPortPathInList(portInfo, options.serial_include)) {
            shouldOpen = true;
            reason = 'explicitly included';
        }

        // By default, exclude devices that appear multiple times in the list.
        if (shouldOpen === undefined) {
            for (const otherPort of ports) {
                if (isSameDevice(portInfo, otherPort.portInfo)) {
                    // never open duplicate devices by default.
                    //
                    // if the other device should be opened: this one shouldn't,
                    // because it's the same. can't open the same device twice.
                    //
                    // if the other device shouldn't be opened: this one
                    // shouldn't either. presumably there's a reason the user
                    // doesn't want the device opened, that applies to all
                    // copies.
                    //
                    // (to override this, there's always the explicit
                    // include/exclude options.)
                    shouldOpen = false;
                    reason = `apparently same device as: ${getSerialPortPath(otherPort.portInfo)}`;
                    if (otherPort.shouldOpen) {
                        reason += ` (not going to open same device twice)`;
                    } else {
                        reason += ` (${otherPort.shouldOpenReason})`;
                    }
                    break;
                }
            }
        }

        // By default, include supported devices.
        if (shouldOpen === undefined) {
            for (const supportedDevice of SUPPORTED_USB_SERIAL_DEVICES) {
                if (isSerialPortUSBDevice(portInfo, supportedDevice)) {
                    shouldOpen = true;
                    reason = `auto-detected device as: ${supportedDevice.description}`;
                }
            }
        }

        // By default, don't open anything that wasn't recognised or explicitly
        // included.
        if (shouldOpen === undefined) {
            shouldOpen = false;
            reason = 'unknown device';
        }

        ports.push({ portInfo, shouldOpen, shouldOpenReason: reason });
    }

    return ports;
}

async function getOpenableSerialDevices(options: ICommandLineOptions): Promise<ISerialDevice[]> {
    const devices = await getAllSerialDevices(options);

    return devices.filter((device) => device.shouldOpen);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function openSerialPort(portInfo: SerialPort.PortInfo): Promise<SerialPort> {
    // The baud rate is a fixed 115,200. That's the fixed rate supported by the
    // UPURS code, and for the Tube Serial device the baud rate doesn't seem to
    // matter.
    const port = new SerialPort(getSerialPortPath(portInfo), {
        autoOpen: false,
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        rtscts: true,
        xon: false,
        xoff: false,
        xany: false
    });

    await new Promise<void>((resolve, reject) => {
        // don't think the module's TS type definition for the callback is quite
        // right...
        port.open((error: Error | undefined | null) => {
            if (error !== undefined && error !== null) {
                reject(error);
            } else {
                resolve();
            }
        });
    });

    return port;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function serialTestPCToBBC2(device: ISerialDevice): Promise<void> {
    process.stderr.write(`${getSerialPortPath(device.portInfo)}: sending bytes...\n`);

    let numBytesSent = 0;

    async function printBytesSent(): Promise<void> {
        let oldNumBytesSent = numBytesSent;

        for (; ;) {
            await delayMS(1000);
            if (oldNumBytesSent !== numBytesSent) {
                process.stderr.write(`${getSerialPortPath(device.portInfo)}: sent ${numBytesSent} bytes\n`);
                oldNumBytesSent = numBytesSent;
            }
        }
    }

    void printBytesSent();

    const port = await openSerialPort(device.portInfo);

    for (; ;) {
        for (let i = 0; i < 256; ++i) {
            const data = Buffer.alloc(1);
            data[0] = i;

            //process.stderr.write(`${ getSerialPortPath(portInfo) }: ${ i }\n`);

            await new Promise<void>((resolve, reject): void => {
                // Despite what the TypeScript definitions appear to say,
                // the JS code actually only seems to call the callback with
                // a single argument: an error, or undefined.
                port.write(data, (error: any): void => {
                    if (error !== undefined && error !== null) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });

            ++numBytesSent;
        }
    }
}

async function serialTestPCToBBC(options: ICommandLineOptions): Promise<void> {
    for (const device of await getOpenableSerialDevices(options)) {
        void serialTestPCToBBC2(device);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function serialTestBBCToPC2(device: ISerialDevice): Promise<void> {
    const port = await openSerialPort(device.portInfo);

    await new Promise<void>((resolve, reject) => {
        port.flush((error: any) => {
            if (error !== undefined && error !== null) {
                reject(error);
            } else {
                resolve();
            }
        });
    });

    process.stderr.write(`${getSerialPortPath(device.portInfo)}: press any key on the BBC now.\n`);

    let numBytesReceived = 0;

    function handleData(data: Buffer): void {
        for (const got of data) {
            const expected = numBytesReceived & 0xff;
            if (got !== expected) {
                throw new Error(`${getSerialPortPath(device.portInfo)}: +${numBytesReceived}: expected ${expected}, got ${got}\n`);
            }

            ++numBytesReceived;
        }
    }

    // port.on('readable', () => {
    //     const data = port.read();

    //     if (data instanceof Buffer) {
    //         handleData(data);
    //     } else if (typeof (data) === 'string') {
    //         handleData(Buffer.from(data, 'binary'));
    //     } else {
    //         // ignore
    //     }
    // });

    port.on('data', (data: Buffer): void => {
        handleData(data);
    });

    port.on('error', (error: any): void => {
        throw new Error(`${getSerialPortPath(device.portInfo)}: error: ${error}`);
    });

    let oldNumBytesReceived = -1;
    for (; ;) {
        await delayMS(1000);

        if (oldNumBytesReceived !== numBytesReceived) {
            process.stderr.write(`${getSerialPortPath(device.portInfo)}: received ${numBytesReceived} bytes\n`);
            oldNumBytesReceived = numBytesReceived;
        }
    }
}

async function serialTestBBCToPC(options: ICommandLineOptions): Promise<void> {
    for (const device of await getOpenableSerialDevices(options)) {
        void serialTestBBCToPC2(device);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function sendFile(device: ISerialDevice, filePath: string): Promise<void> {
    const port = await openSerialPort(device.portInfo);

    const fileData = await utils.fsReadFile(filePath);

    const portPath = getSerialPortPath(device.portInfo);

    process.stderr.write(`${portPath}: flush\n`);

    await flushPort(port);

    process.stderr.write(`${portPath}: sending: ${filePath} (${fileData.length} byte(s))\n`);

    const maxChunkSize = 1024;

    for (let chunkBegin = 0; chunkBegin < fileData.length; chunkBegin += maxChunkSize) {
        const chunkEnd = Math.min(chunkBegin + maxChunkSize, fileData.length);

        const chunk = fileData.slice(chunkBegin, chunkEnd);

        process.stderr.write(`${portPath}: [${chunkBegin},${chunkEnd})\n`);

        await new Promise<void>((resolve, reject): void => {
            // Despite what the TypeScript definitions appear to say,
            // the JS code actually only seems to call the callback with
            // a single argument: an error, or undefined.
            port.write(chunk, (error: any): void => {
                if (error !== undefined && error !== null) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });

        await drainPort(port);
    }

    process.stderr.write(`${portPath}: sent.\n`);
}

async function serialTestSendFile(options: ICommandLineOptions, filePath: string): Promise<void> {
    for (const device of await getOpenableSerialDevices(options)) {
        void sendFile(device, filePath);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function handleCommandLineOptions(options: ICommandLineOptions, log: utils.Log | undefined): Promise<boolean> {
    log?.pn('libusb_debug_level: ``' + options.libusb_debug_level + '\'\'');
    if (options.libusb_debug_level !== null) {
        usb.setDebugLevel(options.libusb_debug_level);
    }

    log?.pn('cwd: ``' + process.cwd() + '\'\'');

    if (options.serial_test_pc_to_bbc) {
        void serialTestPCToBBC(options);
        return false;
    } else if (options.serial_test_bbc_to_pc) {
        void serialTestBBCToPC(options);
        return false;
    } else if (options.serial_test_send_file !== null) {
        void serialTestSendFile(options, options.serial_test_send_file);
        return false;
    }

    if (options.load_config === null) {
        await loadConfig(options, DEFAULT_CONFIG_FILE_NAME, false);
    } else {
        await loadConfig(options, options.load_config, true);
    }

    if (options.list_serial_devices) {
        await listSerialDevices(options);
        return false;
    }

    //log?.pn('load_config: ``' + options.load_config + '\'\'');
    log?.pn('save_config: ``' + options.save_config + '\'\'');

    if (options.folders.length === 0) {
        throw new Error('no folders specified');
    }

    if (options.folders.length > 1) {
        process.stderr.write('Note: new volumes will be created in: ' + options.folders[0] + '\n');
    }

    if (options.save_config !== null) {
        const config: IConfigFile = {
            default_volume: options.default_volume !== null ? options.default_volume : undefined,
            folders: options.folders,
            pc_folders: options.pcFolders,
            tube_host_folders: options.tubeHostFolders,
            avr_rom: options.avr_rom !== null ? options.avr_rom : undefined,
            tube_serial_rom: options.tube_serial_rom !== null ? options.tube_serial_rom : undefined,
            upurs_rom: options.upurs_rom !== null ? options.upurs_rom : undefined,
            git: options.git,
            serial_include: options.serial_include !== null ? options.serial_include : undefined,
            serial_exclude: options.serial_exclude !== null ? options.serial_exclude : undefined,
        };

        await utils.fsMkdirAndWriteFile(options.save_config, JSON.stringify(config, undefined, '  '));
    }

    if (options.avr_rom === null) {
        options.avr_rom = DEFAULT_BEEBLINK_AVR_ROM;
    }

    if (options.tube_serial_rom === null) {
        options.tube_serial_rom = DEFAULT_BEEBLINK_TUBE_SERIAL_ROM;
    }

    if (options.upurs_rom === null) {
        options.upurs_rom = DEFAULT_BEEBLINK_UPURS_ROM;
    }

    if (!await utils.fsExists(options.avr_rom)) {
        process.stderr.write(`AVR ROM image not found for *BLSELFUPDATE/bootstrap: ${options.avr_rom} \n`);
    }

    if (!await utils.fsExists(options.tube_serial_rom)) {
        process.stderr.write(`Tube Serial ROM image not found for *BLSELFUPDATE/bootstrap: ${options.tube_serial_rom} \n`);
    }

    if (!await utils.fsExists(options.upurs_rom)) {
        process.stderr.write(`UPURS ROM image not found for *BLSELFUPDATE/bootstrap: ${options.upurs_rom} \n`);
    }

    return true;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function createSearchFolders(options: ICommandLineOptions): beebfs.IFSSearchFolders {
    const pathExcludeRegExps: RegExp[] = [];
    for (const regExpStr of options.excludeVolumeRegExps) {
        pathExcludeRegExps.push(new RegExp(regExpStr));
    }

    return {
        beebLinkSearchFolders: options.folders,
        pcFolders: options.pcFolders,
        tubeHostFolders: options.tubeHostFolders,
        pathExcludeRegExps,
    };

}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function createGitattributesManipulator(options: ICommandLineOptions, volumes: beebfs.Volume[]): Promise<gitattributes.Manipulator | undefined> {
    if (!options.git) {
        return undefined;
    }

    const gaManipulator = new gitattributes.Manipulator(options.git_verbose);

    // Find all the paths first, then set the gitattributes manipulator
    // going once they've all been collected, in the interests of doing one
    // thing at a time. (Noticeably faster startup on OS X with lots of
    // volumes, even on an SSD.)

    const oldNumVolumes = volumes.length;

    volumes = volumes.filter((volume) => !volume.isReadOnly());
    volumes = volumes.filter(async (volume) => !(await isGit(volume.path)));
    process.stderr.write(`Found ${volumes.length}/${oldNumVolumes} writeable git-controlled volumes.\n`);

    for (const volume of volumes) {
        gaManipulator.makeVolumeNotText(volume);
        gaManipulator.scanForBASIC(volume);
    }

    gaManipulator.whenQuiescent(() => {
        process.stderr.write('Finished scanning for BASIC files.\n');
    });

    return gaManipulator;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function findDefaultVolume(options: ICommandLineOptions, volumes: beebfs.Volume[]): beebfs.Volume | undefined {
    let defaultVolume: beebfs.Volume | undefined;

    if (options.default_volume !== null) {
        for (const volume of volumes) {
            if (volume.name === options.default_volume) {
                defaultVolume = volume;
                break;
            }
        }

        if (defaultVolume === undefined) {
            process.stderr.write(`Default volume not found: ${options.default_volume}\n`);
        }
    }

    return defaultVolume;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function getRomPathsForAVR(options: ICommandLineOptions): Map<number, string> {
    const map = new Map<number, string>();

    if (options.avr_rom !== null) {
        map.set(beeblink.AVR_SUBTYPE_AVR, options.avr_rom);
    }

    return map;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function getRomPathsForSerial(options: ICommandLineOptions): Map<number, string> {
    const map = new Map<number, string>();

    if (options.upurs_rom !== null) {
        map.set(beeblink.SERIAL_SUBTYPE_UPURS, options.upurs_rom);
    }

    if (options.tube_serial_rom !== null) {
        map.set(beeblink.SERIAL_SUBTYPE_TUBE_SERIAL, options.tube_serial_rom);
    }

    return map;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function handleHTTP(options: ICommandLineOptions, createServer: (additionalPrefix: string, romPathByLinkSubtype: Map<number, string>, linkSupportsFireAndForgetRequests: boolean) => Promise<Server>): void {
    if (!options.http) {
        return;
    }

    const serverBySenderId = new Map<string, Server>();

    const httpServer = http.createServer(async (httpRequest, httpResponse): Promise<void> => {
        async function endResponse(): Promise<void> {
            await new Promise<void>((resolve, reject) => {
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
            if (senderId === undefined || senderId.length === 0 || typeof (senderId) !== 'string') {
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
                server = await createServer('HTTP', getRomPathsForAVR(options), false);
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

function findUSBDeviceForSerialPort(portInfo: SerialPort.PortInfo): usb.Device | undefined {
    const idProduct = Number.parseInt(portInfo.productId!, 16);//why not a number?
    const idVendor = Number.parseInt(portInfo.vendorId!, 16);//why not a number?
    const usbDevices = usb.getDeviceList();
    for (const usbDevice of usbDevices) {
        if (usbDevice.deviceDescriptor.idProduct === idProduct && usbDevice.deviceDescriptor.idVendor === idVendor) {
            if (getOSXLocationId(usbDevice).toLowerCase() === portInfo.locationId!.toLowerCase()) {
                return usbDevice;
            }
        }
    }

    return undefined;
}

async function setFTDILatencyTimer(portInfo: SerialPort.PortInfo, ms: number, serialLog: utils.Log | undefined): Promise<void> {
    if (process.platform === 'win32') {
        // When trying to open the device with libusb, the device open
        // fails with LIBUSB_ERROR_UNSUPPORTED. See, e.g.,
        // https://stackoverflow.com/questions/17350177/
        //
        // But it's not a huge problem, as the latency timer can be set
        // manually, and the setting is persistent.
    } else if (process.platform === 'darwin') {
        if (portInfo.locationId === undefined) {
            process.stderr.write(`Not setting FTDI latency timer for ${getSerialPortPath(portInfo)} - no locationId.\n`);
        } else if (portInfo.productId === undefined) {
            process.stderr.write(`Not setting FTDI latency timer for ${getSerialPortPath(portInfo)} - no productId.\n`);
        } else if (portInfo.vendorId === undefined) {
            process.stderr.write(`Not setting FTDI latency timer for ${getSerialPortPath(portInfo)} - no vendorId.\n`);
        } else {
            // Send USB control request to set the latency timer.

            // Try to find the corresponding usb device in the device list.
            //
            // The serial numbers for the FTDI devices aren't necessarily
            // unique, so search by OS X location id rather than serial number.

            let usbDevice: usb.Device | undefined;
            let numAttempts = 0;
            while (numAttempts++ < 5) {
                usbDevice = findUSBDeviceForSerialPort(portInfo);
                if (usbDevice !== undefined) {
                    break;
                }

                await delayMS(500);
            }

            if (usbDevice === undefined) {
                process.stderr.write(`Not setting FTDI latency timer for ${getSerialPortPath(portInfo)} - didn't find corresponding USB device after ${numAttempts} attempt(s)\n`);
                return;
            }

            try {
                process.stderr.write(`Setting FTDI latency timer for ${getSerialPortPath(portInfo)} to ${ms}ms.\n`);

                usbDevice.open();

                // logic copied out of libftdi's ftdi_usb_open_dev.
                serialLog?.pn(`Setting USB device configuration...`);
                if (usbDevice.configDescriptor.bConfigurationValue !== usbDevice.allConfigDescriptors[0].bConfigurationValue) {
                    await new Promise<void>((resolve, reject) => {
                        usbDevice!.setConfiguration(usbDevice!.allConfigDescriptors[0].bConfigurationValue, (err) => {
                            if (err !== undefined) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    });
                }

                const FTDI_DEVICE_OUT_REQTYPE = usb.LIBUSB_REQUEST_TYPE_VENDOR | usb.LIBUSB_RECIPIENT_DEVICE | usb.LIBUSB_ENDPOINT_OUT;
                const SIO_SET_LATENCY_TIMER_REQUEST = 0x09;

                // values corresponding to ftdi->interface and ftdi->index. 1 =
                // INTERFACE_A. (No idea, just copying code here.)
                const ftdiInterface = 0;
                const ftdiIndex = 1;

                //serialLog?.pn(`${usbDevice.interfaces.length} interfaces`);

                try {
                    // 1 = INTERFACE_A.
                    serialLog?.pn(`Claiming USB device interface...`);
                    usbDevice.__claimInterface(ftdiInterface);
                } catch (error) {
                    serialLog?.pn(`Ignoring claimInterface error: ${error}`);
                }

                serialLog?.pn(`Setting latency timer...`);
                await deviceControlTransfer(usbDevice,
                    FTDI_DEVICE_OUT_REQTYPE,
                    SIO_SET_LATENCY_TIMER_REQUEST,
                    ms,//1 = 1ms
                    ftdiIndex,
                    undefined);

                serialLog?.pn(`Done... hopefully.`);
            } catch (error) {
                process.stderr.write(`Error setting FTDI latency timer for ${getSerialPortPath(portInfo)}: ${error}\n`);
            } finally {
                usbDevice.close();
            }
        }
    } else if (process.platform === 'linux') {
        if (ioctl === undefined) {
            process.stderr.write(`Not setting low latency mode for ${getSerialPortPath(portInfo)} - ioctl module not available.\n`);
        } else {
            // The latency timer value can be found in the file
            // /sys/bus/usb-serial/devices/<<DEVICE>>/latency_timer, only
            // writeable by root.
            //
            // The latency timer value can't be set directly, but you can
            // use ioctl to set the ASYNC_LOW_LATENCY bit of the serial
            // port, which sets it to 1ms.
            //
            // See https://www.linuxjournal.com/article/6226 for some
            // notes about TIOCGSERIAL.
            //
            // Regarding ASYNC_LOW_LATENCY, see, e.g.,
            // https://stackoverflow.com/questions/13126138/,
            // https://github.com/pyserial/pyserial/issues/287
            //
            // Once set, ASYNC_LOW_LATENCY seems to stick until the device
            // is unplugged.

            const TIOCGSERIAL = 0x541e;// /usr/include/asm-generic/ioctls.h
            const TIOCSSERIAL = 0x541f;// /usr/include/asm-generic/ioctls.h
            const ASYNC_LOW_LATENCY = 1 << 13;// /usr/include/linux/tty_flags.h
            const flagsOffset = 16;// offsetof(serial_struct,flags)

            const le = os.endianness() === 'LE';//but who am I kidding here.

            let fd = -1;
            try {
                fd = await utils.fsOpen(getSerialPortPath(portInfo), 'r+');

                const buf = Buffer.alloc(1000);//exact size doesn't really matter.

                // This call seems to fill the struct mostly with zeros,
                // which I'm a bit unsure about. But setting the
                // ASYNC_LOW_LATENCY bit does appear to work.
                ioctl(fd, TIOCGSERIAL, buf);

                let flags = le ? buf.readUInt32LE(16) : buf.readUInt32BE(flagsOffset);
                flags |= ASYNC_LOW_LATENCY;
                if (le) {
                    buf.writeUInt32LE(flags, flagsOffset);
                } else {
                    buf.writeUInt32BE(flags, flagsOffset);
                }

                ioctl(fd, TIOCSSERIAL, buf);
            } catch (error) {
                process.stderr.write(`Error setting low latency mode for ${getSerialPortPath(portInfo)}: ${error}\n`);
            } finally {
                if (fd >= 0) {
                    await utils.fsClose(fd);
                    fd = -1;
                }
            }
        }
    } else {
        // Answers on a postcard...
    }
}

interface IReadWaiter {
    resolve: (() => void) | undefined;
    reject: ((error: any) => void) | undefined;
}

// function getPortDescription(portInfo: SerialPort.PortInfo): string {
//     return `Device ${getSerialPortPath(portInfo)}`;
// }

function isSerialDeviceVerbose(portInfo: SerialPort.PortInfo, verboseOptions: string[] | null): boolean {
    if (verboseOptions !== null) {
        if (verboseOptions.includes('')) {
            // --whatever, applying to all devices was provided on its own at some
            // point
            return true;
        }

        if (verboseOptions.includes(getSerialPortPath(portInfo))) {
            return true;
        }
    }

    return false;
}

async function flushPort(port: SerialPort): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        port.flush((error: any) => {
            if (error !== undefined && error !== null) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function drainPort(port: SerialPort): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        port.drain((error: any) => {
            if (error !== null && error !== undefined) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function handleSerialDevice(options: ICommandLineOptions, portInfo: SerialPort.PortInfo, server: Server): Promise<void> {
    const f = process.stdout;

    const serialLog = utils.Log.create(getSerialPortPath(portInfo), f, isSerialDeviceVerbose(portInfo, options.serial_verbose));

    let port: SerialPort;
    try {
        port = await openSerialPort(portInfo);
    } catch (error) {
        process.stderr.write(`Error opening serial port ${getSerialPortPath(portInfo)}: ${error}\n`);
        return;
    }

    if (isSerialPortUSBDevice(portInfo, TUBE_SERIAL_DEVICE) || isSerialPortUSBDevice(portInfo, FTDI_USB_SERIAL_DEVICE)) {
        await setFTDILatencyTimer(portInfo, 1, serialLog);
    }

    let readWaiter: IReadWaiter | undefined;
    const readBuffers: Buffer[] = [];
    let readIndex = 0;

    const dataInLog = utils.Log.create(getSerialPortPath(portInfo), f, isSerialDeviceVerbose(portInfo, options.serial_data_verbose));
    const dataOutLog = utils.Log.create(getSerialPortPath(portInfo), f, isSerialDeviceVerbose(portInfo, options.serial_data_verbose));
    const syncLog = utils.Log.create(`${getSerialPortPath(portInfo)}: sync`, f, isSerialDeviceVerbose(portInfo, options.serial_sync_verbose));

    process.stderr.write(`${getSerialPortPath(portInfo)}: serving. (verbose=${utils.Log.isEnabled(serialLog)}, data-verbose=(in: ${utils.Log.isEnabled(dataInLog)}, out: ${utils.Log.isEnabled(dataOutLog)}), sync-verbose=${utils.Log.isEnabled(syncLog)})\n`);

    port.on('data', (data: Buffer): void => {
        readBuffers.push(data);

        dataInLog?.withIndent('data in: ', () => {
            dataInLog.dumpBuffer(data);
        });

        if (readWaiter !== undefined) {
            const waiter = readWaiter;
            readWaiter = undefined;

            if (waiter.resolve !== undefined) {
                waiter.resolve();
            }
        }

    });

    function rejectReadWaiter(error: any): void {
        if (readWaiter !== undefined) {
            const waiter = readWaiter;
            readWaiter = undefined;

            if (waiter.reject !== undefined) {
                waiter.reject(error);
            }
        }
    }

    port.on('error', (error: any): void => {
        serialLog?.pn(`error: ${error}`);
        rejectReadWaiter(error);
    });

    port.on('close', (error: any): void => {
        serialLog?.pn(`close: ${error}`);
        rejectReadWaiter(error);
    });

    async function readByte(): Promise<number> {
        if (readBuffers.length === 0) {
            //dataInLog?.pn(`readByte: waiting for more data...`);

            await new Promise<void>((resolve, reject): void => {
                readWaiter = { resolve, reject };
            });

            //dataInLog?.pn(`readByte: got some data`);
        }

        //dataInLog?.pn(`readByte: readBuffers.length=${readBuffers.length}, readBuffers[0].length=${readBuffers[0].length}, readIndex=0x${readIndex.toString(16)}`);
        const byte = readBuffers[0][readIndex++];

        if (readIndex === readBuffers[0].length) {
            readBuffers.splice(0, 1);
            readIndex = 0;
        }

        return byte;
    }

    async function readConfirmationByte(): Promise<boolean> {
        const byte = await readByte();

        if (byte === 1) {
            return true;
        } else {
            serialLog?.pn(`Got confirmation byte: ${byte}  - returning to sync state`);
            return false;
        }
    }

    async function writeSyncData(): Promise<void> {
        const syncData = Buffer.alloc(beeblink.NUM_SERIAL_SYNC_ZEROS + 1);
        syncData[syncData.length - 1] = 1;

        await new Promise<void>((resolve, reject): void => {
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
    }

    function getNegativeOffsetLSB(index: number, payload: Buffer): number {
        assert.ok(index >= 0 && index < payload.length);

        // 
        return (-(payload.length - 1 - index)) & 0xff;
    }

    await flushPort(port);

    // Start with the request/response loop, not the sync loop. If the BBC was
    // already synced after a previous run of the server, it can carry on from
    // where it left off, allowing it to survive a server restart. If not, it
    // will embark on the sync process from its end and enter the sync loop that
    // way.
    server_loop:
    for (; ;) {
        // Request/response loop.
        //
        // Treat a command of 0xff same as 0x00 - sometimes when switching of
        // the BBC the server receives a stream of 0xff/0x00 bytes. Safest to
        // put it in the sync state when it looks like this is happening.
        //
        // No point trying to handle junk at other times.

        request_response_loop:
        for (; ;) {
            serialLog?.pn(`Waiting for request...`);
            const cmdByte = await readByte();

            let request: Request;
            {
                const c = cmdByte & 0x7f;
                const variableSizeRequest = (cmdByte & 0x80) !== 0;

                if (c === 0 || c === 0x7f) {
                    serialLog?.pn(`Got command ${utils.hex2(c)} - returning to sync state`);
                    // Special syntax.
                    break request_response_loop;
                }

                let p: Buffer;
                if (!variableSizeRequest) {
                    // 1-byte payload.
                    p = Buffer.alloc(1);
                } else {
                    serialLog?.pn(`Waiting for payload size...`);
                    // Variable-size payload.
                    const b0 = await readByte();
                    const b1 = await readByte();
                    const b2 = await readByte();
                    const b3 = await readByte();
                    const size = UInt32(b0, b1, b2, b3);

                    p = Buffer.alloc(size);
                }

                serialLog?.pn(`Got request 0x${utils.hex2(c)} (${utils.getRequestTypeName(c)}). Waiting for ${p.length} payload bytes...`);

                for (let i = 0; i < p.length; ++i) {
                    p[i] = await readByte();

                    const j = getNegativeOffsetLSB(i, p);

                    //serialLog?.pn(`    index ${i} (-ve LSB=0x${utils.hex2(j)}): value=${p[i]} (0x${utils.hex2(p[i])})`);

                    if (j === 0) {
                        if (!await readConfirmationByte()) {
                            break request_response_loop;
                        }
                    }
                }

                request = new Request(c, p);
            }

            const response = await server.handleRequest(request);

            if (request.isFireAndForget()) {
                // Do nothing.
                serialLog?.pn('(Fire-and-forget request - no response)');
            } else {
                serialLog?.pn(`Sending response 0x${utils.hex2(response.c)} (${utils.getResponseTypeName(response.c)})`);
                let responseData: Buffer;

                // serialLog.withIndent('response: ', () => {
                //     serialLog?.pn(`c=0x${utils.hex2(response.c)}`);
                //     serialLog.withIndent(`p=`, () => {
                //         serialLog.dumpBuffer(response.p, 10);
                //     });
                // });

                let destIdx = 0;

                if (response.p.length === 1 && !options.serial_full_size_messages) {
                    responseData = Buffer.alloc(3);

                    responseData[destIdx++] = response.c & 0x7f;
                    responseData[destIdx++] = response.p[0];
                    responseData[destIdx++] = 1;//confirmation byte
                } else {
                    responseData = Buffer.alloc(1 + 4 + response.p.length + ((response.p.length + 255) >> 8));

                    responseData[destIdx++] = response.c | 0x80;

                    responseData.writeUInt32LE(response.p.length, destIdx);
                    destIdx += 4;

                    for (let srcIdx = 0; srcIdx < response.p.length; ++srcIdx) {
                        responseData[destIdx++] = response.p[srcIdx];

                        if (getNegativeOffsetLSB(srcIdx, response.p) === 0) {
                            responseData[destIdx++] = 1;//confirmation byte
                        }
                    }
                }

                assert.strictEqual(destIdx, responseData.length);

                // This doesn't seem to work terribly well! - should probably just
                // write the whole lot in one big lump and then use the JS analogue
                // of tcflush, whatever it is (assuming there is one, and it's
                // Windows-friendly).
                {
                    serialLog?.pn(`Sending ${responseData.length} bytes response data...`);
                    dataOutLog?.withIndent('data out: ', () => {
                        dataOutLog.dumpBuffer(responseData);
                    });

                    const maxChunkSize = 512;//arbitrary.
                    let srcIdx = 0;
                    while (srcIdx < responseData.length) {
                        const chunk = responseData.subarray(srcIdx, srcIdx + maxChunkSize);

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
                                serialLog?.pn(`Received data while sending - returning to sync state`);
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
                            break request_response_loop;
                        }

                        srcIdx += maxChunkSize;
                    }
                }
            }

            await drainPort(port);

            serialLog?.pn(`Done one request/response.`);
        }

        // Sync loop.
        port.removeAllListeners('drain');

        let synced = false;

        do {
            serialLog?.pn(`Sync: flushing buffers...`);

            // https://stackoverflow.com/questions/13013387/clearing-the-serial-ports-buffer
            //await delayMS(500);
            await flushPort(port);
            //await delayMS(500);

            serialLog?.pn(`Sync: Waiting for ${beeblink.NUM_SERIAL_SYNC_ZEROS} sync 0x00 bytes...`);

            let numZeros = 0;
            while (numZeros < beeblink.NUM_SERIAL_SYNC_ZEROS) {
                const x = await readByte();
                syncLog?.pn(`read server step 1 sync byte: ${x} (${numZeros} 0x00 bytes read)`);
                if (x !== 0) {
                    numZeros = 0;
                } else {
                    ++numZeros;
                }
            }

            serialLog?.pn(`Received ${numZeros} 0 sync bytes.`);

            serialLog?.pn(`sync: write server step 2 sync data`);
            await writeSyncData();

            // eat remaining sync 0s.
            {
                let n = 0;
                let x;
                do {
                    x = await readByte();
                    ++n;
                    syncLog?.pn(`read server step 3 sync byte: ${x} (${n} bytes read)`);

                    // if (n > 5 * beeblink.NUM_SERIAL_SYNC_ZEROS) {
                    //     // a previous sync was probably interrupted, so send the sync data again.
                    //     serialLog?.pn(`taking too long! - sending server step 1 sync data again...`);
                    //     await writeSyncData();
                    //     n = 0;
                    // }
                } while (x === 0);

                if (x === 1) {
                    serialLog?.pn(`Got 0x01 byte - now synced`);
                    synced = true;
                } else {
                    serialLog?.pn(`No sync - bad sync value: ${x} (0x${utils.hex2(x)})`);
                }
            }
        } while (!synced);
    }
}

interface IPortState {
    server: Server;
    active: boolean;
}

async function handleSerial(options: ICommandLineOptions, createServer: (additionalPrefix: string, romPathByLinkSubtype: Map<number, string>, linkSupportsFireAndForgetRequests: boolean) => Promise<Server>): Promise<void> {
    const log = utils.Log.create('SERIAL-DEVICES', process.stdout, options.serial_verbose !== null);

    const portStateByPortPath = new Map<string, IPortState>();

    for (; ;) {
        for (const device of await getOpenableSerialDevices(options)) {
            const portPath = getSerialPortPath(device.portInfo);

            let value = portStateByPortPath.get(portPath);
            if (value === undefined) {
                log?.pn(`${portPath}: new serial port`);
                value = {
                    server: await createServer('SERIAL', getRomPathsForSerial(options), true),
                    active: false,//not quite active just yet!
                };
                portStateByPortPath.set(portPath, value);
            }

            // Some JS nonsense here ? For some reason, the compiler can't tell
            // that 'value' can no longer be undefined by the time it's used by
            // the 'then' and 'error' callbacks below, even though it's captured
            // by them after its active field was set to true, suggesting that
            // it can tell it wasn't undefined by that point at least. Create a
            // new variable of the right type here though and it's fine...
            const portState: IPortState = value;

            if (!portState.active) {
                portState.active = true;
                handleSerialDevice(options, device.portInfo, portState.server).then(() => {
                    process.stderr.write(`${getSerialPortPath(device.portInfo)}: connection closed.\n`);
                    portState.active = false;
                }).catch((error) => {
                    process.stderr.write(`${error.stack}`);
                    process.stderr.write(`${getSerialPortPath(device.portInfo)}: connection closed due to error: ${error}\n`);
                    portState.active = false;
                });
            }
        }

        await delayMS(DEVICE_RETRY_DELAY_MS);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function main(options: ICommandLineOptions) {
    const log = utils.Log.create('', process.stderr, options.verbose);

    if (!await handleCommandLineOptions(options, log)) {
        return;
    }

    const searchFolders = createSearchFolders(options);

    const volumes = await beebfs.FS.findAllVolumes(searchFolders, log);

    const gaManipulator = await createGitattributesManipulator(options, volumes);

    const defaultVolume = findDefaultVolume(options, volumes);

    // 
    const logPalette = [
        chalk.red,
        chalk.blue,
        chalk.yellow,
        chalk.green,
        chalk.black,
    ];

    let nextConnectionId = 1;

    async function createServer(additionalPrefix: string, romPathByLinkSubtype: Map<number, string>, linkSupportsFireAndForgetRequests: boolean): Promise<Server> {
        const connectionId = nextConnectionId++;
        const colours = logPalette[(connectionId - 1) % logPalette.length];//-1 as IDs are 1-based

        const bfsLogPrefix = options.fs_verbose ? 'FS' + connectionId : undefined;
        const bfsLog = utils.Log.create(bfsLogPrefix !== undefined ? bfsLogPrefix : '', process.stderr, bfsLogPrefix !== undefined);
        if (bfsLog !== undefined) {
            bfsLog.colours = colours;
        }

        const serverLogPrefix = options.server_verbose ? additionalPrefix + 'SRV' + connectionId : undefined;
        const serverLog = utils.Log.create(serverLogPrefix !== undefined ? serverLogPrefix : '', process.stderr, serverLogPrefix !== undefined);

        const bfs = new beebfs.FS(searchFolders, gaManipulator, bfsLog, options.locate_verbose);

        if (defaultVolume !== undefined) {
            await bfs.mount(defaultVolume);
        }

        const server = new Server(romPathByLinkSubtype, bfs, serverLog, options.server_data_verbose, linkSupportsFireAndForgetRequests);
        return server;
    }

    handleHTTP(options, createServer);

    void handleSerial(options, createServer);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// argparse calls parseInt with a radix of 10.
function integer(s: string): number {
    const x = parseInt(s, undefined);
    if (Number.isNaN(x)) {
        throw new Error('invalid number provided: "' + s + '"');
    }

    return x;
}

function createArgumentParser(fullHelp: boolean): argparse.ArgumentParser {
    const epi =
        'Settings for VOLUME-FOLDER(s), --pc, --default-volume, --serial-include, --serial-exclude, --git and --*-rom will be loaded from "' + DEFAULT_CONFIG_FILE_NAME + '" if present. ' +
        'Use --load-config to load from a different file. Use --save-config to save all options (both those loaded from file ' +
        'and those specified on the command line) to the given file.';

    const parser = new argparse.ArgumentParser({
        addHelp: false,
        description: 'BeebLink server',
        epilog: epi,
    });

    function always(switches: string[], options: argparse.ArgumentOptions): void {
        parser.addArgument(switches, options);
    }

    function fullHelpOnly(switches: string[], options: argparse.ArgumentOptions): void {
        if (!fullHelp) {
            // see node_modules/argparse/lib/const.js - but how are you supposed
            // to actually access this from TypeScript?
            options.help = '==SUPPRESS==';
        }

        always(switches, options);
    }

    // Help
    always(['-h', '--help'], { action: 'storeTrue', help: 'Show this help message, then exit (combine with -v to show more options)' });

    // ROM paths
    fullHelpOnly(['--avr-rom'], { metavar: 'FILE', defaultValue: null, help: 'read BeebLink AVR ROM (for use with b2) from %(metavar)s. Default: ' + DEFAULT_BEEBLINK_AVR_ROM });
    fullHelpOnly(['--tube-serial-rom'], { metavar: 'FILE', defaultValue: null, help: 'read BeebLink Tube Serial ROM from %(metavar)s. Default: ' + DEFAULT_BEEBLINK_TUBE_SERIAL_ROM });
    fullHelpOnly(['--upurs-rom'], { metavar: 'FILE', defaultValue: null, help: 'read BeebLink UPURS ROM from %(metavar)s. Default: ' + DEFAULT_BEEBLINK_UPURS_ROM });

    // Verbosity
    always(['-v', '--verbose'], { action: 'storeTrue', help: 'extra output' });
    fullHelpOnly(['--fs-verbose'], { action: 'storeTrue', help: 'extra filing system-related output' });
    fullHelpOnly(['--server-verbose'], { action: 'storeTrue', help: 'extra request/response output' });
    fullHelpOnly(['--server-data-verbose'], { action: 'storeTrue', help: 'dump request/response data (requires --server-verbose)' });
    fullHelpOnly(['--libusb-debug-level'], { type: integer, metavar: 'LEVEL', help: 'if provided, set libusb debug logging level to %(metavar)s' });
    fullHelpOnly(['--fatal-verbose'], { action: 'storeTrue', help: 'print debugging info on a fatal error' });
    fullHelpOnly(['--locate-verbose'], { action: 'storeTrue', help: 'extra *LOCATE output (requires --server-verbose)' });

    // Git
    always(['--git'], { action: 'storeTrue', help: 'look after .gitattributes for BBC volumes' });
    fullHelpOnly(['--git-verbose'], { action: 'storeTrue', help: 'extra git-related output' });

    // Serial devices
    fullHelpOnly(['--serial-include'], { action: 'append', metavar: 'DEVICE', help: 'listen on serial port DEVICE' });
    fullHelpOnly(['--serial-exclude'], { action: 'append', metavar: 'DEVICE', help: 'don\'t listen on serial port DEVICE' });
    fullHelpOnly(['--serial-verbose'], { action: 'append', nargs: '?', constant: '', help: 'extra serial-related output (specify devices individually to be verbose for just those, or just --serial-verbose on its own for all devices)' });
    fullHelpOnly(['--serial-sync-verbose'], { action: 'append', nargs: '?', constant: '', help: 'extra serial sync-related output (specify devices same as --serial-verbose)' });
    fullHelpOnly(['--serial-data-verbose'], { action: 'append', nargs: '?', constant: '', help: 'dump raw serial data sent/received (specify devices same as --serial-verbose)' });
    fullHelpOnly(['--serial-test-pc-to-bbc'], { action: 'storeTrue', help: 'run PC->BBC test (goes with T.PC-TO-BBC on the BBC)' });
    fullHelpOnly(['--serial-test-bbc-to-pc'], { action: 'storeTrue', help: 'run BBC->PC test (goes with T.BBC-TO-PC on the BBC)' });
    fullHelpOnly(['--serial-test-send-file'], { metavar: 'FILE', defaultValue: null, help: 'send file, PC->BBC' });
    fullHelpOnly(['--serial-full-size-messages'], { action: 'storeTrue', help: 'always send full-size messages, and never use any shortened syntax (affects all devices) (may reveal bug(s) in pre-Nov 2021 ROM versions...)' });
    always(['--list-serial-devices'], { action: 'storeTrue', help: 'list available serial devices, then exit' });

    // HTTP server (for b2)
    always(['--http'], { action: 'storeTrue', help: 'enable HTTP server' });
    fullHelpOnly(['--http-all-interfaces'], { action: 'storeTrue', help: 'at own risk, make HTTP server listen on all interfaces, not just localhost' });
    //parser.addArgument(['--http-verbose'], { action: 'storeTrue', help: 'extra HTTP-related output' });

    // Config file
    always(['--load-config'], { metavar: 'FILE', help: 'load config from %(metavar)s' });
    always(['--save-config'], { metavar: 'FILE', nargs: '?', constant: DEFAULT_CONFIG_FILE_NAME, help: 'save config to %(metavar)s (%(constant)s if not specified)' });

    // Volumes

    // don't use the argparse default mechanism for --default-volume - this
    // makes it easier to later detect the absence of --default-volume.
    always(['--default-volume'], { metavar: 'DEFAULT-VOLUME', help: 'load volume %(metavar)s on startup' });
    always(['--pc'], { dest: 'pcFolders', action: 'append', defaultValue: [], metavar: 'FOLDER', help: 'use %(metavar)s as a PC volume' });
    always(['--tube-host'], { dest: 'tubeHostFolders', action: 'append', defaultValue: [], metavar: 'FOLDER', help: 'use %(metavar)s as a Tube Host volume' });
    always(['folders'], { nargs: '*', metavar: 'VOLUME-FOLDER', help: 'search %(metavar)s for BeebLink volumes' });
    fullHelpOnly(['--exclude-volume'], { dest: 'excludeVolumeRegExps', action: 'append', defaultValue: [], metavar: 'REGEXP', help: 'for this run, exclude volume(s) with paths matching regexp %(metavar)s' });

    return parser;
}

{
    let parser = createArgumentParser(true);

    const options = parser.parseArgs();

    if (options.help) {
        if (!options.verbose) {
            parser = createArgumentParser(false);
        }

        parser.printHelp();
        process.exit(0);
    }

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
