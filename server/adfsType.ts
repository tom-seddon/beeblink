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
//import CommandLine from './CommandLine';
import * as inf from './inf';
import * as server from './server';

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

function getAbsPath(volume: beebfs.Volume, volRelPath: VolRelPath): AbsPath {
    return path.join(volume.path, volRelPath) as AbsPath;
}

function getAttributesString(attr: beebfs.FileAttributes, isDirectory: boolean): string {
    let str = '';

    if (attr & beebfs.R_ATTR) {
        str += 'R';
    }

    if (attr & beebfs.W_ATTR) {
        str += 'W';
    }

    if (attr & beebfs.L_ATTR) {
        str += 'L';
    }

    if (attr & beebfs.E_ATTR) {
        str += 'E';
    }

    if (isDirectory) {
        str += 'D';
    }

    return str;
}

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

// Similar to beebfs.File, but for an ADFS directory.
class Dir {
    public readonly serverPath: string;

    public readonly fqn: beebfs.FQN;

    public readonly attr: beebfs.FileAttributes;

    public constructor(serverPath: string, fqn: beebfs.FQN, attr: beebfs.FileAttributes) {
        this.serverPath = serverPath;
        this.fqn = fqn;
        this.attr = attr;
    }

    public toString(): string {
        return `Dir(serverPath=\`\`${this.serverPath}'' fqn=\`\`${this.fqn}'' attr = 0x${utils.hex8(this.attr)})`;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSFilePath extends beebfs.FilePath {
    public readonly serverFolder: AbsPath | undefined;

    public constructor(volume: beebfs.Volume, volumeExplicit: boolean, drive: string, driveExplicit: boolean, dir: string, dirExplicit: boolean, serverFolder: AbsPath | undefined) {
        super(volume, volumeExplicit, drive, driveExplicit, dir, dirExplicit);

        if (serverFolder !== undefined) {
            this.serverFolder = utils.getSeparatorAndCaseNormalizedPath(serverFolder) as AbsPath;
        }
    }

    public override getFQNSuffix(): string | undefined {
        return this.serverFolder;
    }
}

function mustBeADFSFilePath(filePath: beebfs.FilePath): ADFSFilePath {
    if (!(filePath instanceof ADFSFilePath)) {
        throw new Error('not ADFSFilePath');
    }

    return filePath;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSPath {
    public constructor(public readonly drive: string, public readonly dir: string) { }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSTransientSettings {
    public constructor(public readonly current: ADFSPath, public readonly library: ADFSPath) { }
}

const gDefaultTransientSettings = new ADFSTransientSettings(new ADFSPath('0', '$'), new ADFSPath('0', '$'));

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSState implements beebfs.IFSState {
    public readonly volume: beebfs.Volume;

    private current: ADFSPath;
    private library: ADFSPath;

    private readonly log: utils.Log | undefined;// tslint:disable-line no-unused-variable

    public constructor(volume: beebfs.Volume, transientSettingsAny: unknown, log: utils.Log | undefined) {
        this.volume = volume;
        this.log = log;

        const transientSettings = ADFSState.getADFSTransientSettings(transientSettingsAny);

        this.current = transientSettings.current;
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

    public getCurrentDrive(): string {
        return this.current.drive;
    }

    public getCurrentDir(): string {
        return this.current.dir;
    }

    public getLibraryDrive(): string {
        return this.library.drive;
    }

    public getLibraryDir(): string {
        return this.library.dir;
    }

    public getTransientSettings(): ADFSTransientSettings {
        return new ADFSTransientSettings(this.current, this.library);
    }

    public getTransientSettingsString(settingsAny: unknown): string {
        const settings = ADFSState.getADFSTransientSettings(settingsAny);

        return `Default dir:${settings.current.drive}.${settings.current.dir}${utils.BNL}Default lib:${settings.library.drive}.${settings.library.dir}${utils.BNL} `;
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
            const libPath = new beebfs.FilePath(fqn.filePath.volume, fqn.filePath.volumeExplicit, this.library.drive, true, this.library.dir, true);
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
            filePath = new beebfs.FilePath(this.volume, false, this.current.drive, false, this.current.dir, false);
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
            this.current = new ADFSPath(arg, this.current.dir);
        } else {
            const filePath = this.volume.type.parseDirString(arg, 0, this, this.volume, false);
            if (!filePath.driveExplicit || filePath.dirExplicit) {
                return errors.badDrive();
            }

            this.current = new ADFSPath(filePath.drive, this.current.dir);
        }

        return true;
    }

    public starDir(filePath: beebfs.FilePath | undefined): void {
        if (filePath !== undefined) {
            this.current = this.getADFSPathFromFilePath(filePath);
        } else {
            this.current = new ADFSPath(this.current.drive, gDefaultTransientSettings.current.dir);
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

    public async readNames(): Promise<string[]> {
        const fqn = new beebfs.FQN(new beebfs.FilePath(this.volume, false, this.current.drive, true, this.current.dir, true), utils.MATCH_N_CHAR);
        const files = await this.volume.type.findBeebFilesMatching(fqn, undefined);

        const names: string[] = [];
        for (const file of files) {
            names.push(file.fqn.name);
        }

        return names;
    }

    public getCommands(): server.Command[] {
        // TODO... bunch of stuff to fill in here
        return [];
    }

    private getADFSPathFromFilePath(filePath: beebfs.FilePath): ADFSPath {
        if (filePath.volumeExplicit) {
            return errors.badDir();
        }

        return new ADFSPath(filePath.drive, filePath.dir);
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSType implements beebfs.IFSType {
    public readonly name = 'BeebLink/ADFS';

    public static isValidDrive(maybeDrive: string): boolean {
        return maybeDrive.length === 1 && utils.isalnum(maybeDrive);
    }

    private static isValidFileNameChar(char: string): boolean {
        const c = char.charCodeAt(0);
        return c >= 32 && c < 127;
    }

    public async createState(volume: beebfs.Volume, transientSettings: unknown, persistentSettings: unknown, log: utils.Log | undefined): Promise<beebfs.IFSState> {
        return new ADFSState(volume, transientSettings, log);
    }

    public canWrite(): boolean {
        return true;
    }

    public isValidBeebFileName(str: string): boolean {
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

    public getIdealVolumeRelativeServerPath(fqn: beebfs.FQN): VolRelPath {
        const adfsFilePath = mustBeADFSFilePath(fqn.filePath);

        // Can't remember what would actually cause this
        if (adfsFilePath.serverFolder === undefined) {
            return errors.generic('Unknown server folder');
        }

        return path.join(adfsFilePath.serverFolder, beebfs.getServerCharsForName(fqn.name)) as VolRelPath;
    }

    public async findBeebFilesInVolume(volume: beebfs.Volume, log: utils.Log | undefined): Promise<beebfs.File[]> {
        return await this.findDirEntries(volume, utils.MATCH_ANY_REG_EXP, utils.MATCH_ANY_REG_EXP, utils.MATCH_ANY_REG_EXP, true, false, log);
    }

    public async locateBeebFiles(fqn: beebfs.FQN, log: utils.Log | undefined): Promise<beebfs.File[]> {
        const driveRegExp = utils.getRegExpFromAFSP(fqn.filePath.drive);
        const dirRegExp = utils.getRegExpFromAFSP(fqn.filePath.dir);
        const nameRegExp = utils.getRegExpFromAFSP(fqn.name);

        return await this.findDirEntries(fqn.filePath.volume, driveRegExp, dirRegExp, nameRegExp, true, false, log);
    }

    public async findBeebFilesMatching(fqn: beebfs.FQN, log: utils.Log | undefined): Promise<beebfs.File[]> {
        const driveRegExp = utils.getRegExpFromAFSP(fqn.filePath.drive);
        const dirRegExp = utils.getRegExpFromAFSP(fqn.filePath.dir);
        const nameRegExp = utils.getRegExpFromAFSP(fqn.name);

        return await this.findDirEntries(fqn.filePath.volume, driveRegExp, dirRegExp, nameRegExp, false, false, log);
    }

    public async getCAT(filePath: beebfs.FilePath, state: beebfs.IFSState | undefined, _log: utils.Log | undefined): Promise<string> {
        //const adfsState = mustBeADFSState(state);

        const beebEntries = await this.findDirEntries(filePath.volume, utils.getRegExpFromAFSP(filePath.drive), utils.getRegExpFromAFSP(filePath.dir), utils.MATCH_ANY_REG_EXP, false, true, _log);

        let text = '';

        text += `Volume: ${filePath.volume.name}${utils.BNL}`;
        text += `Drive: ${filePath.drive}${utils.BNL}`;
        text += `Dir: ${filePath.dir}${utils.BNL}`;
        text += utils.BNL;

        const catStartIndex = text.length;
        for (const beebEntry of beebEntries) {
            const attributesWidth = 6;
            if (beebEntry instanceof beebfs.File) {
                text += getAttributesString(beebEntry.attr, false).padEnd(attributesWidth);
                text += beebEntry.fqn.name;
            } else if (beebEntry instanceof Dir) {
                text += getAttributesString(beebEntry.attr, true).padEnd(attributesWidth);
                text += beebEntry.fqn.name;
            }

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

    public async renameFile(_oldFile: beebfs.File, _newFQN: beebfs.FQN): Promise<void> {
        return errors.generic('TODO: rename');
    }

    public async writeBeebMetadata(serverPath: string, fqn: beebfs.FQN, load: beebfs.FileAddress, exec: beebfs.FileAddress, attr: beebfs.FileAttributes): Promise<void> {
        // TODO... fill out the size! Though BeebLink does ignore it.
        await inf.writeStandardINFFile(serverPath, fqn.name, load, exec, 0, attr, undefined);
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

    public getInfoText(file: beebfs.File, fileSize: number): string {
        return this.getCommonInfoText(file, fileSize);
    }

    public getWideInfoText(file: beebfs.File, stats: fs.Stats): string {
        return `${this.getCommonInfoText(file, stats.size)} ${utils.getDateString(stats.mtime)}`;
    }

    public getAttrString(file: beebfs.File): string | undefined {
        return getAttributesString(file.attr, false);
    }

    private getCommonInfoText(file: beebfs.File, fileSize: number): string {
        // The normal ADFS *INFO doesn't bother to fit into Mode 7, so this doesn't either.
        return `${file.fqn.name.padEnd(15)} ${getAttributesString(file.attr, false).padEnd(6)} ${utils.hex8(file.load)} ${utils.hex8(file.exec)} ${fileSize}`;
    }

    // private async findDirEntriesInFilePath(filePath: beebfs.FilePath, log: utils.Log | undefined): Promise<(beebfs.File | Dir)[]> {
    //     const infos:inf.IINT[]=await inf.getINFsForFolder(filePath.
    // }

    private async findDirEntries(volume: beebfs.Volume, driveRegExp: RegExp | undefined, dirRegExp: RegExp | undefined, nameRegExp: RegExp | undefined, recurse: boolean, includeDirs: false, log: utils.Log | undefined): Promise<beebfs.File[]>;
    private async findDirEntries(volume: beebfs.Volume, driveRegExp: RegExp | undefined, dirRegExp: RegExp | undefined, nameRegExp: RegExp | undefined, recurse: boolean, includeDirs: true, log: utils.Log | undefined): Promise<(beebfs.File | Dir)[]>;
    private async findDirEntries(volume: beebfs.Volume, driveRegExp: RegExp | undefined, dirRegExp: RegExp | undefined, nameRegExp: RegExp | undefined, recurse: boolean, includeDirs: boolean, log: utils.Log | undefined): Promise<(beebfs.File | Dir)[]> {
        const drives = await this.findDrivesForVolume(volume, driveRegExp);

        if (log !== undefined) {
            log.p(`${drives.length} ADFS Drives found:`);
            for (let i = 0; i < drives.length; ++i) {
                log.pn(`  ${i}. ${drives[i].beebName} - ${drives[i].serverFolder}`);
            }
        }

        const dirEntries: (beebfs.File | Dir)[] = [];

        const findDirEntriesRecursive = async (serverPath: AbsPath, filePath: beebfs.FilePath, indent: string): Promise<void> => {
            const infos: inf.IINF[] = await inf.getINFsForFolder(serverPath, includeDirs, log);
            for (const info of infos) {
                const fqn = new beebfs.FQN(filePath, info.name);
                log?.pn(`${indent}${fqn} - ${info.serverPath}`);
                if (info.extra !== undefined && info.extra.dir) {
                    const entry = new Dir(info.serverPath, fqn, info.attr);
                    dirEntries.push(entry);

                    // TODO... would it be better to recurse out of line?
                    if (recurse) {
                        const newFilePath = new ADFSFilePath(filePath.volume, filePath.volumeExplicit, filePath.drive, filePath.driveExplicit, filePath.dir + '.' + info.name, false, serverPath);
                        await findDirEntriesRecursive(info.serverPath as AbsPath, newFilePath, indent + '  ');
                    }
                } else {
                    const entry = new beebfs.File(info.serverPath, fqn, info.load, info.exec, info.attr);
                    dirEntries.push(entry);
                }
            }
        };

        for (const drive of drives) {
            const rootPath = getAbsPath(volume, drive.serverFolder);
            log?.pn(`${drive.beebName}: rootPath: ${rootPath}`);
            await findDirEntriesRecursive(rootPath, new beebfs.FilePath(volume, true, drive.beebName, true, '$', false), '');
        }

        return dirEntries;
    }

    private parseFileOrDirString(str: string, i: number, state: beebfs.IFSState | undefined, parseAsDir: boolean, volume: beebfs.Volume, volumeExplicit: boolean): { filePath: beebfs.FilePath; name: string | undefined; i: number; } {
        const adfsState = mustBeADFSState(state);

        if (i === str.length) {
            if (adfsState === undefined) {
                return errors.badName();
            }

            return {
                filePath: new ADFSFilePath(volume, volumeExplicit, adfsState.getCurrentDrive(), false, adfsState.getCurrentDir(), false, undefined),
                name: undefined,
                i: 0,
            };
        }

        let drive: string | undefined;
        let dir: string | undefined;
        let name: string | undefined;

        if (str[i] === ':' && i + 1 < str.length) {
            drive = str[i + 1];
            i += 2;

            if (str[i] !== '.') {
                return errors.badName();
            }
            i += 1;
        }

        // TODO... need to stop at the first space? This will surely eat too much sometimes.
        if (parseAsDir) {
            dir = str.slice(i);
            if (dir.length === 0) {
                dir = undefined;
            }
        } else {
            const lastSeparatorIndex = str.lastIndexOf('.');
            if (lastSeparatorIndex < i) {
                name = str.slice(i);
            } else {
                dir = str.slice(i, lastSeparatorIndex - i);
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
        if (dir === undefined) {
            if (adfsState !== undefined) {
                dir = adfsState.getCurrentDir();
            } else {
                dir = gDefaultTransientSettings.current.dir;
            }

            dirExplicit = false;
        } else {
            dirExplicit = true;
        }

        return {
            filePath: new ADFSFilePath(volume, volumeExplicit, drive, driveExplicit, dir, dirExplicit, undefined),
            i,
            name,
        };
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export default new ADFSType();
