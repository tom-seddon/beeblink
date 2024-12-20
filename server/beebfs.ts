//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
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

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_FIRST_FILE_HANDLE, DEFAULT_NUM_FILE_HANDLES } from './beeblink';
import * as utils from './utils';
import * as gitattributes from './gitattributes';
import * as errors from './errors';
import CommandLine from './CommandLine';
import * as server from './server';
import * as inf from './inf';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export const MAX_FILE_SIZE = 0xffffff;

export type FileAddress = number & { 'FileAddress': unknown; };
export type FileAttributes = number & { 'FileAttributes': unknown; };

export const SHOULDNT_LOAD = 0xffffffff as FileAddress;
export const SHOULDNT_EXEC = 0xffffffff as FileAddress;

export const R_ATTR = 1 as FileAttributes;
export const W_ATTR = 2 as FileAttributes;
export const E_ATTR = 4 as FileAttributes;
export const L_ATTR = 8 as FileAttributes;

export const DEFAULT_LOAD = SHOULDNT_LOAD;
export const DEFAULT_EXEC = SHOULDNT_EXEC;

// Attributes used in the absence of any other info.
export const DEFAULT_ATTR = (R_ATTR | W_ATTR) as FileAttributes;

// Attributes used for DFS-style L access.
export const DFS_LOCKED_ATTR = (R_ATTR | L_ATTR) as FileAttributes;

const IGNORE_DIR_FILE_NAME = '.beeblink-ignore';

const VOLUME_FILE_NAME = '.volume';

const ADFS_FILE_NAME = '.adfs';

const SERVER_NAME_ESCAPE_CHAR = '#';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Slightly ugly, but the various FS types depend on this file for base classes.
// TS doesn't support circular dependencies, so this file can't depend on them.
//
// Random tidier-looking idea from google:
// https://medium.com/visual-development/how-to-fix-nasty-circular-dependency-issues-once-and-for-all-in-javascript-typescript-a04c987cf0de
//
// But maybe there's some tidier data-driven mechanism hiding here.

interface IFSTypeRef {
    type: IFSType | undefined;
    name: string;
}

const gDFSType: IFSTypeRef = { type: undefined, name: 'DFS' };
const gPCType: IFSTypeRef = { type: undefined, name: 'PC' };
const gTubeHostType: IFSTypeRef = { type: undefined, name: 'TubeHost' };
const gADFSType: IFSTypeRef = { type: undefined, name: 'ADFS' };

function getFSType(typeRef: IFSTypeRef): IFSType {
    if (typeRef.type === undefined) {
        throw new Error(`${typeRef.name} type not set`);
    }

    return typeRef.type;
}

function setFSType(typeRef: IFSTypeRef, type: IFSType): void {
    if (typeRef.type !== undefined) {
        throw new Error(`${typeRef.name} type already set`);
    }

    typeRef.type = type;
}

