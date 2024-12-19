//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
// Copyright (C) 2019, 2020 Tom Seddon
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
import * as beebfs from './beebfs';
import * as errors from './errors';
import * as inf from './inf';
import * as utils from './utils';
import * as server from './server';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// 10 is the CFS/CFS/ADFS limit, so it's not pushing the boat out *too* much...
const MAX_NAME_LENGTH = 10;

// Must be <255, but aside from that it's an arbitrary limit. (39 = it fits in
// Mode 7.)
const MAX_TITLE_LENGTH = 39;

const OPT4_FILE_NAME = '.opt4';
const TITLE_FILE_NAME = '.title';

const DEFAULT_TITLE = '';
const DEFAULT_BOOT_OPTION = 0;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function mustBeDFSType(type: beebfs.IFSType): DFSType {
    if (!(type instanceof DFSType)) {
        throw new Error('not DFSType');
    }

    return type;
}

function mustBeDFSState(state: beebfs.IFSState | undefined): DFSState | undefined {
    if (state !== undefined) {
        if (!(state instanceof DFSState)) {
            throw new Error('not DFSState');
        }
    }

    return state;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IDFSDrive {
    readonly serverFolder: string;
    readonly beebName: string;
    readonly option: number;
    readonly title: string;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// "path"
class DFSPath {
    public constructor(public readonly drive: string, public readonly dir: string) { }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// this is a class purely so that 'instanceof' can be used.
class DFSTransientSettings {
    public constructor(public readonly current: DFSPath, public readonly library: DFSPath) { }
}

const gDefaultTransientSettings = new DFSTransientSettings(new DFSPath('0', '$'), new DFSPath('0', '$'));

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class DFSState implements beebfs.IFSState {
    public readonly volume: beebfs.Volume;

    private current: DFSPath;
    private library: DFSPath;

    private readonly log: utils.Log | undefined;// tslint:disable-line no-unused-variable

    public constructor(volume: beebfs.Volume, transientSettingsAny: unknown, log: utils.Log | undefined) {
        this.volume = volume;
        this.log = log;

        const transientSettings = DFSState.getDFSTransientSettings(transientSettingsAny);

        this.current = transientSettings.current;
        this.library = transientSettings.library;
    }

    private static getDFSTransientSettings(settings: unknown): DFSTransientSettings {
        if (settings === undefined) {
            return gDefaultTransientSettings;
        }

        if (!(settings instanceof DFSTransientSettings)) {
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

    public getTransientSettings(): DFSTransientSettings {
        return new DFSTransientSettings(this.current, this.library);
    }

    public getTransientSettingsString(settingsAny: unknown): string {
        const settings = DFSState.getDFSTransientSettings(settingsAny);

        return `Default dir :${settings.current.drive}.${settings.current.dir}${utils.BNL}Default lib :${settings.library.drive}.${settings.library.dir}${utils.BNL}`;
    }

    public getPersistentSettings(): undefined {
        return undefined;
    }

    public getPersistentSettingsString(_settings: unknown): string {
        return '';
    }

    public async getFileForRUN(fqn: beebfs.FQN, tryLibDir: boolean): Promise<beebfs.File | undefined> {
        // Additional DFS rules for tryLibDir.
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
        let drive: string;
        if (commandLine === undefined) {
            drive = this.current.drive;
        } else if (DFSType.isValidDrive(commandLine)) {
            drive = commandLine;
        } else {
            return undefined;
        }

        const filePath = new beebfs.FilePath(this.volume, false, drive, true, this.current.dir, false);
        return await this.volume.type.getCAT(filePath, this, this.log);
    }

    public starDrive(arg: string | undefined): boolean {
        if (arg === undefined) {
            return errors.badDrive();
        }

        if (DFSType.isValidDrive(arg)) {
            this.current = new DFSPath(arg, this.current.dir);
        } else {
            const filePath = this.volume.type.parseDirString(arg, 0, this, this.volume, false);
            if (!filePath.driveExplicit || filePath.dirExplicit) {
                return errors.badDrive();
            }

            this.current = new DFSPath(filePath.drive, this.current.dir);
        }

        return true;
    }

    public starDir(filePath: beebfs.FilePath | undefined): void {
        if (filePath !== undefined) {
            this.current = this.getDFSPathFromFilePath(filePath);
        }
    }

    public starLib(filePath: beebfs.FilePath | undefined): void {
        if (filePath !== undefined) {
            this.library = this.getDFSPathFromFilePath(filePath);
        } else {
            // This is what DFS 2.45 does, and BeebLink's DFS mode is trying to
            // copy DFS...
            this.library = gDefaultTransientSettings.library;
        }
    }

    public async getDrivesOutput(): Promise<string> {
        const drives = await mustBeDFSType(this.volume.type).findDrivesForVolume(this.volume, undefined);

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
        const dfsType = mustBeDFSType(this.volume.type);
        return await dfsType.loadBootOption(this.volume, this.current.drive);
    }

    public async setBootOption(option: number): Promise<void> {
        const str = (option & 3).toString() + os.EOL;
        await beebfs.writeFile(path.join(this.volume.path, this.current.drive, OPT4_FILE_NAME), Buffer.from(str, 'binary'));
    }

    public async setTitle(title: string): Promise<void> {
        const buffer = Buffer.from(title.substring(0, MAX_TITLE_LENGTH) + os.EOL, 'binary');
        await beebfs.writeFile(path.join(this.volume.path, this.current.drive, TITLE_FILE_NAME), buffer);
    }

    public async getTitle(): Promise<string> {
        const dfsType = mustBeDFSType(this.volume.type);
        return await dfsType.loadTitle(this.volume, this.current.drive);
    }

    public async readNames(): Promise<string[]> {
        const fqn = new beebfs.FQN(new beebfs.FilePath(this.volume, false, this.current.drive, true, this.current.dir, true), utils.MATCH_N_CHAR);
        const files = await this.volume.type.findObjectsMatching(fqn, undefined);

        const names: string[] = [];
        for (const file of files) {
            names.push(file.fqn.name);
        }

        return names;
    }

    public getCommands(): server.Command[] {
        return [
            //new server.Command('TEST', undefined, this.testCommand),
        ];
    }

    // private async testCommand(commandLine: CommandLine): Promise<string> {
    //     return `hello${BNL}`;
    // }

    // TODO: surely this could be done a bit better...?
    private getDFSPathFromFilePath(filePath: beebfs.FilePath): DFSPath {
        if (filePath.volumeExplicit) {
            return errors.badDir();
        }

        return new DFSPath(filePath.drive, filePath.dir);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class DFSType implements beebfs.IFSType {
    public readonly name = 'BeebLink/DFS';

    public static isValidDrive(maybeDrive: string): boolean {
        return maybeDrive.length === 1 && utils.isalnum(maybeDrive);
    }

    private static isValidFileNameChar(char: string) {
        const c = char.charCodeAt(0);
        return c >= 32 && c < 127;
    }

    public async createState(volume: beebfs.Volume, transientSettings: unknown, persistentSettings: unknown, log: utils.Log | undefined): Promise<beebfs.IFSState> {
        return new DFSState(volume, transientSettings, log);
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

        if (!DFSType.isValidFileNameChar(str[0])) {
            return false;
        }

        for (let i = 2; i < str.length; ++i) {
            if (!DFSType.isValidFileNameChar(str[i])) {
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

    public async getIdealVolumeRelativeServerPath(fqn: beebfs.FQN): Promise<string> {
        return path.join(fqn.filePath.drive.toUpperCase(), beebfs.getServerCharsForNamePart(fqn.filePath.dir) + '.' + beebfs.getServerCharsForNamePart(fqn.name));
    }

    public async findBeebFilesInVolume(volume: beebfs.Volume, log: utils.Log | undefined): Promise<beebfs.File[]> {
        return await this.findFiles(volume, undefined, undefined, undefined, log);
    }

    public async locateBeebFiles(fqn: beebfs.FQN, log: utils.Log | undefined): Promise<beebfs.File[]> {
        const driveRegExp = fqn.filePath.driveExplicit ? utils.getRegExpFromAFSP(fqn.filePath.drive) : utils.MATCH_ANY_REG_EXP;
        const dirRegExp = fqn.filePath.driveExplicit ? utils.getRegExpFromAFSP(fqn.filePath.dir) : utils.MATCH_ANY_REG_EXP;
        const nameRegExp = utils.getRegExpFromAFSP(fqn.name);
        return await this.findFiles(fqn.filePath.volume, driveRegExp, dirRegExp, nameRegExp, log);
    }

    public async findObjectsMatching(fqn: beebfs.FQN, log: utils.Log | undefined): Promise<beebfs.File[]> {
        const driveRegExp = utils.getRegExpFromAFSP(fqn.filePath.drive);
        const dirRegExp = utils.getRegExpFromAFSP(fqn.filePath.dir);
        const nameRegExp = utils.getRegExpFromAFSP(fqn.name);

        return await this.findFiles(fqn.filePath.volume, driveRegExp, dirRegExp, nameRegExp, log);
    }

    public async getCAT(filePath: beebfs.FilePath, state: beebfs.IFSState | undefined, _log: utils.Log | undefined): Promise<string> {
        const dfsState = mustBeDFSState(state);

        if (!filePath.driveExplicit || filePath.dirExplicit) {
            return errors.badDrive();
        }

        const beebFiles = await this.findObjectsMatching(new beebfs.FQN(new beebfs.FilePath(filePath.volume, true, filePath.drive, true, '*', false), '*'), undefined);

        let text = '';

        const title = await this.loadTitle(filePath.volume, filePath.drive);
        if (title !== '') {
            text += title + utils.BNL;
        }

        text += 'Volume: ' + filePath.volume.name + utils.BNL;

        const boot = await this.loadBootOption(filePath.volume, filePath.drive);
        text += ('Drive ' + filePath.drive + ' (' + boot + ' - ' + beebfs.getBootOptionDescription(boot) + ')').padEnd(20);

        if (dfsState !== undefined) {
            text += ('Dir :' + dfsState.getCurrentDrive() + '.' + dfsState.getCurrentDir()).padEnd(10);

            text += 'Lib :' + dfsState.getLibraryDrive() + '.' + dfsState.getLibraryDir();
        }

        text += utils.BNL + utils.BNL;

        beebFiles.sort((a, b) => {
            if (a.fqn.filePath.dir === filePath.dir && b.fqn.filePath.dir !== filePath.dir) {
                return -1;
            } else if (a.fqn.filePath.dir !== filePath.dir && b.fqn.filePath.dir === filePath.dir) {
                return 1;
            } else {
                const cmpDirs = utils.stricmp(a.fqn.filePath.dir, b.fqn.filePath.dir);
                if (cmpDirs !== 0) {
                    return cmpDirs;
                }

                return utils.stricmp(a.fqn.name, b.fqn.name);
            }
        });

        for (const beebFile of beebFiles) {
            let name;
            if (beebFile.fqn.filePath.dir === filePath.dir) {
                name = `  ${beebFile.fqn.name}`;
            } else {
                name = `${beebFile.fqn.filePath.dir}.${beebFile.fqn.name}`;
            }

            if ((beebFile.attr & beebfs.L_ATTR) !== 0) {
                name = name.padEnd(14) + 'L';
            }

            text += ('  ' + name).padEnd(20);
        }

        text += utils.BNL;

        //this.log.withIndent('*CAT output: ', () => this.log.bpn(text));

        return text;
    }

    public async deleteFile(file: beebfs.File): Promise<void> {
        try {
            await utils.forceFsUnlink(file.serverPath + inf.ext);
            await utils.forceFsUnlink(file.serverPath);
        } catch (error) {
            errors.nodeError(error as NodeJS.ErrnoException);
        }
    }

    public async rename(oldFQN: beebfs.FQN, newFQN: beebfs.FQN): Promise<beebfs.IRenameFileResult> {
        const oldFile = await beebfs.mustGetBeebFile(oldFQN, false, undefined);

        const newServerPath = path.join(newFQN.filePath.volume.path, await this.getIdealVolumeRelativeServerPath(newFQN));
        await inf.mustNotExist(newServerPath);

        const newFile = new beebfs.File(newServerPath, newFQN, oldFile.load, oldFile.exec, oldFile.attr);

        await this.writeBeebMetadata(newFile.serverPath, newFQN, newFile.load, newFile.exec, newFile.attr);

        try {
            await utils.fsRename(oldFile.serverPath, newFile.serverPath);
        } catch (error) {
            return errors.nodeError(error);
        }

        await utils.forceFsUnlink(oldFile.serverPath + inf.ext);

        return { oldServerPath: oldFile.serverPath, newServerPath };
    }

    public async writeBeebMetadata(serverPath: string, fqn: beebfs.FQN, load: beebfs.FileAddress, exec: beebfs.FileAddress, attr: beebfs.FileAttributes): Promise<void> {
        await inf.writeNonStandardINFFile(serverPath, `${fqn.filePath.dir}.${fqn.name}`, load, exec, (attr & beebfs.L_ATTR) !== 0);
    }

    public getNewAttributes(oldAttr: beebfs.FileAttributes, attrString: string): beebfs.FileAttributes | undefined {
        if (attrString === '') {
            return beebfs.DEFAULT_ATTR;
        } else if (attrString.toLowerCase() === 'l') {
            return beebfs.DFS_LOCKED_ATTR;
        } else {
            return undefined;
        }
    }

    public async loadTitle(volume: beebfs.Volume, drive: string): Promise<string> {
        const buffer = await utils.tryReadFile(path.join(volume.path, drive, TITLE_FILE_NAME));
        if (buffer === undefined) {
            return DEFAULT_TITLE;
        }

        return utils.getFirstLine(buffer).substring(0, MAX_TITLE_LENGTH);
    }

    public async loadBootOption(volume: beebfs.Volume, drive: string): Promise<number> {
        const buffer = await utils.tryReadFile(path.join(volume.path, drive, OPT4_FILE_NAME));
        if (buffer === undefined || buffer.length === 0) {
            return DEFAULT_BOOT_OPTION;
        }

        return buffer[0] & 3;//ugh.
    }

    public getInfoText(file: beebfs.File, fileSize: number): string {
        return this.getCommonInfoText(file, fileSize);
    }

    public getWideInfoText(file: beebfs.File, stats: fs.Stats): string {
        return `${this.getCommonInfoText(file, stats.size)} ${utils.getDateString(stats.mtime)}`;
    }

    public getAttrString(file: beebfs.File): string | undefined {
        if ((file.attr & beebfs.L_ATTR) !== 0) {
            return 'L';
        } else {
            return ' ';
        }
    }

    public async findDrivesForVolume(volume: beebfs.Volume, driveRegExp: RegExp | undefined): Promise<IDFSDrive[]> {
        let names: string[];
        try {
            names = await utils.fsReaddir(volume.path);
        } catch (error) {
            return errors.nodeError(error);
        }

        const beebNamesSeen = new Set<string>();
        const drives = [];

        for (const name of names) {
            if (DFSType.isValidDrive(name)) {
                if (utils.matchesOptionalRegExp(name, driveRegExp)) {
                    const beebName = name.toUpperCase();
                    if (!beebNamesSeen.has(beebName)) {
                        const option = await this.loadBootOption(volume, name);
                        const title = await this.loadTitle(volume, name);

                        drives.push({
                            serverFolder: name,
                            beebName: name.toUpperCase(),
                            option,
                            title
                        });

                        beebNamesSeen.add(beebName);
                    }
                }
            }
        }

        return drives;
    }

    private async findFiles(volume: beebfs.Volume, driveRegExp: RegExp | undefined, dirRegExp: RegExp | undefined, nameRegExp: RegExp | undefined, log: utils.Log | undefined): Promise<beebfs.File[]> {
        const drives = await this.findDrivesForVolume(volume, driveRegExp);

        const beebFiles: beebfs.File[] = [];

        for (const drive of drives) {
            const drivePath = path.join(volume.path, drive.serverFolder);
            const infos = await inf.getINFsForFolder(drivePath, false, log);

            for (const info of infos) {
                if (!this.isValidBeebFileName(info.name)) {
                    continue;
                }

                const dir = info.name[0];
                if (!utils.matchesOptionalRegExp(dir, dirRegExp)) {
                    continue;
                }

                const name = info.name.slice(2);
                if (!utils.matchesOptionalRegExp(name, nameRegExp)) {
                    continue;
                }

                const fqn = new beebfs.FQN(new beebfs.FilePath(volume, true, drive.beebName, true, dir, true), name);
                const file = new beebfs.File(info.serverPath, fqn, info.load, info.exec, info.attr);
                log?.pn(`${file}`);

                beebFiles.push(file);
            }
        }

        return beebFiles;
    }

    private getCommonInfoText(file: beebfs.File, fileSize: number): string {
        const attr = this.getAttrString(file);
        const load = utils.hex8(file.load).toUpperCase();
        const exec = utils.hex8(file.exec).toUpperCase();
        const size = utils.hex(fileSize & 0x00ffffff, 6).toUpperCase();

        // 0123456789012345678901234567890123456789
        // _.__________ L 12345678 12345678 123456
        return `${file.fqn.filePath.dir}.${file.fqn.name.padEnd(10)} ${attr} ${load} ${exec} ${size}`;
    }

    private parseFileOrDirString(
        str: string,
        i: number,
        state: beebfs.IFSState | undefined,
        parseAsDir: boolean,
        volume: beebfs.Volume,
        volumeExplicit: boolean): { filePath: beebfs.FilePath; name: string | undefined; } {
        const dfsState = mustBeDFSState(state);

        let drive: string | undefined;
        let dir: string | undefined;
        let name: string | undefined;

        if (i === str.length) {
            if (dfsState === undefined) {
                return errors.badName();
            }

            return {
                filePath: new beebfs.FilePath(volume, volumeExplicit, dfsState.getCurrentDrive(), false, dfsState.getCurrentDir(), false),
                name: undefined,
            };
        }

        if (str[i] === ':' && i + 1 < str.length) {
            if (!DFSType.isValidDrive(str[i + 1])) {
                return errors.badDrive();
            }

            drive = str[i + 1];
            i += 2;

            if (i < str.length) {
                if (str[i] !== '.') {
                    return errors.badDrive();
                }
                ++i;
            }
        }

        if (str[i + 1] === '.') {
            if (!DFSType.isValidFileNameChar(str[i])) {
                return errors.badDir();
            }

            dir = str[i];
            i += 2;
        }

        if (parseAsDir) {
            if (i < str.length && dir !== undefined || i === str.length - 1 && !DFSType.isValidFileNameChar(str[i])) {
                return errors.badDir();
            }

            dir = str[i];
        } else {
            if (i < str.length) {
                for (let j = i; j < str.length; ++j) {
                    if (!DFSType.isValidFileNameChar(str[j])) {
                        return errors.badName();
                    }
                }

                name = str.slice(i);

                if (name.length > MAX_NAME_LENGTH) {
                    return errors.badName();
                }
            }
        }

        let driveExplicit: boolean;
        if (drive === undefined) {
            if (dfsState !== undefined) {
                drive = dfsState.getCurrentDrive();
            } else {
                drive = gDefaultTransientSettings.current.drive;
            }

            driveExplicit = false;
        } else {
            driveExplicit = true;
        }

        let dirExplicit: boolean;
        if (dir === undefined) {
            if (dfsState !== undefined) {
                dir = dfsState.getCurrentDir();
            } else {
                dir = gDefaultTransientSettings.current.dir;
            }

            dirExplicit = false;
        } else {
            dirExplicit = true;
        }

        return {
            filePath: new beebfs.FilePath(volume, volumeExplicit, drive, driveExplicit, dir, dirExplicit),
            name,
        };
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export default new DFSType();
