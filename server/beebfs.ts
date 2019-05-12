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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_FIRST_FILE_HANDLE, DEFAULT_NUM_FILE_HANDLES } from './beeblink';
import * as utils from './utils';
import { BNL } from './utils';
import { Chalk } from 'chalk';
import * as gitattributes from './gitattributes';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

const MAX_NUM_DRIVES = 8;
const MAX_FILE_SIZE = 0xffffff;
const INF_EXT = '.inf';
const LOCKED_ATTR = 8;

// Must be <255, but aside from that it's a completely arbitrary limit.
const MAX_TITLE_LENGTH = 40;

// 10 is the CFS/CFS/ADFS limit, so it's not pushing the boat out *too* much...
const MAX_NAME_LENGTH = 10;

const MIN_FILE_HANDLE = 0xa0;

export const SHOULDNT_LOAD = 0xffffffff;
export const SHOULDNT_EXEC = 0xffffffff;

const DEFAULT_LOAD = SHOULDNT_LOAD;
const DEFAULT_EXEC = SHOULDNT_EXEC;
const DEFAULT_ATTR = 0;

const BOOT_OPTION_DESCRIPTIONS = ['None', 'LOAD', 'RUN', 'EXEC'];

const OPT4_FILE_NAME = '.opt4';
const TITLE_FILE_NAME = '.title';
const VOLUME_FILE_NAME = '.volume';
const PC_FILE_NAME = '.beeblink-pc';

const DEFAULT_TITLE = '';
const DEFAULT_BOOT_OPTION = 0;

const HOST_NAME_ESCAPE_CHAR = '#';

