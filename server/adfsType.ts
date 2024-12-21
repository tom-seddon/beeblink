//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
// Copyright (C) 2024 Tom Seddon
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
//import * as os from 'os';
import * as path from 'path';
import * as beebfs from './beebfs';
import * as utils from './utils';
import * as errors from './errors';
import CommandLine from './CommandLine';
import * as inf from './inf';
import * as server from './server';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// TODO...

// ADFS doesn't work quite like any of the other supported volume types, but it
// does hang together, sort of, just about.

// Should the ADFSFilePath have an optional string[] holding the split dir
// parts? Either it was created by scanning files on disk (in which case the
// server path will be known, and the split dir parts are irrelevant), or it was
// created by parsing a string (in which case the split dir parts will be known,
// but the server path won't).

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

const MAX_NAME_LENGTH = 10;
const DEFAULT_TITLE = '';
const DEFAULT_BOOT_OPTION = 0;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// https://github.com/Microsoft/TypeScript/wiki/FAQ#can-i-make-a-type-alias-nominal

// Had more than one bug stem from mixing these up...
type AbsPath = string & { 'absPath': object; };
type VolRelPath = string & { 'volRelPath': object; };

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function todoError(what: string): never {
    return errors.generic(`TODO: ${what}`);
}

// function getAbsPath(volume: beebfs.Volume, volRelPath: VolRelPath): AbsPath {
//     return path.join(volume.path, volRelPath) as AbsPath;
// }

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function mustBeADFSType(type: beebfs.IFSType): ADFSType {
    if (!(type instanceof ADFSType)) {
        throw new Error('not ADFSType');
    }

    return type;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function mustBeADFSState(state: beebfs.IFSState | undefined): ADFSState | undefined {
    if (state !== undefined) {
        if (!(state instanceof ADFSState)) {
            throw new Error('not ADFSState');
        }
    }

    return state;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

interface IADFSDrive {
    readonly serverFolder: VolRelPath;
    readonly beebName: string;
    readonly option: number;
    readonly title: string;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// // Similar to beebfs.File, but for an ADFS directory.
// class Dir {
//     // Actual path to the folder on the server.
//     public readonly serverPath: string;

//     public readonly fqn: beebfs.FQN;

//     public readonly attr: beebfs.FileAttributes;

//     public constructor(serverPath: string, fqn: beebfs.FQN, attr: beebfs.FileAttributes) {
//         this.serverPath = serverPath;
//         this.fqn = fqn;
//         this.attr = attr;
//     }

//     public toString(): string {
//         return `Dir(serverPath=\`\`${this.serverPath}'' fqn=\`\`${this.fqn}'' attr = 0x${utils.hex8(this.attr)})`;
//     }
// }

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSFilePath extends beebfs.FilePath {
    public readonly serverFolder: AbsPath;

    public constructor(volume: beebfs.Volume, volumeExplicit: boolean, drive: string, driveExplicit: boolean, dir: string, dirExplicit: boolean, serverFolder: AbsPath) {
        super(volume, volumeExplicit, drive, driveExplicit, dir, dirExplicit);

        this.serverFolder = utils.getSeparatorAndCaseNormalizedPath(serverFolder) as AbsPath;
    }

    public override getFQNSuffix(): string | undefined {
        return this.serverFolder;
    }
}

// function mustBeADFSFilePath(filePath: beebfs.FilePath): ADFSFilePath {
//     if (!(filePath instanceof ADFSFilePath)) {
//         throw new Error('not ADFSFilePath');
//     }

//     return filePath;
// }

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSPath {
    public constructor(public readonly drive: string, public readonly dir: ReadonlyArray<string>) { }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSTransientSettings {
    public constructor(public readonly current: ADFSPath, public readonly library: ADFSPath) { }
}

const gDefaultTransientSettings = new ADFSTransientSettings(new ADFSPath('0', ['$']), new ADFSPath('0', ['$']));

function getDirString(dir: ReadonlyArray<string>): string {
    return dir.join('.');
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSState implements beebfs.IFSState {
    public readonly volume: beebfs.Volume;

    public readonly log: utils.Log | undefined;// tslint:disable-line no-unused-variable

    private current: ADFSPath;
    private previous: ADFSPath;
    private library: ADFSPath;

    public constructor(volume: beebfs.Volume, transientSettingsAny: unknown, log: utils.Log | undefined) {
        this.volume = volume;
        this.log = log;

        const transientSettings = ADFSState.getADFSTransientSettings(transientSettingsAny);

        this.current = transientSettings.current;
        this.previous = this.current;
        this.library = transientSettings.library;
    }

    private static getADFSTransientSettings(settings: unknown): ADFSTransientSettings {
        if (settings === undefined) {
            return gDefaultTransientSettings;
        }

        if (!(settings instanceof ADFSTransientSettings)) {
            return gDefaultTransientSettings;
        }

        return settings;
    }

    public getCurrent(): ADFSPath {
        return this.current;
    }

    public getLibrary(): ADFSPath {
        return this.library;
    }

    public getCurrentDrive(): string {
        return this.current.drive;
    }

    public getCurrentDir(): string {
        return getDirString(this.current.dir);
    }

    public getLibraryDrive(): string {
        return this.library.drive;
    }

    public getLibraryDir(): string {
        return getDirString(this.library.dir);
    }

    public getTransientSettings(): ADFSTransientSettings {
        return new ADFSTransientSettings(this.current, this.library);
    }

    public getTransientSettingsString(settingsAny: unknown): string {
        const settings = ADFSState.getADFSTransientSettings(settingsAny);

        let text = ``;

        text += `Default dir: :${settings.current.drive}.${settings.current.dir}${utils.BNL}`;
        text += `Default lib: :${settings.library.drive}.${settings.library.dir}${utils.BNL}`;

        return text;
    }

    public getPersistentSettings(): undefined {
        return undefined;
    }

    public getPersistentSettingsString(_settings: unknown): string {
        return '';
    }

    public async getFileForRUN(fqn: beebfs.FQN, tryLibDir: boolean): Promise<beebfs.File | undefined> {
        if (fqn.filePath.driveExplicit || fqn.filePath.dirExplicit) {
            tryLibDir = false;
        }

        const curFile = await beebfs.getBeebFile(fqn, true, this.log);
        if (curFile !== undefined) {
            return curFile;
        }

        if (tryLibDir) {
            const libPath = new beebfs.FilePath(fqn.filePath.volume, fqn.filePath.volumeExplicit, this.library.drive, true, this.getLibraryDir(), true);
            const libFQN = new beebfs.FQN(libPath, fqn.name);
            const libFile = await beebfs.getBeebFile(libFQN, true, this.log);
            if (libFile !== undefined) {
                return libFile;
            }
        }

        return undefined;
    }

    public async getCAT(commandLine: string | undefined): Promise<string | undefined> {
        let filePath: beebfs.FilePath;
        if (commandLine === undefined) {
            filePath = new beebfs.FilePath(this.volume, false, this.current.drive, false, this.getCurrentDir(), false);
        } else {
            // TODO... handle <obspec>
            return undefined;
        }

        return await this.volume.type.getCAT(filePath, this, this.log);
    }

    public starDrive(arg: string | undefined): boolean {
        if (arg === undefined) {
            return errors.badDrive();
        }

        if (ADFSType.isValidDrive(arg)) {
            this.setCurrentDir(new ADFSPath(arg, this.current.dir));
        } else {
            const filePath = this.volume.type.parseDirString(arg, 0, this, this.volume, false);
            if (!filePath.driveExplicit || filePath.dirExplicit) {
                return errors.badDrive();
            }

            this.setCurrentDir(new ADFSPath(filePath.drive, this.current.dir));
        }

        return true;
    }

    public starDir(filePath: beebfs.FilePath | undefined): void {
        if (filePath !== undefined) {
            this.setCurrentDir(this.getADFSPathFromFilePath(filePath));
        } else {
            this.setCurrentDir(new ADFSPath(this.current.drive, gDefaultTransientSettings.current.dir));
        }
    }

    public starLib(filePath: beebfs.FilePath | undefined): void {
        if (filePath !== undefined) {
            this.library = this.getADFSPathFromFilePath(filePath);
        } else {
            this.library = new ADFSPath(this.current.drive, gDefaultTransientSettings.library.dir);
        }
    }

    public async getDrivesOutput(): Promise<string> {
        const drives = await mustBeADFSType(this.volume.type).findDrivesForVolume(this.volume, undefined);

        let text = '';

        for (const drive of drives) {
            text += `${drive.beebName} - ${beebfs.getBootOptionDescription(drive.option).padEnd(4)}: `;

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
        // TODO...
        return DEFAULT_BOOT_OPTION;
    }

    public async setBootOption(_option: number): Promise<void> {
        // TODO...
    }

    public async setTitle(_title: string): Promise<void> {
        // TODO...
    }

    public async getTitle(): Promise<string> {
        // TODO...
        return DEFAULT_TITLE;
    }

    //private readonly fun: (commandLine: CommandLine) => Promise<void | string | StringWithError | Response>;
    public getCommands(): server.Command[] {
        return [
            new server.Command('BACK', undefined, this.backCommand),
            new server.Command('CDIR', '<Ob Spec>', this.cdirCommand),
            new server.Command('LCAT', undefined, this.lcatCommand),
            new server.Command('LEX', undefined, this.lexCommand),
        ];
    }

    private readonly backCommand = async (_commandLine: CommandLine): Promise<void> => {
        [this.current, this.previous] = [this.previous, this.current];
        // const temp = this.current;
        // this.current = this.previous;
        // this.previous = temp;
    };

    private readonly cdirCommand = async (_commandLine: CommandLine): Promise<void> => {
        return todoError('CDIR');
    };

    private readonly lcatCommand = async (_commandLine: CommandLine): Promise<void> => {
        return todoError('LCAT');
    };

    private readonly lexCommand = async (_commandLine: CommandLine): Promise<void> => {
        return todoError('LEX');
    };

    private getADFSPathFromFilePath(filePath: beebfs.FilePath): ADFSPath {
        if (filePath.volumeExplicit) {
            return errors.badDir();
        }

        return new ADFSPath(filePath.drive, filePath.dir.split('.'));
    }

    private setCurrentDir(newCurrent: ADFSPath): void {
        this.previous = this.current;
        this.current = newCurrent;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

const DRIVE_NAMES: ReadonlyArray<string> = ['0', '1', '2', '3', '4', '5', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',];

const NAME_CHARS_VALID: boolean[] = ((): boolean[] => {
    const valid: boolean[] = [];

    for (let i = 0; i < 128; ++i) {
        valid.push(i >= 32 && '#*.:$&@ '.indexOf(String.fromCharCode(i)) < 0);
    }

    return valid;
})();

class ADFSType implements beebfs.IFSType {
    public readonly name = 'BeebLink/ADFS';

    public static isValidDrive(maybeDrive: string): boolean {
        return maybeDrive.length === 1 && utils.isalnum(maybeDrive);
    }

    public static isValidBeebFileName(str: string): boolean {
        if (str.length > MAX_NAME_LENGTH) {
            return false;
        }

        for (const c of str) {
            if (!ADFSType.isValidFileNameChar(c)) {
                return false;
            }
        }

        return true;
    }

    public static isValidBeebDirectoryName(str: string): boolean {
        if (str.length > MAX_NAME_LENGTH) {
            return false;
        }

        for (const c of str) {
            if (!ADFSType.isValidFileNameChar(c)) {
                return false;
            }
        }

        return true;
    }

    private static isValidFileNameChar(char: string): boolean {
        const c = char.charCodeAt(0);
        if (c >= NAME_CHARS_VALID.length) {
            return false;
        } else {
            return NAME_CHARS_VALID[c];
        }
    }

    public async createState(volume: beebfs.Volume, transientSettings: unknown, persistentSettings: unknown, log: utils.Log | undefined): Promise<beebfs.IFSState> {
        return new ADFSState(volume, transientSettings, log);
    }

    public canWrite(): boolean {
        return true;
    }

    public parseFileString(str: string, i: number, state: beebfs.IFSState | undefined, volume: beebfs.Volume, volumeExplicit: boolean): beebfs.FQN {
        const parseResult = this.parseFileOrDirString(str, i, state, false, volume, volumeExplicit);
        if (parseResult.name === undefined) {
            return errors.badName();
        }

        return new beebfs.FQN(parseResult.filePath, parseResult.name);
    }

    public parseDirString(str: string, i: number, state: beebfs.IFSState | undefined, volume: beebfs.Volume, volumeExplicit: boolean): beebfs.FilePath {
        return this.parseFileOrDirString(str, i, state, true, volume, volumeExplicit).filePath;
    }

    public async getIdealAbsoluteServerPath(fqn: beebfs.FQN): Promise<AbsPath> {
        // The directory structure must be present when creating a file. *CDIR
        // has its own handling.
        const adfsFilePath = await this.mustFindADFSFilePath(fqn.filePath, undefined);

        return path.join(adfsFilePath.serverFolder, beebfs.getServerCharsForName(fqn.name)) as AbsPath;
    }

    // The dir matching is a bit weird - the entire dir string is matched, and
    // regexp-style, so * matches any number of directories. But this is
    // (probably) actually what you want.
    public async locateBeebFiles(fqn: beebfs.FQN, log: utils.Log | undefined): Promise<beebfs.File[]> {
        const driveRegExp = fqn.filePath.driveExplicit ? utils.getRegExpFromAFSP(fqn.filePath.drive) : undefined;
        const dirRegExp = fqn.filePath.dirExplicit ? utils.getRegExpFromAFSP(fqn.filePath.dir) : undefined;
        return await this.findFiles(fqn.filePath.volume, driveRegExp, dirRegExp, utils.getRegExpFromAFSP(fqn.name), log);
    }

    public async findObjectsMatching(fqn: beebfs.FQN, log: utils.Log | undefined): Promise<beebfs.FSObject[]> {
        const filePath = await this.mustFindADFSFilePath(fqn.filePath, log);
        const nameRegExp = utils.getOptionalRegExpFromAFSP(fqn.name);

        const foundObjects = await this.findObjects(filePath, log);
        if (nameRegExp === undefined) {
            return foundObjects;
        } else {
            const matchingObjects: beebfs.FSObject[] = [];

            for (const foundObject of foundObjects) {
                if (nameRegExp.exec(foundObject.fqn.name) !== null) {
                    matchingObjects.push(foundObject);
                }
            }

            return matchingObjects;
        }
    }

    public async getCAT(filePath: beebfs.FilePath, state: beebfs.IFSState | undefined, _log: utils.Log | undefined): Promise<string> {
        const adfsFilePath = await this.mustFindADFSFilePath(filePath, _log);

        const beebEntries = await this.findObjects(adfsFilePath, _log);

        //const beebEntries = await this.findDirEntries(filePath.volume, utils.getRegExpFromAFSP(filePath.drive), utils.getRegExpFromAFSP(filePath.dir), utils.MATCH_ANY_REG_EXP, false, true, _log);

        let text = '';

        text += `Volume: ${filePath.volume.name}${utils.BNL}`;
        text += `Drive: ${filePath.drive}${utils.BNL}`;
        text += `Dir: ${filePath.dir}${utils.BNL}`;
        text += utils.BNL;

        const catStartIndex = text.length;
        for (const beebEntry of beebEntries) {
            const attributesWidth = 6;
            text += this.getAttrString(beebEntry).padEnd(attributesWidth);
            text += beebEntry.fqn.name;

            while ((text.length - catStartIndex) % 20 !== 0) {
                text += ' ';
            }
        }

        return text;
    }

    public async findDrivesForVolume(volume: beebfs.Volume, driveRegExp: RegExp | undefined): Promise<IADFSDrive[]> {
        let entries: fs.Dirent[];
        try {
            entries = await utils.fsReaddir(volume.path, { withFileTypes: true });
        } catch (error) {
            return errors.nodeError(error);
        }

        const beebNamesSeen = new Set<string>();
        const drives = [];

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (ADFSType.isValidDrive(entry.name)) {
                    if (utils.matchesOptionalRegExp(entry.name, driveRegExp)) {
                        const beebName = entry.name.toUpperCase();
                        if (!beebNamesSeen.has(beebName)) {
                            const option = DEFAULT_BOOT_OPTION;//TODO... await this.loadBootOption(volume, name);
                            const title = DEFAULT_TITLE;//TODO...await this.loadTitle(volume, name);

                            drives.push({
                                serverFolder: entry.name as VolRelPath,
                                beebName: entry.name.toUpperCase(),
                                option,
                                title
                            });

                            beebNamesSeen.add(beebName);
                        }
                    }
                }
            }
        }

        return drives;
    }

    public async deleteFile(_file: beebfs.File): Promise<void> {
        return errors.generic('TODO: delete');
    }

    public async rename(_oldFQN: beebfs.FQN, _newFQN: beebfs.FQN): Promise<beebfs.IRenameFileResult> {
        return errors.generic('TODO: rename');
    }

    public async writeBeebMetadata(serverPath: string, fqn: beebfs.FQN, load: beebfs.FileAddress, exec: beebfs.FileAddress, size: number, attr: beebfs.FileAttributes): Promise<void> {
        await inf.writeStandardINFFile(serverPath, fqn.name, load, exec, size, attr, undefined);
    }

    public getNewAttributes(_oldAttr: beebfs.FileAttributes, attrString: string): beebfs.FileAttributes | undefined {
        let newAttr = 0 as beebfs.FileAttributes;

        // I don't think every combination is valid, but does it matter much?
        for (const c of attrString.toLowerCase()) {
            if (c === 'l') {
                newAttr = (newAttr | beebfs.L_ATTR) as beebfs.FileAttributes;
            } else if (c === 'r') {
                newAttr = (newAttr | beebfs.R_ATTR) as beebfs.FileAttributes;
            } else if (c === 'w') {
                newAttr = (newAttr | beebfs.W_ATTR) as beebfs.FileAttributes;
            } else if (c === 'e') {
                newAttr = (newAttr | beebfs.E_ATTR) as beebfs.FileAttributes;
            } else {
                return undefined;
            }
        }

        return newAttr;
    }

    // The normal ADFS *INFO doesn't bother to fit into Mode 7, so this doesn't either.
    public async getInfoText(object: beebfs.FSObject, wide: boolean): Promise<string> {
        const stats = await object.tryGetStats();

        let text = `${object.fqn.name.padEnd(15)} ${this.getAttrString(object).padEnd(6)}`;
        if (object instanceof beebfs.File) {
            text += ` ${utils.hex8(object.load)} ${utils.hex8(object.exec)} `;
            if (stats !== undefined) {
                text += utils.hex8(stats.size);
            } else {
                text += `????????`;
            }
        }

        if (wide) {
            if (stats !== undefined) {
                text += ` ${utils.getDateString(stats.mtime)}`;
            }
        }

        return text;
    }

    public getAttrString(object: beebfs.FSObject): string {
        let str = '';

        if (object.attr & beebfs.R_ATTR) {
            str += 'R';
        }

        if (object.attr & beebfs.W_ATTR) {
            str += 'W';
        }

        if (object.attr & beebfs.L_ATTR) {
            str += 'L';
        }

        if (object.attr & beebfs.E_ATTR) {
            str += 'E';
        }

        if (object instanceof beebfs.Dir) {
            str += 'D';
        }

        return str;
    }

    private async mustFindADFSFilePath(filePath: beebfs.FilePath, log: utils.Log | undefined): Promise<ADFSFilePath> {
        const adfsFilePath = await this.findADFSFilePath(filePath, log);
        if (adfsFilePath === undefined) {
            return errors.badDir();
        }

        return adfsFilePath;
    }

    // Returns undefined if the directory tree doesn't exist.
    private async findADFSFilePath(filePath: beebfs.FilePath, log: utils.Log | undefined): Promise<ADFSFilePath | undefined> {
        if (filePath instanceof ADFSFilePath) {
            return filePath;
        }

        // Bleargh.
        let currentFilePath = new ADFSFilePath(filePath.volume, true, filePath.drive, true, '$', true, path.join(filePath.volume.path, filePath.drive) as AbsPath);

        // The parse will already have done this. Might it be worth storing off?
        //
        // The server path and dir parts are mutually exclusive.
        const dirs = filePath.dir.split('.');

        let dirIndex = 0;
        if (dirs[dirIndex] !== '$') {
            return errors.generic('No $');
        }
        ++dirIndex;

        while (dirIndex < dirs.length) {
            const entries = await this.findObjects(currentFilePath, log);
            const nameRegExp = utils.getRegExpFromAFSP(dirs[dirIndex]);
            let foundEntry: beebfs.Dir | undefined;
            for (const entry of entries) {
                if (entry instanceof beebfs.Dir) {
                    if (nameRegExp.exec(entry.fqn.name) !== null) {
                        if (foundEntry !== undefined) {
                            return errors.ambiguousName();
                        } else {
                            foundEntry = entry;
                        }
                    }
                }
            }
            if (foundEntry === undefined) {
                return undefined;
            }

            currentFilePath = new ADFSFilePath(currentFilePath.volume, true, currentFilePath.drive, true, currentFilePath + '.' + foundEntry.fqn.name, true, foundEntry.serverPath as AbsPath);
            ++dirIndex;
        }

        return currentFilePath;
    }

    private async findObjects(filePath: ADFSFilePath, log: utils.Log | undefined): Promise<beebfs.FSObject[]> {
        const entries: beebfs.FSObject[] = [];

        const infos: inf.IINF[] = await inf.getINFsForFolder(filePath.serverFolder, true, log);
        for (const info of infos) {
            const fqn = new beebfs.FQN(filePath, info.name);
            log?.pn(`${fqn} - ${info.serverPath} `);
            if (info.extra !== undefined && info.extra.dir) {
                entries.push(new beebfs.Dir(info.serverPath, fqn, info.attr));
            } else {
                entries.push(new beebfs.File(info.serverPath, fqn, info.load, info.exec, info.attr));
            }
        }

        return entries;
    }

    private async findFiles(volume: beebfs.Volume, driveRegExp: RegExp | undefined, dirRegExp: RegExp | undefined, nameRegExp: RegExp | undefined, log: utils.Log | undefined): Promise<beebfs.File[]> {
        const files: beebfs.File[] = [];

        const recurse = async (filePath: ADFSFilePath): Promise<void> => {
            const entries = await this.findObjects(filePath, log);
            for (const entry of entries) {
                if (entry instanceof beebfs.File) {
                    if (utils.matchesOptionalRegExp(entry.fqn.filePath.dir, dirRegExp) && utils.matchesOptionalRegExp(entry.fqn.name, nameRegExp)) {
                        files.push(entry);
                    }
                } else if (entry instanceof beebfs.Dir) {
                    const newFilePath = new ADFSFilePath(entry.fqn.filePath.volume, entry.fqn.filePath.volumeExplicit, entry.fqn.filePath.drive, entry.fqn.filePath.driveExplicit, `${entry.fqn.filePath.dir}.${entry.fqn.name} `, true, entry.serverPath as AbsPath);
                    await recurse(newFilePath);
                }
            }
        };

        for (const driveName of DRIVE_NAMES) {
            if (utils.matchesOptionalRegExp(driveName, driveRegExp)) {
                await recurse(new ADFSFilePath(volume, true, driveName, true, '$', true, path.join(volume.path, driveName) as AbsPath));
            }
        }

        return files;
    }

    private parseFileOrDirString(str: string, i: number, state: beebfs.IFSState | undefined, parseAsDir: boolean, volume: beebfs.Volume, volumeExplicit: boolean): { filePath: beebfs.FilePath; name: string | undefined; i: number; } {
        const adfsState = mustBeADFSState(state);

        const log: utils.Log | undefined = adfsState?.log;

        //log?.pn(`ADFSType.parseFileOrDirString: str = "${str}"; i = ${ i }; parseAsDir = ${ parseAsDir }; volume = ${ volume.name } `);

        if (i === str.length) {
            //log?.pn(`ADFSType.parseFileOrDirString: default properties`);
            if (adfsState === undefined) {
                return errors.badName();
            }

            return {
                filePath: new beebfs.FilePath(volume, volumeExplicit, adfsState.getCurrentDrive(), false, adfsState.getCurrentDir(), false),
                name: undefined,
                i: 0,
            };
        }

        let drive: string | undefined;
        let dirs: string[] | undefined;
        let name: string | undefined;

        if (str[i] === ':' && i + 1 < str.length) {
            drive = str[i + 1];
            i += 2;

            if (str[i] !== '.') {
                return errors.badName();
            }
            i += 1;

            log?.pn(`  Drive: ${drive} `);
        }

        // TODO... need to stop at the first space? This will surely eat too much sometimes.
        if (parseAsDir) {
            dirs = str.slice(i).split('.');
            if (dirs.length === 1 && dirs[0] === '') {
                dirs = undefined;
            }
        } else {
            const lastSeparatorIndex = str.lastIndexOf('.');
            if (lastSeparatorIndex < i) {
                name = str.slice(i);
            } else {
                dirs = str.slice(i, lastSeparatorIndex - i).split('.');
                name = str.slice(lastSeparatorIndex + 1);
                if (name.length === 0) {
                    name = undefined;
                }
            }
        }

        let driveExplicit: boolean;
        if (drive === undefined) {
            if (adfsState !== undefined) {
                drive = adfsState.getCurrentDrive();
            } else {
                drive = gDefaultTransientSettings.current.drive;
            }

            driveExplicit = false;
        } else {
            driveExplicit = true;
        }

        let dirExplicit: boolean;
        if (dirs === undefined) {
            if (adfsState !== undefined) {
                dirs = adfsState.getCurrent().dir.slice();
            } else {
                dirs = gDefaultTransientSettings.current.dir.slice();
            }

            dirExplicit = false;
        } else {
            if (dirs.length > 0 && dirs[0] !== '$') {
                if (adfsState !== undefined) {
                    dirs = adfsState.getCurrent().dir.concat(dirs);
                } else {
                    return errors.badName();
                }
            }

            dirExplicit = true;
        }

        // Fix up the directory names.
        log?.pn(`Fix up directories: `);
        let dirIndex = 0;
        while (dirIndex < dirs.length) {
            log?.pn(`  dirs[${dirIndex}]="${dirs[dirIndex]}"`);
            if (dirs[dirIndex] === '$' && dirIndex > 0) {
                dirs = dirs.slice(dirIndex);
                dirIndex = 1;//skip the $
            } else if (dirs[dirIndex] === '^') {
                // Remove 2 items - this one, and the previous (if there is one).
                if (dirIndex === 0) {
                    dirs.splice(dirIndex);
                } else {
                    --dirIndex;
                    dirs.splice(dirIndex, 2);
                }
            } else if (!ADFSType.isValidBeebDirectoryName(dirs[dirIndex])) {
                return errors.badName();
            } else {
                ++dirIndex;
            }
        }

        // The whole point of an FQN is that it's FQ.
        if (dirs.length === 0 || dirs[0] !== '$') {
            dirs.unshift('$');
        }

        return {
            filePath: new beebfs.FilePath(volume, volumeExplicit, drive, driveExplicit, dirs.join('.'), dirExplicit),
            i,
            name,
        };
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export default new ADFSType();
