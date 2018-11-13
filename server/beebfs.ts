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
import { FIRST_FILE_HANDLE, NUM_FILE_HANDLES } from './beeblink';
import * as utils from './utils';
import { BNL } from './utils';
import { Chalk } from 'chalk';

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
        // may change this policy.
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
    BadName = 204,
    BadDrive = 205,
    BadDir = 206,
    BadAttribute = 207,
    FileNotFound = 214,
    Syntax = 220,//no generic text for this
    Channel = 222,
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
    [ErrorCode.BadString]: 'Bad string',
    [ErrorCode.BadCommand]: 'Bad command',
    [ErrorCode.DataLost]: 'Data lost',
    [ErrorCode.Wont]: 'Won\'t',
};

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Fully-qualified name of a Beeb file that may or may not exist. Drive and dir
// are as supplied on command line, or filled in from defaults, as appropriate.
//
// This was a slightly late addition and isn't used everywhere it should be...
export class BeebFQN {
    public readonly volumePath: string;
    public readonly drive: string;
    public readonly dir: string;
    public readonly name: string;

    public constructor(volumePath: string, drive: string, dir: string, name: string) {
        this.volumePath = volumePath;
        this.drive = drive;
        this.dir = dir;
        this.name = name;
    }

    public toString() {
        return '::' + this.volumePath + ':' + this.drive + '.' + this.dir + '.' + this.name;
    }