const HOST_NAME_CHARS: string[] = [];
for (let c = 0; c < 256; ++c) {
    let escape = false;

    if (c < 32) {
        escape = true;
    } else if (c > 126) {
        escape = true;
    } else if ('/'.indexOf(String.fromCharCode(c)) >= 0) {
        // not valid on Windows or Unix
        escape = true;
    } else if ('<>:"\\|?*'.indexOf(String.fromCharCode(c)) >= 0) {
        // not valid on Windows
        escape = true;
    } else if (' .'.indexOf(String.fromCharCode(c)) >= 0) {
        // It's worth escaping '.', because it makes it impossible to create a
        // BBC file that ends with '.inf'...
        escape = true;
    } else if (String.fromCharCode(c) === HOST_NAME_ESCAPE_CHAR) {
        // the escape char itself.
        escape = true;
    }

    if (escape) {
        HOST_NAME_CHARS.push('#' + utils.hex2(c));
    } else {
        HOST_NAME_CHARS.push(String.fromCharCode(c));
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class BeebError extends Error {
    public readonly code: number;
    public readonly text: string;

    public constructor(code: number, text: string) {
        super(text + ' (' + code + ')');

        this.code = code;
        this.text = text;
    }

    public toString() {
        return this.message;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export enum ErrorCode {
    TooManyOpen = 192,
    ReadOnly = 193,
    Open = 194,
    Locked = 195,
    Exists = 196,
    TooBig = 198,
    DiscFault = 199,
    VolumeReadOnly = 201,
    BadName = 204,
    BadDrive = 205,
    BadDir = 206,
    BadAttribute = 207,
    FileNotFound = 214,
    Syntax = 220,//no generic text for this
    Channel = 222,
    EOF = 223,
    BadString = 253,
    BadCommand = 254,
    DataLost = 0xca,
    Wont = 0x93,
}

const errorTexts: { [index: number]: string | undefined } = {
    [ErrorCode.TooManyOpen]: 'Too many open',
    [ErrorCode.ReadOnly]: 'Read only',
    [ErrorCode.Open]: 'Open',
    [ErrorCode.Locked]: 'Locked',
    [ErrorCode.Exists]: 'Exists',
    [ErrorCode.TooBig]: 'Too big',
    [ErrorCode.DiscFault]: 'Disc fault',
    [ErrorCode.BadName]: 'Bad name',
    [ErrorCode.BadDrive]: 'Bad drive',
    [ErrorCode.BadDir]: 'Bad dir',
    [ErrorCode.BadAttribute]: 'Bad attribute',
    [ErrorCode.FileNotFound]: 'File not found',
    [ErrorCode.Channel]: 'Channel',
    [ErrorCode.EOF]: 'EOF',
    [ErrorCode.BadString]: 'Bad string',
    [ErrorCode.BadCommand]: 'Bad command',
    [ErrorCode.DataLost]: 'Data lost',
    [ErrorCode.Wont]: 'Won\'t',
    [ErrorCode.VolumeReadOnly]: 'Volume read only',
};

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Fully-qualified name of a Beeb file that may or may not exist. Drive and dir
// are as supplied on command line, or filled in from defaults, as appropriate.
//
// This was a slightly late addition and isn't used everywhere it should be...
export class BeebFQN {
    public readonly volume: BeebVolume;
    public readonly drive: string;
    public readonly dir: string;
    public readonly name: string;

    public constructor(volume: BeebVolume, drive: string, dir: string, name: string) {
        this.volume = volume;
        this.drive = drive;
        this.dir = dir;
        this.name = name;
    }

    public toString() {
        return '::' + this.volume.path + ':' + this.drive + '.' + this.dir + '.' + this.name;
    }

    public equals(other: BeebFQN): boolean {
        return this.volume.equals(other.volume) && utils.strieq(this.drive, other.drive) && utils.strieq(this.dir, other.dir) && utils.strieq(this.name, other.name);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class BeebFile {
    public readonly hostPath: string;
    public readonly name: BeebFQN;
    public readonly load: number;
    public readonly exec: number;
    public readonly size: number;
    public readonly attr: number;

    // could perhaps be part of the attr field, but I'm a bit reluctant to
    // fiddle around with that.
    public readonly text: boolean;

    public constructor(hostPath: string, name: BeebFQN, load: number, exec: number, size: number, attr: number, text: boolean) {
        this.hostPath = hostPath;
        this.name = name;
        this.load = load;
        this.exec = exec;
        this.size = size;
        this.attr = attr;
        this.text = text;
    }

    public isLocked() {
        return (this.attr & LOCKED_ATTR) !== 0;
    }

    public toString(): string {
        return 'BeebFile(hostPath=``' + this.hostPath + '\'\' name=``' + this.name + '\'\' load=0x' + utils.hex8(this.load) + ' exec=0x' + utils.hex8(this.exec) + ' size=' + this.size + ' (0x' + this.size.toString(16) + ') attr=0x' + utils.hex8(this.attr);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class OpenFile {
    public readonly hostPath: string;
    public readonly name: BeebFQN;
    public readonly read: boolean;
    public readonly write: boolean;
    public ptr: number;
    public eofError: boolean;// http://beebwiki.mdfs.net/OSBGET
    public dirty: boolean;

    // I wasn't going to buffer anything originally, but I quickly found it
    // massively simplifies the error handling.
    public readonly contents: number[];

    public constructor(hostPath: string, name: BeebFQN, read: boolean, write: boolean, contents: number[]) {
        this.hostPath = hostPath;
        this.name = name;
        this.read = read;
        this.write = write;
        this.ptr = 0;
        this.eofError = false;
        this.contents = contents;
        this.dirty = false;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class BeebDrive {
    public readonly volume: BeebVolume;
    public readonly name: string;
    public readonly option: number;
    public readonly title: string;

    public constructor(volume: BeebVolume, name: string, option: number, title: string) {
        this.volume = volume;
        this.name = name;
        this.option = option;
        this.title = title;
    }

    public getOptionDescription(): string {
        return BOOT_OPTION_DESCRIPTIONS[this.option & 3];
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export enum BeebVolumeType {
    DFS,
    PC,
}

export class BeebVolume {
    public readonly path: string;
    public readonly name: string;
    public readonly type: BeebVolumeType;
    private readOnly: boolean;

    public constructor(volumePath: string, name: string, type: BeebVolumeType, readOnly: boolean) {
        this.path = volumePath;
        this.name = name;
        this.type = type;
        this.readOnly = readOnly;
    }

    public isReadOnly(): boolean {
        if (this.type === BeebVolumeType.PC) {
            return true;
        }

        if (this.readOnly) {
            return true;
        }

        return false;
    }

    public asReadOnly(): BeebVolume {
        return new BeebVolume(this.path, this.name, this.type, true);
    }

    public equals(oth: BeebVolume): boolean {
        // No need to check the name.
        return this.path === oth.path;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Name of Beeb file or dir, that may or may not exist, as entered on the
// command line. Components not supplied are set to undefined.
//
// A BeebFSP always includes a volume. wasExplicitVolume indicates whether the
// ::VOLUME syntax was used.
export class BeebFSP {
    public readonly volume: BeebVolume;
    public readonly wasExplicitVolume: boolean;
    public readonly drive: string | undefined;
    public readonly dir: string | undefined;
    public readonly name: string | undefined;

    public constructor(volume: BeebVolume, wasExplicitVolume: boolean, drive: string | undefined, dir: string | undefined, name: string | undefined) {
        this.volume = volume;
        this.wasExplicitVolume = wasExplicitVolume;
        this.drive = drive;
        this.dir = dir;
        this.name = name;
    }

    public toString(): string {
        let str = `::${this.volume.name}:${this.getString(this.drive)}.${this.getString(this.dir)}`;

        if (this.name !== undefined) {
            str += `.${this.name}`;
        }

        return str;
    }

    private getString(x: string | undefined): string {
        // 2026 = HORIZONTAL ELLIPSIS
        return x !== undefined ? x : '\u2026';
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// The precise logic for this stuff eludes me, so I just threw together this
// mishmash of nonsense that kind of does roughly the same thing as the DFS.

//const gParseLog = new utils.Log('PARSE', process.stderr, true);

export class CommandLine {
    public readonly parts: string[];
    private part: string | undefined;
    private partOffset: number | undefined;
    private y: number;

    public constructor(str: string) {
        let i = 0;
        let quotes = false;
        let mask = 0;

        this.parts = [];
        this.y = -1;

        while (i < str.length) {
            const offset = i;

            if (str[i] === '|') {
                this.gotChar(offset);
                ++i;
                if (i >= str.length) {
                    BeebFS.throwError(ErrorCode.BadString);
                }

                let ch: number | undefined;
                if (str[i] === '!') {
                    ++i;
                    mask = 0x80;
                } else {
                    ch = str.charCodeAt(i);
                    ++i;

                    if (ch < 32) {
                        BeebFS.throwError(ErrorCode.BadString);
                    } else if (ch === 0x3f) {
                        ch = 0x7f;//"|?"
                    } else if (ch >= 0x40 && ch <= 0x5f || ch >= 0x61 && ch <= 0x7b || ch === 0x7d || ch === 0x7e) {
                        ch &= 0x1f;
                    } else if (ch === 0x60) {
                        ch = 31;
                    } else if (ch >= 0x80) {
                        ch ^= 0x20;
                    } else {
                        // ch >= 32 && ch < 0x3f || ch === 0x7c ("|") || ch == 0x7f - pass through
                    }
                }

                if (ch !== undefined) {
                    this.addToPart(offset, String.fromCharCode(ch | mask));
                    mask = 0;
                }
            } else {
                let ch = str.charCodeAt(i);
                ch |= mask;
                mask = 0;

                if (ch === '"'.charCodeAt(0)) {
                    ++i;
                    if (quotes) {
                        if (i < str.length && str[i + 1] === '"') {
                            this.addToPart(offset, '"');
                            ++i;
                        } else {
                            quotes = false;
                            this.addPart();
                        }
                    } else {
                        this.addPart();
                        quotes = true;
                        this.gotChar(offset);
                    }
                } else if (ch === 32) {
                    ++i;
                    if (quotes) {
                        this.addToPart(offset, ' ');
                    } else {
                        this.addPart();
                    }
                } else {
                    ++i;
                    this.addToPart(offset, String.fromCharCode(ch));
                }
            }
        }

        if (quotes) {
            BeebFS.throwError(ErrorCode.BadString);
        }

        this.addPart();

        if (this.y < 0) {
            this.y = str.length;
        }
    }

    public getY(): number {
        return this.y;
    }

    private gotChar(offset: number) {
        if (this.partOffset === undefined) {
            this.partOffset = offset;
        }
    }

    private addToPart(offset: number, ch: string) {
        if (this.part === undefined) {
            this.gotChar(offset);
            this.part = '';
        }

        this.part += ch;
    }

    private addPart() {
        if (this.part !== undefined) {
            this.parts.push(this.part);

            if (this.parts.length === 2) {
                this.y = this.partOffset!;
            }

            this.part = undefined;
            this.partOffset = undefined;
        }
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class OSGBPBResult {
    public readonly c: boolean;
    public readonly numBytesLeft: number | undefined;
    public readonly ptr: number | undefined;
    public readonly data: Buffer | undefined;

    public constructor(c: boolean, numBytesLeft: number | undefined, ptr: number | undefined, data: Buffer | undefined) {
        this.c = c;
        this.numBytesLeft = numBytesLeft;
        this.ptr = ptr;
        this.data = data;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class OSFILEResult {
    public readonly fileType: number;
    public readonly block: Buffer | undefined;//if undefined, no change
    public readonly data: Buffer | undefined;
    public readonly dataLoad: number | undefined;

    public constructor(fileType: number, block: Buffer | undefined, data: Buffer | undefined, dataLoad: number | undefined) {
        this.fileType = fileType;
        this.block = block;
        this.data = data;
        this.dataLoad = dataLoad;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class BeebFS {

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static throwError(errorCode: ErrorCode): never {
        let text = errorTexts[errorCode];
        if (text === undefined) {
            text = 'Unknown error: ' + errorCode;
        }

        throw new BeebError(errorCode, text);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Try (if not very hard) to translate POSIX-style Node errors into
    // something that makes more sense for the Beeb.
    public static throwServerError(error: NodeJS.ErrnoException): never {
        if (error.code === 'ENOENT') {
            return BeebFS.throwError(ErrorCode.FileNotFound);
        } else {
            throw new BeebError(ErrorCode.DiscFault, 'POSIX error: ' + error.code);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static isValidDrive(drive: string) {
        return drive.length === 1 && utils.isdigit(drive);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async findAllVolumes(folders: string[], log: utils.Log | undefined): Promise<BeebVolume[]> {
        return await BeebFS.findVolumes('*', folders, log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async findDrivesForVolume(volume: BeebVolume): Promise<BeebDrive[]> {
        let names: string[];
        try {
            names = await utils.fsReaddir(volume.path);
        } catch (error) {
            return BeebFS.throwServerError(error);
        }

        const drives = [];

        for (const name of names) {
            if (BeebFS.isValidDrive(name)) {
                const option = await BeebFS.loadBootOption(volume, name);
                const title = await BeebFS.loadTitle(volume, name);

                drives.push(new BeebDrive(volume, name, option, title));
            }
        }

        return drives;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async loadTitle(volume: BeebVolume, drive: string): Promise<string> {
        const buffer = await utils.tryReadFile(path.join(volume.path, drive, TITLE_FILE_NAME));
        if (buffer === undefined) {
            return DEFAULT_TITLE;
        }

        return BeebFS.getFirstLine(buffer).substr(0, MAX_TITLE_LENGTH);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async loadBootOption(volume: BeebVolume, drive: string): Promise<number> {
        const buffer = await utils.tryReadFile(path.join(volume.path, drive, OPT4_FILE_NAME));
        if (buffer === undefined || buffer.length === 0) {
            return DEFAULT_BOOT_OPTION;
        }

        return buffer[0] & 3;//ugh.
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Find all Beeb files in a drive in a volume.
    public static async getBeebFiles(volume: BeebVolume, drive: string, log: utils.Log | undefined): Promise<BeebFile[]> {
        let hostNames: string[];
        try {
            hostNames = await utils.fsReaddir(path.join(volume.path, drive));
        } catch (error) {
            return [];
        }

        const beebFiles: BeebFile[] = [];

        const infExtRegExp = new RegExp(`\\${INF_EXT}$$`, 'i');

        if (log !== undefined) {
            log.in('getBeebFiles: ');
        }

        if (log !== undefined) {
            log.pn(`path: ${path.join(volume.path, drive)}`);
            log.pn(`.inf regexp: ${infExtRegExp.source}`);
        }

        for (const hostName of hostNames) {
            if (infExtRegExp.exec(hostName) !== null) {
                // skip .inf files.
                continue;
            }

            const hostPath = path.join(volume.path, drive, hostName);

            if (log !== undefined) {
                log.p(`${hostName}: `);
            }

            const hostStat = await utils.tryStat(hostPath);
            if (hostStat === undefined) {
                if (log !== undefined) {
                    log.pn(` - failed to stat`);
                }
                continue;
            }

            const infPath = hostPath + INF_EXT;
            const infBuffer = await utils.tryReadFile(infPath);

            const file = BeebFS.tryCreateBeebFileFromINF(infBuffer, hostPath, volume, drive, hostName, hostStat, log);
            if (file === undefined) {
                if (log !== undefined) {
                    if (infBuffer === undefined) {
                        log.pn(` - invalid name`);
                    } else {
                        log.pn(` - invalid .inf contents`);
                    }
                }
                continue;
            }

            if (log !== undefined) {
                log.pn(`${file}`);
            }

            beebFiles.push(file);
        }

        if (log !== undefined) {
            log.out();
        }

        return beebFiles;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async readFile(file: BeebFile): Promise<Buffer> {
        try {
            return await utils.fsReadFile(file.hostPath);
        } catch (error) {
            return BeebFS.throwServerError(error);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private static getFirstLine(b: Buffer): string {
        let i;

        for (i = 0; i < b.length; ++i) {
            const x = b[i];
            if (x === 10 || x === 13 || x === 26) {
                break;
            }
        }

        return b.toString('binary', 0, i).trim();
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Logging for this probably isn't proving especially useful. Maybe it
    // should go away?
    private static async findVolumes(afsp: string, folders: string[], log: utils.Log | undefined): Promise<BeebVolume[]> {
        const volumes: BeebVolume[] = [];

        const re = utils.getRegExpFromAFSP(afsp);

        const findVolumesMatchingRecursive = async (folderPath: string, indent: string): Promise<void> => {
            if (log !== undefined) {
                log.pn(indent + 'Looking in: ' + folderPath + '...');
            }

            let names: string[];
            try {
                names = await utils.fsReaddir(folderPath);
            } catch (error) {
                process.stderr.write('WARNING: failed to read files in folder: ' + folderPath + '\n');
                if (log !== undefined) {
                    log.pn('Error was: ' + error);
                }
                return;
            }

            const subfolderPaths: string[] = [];

            for (const name of names) {
                if (name[0] === '.') {
                    continue;
                }

                const fullName = path.join(folderPath, name);

                const stat = await utils.tryStat(fullName);
                if (stat !== undefined && stat.isDirectory()) {
                    const stat0 = await utils.tryStat(path.join(fullName, '0'));
                    if (stat0 === undefined) {
                        // obviously not a BeebLink volume, so save for later.
                        subfolderPaths.push(fullName);
                    } else if (stat0.isDirectory()) {
                        let volumeName: string;
                        const buffer = await utils.tryReadFile(path.join(fullName, VOLUME_FILE_NAME));
                        if (buffer !== undefined) {
                            volumeName = BeebFS.getFirstLine(buffer);
                        } else {
                            volumeName = name;
                        }

                        if (BeebFS.isValidVolumeName(volumeName)) {
                            const volume = new BeebVolume(fullName, volumeName, BeebVolumeType.DFS, false);
                            if (log !== undefined) {
                                log.pn('Found volume ' + volume.path + ': ' + volume.name);
                            }

                            if (re.exec(volume.name) !== null) {
                                volumes.push(volume);
                            }
                        }
                    }
                }
            }

            for (const subfolderPath of subfolderPaths) {
                await findVolumesMatchingRecursive(subfolderPath, indent + '    ');
            }
        };

        for (const folder of folders) {
            await findVolumesMatchingRecursive(folder, '');
        }

        return volumes;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Valid volume names are 7-bit ASCII, no spaces. If you want £, use `.
    private static isValidVolumeName(name: string): boolean {
        // Ignore empty string, as might be found in a .volume file.
        if (name.length === 0) {
            return false;
        }

        // Ignore dot folders.
        if (name[0] === '.') {
            return false;
        }

        for (let i = 0; i < name.length; ++i) {
            const c = name.charCodeAt(i);

            if (!(c >= 33 && c < 127)) {
                return false;
            }
        }

        return true;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private static isValidFileNameChar(char: string) {
        const c = char.charCodeAt(0);
        return c >= 32 && c < 127;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private static tryCreateBeebFileFromINF(infBuffer: Buffer | undefined, hostPath: string, volume: BeebVolume, drive: string, hostName: string, hostStat: fs.Stats, log: utils.Log | undefined): BeebFile | undefined {
        let name;
        let load;
        let exec;
        let attr;
        let text;

        if (infBuffer === undefined || infBuffer.length === 0) {
            name = hostName;
            load = DEFAULT_LOAD;
            exec = DEFAULT_EXEC;
            attr = DEFAULT_ATTR;
            text = name[0] === '!';
        } else {
            const infString = BeebFS.getFirstLine(infBuffer);

            if (log !== undefined) {
                log.p(' - ``' + infString + '\'\'');
            }

            const infParts = infString.split(new RegExp('\\s+'));
            if (infParts.length < 3) {
                return undefined;
            }

            let i = 0;

            name = infParts[i++];

            load = BeebFS.tryGetINFAddress(infParts[i++]);
            if (load === undefined) {
                return undefined;
            }

            exec = BeebFS.tryGetINFAddress(infParts[i++]);
            if (exec === undefined) {
                return undefined;
            }

            attr = 0;
            if (i < infParts.length) {
                if (infParts[i].startsWith('CRC=')) {
                    // Ignore the CRC entry.
                } else if (infParts[i] === 'L' || infParts[i] === 'l') {
                    attr = LOCKED_ATTR;
                } else {
                    attr = Number('0x' + infParts[i]);
                    if (Number.isNaN(attr)) {
                        return undefined;
                    }
                }

                ++i;
            }

            text = false;
        }

        if (name.length < 2 || name[1] !== '.') {
            return undefined;
        }

        const dir = name[0];
        name = name.slice(2);

        if (name.length > MAX_NAME_LENGTH) {
            return undefined;
        }

        return new BeebFile(hostPath, new BeebFQN(volume, drive, dir, name), load, exec, hostStat.size, attr, text);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private static tryGetINFAddress(addressString: string): number | undefined {
        let address = Number('0x' + addressString);
        if (Number.isNaN(address)) {
            return undefined;
        }

        // Try to work around 6-digit DFS addresses.
        if (addressString.length === 6) {
            if ((address & 0xff0000) === 0xff0000) {
                // Javascript bitwise operators work with 32-bit signed values,
                // so |=0xff000000 makes a negative mess.
                address += 0xff000000;
            }
        }

        return address;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private folders: Array<string>;

    private currentVolume: BeebVolume | undefined;

    private firstFileHandle: number;
    private openFiles: (OpenFile | undefined)[];

    private log: utils.Log;

    private drive!: string;
    private dir!: string;
    private libDrive!: string;
    private libDir!: string;
    private gaManipulator: gitattributes.Manipulator | undefined;

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public constructor(logPrefix: string | undefined, folders: string[], colours: Chalk | undefined, gaManipulator: gitattributes.Manipulator | undefined) {
        this.log = new utils.Log(logPrefix !== undefined ? logPrefix : '', process.stdout, logPrefix !== undefined);
        this.log.colours = colours;

        this.folders = folders.slice();

        this.resetDirs();

        this.openFiles = [];
        this.firstFileHandle = DEFAULT_FIRST_FILE_HANDLE;
        for (let i = 0; i < DEFAULT_NUM_FILE_HANDLES; ++i) {
            this.openFiles.push(undefined);
        }

        this.gaManipulator = gaManipulator;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseDirString(dirString: string): Promise<BeebFSP> {
        return await this.parseFileOrDirString(dirString, true);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseFileString(fileString: string): Promise<BeebFSP> {
        return await this.parseFileOrDirString(fileString, false);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async mount(volume: BeebVolume): Promise<void> {
        if (this.gaManipulator !== undefined) {
            const drives = await BeebFS.findDrivesForVolume(volume);
            for (const drive of drives) {
                this.gaManipulator.makeFolderNotText(path.join(volume.path, drive.name));
            }
        }

        this.currentVolume = volume;

        this.resetDirs();
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Reset dirs and close open files.
    public async reset() {
        this.resetDirs();

        await this.OSFINDClose(0);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getVolume() {
        if (this.currentVolume === undefined) {
            throw new BeebError(ErrorCode.DiscFault, 'No volume');
        }

        return this.currentVolume;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getDrive(): string {
        return this.drive;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public setDrive(drive: string) {
        this.drive = this.setDriveInternal(drive);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getDir(): string {
        return this.dir;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public setDir(dir: string) {
        this.dir = this.setDirInternal(dir);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getLibDrive(): string {
        return this.libDrive;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public setLibDrive(drive: string) {
        this.libDrive = this.setDriveInternal(drive);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getLibDir(): string {
        return this.libDir;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public setLibDir(dir: string) {
        this.libDir = this.setDirInternal(dir);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async findDrives(): Promise<BeebDrive[]> {
        return await BeebFS.findDrivesForVolume(this.getVolume());
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async findVolumesMatching(afsp: string): Promise<BeebVolume[]> {
        return await BeebFS.findVolumes(afsp, this.folders, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async createVolume(name: string): Promise<BeebVolume> {
        if (!BeebFS.isValidVolumeName(name)) {
            BeebFS.throwError(ErrorCode.BadName);
        }

        // This check is a bit crude, but should catch obvious problems...
        const volumePath = path.join(this.folders[0], name);
        try {
            const stat0 = await utils.fsStat(path.join(volumePath, '0'));
            if (stat0.isDirectory()) {
                BeebFS.throwError(ErrorCode.Exists);
            }
        } catch (error) {
            // ...
        }

        try {
            await utils.fsMkdir(volumePath);
        } catch (error) {
            if (error.code !== 'EEXIST') {
                BeebFS.throwServerError(error);
            }
        }

        try {
            await utils.fsMkdir(path.join(volumePath, '0'));
        } catch (error) {
            BeebFS.throwServerError(error);
        }

        const newVolume = new BeebVolume(volumePath, name, BeebVolumeType.DFS, false);
        return newVolume;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseDirStringWithDefaults(dirString: string): Promise<BeebFSP> {
        const fsp = await this.parseDirString(dirString);

        // if (fsp.volumeName !== undefined) {
        //     // this is for *LIB and *DIR. Current volume only!
        //     BeebFS.throwError(ErrorCode.BadDir);
        // }

        if (fsp.drive !== undefined && fsp.dir !== undefined) {
            return fsp;
        } else {
            return new BeebFSP(
                fsp.volume,
                fsp.wasExplicitVolume,
                fsp.drive !== undefined ? fsp.drive : this.drive,
                fsp.dir !== undefined ? fsp.dir : this.dir,
                fsp.name);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseFQN(fileString: string): Promise<BeebFQN> {
        this.log.pn('parseFQN: ``' + fileString + '\'\'');

        const fsp = await this.parseFileString(fileString);
        this.log.pn('    fsp: ' + fsp);

        if (fsp.name === undefined) {
            return BeebFS.throwError(ErrorCode.BadName);
        }

        const fqn = new BeebFQN(fsp.volume, fsp.drive !== undefined ? fsp.drive : this.drive, fsp.dir !== undefined ? fsp.dir : this.dir, fsp.name);
        this.log.pn('    fqn: ' + fqn);
        return fqn;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getOpenFilesOutput(): string {
        let text = '';
        let anyOpen = false;

        for (let i = 0; i < this.openFiles.length; ++i) {
            const openFile = this.openFiles[i];
            if (openFile === undefined) {
                continue;
            }

            anyOpen = true;

            text += '&' + utils.hex2(this.firstFileHandle + i).toUpperCase() + ": ";

            if (openFile.read) {
                if (openFile.write) {
                    text += 'up';
                } else {
                    text += 'in';
                }
            } else {
                text += 'out';
            }

            text += ' PTR#=&' + utils.hex8(openFile.ptr) + ' EXT#=&' + utils.hex8(openFile.contents.length) + ' - ' + openFile.hostPath + BNL;
        }

        if (!anyOpen) {
            text += 'No files open.' + BNL;
        }

        return text;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getCAT(commandLine: string | undefined): Promise<string> {
        this.log.pn('*CAT: ``' + commandLine + '\'\'');

        let drive: string;
        let volume: BeebVolume;

        if (commandLine === undefined) {
            drive = this.drive;
            volume = this.getVolume();
        } else if (BeebFS.isValidDrive(commandLine)) {
            drive = commandLine;
            volume = this.getVolume();
        } else {
            const fsp = await this.parseFileString(commandLine);

            if (fsp.drive === undefined || fsp.dir !== undefined || fsp.name !== undefined) {
                return BeebFS.throwError(ErrorCode.BadDrive);
            }

            // "*CAT :<drive>" or "*CAT ::<volume>:<drive>"
            volume = fsp.volume;
            drive = fsp.drive;
        }


        let text = '';

        const title = await BeebFS.loadTitle(volume, drive);
        if (title !== '') {
            text += title + BNL;
        }

        text += 'Volume: ' + volume.name + BNL;

        const boot = await BeebFS.loadBootOption(volume, drive);
        text += ('Drive ' + drive + ' (' + boot + ' - ' + BOOT_OPTION_DESCRIPTIONS[boot] + ')').padEnd(20);

        text += ('Dir :' + this.drive + '.' + this.dir).padEnd(10);

        text += 'Lib :' + this.libDrive + '.' + this.libDir;

        text += BNL + BNL;

        const beebFiles = await BeebFS.getBeebFiles(volume, drive, this.log);

        beebFiles.sort((a, b) => {
            if (a.name.dir === this.dir && b.name.dir !== this.dir) {
                return -1;
            } else if (a.name.dir !== this.dir && b.name.dir === this.dir) {
                return 1;
            } else {
                const cmpDirs = utils.stricmp(a.name.dir, b.name.dir);
                if (cmpDirs !== 0) {
                    return cmpDirs;
                }

                return utils.stricmp(a.name.name, b.name.name);
            }
        });

        for (const beebFile of beebFiles) {
            let name: string;
            if (beebFile.name.dir === this.dir) {
                name = '  ' + beebFile.name.name;
            } else {
                name = beebFile.name.dir + '.' + beebFile.name.name;
            }

            if (beebFile.isLocked()) {
                name = name.padEnd(11) + 'L';
            }

            text += ('  ' + name).padEnd(20);
        }

        text += BNL;

        this.log.withIndent('*CAT output: ', () => this.log.bpn(text));

        return text;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public eof(handle: number): boolean {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        return openFile.ptr >= openFile.contents.length;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public OSBGET(handle: number): number | undefined {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        if (openFile.ptr < openFile.contents.length) {
            return openFile.contents[openFile.ptr++];
        } else {
            if (openFile.eofError) {
                return BeebFS.throwError(ErrorCode.EOF);
            } else {
                openFile.eofError = true;
                return undefined;
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public OSBPUT(handle: number, byte: number): void {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        this.mustBeOpenForWrite(openFile);

        this.bputInternal(openFile, byte);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async OSARGS(a: number, handle: number, value: number): Promise<number> {
        if (a === 0) {
            return this.OSARGSGetPtr(handle);
        } else if (a === 1) {
            this.OSARGSSetPtr(handle, value);
            return value;
        } else if (a === 2) {
            return this.OSARGSGetSize(handle);
        } else if (a === 3) {
            this.OSARGSSetSize(handle, value);
            return value;
        } else if (a === 255) {
            await this.OSARGSFlush(handle);
            return value;
        } else {
            return value;
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // The OSFILE file name is not actually a file name, but a command line
    // string, the first arg of which is the file name. (When doing a *LOAD or
    // *SAVE, for example, the OS just hands the whole command line to OSFILE.)
    public async OSFILE(a: number, nameString: string, block: Buffer, data: Buffer): Promise<OSFILEResult> {
        const commandLine = new CommandLine(nameString);
        if (commandLine.parts.length === 0) {
            BeebFS.throwError(ErrorCode.BadName);
        }

        const fqn = await this.parseFQN(commandLine.parts[0]);

        if (a === 0) {
            return await this.OSFILESave(fqn, block.readUInt32LE(0), block.readUInt32LE(4), data);
        } else if (a >= 1 && a <= 4) {
            return await this.OSFILEWriteMetadata(fqn,
                a === 1 || a === 2 ? block.readUInt32LE(0) : undefined,
                a === 1 || a === 3 ? block.readUInt32LE(4) : undefined,
                a === 1 || a === 4 ? block.readUInt32LE(12) : undefined);
        } else if (a === 5) {
            return await this.OSFILEReadMetadata(fqn);
        } else if (a === 6) {
            return await this.OSFILEDelete(fqn);
        } else if (a === 7) {
            return await this.OSFILECreate(fqn, block.readUInt32LE(0), block.readUInt32LE(4), block.readUInt32LE(12) - block.readUInt32LE(8));
        } else if (a === 255) {
            return await this.OSFILELoad(fqn, block.readUInt32LE(0), block.readUInt32LE(4));
        } else {
            throw new BeebError(255, 'Unhandled OSFILE: &' + utils.hex2(a));
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // The OSFIND file name is not actually a file name, but a command line
    // string, the first arg of which is the file name. (When doing a *SRLOAD,
    // for example, the MOS just hands the whole command line to OSFIND.)
    public async OSFINDOpen(mode: number, nameString: string): Promise<number> {
        const commandLine = new CommandLine(nameString);
        if (commandLine.parts.length === 0) {
            BeebFS.throwError(ErrorCode.BadName);
        }

        this.log.pn('OSFIND: mode=$' + utils.hex2(mode) + ' nameString=``' + nameString + '\'\'');

        const index = this.openFiles.indexOf(undefined);
        if (index < 0) {
            return BeebFS.throwError(ErrorCode.TooManyOpen);
        }

        const write = (mode & 0x80) !== 0;
        const read = (mode & 0x40) !== 0;

        const fqn = await this.parseFQN(commandLine.parts[0]);
        let hostPath = this.getHostPath(fqn);

        // Files can be opened once for write, or multiple times for read.
        {
            for (let othIndex = 0; othIndex < this.openFiles.length; ++othIndex) {
                const openFile = this.openFiles[othIndex];
                if (openFile !== undefined) {
                    if (openFile.hostPath === hostPath) {
                        if (openFile.write || write) {
                            this.log.pn(`        already open: handle=0x${this.firstFileHandle + othIndex}`);
                            return BeebFS.throwError(ErrorCode.Open);
                        }
                    }
                }
            }
        }

        let contentsBuffer: Buffer | undefined;
        const file = await this.getBeebFileInternal(fqn, read && !write, false);
        if (file !== undefined) {
            this.log.pn('        hostPath=``' + file.hostPath + '\'\'');
            this.log.pn('        text=' + file.text);

            // File exists.
            hostPath = file.hostPath;

            if (write) {
                this.mustBeWriteableVolume(fqn.volume);
                this.mustBeWriteableFile(file);
            }

            if (write && !read) {
                // OPENOUT of file that exists. Zap the contents first.
                try {
                    await utils.fsTruncate(file.hostPath);
                } catch (error) {
                    return BeebFS.throwServerError(error as NodeJS.ErrnoException);
                }
            }

            if (file.text) {
                // Not efficient, but I don't think it matters...
                const lines = await this.readTextFile(file);

                let linesString = '';
                for (const line of lines) {
                    linesString += line + '\x0d';
                }

                contentsBuffer = Buffer.from(linesString, 'binary');
            } else {
                contentsBuffer = await BeebFS.readFile(file);
            }
        } else {
            // File doesn't exist.
            if (read) {
                // OPENIN or OPENUP of nonexistent file.
                return 0;
            }

            await this.mustNotExist(hostPath);

            // Create file.
            await this.OSFILECreate(fqn, 0, 0, 0);
        }

        const contents: number[] = [];
        if (contentsBuffer !== undefined) {
            for (const byte of contentsBuffer) {
                contents.push(byte);
            }
        }

        this.openFiles[index] = new OpenFile(hostPath, fqn, read, write, contents);
        const handle = this.firstFileHandle + index;
        this.log.pn(`        handle=0x${handle}`);
        return handle;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async OSFINDClose(handle: number): Promise<void> {
        if (handle === 0) {
            await this.closeAllFiles();
        } else if (handle >= this.firstFileHandle && handle < this.firstFileHandle + this.openFiles.length) {
            const index = handle - this.firstFileHandle;
            if (this.openFiles[index] === undefined) {
                BeebFS.throwError(ErrorCode.Channel);
            }

            await this.closeByIndex(index);
        } else {
            BeebFS.throwError(ErrorCode.Channel);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async OSGBPB(a: number, handle: number, numBytes: number, newPtr: number, data: Buffer): Promise<OSGBPBResult> {
        if (a === 1 || a === 2) {
            return this.OSGBPBWrite(a === 1, handle, numBytes, newPtr, data);
        } else if (a === 3 || a === 4) {
            return this.OSGBPBRead(a === 3, handle, numBytes, newPtr);
        } else if (a === 5) {
            return await this.OSGBPBGetTitleAndBootOption();
        } else if (a === 6) {
            return this.OSGBPBReadDevice(this.drive, this.dir);
        } else if (a === 7) {
            return this.OSGBPBReadDevice(this.libDrive, this.libDir);
        } else if (a === 8) {
            return await this.OSGBPBReadNames(numBytes, newPtr);
        } else {
            return new OSGBPBResult(true, numBytes, newPtr, undefined);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // this follows what MOS 3.20 *TYPE does: any of CR, LF, CRLF or LFCR is a
    // new line. See routine at $8f14 (part of *TYPE).

    public async readTextFile(file: BeebFile): Promise<string[]> {
        const b = await BeebFS.readFile(file);

        return utils.splitTextFileLines(b, 'binary');
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // get BeebFile matching FQN, or throw a NotFound. If FQN has wildcards,
    // that's fine, but it's a BadName/'Ambiguous name' if multiple files are
    // matched.
    public async getExistingBeebFileForRead(fqn: BeebFQN): Promise<BeebFile> {
        return (await this.getBeebFileInternal(fqn, true, true))!;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Get list of BeebFile(s) matching FQN.
    public async getBeebFilesForAFSP(afsp: BeebFQN): Promise<BeebFile[]> {
        this.log.pn('getBeebFilesForAFSP: ' + afsp);

        let files = await BeebFS.getBeebFiles(afsp.volume, afsp.drive, this.log);

        const dirRegExp = utils.getRegExpFromAFSP(afsp.dir);
        const nameRegExp = utils.getRegExpFromAFSP(afsp.name);

        this.log.pn('    dirRegExp: ``' + dirRegExp.source + '\'\'');
        this.log.pn('    nameRegExp: ``' + nameRegExp.source + '\'\'');

        files = files.filter((file) => dirRegExp.exec(file.name.dir) !== null && nameRegExp.exec(file.name.name) !== null);

        this.log.pn('    matched: ' + files.length + ' file(s)');

        return files;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async OPT(x: number, y: number): Promise<void> {
        if (x === 4) {
            await this.saveBootOption(this.drive, y & 3);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async setTitle(drive: string, title: string): Promise<void> {
        const volume = this.getVolume();

        this.mustBeWriteableVolume(volume);

        const buffer = Buffer.from(title.substr(0, MAX_TITLE_LENGTH) + os.EOL, 'binary');
        await this.writeHostFile(path.join(volume.path, drive, TITLE_FILE_NAME), buffer);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async saveBootOption(drive: string, option: number): Promise<void> {
        const volume = this.getVolume();

        this.mustBeWriteableVolume(volume);

        const str = (option & 3).toString() + os.EOL;
        await this.writeHostFile(path.join(volume.path, drive, OPT4_FILE_NAME), Buffer.from(str, 'binary'));
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async writeMetadata(hostPath: string, fqn: BeebFQN, load: number, exec: number, attr: number): Promise<void> {
        let inf = fqn.dir + '.' + fqn.name + ' ' + load.toString(16) + ' ' + exec.toString(16);
        if ((attr & LOCKED_ATTR) !== 0) {
            inf += ' L';
        }
        inf += os.EOL;//stop git moaning.

        await this.writeHostFile(hostPath + INF_EXT, Buffer.from(inf, 'binary'));
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getModifiedAttributes(attributeString: string | undefined, oldAttr: number): number {
        if (attributeString === undefined) {
            return 0;
        } else if (attributeString.toUpperCase() === 'L') {
            return LOCKED_ATTR;
        } else {
            return BeebFS.throwError(ErrorCode.BadAttribute);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async delete(fqn: BeebFQN): Promise<void> {
        const file = (await this.getBeebFileInternal(fqn, false, true))!;

        await this.deleteFile(file);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async rename(oldFQN: BeebFQN, newFQN: BeebFQN): Promise<void> {
        this.log.pn('oldFQN: ' + oldFQN);
        this.log.pn('newFQN: ' + newFQN);

        if (!oldFQN.volume.equals(newFQN.volume)) {
            BeebFS.throwError(ErrorCode.BadDrive);
        }

        if (oldFQN.drive !== newFQN.drive) {
            BeebFS.throwError(ErrorCode.BadDrive);//not my rules
        }

        if (await this.getBeebFileInternal(newFQN, false, false) !== undefined) {
            BeebFS.throwError(ErrorCode.Exists);
        }

        const oldFile = (await this.getBeebFileInternal(oldFQN, false, true))!;

        const newHostPath = this.getHostPath(newFQN);
        await this.mustNotExist(newHostPath);

        const newFile = new BeebFile(newHostPath, newFQN, oldFile.load, oldFile.exec, oldFile.size, oldFile.attr, false);

        await this.writeMetadata(newFile.hostPath, newFile.name, newFile.load, newFile.exec, newFile.attr);

        try {
            await utils.fsRename(oldFile.hostPath, newFile.hostPath);
        } catch (error) {
            return BeebFS.throwServerError(error);
        }

        await utils.forceFsUnlink(oldFile.hostPath + INF_EXT);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getFileForRUN(fsp: BeebFSP, tryLibDir: boolean): Promise<BeebFile> {
        if (fsp.name === undefined) {
            return BeebFS.throwError(ErrorCode.BadName);
        }

        // Don't try lib dir if the file name looks at all explicit.
        if (fsp.wasExplicitVolume || fsp.drive !== undefined || fsp.dir !== undefined) {
            tryLibDir = false;
            this.log.pn('Volume/drive/dir provided - don\'t try lib dir.');
        }

        const curFQN = new BeebFQN(fsp.volume, fsp.drive !== undefined ? fsp.drive : this.drive, fsp.dir !== undefined ? fsp.dir : this.dir, fsp.name);
        this.log.pn('Trying in current dir: ``' + curFQN + '\'\'');

        const curFile = await this.getBeebFileInternal(curFQN, true, false);
        if (curFile !== undefined) {
            return curFile;
        }

        if (tryLibDir) {
            // (fsp.volume will be the current volume - if fsp.wasExplicitVolume,
            // tryLibDir is false.)
            const libFQN = new BeebFQN(fsp.volume, fsp.drive !== undefined ? fsp.drive : this.libDrive, fsp.dir !== undefined ? fsp.dir : this.libDir, fsp.name);
            this.log.pn('Trying in library dir: ``' + libFQN + '\'\'');

            const libFile = await this.getBeebFileInternal(libFQN, true, false);
            if (libFile !== undefined) {
                return libFile;
            }
        }

        return BeebFS.throwError(ErrorCode.BadCommand);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async setFileHandleRange(firstFileHandle: number, numFileHandles: number): Promise<void> {
        this.log.pn(`Set file handle range: first handle = 0x${utils.hex2(firstFileHandle)}, num handles = ${numFileHandles}`);

        if (firstFileHandle <= 0 || numFileHandles < 1 || firstFileHandle + numFileHandles > 256) {
            this.log.pn(`Ignoring invalid settings.`);
        } else {
            if (firstFileHandle !== this.firstFileHandle || numFileHandles !== this.openFiles.length) {
                this.log.pn(`Settings have changed - closing any open files.`);
                try {
                    await this.closeAllFiles();
                } catch (error) {
                    this.log.pn(`Ignoring closeAllFiles error: ${error}`);
                }

                this.firstFileHandle = firstFileHandle;

                this.openFiles = [];
                for (let i = 0; i < numFileHandles; ++i) {
                    this.openFiles.push(undefined);
                }
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private setDriveInternal(drive: string): string {
        if (drive < '0' || drive > '9') {
            BeebFS.throwError(ErrorCode.BadDrive);
        }

        return drive;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private setDirInternal(dir: string): string {
        if (dir.length !== 1 || !BeebFS.isValidFileNameChar(dir)) {
            BeebFS.throwError(ErrorCode.BadDir);
        }

        return dir;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private getHostChars(str: string): string {
        let result = '';

        for (let i = 0; i < str.length; ++i) {
            const c = str.charCodeAt(i);
            if (c < 0 || c >= HOST_NAME_CHARS.length) {
                // Answers on postcard please.
                result += '_';
            } else {
                result += HOST_NAME_CHARS[c];
            }
        }

        return result;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private getHostPath(fqn: BeebFQN): string {
        const volume = this.getVolume();

        return path.join(volume.path, fqn.drive, this.getHostChars(fqn.dir) + '.' + this.getHostChars(fqn.name));
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Retrieve BeebFile for one file.
    //
    // If wildcardsOK, wild cards will be handled: the result is the uniquely
    // matching BeebFile, or a BadName/'Ambiguous name' error is thrown; if
    // throwIfNotFound, when not found, a FileNotFound error will be thrown.
    private async getBeebFileInternal(fqn: BeebFQN, wildcardsOK: boolean, throwIfNotFound: boolean): Promise<BeebFile | undefined> {
        if (!wildcardsOK) {
            if (fqn.dir === utils.MATCH_N_CHAR || fqn.dir === utils.MATCH_ONE_CHAR) {
                return BeebFS.throwError(ErrorCode.BadName);
            }

            for (const c of fqn.name) {
                if (c === utils.MATCH_N_CHAR || c === utils.MATCH_ONE_CHAR) {
                    return BeebFS.throwError(ErrorCode.BadName);
                }
            }
        }

        const files = await this.getBeebFilesForAFSP(fqn);

        if (files.length === 0) {
            if (throwIfNotFound) {
                return BeebFS.throwError(ErrorCode.FileNotFound);
            } else {
                return undefined;
            }
        } else if (files.length === 1) {
            return files[0];
        } else {
            throw new BeebError(ErrorCode.BadName, 'Ambiguous name');
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private createOSFILEBlock(load: number, exec: number, size: number, attr: number): Buffer {
        const b = Buffer.alloc(16);

        b.writeUInt32LE(load, 0);
        b.writeUInt32LE(exec, 4);
        b.writeUInt32LE(size, 8);
        b.writeUInt32LE(attr, 12);

        return b;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILELoad(fqn: BeebFQN, load: number, exec: number): Promise<OSFILEResult> {
        const file = await this.getExistingBeebFileForRead(fqn);

        this.mustNotBeOpen(file);

        const data = await BeebFS.readFile(file);

        this.mustNotBeTooBig(data.length);

        let dataLoadAddress;
        if ((exec & 0xff) === 0) {
            dataLoadAddress = load;
        } else {
            dataLoadAddress = file.load;

            if (file.load === SHOULDNT_LOAD) {
                BeebFS.throwError(ErrorCode.Wont);
            }
        }

        return new OSFILEResult(1, this.createOSFILEBlock(file.load, file.exec, file.size, file.attr), data, dataLoadAddress);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILESave(fqn: BeebFQN, load: number, exec: number, data: Buffer): Promise<OSFILEResult> {
        this.mustBeWriteableVolume(fqn.volume);
        this.mustNotBeTooBig(data.length);

        let hostPath: string;

        const file = await this.getBeebFileInternal(fqn, false, false);
        if (file !== undefined) {
            this.mustNotBeOpen(file);
            this.mustBeWriteableFile(file);

            hostPath = file.hostPath;
        } else {
            hostPath = this.getHostPath(fqn);

            await this.mustNotExist(hostPath);
        }

        const attr = DEFAULT_ATTR;
        await this.writeMetadata(hostPath, fqn, load, exec, attr);
        await this.writeBeebFile(hostPath, data);

        return new OSFILEResult(1, this.createOSFILEBlock(load, exec, data.length, attr), undefined, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEWriteMetadata(
        fqn: BeebFQN,
        load: number | undefined,
        exec: number | undefined,
        attr: number | undefined): Promise<OSFILEResult> {
        this.mustBeWriteableVolume(fqn.volume);

        const file = await this.getBeebFileInternal(fqn, false, false);
        if (file === undefined) {
            return new OSFILEResult(0, undefined, undefined, undefined);
        }

        if (load === undefined) {
            load = file.load;
        }

        if (exec === undefined) {
            exec = file.exec;
        }

        if (attr === undefined) {
            attr = file.attr;
        }

        await this.writeMetadata(file.hostPath, file.name, load, exec, attr);

        return new OSFILEResult(1, this.createOSFILEBlock(load, exec, file.size, attr), undefined, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEReadMetadata(fqn: BeebFQN): Promise<OSFILEResult> {
        const file = await this.getBeebFileInternal(fqn, true, false);
        if (file === undefined) {
            return new OSFILEResult(0, undefined, undefined, undefined);
        } else {
            return new OSFILEResult(1, this.createOSFILEBlock(file.load, file.exec, file.size, file.attr), undefined, undefined);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEDelete(fqn: BeebFQN): Promise<OSFILEResult> {
        const file = await this.getBeebFileInternal(fqn, true, false);
        if (file === undefined) {
            return new OSFILEResult(0, undefined, undefined, undefined);
        } else {
            await this.deleteFile(file);

            return new OSFILEResult(1, this.createOSFILEBlock(file.load, file.exec, file.size, file.attr), undefined, undefined);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async deleteFile(file: BeebFile): Promise<void> {
        this.mustBeWriteableVolume(file.name.volume);
        this.mustNotBeOpen(file);
        this.mustBeWriteableFile(file);

        try {
            await utils.forceFsUnlink(file.hostPath + INF_EXT);
            await utils.forceFsUnlink(file.hostPath);
        } catch (error) {
            BeebFS.throwServerError(error as NodeJS.ErrnoException);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILECreate(fqn: BeebFQN, load: number, exec: number, size: number): Promise<OSFILEResult> {
        this.mustBeWriteableVolume(fqn.volume);
        this.mustNotBeTooBig(size);//block.attr - block.size);

        // Cheat.
        return await this.OSFILESave(fqn, load, exec, Buffer.alloc(size));
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // private findOpenFileByName(name: BeebFileName): OpenFile | undefined {
    //     for (const openFile of this.openFiles) {
    //         if (openFile !== undefined) {
    //             if (openFile.name.equals(name)) {
    //                 return openFile;
    //             }
    //         }
    //     }

    //     return undefined;
    // }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Open' error if the file appears to be open.
    private mustNotBeOpen(file: BeebFile) {
        for (const openFile of this.openFiles) {
            if (openFile !== undefined) {
                if (openFile.hostPath === file.hostPath) {
                    BeebFS.throwError(ErrorCode.Open);
                }
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Read only' error if the given file isn't open for write.
    private mustBeOpenForWrite(openFile: OpenFile) {
        if (!openFile.write) {
            BeebFS.throwError(ErrorCode.ReadOnly);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Channel' error if the OpenFile is undefined.
    private mustBeOpen(openFile: OpenFile | undefined): OpenFile {
        if (openFile === undefined) {
            return BeebFS.throwError(ErrorCode.Channel);
        }

        return openFile;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Too big' error if the value is larger than the max file size.
    private mustNotBeTooBig(amount: number) {
        if (amount > MAX_FILE_SIZE) {
            BeebFS.throwError(ErrorCode.TooBig);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Locked' error if the file exists and is locked.
    private mustBeWriteableFile(file: BeebFile | undefined) {
        if (file !== undefined) {
            if (file.isLocked()) {
                BeebFS.throwError(ErrorCode.Locked);
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private mustBeWriteableVolume(volume: BeebVolume): void {
        if (volume.isReadOnly()) {
            BeebFS.throwError(ErrorCode.VolumeReadOnly);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Throws 'No volume', or 'Volume read only', when appropriate.
    // private getWriteableCurrentVolume(): BeebVolume {
    //     let volume = this.getVolume();

    //     if (volume.isReadOnly()) {
    //         BeebFS.throwError(ErrorCode.VolumeReadOnly);
    //     }

    //     return volume;
    // }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Bad drive', 'Bad dir' or 'Bad name' error if the corresponding
    // part of the file spec is missing.
    private mustBeFullyQualified(fsp: BeebFSP): void {
        if (fsp.drive === undefined) {
            return BeebFS.throwError(ErrorCode.BadDrive);
        }

        if (fsp.dir === undefined) {
            return BeebFS.throwError(ErrorCode.BadDir);
        }

        if (fsp.name === undefined) {
            return BeebFS.throwError(ErrorCode.BadName);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Exists on server' error if the given host file or metadata
    // counterpart exists.
    //
    // This is to cater for trying to create a new file that would have the same
    // PC name as an existing file. Could be due to mismatches between BBC names
    // in the .inf files and the actual names on disk, could be due to loose
    // non-BBC files on disk...
    private async mustNotExist(hostPath: string): Promise<void> {
        if (await utils.fsExists(hostPath) || await utils.fsExists(hostPath + INF_EXT)) {
            throw new BeebError(ErrorCode.Exists, 'Exists on server');
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async writeHostFile(hostPath: string, data: Buffer): Promise<void> {
        try {
            await utils.fsMkdirAndWriteFile(hostPath, data);
        } catch (error) {
            return BeebFS.throwServerError(error);
        }

        if (this.gaManipulator !== undefined) {
            this.gaManipulator.makeFolderNotText(path.dirname(hostPath));
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async writeBeebFile(hostPath: string, data: Buffer): Promise<void> {
        await this.writeHostFile(hostPath, data);

        if (this.gaManipulator !== undefined) {
            this.gaManipulator.makeFileBASIC(hostPath, utils.isBASIC(data));
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async closeByIndex(index: number): Promise<void> {
        const openFile = this.openFiles[index];
        this.openFiles[index] = undefined;

        if (openFile === undefined) {
            return;
        }

        await this.flushOpenFile(openFile);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async closeAllFiles(): Promise<void> {
        // Close all.
        let dataLost = false;

        for (let index = 0; index < this.openFiles.length; ++index) {
            try {
                await this.closeByIndex(index);
            } catch (error) {
                if (error instanceof BeebError) {
                    dataLost = true;
                    // but keep going so that all the files get closed.
                } else {
                    throw error;
                }
            }
        }

        if (dataLost) {
            BeebFS.throwError(ErrorCode.DataLost);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private getOpenFileByHandle(handle: number): OpenFile | undefined {
        if (handle >= this.firstFileHandle && handle < this.firstFileHandle + this.openFiles.length) {
            return this.openFiles[handle - this.firstFileHandle];
        } else {
            return undefined;
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async flushOpenFile(openFile: OpenFile): Promise<void> {
        if (openFile.dirty) {
            const data = Buffer.from(openFile.contents);

            await this.writeBeebFile(openFile.hostPath, data);

            openFile.dirty = false;
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private OSARGSGetPtr(handle: number): number {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        return openFile.ptr;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private OSARGSSetPtr(handle: number, ptr: number) {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        if (ptr > openFile.contents.length) {
            this.mustBeOpenForWrite(openFile);

            while (openFile.contents.length < ptr) {
                openFile.contents.push(0);
            }
        }

        openFile.ptr = ptr;
        openFile.eofError = false;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private OSARGSGetSize(handle: number): number {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        return openFile.contents.length;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private OSARGSSetSize(handle: number, size: number): void {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        this.mustBeOpenForWrite(openFile);

        if (size < openFile.contents.length) {
            openFile.contents.splice(size);
        } else {
            while (openFile.contents.length < size) {
                openFile.contents.push(0);
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSARGSFlush(handle: number): Promise<void> {
        if (handle === 0) {
            // Flush all.
            for (const openFile of this.openFiles) {
                if (openFile !== undefined) {
                    try {
                        await this.flushOpenFile(openFile);
                    } catch (error) {
                        // What can you do?
                    }
                }
            }
        } else {
            // Flush one.
            const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

            await this.flushOpenFile(openFile);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private OSGBPBWrite(useNewPtr: boolean, handle: number, numBytes: number, newPtr: number, data: Buffer): OSGBPBResult {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        this.mustBeOpenForWrite(openFile);

        if (useNewPtr) {
            openFile.ptr = newPtr;
        }

        let i = 0;
        while (numBytes > 0 && i < data.length) {
            this.bputInternal(openFile, data[i]);

            ++i;
            --numBytes;
        }

        return new OSGBPBResult(numBytes > 0, numBytes, openFile.ptr, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private OSGBPBRead(useNewPtr: boolean, handle: number, numBytes: number, newPtr: number): OSGBPBResult {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        const ptr = useNewPtr ? newPtr : openFile.ptr;

        let numBytesLeft = 0;
        let eof = false;
        if (ptr + numBytes > openFile.contents.length) {
            eof = true;
            numBytesLeft = ptr + numBytes - openFile.contents.length;
            numBytes = openFile.contents.length - ptr;
        }

        const data = Buffer.alloc(numBytes);
        for (let i = 0; i < data.length; ++i) {
            data[i] = openFile.contents[ptr + i];
        }

        openFile.ptr = ptr + numBytes;

        return new OSGBPBResult(eof, numBytesLeft, openFile.ptr, data);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSGBPBGetTitleAndBootOption(): Promise<OSGBPBResult> {
        const builder = new utils.BufferBuilder();

        builder.writePascalString(await BeebFS.loadTitle(this.getVolume(), this.drive));
        builder.writeUInt8(await BeebFS.loadBootOption(this.getVolume(), this.drive));

        // What are you supposed to return for count and pointer in this case?
        return new OSGBPBResult(false, undefined, undefined, builder.createBuffer());
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private OSGBPBReadDevice(drive: string, dir: string): OSGBPBResult {
        const builder = new utils.BufferBuilder();

        builder.writePascalString(drive);
        builder.writePascalString(dir);

        return new OSGBPBResult(false, undefined, undefined, builder.createBuffer());
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSGBPBReadNames(numBytes: number, newPtr: number): Promise<OSGBPBResult> {
        const builder = new utils.BufferBuilder();

        const files = await this.getBeebFilesForAFSP(new BeebFQN(this.getVolume(), this.drive, this.dir, '*'));

        let fileIdx = newPtr;

        while (numBytes > 0 && fileIdx < files.length) {
            builder.writePascalString(files[fileIdx].name.name);

            --numBytes;
            ++fileIdx;
        }

        return new OSGBPBResult(numBytes > 0, numBytes, fileIdx, builder.createBuffer());
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private bputInternal(openFile: OpenFile, byte: number) {
        if (openFile.ptr >= openFile.contents.length) {
            if (openFile.contents.length >= MAX_FILE_SIZE) {
                BeebFS.throwError(ErrorCode.TooBig);
            }

            openFile.contents.push(byte);
        } else {
            openFile.contents[openFile.ptr] = byte;
        }

        ++openFile.ptr;
        openFile.dirty = true;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private resetDirs() {
        this.setDrive('0');
        this.setDir('$');

        this.setLibDrive('0');
        this.setLibDir('$');
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async parseFileOrDirString(str: string, parseAsDir: boolean): Promise<BeebFSP> {
        if (str === '') {
            BeebFS.throwError(ErrorCode.BadName);
        }

        let i = 0;
        let volume: BeebVolume;
        let wasExplicitVolume: boolean;
        let drive: string | undefined;
        let dir: string | undefined;
        let name: string | undefined;

        // ::x:y.z
        if (str[i] === ':' && str[i + 1] === ':' && str.length > 3) {
            const end = str.indexOf(':', i + 2);
            if (end < 0) {
                // "::fred" or similar.
                BeebFS.throwError(ErrorCode.BadName);
            }

            const volumeName = str.substring(i + 2, end);

            const volumes = await this.findVolumesMatching(volumeName);

            if (volumes.length === 0) {
                throw new BeebError(ErrorCode.FileNotFound, 'Volume not found');
            } else if (volumes.length > 1) {
                throw new BeebError(ErrorCode.BadName, 'Ambiguous volume');
            }

            volume = volumes[0];
            wasExplicitVolume = true;

            i = end;
        } else {
            // This might produce a 'No volume' error, which feels a bit ugly at
            // the parsing step, but I don't think it matters in practice...
            volume = this.getVolume();
            wasExplicitVolume = false;
        }

        if (str[i] === ':' && i + 1 < str.length) {
            if (!BeebFS.isValidDrive(str[i + 1])) {
                BeebFS.throwError(ErrorCode.BadDrive);
            }

            drive = str[i + 1];
            i += 2;

            if (str[i] === '.') {
                ++i;
            }
        }

        if (str[i + 1] === '.') {
            if (!BeebFS.isValidFileNameChar(str[i])) {
                BeebFS.throwError(ErrorCode.BadDir);
            }

            dir = str[i];
            i += 2;
        }

        if (parseAsDir) {
            if (i < str.length && dir !== undefined || i === str.length - 1 && !BeebFS.isValidFileNameChar(str[i])) {
                BeebFS.throwError(ErrorCode.BadDir);
            }

            dir = str[i];
        } else {
            if (i < str.length) {
                for (let j = i; j < str.length; ++j) {
                    if (!BeebFS.isValidFileNameChar(str[j])) {
                        BeebFS.throwError(ErrorCode.BadName);
                    }
                }

                name = str.slice(i);

                if (name.length > MAX_NAME_LENGTH) {
                    BeebFS.throwError(ErrorCode.BadName);
                }
            }
        }

        // Everything is mandatory using the :: syntax.
        if (wasExplicitVolume) {
            if (drive === undefined || name !== undefined && dir === undefined) {
                return BeebFS.throwError(ErrorCode.BadName);
            }
        }

        return new BeebFSP(volume, wasExplicitVolume, drive, dir, name);
    }

    /////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////
}
