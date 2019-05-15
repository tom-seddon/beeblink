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
import CommandLine from './CommandLine';
import * as inf from './inf';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

const MAX_NUM_DRIVES = 8;
const MAX_FILE_SIZE = 0xffffff;

// Must be <255, but aside from that it's a completely arbitrary limit.
const MAX_TITLE_LENGTH = 40;

// 10 is the CFS/CFS/ADFS limit, so it's not pushing the boat out *too* much...
const MAX_NAME_LENGTH = 10;

const MIN_FILE_HANDLE = 0xa0;

export const SHOULDNT_LOAD = 0xffffffff;
export const SHOULDNT_EXEC = 0xffffffff;

export const DEFAULT_LOAD = SHOULDNT_LOAD;
export const DEFAULT_EXEC = SHOULDNT_EXEC;
export const DEFAULT_ATTR = 0;

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
export class FQN {
    // Volume this FQN refers to.
    public readonly volume: Volume;

    // FS-specific name portion of this FQN.
    public fsFQN: IFSFQN;

    public constructor(volume: Volume, fsFQN: IFSFQN) {
        this.volume = volume;
        this.fsFQN = fsFQN;
    }

    public toString() {
        return `::${this.volume.name}${this.fsFQN}`;
    }

    public equals(other: FQN): boolean {
        return this.volume.equals(other.volume) && this.fsFQN.equals(other.fsFQN);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export const R_ATTR = 1;
export const W_ATTR = 2;
export const E_ATTR = 4;
export const L_ATTR = 8;

export class File {
    // Path of this file on the PC filing system.
    public readonly hostPath: string;

    // Actual BBC file name.
    public readonly fqn: FQN;

    // BBC-style attributes.
    public readonly load: number;
    public readonly exec: number;
    public readonly attr: number;

    // could perhaps be part of the attr field, but I'm a bit reluctant to
    // fiddle around with that.
    public readonly text: boolean;

    public constructor(hostPath: string, fqn: FQN, load: number, exec: number, attr: number, text: boolean) {
        this.hostPath = hostPath;
        this.fqn = fqn;
        this.load = load;
        this.exec = exec;
        this.attr = attr;
        this.text = text;
    }

    public toString(): string {
        return 'BeebFile(hostPath=``' + this.hostPath + '\'\' name=``' + this.fqn + '\'\' load=0x' + utils.hex8(this.load) + ' exec=0x' + utils.hex8(this.exec) + ' attr=0x' + utils.hex8(this.attr);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class OpenFile {
    public readonly hostPath: string;
    public readonly fqn: FQN;
    public readonly read: boolean;
    public readonly write: boolean;
    public ptr: number;
    public eofError: boolean;// http://beebwiki.mdfs.net/OSBGET
    public dirty: boolean;

    // I wasn't going to buffer anything originally, but I quickly found it
    // massively simplifies the error handling.
    public readonly contents: number[];

    public constructor(hostPath: string, fqn: FQN, read: boolean, write: boolean, contents: number[]) {
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

export class Volume {
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

    public asReadOnly(): Volume {
        const readOnly = new Volume(this.path, this.name, this.handler);

        readOnly.readOnly = true;

        return readOnly;
    }

    public equals(oth: Volume): boolean {
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
class FSP {
    // Volume this FSP refers to.
    public readonly volume: Volume;

    // set to true if the ::VOLUME syntax was used to specify the volume.
    public readonly wasExplicitVolume: boolean;

    // FS-specific portion of the FSP.
    public readonly name: IFSFSP;

    public constructor(volume: Volume, wasExplicitVolume: boolean, name: IFSFSP) {
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

// Causes a 'Exists on server' error if the given host file or metadata
// counterpart exists.
//
// This is to cater for trying to create a new file that would have the same
// PC name as an existing file. Could be due to mismatches between BBC names
// in the .inf files and the actual names on disk, could be due to loose
// non-BBC files on disk...
async function mustNotExist(hostPath: string): Promise<void> {
    if (await utils.fsExists(hostPath) || await utils.fsExists(hostPath + inf.ext)) {
        return errors.exists('Exists on server');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Write a file to disk, creating the folder for it if required and throwing a
// suitable BBC-friendly error if something goes wrong.
async function writeFile(filePath: string, data: Buffer): Promise<void> {
    try {
        await utils.fsMkdirAndWriteFile(filePath, data);
    } catch (error) {
        return FS.throwServerError(error);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Maintain any FS-specific state (at least, probably, current drive/dir, lib
// drive/dir...), and handle any stuff that might require that state.
//
// this.volume.handler points to the appropriate Handler.

interface IFSState {
    readonly volume: Volume;

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
    getFileForRUN(fsp: FSP, tryLibDir: boolean): Promise<File | undefined>;

    // get *CAT text, given command line that wasn't a valid FQN - presumably
    // will figure out some default value(s) and pass on to the Handler getCAT.
    getCAT(commandLine: string | undefined): Promise<string>;

    // handle *DRIVE/*MOUNT.
    starDrive(arg: string | undefined): void;

    // handle *DIR.
    starDir(fsp: FSP | undefined): void;

    // handle *LIB.
    starLib(fsp: FSP | undefined): void;

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
    // a IFSFP for use with findBeebFilesMatching that will match all files in
    // the volume.
    readonly matchAllFSP: IFSFSP;

    // create new state for this type of FS.
    createState(volume: Volume, log: utils.Log): IFSState;

    // whether this FS supports writing.
    canWrite(): boolean;

    // check if given string is a valid BBC file name. Used to check that a .INF
    // file is valid, or whether a .INF/0-byte .INF PC file has a valid BBC
    // name.
    isValidBeebFileName(str: string): boolean;

    // get list of Beeb files matching the given FSP/FQN in the given volume. If
    // an FQN, do a wildcard match; if an FSP, same, treating any undefined
    // values as matching anything.
    findBeebFilesMatching(volume: Volume, pattern: IFSFSP | IFSFQN, log: utils.Log | undefined): Promise<File[]>;

    // parse file/dir string, starting at index i. 
    parseFileOrDirString(str: string, i: number, parseAsDir: boolean): IFSFSP;

    // create appropriate FSFQN from FSFSP, filling in defaults from the given State as appropriate.
    createFQN(fsp: IFSFSP, state: IFSState | undefined): IFSFQN;

    // get ideal host path for FQN, relative to whichever volume it's in. Used
    // when creating a new file.
    getHostPath(fqn: IFSFQN): string;

    // get *CAT text for FSP.
    getCAT(fsp: FSP, state: IFSState | undefined): Promise<string>;

    // delete the given file.
    deleteFile(file: File): Promise<void>;

    // rename the given file. The volume won't change. The new file doesn't
    // obviously exist.
    renameFile(file: File, newName: FQN): Promise<void>;

    // write the metadata for the given file.
    writeBeebMetadata(hostPath: string, fqn: IFSFQN, load: number, exec: number, attr: number): Promise<void>;

    // get new attributes from attribute string. Return undefined if invalid.
    getNewAttributes(oldAttr: number, attrString: string): number | undefined;

    // get *INFO/*EX text for the given file. Show name, attributes and
    // metadata. Newline will be added automatically.
    getInfoText(file: File, fileSize: number): string;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IFSFSP {
    getName(): string | undefined;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IFSFQN {
    readonly name: string;
    equals(other: IFSFQN): boolean;
    toString(): string;
    isWildcard(): boolean;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

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

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

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

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

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

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// get single BeebFile matching the given fqn.
//
// If wildcardsOK, wildcards are acceptable, but the pattern must match exactly
// one file - will throw BadName/'Ambiguous name' if not.
//
// If throwIfNotFound, wil throw FileNotFound if the file isn't found -
// otherwise, return undefined.
async function getBeebFile(fqn: FQN, wildcardsOK: boolean, throwIfNotFound: boolean, log?: utils.Log): Promise<File | undefined> {
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

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

const DFS_FIXED_ATTRS = R_ATTR | W_ATTR;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IDFSDrive {
    readonly name: string;
    readonly option: number;
    readonly title: string;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class DFSState implements IFSState {
    public readonly volume: Volume;

    public drive: string;
    public dir: string;

    public libDrive: string;
    public libDir: string;

    private readonly log: utils.Log;

    public constructor(volume: Volume, log: utils.Log) {
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

    public async getFileForRUN(fsp: FSP, tryLibDir: boolean): Promise<File | undefined> {
        const fspName = mustBeDFSFSP(fsp.name);

        if (fspName.name === undefined) {
            return undefined;
        }

        // Additional DFS rules for tryLibDir.
        if (fspName.drive !== undefined || fspName.dir !== undefined) {
            tryLibDir = false;
        }

        const curFQN = new FQN(fsp.volume, this.volume.handler.createFQN(fspName, this));
        const curFile = await getBeebFile(curFQN, true, false);
        if (curFile !== undefined) {
            return curFile;
        }

        if (tryLibDir) {
            const libFQN = new FQN(fsp.volume, new DFSFQN(this.libDrive, this.libDir, fspName.name));
            const libFile = await getBeebFile(libFQN, true, false);
            if (libFile !== undefined) {
                return libFile;
            }
        }

        return undefined;
    }

    public async getCAT(commandLine: string | undefined): Promise<string> {
        let drive: string;
        if (commandLine === undefined) {
            drive = this.drive;
        } else if (commandLine.length === 1 && utils.isdigit(commandLine)) {
            drive = commandLine;
        } else {
            return errors.badDrive();
        }

        this.log.pn(`*CAT: drive: ${drive}`);
        return await this.volume.handler.getCAT(new FSP(this.volume, false, new DFSFSP(drive, undefined, undefined)), this);
    }

    public starDrive(arg: string | undefined): boolean {
        if (arg === undefined) {
            return errors.badDrive();
        }

        if (arg.length === 1 && utils.isdigit(arg)) {
            this.drive = arg;
        } else {
            const fsp = mustBeDFSFSP(this.volume.handler.parseFileOrDirString(arg, 0, true));
            if (fsp.drive === undefined || fsp.dir !== undefined) {
                return errors.badDrive();
            }

            this.drive = fsp.drive;
        }

        return true;
    }

    public starDir(fsp: FSP): void {
        const dirFQN = this.getDirOrLibFQN(fsp);

        this.drive = dirFQN.drive;
        this.dir = dirFQN.dir;
    }

    public starLib(fsp: FSP): void {
        const libFQN = this.getDirOrLibFQN(fsp);

        this.libDrive = libFQN.drive;
        this.libDir = libFQN.dir;
    }

    public async starDrives(): Promise<string> {
        const drives = await mustBeDFSHandler(this.volume.handler).findDrivesForVolume(this.volume);

        let text = '';

        for (const drive of drives) {
            text += `${drive.name} - ${BOOT_OPTION_DESCRIPTIONS[drive.option & 3].padEnd(4)}: `;

            if (drive.title.length > 0) {
                text += drive.title;
            } else {
                text += '(no title)';
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
        const files = await this.volume.handler.findBeebFilesMatching(this.volume, new DFSFSP(this.drive, this.dir, undefined), undefined);

        const names: string[] = [];
        for (const file of files) {
            const dfsFQN = mustBeDFSFQN(file.fqn.fsFQN);
            names.push(dfsFQN.name);
        }

        return names;
    }

    private getDirOrLibFQN(fsp: FSP): DFSFQN {
        const dfsFSP = mustBeDFSFSP(fsp.name);

        if (fsp.wasExplicitVolume || dfsFSP.name !== undefined) {
            return errors.badDir();
        }

        // the name part is bogus, but it's never used.
        return new DFSFQN(dfsFSP.drive !== undefined ? dfsFSP.drive : this.drive, dfsFSP.dir !== undefined ? dfsFSP.dir : this.dir, '');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class DFSHandler implements IFSType {
    private static isValidFileNameChar(char: string) {
        const c = char.charCodeAt(0);
        return c >= 32 && c < 127;
    }

    public readonly matchAllFSP: IFSFSP = new DFSFSP(undefined, undefined, undefined);

    public createState(volume: Volume, log: utils.Log): IFSState {
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

    public parseFileOrDirString(str: string, i: number, parseAsDir: boolean): DFSFSP {
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
        }

        if (str[i + 1] === '.') {
            if (!DFSHandler.isValidFileNameChar(str[i])) {
                return errors.badDir();
            }

            dir = str[i];
            i += 2;
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

    public async findBeebFilesMatching(volume: Volume, pattern: IFSFQN | IFSFSP, log: utils.Log | undefined): Promise<File[]> {
        let driveNames: string[];
        let dirRegExp: RegExp;
        let nameRegExp: RegExp;

        if (pattern instanceof DFSFQN) {
            driveNames = [pattern.drive];
            dirRegExp = utils.getRegExpFromAFSP(pattern.dir);
            nameRegExp = utils.getRegExpFromAFSP(pattern.name);
        } else if (pattern instanceof DFSFSP) {
            if (pattern.drive !== undefined) {
                driveNames = [pattern.drive];
            } else {
                driveNames = [];
                for (const drive of await this.findDrivesForVolume(volume)) {
                    driveNames.push(drive.name);
                }
            }

            dirRegExp = utils.getRegExpFromAFSP(pattern.dir !== undefined ? pattern.dir : '*');
            nameRegExp = utils.getRegExpFromAFSP(pattern.name !== undefined ? pattern.name : '*');
        } else {
            throw new Error('not DFSFQN or DFSFSP');
        }

        const beebFiles: File[] = [];

        for (const driveName of driveNames) {
            const driveHostPath = path.join(volume.path, driveName);
            const beebFileInfos = await inf.getINFsForFolder(driveHostPath, log);

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

                const file = new File(beebFileInfo.hostPath, new FQN(volume, dfsFQN), beebFileInfo.load, beebFileInfo.exec, beebFileInfo.attr | DFS_FIXED_ATTRS, text);

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

    public async getCAT(fsp: FSP, state: IFSState | undefined): Promise<string> {
        const fspDFSName = mustBeDFSFSP(fsp.name);
        const dfsState = mustBeDFSState(state);

        if (fspDFSName.drive === undefined || fspDFSName.name !== undefined) {
            return errors.badDrive();
        }

        const beebFiles = await this.findBeebFilesMatching(fsp.volume, new DFSFSP(fspDFSName.drive, undefined, undefined), undefined);

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

    public async deleteFile(file: File): Promise<void> {
        try {
            await utils.forceFsUnlink(file.hostPath + inf.ext);
            await utils.forceFsUnlink(file.hostPath);
        } catch (error) {
            FS.throwServerError(error as NodeJS.ErrnoException);
        }
    }

    public async renameFile(oldFile: File, newFQN: FQN): Promise<void> {
        const newFQNDFSName = mustBeDFSFQN(newFQN.fsFQN);

        const newHostPath = path.join(newFQN.volume.path, this.getHostPath(newFQNDFSName));
        await mustNotExist(newHostPath);

        const newFile = new File(newHostPath, newFQN, oldFile.load, oldFile.exec, oldFile.attr, false);

        await this.writeBeebMetadata(newFile.hostPath, newFQNDFSName, newFile.load, newFile.exec, newFile.attr);

        try {
            await utils.fsRename(oldFile.hostPath, newFile.hostPath);
        } catch (error) {
            return FS.throwServerError(error);
        }

        await utils.forceFsUnlink(oldFile.hostPath + inf.ext);
    }

    public async writeBeebMetadata(hostPath: string, fqn: IFSFQN, load: number, exec: number, attr: number): Promise<void> {
        const dfsFQN = mustBeDFSFQN(fqn);

        await inf.writeFile(hostPath, `${dfsFQN.dir}.${dfsFQN.name}`, load, exec, (attr & L_ATTR) !== 0 ? 'L' : '');
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

    public async loadTitle(volume: Volume, drive: string): Promise<string> {
        const buffer = await utils.tryReadFile(path.join(volume.path, drive, TITLE_FILE_NAME));
        if (buffer === undefined) {
            return DEFAULT_TITLE;
        }

        return utils.getFirstLine(buffer).substr(0, MAX_TITLE_LENGTH);
    }

    public async loadBootOption(volume: Volume, drive: string): Promise<number> {
        const buffer = await utils.tryReadFile(path.join(volume.path, drive, OPT4_FILE_NAME));
        if (buffer === undefined || buffer.length === 0) {
            return DEFAULT_BOOT_OPTION;
        }

        return buffer[0] & 3;//ugh.
    }

    public getInfoText(file: File, fileSize: number): string {
        const dfsFQN = mustBeDFSFQN(file.fqn.fsFQN);

        const attr = (file.attr & L_ATTR) !== 0 ? 'L' : ' ';
        const load = utils.hex8(file.load).toUpperCase();
        const exec = utils.hex8(file.exec).toUpperCase();
        const size = utils.hex(fileSize & 0x00ffffff, 6).toUpperCase();

        // 0123456789012345678901234567890123456789
        // _.__________ L 12345678 12345678 123456
        return `${dfsFQN.dir}.${dfsFQN.name.padEnd(10)} ${attr} ${load} ${exec} ${size}`;
    }

    public async findDrivesForVolume(volume: Volume): Promise<IDFSDrive[]> {
        let names: string[];
        try {
            names = await utils.fsReaddir(volume.path);
        } catch (error) {
            return FS.throwServerError(error);
        }

        const drives = [];

        for (const name of names) {
            if (this.isValidDrive(name)) {
                const option = await this.loadBootOption(volume, name);
                const title = await this.loadTitle(volume, name);

                drives.push({ name, option, title });
            }
        }

        return drives;
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

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// there's just the one of these.
const gDFSHandler = new DFSHandler();

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class FS {

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

    public static async findAllVolumes(folders: string[], pcFolders: string[], log: utils.Log | undefined): Promise<Volume[]> {
        return await FS.findVolumes('*', folders, pcFolders, log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async readFile(file: File): Promise<Buffer> {
        try {
            return await utils.fsReadFile(file.hostPath);
        } catch (error) {
            return FS.throwServerError(error);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Logging for this probably isn't proving especially useful. Maybe it
    // should go away?
    private static async findVolumes(afsp: string, folders: string[], pcFolders: string[], log: utils.Log | undefined): Promise<Volume[]> {
        const volumes: Volume[] = [];

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
                            volumeName = utils.getFirstLine(buffer);
                        } else {
                            volumeName = name;
                        }

                        if (FS.isValidVolumeName(volumeName)) {
                            const volume = new Volume(fullName, volumeName, gDFSHandler);
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

    public async parseDirString(dirString: string): Promise<FSP> {
        return await this.parseFileOrDirString(dirString, true);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseFileString(fileString: string): Promise<FSP> {
        return await this.parseFileOrDirString(fileString, false);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async mount(volume: Volume): Promise<void> {
        if (!volume.isReadOnly()) {
            if (this.gaManipulator !== undefined) {
                this.gaManipulator.makeVolumeNotText(volume);
            }
        }

        this.state = volume.handler.createState(volume, this.log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getVolume(): Volume {
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
        let fsp: FSP | undefined;

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
        let fsp: FSP | undefined;

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

    public async findVolumesMatching(afsp: string): Promise<Volume[]> {
        return await FS.findVolumes(afsp, this.folders, this.pcFolders, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async createVolume(name: string): Promise<Volume> {
        if (!FS.isValidVolumeName(name)) {
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
                FS.throwServerError(error);
            }
        }

        try {
            await utils.fsMkdir(path.join(volumePath, '0'));
        } catch (error) {
            FS.throwServerError(error);
        }

        const newVolume = new Volume(volumePath, name, gDFSHandler);
        return newVolume;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseFQN(fileString: string): Promise<FQN> {
        this.log.pn('parseFQN: ``' + fileString + '\'\'');

        const fsp = await this.parseFileString(fileString);
        this.log.pn('    fsp: ' + fsp);

        const fqn = fsp.volume.handler.createFQN(fsp.name, this.state);
        this.log.pn(`    fqn: ${fqn}`);

        return new FQN(fsp.volume, fqn);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async findFilesMatching(fqn: FQN): Promise<File[]> {
        return await fqn.volume.handler.findBeebFilesMatching(fqn.volume, fqn.fsFQN, this.log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getInfoText(file: File): Promise<string> {
        const fileSize = await this.tryGetFileSize(file);

        return file.fqn.volume.handler.getInfoText(file, fileSize);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async starLocate(arg: string): Promise<string[]> {
        const volumes = await this.findVolumesMatching('*');

        const foundPaths: string[] = [];

        for (const volume of volumes) {
            let fsp: IFSFSP;
            try {
                fsp = volume.handler.parseFileOrDirString(arg, 0, false);
            } catch (error) {
                // if the arg wasn't even parseable by this volume's handler, it
                // presumably won't match any file...
                continue;
            }

            const files = await volume.handler.findBeebFilesMatching(volume, fsp, undefined);

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
            let fsp: FSP | undefined;
            try {
                fsp = await this.parseDirString(commandLine);
            } catch (error) {
                // Just ignore, and let the active FS try to re-parse it.
            }

            if (fsp !== undefined) {
                this.log.pn(`*CAT with FSP: ${fsp}`);
                return fsp.volume.handler.getCAT(fsp, this.state);
            }
        }

        this.log.pn(`*CAT with command line: ${commandLine}`);
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
                    return FS.throwServerError(error as NodeJS.ErrnoException);
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
                contentsBuffer = await FS.readFile(file);
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

    public async readTextFile(file: File): Promise<string[]> {
        const b = await FS.readFile(file);

        return utils.splitTextFileLines(b, 'binary');
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // get BeebFile matching FQN, or throw a NotFound. If FQN has wildcards,
    // that's fine, but it's a BadName/'Ambiguous name' if multiple files are
    // matched.
    public async getExistingBeebFileForRead(fqn: FQN): Promise<File> {
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

    public async writeBeebFileMetadata(file: File): Promise<void> {
        try {
            await this.writeBeebMetadata(file.hostPath, file.fqn, file.load, file.exec, file.attr);
        } catch (error) {
            FS.throwServerError(error);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getFileWithModifiedAttributes(file: File, attributeString: string): File {
        const newAttr = file.fqn.volume.handler.getNewAttributes(file.attr, attributeString);
        if (newAttr === undefined) {
            return errors.badAttribute();
        }

        return new File(file.hostPath, file.fqn, file.load, file.exec, newAttr, file.text);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async delete(fqn: FQN): Promise<void> {
        const file = (await getBeebFile(fqn, false, true))!;

        await this.deleteFile(file);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async rename(oldFQN: FQN, newFQN: FQN): Promise<void> {
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

    public async getFileForRUN(fsp: FSP, tryLibDir: boolean): Promise<File> {
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

    private getHostPath(fqn: FQN): string {
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

    private async OSFILELoad(fqn: FQN, load: number, exec: number): Promise<OSFILEResult> {
        const file = await this.getExistingBeebFileForRead(fqn);

        this.mustNotBeOpen(file);

        const data = await FS.readFile(file);

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

        return new OSFILEResult(1, this.createOSFILEBlock(file.load, file.exec, data.length, file.attr), data, dataLoadAddress);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILESave(fqn: FQN, load: number, exec: number, data: Buffer): Promise<OSFILEResult> {
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

    private async writeBeebData(hostPath: string, fqn: FQN, data: Buffer): Promise<void> {
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

    private async writeBeebMetadata(hostPath: string, fqn: FQN, load: number, exec: number, attr: number): Promise<void> {
        await fqn.volume.handler.writeBeebMetadata(hostPath, fqn.fsFQN, load, exec, attr);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // This is never used anywhere where the error case is particularly
    // important.
    private async tryGetFileSize(file: File): Promise<number> {
        const hostStat = await utils.tryStat(file.hostPath);
        if (hostStat === undefined) {
            return 0;
        }

        return hostStat.size;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEWriteMetadata(
        fqn: FQN,
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

        const fileSize = await this.tryGetFileSize(file);

        await this.writeBeebMetadata(file.hostPath, file.fqn, load, exec, attr);

        return new OSFILEResult(1, this.createOSFILEBlock(load, exec, fileSize, attr), undefined, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEReadMetadata(fqn: FQN): Promise<OSFILEResult> {
        const file = await getBeebFile(fqn, true, false);
        if (file === undefined) {
            return new OSFILEResult(0, undefined, undefined, undefined);
        } else {
            const fileSize = await this.tryGetFileSize(file);

            return new OSFILEResult(1, this.createOSFILEBlock(file.load, file.exec, fileSize, file.attr), undefined, undefined);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEDelete(fqn: FQN): Promise<OSFILEResult> {
        const file = await getBeebFile(fqn, true, false);
        if (file === undefined) {
            return new OSFILEResult(0, undefined, undefined, undefined);
        } else {
            const fileSize = await this.tryGetFileSize(file);

            await this.deleteFile(file);

            return new OSFILEResult(1, this.createOSFILEBlock(file.load, file.exec, fileSize, file.attr), undefined, undefined);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async deleteFile(file: File): Promise<void> {
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

    private async OSFILECreate(fqn: FQN, load: number, exec: number, size: number): Promise<OSFILEResult> {
        this.mustBeWriteableVolume(fqn.volume);
        this.mustNotBeTooBig(size);//block.attr - block.size);

        // Cheat.
        return await this.OSFILESave(fqn, load, exec, Buffer.alloc(size));
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Open' error if the file appears to be open.
    private mustNotBeOpen(file: File): void {
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
    private mustBeWriteableFile(file: File | undefined): void {
        if (file !== undefined) {
            if ((file.attr & L_ATTR) !== 0) {
                return errors.locked();
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private mustBeWriteableVolume(volume: Volume): void {
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

    private async parseFileOrDirString(str: string, parseAsDir: boolean): Promise<FSP> {
        if (str === '') {
            return errors.badName();
        }

        let i = 0;
        let volume: Volume;
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

        const fsp = volume.handler.parseFileOrDirString(str, i, parseAsDir);

        return new FSP(volume, wasExplicitVolume, fsp);
    }

    /////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////
}
