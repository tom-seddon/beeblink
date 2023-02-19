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
import dfsType from './dfsType';
import pcType from './pcType';
import tubeHostType from './tubeHostType';
import * as server from './server';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export const MAX_FILE_SIZE = 0xffffff;

export const SHOULDNT_LOAD = 0xffffffff;
export const SHOULDNT_EXEC = 0xffffffff;

export const R_ATTR = 1;
export const W_ATTR = 2;
export const E_ATTR = 4;
export const L_ATTR = 8;

export const DEFAULT_LOAD = SHOULDNT_LOAD;
export const DEFAULT_EXEC = SHOULDNT_EXEC;
export const DEFAULT_ATTR = R_ATTR | W_ATTR;

const IGNORE_DIR_FILE_NAME = '.beeblink-ignore';

const VOLUME_FILE_NAME = '.volume';

const HOST_NAME_ESCAPE_CHAR = '#';

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

const HOST_NAME_CHARS: string[] = [];

export function getHostChars(str: string): string {
    if (HOST_NAME_CHARS.length === 0) {
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
    }

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
        return 'File(hostPath=``' + this.hostPath + '\'\' name=``' + this.fqn + '\'\' load=0x' + utils.hex8(this.load) + ' exec=0x' + utils.hex8(this.exec) + ' attr=0x' + utils.hex8(this.attr);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class OpenFile {
    public readonly handle: number;
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

    public constructor(handle: number, hostPath: string, fqn: FQN, read: boolean, write: boolean, contents: number[]) {
        this.handle = handle;
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

// Name of Beeb file or dir, that may or may not exist, as entered on the
// command line. Components not supplied are set to undefined.
//
// A BeebFSP always includes a volume. wasExplicitVolume indicates whether the
// ::VOLUME syntax was used.
export class FSP {
    // Volume this FSP refers to.
    public readonly volume: Volume;

    // If the volume refers to one that's currently set, state is the state
    // associated with it; if undefined, the ::VOLUME syntax was used.
    public readonly state: IFSState | undefined;

    // FS-specific portion of the FSP.
    public readonly fsFSP: IFSFSP;

    public constructor(volume: Volume, state: IFSState | undefined, name: IFSFSP) {
        this.volume = volume;
        this.state = state;
        this.fsFSP = name;
    }

    public toString(): string {
        return `::${this.volume.name}${this.fsFSP}`;
    }

    public wasExplicitVolume(): boolean {
        return this.state === undefined;
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
    getCurrentDrive(): string;

    // get current directory. (OSGBPB 6 reads this, so it's part of the standard
    // interface.)
    getCurrentDir(): string;

    // get library drive. (OSGBPB 7 reads this, so it's part of the standard
    // interface.)
    getLibraryDrive(): string;

    // get library directory. (OSGBPB 7 reads this, so it's part of the standard
    // interface.)
    getLibraryDir(): string;

    // get object holding current transient settings that would be reset on
    // Ctrl+Break - drive/dir, lib drive/dir, and so on. Use when recreating the
    // state, to restore the current settings.
    //
    // The naming is crappy because 'state' was already taken.
    getTransientSettings(): any | undefined;

    // turns transient settings into a human-readable string for printing on the
    // Beeb. This isn't a toString on an interface type, so the FS state has the
    // option of printing something useful out when there's no state.
    getTransientSettingsString(transientSettings: any | undefined): string;

    // get object holding current persistent settings, that would not be reset
    // on Ctrl+Break - drive assignments, and so on. Use when recreating the
    // state, to restore the current settings.
    getPersistentSettings(): any | undefined;

    // turns persistent settings into a human-readable string for printing on
    // the Beeb.
    getPersistentSettingsString(persistentSettings: any | undefined): string;

    // get file to use for *RUN. If tryLibDir is false, definitely don't try lib
    // drive/directory.
    getFileForRUN(fsp: FSP, tryLibDir: boolean): Promise<File | undefined>;

    // get *CAT text, given command line. Handle default case, when
    // commandLine===undefined, and any straightforward special cases that would
    // otherwise be ambiguous (e.g., drives in DFS/ADFS), returning *CAT string.
    // Or return undefined otherwise.
    //
    // If returning undefined, the BeebFS class will try to interpret the
    // command line as a FSP and use the resulting volume's handler type to
    // catalogue an appropriate drive based on that.
    getCAT(commandLine: string | undefined): Promise<string | undefined>;

    // handle *DRIVE/*MOUNT.
    starDrive(arg: string | undefined): void;

    // handle *DIR.
    starDir(fsp: FSP | undefined): void;

    // handle *LIB.
    starLib(fsp: FSP | undefined): void;

    // handle *HSTATUS drives output.
    getDrivesOutput(): Promise<string>;

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

    // return list of type-specific commands.
    //
    // This is only called when the FS type potentially changes, so it's OK if
    // it does something expensive.
    getCommands(): server.Command[];
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Handle FS-specific stuff that doesn't require any state.

export interface IFSType {
    readonly name: string;

    // create new state for this type of FS.
    createState(volume: Volume, transientSettings: any | undefined, persistentSettings: any | undefined, log: utils.Log | undefined): Promise<IFSState>;

    // whether this FS supports writing.
    canWrite(): boolean;

    // check if given string is a valid BBC file name. Used to check that a .INF
    // file is valid, or whether a .INF/0-byte .INF PC file has a valid BBC
    // name.
    isValidBeebFileName(str: string): boolean;

    // get list of Beeb files matching the given FSP/FQN in the given volume. If
    // an FQN, do a wildcard match; if an FSP, same, treating any undefined
    // values as matching anything; if undefined, find absolutely everything.
    findBeebFilesMatching(volume: Volume, pattern: IFSFSP | IFSFQN | undefined, recurse: boolean, log: utils.Log | undefined): Promise<File[]>;

    // parse file/dir string, starting at index i. 
    parseFileOrDirString(str: string, i: number, parseAsDir: boolean): IFSFSP;

    // create appropriate FSFQN from FSFSP, filling in defaults from the given State as appropriate.
    createFQN(fsp: IFSFSP, state: IFSState | undefined): IFSFQN;

    // get ideal host path for FQN, relative to whichever volume it's in. Used
    // when creating a new file.
    getHostPath(fqn: IFSFQN): string;

    // get *CAT text for FSP.
    getCAT(fsp: FSP, state: IFSState | undefined, log: utils.Log | undefined): Promise<string>;

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
    // metadata. Don't append newline - that will be added automatically.
    getInfoText(file: File, fileSize: number): string;

    // get *WINFO text for the given file. Don't append newline - that will be
    // added automatically.
    getWideInfoText(file: File, stats: fs.Stats): string;

    // get *INFO/*EX-style attributes string for the given file.
    //
    // A return value of undefined indicates that attributes aren't relevant for
    // the current FS. (What's the value of distinguishing this from ''? TBC...)
    getAttrString(file: File): string | undefined;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Name as supplied by caller. Properties may be undefined if they weren't
// provided.
//
// explicitly mentioning toString avoids the no-empty-interface tslint warning
// (that I haven't decided what to do about yet).
export interface IFSFSP {
    toString(): string;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export interface IFSFQN {
    readonly name: string;
    equals(other: IFSFQN): boolean;
    toString(): string;
    isWildcard(): boolean;
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
export async function getBeebFile(fqn: FQN, wildcardsOK: boolean, throwIfNotFound: boolean, log?: utils.Log | undefined): Promise<File | undefined> {
    log?.pn(`getBeebFile: ${fqn}; wildCardsOK=${wildcardsOK} throwIfNotFound=${throwIfNotFound}`);

    if (!wildcardsOK) {
        if (fqn.fsFQN.isWildcard()) {
            return errors.badName();
        }
    }

    const files = await fqn.volume.type.findBeebFilesMatching(fqn.volume, fqn.fsFQN, false, log);
    log?.pn(`found ${files.length} file(s)`);

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

    public static async findAllVolumes(searchFolders: IFSSearchFolders, log: utils.Log | undefined): Promise<Volume[]> {
        return await FS.findVolumes('*', false, searchFolders, log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public static async readFile(file: File): Promise<Buffer> {
        try {
            return await utils.fsReadFile(file.hostPath);
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

            await writeFile(file.hostPath, data);
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

    // Causes a 'Locked' error if the file exists and is locked.
    private static mustBeWriteableFile(file: File | undefined): void {
        if (file !== undefined) {
            if ((file.attr & L_ATTR) !== 0) {
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

        async function findBeebLinkVolumesMatchingRecursive(folderPath: string, indent: string): Promise<boolean> {
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

                            if (addVolume(volumePath, volumeName, dfsType)) {
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
        }

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

        if (addFolders(searchFolders.pcFolders, pcType)) {
            return volumes;
        }

        if (addFolders(searchFolders.tubeHostFolders, tubeHostType)) {
            return volumes;
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

    private searchFolders: IFSSearchFolders;

    //private currentVolume: BeebVolume | undefined;

    private firstFileHandle: number;
    private openFiles: (OpenFile | undefined)[];

    private log: utils.Log | undefined;

    private state: IFSState | undefined;
    private stateCommands: undefined | server.Command[];
    private defaultTransientSettings: any | undefined;

    private gaManipulator: gitattributes.Manipulator | undefined;

    private locateVerbose: boolean;

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public constructor(searchFolders: IFSSearchFolders, gaManipulator: gitattributes.Manipulator | undefined, log: utils.Log | undefined, locateVerbose: boolean) {
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
        let fsp: FSP | undefined;

        if (arg !== undefined) {
            fsp = await this.parseDirString(arg);

            if (fsp.wasExplicitVolume()) {
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

            if (fsp.wasExplicitVolume()) {
                return errors.badDir();
            }
        }

        this.getState().starLib(fsp);
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

        const newVolume = new Volume(volumePath, name, dfsType);
        return newVolume;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async parseFQN(fileString: string): Promise<FQN> {
        this.log?.pn('parseFQN: ``' + fileString + '\'\'');

        const fsp = await this.parseFileString(fileString);
        this.log?.pn('    fsp: ' + fsp);

        const fqn = new FQN(fsp.volume, fsp.volume.type.createFQN(fsp.fsFSP, this.state));
        this.log?.pn(`    fqn: ${fqn}`);

        return fqn;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async findFilesMatching(fqn: FQN): Promise<File[]> {
        return await fqn.volume.type.findBeebFilesMatching(fqn.volume, fqn.fsFQN, false, this.log);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getInfoText(file: File): Promise<string> {
        const fileSize = await this.tryGetFileSize(file);

        return file.fqn.volume.type.getInfoText(file, fileSize);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getWideInfoText(file: File): Promise<string> {
        const stats = await this.tryGetFileStats(file);

        if (stats === undefined) {
            return file.fqn.volume.type.getInfoText(file, 0);
        } else {
            return file.fqn.volume.type.getWideInfoText(file, stats);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getAttrString(file: File): string | undefined {
        return file.fqn.volume.type.getAttrString(file);
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
                    this.log?.in('  ');
                }

                let fsp: IFSFSP;
                try {
                    fsp = volume.type.parseFileOrDirString(arg, 0, false);
                } catch (error) {
                    // if the arg wasn't even parseable by this volume's type, it
                    // presumably won't match any file...
                    continue;
                }

                const files = await volume.type.findBeebFilesMatching(volume, fsp, true, this.locateVerbose ? this.log : undefined);

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

    public async tryGetFileStats(file: File): Promise<fs.Stats | undefined> {
        return await utils.tryStat(file.hostPath);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // This is never used anywhere where the error case is particularly
    // important.
    //
    // TODO: should this info be part of the File type?
    public async tryGetFileSize(file: File): Promise<number> {
        const hostStat = await this.tryGetFileStats(file);
        if (hostStat === undefined) {
            return 0;
        }

        return hostStat.size;
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

            text += ' PTR#=&' + utils.hex8(openFile.ptr) + ' EXT#=&' + utils.hex8(openFile.contents.length) + ' - ' + openFile.hostPath + utils.BNL;
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

        const fsp = await this.parseDirString(commandLine);

        return await fsp.volume.type.getCAT(fsp, this.getState(), this.log);
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

        this.log?.pn('OSFIND: mode=$' + utils.hex2(mode) + ' nameString=``' + nameString + '\'\'');

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
                for (let otherIndex = 0; otherIndex < this.openFiles.length; ++otherIndex) {
                    const otherOpenFile = this.openFiles[otherIndex];
                    if (otherOpenFile !== undefined) {
                        if (otherOpenFile.hostPath === file.hostPath) {
                            if (otherOpenFile.write || write) {
                                this.log?.pn(`        already open: handle=0x${this.firstFileHandle + otherIndex}`);
                                return errors.open();
                            }
                        }
                    }
                }
            }

            this.log?.pn('        hostPath=``' + file.hostPath + '\'\'');
            this.log?.pn('        text=' + file.text);

            // File exists.
            hostPath = file.hostPath;

            if (write) {
                FS.mustBeWriteableVolume(fqn.volume);
                FS.mustBeWriteableFile(file);
            }

            if (write && !read) {
                // OPENOUT of file that exists. Zap the contents first.
                try {
                    await utils.fsTruncate(file.hostPath);
                } catch (error) {
                    return errors.nodeError(error as NodeJS.ErrnoException);
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
            await utils.mustNotExist(hostPath);

            // Create file.
            await this.OSFILECreate(fqn, 0, 0, 0);
        }

        const contents: number[] = [];
        if (contentsBuffer !== undefined) {
            for (const byte of contentsBuffer) {
                contents.push(byte);
            }
        }

        const openFile = new OpenFile(this.firstFileHandle + index, hostPath, fqn, read, write, contents);
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
        return (await getBeebFile(fqn, true, true))!;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    // get File matching FQN, that must be writeable.
    public async getBeebFileForWrite(fqn: FQN): Promise<File> {
        FS.mustBeWriteableVolume(fqn.volume);

        let file = await getBeebFile(fqn, false, false);
        if (file !== undefined) {
            this.mustNotBeOpen(file);
        } else {
            file = new File(this.getHostPath(fqn), fqn, SHOULDNT_LOAD, SHOULDNT_EXEC, 0, false);
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

    public async writeBeebFileMetadata(file: File): Promise<void> {
        try {
            await this.writeBeebMetadata(file.hostPath, file.fqn, file.load, file.exec, file.attr);
        } catch (error) {
            errors.nodeError(error);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public getFileWithModifiedAttributes(file: File, attributeString: string): File {
        const newAttr = file.fqn.volume.type.getNewAttributes(file.attr, attributeString);
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
        this.log?.pn('oldFQN: ' + oldFQN);
        this.log?.pn('newFQN: ' + newFQN);

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

        await oldFQN.volume.type.renameFile(oldFile, newFQN);

        if (this.gaManipulator !== undefined) {
            if (!newFQN.volume.isReadOnly()) {
                // could be cleverer than this.
                this.gaManipulator.renameFile(oldFile.hostPath, newFQN.volume.type.getHostPath(newFQN.fsFQN));
            }
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    public async getFileForRUN(fsp: FSP, tryLibDir: boolean): Promise<File> {
        if (fsp.wasExplicitVolume()) {
            // Definitely don't try lib drive/dir if volume was specified.
            tryLibDir = false;
        }

        const file = await this.getState().getFileForRUN(fsp, tryLibDir);

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

    private setState(state: IFSState): void {
        this.state = state;
        this.stateCommands = undefined;
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private getHostPath(fqn: FQN): string {
        return path.join(fqn.volume.path, fqn.volume.type.getHostPath(fqn.fsFQN));
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

        FS.mustNotBeTooBig(data.length);

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
        FS.mustBeWriteableVolume(fqn.volume);
        FS.mustNotBeTooBig(data.length);

        let hostPath: string;

        const file = await getBeebFile(fqn, false, false, this.log);
        if (file !== undefined) {
            this.mustNotBeOpen(file);
            FS.mustBeWriteableFile(file);

            hostPath = file.hostPath;
        } else {
            hostPath = this.getHostPath(fqn);

            await utils.mustNotExist(hostPath);
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
        await fqn.volume.type.writeBeebMetadata(hostPath, fqn.fsFQN, load, exec, attr);
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILEWriteMetadata(
        fqn: FQN,
        load: number | undefined,
        exec: number | undefined,
        attr: number | undefined): Promise<OSFILEResult> {
        FS.mustBeWriteableVolume(fqn.volume);

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
        FS.mustBeWriteableVolume(file.fqn.volume);
        this.mustNotBeOpen(file);
        FS.mustBeWriteableFile(file);

        await file.fqn.volume.type.deleteFile(file);

        if (this.gaManipulator !== undefined) {
            this.gaManipulator.deleteFile(file.hostPath);
        }
    }

    /////////////////////////////////////////////////////////////////////////
    /////////////////////////////////////////////////////////////////////////

    private async OSFILECreate(fqn: FQN, load: number, exec: number, size: number): Promise<OSFILEResult> {
        FS.mustBeWriteableVolume(fqn.volume);
        FS.mustNotBeTooBig(size);//block.attr - block.size);

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

            await this.writeBeebData(openFile.hostPath, openFile.fqn, data);

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

    private async parseFileOrDirString(str: string, parseAsDir: boolean): Promise<FSP> {
        if (str === '') {
            return errors.badName();
        }

        let i = 0;
        let volume: Volume;
        let state: IFSState | undefined;

        if (str[i] === ':' && str[i + 1] === ':' && str.length > 3) {
            // ::x:whatever
            //
            // The : is doing double duty here: it's the terminator of the
            // volume name, but (with the DFS syntax that I had in mind when
            // adding this stuff originally) it's also the prefix for the drive
            // name. So it has to get passed through to the FS type handler.
            //
            // This is good for FS types with drives, because then the volume
            // name is just a ::WHATEVER prefix, followed by a fully-specified
            // path, drive and all. Not so good for the PC type, though, because
            // the : prefix is sent through just the same, and it has to be
            // stripped off. 

            let end = str.indexOf(':', i + 2);
            if (end < 0) {
                // "::fred" or similar.
                end = str.length;
                //return errors.badName();
            }

            const volumeName = str.substring(i + 2, end);

            const volumes = await this.findFirstVolumeMatching(volumeName);

            if (volumes.length === 0) {
                return errors.fileNotFound('Volume not found');
            } else if (volumes.length > 1) {
                return errors.badName('Ambiguous volume');
            }

            volume = volumes[0];

            i = end;
        } else {
            // This might produce a 'No volume' error, which feels a bit ugly at
            // the parsing step, but I don't think it matters in practice...
            state = this.getState();
            volume = state.volume;
        }

        const fsp = volume.type.parseFileOrDirString(str, i, parseAsDir);

        return new FSP(volume, state, fsp);
    }

    /////////////////////////////////////////////////////////////////////////
    ////////////////////////////////////////////////////////////////////////
}