export function setFSTypes(dfsType: IFSType, pcType: IFSType, tubeHostType: IFSType, adfsType: IFSType): void {
    setFSType(gDFSType, dfsType);
    setFSType(gPCType, pcType);
    setFSType(gTubeHostType, tubeHostType);
    setFSType(gADFSType, adfsType);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function getBootOptionDescription(option: number): string {
    switch (option & 3) {
        default:
        // fall through
        case 0:
            return 'None';

        case 1:
            return 'LOAD';

        case 2:
            return 'RUN';

        case 3:
            return 'EXEC';
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

const SERVER_NAME_CHARS: string[] = [];

function getEscapedChar(c: number): string {
    return `#${utils.hex2(c)}`;
}

export function getServerCharsForNamePart(str: string): string {
    if (SERVER_NAME_CHARS.length === 0) {
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
            } else if (String.fromCharCode(c) === SERVER_NAME_ESCAPE_CHAR) {
                // the escape char itself.
                escape = true;
            }

            if (escape) {
                SERVER_NAME_CHARS.push(getEscapedChar(c));
            } else {
                SERVER_NAME_CHARS.push(String.fromCharCode(c));
            }
        }
    }

    let result = '';

    for (let i = 0; i < str.length; ++i) {
        const c = str.charCodeAt(i);
        if (c < 0 || c >= SERVER_NAME_CHARS.length) {
            // Answers on postcard please.
            result += '_';
        } else {
            result += SERVER_NAME_CHARS[c];
        }
    }

    return result;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// As above, but for an entire path component. If the result would be one of the
// Windows reserved names, escape it.

// See https://docs.microsoft.com/en-us/windows/desktop/fileio/naming-a-file#file-and-directory-names
const WINDOWS_RESERVED_NAMES = new Set<string>(['CON', 'PRN', 'AUX', 'NUL', 'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);

export function getServerCharsForName(str: string): string {

    let result: string = getServerCharsForNamePart(str);

    if (WINDOWS_RESERVED_NAMES.has(result.toUpperCase())) {
        result = getEscapedChar(result.charCodeAt(0)) + result.substring(1);
    }

    return result;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// While this is not an abstract class, volume types may extend it.
export class FilePath {
    // Volume this FQN refers to. If this.volumeExplicit, the volume was
    // explicitly set (e.g., by being provided as part of the name on the
    // command line); otherwise, it was filled in from the current state.
    public readonly volume: Volume;
    public readonly volumeExplicit: boolean;

    // Not all volume types actually support drives and dirs, but the concept is
    // baked enough into the Beeb way of doing things that they might as well be
    // permanently present.
    public readonly drive: string;
    public readonly driveExplicit: boolean;

    public readonly dir: string;
    public readonly dirExplicit: boolean;

    public constructor(volume: Volume, volumeExplicit: boolean, drive: string, driveExplicit: boolean, dir: string, dirExplicit: boolean) {
        this.volume = volume;
        this.volumeExplicit = volumeExplicit;
        this.drive = drive;
        this.driveExplicit = driveExplicit;
        this.dir = dir;
        this.dirExplicit = dirExplicit;
    }

    // If not undefined, appended as a parenthetical to the result of
    // FilePath.toString or FQN.toString.
    public getFQNSuffix(): string | undefined {
        return undefined;
    }

    public toString(): string {
        let str = `::${this.volume.name}`;

        if (this.drive !== '') {
            str += `:${this.drive}`;
        }

        if (this.dir !== '') {
            str += `.${this.dir}`;
        }

        const suffix = this.getFQNSuffix();
        if (suffix !== undefined) {
            str += ` (${suffix})`;
        }

        return str;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Fully-qualified name of a Beeb file that may or may not exist. 
export class FQN {
    public readonly filePath: FilePath;
    public name: string;

    public constructor(filePath: FilePath, name: string) {
        this.filePath = filePath;
        this.name = name;
    }

    public toString(): string {
        let str = `::${this.filePath.volume.name}`;
        let sep = `:`;

        if (this.filePath.drive !== '') {
            str += `${sep}${this.filePath.drive}`;
            sep = '.';
        }

        if (this.filePath.dir !== '') {
            str += `${sep}${this.filePath.dir}`;
            sep = '.';
        }

        str += `${sep}${this.name}`;

        const suffix = this.filePath.getFQNSuffix();
        if (suffix !== undefined) {
            str += ` (${suffix})`;
        }

        return str;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// "FSObject" - ugh. But there doesn't seem to be any easy way to make
// Typescript let you have a class called "Object".
export abstract class FSObject {
    // Path of the corresponding file or folder on the server filing system.
    public readonly serverPath: string;

    // Actual BBC file or directory name. 
    public readonly fqn: FQN;

    // BBC-style attributes.
    public readonly attr: FileAttributes;

    public constructor(serverPath: string, fqn: FQN, attr: FileAttributes) {
        this.serverPath = serverPath;
        this.fqn = fqn;
        this.attr = attr;
    }

    public async tryGetStats(): Promise<fs.Stats | undefined> {
        return await utils.tryStat(this.serverPath);
    }

    public abstract withModifiedAttributes(_attr: FileAttributes): FSObject;

    // Return placeholder values if the object does not have these properties.
    //
    // This isn't terribly nice, but OSFILE kind of assumes that all objects
    // have these properties, even though they don't.
    public abstract getLoad(): FileAddress;
    public abstract getExec(): FileAddress;
    public abstract tryGetSize(): Promise<number>;

    // As returned by OSFILE.
    public abstract getObjectType(): number;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class File extends FSObject {
    // BBC-style attributes.
    public readonly load: FileAddress;
    public readonly exec: FileAddress;

    public constructor(serverPath: string, fqn: FQN, load: FileAddress, exec: FileAddress, attr: FileAttributes) {
        super(serverPath, fqn, attr);
        this.load = load;
        this.exec = exec;
    }

    public override toString(): string {
        return 'File(serverPath=``' + this.serverPath + '\'\' name=``' + this.fqn + '\'\' load=0x' + utils.hex8(this.load) + ' exec=0x' + utils.hex8(this.exec) + ' attr=0x' + utils.hex8(this.attr);
    }

    // This is never used anywhere where the error case is particularly
    // important.
    public async tryGetSize(): Promise<number> {
        const stats = await this.tryGetStats();
        if (stats === undefined) {
            return 0;
        }

        return stats.size;
    }

    public override withModifiedAttributes(attr: FileAttributes): File {
        return new File(this.serverPath, this.fqn, this.load, this.exec, attr);
    }

    public override getLoad(): FileAddress {
        return this.load;
    }

    public override getExec(): FileAddress {
        return this.exec;
    }

    public override getObjectType(): number {
        return 1;
    }
}

// Helper function for the benefit of the DFS and TubeHost types, for which
// (well, in theory...) the Dir type will never occur.
export function mustBeFile(object: FSObject): File {
    if (!(object instanceof File)) {
        return errors.notAFile();
    }

    return object;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class Dir extends FSObject {
    public constructor(serverPath: string, fqn: FQN, attr: FileAttributes) {
        super(serverPath, fqn, attr);
    }

    public override toString(): string {
        return `Dir(serverPath=\`\`${this.serverPath}'' name=\`\`${this.fqn}'' attr=0x${utils.hex8(this.attr)}`;
    }

    public override withModifiedAttributes(attr: FileAttributes): Dir {
        return new Dir(this.serverPath, this.fqn, attr);
    }

    public override getLoad(): FileAddress {
        // This is what ADFS 2.03 returns.
        return 0 as FileAddress;
    }

    public override getExec(): FileAddress {
        // This is what ADFS 2.03 returns.
        return 0 as FileAddress;
    }

    public override async tryGetSize(): Promise<number> {
        return 0;
    }

    public override getObjectType(): number {
        return 2;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class OpenFile {
    public readonly handle: number;
    public readonly serverPath: string;
    public readonly fqn: FQN;
    public readonly read: boolean;
    public readonly write: boolean;
    public readonly openedAsText: boolean;
    public ptr: number;
    public eofError: boolean;// http://beebwiki.mdfs.net/OSBGET
    public dirty: boolean;

    // I wasn't going to buffer anything originally, but I quickly found it
    // massively simplifies the error handling.
    public readonly contents: number[];

    public constructor(handle: number, serverPath: string, fqn: FQN, read: boolean, write: boolean, openedAsText: boolean, contents: number[]) {
        this.handle = handle;
        this.serverPath = serverPath;
        this.fqn = fqn;
        this.read = read;
        this.write = write;
        this.openedAsText = openedAsText;
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
    public readonly type: IFSType;
    private readOnly: boolean;

    public constructor(volumePath: string, name: string, type: IFSType) {
        this.path = volumePath;
        this.name = name;
        this.type = type;
        this.readOnly = false;
    }

    public isReadOnly(): boolean {
        if (!this.type.canWrite()) {
            return true;
        }

        if (this.readOnly) {
            return true;
        }

        return false;
    }

    public asReadOnly(): Volume {
        const readOnly = new Volume(this.path, this.name, this.type);

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
    public readonly dataLoad: FileAddress | undefined;

    public constructor(fileType: number, block: Buffer | undefined, data: Buffer | undefined, dataLoad: FileAddress | undefined) {
        this.fileType = fileType;
        this.block = block;
        this.data = data;
        this.dataLoad = dataLoad;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Write a file to disk, creating the folder for it if required and throwing a
// suitable BBC-friendly error if something goes wrong.
export async function writeFile(filePath: string, data: Buffer): Promise<void> {
    try {
        await utils.fsMkdirAndWriteFile(filePath, data);
    } catch (error) {
        return errors.nodeError(error);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Maintain any FS-specific state (at least, probably, current drive/dir, lib
// drive/dir...), and handle any stuff that might require that state.
//
// this.volume.type points to the appropriate IFSType.

export interface IFSState {
    readonly volume: Volume;

    // get current drive. (OSGBPB 6 reads this, so it's part of the standard
    // interface.)
    getCurrentDrive: () => string;

    // get current directory. (OSGBPB 6 reads this, so it's part of the standard
    // interface.)
    getCurrentDir: () => string;

    // get library drive. (OSGBPB 7 reads this, so it's part of the standard
    // interface.)
    getLibraryDrive: () => string;

    // get library directory. (OSGBPB 7 reads this, so it's part of the standard
    // interface.)
    getLibraryDir: () => string;

    // get object holding current transient settings that would be reset on
    // Ctrl+Break - drive/dir, lib drive/dir, and so on. Use when recreating the
    // state, to restore the current settings.
    //
    // The naming is crappy because 'state' was already taken.
    getTransientSettings: () => unknown;

    // turns transient settings into a human-readable string for printing on the
    // Beeb. This isn't a toString on an interface type, so the FS state has the
    // option of printing something useful out when there's no state.
    getTransientSettingsString: (transientSettings: unknown) => string;

    // get object holding current persistent settings, that would not be reset
    // on Ctrl+Break - drive assignments, and so on. Use when recreating the
    // state, to restore the current settings.
    getPersistentSettings: () => unknown;

    // turns persistent settings into a human-readable string for printing on
    // the Beeb.
    getPersistentSettingsString: (persistentSettings: unknown) => string;

    // get file to use for *RUN. If tryLibDir is false, definitely don't try lib
    // drive/directory.
    getFileForRUN: (fqn: FQN, tryLibDir: boolean) => Promise<File | undefined>;

    // get *CAT text, given command line. Handle default case, when
    // commandLine===undefined, and any straightforward special cases that would
    // otherwise be ambiguous (e.g., drives in DFS/ADFS), returning *CAT string.
    // Or return undefined otherwise.
    //
    // If returning undefined, the BeebFS class will try to interpret the
    // command line as a FSP and use the resulting volume's handler type to
    // catalogue an appropriate drive based on that.
    getCAT: (commandLine: string | undefined) => Promise<string | undefined>;

    // handle *DRIVE/*MOUNT.
    starDrive: (arg: string | undefined) => void;

    // handle *DIR.
    starDir: (filePath: FilePath | undefined) => void;

    // handle *LIB.
    starLib: (filePath: FilePath | undefined) => void;

    // handle *HSTATUS drives output.
    getDrivesOutput: () => Promise<string>;

    // read boot option, for OSGBPB 5 or SHIFT+BREAK.
    getBootOption: () => Promise<number>;

    // handle *OPT 4.
    setBootOption: (option: number) => Promise<void>;

    // handle *TITLE.
    setTitle: (title: string) => Promise<void>;

    // read title, for OSGBPB 5.
    getTitle: () => Promise<string>;

    // read names, for OSGBPB 6.
    readNames: () => Promise<string[]>;

    // return list of type-specific commands.
    //
    // This is only called when the FS type potentially changes, so it's OK if
    // it does something expensive.
    getCommands: () => server.Command[];
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Result of a rename operation. The information is used by the gitattributes
// manipulator, so only relevant for file renames. (If a folder is renamed, any
// .gitattributes file inside it remains valid.)
export interface IRenameFileResult {
    oldServerPath: string;
    newServerPath: string;
}

// Handle FS-specific stuff that doesn't require any state.

export interface IFSType {
    readonly name: string;

    // create new state for this type of FS.
    createState: (volume: Volume, transientSettings: unknown, persistentSettings: unknown, log: utils.Log | undefined) => Promise<IFSState>;

    // whether this FS supports writing.
    canWrite: () => boolean;

    // Handle *LOCATE: get list of all Beeb files in volume matching explicit
    // parts of FQN. Treat implicit drive/dir values as matching anything.
    // Always recursive when appropriate. Does not return information about
    // directories.
    //
    // (As well as being recursive, this entry point differs from
    // findObjectsMatching in that it may discover files that aren't directly
    // accessible via a Beeb path, but could become so by arrangement. TubeHost
    // files are like this.)
    locateBeebFiles: (fqn: FQN, log: utils.Log | undefined) => Promise<File[]>;

    // get list of Beeb files/dirs matching FQN. Used for generally finding files in
    // a specific drive/directory, non-recursively, e.g., for finding the file
    // that matches a name, or handling *CAT.
    //
    // The volume will be of the right type. Drive and directory wildcards don't
    // have to work.
    findObjectsMatching: (fqn: FQN, log: utils.Log | undefined) => Promise<FSObject[]>;

    // parse file/dir string, starting at index i. 
    parseFileString: (str: string, i: number, state: IFSState | undefined, volume: Volume, volumeExplicit: boolean) => FQN;
    parseDirString: (str: string, i: number, state: IFSState | undefined, volume: Volume, volumeExplicit: boolean) => FilePath;

    // get ideal server path for FQN, relative to whichever volume it's in. Used
    // when creating a new file.
    getIdealVolumeRelativeServerPath: (fqn: FQN) => Promise<string>;

    // get *CAT text.
    getCAT: (filePath: FilePath, state: IFSState | undefined, log: utils.Log | undefined) => Promise<string>;

    // delete the given file.
    deleteFile: (file: File) => Promise<void>;

    // rename the given entry. The volume won't change. The new name doesn't
    // obviously exist.
    //
    // If a file rename, return old and new file paths on the server, so the
    // gitattributes manipulator can sort it out. Otherwise, return undefined.
    rename: (oldFQN: FQN, newName: FQN) => Promise<IRenameFileResult | undefined>;

    // write the metadata for the given file.
    writeBeebMetadata: (serverPath: string, fqn: FQN, load: FileAddress, exec: FileAddress, attr: FileAttributes) => Promise<void>;

    // get new attributes from attribute string. Return undefined if invalid.
    getNewAttributes: (oldAttr: FileAttributes, attrString: string) => FileAttributes | undefined;

    // get *INFO/*EX/*WINFO text for the given file. Show name, attributes and
    // metadata. Don't append newline - that will be added automatically.
    getInfoText: (object: FSObject, wide: boolean) => Promise<string>;

    // get *INFO/*EX-style attributes string for the given file.
    //
    // A return value of undefined indicates that attributes aren't relevant for
    // the current FS. (What's the value of distinguishing this from ''? TBC...)
    getAttrString: (object: FSObject) => string | undefined;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function getObjectInternal(fqn: FQN, wildcardsOK: boolean, log: utils.Log | undefined): Promise<FSObject | undefined> {
    if (!wildcardsOK) {
        if (utils.isAmbiguousAFSP(fqn.filePath.drive) ||
            utils.isAmbiguousAFSP(fqn.filePath.dir) ||
            utils.isAmbiguousAFSP(fqn.name)) {
            return errors.badName();
        }
    }

    const files = await fqn.filePath.volume.type.findObjectsMatching(fqn, log);
    log?.pn(`found ${files.length} file(s)`);

    if (files.length === 0) {
        return undefined;
    } else if (files.length === 1) {
        return files[0];
    } else {
        return errors.ambiguousName();
    }
}

// get single BeebFile matching the given fqn.
//
// If wildcardsOK, wildcards are acceptable, but the pattern must match exactly
// one file - will throw BadName/'Ambiguous name' if not.
//
// If file not found: getBeebFile returns undefined, mustGetBeebFile raises a
// File not found error.
export async function getObject(fqn: FQN, wildcardsOK: boolean, log: utils.Log | undefined): Promise<FSObject | undefined> {
    log?.pn(`getObject: ${fqn}; wildCardsOK = ${wildcardsOK} `);
    return getObject(fqn, wildcardsOK, log);
}

export async function mustGetObject(fqn: FQN, wildcardsOK: boolean, log: utils.Log | undefined): Promise<FSObject> {
    log?.pn(`mustGetObject: ${fqn}; wildCardsOK = ${wildcardsOK} `);
    const object = await getObject(fqn, wildcardsOK, log);
    if (object === undefined) {
        return errors.notFound();
    }

    return object;
}

export async function getBeebFile(fqn: FQN, wildcardsOK: boolean, log: utils.Log | undefined): Promise<File | undefined> {
    log?.pn(`getBeebFile: ${fqn}; wildCardsOK = ${wildcardsOK} `);
    const object = await getObjectInternal(fqn, wildcardsOK, log);
    if (object === undefined || object instanceof File) {
        return object;
    } else {
        return mustBeFile(object);
    }
}

export async function mustGetBeebFile(fqn: FQN, wildcardsOK: boolean, log: utils.Log | undefined): Promise<File> {
    log?.pn(`mustGetBeebFile: ${fqn}; wildCardsOK = ${wildcardsOK} `);
    const file = await getBeebFile(fqn, wildcardsOK, log);
    if (file === undefined) {
        return errors.notFound();
    }

    return file;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export interface IFSSearchFolders {
    // Folders to search for BeebLink volumes.
    beebLinkSearchFolders: string[];

    // Folders to use as PC volumes.
    pcFolders: string[];

    // Folders to use as TubeHost volumes.
    tubeHostFolders: string[];

    // Regexps of folders to exclude when searching. (This is a bit of a hack,
    // for use when I'm testing stuff and it's annoying having loads of
    // volumes...)
    pathExcludeRegExps: RegExp[];
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class FS {

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private searchFolders: IFSSearchFolders;

    //private currentVolume: BeebVolume | undefined;

    private firstFileHandle: number;
    private openFiles: (OpenFile | undefined)[];

    private log: utils.Log | undefined;

    private state: IFSState | undefined;
    private stateCommands: undefined | server.Command[];
    private defaultTransientSettings: unknown;

    private gaManipulator: gitattributes.Manipulator | undefined;

    private locateVerbose: boolean;

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public constructor(
        searchFolders: IFSSearchFolders,
        gaManipulator: gitattributes.Manipulator | undefined,
        log: utils.Log | undefined,
        locateVerbose: boolean) {
        this.log = log;

        this.searchFolders = searchFolders;

        //this.resetDirs();

        this.openFiles = [];
        this.firstFileHandle = DEFAULT_FIRST_FILE_HANDLE;
        for (let i = 0; i < DEFAULT_NUM_FILE_HANDLES; ++i) {
            this.openFiles.push(undefined);
        }

        this.gaManipulator = gaManipulator;
        this.locateVerbose = locateVerbose;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async findAllVolumes(searchFolders: IFSSearchFolders, log: utils.Log | undefined): Promise<Volume[]> {
        return await FS.findVolumes('*', false, searchFolders, log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async readFile(file: File): Promise<Buffer> {
        try {
            return await utils.fsReadFile(file.serverPath);
        } catch (error) {
            return errors.nodeError(error);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async writeFile(file: File, data: Buffer): Promise<void> {
        try {
            FS.mustBeWriteableFile(file);
            FS.mustNotBeTooBig(data.length);

            await writeFile(file.serverPath, data);
        } catch (error) {
            return errors.nodeError(error);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Too big' error if the value is larger than the max file size.
    private static mustNotBeTooBig(amount: number): void {
        if (amount > MAX_FILE_SIZE) {
            return errors.tooBig();
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Object is a dir: 'Exists'
    //
    // Object is a locked file: 'Locked'
    private static mustBeWriteableFile(object: FSObject | undefined): void {
        if (object !== undefined) {
            if (!(object instanceof File)) {
                return errors.exists();
            }

            if ((object.attr & L_ATTR) !== 0) {
                return errors.locked();
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private static mustBeWriteableVolume(volume: Volume): void {
        if (volume.isReadOnly()) {
            return errors.volumeReadOnly();
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Logging for this probably isn't proving especially useful. Maybe it
    // should go away?
    //
    // If findFirstMatchingVolume is true, the search will early out once the
    // result is clear: that is, is if the volume spec is unambiguous, when the
    // first matching volume is found, indicating the search is complete; or, if
    // the volume spec is ambiguous, when the second matching volume is found,
    // indicating the search is ambiguous.
    private static async findVolumes(afsp: string, findFirstMatchingVolume: boolean, searchFolders: IFSSearchFolders, log: utils.Log | undefined): Promise<Volume[]> {
        const volumes: Volume[] = [];

        const volumeNameRegExp = utils.getRegExpFromAFSP(afsp);
        const ambiguous = utils.isAmbiguousAFSP(afsp);

        const beebLinkIgnoreFolders = new Set<string>();
        const addIgnoreFolders = (folders: string[]) => {
            for (const folder of folders) {
                beebLinkIgnoreFolders.add(utils.getSeparatorAndCaseNormalizedPath(folder));
            }
        };
        addIgnoreFolders(searchFolders.pcFolders);
        addIgnoreFolders(searchFolders.tubeHostFolders);

        // Adds volume with given properties, if it looks valid and fulfils the criteria.
        //
        // Returns true if the find process should finish early.
        function addVolume(volumePath: string, volumeName: string, volumeType: IFSType): boolean {
            if (!FS.isValidVolumeName(volumeName)) {
                return false;
            }

            if (volumeNameRegExp.exec(volumeName) === null) {
                return false;
            }

            for (const regExp of searchFolders.pathExcludeRegExps) {
                if (regExp.exec(volumePath) !== null) {
                    return false;
                }
            }

            volumes.push(new Volume(volumePath, volumeName, volumeType));

            if (findFirstMatchingVolume) {
                if (ambiguous) {
                    if (volumes.length === 2) {
                        return true;
                    }
                } else {
                    if (volumes.length === 1) {
                        return true;
                    }
                }
            }

            return false;
        }

        const findBeebLinkVolumesMatchingRecursive = async (folderPath: string, indent: string): Promise<boolean> => {
            log?.pn(indent + 'Looking in: ' + folderPath + '...');

            let names: string[];
            try {
                names = await utils.fsReaddir(folderPath);
            } catch (error) {
                process.stderr.write('WARNING: failed to read files in folder: ' + folderPath + '\n');
                log?.pn('Error was: ' + error);
                return false;
            }

            const subfolderPaths: string[] = [];

            let useDir = true;
            for (const name of names) {
                if (utils.getCaseNormalizedPath(name) === IGNORE_DIR_FILE_NAME) {
                    useDir = false;
                    break;
                }
            }

            if (useDir) {
                for (const name of names) {
                    if (name[0] === '.') {
                        continue;
                    }

                    const volumePath = path.join(folderPath, name);

                    if (beebLinkIgnoreFolders.has(utils.getSeparatorAndCaseNormalizedPath(volumePath))) {
                        // Folder explicitly added as some other type - don't look inside.
                        continue;
                    }

                    const stat = await utils.tryStat(volumePath);
                    if (stat !== undefined && stat.isDirectory()) {
                        const stat0 = await utils.tryStat(path.join(volumePath, '0'));
                        if (stat0 === undefined) {
                            // obviously not a BeebLink volume, so save for later.
                            subfolderPaths.push(volumePath);
                        } else if (stat0.isDirectory()) {
                            let volumeName: string;
                            const buffer = await utils.tryReadFile(path.join(volumePath, VOLUME_FILE_NAME));
                            if (buffer !== undefined) {
                                volumeName = utils.getFirstLine(buffer);
                            } else {
                                volumeName = name;
                            }

                            let volumeType: IFSType;
                            if (await utils.tryReadFile(path.join(volumePath, ADFS_FILE_NAME)) !== undefined) {
                                volumeType = getFSType(gADFSType);
                            } else {
                                volumeType = getFSType(gDFSType);
                            }

                            if (addVolume(volumePath, volumeName, volumeType)) {
                                return true;
                            }
                        }
                    }
                }

                for (const subfolderPath of subfolderPaths) {
                    if (await findBeebLinkVolumesMatchingRecursive(subfolderPath, indent + '    ')) {
                        return true;
                    }
                }
            }

            return false;
        };

        for (const folder of searchFolders.beebLinkSearchFolders) {
            if (await findBeebLinkVolumesMatchingRecursive(folder, '')) {
                return volumes;
            }
        }

        // returns true if done.
        function addFolders(folders: string[], type: IFSType): boolean {
            for (const folder of folders) {
                if (addVolume(folder, path.basename(folder), type)) {
                    return true;
                }
            }

            return false;
        }

        if (addFolders(searchFolders.pcFolders, getFSType(gPCType))) {
            return volumes;
        }

        if (addFolders(searchFolders.tubeHostFolders, getFSType(gTubeHostType))) {
            return volumes;
        }

        return volumes;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Valid volume names are 7-bit ASCII, no spaces, no '/' or ':'. If you want
    // £, use `.
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

            if (!(c >= 32 && c < 127)) {
                return false;
            } else if (name[i] === ':' || name[i] === '/') {
                return false;
            }
        }

        return true;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getCommands(): server.Command[] {
        if (this.stateCommands === undefined) {
            if (this.state === undefined) {
                return [];
            }

            this.stateCommands = this.state.getCommands();
        }

        return this.stateCommands;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseDirString(dirString: string): Promise<FilePath> {
        const parseVolumeResult = await this.parseVolumeString(dirString);

        return parseVolumeResult.volume.type.parseDirString(dirString, parseVolumeResult.i, this.getState(), parseVolumeResult.volume, parseVolumeResult.volumeExplicit);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseFileString(fileString: string): Promise<FQN> {
        const parseVolumeResult = await this.parseVolumeString(fileString);

        return parseVolumeResult.volume.type.parseFileString(fileString, parseVolumeResult.i, this.getState(), parseVolumeResult.volume, parseVolumeResult.volumeExplicit);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async mount(volume: Volume): Promise<void> {
        if (!volume.isReadOnly()) {
            if (this.gaManipulator !== undefined) {
                this.gaManipulator.makeVolumeNotText(volume);
            }
        }

        this.setState(await volume.type.createState(volume, undefined, undefined, this.log));
        this.resetDefaults();
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getVolume(): Volume {
        return this.getState().volume;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public setDefaults(): void {
        if (this.state === undefined) {
            return errors.discFault('No volume');
        } else {
            this.defaultTransientSettings = this.state.getTransientSettings();
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public resetDefaults(): void {
        this.defaultTransientSettings = undefined;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getDefaultsString(): string {
        if (this.state === undefined) {
            return errors.discFault('No volume');
        } else {
            return this.state.getTransientSettingsString(this.defaultTransientSettings);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Reset dirs and close open files.
    public async reset() {
        if (this.state !== undefined) {
            const persistentSettings = this.state.getPersistentSettings();
            this.setState(await this.state.volume.type.createState(this.state.volume, this.defaultTransientSettings, persistentSettings, this.log));
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
        let filePath: FilePath | undefined;

        if (arg !== undefined) {
            filePath = await this.parseDirString(arg);

            if (filePath.volumeExplicit) {
                await this.mount(filePath.volume);
            }
        }

        this.getState().starDir(filePath);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async starLib(arg: string | undefined): Promise<void> {
        let filePath: FilePath | undefined;

        if (arg !== undefined) {
            filePath = await this.parseDirString(arg);

            if (filePath.volumeExplicit) {
                return errors.badDir();
            }
        }

        this.getState().starLib(filePath);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getDrivesOutput(): Promise<string> {
        return await this.getState().getDrivesOutput();
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Finds all volumes matching the given afsp.
    public async findAllVolumesMatching(afsp: string): Promise<Volume[]> {
        return await FS.findVolumes(afsp, false, this.searchFolders, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // If afsp is unambiguous, finds first volume matching, if any.
    //
    // If afsp is ambiguous, finds single volume matching it, or two volumes
    // that match it (no matter how many other volumes might also match).
    public async findFirstVolumeMatching(afsp: string): Promise<Volume[]> {
        return await FS.findVolumes(afsp, true, this.searchFolders, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async createVolume(name: string): Promise<Volume> {
        if (!FS.isValidVolumeName(name)) {
            return errors.badName();
        }

        // This check is a bit crude, but should catch obvious problems...
        const volumePath = path.join(this.searchFolders.beebLinkSearchFolders[0], name);
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
            if (errors.getErrno(error) !== 'EEXIST') {
                errors.nodeError(error);
            }
        }

        try {
            await utils.fsMkdir(path.join(volumePath, '0'));
        } catch (error) {
            errors.nodeError(error);
        }

        const newVolume = new Volume(volumePath, name, getFSType(gDFSType));
        return newVolume;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async findObjectsMatching(fqn: FQN): Promise<FSObject[]> {
        return fqn.filePath.volume.type.findObjectsMatching(fqn, this.log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getInfoText(object: FSObject, wide: boolean): Promise<string> {
        return await object.fqn.filePath.volume.type.getInfoText(object, wide);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getAttrString(file: File): string | undefined {
        return file.fqn.filePath.volume.type.getAttrString(file);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async starLocate(arg: string): Promise<File[]> {
        const volumes = await this.findAllVolumesMatching('*');

        const foundFiles: File[] = [];

        if (this.locateVerbose) {
            this.log?.pn(`starLocate: arg=\`\`${arg}''`);
        }

        for (let volumeIdx = 0; volumeIdx < volumes.length; ++volumeIdx) {
            const volume = volumes[volumeIdx];

            if (this.locateVerbose) {
                this.log?.pn(`Volume ${1 + volumeIdx}/${volumes.length}: ${volume.name}: ${volume.path}`);
            }

            try {
                if (this.locateVerbose) {
                    this.log?.inN(2);
                }

                let fqn: FQN;
                try {
                    fqn = volume.type.parseFileString(arg, 0, undefined, volume, true);
                } catch (error) {
                    // if the arg wasn't even parseable by this volume's type, it
                    // presumably won't match any file...
                    continue;
                }

                const files = await volume.type.locateBeebFiles(fqn, this.locateVerbose ? this.log : undefined);

                for (const file of files) {
                    foundFiles.push(file);
                }
            } finally {
                if (this.locateVerbose) {
                    this.log?.out();
                }
            }
        }

        return foundFiles;
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

            if (openFile.openedAsText) {
                text += ' (text)';
            }

            text += ' PTR#=&' + utils.hex8(openFile.ptr) + ' EXT#=&' + utils.hex8(openFile.contents.length) + ' - ' + openFile.serverPath + utils.BNL;
        }

        if (!anyOpen) {
            text += 'No files open' + utils.BNL;
        }

        return text;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getCAT(commandLine: string | undefined): Promise<string> {
        const catString = await this.getState().getCAT(commandLine);
        if (catString !== undefined) {
            return catString;
        }

        // IFSState.getCAT must handle the undefined case itself.
        if (commandLine === undefined) {
            return errors.generic('*CAT internal error');
        }

        const fqn = await this.parseDirString(commandLine);

        let state: IFSState | undefined = this.getState();
        if (fqn.volumeExplicit) {
            state = undefined;
        }

        return await fqn.volume.type.getCAT(fqn, state, this.log);
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

    // If EOF, returns [] (exit OSBGET with C=1) or raises an error.
    //
    // Otherwise, returns 1 byte, plus the read-ahead bytes. (The read-ahead
    // bytes are in addition, so when maxNumReadaheadBytes===0, 1 byte in total
    // is returned.)
    public OSBGETWithReadahead(handle: number, maxNumReadaheadBytes: number): number[] {
        // Defer to OSBGET for the first byte. This will also cover the two EOF
        // cases.
        const firstResult = this.OSBGET(handle);
        if (firstResult === undefined) {
            return [];
        }

        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        const bytes = [firstResult];
        for (let i = openFile.ptr; i < openFile.contents.length && bytes.length < 1 + maxNumReadaheadBytes; ++i) {
            bytes.push(openFile.contents[i]);
        }

        return bytes;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public OSBGETConsumeReadahead(handle: number): void {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        if (openFile.ptr < openFile.contents.length) {
            ++openFile.ptr;
        } else {
            return errors.generic(`EOF in readahead`);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public OSBPUT(handle: number, byte: number): number {
        const openFile = this.mustBeOpen(this.getOpenFileByHandle(handle));

        this.mustBeOpenForWrite(openFile);

        this.bputInternal(openFile, byte);

        return openFile.ptr;
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

        const fqn = await this.parseFileString(commandLine.parts[0]);

        if (a === 0) {
            return await this.OSFILESave(fqn, block.readUInt32LE(0) as FileAddress, block.readUInt32LE(4) as FileAddress, data);
        } else if (a >= 1 && a <= 4) {
            return await this.OSFILEWriteMetadata(fqn,
                a === 1 || a === 2 ? block.readUInt32LE(0) as FileAddress : undefined,
                a === 1 || a === 3 ? block.readUInt32LE(4) as FileAddress : undefined,
                a === 1 || a === 4 ? block.readUInt32LE(12) as FileAttributes : undefined);
        } else if (a === 5) {
            return await this.OSFILEReadMetadata(fqn);
        } else if (a === 6) {
            return await this.OSFILEDelete(fqn);
        } else if (a === 7) {
            return await this.OSFILECreate(fqn,
                block.readUInt32LE(0) as FileAddress,
                block.readUInt32LE(4) as FileAddress,
                block.readUInt32LE(12) - block.readUInt32LE(8));
        } else if (a === 255) {
            return await this.OSFILELoad(fqn,
                block.readUInt32LE(0) as FileAddress,
                block.readUInt8(4) !== 0);
        } else {
            throw new errors.BeebError(255, 'Unhandled OSFILE: &' + utils.hex2(a));
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // The OSFIND file name is not actually a file name, but a command line
    // string, the first arg of which is the file name. (When doing a *SRLOAD,
    // for example, the MOS just hands the whole command line to OSFIND.)
    //
    // If textPrefix is not undefined, the file is opened as text (see docs),
    // and the prefix lines - if any - prepended as if those lines were read
    // from the start of the file.
    //
    // If textPrefix is undefined, the file is opened as binary.
    public async OSFINDOpen(mode: number, nameString: string, textPrefix: string[] | undefined): Promise<number> {
        const commandLine = new CommandLine(nameString);
        if (commandLine.parts.length === 0) {
            return errors.badName();
        }

        this.log?.pn('OSFIND: mode=$' + utils.hex2(mode) + ' nameString=``' + nameString + '\'\'');

        const index = this.openFiles.indexOf(undefined);
        if (index < 0) {
            return errors.tooManyOpen();
        }

        const write = (mode & 0x80) !== 0;
        const read = (mode & 0x40) !== 0;

        const fqn = await this.parseFileString(commandLine.parts[0]);
        let serverPath: string;

        if (textPrefix !== undefined && write) {
            // Should never see this!
            return errors.generic('Can\'t open text file for write');
        }

        let contentsBuffer: Buffer | undefined;
        const file = await getBeebFile(fqn, read && !write, this.log);
        if (file !== undefined) {
            // Files can be opened once for write, or multiple times for read.
            {
                for (let otherIndex = 0; otherIndex < this.openFiles.length; ++otherIndex) {
                    const otherOpenFile = this.openFiles[otherIndex];
                    if (otherOpenFile !== undefined) {
                        if (otherOpenFile.serverPath === file.serverPath) {
                            if (otherOpenFile.write || write) {
                                this.log?.pn(`        already open: handle=0x${this.firstFileHandle + otherIndex}`);
                                return errors.open();
                            }
                        }
                    }
                }
            }

            this.log?.pn('        serverPath=``' + file.serverPath + '\'\'');
            this.log?.pn('        openAsText=' + (textPrefix !== undefined));

            // File exists.
            serverPath = file.serverPath;

            if (write) {
                FS.mustBeWriteableVolume(fqn.filePath.volume);
                FS.mustBeWriteableFile(file);
            }

            if (write && !read) {
                // OPENOUT of file that exists. Zap the contents first.
                try {
                    await utils.fsTruncate(file.serverPath);
                } catch (error) {
                    return errors.nodeError(error as NodeJS.ErrnoException);
                }
            }

            if (textPrefix !== undefined) {
                // Not efficient, but I don't think it matters...
                const lines = await this.readTextFile(file);

                let linesString = '';

                for (const line of textPrefix) {
                    linesString += line + '\x0d';
                }

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

            serverPath = await this.getServerPath(fqn);
            await inf.mustNotExist(serverPath);

            // Create file.
            await this.OSFILECreate(fqn, SHOULDNT_LOAD, SHOULDNT_EXEC, 0);
        }

        const contents: number[] = [];
        if (contentsBuffer !== undefined) {
            for (const byte of contentsBuffer) {
                contents.push(byte);
            }
        }

        const openFile = new OpenFile(this.firstFileHandle + index, serverPath, fqn, read, write, textPrefix !== undefined, contents);
        this.openFiles[index] = openFile;
        this.log?.pn(`        handle=0x${openFile.handle}`);
        return openFile.handle;
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
        return mustGetBeebFile(fqn, true, this.log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // get File matching FQN, that must be writeable.
    public async getBeebFileForWrite(fqn: FQN): Promise<File> {
        FS.mustBeWriteableVolume(fqn.filePath.volume);

        let file = await getBeebFile(fqn, false, this.log);
        if (file !== undefined) {
            this.mustNotBeOpen(file);
        } else {
            file = new File(await this.getServerPath(fqn), fqn, SHOULDNT_LOAD, SHOULDNT_EXEC, DEFAULT_ATTR);
        }

        FS.mustBeWriteableFile(file);

        return file;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async OPT(x: number, y: number): Promise<void> {
        if (x === 4) {
            const state = this.getState();

            FS.mustBeWriteableVolume(state.volume);

            await state.setBootOption(y & 3);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async setTitle(title: string): Promise<void> {
        const state = this.getState();

        FS.mustBeWriteableVolume(state.volume);

        await state.setTitle(title);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async writeBeebFileMetadata(object: FSObject): Promise<void> {
        try {
            await this.writeBeebMetadata(object.serverPath, object.fqn, object.getLoad(), object.getExec(), object.attr);
        } catch (error) {
            errors.nodeError(error);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getModifiedAttributesForObject(object: FSObject, attributeString: string): FileAttributes | undefined {
        return object.fqn.filePath.volume.type.getNewAttributes(object.attr, attributeString);
        // if (newAttr === undefined) {
        //     return errors.badAttribute();
        // }

        // // const newObject=

        // // if (object instanceof File) {
        // //     return new File(object.serverPath, object.fqn, object.load, object.exec, newAttr);
        // // } else if (object instanceof Dir) {
        // //     return new Dir(object.serverPath, object.fqn, newAttr);
        // // } else {
        // //     return errors.notAFile();//TODO...
        // // }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async delete(fqn: FQN): Promise<void> {
        const object = await mustGetObject(fqn, false, this.log);

        await this.deleteObject(object);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async rename(oldFQN: FQN, newFQN: FQN): Promise<void> {
        this.log?.pn('oldFQN: ' + oldFQN);
        this.log?.pn('newFQN: ' + newFQN);

        if (!oldFQN.filePath.volume.equals(newFQN.filePath.volume)) {
            return errors.badDrive();
        }

        if (await getBeebFile(newFQN, false, this.log) !== undefined) {
            return errors.exists();
        }

        //const oldFile = await mustGetBeebFile(oldFQN, false, this.log);

        const renameFileResult = await oldFQN.filePath.volume.type.rename(oldFQN, newFQN);

        if (this.gaManipulator !== undefined && renameFileResult !== undefined) {
            if (!newFQN.filePath.volume.isReadOnly()) {
                this.gaManipulator.renameFile(renameFileResult.oldServerPath, renameFileResult.newServerPath);
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getFileForRUN(fqn: FQN, tryLibDir: boolean): Promise<File> {
        if (fqn.filePath.volumeExplicit) {
            // Definitely don't try lib drive/dir if volume was specified.
            tryLibDir = false;
        }

        const file = await this.getState().getFileForRUN(fqn, tryLibDir);

        if (file !== undefined) {
            return file;
        }

        return errors.badCommand();
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async setFileHandleRange(firstFileHandle: number, numFileHandles: number): Promise<void> {
        this.log?.pn(`Set file handle range: first handle = 0x${utils.hex2(firstFileHandle)}, num handles = ${numFileHandles}`);

        if (firstFileHandle <= 0 || numFileHandles < 1 || firstFileHandle + numFileHandles > 256) {
            this.log?.pn(`Ignoring invalid settings.`);
        } else {
            if (firstFileHandle !== this.firstFileHandle || numFileHandles !== this.openFiles.length) {
                this.log?.pn(`Settings have changed - closing any open files.`);
                try {
                    await this.closeAllFiles();
                } catch (error) {
                    this.log?.pn(`Ignoring closeAllFiles error: ${error}`);
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

    public async copy(src: File, dest: FQN): Promise<void> {
        this.mustNotBeOpen(src);
        FS.mustBeWriteableVolume(dest.filePath.volume);

        const data = await FS.readFile(src);

        await this.saveFile(dest, src.load, src.exec, src.attr, data);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private setState(state: IFSState): void {
        this.state = state;
        this.stateCommands = undefined;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async getServerPath(fqn: FQN): Promise<string> {
        return path.join(fqn.filePath.volume.path, await fqn.filePath.volume.type.getIdealVolumeRelativeServerPath(fqn));
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private createOSFILEBlock(load: FileAddress, exec: FileAddress, size: number, attr: FileAttributes): Buffer {
        const b = Buffer.alloc(16);

        b.writeUInt32LE(load, 0);
        b.writeUInt32LE(exec, 4);
        b.writeUInt32LE(size, 8);
        b.writeUInt32LE(attr, 12);

        return b;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILELoad(fqn: FQN, load: FileAddress, useFileLoadAddress: boolean): Promise<OSFILEResult> {
        const file = await this.getExistingBeebFileForRead(fqn);

        this.mustNotBeOpen(file);

        const data = await FS.readFile(file);

        FS.mustNotBeTooBig(data.length);

        let dataLoadAddress;
        if (useFileLoadAddress) {
            dataLoadAddress = file.load;

            if (file.load === SHOULDNT_LOAD) {
                return errors.wont();
            }
        } else {
            dataLoadAddress = load;
        }

        return new OSFILEResult(1, this.createOSFILEBlock(file.load, file.exec, data.length, file.attr), data, dataLoadAddress);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILESave(fqn: FQN, load: FileAddress, exec: FileAddress, data: Buffer): Promise<OSFILEResult> {
        const attr = DEFAULT_ATTR;
        await this.saveFile(fqn, load, exec, attr, data);
        return new OSFILEResult(1, this.createOSFILEBlock(load, exec, data.length, attr), undefined, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async saveFile(fqn: FQN, load: FileAddress, exec: FileAddress, attr: FileAttributes, data: Buffer): Promise<void> {
        FS.mustBeWriteableVolume(fqn.filePath.volume);
        FS.mustNotBeTooBig(data.length);

        let serverPath: string;

        const object = await getObject(fqn, false, this.log);
        if (object !== undefined) {
            this.mustNotBeOpen(object);
            FS.mustBeWriteableFile(object);

            serverPath = object.serverPath;
        } else {
            serverPath = await this.getServerPath(fqn);

            await inf.mustNotExist(serverPath);
        }

        await this.writeBeebData(serverPath, fqn, data);
        await this.writeBeebMetadata(serverPath, fqn, load, exec, attr);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async writeBeebData(serverPath: string, fqn: FQN, data: Buffer): Promise<void> {
        await writeFile(serverPath, data);

        if (this.gaManipulator !== undefined) {
            if (!fqn.filePath.volume.isReadOnly()) {
                this.gaManipulator.makeVolumeNotText(fqn.filePath.volume);
                this.gaManipulator.makeFileBASIC(serverPath, utils.isBASIC(data));
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async writeBeebMetadata(serverPath: string, fqn: FQN, load: FileAddress, exec: FileAddress, attr: FileAttributes): Promise<void> {
        await fqn.filePath.volume.type.writeBeebMetadata(serverPath, fqn, load, exec, attr);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // You can set the metadata for a 
    private async OSFILEWriteMetadata(
        fqn: FQN,
        load: FileAddress | undefined,
        exec: FileAddress | undefined,
        attr: FileAttributes | undefined): Promise<OSFILEResult> {
        FS.mustBeWriteableVolume(fqn.filePath.volume);

        const object = await getObject(fqn, false, this.log);
        if (object === undefined) {
            return new OSFILEResult(0, undefined, undefined, undefined);
        }

        if (load === undefined) {
            load = object.getLoad();
        }

        if (exec === undefined) {
            exec = object.getExec();
        }

        if (attr === undefined) {
            attr = object.attr;
        }

        const size = await object.tryGetSize();

        await this.writeBeebMetadata(object.serverPath, object.fqn, load, exec, attr);

        return new OSFILEResult(object.getObjectType(), this.createOSFILEBlock(load, exec, size, attr), undefined, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEReadMetadata(fqn: FQN): Promise<OSFILEResult> {
        const object = await getObject(fqn, true, this.log);
        if (object === undefined) {
            return new OSFILEResult(0, undefined, undefined, undefined);
        } else {
            return new OSFILEResult(1, this.createOSFILEBlock(object.getLoad(), object.getExec(), await object.tryGetSize(), object.attr), undefined, undefined);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEDelete(fqn: FQN): Promise<OSFILEResult> {
        const object = await getObject(fqn, false, this.log);
        if (object === undefined) {
            return new OSFILEResult(0, undefined, undefined, undefined);
        }

        const size = await object.tryGetSize();

        await this.deleteObject(object);

        return new OSFILEResult(object.getObjectType(), this.createOSFILEBlock(object.getLoad(), object.getExec(), size, object.attr), undefined, undefined);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async deleteObject(object: FSObject): Promise<void> {
        if (!(object instanceof File)) {
            return errors.notAFile();//TODO...
        }

        FS.mustBeWriteableVolume(object.fqn.filePath.volume);
        this.mustNotBeOpen(object);
        FS.mustBeWriteableFile(object);

        await object.fqn.filePath.volume.type.deleteFile(object);

        if (this.gaManipulator !== undefined) {
            this.gaManipulator.deleteFile(object.serverPath);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILECreate(fqn: FQN, load: FileAddress, exec: FileAddress, size: number): Promise<OSFILEResult> {
        FS.mustBeWriteableVolume(fqn.filePath.volume);
        FS.mustNotBeTooBig(size);//block.attr - block.size);

        // Cheat.
        return await this.OSFILESave(fqn, load, exec, Buffer.alloc(size));
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Open' error if the object is a file and appears to be open.
    private mustNotBeOpen(object: FSObject): void {
        if (object instanceof File) {
            for (const openFile of this.openFiles) {
                if (openFile !== undefined) {
                    if (openFile.serverPath === object.serverPath) {
                        return errors.open();
                    }
                }
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // Causes a 'Not open for update' error if the given file isn't open for write.
    private mustBeOpenForWrite(openFile: OpenFile): void {
        if (!openFile.write) {
            return errors.notOpenForUpdate(openFile.handle);
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

            await this.writeBeebData(openFile.serverPath, openFile.fqn, data);

            openFile.dirty = false;
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private setOpenFilePtr(openFile: OpenFile, ptr: number): void {
        if (ptr > openFile.contents.length) {
            if (!openFile.write) {
                errors.outsideFile(openFile.handle);
            }

            FS.mustNotBeTooBig(ptr);

            while (openFile.contents.length < ptr) {
                openFile.contents.push(0);
                openFile.dirty = true;
            }
        }

        openFile.ptr = ptr;
        openFile.eofError = false;
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

        this.setOpenFilePtr(openFile, ptr);
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
        FS.mustNotBeTooBig(size);

        if (size < openFile.contents.length) {
            openFile.contents.splice(size);
            openFile.dirty = true;
        } else {
            while (openFile.contents.length < size) {
                openFile.contents.push(0);
                openFile.dirty = true;
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
            this.setOpenFilePtr(openFile, newPtr);
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

        if (useNewPtr) {
            this.setOpenFilePtr(openFile, newPtr);
        }

        let numBytesLeft = 0;
        let eof = false;
        if (openFile.ptr + numBytes > openFile.contents.length) {
            eof = true;
            numBytesLeft = openFile.ptr + numBytes - openFile.contents.length;
            numBytes = openFile.contents.length - openFile.ptr;
        }

        const data = Buffer.alloc(numBytes);
        for (let i = 0; i < data.length; ++i) {
            data[i] = openFile.contents[openFile.ptr + i];
        }

        openFile.ptr = openFile.ptr + numBytes;

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
            FS.mustNotBeTooBig(openFile.contents.length + 1);

            openFile.contents.push(byte);
        } else {
            openFile.contents[openFile.ptr] = byte;
        }

        ++openFile.ptr;
        openFile.dirty = true;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async parseVolumeString(str: string): Promise<{ volume: Volume; volumeExplicit: boolean; i: number; }> {
        if (str === '') {
            return errors.badName();
        }

        this.log?.p(`FS: parseVolumeString: \`\`${str}'': `);

        if (str.length > 3 && str[0] === ':' && str[1] === ':') {
            // Valid cross-volume syntaxes:
            //
            // - ::x:whatever
            // - ::x/whatever
            //
            // The separator is passed to the volume handler, in case it makes a
            // difference.

            let end: number;
            for (end = 2; end < str.length; ++end) {
                if (str[end] === ':' || str[end] === '/') {
                    break;
                }
            }

            const volumeName = str.substring(2, end);

            this.log?.pn(`volume name: ${volumeName}`);

            const volumes = await this.findFirstVolumeMatching(volumeName);

            if (volumes.length === 0) {
                return errors.notFound();
            } else if (volumes.length > 1) {
                return errors.ambiguousName();
            }

            return {
                volume: volumes[0],
                volumeExplicit: true,
                i: end
            };
        } else {
            this.log?.pn(`(current volume)`);

            // This might produce a 'No volume' error, which feels a bit ugly at
            // the parsing step, but I don't think it matters in practice...
            return {
                volume: this.getState().volume,
                volumeExplicit: false,
                i: 0,
            };
        }
    }

    /////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////
}
