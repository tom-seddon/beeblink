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

import * as os from 'os';
import * as path from 'path';
import { DEFAULT_FIRST_FILE_HANDLE, DEFAULT_NUM_FILE_HANDLES } from './beeblink';
import * as utils from './utils';
import { BNL } from './utils';
import { Chalk } from 'chalk';
import * as gitattributes from './gitattributes';
import * as errors from './errors';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

const MAX_NUM_DRIVES = 8;
const MAX_FILE_SIZE = 0xffffff;
const INF_EXT = '.inf';

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

// Fully-qualified name of a Beeb file that may or may not exist. Drive and dir
// are as supplied on command line, or filled in from defaults, as appropriate.
//
// This was a slightly late addition and isn't used everywhere it should be...
export class BeebFQN {
    // Volume this FQN refers to.
    public readonly volume: BeebVolume;

    // FS-specific name portion of this FQN.
    public fsFQN: IFSFQN;

    public constructor(volume: BeebVolume, fsFQN: IFSFQN) {
        this.volume = volume;
        this.fsFQN = fsFQN;
    }

    public toString() {
        return `::${this.volume.name}${this.fsFQN}`;
    }

    public equals(other: BeebFQN): boolean {
        return this.volume.equals(other.volume) && this.fsFQN.equals(other.fsFQN);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

const R_ATTR = 1;
const W_ATTR = 2;
const E_ATTR = 4;
const L_ATTR = 8;

export class BeebFile {
    // Path of this file on the PC filing system.
    public readonly hostPath: string;

    // Actual BBC file name.
    public readonly fqn: BeebFQN;

    // BBC-style attributes.
    public readonly load: number;
    public readonly exec: number;
    public readonly size: number;
    public readonly attr: number;

    // could perhaps be part of the attr field, but I'm a bit reluctant to
    // fiddle around with that.
    public readonly text: boolean;

    public constructor(hostPath: string, fqn: BeebFQN, load: number, exec: number, size: number, attr: number, text: boolean) {
        this.hostPath = hostPath;
        this.fqn = fqn;
        this.load = load;
        this.exec = exec;
        this.size = size;
        this.attr = attr;
        this.text = text;
    }

    public toString(): string {
        return 'BeebFile(hostPath=``' + this.hostPath + '\'\' name=``' + this.fqn + '\'\' load=0x' + utils.hex8(this.load) + ' exec=0x' + utils.hex8(this.exec) + ' size=' + this.size + ' (0x' + this.size.toString(16) + ') attr=0x' + utils.hex8(this.attr);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class OpenFile {
    public readonly hostPath: string;
    public readonly fqn: BeebFQN;
    public readonly read: boolean;
    public readonly write: boolean;
    public ptr: number;
    public eofError: boolean;// http://beebwiki.mdfs.net/OSBGET
    public dirty: boolean;

    // I wasn't going to buffer anything originally, but I quickly found it
    // massively simplifies the error handling.
    public readonly contents: number[];

    public constructor(hostPath: string, fqn: BeebFQN, read: boolean, write: boolean, contents: number[]) {
        this.hostPath = hostPath;
        this.fqn = fqn;
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

export class BeebVolume {
    public readonly path: string;
    public readonly name: string;
    public readonly handler: IFSType;
    private readOnly: boolean;

    public constructor(volumePath: string, name: string, handler: IFSType) {
        this.path = volumePath;
        this.name = name;
        this.handler = handler;
        this.readOnly = false;
    }

    public isReadOnly(): boolean {
        if (!this.handler.canWrite()) {
            return true;
        }

        if (this.readOnly) {
            return true;
        }

        return false;
    }

    public asReadOnly(): BeebVolume {
        const readOnly = new BeebVolume(this.path, this.name, this.handler);

        readOnly.readOnly = true;

        return readOnly;
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
class BeebFSP {
    // Volume this FSP refers to.
    public readonly volume: BeebVolume;

    // set to true if the ::VOLUME syntax was used to specify the volume.
    public readonly wasExplicitVolume: boolean;

    // FS-specific portion of the FSP.
    public readonly name: IFSFSP;

    public constructor(volume: BeebVolume, wasExplicitVolume: boolean, name: IFSFSP) {
        this.volume = volume;
        this.wasExplicitVolume = wasExplicitVolume;
        this.name = name;
    }

    public toString(): string {
        return `::${this.volume.name}${this.name}`;
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
                    return errors.badString();
                }

                let ch: number | undefined;
                if (str[i] === '!') {
                    ++i;
                    mask = 0x80;
                } else {
                    ch = str.charCodeAt(i);
                    ++i;

                    if (ch < 32) {
                        return errors.badString();
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
            return errors.badString();
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

// Convert a hex address from a .inf file into a number, or undefined if it
// isn't valid. Sign-extend 6-digit DFS *INFO output if necessary.
function tryGetINFAddress(addressString: string): number | undefined {
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

// Get contents of first line of an 8-bit text file.
function getFirstLine(b: Buffer): string {
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

// Causes a 'Exists on server' error if the given host file or metadata
// counterpart exists.
//
// This is to cater for trying to create a new file that would have the same
// PC name as an existing file. Could be due to mismatches between BBC names
// in the .inf files and the actual names on disk, could be due to loose
// non-BBC files on disk...
async function mustNotExist(hostPath: string): Promise<void> {
    if (await utils.fsExists(hostPath) || await utils.fsExists(hostPath + INF_EXT)) {
        return errors.exists('Exists on server');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IBeebFileInfo {
    // Host path for this file.
    hostPath: string;

    // Name, verbatim.
    name: string;

    // Load address.
    load: number;

    // Execution address.
    exec: number;

    // File size.
    size: number;

    // Attributes. "L" is translated to L_ATTR.
    attr: number;

    // true if the .inf file is non-existent or 0 bytes.
    noINF: boolean;
}

// Try to parse a .inf file. infBuffer is the contents, or undefined if no .inf
// file; hostName is the basename of the host file.
//
// hostName should be path.basename(hostPath); this could be computed, but since
// the caller will already have it, might as well have it supply it.
async function tryGetBeebFileInfo(
    infBuffer: Buffer | undefined,
    hostPath: string,
    hostName: string,
    log: utils.Log | undefined): Promise<IBeebFileInfo | undefined> {
    const hostStat = await utils.tryStat(hostPath);
    if (hostStat === undefined) {
        if (log !== undefined) {
            log.pn(` - failed to stat`);
        }
        return undefined;
    }

    let name: string;
    let load: number | undefined;
    let exec: number | undefined;
    let attr: number;
    let noINF: boolean;
    const size = hostStat.size;

    if (infBuffer === undefined || infBuffer.length === 0) {
        name = hostName;
        load = DEFAULT_LOAD;
        exec = DEFAULT_EXEC;
        attr = DEFAULT_ATTR;
        noINF = true;
    } else {
        const infString = getFirstLine(infBuffer);

        if (log !== undefined) {
            log.p(' - ``' + infString + '\'\'');
        }

        const infParts = infString.split(new RegExp('\\s+'));
        if (infParts.length < 3) {
            if (log !== undefined) {
                log.pn(' - too few parts');
            }

            return undefined;
        }

        let i = 0;

        name = infParts[i++];

        load = tryGetINFAddress(infParts[i++]);
        if (load === undefined) {
            if (log !== undefined) {
                log.pn(' - invalid load');
            }

            return undefined;
        }

        exec = tryGetINFAddress(infParts[i++]);
        if (exec === undefined) {
            if (log !== undefined) {
                log.pn(' - invalid exec');
            }

            return undefined;
        }

        attr = 0;
        if (i < infParts.length) {
            if (infParts[i].startsWith('CRC=')) {
                // Ignore the CRC entry.
            } else if (infParts[i] === 'L' || infParts[i] === 'l') {
                attr = L_ATTR;
            } else {
                attr = Number('0x' + infParts[i]);
                if (Number.isNaN(attr)) {
                    if (log !== undefined) {
                        log.pn(' - invalid attributes');
                    }

                    return undefined;
                }
            }

            ++i;
        }

        noINF = false;
    }

    if (log !== undefined) {
        log.pn(` - load=0x${load.toString(16)} exec=0x${exec.toString(16)} size=${size} attr=0x${attr.toString(16)}`);
    }

    return { hostPath, name, load, exec, size, attr, noINF };
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Find all .inf files in the given folder, call tryGetBeebFileInfo as
// appropriate, and return an array of the results.
async function getBeebFileInfosForFolder(hostFolderPath: string, log: utils.Log | undefined): Promise<IBeebFileInfo[]> {
    let hostNames: string[];
    try {
        hostNames = await utils.fsReaddir(hostFolderPath);
    } catch (error) {
        return [];
    }

    const beebFileInfos: IBeebFileInfo[] = [];

    const infExtRegExp = new RegExp(`\\${INF_EXT}$$`, 'i');

    if (log !== undefined) {
        log.pn('getBeebFileInfosForFolder:');
        log.in(`    `);
        log.pn(`folder path: ${hostFolderPath}`);
        log.pn(`.inf regexp: ${infExtRegExp.source}`);
    }

    for (const hostName of hostNames) {
        if (infExtRegExp.exec(hostName) !== null) {
            // skip .inf files.
            continue;
        }

        const hostPath = path.join(hostFolderPath, hostName);

        if (log !== undefined) {
            log.p(`${hostName}: `);
        }

        const infPath = hostPath + INF_EXT;
        const infBuffer = await utils.tryReadFile(infPath);

        const beebFileInfo = await tryGetBeebFileInfo(infBuffer, hostPath, hostName, log);
        if (beebFileInfo === undefined) {
            continue;
        }

        beebFileInfos.push(beebFileInfo);
    }

    if (log !== undefined) {
        log.out();
    }

    return beebFileInfos;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// async function writeHostFile(hostPath: string, data: Buffer, gaManipulator: gitattributes.Manipulator | undefined): Promise<void> {
//     try {
//         await utils.fsMkdirAndWriteFile(hostPath, data);
//     } catch (error) {
//         return BeebFS.throwServerError(error);
//     }

//     if (gaManipulator !== undefined) {
//         gaManipulator.makeFolderNotText(path.dirname(hostPath));
//     }
// }

// /////////////////////////////////////////////////////////////////////////
// /////////////////////////////////////////////////////////////////////////

// async function writeBeebFile(hostPath: string, data: Buffer, gaManipulator: gitattributes.Manipulator | undefined): Promise<void> {
//     await writeHostFile(hostPath, data, gaManipulator);

//     if (gaManipulator !== undefined) {
//         gaManipulator.makeFileBASIC(hostPath, utils.isBASIC(data));
//     }
// }

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Write a file to disk, creating the folder for it if required and throwing a
// suitable BBC-friendly error if something goes wrong.
async function writeFile(filePath: string, data: Buffer): Promise<void> {
    try {
        await utils.fsMkdirAndWriteFile(filePath, data);
    } catch (error) {
        return BeebFS.throwServerError(error);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Write INF file to disk. 'name' will be written as-is (since it's
// FS-specific), as will 'attr' (so DFS-type .inf files can have attributes
// written as 'L').
async function writeINFFile(hostPath: string, name: string, load: number, exec: number, attr: string): Promise<void> {
    let inf = `${name} ${load.toString(16)} ${exec.toString(16)}`;

    if (attr !== '') {
        inf += ` ${attr}`;
    }

    inf += os.EOL;//stop git moaning.

    await writeFile(hostPath + INF_EXT, Buffer.from(inf, 'binary'));
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Maintain any FS-specific state (at least, probably, current drive/dir, lib
// drive/dir...), and handle any stuff that might require that state.
//
// this.volume.handler points to the appropriate Handler.

interface IFSState {
    readonly volume: BeebVolume;

    // get current drive.
    getCurrentDrive(): string;

    // get current directory.
    getCurrentDir(): string;

    // get library drive.
    getLibraryDrive(): string;

    // get library directory.
    getLibraryDir(): string;

    // get file to use for *RUN. If tryLibDir is false, definitely don't try lib
    // drive/directory.
    getFileForRUN(fsp: BeebFSP, tryLibDir: boolean): Promise<BeebFile | undefined>;

    // get *CAT text, given command line that wasn't a valid FQN - presumably
    // will figure out some default value(s) and pass on to the Handler getCAT.
    getCAT(commandLine: string | undefined): Promise<string>;

    // handle *DRIVE/*MOUNT.
    starDrive(arg: string | undefined): void;

    // handle *DIR.
    starDir(fsp: BeebFSP | undefined): void;

    // handle *LIB.
    starLib(fsp: BeebFSP | undefined): void;

    // handle *DRIVES.
    starDrives(): Promise<string>;

    // read boot option, for OSGBPB 5 or SHIFT+BREAK.
    getBootOption(): Promise<number>;

    // handle *OPT 4.
    setBootOption(option: number): Promise<void>;

    // handle *TITLE.
    setTitle(title: string): Promise<void>;

    // read title, for OSGBPB 5.
    getTitle(): Promise<string>;

    // read names, for OSGBPB 6.
    readNames(): Promise<string[]>;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Handle FS-specific stuff that doesn't require any state.

interface IFSType {
    // create new state for this type of FS.
    createState(volume: BeebVolume, log: utils.Log): IFSState;

    // whether this FS supports writing.
    canWrite(): boolean;

    // check if given string is a valid BBC file name. Used to check that a .INF
    // file is valid, or whether a .INF/0-byte .INF PC file has a valid BBC
    // name.
    isValidBeebFileName(str: string): boolean;

    // get list of Beeb files matching the given FQN in the given volume - or,
    // if the FQN is undefined, all files in the volume.
    findBeebFilesMatching(volume: BeebVolume, fqn: IFSFQN | undefined, log: utils.Log | undefined): Promise<BeebFile[]>;

    // parse file/dir string, starting at index i. If state!==undefined, use it to fill in any
    // unspecified components.
    parseFileOrDirString(str: string, i: number, parseAsDir: boolean, state: IFSState | undefined): IFSFSP;

    // create appropriate FSFQN from FSFSP, filling in defaults from the given State as appropriate.
    createFQN(fsp: IFSFSP, state: IFSState | undefined): IFSFQN;

    // get ideal host path for FQN, relative to whichever volume it's in. Used
    // when creating a new file.
    getHostPath(fqn: IFSFQN): string;

    // get *CAT text for FSP.
    getCAT(fsp: BeebFSP, state: IFSState | undefined): Promise<string>;

    // find all drives in the given volume.
    findDrivesForVolume(volume: BeebVolume): Promise<BeebDrive[]>;

    // delete the given file.
    deleteFile(file: BeebFile): Promise<void>;

    // rename the given file. The volume won't change. The new file doesn't
    // obviously exist.
    renameFile(file: BeebFile, newName: BeebFQN): Promise<void>;

    // write the metadata for the given file.
    writeBeebMetadata(hostPath: string, fqn: IFSFQN, load: number, exec: number, attr: number): Promise<void>;

    // get new attributes from attribute string. Return undefined if invalid.
    getNewAttributes(oldAttr: number, attrString: string): number | undefined;

    // get *INFO/*EX text for the given file. Show name, attributes and
    // metadata. Newline will be added automatically.
    getInfoText(file: BeebFile): string;
}

interface IFSFSP {
    getName(): string | undefined;
}

interface IFSFQN {
    readonly name: string;
    equals(other: IFSFQN): boolean;
    toString(): string;
    isWildcard(): boolean;
}

function mustBeDFSHandler(handler: IFSType): DFSHandler {
    if (!(handler instanceof DFSHandler)) {
        throw new Error('not DFSHandler');
    }

    return handler;
}

function mustBeDFSState(state: IFSState | undefined): DFSState | undefined {
    if (state !== undefined) {
        if (!(state instanceof DFSState)) {
            throw new Error('not DFSState');
        }
    }

    return state;
}

function mustBeDFSFSP(fsp: IFSFSP): DFSFSP {
    if (!(fsp instanceof DFSFSP)) {
        throw new Error('not DFSFSP');
    }

    return fsp;
}

function mustBeDFSFQN(fqn: IFSFQN): DFSFQN {
    if (!(fqn instanceof DFSFQN)) {
        throw new Error('not DFSFQN');
    }

    return fqn;
}


class DFSFQN implements IFSFQN {
    public readonly drive: string;
    public readonly dir: string;
    public readonly name: string;

    public constructor(drive: string, dir: string, name: string) {
        this.drive = drive;
        this.dir = dir;
        this.name = name;
    }

    public equals(other: IFSFQN): boolean {
        if (!(other instanceof DFSFQN)) {
            return false;
        }

        if (!utils.strieq(this.drive, other.drive)) {
            return false;
        }

        if (!utils.strieq(this.dir, other.dir)) {
            return false;
        }

        if (!utils.strieq(this.name, other.name)) {
            return false;
        }

        return true;
    }

    public toString(): string {
        return `:${this.drive}.${this.dir}.${this.name}`;
    }

    public isWildcard(): boolean {
        if (this.dir === utils.MATCH_N_CHAR || this.dir === utils.MATCH_ONE_CHAR) {
            return true;
        }

        for (const c of this.name) {
            if (c === utils.MATCH_N_CHAR || c === utils.MATCH_ONE_CHAR) {
                return true;
            }
        }

        return false;
    }
}

class DFSFSP implements IFSFSP {
    public readonly drive: string | undefined;
    public readonly dir: string | undefined;
    public readonly name: string | undefined;

    public constructor(drive: string | undefined, dir: string | undefined, name: string | undefined) {
        this.drive = drive;
        this.dir = dir;
        this.name = name;
    }

    public getName(): string | undefined {
        return this.name;
    }

    public toString(): string {
        return `:${this.getString(this.drive)}.${this.getString(this.dir)}.${this.getString(this.name)}`;
    }

    private getString(x: string | undefined): string {
        // 2026 = HORIZONTAL ELLIPSIS
        return x !== undefined ? x : '\u2026';
    }
}

// get single BeebFile matching the given fqn.
//
// If wildcardsOK, wildcards are acceptable, but the pattern must match exactly
// one file - will throw BadName/'Ambiguous name' if not.
//
// If throwIfNotFound, wil throw FileNotFound if the file isn't found -
// otherwise, return undefined.
async function getBeebFile(fqn: BeebFQN, wildcardsOK: boolean, throwIfNotFound: boolean, log?: utils.Log): Promise<BeebFile | undefined> {
    if (log !== undefined) {
        log.pn(`getBeebFile: ${fqn}; wildCardsOK=${wildcardsOK} throwIfNotFound=${throwIfNotFound}`);
    }

    if (!wildcardsOK) {
        if (fqn.fsFQN.isWildcard()) {
            return errors.badName();
        }
    }

    const files = await fqn.volume.handler.findBeebFilesMatching(fqn.volume, fqn.fsFQN, log);
    if (log !== undefined) {
        log.pn(`found ${files.length} file(s)`);
    }

    if (files.length === 0) {
        if (throwIfNotFound) {
            return errors.fileNotFound();
        } else {
            return undefined;
        }
    } else if (files.length === 1) {
        return files[0];
    } else {
        return errors.badName('Ambiguous name');
    }
}

const DFS_FIXED_ATTRS = R_ATTR | W_ATTR;

class DFSState implements IFSState {
    public readonly volume: BeebVolume;

    public drive: string;
    public dir: string;

    public libDrive: string;
    public libDir: string;

    private readonly log: utils.Log;

    public constructor(volume: BeebVolume, log: utils.Log) {
        this.volume = volume;
        this.log = log;

        this.drive = '0';
        this.dir = '$';

        this.libDrive = '0';
        this.libDir = '$';
    }

    public getCurrentDrive(): string {
        return this.drive;
    }

    public getCurrentDir(): string {
        return this.dir;
    }

    public getLibraryDrive(): string {
        return this.libDrive;
    }

    public getLibraryDir(): string {
        return this.libDir;
    }

    public async getFileForRUN(fsp: BeebFSP, tryLibDir: boolean): Promise<BeebFile | undefined> {
        const fspName = mustBeDFSFSP(fsp.name);

        if (fspName.name === undefined) {
            return undefined;
        }

        // Additional DFS rules for tryLibDir.
        if (fspName.drive !== undefined || fspName.dir !== undefined) {
            tryLibDir = false;
        }

        const curFQN = new BeebFQN(fsp.volume, this.volume.handler.createFQN(fspName, this));
        const curFile = await getBeebFile(curFQN, true, false);
        if (curFile !== undefined) {
            return curFile;
        }

        if (tryLibDir) {
            const libFQN = new BeebFQN(fsp.volume, new DFSFQN(this.libDrive, this.libDir, fspName.name));
            const libFile = await getBeebFile(libFQN, true, false);
            if (libFile !== undefined) {
                return libFile;
            }
        }

        return undefined;
    }

    public async getCAT(commandLine: string | undefined): Promise<string> {
        if (commandLine === undefined) {
            return await this.volume.handler.getCAT(new BeebFSP(this.volume, false, new DFSFSP(this.drive, undefined, undefined)), this);
        } else if (commandLine.length === 1 && utils.isdigit(commandLine)) {
            return await this.volume.handler.getCAT(new BeebFSP(this.volume, false, new DFSFSP(commandLine, undefined, undefined)), this);
        } else {
            return errors.badDrive();
        }
    }

    public starDrive(arg: string | undefined): boolean {
        if (arg === undefined) {
            return errors.badDrive();
        }

        if (arg.length === 1 && utils.isdigit(arg)) {
            this.drive = arg;
        } else {
            const fsp = mustBeDFSFSP(this.volume.handler.parseFileOrDirString(arg, 0, true, this));
            if (fsp.drive === undefined || fsp.dir !== undefined) {
                return errors.badDrive();
            }

            this.drive = fsp.drive;
        }

        return true;
    }

    public starDir(fsp: BeebFSP): void {
        const dirFQN = this.getDirOrLibFQN(fsp);

        this.drive = dirFQN.drive;
        this.dir = dirFQN.dir;
    }

    public starLib(fsp: BeebFSP): void {
        const libFQN = this.getDirOrLibFQN(fsp);

        this.libDrive = libFQN.drive;
        this.libDir = libFQN.dir;
    }

    public async starDrives(): Promise<string> {
        const drives = await this.volume.handler.findDrivesForVolume(this.volume);

        let text = '';

        for (const drive of drives) {
            text += drive.name + ' - ' + drive.getOptionDescription().padEnd(4, ' ');
            if (drive.title.length > 0) {
                text += ': ' + drive.title;
            }
            text += utils.BNL;
        }

        return text;
    }

    public async getBootOption(): Promise<number> {
        const dfsHandler = mustBeDFSHandler(this.volume.handler);
        return await dfsHandler.loadBootOption(this.volume, this.drive);
    }

    public async setBootOption(option: number): Promise<void> {
        const str = (option & 3).toString() + os.EOL;
        await writeFile(path.join(this.volume.path, this.drive, OPT4_FILE_NAME), Buffer.from(str, 'binary'));
    }

    public async setTitle(title: string): Promise<void> {
        const buffer = Buffer.from(title.substr(0, MAX_TITLE_LENGTH) + os.EOL, 'binary');
        await writeFile(path.join(this.volume.path, this.drive, TITLE_FILE_NAME), buffer);
    }

    public async getTitle(): Promise<string> {
        const dfsHandler = mustBeDFSHandler(this.volume.handler);
        return await dfsHandler.loadTitle(this.volume, this.drive);
    }

    public async readNames(): Promise<string[]> {
        const files = await this.volume.handler.findBeebFilesMatching(this.volume, new DFSFQN(this.drive, this.dir, '*'), undefined);

        const names: string[] = [];
        for (const file of files) {
            const dfsFQN = mustBeDFSFQN(file.fqn.fsFQN);
            names.push(dfsFQN.name);
        }

        return names;
    }

    private getDirOrLibFQN(fsp: BeebFSP): DFSFQN {
        const dfsFSP = mustBeDFSFSP(fsp.name);

        if (fsp.wasExplicitVolume || dfsFSP.name !== undefined) {
            return errors.badDir();
        }

        // the name part is bogus, but it's never used.
        return new DFSFQN(dfsFSP.drive !== undefined ? dfsFSP.drive : this.drive, dfsFSP.dir !== undefined ? dfsFSP.dir : this.dir, '');
    }
}

class DFSHandler implements IFSType {
    private static isValidFileNameChar(char: string) {
        const c = char.charCodeAt(0);
        return c >= 32 && c < 127;
    }

    public createState(volume: BeebVolume, log: utils.Log): IFSState {
        return new DFSState(volume, log);
    }

    public canWrite(): boolean {
        return true;
    }

    public isValidBeebFileName(str: string): boolean {
        if (str.length < 2) {
            return false;
        }

        if (str[1] !== '.') {
            return false;
        }

        if (str.length > 2 + MAX_NAME_LENGTH) {
            return false;
        }

        if (!DFSHandler.isValidFileNameChar(str[0])) {
            return false;
        }

        for (let i = 2; i < str.length; ++i) {
            if (!DFSHandler.isValidFileNameChar(str[i])) {
                return false;
            }
        }

        return true;
    }

    public parseFileOrDirString(str: string, i: number, parseAsDir: boolean, state: IFSState | undefined): DFSFSP {
        const dfsState = mustBeDFSState(state);

        let drive: string | undefined;
        let dir: string | undefined;
        let name: string | undefined;

        if (str[i] === ':' && i + 1 < str.length) {
            if (!this.isValidDrive(str[i + 1])) {
                return errors.badDrive();
            }

            drive = str[i + 1];
            i += 2;

            if (str[i] === '.') {
                ++i;
            }
        } else {
            if (dfsState !== undefined) {
                drive = dfsState.drive;
            }
        }



        if (str[i + 1] === '.') {
            if (!DFSHandler.isValidFileNameChar(str[i])) {
                return errors.badDir();
            }

            dir = str[i];
            i += 2;
        } else {
            if (dfsState !== undefined) {
                dir = dfsState.dir;
            }
        }

        if (parseAsDir) {
            if (i < str.length && dir !== undefined || i === str.length - 1 && !DFSHandler.isValidFileNameChar(str[i])) {
                return errors.badDir();
            }

            dir = str[i];
        } else {
            if (i < str.length) {
                for (let j = i; j < str.length; ++j) {
                    if (!DFSHandler.isValidFileNameChar(str[j])) {
                        return errors.badName();
                    }
                }

                name = str.slice(i);

                if (name.length > MAX_NAME_LENGTH) {
                    return errors.badName();
                }
            }
        }

        return new DFSFSP(drive, dir, name);
    }

    public createFQN(fsp: DFSFSP, state: IFSState | undefined): DFSFQN {
        mustBeDFSFSP(fsp);
        const dfsState = mustBeDFSState(state);

        let drive: string;
        if (fsp.drive === undefined) {
            if (dfsState === undefined) {
                return errors.badName();
            }

            drive = dfsState.drive;
        } else {
            drive = fsp.drive;
        }

        let dir: string;
        if (fsp.dir === undefined) {
            if (dfsState === undefined) {
                return errors.badName();
            }
            dir = dfsState.dir;
        } else {
            dir = fsp.dir;
        }

        if (fsp.name === undefined) {
            return errors.badName();
        }

        return new DFSFQN(drive, dir, fsp.name);
    }

    public getHostPath(fqn: IFSFQN): string {
        const dfsFQN = mustBeDFSFQN(fqn);

        return path.join(dfsFQN.drive, this.getHostChars(dfsFQN.dir) + '.' + this.getHostChars(fqn.name));
    }

    public async findBeebFilesMatching(volume: BeebVolume, fqn: IFSFQN | undefined, log: utils.Log | undefined): Promise<BeebFile[]> {
        let driveNames: string[];
        let dirRegExp: RegExp;
        let nameRegExp: RegExp;
        if (fqn === undefined) {
            driveNames = [];
            for (const drive of await this.findDrivesForVolume(volume)) {
                driveNames.push(drive.name);
            }
            dirRegExp = utils.getRegExpFromAFSP('*');
            nameRegExp = utils.getRegExpFromAFSP('*');
        } else {
            const dfsFQN = mustBeDFSFQN(fqn);
            driveNames = [dfsFQN.drive];
            dirRegExp = utils.getRegExpFromAFSP(dfsFQN.dir);
            nameRegExp = utils.getRegExpFromAFSP(dfsFQN.name);
        }

        const beebFiles: BeebFile[] = [];

        for (const driveName of driveNames) {
            const driveHostPath = path.join(volume.path, driveName);
            const beebFileInfos = await getBeebFileInfosForFolder(driveHostPath, log);

            for (const beebFileInfo of beebFileInfos) {
                let text = false;

                if (!this.isValidBeebFileName(beebFileInfo.name)) {
                    continue;
                }

                const dir = beebFileInfo.name[0];
                const name = beebFileInfo.name.slice(2);

                if (dirRegExp.exec(dir) === null || nameRegExp.exec(name) === null) {
                    continue;
                }

                if (beebFileInfo.noINF) {
                    if (beebFileInfo.name[0] === '!') {
                        text = true;
                    }
                }

                const dfsFQN = new DFSFQN(driveName, dir, name);

                const file = new BeebFile(beebFileInfo.hostPath, new BeebFQN(volume, dfsFQN), beebFileInfo.load, beebFileInfo.exec, beebFileInfo.size, beebFileInfo.attr | DFS_FIXED_ATTRS, text);

                if (log !== undefined) {
                    log.pn(`${file}`);
                }

                beebFiles.push(file);
            }
        }

        if (log !== undefined) {
            log.out();
        }

        return beebFiles;
    }

    public async getCAT(fsp: BeebFSP, state: IFSState | undefined): Promise<string> {
        const fspDFSName = mustBeDFSFSP(fsp.name);
        const dfsState = mustBeDFSState(state);

        if (fspDFSName.drive === undefined || fspDFSName.name !== undefined) {
            return errors.badDrive();
        }

        const beebFiles = await this.findBeebFilesMatching(fsp.volume, new DFSFQN(fspDFSName.drive, '*', '*'), undefined);

        let text = '';

        const title = await this.loadTitle(fsp.volume, fspDFSName.drive);
        if (title !== '') {
            text += title + BNL;
        }

        text += 'Volume: ' + fsp.volume.name + BNL;

        const boot = await this.loadBootOption(fsp.volume, fspDFSName.drive);
        text += ('Drive ' + fspDFSName.drive + ' (' + boot + ' - ' + BOOT_OPTION_DESCRIPTIONS[boot] + ')').padEnd(20);

        if (dfsState !== undefined) {
            text += ('Dir :' + dfsState.dir + '.' + dfsState.dir).padEnd(10);

            text += 'Lib :' + dfsState.libDrive + '.' + dfsState.libDir;
        }

        text += BNL + BNL;

        let dir: string;
        if (dfsState !== undefined) {
            dir = dfsState.dir;
        } else {
            dir = '$';
        }

        beebFiles.sort((a, b) => {
            const aNameFSName = mustBeDFSFQN(a.fqn.fsFQN);
            const bNameFSName = mustBeDFSFQN(b.fqn.fsFQN);

            if (aNameFSName.dir === dir && bNameFSName.dir !== dir) {
                return -1;
            } else if (aNameFSName.dir !== dir && bNameFSName.dir === dir) {
                return 1;
            } else {
                const cmpDirs = utils.stricmp(aNameFSName.dir, bNameFSName.dir);
                if (cmpDirs !== 0) {
                    return cmpDirs;
                }

                return utils.stricmp(aNameFSName.name, bNameFSName.name);
            }
        });

        for (const beebFile of beebFiles) {
            const fileFSName = mustBeDFSFQN(beebFile.fqn.fsFQN);

            let name;
            if (fileFSName.dir === dir) {
                name = `  ${fileFSName.name}`;
            } else {
                name = `${fileFSName.dir}.${fileFSName.name}`;
            }

            if ((beebFile.attr & L_ATTR) !== 0) {
                name = name.padEnd(14) + 'L';
            }

            text += ('  ' + name).padEnd(20);
        }

        text += BNL;

        //this.log.withIndent('*CAT output: ', () => this.log.bpn(text));

        return text;
    }

    public async findDrivesForVolume(volume: BeebVolume): Promise<BeebDrive[]> {
        let names: string[];
        try {
            names = await utils.fsReaddir(volume.path);
        } catch (error) {
            return BeebFS.throwServerError(error);
        }

        const drives = [];

        for (const name of names) {
            if (this.isValidDrive(name)) {
                const option = await this.loadBootOption(volume, name);
                const title = await this.loadTitle(volume, name);

                drives.push(new BeebDrive(volume, name, option, title));
            }
        }

        return drives;
    }

    public async deleteFile(file: BeebFile): Promise<void> {
        try {
            await utils.forceFsUnlink(file.hostPath + INF_EXT);
            await utils.forceFsUnlink(file.hostPath);
        } catch (error) {
            BeebFS.throwServerError(error as NodeJS.ErrnoException);
        }
    }

    public async renameFile(oldFile: BeebFile, newFQN: BeebFQN): Promise<void> {
        const newFQNDFSName = mustBeDFSFQN(newFQN.fsFQN);

        const newHostPath = path.join(newFQN.volume.path, this.getHostPath(newFQNDFSName));
        await mustNotExist(newHostPath);

        const newFile = new BeebFile(newHostPath, newFQN, oldFile.load, oldFile.exec, oldFile.size, oldFile.attr, false);

        await this.writeBeebMetadata(newFile.hostPath, newFQNDFSName, newFile.load, newFile.exec, newFile.attr);

        try {
            await utils.fsRename(oldFile.hostPath, newFile.hostPath);
        } catch (error) {
            return BeebFS.throwServerError(error);
        }

        await utils.forceFsUnlink(oldFile.hostPath + INF_EXT);
    }

    public async writeBeebMetadata(hostPath: string, fqn: IFSFQN, load: number, exec: number, attr: number): Promise<void> {
        const dfsFQN = mustBeDFSFQN(fqn);

        await writeINFFile(hostPath, `${dfsFQN.dir}.${dfsFQN.name}`, load, exec, (attr & L_ATTR) !== 0 ? 'L' : '');
    }

    public getNewAttributes(oldAttr: number, attrString: string): number | undefined {
        if (attrString === '') {
            return DFS_FIXED_ATTRS;
        } else if (attrString.toLowerCase() === 'l') {
            return DFS_FIXED_ATTRS | L_ATTR;
        } else {
            return undefined;
        }
    }

    public async loadTitle(volume: BeebVolume, drive: string): Promise<string> {
        const buffer = await utils.tryReadFile(path.join(volume.path, drive, TITLE_FILE_NAME));
        if (buffer === undefined) {
            return DEFAULT_TITLE;
        }

        return getFirstLine(buffer).substr(0, MAX_TITLE_LENGTH);
    }

    public async loadBootOption(volume: BeebVolume, drive: string): Promise<number> {
        const buffer = await utils.tryReadFile(path.join(volume.path, drive, OPT4_FILE_NAME));
        if (buffer === undefined || buffer.length === 0) {
            return DEFAULT_BOOT_OPTION;
        }

        return buffer[0] & 3;//ugh.
    }

    public getInfoText(file: BeebFile): string {
        const dfsFQN = mustBeDFSFQN(file.fqn.fsFQN);

        const attr = (file.attr & L_ATTR) !== 0 ? 'L' : ' ';
        const load = utils.hex8(file.load).toUpperCase();
        const exec = utils.hex8(file.exec).toUpperCase();
        const size = utils.hex(file.size & 0x00ffffff, 6).toUpperCase();

        // 0123456789012345678901234567890123456789
        // _.__________ L 12345678 12345678 123456
        return `${dfsFQN.dir}.${dfsFQN.name.padEnd(10)} ${attr} ${load} ${exec} ${size}`;
    }

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

    private isValidDrive(maybeDrive: string): boolean {
        return maybeDrive.length === 1 && utils.isdigit(maybeDrive);
    }
}

// there's just the one of these.
const gDFSHandler = new DFSHandler();

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class BeebFS {

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Try (if not very hard) to translate POSIX-style Node errors into
    // something that makes more sense for the Beeb.
    public static throwServerError(error: NodeJS.ErrnoException): never {
        if (error.code === 'ENOENT') {
            return errors.fileNotFound();
        } else {
            return errors.discFault(`POSIX error: ${error.code}`);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async findAllVolumes(folders: string[], pcFolders: string[], log: utils.Log | undefined): Promise<BeebVolume[]> {
        return await BeebFS.findVolumes('*', folders, pcFolders, log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // public static async findDrivesForVolume(volume: BeebVolume): Promise<BeebDrive[]> {
    //     let names: string[];
    //     try {
    //         names = await utils.fsReaddir(volume.path);
    //     } catch (error) {
    //         return BeebFS.throwServerError(error);
    //     }

    //     const drives = [];

    //     for (const name of names) {
    //         if (BeebFS.isValidDrive(name)) {
    //             const option = await BeebFS.loadBootOption(volume, name);
    //             const title = await BeebFS.loadTitle(volume, name);

    //             drives.push(new BeebDrive(volume, name, option, title));
    //         }
    //     }

    //     return drives;
    // }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // public static async loadTitle(volume: BeebVolume, drive: string): Promise<string> {
    //     const buffer = await utils.tryReadFile(path.join(volume.path, drive, TITLE_FILE_NAME));
    //     if (buffer === undefined) {
    //         return DEFAULT_TITLE;
    //     }

    //     return getFirstLine(buffer).substr(0, MAX_TITLE_LENGTH);
    // }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // public static async loadBootOption(volume: BeebVolume, drive: string): Promise<number> {
    //     const buffer = await utils.tryReadFile(path.join(volume.path, drive, OPT4_FILE_NAME));
    //     if (buffer === undefined || buffer.length === 0) {
    //         return DEFAULT_BOOT_OPTION;
    //     }

    //     return buffer[0] & 3;//ugh.
    // }

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

    // // Get list of BeebFile(s) matching FQN.
    // public static async getBeebFilesForAFSP(afsp: BeebFQN, log?: utils.Log): Promise<BeebFile[]> {
    //     if (log !== undefined) {
    //         log.pn('getBeebFilesForAFSP: ' + afsp);
    //     }

    //     let files = await BeebFS.getBeebFiles(afsp.volume, afsp.drive, log);

    //     const dirRegExp = utils.getRegExpFromAFSP(afsp.dir);
    //     const nameRegExp = utils.getRegExpFromAFSP(afsp.name);

    //     if (log !== undefined) {
    //         log.pn('    dirRegExp: ``' + dirRegExp.source + '\'\'');
    //         log.pn('    nameRegExp: ``' + nameRegExp.source + '\'\'');
    //     }

    //     files = files.filter((file) => dirRegExp.exec(file.name.dir) !== null && nameRegExp.exec(file.name.name) !== null);

    //     if (log !== undefined) {
    //         log.pn('    matched: ' + files.length + ' file(s)');
    //     }

    //     return files;
    // }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Logging for this probably isn't proving especially useful. Maybe it
    // should go away?
    private static async findVolumes(afsp: string, folders: string[], pcFolders: string[], log: utils.Log | undefined): Promise<BeebVolume[]> {
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
                            volumeName = getFirstLine(buffer);
                        } else {
                            volumeName = name;
                        }

                        if (BeebFS.isValidVolumeName(volumeName)) {
                            const volume = new BeebVolume(fullName, volumeName, gDFSHandler);
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

        // for (const pcFolder of pcFolders) {
        //     const volumeName = path.basename(pcFolder);
        //     if (BeebFS.isValidVolumeName(volumeName)) {
        //         if (re.exec(volumeName) !== null) {
        //             const volume = new BeebVolume(pcFolder, volumeName, BeebVolumeType.PC);
        //             volumes.push(volume);
        //         }
        //     }
        // }

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

    private folders: string[];
    private pcFolders: string[];

    //private currentVolume: BeebVolume | undefined;

    private firstFileHandle: number;
    private openFiles: (OpenFile | undefined)[];

    private log: utils.Log;

    private state: IFSState | undefined;

    // private drive!: string;
    // private dir!: string;
    // private libDrive!: string;
    // private libDir!: string;
    private gaManipulator: gitattributes.Manipulator | undefined;

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public constructor(logPrefix: string | undefined, folders: string[], pcFolders: string[], colours: Chalk | undefined, gaManipulator: gitattributes.Manipulator | undefined) {
        this.log = new utils.Log(logPrefix !== undefined ? logPrefix : '', process.stdout, logPrefix !== undefined);
        this.log.colours = colours;

        this.folders = folders.slice();
        this.pcFolders = pcFolders.slice();

        //this.resetDirs();

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
        if (!volume.isReadOnly()) {
            if (this.gaManipulator !== undefined) {
                this.gaManipulator.makeVolumeNotText(volume);
            }
        }

        this.state = volume.handler.createState(volume, this.log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getVolume(): BeebVolume {
        return this.getState().volume;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Reset dirs and close open files.
    public async reset() {
        if (this.state !== undefined) {
            this.state = this.state.volume.handler.createState(this.state.volume, this.log);
        }

        await this.OSFINDClose(0);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getState(): IFSState {
        if (this.state === undefined) {
            return errors.discFault('No volume');
        }

        return this.state;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async starDrive(arg: string | undefined): Promise<void> {
        this.getState().starDrive(arg);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async starDir(arg: string | undefined): Promise<void> {
        let fsp: BeebFSP | undefined;

        if (arg !== undefined) {
            fsp = await this.parseDirString(arg);

            if (fsp.wasExplicitVolume) {
                await this.mount(fsp.volume);
            }
        }

        this.getState().starDir(fsp);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async starLib(arg: string | undefined): Promise<void> {
        let fsp: BeebFSP | undefined;

        if (arg !== undefined) {
            fsp = await this.parseDirString(arg);

            if (fsp.wasExplicitVolume) {
                return errors.badDir();
            }
        }

        this.getState().starLib(fsp);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async starDrives(): Promise<string> {
        return await this.getState().starDrives();
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async findVolumesMatching(afsp: string): Promise<BeebVolume[]> {
        return await BeebFS.findVolumes(afsp, this.folders, this.pcFolders, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async createVolume(name: string): Promise<BeebVolume> {
        if (!BeebFS.isValidVolumeName(name)) {
            return errors.badName();
        }

        // This check is a bit crude, but should catch obvious problems...
        const volumePath = path.join(this.folders[0], name);
        try {
            const stat0 = await utils.fsStat(path.join(volumePath, '0'));
            if (stat0.isDirectory()) {
                return errors.exists();
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

        const newVolume = new BeebVolume(volumePath, name, gDFSHandler);
        return newVolume;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseFQN(fileString: string): Promise<BeebFQN> {
        this.log.pn('parseFQN: ``' + fileString + '\'\'');

        const fsp = await this.parseFileString(fileString);
        this.log.pn('    fsp: ' + fsp);

        const fqn = fsp.volume.handler.createFQN(fsp.name, this.state);
        this.log.pn(`    fqn: ${fqn}`);

        return new BeebFQN(fsp.volume, fqn);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async findFilesMatching(fqn: BeebFQN): Promise<BeebFile[]> {
        return await fqn.volume.handler.findBeebFilesMatching(fqn.volume, fqn.fsFQN, this.log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getInfoText(file: BeebFile): string {
        return file.fqn.volume.handler.getInfoText(file);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async starLocate(arg: string): Promise<string[]> {
        const volumes = await this.findVolumesMatching('*');

        const foundPaths: string[] = [];

        for (const volume of volumes) {
            const files = await volume.handler.findBeebFilesMatching(volume, undefined, undefined);

            for (const file of files) {
                foundPaths.push(file.fqn.toString());
            }
        }

        return foundPaths;
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
        if (commandLine !== undefined) {
            let fsp: BeebFSP | undefined;
            try {
                fsp = await this.parseFileString(commandLine);
            } catch (error) {
                // Just ignore, and let the active FS try to re-parse it.
            }

            if (fsp !== undefined) {
                return fsp.volume.handler.getCAT(fsp, this.state);
            }
        }

        return await this.getState().getCAT(commandLine);
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
                return errors.eof();
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
            return errors.badName();
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
            throw new errors.BeebError(255, 'Unhandled OSFILE: &' + utils.hex2(a));
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
            return errors.badName();
        }

        this.log.pn('OSFIND: mode=$' + utils.hex2(mode) + ' nameString=``' + nameString + '\'\'');

        const index = this.openFiles.indexOf(undefined);
        if (index < 0) {
            return errors.tooManyOpen();
        }

        const write = (mode & 0x80) !== 0;
        const read = (mode & 0x40) !== 0;

        const fqn = await this.parseFQN(commandLine.parts[0]);
        let hostPath: string;

        let contentsBuffer: Buffer | undefined;
        const file = await getBeebFile(fqn, read && !write, false);
        if (file !== undefined) {
            // Files can be opened once for write, or multiple times for read.
            {
                for (let othIndex = 0; othIndex < this.openFiles.length; ++othIndex) {
                    const openFile = this.openFiles[othIndex];
                    if (openFile !== undefined) {
                        if (openFile.hostPath === file.hostPath) {
                            if (openFile.write || write) {
                                this.log.pn(`        already open: handle=0x${this.firstFileHandle + othIndex}`);
                                return errors.open();
                            }
                        }
                    }
                }
            }

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

            hostPath = this.getHostPath(fqn);
            await mustNotExist(hostPath);

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
                return errors.channel();
            }

            await this.closeByIndex(index);
        } else {
            return errors.channel();
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
            return this.OSGBPBReadDevice(true);//this.drive, this.dir);
        } else if (a === 7) {
            return this.OSGBPBReadDevice(false);//this.libDrive, this.libDir);
        } else if (a === 8) {
            return await this.OSGBPBReadNames(numBytes, newPtr);
        } else {
            return new OSGBPBResult(true, numBytes, newPtr, undefined);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getBootOption(): Promise<number> {
        return await this.getState().getBootOption();
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
        return (await getBeebFile(fqn, true, true))!;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async OPT(x: number, y: number): Promise<void> {
        if (x === 4) {
            const state = this.getState();

            this.mustBeWriteableVolume(state.volume);

            await state.setBootOption(y & 3);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async setTitle(title: string): Promise<void> {
        const state = this.getState();

        this.mustBeWriteableVolume(state.volume);

        await state.setTitle(title);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async writeBeebFileMetadata(file: BeebFile): Promise<void> {
        await this.writeBeebMetadata(file.hostPath, file.fqn, file.load, file.exec, file.attr);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getFileWithModifiedAttributes(file: BeebFile, attributeString: string): BeebFile {
        const newAttr = file.fqn.volume.handler.getNewAttributes(file.attr, attributeString);
        if (newAttr === undefined) {
            return errors.badAttribute();
        }

        return new BeebFile(file.hostPath, file.fqn, file.load, file.exec, file.size, newAttr, file.text);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async delete(fqn: BeebFQN): Promise<void> {
        const file = (await getBeebFile(fqn, false, true))!;

        await this.deleteFile(file);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async rename(oldFQN: BeebFQN, newFQN: BeebFQN): Promise<void> {
        this.log.pn('oldFQN: ' + oldFQN);
        this.log.pn('newFQN: ' + newFQN);

        if (!oldFQN.volume.equals(newFQN.volume)) {
            return errors.badDrive();
        }

        if (await getBeebFile(newFQN, false, false) !== undefined) {
            return errors.exists();
        }

        const oldFile = await getBeebFile(oldFQN, false, true);
        if (oldFile === undefined) {
            return errors.fileNotFound();
        }

        await oldFQN.volume.handler.renameFile(oldFile, newFQN);

        if (this.gaManipulator !== undefined) {
            if (!newFQN.volume.isReadOnly()) {
                // could be cleverer than this.
                this.gaManipulator.renameFile(oldFile.hostPath, newFQN.volume.handler.getHostPath(newFQN.fsFQN));
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getFileForRUN(fsp: BeebFSP, tryLibDir: boolean): Promise<BeebFile> {
        const file = await this.getState().getFileForRUN(fsp, !fsp.wasExplicitVolume);

        if (file !== undefined) {
            return file;
        }

        return errors.badCommand();
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

    private getHostPath(fqn: BeebFQN): string {
        return path.join(fqn.volume.path, fqn.volume.handler.getHostPath(fqn.fsFQN));
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
                return errors.wont();
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

        const file = await getBeebFile(fqn, false, false, this.log);
        if (file !== undefined) {
            this.mustNotBeOpen(file);
            this.mustBeWriteableFile(file);

            hostPath = file.hostPath;
        } else {
            hostPath = this.getHostPath(fqn);

            await mustNotExist(hostPath);
        }

        const attr = DEFAULT_ATTR;
        await this.writeBeebData(hostPath, fqn, data);
        await this.writeBeebMetadata(hostPath, fqn, load, exec, attr);

        return new OSFILEResult(1, this.createOSFILEBlock(load, exec, data.length, attr), undefined, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async writeBeebData(hostPath: string, fqn: BeebFQN, data: Buffer): Promise<void> {
        await writeFile(hostPath, data);

        if (this.gaManipulator !== undefined) {
            if (!fqn.volume.isReadOnly()) {
                this.gaManipulator.makeVolumeNotText(fqn.volume);
                this.gaManipulator.makeFileBASIC(hostPath, utils.isBASIC(data));
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async writeBeebMetadata(hostPath: string, fqn: BeebFQN, load: number, exec: number, attr: number): Promise<void> {
        await fqn.volume.handler.writeBeebMetadata(hostPath, fqn.fsFQN, load, exec, attr);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEWriteMetadata(
        fqn: BeebFQN,
        load: number | undefined,
        exec: number | undefined,
        attr: number | undefined): Promise<OSFILEResult> {
        this.mustBeWriteableVolume(fqn.volume);

        const file = await getBeebFile(fqn, false, false);
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

        await this.writeBeebMetadata(file.hostPath, file.fqn, load, exec, attr);

        return new OSFILEResult(1, this.createOSFILEBlock(load, exec, file.size, attr), undefined, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEReadMetadata(fqn: BeebFQN): Promise<OSFILEResult> {
        const file = await getBeebFile(fqn, true, false);
        if (file === undefined) {
            return new OSFILEResult(0, undefined, undefined, undefined);
        } else {
            return new OSFILEResult(1, this.createOSFILEBlock(file.load, file.exec, file.size, file.attr), undefined, undefined);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEDelete(fqn: BeebFQN): Promise<OSFILEResult> {
        const file = await getBeebFile(fqn, true, false);
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
        this.mustBeWriteableVolume(file.fqn.volume);
        this.mustNotBeOpen(file);
        this.mustBeWriteableFile(file);

        await file.fqn.volume.handler.deleteFile(file);

        if (this.gaManipulator !== undefined) {
            this.gaManipulator.deleteFile(file.hostPath);
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

    // Causes a 'Open' error if the file appears to be open.
    private mustNotBeOpen(file: BeebFile): void {
        for (const openFile of this.openFiles) {
            if (openFile !== undefined) {
                if (openFile.hostPath === file.hostPath) {
                    return errors.open();
                }
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Read only' error if the given file isn't open for write.
    private mustBeOpenForWrite(openFile: OpenFile): void {
        if (!openFile.write) {
            return errors.readOnly();
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Channel' error if the OpenFile is undefined.
    private mustBeOpen(openFile: OpenFile | undefined): OpenFile {
        if (openFile === undefined) {
            return errors.channel();
        }

        return openFile;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Too big' error if the value is larger than the max file size.
    private mustNotBeTooBig(amount: number): void {
        if (amount > MAX_FILE_SIZE) {
            return errors.tooBig();
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Locked' error if the file exists and is locked.
    private mustBeWriteableFile(file: BeebFile | undefined): void {
        if (file !== undefined) {
            if ((file.attr & L_ATTR) !== 0) {
                return errors.locked();
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private mustBeWriteableVolume(volume: BeebVolume): void {
        if (volume.isReadOnly()) {
            return errors.volumeReadOnly();
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
                if (error instanceof errors.BeebError) {
                    dataLost = true;
                    // but keep going so that all the files get closed.
                } else {
                    throw error;
                }
            }
        }

        if (dataLost) {
            return errors.dataLost();
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

            await this.writeBeebData(openFile.hostPath, openFile.fqn, data);

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
        const state = this.getState();

        const builder = new utils.BufferBuilder();

        const title = await state.getTitle();
        const bootOption = await state.getBootOption();

        builder.writePascalString(title);
        builder.writeUInt8(bootOption);

        // What are you supposed to return for count and pointer in this case?
        return new OSGBPBResult(false, undefined, undefined, builder.createBuffer());
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private OSGBPBReadDevice(current: boolean): OSGBPBResult {
        const state = this.getState();
        const builder = new utils.BufferBuilder();

        let drive: string;
        let dir: string;
        if (current) {
            drive = state.getCurrentDrive();
            dir = state.getCurrentDir();
        } else {
            drive = state.getLibraryDrive();
            dir = state.getLibraryDir();
        }

        builder.writePascalString(drive);
        builder.writePascalString(dir);

        return new OSGBPBResult(false, undefined, undefined, builder.createBuffer());
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSGBPBReadNames(numBytes: number, newPtr: number): Promise<OSGBPBResult> {
        const state = this.getState();

        const builder = new utils.BufferBuilder();

        const names = await state.readNames();

        let nameIdx = newPtr;

        while (numBytes > 0 && nameIdx < names.length) {
            builder.writePascalString(names[nameIdx]);

            --numBytes;
            ++nameIdx;
        }

        return new OSGBPBResult(numBytes > 0, numBytes, nameIdx, builder.createBuffer());
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private bputInternal(openFile: OpenFile, byte: number): void {
        if (openFile.ptr >= openFile.contents.length) {
            if (openFile.contents.length >= MAX_FILE_SIZE) {
                return errors.tooBig();
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

    // private resetDirs() {
    //     this.setDrive('0');
    //     this.setDir('$');

    //     this.setLibDrive('0');
    //     this.setLibDir('$');
    // }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async parseFileOrDirString(str: string, parseAsDir: boolean): Promise<BeebFSP> {
        if (str === '') {
            return errors.badName();
        }

        let i = 0;
        let volume: BeebVolume;
        let wasExplicitVolume: boolean;

        // ::x:y.z
        if (str[i] === ':' && str[i + 1] === ':' && str.length > 3) {
            const end = str.indexOf(':', i + 2);
            if (end < 0) {
                // "::fred" or similar.
                return errors.badName();
            }

            const volumeName = str.substring(i + 2, end);

            const volumes = await this.findVolumesMatching(volumeName);

            if (volumes.length === 0) {
                return errors.fileNotFound('Volume not found');
            } else if (volumes.length > 1) {
                return errors.badName('Ambiguous volume');
            }

            volume = volumes[0];
            wasExplicitVolume = true;

            i = end;
        } else {
            // This might produce a 'No volume' error, which feels a bit ugly at
            // the parsing step, but I don't think it matters in practice...
            volume = this.getState().volume;
            wasExplicitVolume = false;
        }

        const fsp = volume.handler.parseFileOrDirString(str, i, parseAsDir, this.state);

        return new BeebFSP(volume, wasExplicitVolume, fsp);
    }

    /////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////
}