    public equals(other: BeebFQN): boolean {
        return this.volumePath === other.volumePath && utils.strieq(this.drive, other.drive) && utils.strieq(this.dir, other.dir) && utils.strieq(this.name, other.name);
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

    public constructor(hostPath: string, name: BeebFQN, load: number, exec: number, size: number, attr: number) {
        this.hostPath = hostPath;
        this.name = name;
        this.load = load;
        this.exec = exec;
        this.size = size;
        this.attr = attr;
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

class BeebDrive {
    public readonly name: string;
    public readonly option: number;
    public readonly title: string;

    public constructor(name: string, option: number, title: string) {
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

// Name of Beeb file or dir, that may or may not exist, as entered on the
// command line. Components not supplied are set to undefined.
export class BeebFSP {
    public readonly volumeName: string | undefined;
    public readonly drive: string | undefined;
    public readonly dir: string | undefined;
    public readonly name: string | undefined;

    public constructor(volumeName: string | undefined, drive: string | undefined, dir: string | undefined, name: string | undefined) {
        this.volumeName = volumeName;
        this.drive = drive;
        this.dir = dir;
        this.name = name;
    }

    public toString(): string {
        let str = '';

        if (this.volumeName !== undefined) {
            str += '::' + this.volumeName;
        }

        str += ':' + this.getString(this.drive);
        str += '.' + this.getString(this.dir);

        if (this.name !== undefined) {
            str += '.' + this.name;
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

    public static parseDirString(dirString: string): BeebFSP {
        return BeebFS.parseFileOrDirString(dirString, true);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static parseFileString(fileString: string): BeebFSP {
        return BeebFS.parseFileOrDirString(fileString, false);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static isValidDrive(drive: string) {
        return drive.length === 1 && utils.isdigit(drive);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async isVolume(volumePath: string): Promise<boolean> {
        if (!BeebFS.isValidVolumeName(path.basename(volumePath))) {
            return false;
        }

        try {
            const stat0 = await utils.fsStat(path.join(volumePath, '0'));
            if (!stat0.isDirectory()) {
                return false;
            }
        } catch (error) {
            // Whatever the problem is, it's not going to get any better.
            return false;
        }

        return true;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async findAllVolumePaths(folders: string[], log: utils.Log): Promise<string[]> {
        return await BeebFS.findVolumePaths('*', folders, log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async findDrivesForVolume(volumePath: string): Promise<BeebDrive[]> {
        let names: string[];
        try {
            names = await utils.fsReaddir(volumePath);
        } catch (error) {
            return BeebFS.throwServerError(error);
        }

        const drives = [];

        for (const name of names) {
            if (BeebFS.isValidDrive(name)) {
                const option = await BeebFS.loadBootOption(volumePath, name);
                const title = await BeebFS.loadTitle(volumePath, name);

                drives.push(new BeebDrive(name, option, title));
            }
        }

        return drives;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async loadTitle(volumePath: string, drive: string): Promise<string> {
        const buffer = await utils.tryReadFile(path.join(volumePath, drive, TITLE_FILE_NAME));
        if (buffer === undefined) {
            return DEFAULT_TITLE;
        }

        return BeebFS.getFirstLine(buffer).substr(0, MAX_TITLE_LENGTH);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async loadBootOption(volumePath: string, drive: string): Promise<number> {
        const buffer = await utils.tryReadFile(path.join(volumePath, drive, OPT4_FILE_NAME));
        if (buffer === undefined || buffer.length === 0) {
            return DEFAULT_BOOT_OPTION;
        }

        return buffer[0] & 3;//ugh.
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

    private static async findVolumePaths(afsp: string, folders: string[], log: utils.Log): Promise<string[]> {
        const volumePaths = [];

        const re = BeebFS.getRegExpFromAFSP(afsp);

        for (const folder of folders) {
            let names: string[];
            try {
                names = await utils.fsReaddir(folder);
            } catch (error) {
                process.stderr.write('WARNING: failed to read files in folder: ' + folder + '\n');
                log.pn('Error was: ' + error);
                continue;
            }

            for (const name of names) {
                if (re.exec(name) !== null) {
                    const volumePath = path.join(folder, name);
                    if (await BeebFS.isVolume(volumePath)) {
                        volumePaths.push(volumePath);
                    }
                }
            }
        }

        return volumePaths;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // The regexp is actually a bit cleverer than the afsp, at least compared to
    // how DFS does it, in that a * will match chars in the middle of a string,
    // not just at the end.
    private static getRegExpFromAFSP(afsp: string): RegExp {
        let r = '^';

        for (const c of afsp) {
            if (c === '*') {
                r += '.*';
            } else if (c === '#') {
                r += '.';
            } else if (utils.isalnum(c)) {
                r += c;
            } else {
                r += '\\' + c;
            }
        }

        r += '$';

        return new RegExp(r, 'i');
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Valid volume names are 7-bit ASCII, no spaces. If you want £, use `.
    private static isValidVolumeName(name: string): boolean {
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

    private static parseFileOrDirString(str: string, parseAsDir: boolean): BeebFSP {
        if (str === '') {
            BeebFS.throwError(ErrorCode.BadName);
        }

        let i = 0;
        let volumeName: string | undefined;
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

            volumeName = str.substring(i + 2, end);

            if (!BeebFS.isValidVolumeName(volumeName)) {
                BeebFS.throwError(ErrorCode.BadName);
            }

            i = end;
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
            if (!this.isValidFileNameChar(str[i])) {
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
        if (volumeName !== undefined) {
            if (drive === undefined || name !== undefined && dir === undefined) {
                return BeebFS.throwError(ErrorCode.BadName);
            }
        }

        return new BeebFSP(volumeName, drive, dir, name);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private folders: Array<string>;

    private volumePath: string;

    private openFiles: (OpenFile | undefined)[];

    private log: utils.Log;

    private drive!: string;
    private dir!: string;
    private libDrive!: string;
    private libDir!: string;

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public constructor(logPrefix: string | undefined, folders: string[], colours: Chalk | undefined) {
        this.log = new utils.Log(logPrefix !== undefined ? logPrefix : '', process.stdout, logPrefix !== undefined);
        this.log.colours = colours;

        this.folders = folders.slice();

        this.resetDirs();

        // TODO: this should ideally always be valid. Fiddle around with the
        // initialisation process so it's impossible to get wrong.
        this.volumePath = '';

        this.openFiles = [];
        for (let i = 0; i < NUM_FILE_HANDLES; ++i) {
            this.openFiles.push(undefined);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Returns string to print on error, or undefined on success (yes this is
    // weird).
    public async mountByName(volumeAFSP: string): Promise<string | undefined> {
        const volumePaths = await this.findPathsOfVolumesMatching(volumeAFSP);

        if (volumePaths.length === 0) {
            return 'No volumes match: ' + volumeAFSP;
        }

        return await this.mountByPath(volumePaths[0]);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async mountByPath(volumePath: string): Promise<string | undefined> {
        if (!await BeebFS.isVolume(volumePath)) {
            return 'Volume not valid: ' + volumePath;
        }

        this.volumePath = volumePath;

        this.resetDirs();

        return undefined;
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

    public getVolumeName() {
        return path.basename(this.volumePath);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getVolumePath() {
        return this.volumePath;
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
        return await BeebFS.findDrivesForVolume(this.volumePath);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async findPathsOfVolumesMatching(afsp: string): Promise<string[]> {
        return await BeebFS.findVolumePaths(afsp, this.folders, this.log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async createVolume(name: string): Promise<string> {
        if (!BeebFS.isValidVolumeName(name)) {
            BeebFS.throwError(ErrorCode.BadName);
        }

        const volumePath = path.join(this.folders[0], name);
        if (await BeebFS.isVolume(volumePath)) {
            BeebFS.throwError(ErrorCode.Exists);
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

        let result = await this.mountByPath(volumePath);
        if (result === undefined) {
            result = 'Created: ' + volumePath;
        }

        return result;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public parseDirStringWithDefaults(dirString: string): BeebFSP {
        const fsp = BeebFS.parseDirString(dirString);

        if (fsp.volumeName !== undefined) {
            // this is for *LIB and *DIR. Current volume only!
            BeebFS.throwError(ErrorCode.BadDir);
        }

        if (fsp.drive !== undefined && fsp.dir !== undefined) {
            return fsp;
        } else {
            return new BeebFSP(
                undefined,
                fsp.drive !== undefined ? fsp.drive : this.drive,
                fsp.dir !== undefined ? fsp.dir : this.dir,
                fsp.name);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseFQN(fileString: string): Promise<BeebFQN> {
        this.log.pn('parseFQN: ``' + fileString + '\'\'');

        const fsp = BeebFS.parseFileString(fileString);
        this.log.pn('    fsp: ' + fsp);

        if (fsp.name === undefined) {
            return BeebFS.throwError(ErrorCode.BadName);
        }

        const volumePath = await this.getVolumePathFromFSP(fsp);

        const fqn = new BeebFQN(volumePath, fsp.drive !== undefined ? fsp.drive : this.drive, fsp.dir !== undefined ? fsp.dir : this.dir, fsp.name);
        this.log.pn('    fqn: ' + fqn);
        return fqn;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getOpenFilesOutput(): string {
        let text = '';
        let anyOpen = false;

        for (let i = 0; i < NUM_FILE_HANDLES; ++i) {
            const openFile = this.openFiles[i];
            if (openFile === undefined) {
                continue;
            }

            anyOpen = true;

            text += '&' + utils.hex2(FIRST_FILE_HANDLE + i).toUpperCase() + ": ";

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
        let volumePath: string;

        if (commandLine === undefined) {
            drive = this.drive;
            volumePath = this.volumePath;
        } else if (BeebFS.isValidDrive(commandLine)) {
            drive = commandLine;
            volumePath = this.volumePath;
        } else {
            const fsp = BeebFS.parseFileString(commandLine);

            if (fsp.drive === undefined || fsp.dir !== undefined || fsp.name !== undefined) {
                return BeebFS.throwError(ErrorCode.BadDrive);
            }

            // "*CAT :<drive>" or "*CAT ::<volume>:<drive>"
            volumePath = await this.getVolumePathFromFSP(fsp);
            drive = fsp.drive;
        }


        let text = '';

        const title = await BeebFS.loadTitle(volumePath, drive);
        if (title !== '') {
            text += title + BNL;
        }

        text += 'Volume: ' + path.basename(volumePath) + BNL;

        const boot = await BeebFS.loadBootOption(volumePath, drive);
        text += ('Drive ' + drive + ' (' + boot + ' - ' + BOOT_OPTION_DESCRIPTIONS[boot] + ')').padEnd(20);

        text += ('Dir :' + this.drive + '.' + this.dir).padEnd(10);

        text += 'Lib :' + this.libDrive + '.' + this.libDir;

        text += BNL + BNL;

        const beebFiles = await this.getBeebFiles(volumePath, drive); path.join(volumePath, drive);

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
                return BeebFS.throwError(ErrorCode.Channel);
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
            for (const openFile of this.openFiles) {
                if (openFile !== undefined) {
                    if (openFile.hostPath === hostPath) {
                        if (openFile.write || write) {
                            return BeebFS.throwError(ErrorCode.Open);
                        }
                    }
                }
            }
        }

        let contentsBuffer: Buffer | undefined;
        const file = await this.tryGetBeebFile(fqn);
        if (file !== undefined) {
            // File exists.
            hostPath = file.hostPath;

            if (write) {
                this.mustBeWriteable(file);
            }

            if (write && !read) {
                // OPENOUT of file that exists. Zap the contents first.
                try {
                    await utils.fsTruncate(file.hostPath);
                } catch (error) {
                    return BeebFS.throwServerError(error as NodeJS.ErrnoException);
                }
            }

            contentsBuffer = await this.readFile(file);
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
        return FIRST_FILE_HANDLE + index;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async OSFINDClose(handle: number): Promise<void> {
        if (handle === 0) {
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
        } else if (handle >= FIRST_FILE_HANDLE && handle < FIRST_FILE_HANDLE + NUM_FILE_HANDLES) {
            const index = handle - FIRST_FILE_HANDLE;
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

    public async readFile(file: BeebFile): Promise<Buffer> {
        try {
            return await utils.fsReadFile(file.hostPath);
        } catch (error) {
            return BeebFS.throwServerError(error);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // this follows what MOS 3.20 *TYPE does: any of CR, LF, CRLF or LFCR is a
    // new line. See routine at $8f14 (part of *TYPE).

    public async readTextFile(file: BeebFile): Promise<string[]> {
        const b = await this.readFile(file);

        return utils.splitTextFileLines(b, 'binary');
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async tryGetBeebFile(fqn: BeebFQN): Promise<BeebFile | undefined> {
        return await this.getBeebFileInternal(fqn, false);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getBeebFile(fqn: BeebFQN): Promise<BeebFile> {
        return (await this.getBeebFileInternal(fqn, true))!;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getBeebFilesForAFSP(afsp: BeebFQN): Promise<BeebFile[]> {
        this.log.pn('getBeebFilesForAFSP: ' + afsp);

        let files = await this.getBeebFiles(this.volumePath, afsp.drive!);

        const dirRegExp = BeebFS.getRegExpFromAFSP(afsp.dir!);
        const nameRegExp = BeebFS.getRegExpFromAFSP(afsp.name!);

        this.log.pn('    dirRegExp: ``' + dirRegExp.source + '\'\'');
        this.log.pn('    nameRegExp: ``' + nameRegExp.source + '\'\'');

        files = files.filter((file) => dirRegExp.exec(file.name.dir) !== null && nameRegExp.exec(file.name.name) !== null);

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
        const buffer = Buffer.from(title.substr(0, MAX_TITLE_LENGTH) + os.EOL, 'binary');
        await this.writeFile(path.join(this.volumePath, drive, TITLE_FILE_NAME), buffer);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async saveBootOption(drive: string, option: number): Promise<void> {
        const str = (option & 3).toString() + os.EOL;
        await this.writeFile(path.join(this.volumePath, drive, OPT4_FILE_NAME), Buffer.from(str, 'binary'));
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async writeMetadata(hostPath: string, fqn: BeebFQN, load: number, exec: number, attr: number): Promise<void> {
        let inf = fqn.dir + '.' + fqn.name + ' ' + load.toString(16) + ' ' + exec.toString(16);
        if ((attr & LOCKED_ATTR) !== 0) {
            inf += ' L';
        }
        inf += os.EOL;//stop git moaning.

        try {
            await utils.fsWriteFile(hostPath + INF_EXT, Buffer.from(inf, 'binary'));
        } catch (error) {
            return BeebFS.throwServerError(error);
        }
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
        const file = await this.getBeebFile(fqn);

        await this.deleteFile(file);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async rename(oldFQN: BeebFQN, newFQN: BeebFQN): Promise<void> {
        this.log.pn('oldFQN: ' + oldFQN);
        this.log.pn('newFQN: ' + newFQN);

        if (oldFQN.volumePath !== newFQN.volumePath) {
            BeebFS.throwError(ErrorCode.BadDrive);
        }

        if (oldFQN.drive !== newFQN.drive) {
            BeebFS.throwError(ErrorCode.BadDrive);//not my rules
        }

        if (await this.tryGetBeebFile(newFQN) !== undefined) {
            BeebFS.throwError(ErrorCode.Exists);
        }

        const oldFile = await this.getBeebFile(oldFQN);

        const newHostPath = this.getHostPath(newFQN);
        await this.mustNotExist(newHostPath);

        const newFile = new BeebFile(newHostPath, newFQN, oldFile.load, oldFile.exec, oldFile.size, oldFile.attr);

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

        if (fsp.drive !== undefined || fsp.dir !== undefined) {
            // Never try lib dir when drive and/or dir are specified.
            tryLibDir = false;
            this.log.pn('Drive and/or dir provided - don\'t try lib dir.');
        }

        const curFQN = new BeebFQN(this.volumePath, fsp.drive !== undefined ? fsp.drive : this.drive, fsp.dir !== undefined ? fsp.dir : this.dir, fsp.name);
        this.log.pn('Trying in current dir: ``' + curFQN + '\'\'');

        const curFile = await this.tryGetBeebFile(curFQN);
        if (curFile !== undefined) {
            return curFile;
        }

        if (tryLibDir) {
            const libFQN = new BeebFQN(this.volumePath, fsp.drive !== undefined ? fsp.drive : this.libDrive, fsp.dir !== undefined ? fsp.dir : this.libDir, fsp.name);
            this.log.pn('Trying in library dir: ``' + libFQN + '\'\'');

            const libFile = await this.tryGetBeebFile(libFQN);
            if (libFile !== undefined) {
                return libFile;
            }
        }

        return BeebFS.throwError(ErrorCode.BadCommand);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async getVolumePathFromFSP(fsp: BeebFSP): Promise<string> {
        if (fsp.volumeName !== undefined) {
            const paths = await this.findPathsOfVolumesMatching(fsp.volumeName);
            if (paths.length !== 1) {
                throw new BeebError(ErrorCode.BadName, 'Ambiguous volume');
            }

            return paths[0];
        } else {
            return this.volumePath;
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private tryGetINFAddress(addressString: string): number | undefined {
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

    private tryCreateBeebFileFromINF(infBuffer: Buffer, hostPath: string, volumePath: string, drive: string, hostName: string, hostStat: fs.Stats): BeebFile | undefined {
        let name;
        let load;
        let exec;
        let attr;

        if (infBuffer.length === 0) {
            name = hostName;
            load = DEFAULT_LOAD;
            exec = DEFAULT_EXEC;
            attr = DEFAULT_ATTR;
        } else {
            const infString = BeebFS.getFirstLine(infBuffer);
            this.log.p(' - ``' + infString + '\'\'');

            const infParts = infString.split(new RegExp('\\s+'));
            if (infParts.length < 3) {
                return undefined;
            }

            let i = 0;

            name = infParts[i++];

            load = this.tryGetINFAddress(infParts[i++]);
            if (load === undefined) {
                return undefined;
            }

            exec = this.tryGetINFAddress(infParts[i++]);
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
        }

        if (name.length < 2 || name[1] !== '.') {
            return undefined;
        }

        const dir = name[0];
        name = name.slice(2);

        if (name.length > MAX_NAME_LENGTH) {
            return undefined;
        }

        return new BeebFile(hostPath, new BeebFQN(volumePath, drive, dir, name), load, exec, hostStat.size, attr);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Find all Beeb files in a drive in a volume.
    private async getBeebFiles(volumePath: string, drive: string): Promise<BeebFile[]> {
        let hostNames: string[];
        try {
            hostNames = await utils.fsReaddir(path.join(volumePath, drive));
        } catch (error) {
            return [];
        }

        const beebFiles: BeebFile[] = [];

        const infExtRegExp = new RegExp('\.inf$', 'i');

        this.log.in('getBeebFiles: ');

        for (const infHostName of hostNames) {
            if (infExtRegExp.exec(infHostName) === null) {
                continue;
            }

            this.log.p(infHostName);

            const hostName = infHostName.substr(0, infHostName.length - 4);
            const hostPath = path.join(volumePath, drive, hostName);
            const hostStat = await utils.tryStat(hostPath);
            if (hostStat === undefined) {
                this.log.pn(' - failed to stat');
                continue;
            }

            const infPath = path.join(volumePath, drive, infHostName);
            const infBuffer = await utils.tryReadFile(infPath);
            if (infBuffer === undefined) {
                this.log.pn(' - failed to load .inf');
                continue;
            }

            const file = this.tryCreateBeebFileFromINF(infBuffer, hostPath, volumePath, drive, hostName, hostStat);
            if (file === undefined) {
                this.log.pn(' - failed to interpret .inf');
                continue;
            }

            this.log.pn(' - ok');

            beebFiles.push(file);
        }

        this.log.out();

        return beebFiles;
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
        return path.join(this.volumePath, fqn.drive, this.getHostChars(fqn.dir) + '.' + this.getHostChars(fqn.name));
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // The lack of mapping from Beeb name to host name makes this a bit
    // inefficient.
    //
    // But this will improve...
    private async getBeebFileInternal(fqn: BeebFQN, throwOnError: boolean): Promise<BeebFile | undefined> {
        const files = await this.getBeebFiles(fqn.volumePath, fqn.drive);

        for (const file of files) {
            if (file.name.equals(fqn)) {
                return file;
            }
        }

        if (throwOnError) {
            return BeebFS.throwError(ErrorCode.FileNotFound);
        } else {
            return undefined;
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
        const file = await this.getBeebFile(fqn);
        this.mustNotBeOpen(file);

        const data = await this.readFile(file);

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

        return new OSFILEResult(1, this.createOSFILEBlock(file.load, file.exec, file.size, file.attr), data!, dataLoadAddress);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILESave(fqn: BeebFQN, load: number, exec: number, data: Buffer): Promise<OSFILEResult> {
        this.mustNotBeTooBig(data.length);

        let hostPath: string;

        const file = await this.tryGetBeebFile(fqn);
        if (file !== undefined) {
            this.mustNotBeOpen(file);
            this.mustBeWriteable(file);

            hostPath = file.hostPath;
        } else {
            hostPath = this.getHostPath(fqn);

            await this.mustNotExist(hostPath);
        }

        await this.writeMetadata(hostPath, fqn, load, exec, DEFAULT_ATTR);
        await this.writeFile(hostPath, data);

        return new OSFILEResult(1, undefined, undefined, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEWriteMetadata(
        fqn: BeebFQN,
        load: number | undefined,
        exec: number | undefined,
        attr: number | undefined): Promise<OSFILEResult> {

        const file = await this.tryGetBeebFile(fqn);
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
        const file = await this.tryGetBeebFile(fqn);
        if (file === undefined) {
            return new OSFILEResult(0, undefined, undefined, undefined);
        } else {
            return new OSFILEResult(1, this.createOSFILEBlock(file.load, file.exec, file.size, file.attr), undefined, undefined);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEDelete(fqn: BeebFQN): Promise<OSFILEResult> {
        const file = await this.tryGetBeebFile(fqn);
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
        this.mustNotBeOpen(file);
        this.mustBeWriteable(file);

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
    private mustBeWriteable(file: BeebFile | undefined) {
        if (file !== undefined) {
            if (file.isLocked()) {
                BeebFS.throwError(ErrorCode.Locked);
            }
        }
    }

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

    private async writeFile(hostPath: string, data: Buffer): Promise<void> {
        try {
            await utils.fsWriteFile(hostPath, data);
        } catch (error) {
            return BeebFS.throwServerError(error);
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

    private getOpenFileByHandle(handle: number): OpenFile | undefined {
        if (handle >= FIRST_FILE_HANDLE && handle < FIRST_FILE_HANDLE + NUM_FILE_HANDLES) {
            return this.openFiles[handle - FIRST_FILE_HANDLE];
        } else {
            return undefined;
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async flushOpenFile(openFile: OpenFile): Promise<void> {
        if (openFile.dirty) {
            const data = Buffer.from(openFile.contents);
            await this.writeFile(openFile.hostPath, data);

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

        builder.writePascalString(await BeebFS.loadTitle(this.volumePath, this.drive));
        builder.writeUInt8(await BeebFS.loadBootOption(this.volumePath, this.drive));

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

        const files = await this.getBeebFilesForAFSP(new BeebFQN(this.volumePath, this.drive, this.dir, '*'));

        let fileIdx = 0;

        while (numBytes > 0 && newPtr < files.length) {
            builder.writePascalString(files[fileIdx].name.name);

            --numBytes;
            ++newPtr;
            ++fileIdx;
        }

        return new OSGBPBResult(numBytes > 0, numBytes, newPtr, builder.createBuffer());
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
    ////////////////////////////////////////////////////////////////////////
}
