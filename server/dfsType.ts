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

function mustBeDFSFQN(fqn: beebfs.FQN): DFSFQN {
    if (!(fqn instanceof DFSFQN)) {
        throw new Error('not DFSFQN');
    }

    return fqn;
}

function mustBeDFSFQNWithName(fqn: beebfs.FQN): DFSFQN {
    const dfsFQN = mustBeDFSFQN(fqn);

    if (dfsFQN.name === undefined) {
        throw new Error(`not DFSFQN with name`);
    }

    return dfsFQN;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class DFSFQN extends beebfs.FQN {
    public readonly drive: string;
    public readonly driveExplicit: boolean;
    public readonly dir: string;
    public readonly dirExplicit: boolean;
    public readonly name: string | undefined;

    public constructor(volume: beebfs.Volume, volumeExplicit: boolean, drive: string, driveExplicit: boolean, dir: string, dirExplicit: boolean, name: string | undefined) {
        super(volume, volumeExplicit);

        this.drive = drive;
        this.driveExplicit = driveExplicit;
        this.dir = dir;
        this.dirExplicit = dirExplicit;
        this.name = name;
    }

    public equals(other: beebfs.FQN): boolean {
        if (!(other instanceof DFSFQN)) {
            return false;
        }

        if (!super.equals(other)) {
            return false;
        }

        if (!utils.strieq(this.drive, other.drive)) {
            return false;
        }

        if (!utils.strieq(this.dir, other.dir)) {
            return false;
        }

        if (!utils.struieq(this.name, other.name)) {
            return false;
        }

        return true;
    }

    public toString(): string {
        let str = `${super.toString()}:${this.drive}.${this.dir}`;
        if (this.name !== undefined) {
            str += `.${this.name}`;
        }

        return str;
    }

    public isWildcard(): boolean {
        if (this.dir === utils.MATCH_N_CHAR || this.dir === utils.MATCH_ONE_CHAR) {
            return true;
        }

        if (this.name !== undefined) {
            for (const c of this.name) {
                if (c === utils.MATCH_N_CHAR || c === utils.MATCH_ONE_CHAR) {
                    return true;
                }
            }
        }

        return false;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IDFSDrive {
    readonly hostFolder: string;
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
    private static getDFSTransientSettings(settings: any | undefined): DFSTransientSettings {
        if (settings === undefined) {
            return gDefaultTransientSettings;
        }

        if (!(settings instanceof DFSTransientSettings)) {
            return gDefaultTransientSettings;
        }

        return settings;
    }

    public readonly volume: beebfs.Volume;

    private current: DFSPath;
    private library: DFSPath;

    private readonly log: utils.Log | undefined;// tslint:disable-line no-unused-variable

    public constructor(volume: beebfs.Volume, transientSettingsAny: any | undefined, log: utils.Log | undefined) {
        this.volume = volume;
        this.log = log;

        const transientSettings = DFSState.getDFSTransientSettings(transientSettingsAny);

        this.current = transientSettings.current;
        this.library = transientSettings.library;
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

    public getTransientSettingsString(settingsAny: any | undefined): string {
        const settings = DFSState.getDFSTransientSettings(settingsAny);

        return `Default dir :${settings.current.drive}.${settings.current.dir}${utils.BNL}Default lib :${settings.library.drive}.${settings.library.dir}${utils.BNL}`;
    }

    public getPersistentSettings(): undefined {
        return undefined;
    }

    public getPersistentSettingsString(settings: undefined): string {
        return '';
    }

    public async getFileForRUN(fqn: beebfs.FQN, tryLibDir: boolean): Promise<beebfs.File | undefined> {
        const dfsFQN = mustBeDFSFQN(fqn);

        if (dfsFQN.name === undefined) {
            return undefined;
        }

        // Additional DFS rules for tryLibDir.
        if (dfsFQN.driveExplicit || dfsFQN.dirExplicit) {
            tryLibDir = false;
        }

        const curFile = await beebfs.getBeebFile(fqn, true, false);
        if (curFile !== undefined) {
            return curFile;
        }

        if (tryLibDir) {
            const libFQN = new DFSFQN(fqn.volume, fqn.volumeExplicit, this.library.drive, true, this.library.dir, true, dfsFQN.name);
            const libFile = await beebfs.getBeebFile(libFQN, true, false);
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

        const fqn = new DFSFQN(this.volume, false, drive, true, this.current.dir, false, undefined);
        return await this.volume.type.getCAT(fqn, this, this.log);
    }

    public starDrive(arg: string | undefined): boolean {
        if (arg === undefined) {
            return errors.badDrive();
        }

        if (DFSType.isValidDrive(arg)) {
            this.current = new DFSPath(arg, this.current.dir);
        } else {
            const fqn = mustBeDFSFQN(this.volume.type.parseFileOrDirString(arg, 0, this, true, this.volume, false));
            if (!fqn.driveExplicit || fqn.dirExplicit) {
                return errors.badDrive();
            }

            this.current = new DFSPath(fqn.drive, this.current.dir);
        }

        return true;
    }

    public starDir(fqn: beebfs.FQN): void {
        this.current = this.getPathFromFQN(fqn);
    }

    public starLib(fqn: beebfs.FQN): void {
        this.library = this.getPathFromFQN(fqn);
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
        const fqn = new DFSFQN(this.volume, false, this.current.drive, true, this.current.dir, true, undefined);
        const files = await this.volume.type.findBeebFilesMatching(fqn, false, undefined);

        const names: string[] = [];
        for (const file of files) {
            const dfsFQN = mustBeDFSFQN(file.fqn);
            names.push(dfsFQN.name!);
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

    private getPathFromFQN(fqn: beebfs.FQN): DFSPath {
        const dfsFQN = mustBeDFSFQN(fqn);

        if (fqn.volumeExplicit || dfsFQN.name !== undefined) {
            return errors.badDir();
        }

        return new DFSPath(dfsFQN.drive, dfsFQN.dir);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class DFSType implements beebfs.IFSType {
    public static isValidDrive(maybeDrive: string): boolean {
        return maybeDrive.length === 1 && utils.isalnum(maybeDrive);
    }

    private static isValidFileNameChar(char: string) {
        const c = char.charCodeAt(0);
        return c >= 32 && c < 127;
    }

    public readonly name = 'BeebLink/DFS';

    public async createState(volume: beebfs.Volume, transientSettings: any | undefined, persistentSettings: any | undefined, log: utils.Log | undefined): Promise<beebfs.IFSState> {
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

    public parseFileOrDirString(str: string, i: number, state: beebfs.IFSState | undefined, parseAsDir: boolean, volume: beebfs.Volume, volumeExplicit: boolean): DFSFQN {
        const dfsState = mustBeDFSState(state);

        let drive: string | undefined;
        let dir: string | undefined;
        let name: string | undefined;

        if (i === str.length) {
            if (dfsState === undefined) {
                return errors.badName();
            }

            return new DFSFQN(volume, volumeExplicit, dfsState.getCurrentDrive(), false, dfsState.getCurrentDir(), false, undefined);
        }

        if (str[i] === ':' && i + 1 < str.length) {
            if (!DFSType.isValidDrive(str[i + 1])) {
                return errors.badDrive();
            }

            drive = str[i + 1];
            i += 2;

            if (str[i] === '.') {
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

        return new DFSFQN(volume, volumeExplicit, drive, driveExplicit, dir, dirExplicit, name);
    }

    public getIdealVolumeRelativeHostPath(fqn: beebfs.FQN): string {
        const dfsFQN = mustBeDFSFQNWithName(fqn);

        return path.join(dfsFQN.drive.toUpperCase(), beebfs.getHostChars(dfsFQN.dir) + '.' + beebfs.getHostChars(dfsFQN.name!));
    }

    public async findBeebFilesInVolume(volumeOrFQN: beebfs.Volume | beebfs.FQN, log: utils.Log | undefined): Promise<beebfs.File[]> {
        if (volumeOrFQN instanceof beebfs.Volume) {
            return await this.findFiles(volumeOrFQN, undefined, undefined, undefined, log);
        } else {
            return await this.findBeebFilesMatching(volumeOrFQN, false, log);
        }
    }

    public async findBeebFilesMatching(fqn: beebfs.FQN, recurse: boolean, log: utils.Log | undefined): Promise<beebfs.File[]> {
        // The recurse flag is ignored. There is no hierarchy within a BeebLink volume.

        const dfsFQN = mustBeDFSFQN(fqn);

        const driveRegExp = utils.getRegExpFromAFSP(dfsFQN.drive);
        const dirRegExp = utils.getRegExpFromAFSP(dfsFQN.dir);
        const nameRegExp = dfsFQN.name !== undefined ? utils.getRegExpFromAFSP(dfsFQN.name) : undefined;

        return await this.findFiles(fqn.volume, driveRegExp, dirRegExp, nameRegExp, log);
    }

    public async getCAT(fqn: beebfs.FQN, state: beebfs.IFSState | undefined, log: utils.Log | undefined): Promise<string> {
        const dfsFQN = mustBeDFSFQN(fqn);
        const dfsState = mustBeDFSState(state);

        if (!dfsFQN.driveExplicit || dfsFQN.dirExplicit) {
            return errors.badDrive();
        }

        const beebFiles = await this.findBeebFilesMatching(new DFSFQN(fqn.volume, true, dfsFQN.drive, true, '*', false, undefined), false, undefined);

        let text = '';

        const title = await this.loadTitle(fqn.volume, dfsFQN.drive);
        if (title !== '') {
            text += title + utils.BNL;
        }

        text += 'Volume: ' + fqn.volume.name + utils.BNL;

        const boot = await this.loadBootOption(fqn.volume, dfsFQN.drive);
        text += ('Drive ' + dfsFQN.drive + ' (' + boot + ' - ' + beebfs.getBootOptionDescription(boot) + ')').padEnd(20);

        if (dfsState !== undefined) {
            text += ('Dir :' + dfsState.getCurrentDrive() + '.' + dfsState.getCurrentDir()).padEnd(10);

            text += 'Lib :' + dfsState.getLibraryDrive() + '.' + dfsState.getLibraryDir();
        }

        text += utils.BNL + utils.BNL;

        // let dir: string;
        // if (dfsFQN.dir !== undefined) {
        //     dir = dfsFQN.dir;
        // } else if (dfsState !== undefined) {
        //     dir = dfsState.dir;
        // } else {
        //     dir = '$';
        // }

        for (const beebFile of beebFiles) {
            mustBeDFSFQN(beebFile.fqn);
        }

        beebFiles.sort((a, b) => {
            const aNameFSName = a.fqn as DFSFQN;
            const bNameFSName = b.fqn as DFSFQN;

            if (aNameFSName.dir === dfsFQN.dir && bNameFSName.dir !== dfsFQN.dir) {
                return -1;
            } else if (aNameFSName.dir !== dfsFQN.dir && bNameFSName.dir === dfsFQN.dir) {
                return 1;
            } else {
                const cmpDirs = utils.stricmp(aNameFSName.dir, bNameFSName.dir);
                if (cmpDirs !== 0) {
                    return cmpDirs;
                }

                return utils.stricmp(aNameFSName.name!, bNameFSName.name!);
            }
        });

        for (const beebFile of beebFiles) {
            const fileFSName = beebFile.fqn as DFSFQN;

            let name;
            if (fileFSName.dir === dfsFQN.dir) {
                name = `  ${fileFSName.name!}`;
            } else {
                name = `${fileFSName.dir}.${fileFSName.name!}`;
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
            await utils.forceFsUnlink(file.hostPath + inf.ext);
            await utils.forceFsUnlink(file.hostPath);
        } catch (error) {
            errors.nodeError(error as NodeJS.ErrnoException);
        }
    }

    public async renameFile(oldFile: beebfs.File, newFQN: beebfs.FQN): Promise<void> {
        const newDFSFQN = mustBeDFSFQN(newFQN);

        const newHostPath = path.join(newFQN.volume.path, this.getIdealVolumeRelativeHostPath(newDFSFQN));
        await inf.mustNotExist(newHostPath);

        const newFile = new beebfs.File(newHostPath, newFQN, oldFile.load, oldFile.exec, oldFile.attr, false);

        await this.writeBeebMetadata(newFile.hostPath, newDFSFQN, newFile.load, newFile.exec, newFile.attr);

        try {
            await utils.fsRename(oldFile.hostPath, newFile.hostPath);
        } catch (error) {
            return errors.nodeError(error);
        }

        await utils.forceFsUnlink(oldFile.hostPath + inf.ext);
    }

    public async writeBeebMetadata(hostPath: string, fqn: beebfs.FQN, load: number, exec: number, attr: number): Promise<void> {
        const dfsFQN = mustBeDFSFQN(fqn);

        await inf.writeFile(hostPath, `${dfsFQN.dir}.${dfsFQN.name}`, load, exec, (attr & beebfs.L_ATTR) !== 0 ? 'L' : '');
    }

    public getNewAttributes(oldAttr: number, attrString: string): number | undefined {
        if (attrString === '') {
            return beebfs.DEFAULT_ATTR;
        } else if (attrString.toLowerCase() === 'l') {
            return beebfs.DEFAULT_ATTR | beebfs.L_ATTR;
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
                            hostFolder: name,
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
            const drivePath = path.join(volume.path, drive.hostFolder);
            const infos = await inf.getINFsForFolder(drivePath, log);

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

                const fqn = new DFSFQN(volume, true, drive.beebName, true, dir, true, name);
                const file = new beebfs.File(info.hostPath, fqn, info.load, info.exec, info.attr | beebfs.DEFAULT_ATTR, false);
                log?.pn(`${file}`);

                beebFiles.push(file);
            }
        }

        return beebFiles;
    }

    private getCommonInfoText(file: beebfs.File, fileSize: number): string {
        const dfsFQN = mustBeDFSFQNWithName(file.fqn);

        const attr = this.getAttrString(file);
        const load = utils.hex8(file.load).toUpperCase();
        const exec = utils.hex8(file.exec).toUpperCase();
        const size = utils.hex(fileSize & 0x00ffffff, 6).toUpperCase();

        // 0123456789012345678901234567890123456789
        // _.__________ L 12345678 12345678 123456
        return `${dfsFQN.dir}.${dfsFQN.name!.padEnd(10)} ${attr} ${load} ${exec} ${size}`;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export default new DFSType();
