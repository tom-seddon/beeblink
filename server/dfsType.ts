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

function mustBeDFSFSP(fsp: beebfs.IFSFSP): DFSFSP {
    if (!(fsp instanceof DFSFSP)) {
        throw new Error('not DFSFSP');
    }

    return fsp;
}

function mustBeDFSFQN(fqn: beebfs.IFSFQN): DFSFQN {
    if (!(fqn instanceof DFSFQN)) {
        throw new Error('not DFSFQN');
    }

    return fqn;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class DFSFQN implements beebfs.IFSFQN {
    public readonly drive: string;
    public readonly dir: string;
    public readonly name: string;

    public constructor(drive: string, dir: string, name: string) {
        this.drive = drive;
        this.dir = dir;
        this.name = name;
    }

    public equals(other: beebfs.IFSFQN): boolean {
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

class DFSFSP implements beebfs.IFSFSP {
    public readonly drive: string | undefined;
    public readonly dir: string | undefined;
    public readonly name: string | undefined;

    public constructor(drive: string | undefined, dir: string | undefined, name: string | undefined) {
        this.drive = drive;
        this.dir = dir;
        this.name = name;
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

interface IDFSDrive {
    readonly name: string;
    readonly option: number;
    readonly title: string;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// this is a class purely so that 'instanceof' can be used.
class DFSTransientSettings {
    public readonly drive: string;
    public readonly dir: string;
    public readonly libDrive: string;
    public readonly libDir: string;

    public constructor(drive: string, dir: string, libDrive: string, libDir: string) {
        this.drive = drive;
        this.dir = dir;
        this.libDrive = libDrive;
        this.libDir = libDir;
    }
}

const gDefaultTransientSettings = new DFSTransientSettings('0', '$', '0', '$');

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

    public drive: string;
    public dir: string;

    public libDrive: string;
    public libDir: string;

    private readonly log: utils.Log | undefined;// tslint:disable-line no-unused-variable

    public constructor(volume: beebfs.Volume, transientSettingsAny: any | undefined, log: utils.Log | undefined) {
        this.volume = volume;
        this.log = log;

        const transientSettings = DFSState.getDFSTransientSettings(transientSettingsAny);

        this.drive = transientSettings.drive;
        this.dir = transientSettings.dir;
        this.libDrive = transientSettings.libDrive;
        this.libDir = transientSettings.libDir;
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

    public getTransientSettings(): DFSTransientSettings {
        return new DFSTransientSettings(this.drive, this.dir, this.libDrive, this.libDir);
    }

    public getTransientSettingsString(settingsAny: any | undefined): string {
        const settings = DFSState.getDFSTransientSettings(settingsAny);

        return `Default dir :${settings.drive}.${settings.dir}${utils.BNL}Default lib :${settings.libDrive}.${settings.libDir}${utils.BNL}`;
    }

    public getPersistentSettings(): undefined {
        return undefined;
    }

    public getPersistentSettingsString(settings: undefined): string {
        return '';
    }

    public async getFileForRUN(fsp: beebfs.FSP, tryLibDir: boolean): Promise<beebfs.File | undefined> {
        const fspName = mustBeDFSFSP(fsp.fsFSP);

        if (fspName.name === undefined) {
            return undefined;
        }

        // Additional DFS rules for tryLibDir.
        if (fspName.drive !== undefined || fspName.dir !== undefined) {
            tryLibDir = false;
        }

        const curFQN = new beebfs.FQN(fsp.volume, this.volume.type.createFQN(fspName, this));
        const curFile = await beebfs.getBeebFile(curFQN, true, false);
        if (curFile !== undefined) {
            return curFile;
        }

        if (tryLibDir) {
            const libFQN = new beebfs.FQN(fsp.volume, new DFSFQN(this.libDrive, this.libDir, fspName.name));
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
            drive = this.drive;
        } else if (DFSType.isValidDrive(commandLine)) {
            drive = commandLine;
        } else {
            return undefined;
        }

        return await this.volume.type.getCAT(new beebfs.FSP(this.volume, undefined, new DFSFSP(drive, undefined, undefined)), this, this.log);
    }

    public starDrive(arg: string | undefined): boolean {
        if (arg === undefined) {
            return errors.badDrive();
        }

        if (DFSType.isValidDrive(arg)) {
            this.drive = arg;
        } else {
            const fsp = mustBeDFSFSP(this.volume.type.parseFileOrDirString(arg, 0, true));
            if (fsp.drive === undefined || fsp.dir !== undefined) {
                return errors.badDrive();
            }

            this.drive = fsp.drive;
        }

        return true;
    }

    public starDir(fsp: beebfs.FSP): void {
        const dirFQN = this.getDirOrLibFQN(fsp);

        this.drive = dirFQN.drive;
        this.dir = dirFQN.dir;
    }

    public starLib(fsp: beebfs.FSP): void {
        const libFQN = this.getDirOrLibFQN(fsp);

        this.libDrive = libFQN.drive;
        this.libDir = libFQN.dir;
    }

    public async getDrivesOutput(): Promise<string> {
        const drives = await mustBeDFSType(this.volume.type).findDrivesForVolume(this.volume);

        let text = '';

        for (const drive of drives) {
            text += `${drive.name} - ${beebfs.getBootOptionDescription(drive.option).padEnd(4)}: `;

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
        return await dfsType.loadBootOption(this.volume, this.drive);
    }

    public async setBootOption(option: number): Promise<void> {
        const str = (option & 3).toString() + os.EOL;
        await beebfs.writeFile(path.join(this.volume.path, this.drive, OPT4_FILE_NAME), Buffer.from(str, 'binary'));
    }

    public async setTitle(title: string): Promise<void> {
        const buffer = Buffer.from(title.substr(0, MAX_TITLE_LENGTH) + os.EOL, 'binary');
        await beebfs.writeFile(path.join(this.volume.path, this.drive, TITLE_FILE_NAME), buffer);
    }

    public async getTitle(): Promise<string> {
        const dfsType = mustBeDFSType(this.volume.type);
        return await dfsType.loadTitle(this.volume, this.drive);
    }

    public async readNames(): Promise<string[]> {
        const files = await this.volume.type.findBeebFilesMatching(this.volume, new DFSFSP(this.drive, this.dir, undefined), false, undefined);

        const names: string[] = [];
        for (const file of files) {
            const dfsFQN = mustBeDFSFQN(file.fqn.fsFQN);
            names.push(dfsFQN.name);
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

    private getDirOrLibFQN(fsp: beebfs.FSP): DFSFQN {
        const dfsFSP = mustBeDFSFSP(fsp.fsFSP);

        if (fsp.wasExplicitVolume() || dfsFSP.name !== undefined) {
            return errors.badDir();
        }

        // the name part is bogus, but it's never used.
        return new DFSFQN(dfsFSP.drive !== undefined ? dfsFSP.drive : this.drive, dfsFSP.dir !== undefined ? dfsFSP.dir : this.dir, '');
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

    public parseFileOrDirString(str: string, i: number, parseAsDir: boolean): DFSFSP {
        let drive: string | undefined;
        let dir: string | undefined;
        let name: string | undefined;

        if (i === str.length) {
            return new DFSFSP(undefined, undefined, undefined);
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

        return new DFSFSP(drive, dir, name);
    }

    public createFQN(fsp: beebfs.IFSFSP, state: beebfs.IFSState | undefined): DFSFQN {
        const dfsFSP = mustBeDFSFSP(fsp);
        const dfsState = mustBeDFSState(state);

        let drive: string;
        if (dfsFSP.drive === undefined) {
            if (dfsState === undefined) {
                return errors.badName();
            }

            drive = dfsState.drive;
        } else {
            drive = dfsFSP.drive;
        }

        let dir: string;
        if (dfsFSP.dir === undefined) {
            if (dfsState === undefined) {
                return errors.badName();
            }
            dir = dfsState.dir;
        } else {
            dir = dfsFSP.dir;
        }

        if (dfsFSP.name === undefined) {
            return errors.badName();
        }

        return new DFSFQN(drive, dir, dfsFSP.name);
    }

    public getHostPath(fqn: beebfs.IFSFQN): string {
        const dfsFQN = mustBeDFSFQN(fqn);

        return path.join(dfsFQN.drive.toUpperCase(), beebfs.getHostChars(dfsFQN.dir) + '.' + beebfs.getHostChars(fqn.name));
    }

    public async findBeebFilesMatching(volume: beebfs.Volume, pattern: beebfs.IFSFQN | beebfs.IFSFSP | undefined, recurse: boolean, log: utils.Log | undefined): Promise<beebfs.File[]> {
        let driveNames: string[];
        let dirRegExp: RegExp;
        let nameRegExp: RegExp;

        if (pattern === undefined) {
            driveNames = [];
            for (const drive of await this.findDrivesForVolume(volume)) {
                driveNames.push(drive.name);
            }
            dirRegExp = utils.getRegExpFromAFSP('*');
            nameRegExp = utils.getRegExpFromAFSP('*');
        } else if (pattern instanceof DFSFQN) {
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

        // The recurse flag is ignored. There is no hierarchy within a BeebLink volume.

        const beebFiles: beebfs.File[] = [];

        for (const driveName of driveNames) {
            const driveHostPath = path.join(volume.path, driveName);
            const beebFileInfos = await inf.getINFsForFolder(driveHostPath, log);

            for (const beebFileInfo of beebFileInfos) {
                if (!this.isValidBeebFileName(beebFileInfo.name)) {
                    continue;
                }

                const dir = beebFileInfo.name[0];
                const name = beebFileInfo.name.slice(2);

                if (dirRegExp.exec(dir) === null || nameRegExp.exec(name) === null) {
                    continue;
                }

                const dfsFQN = new DFSFQN(driveName, dir, name);

                const file = new beebfs.File(beebFileInfo.hostPath, new beebfs.FQN(volume, dfsFQN), beebFileInfo.load, beebFileInfo.exec, beebFileInfo.attr | beebfs.DEFAULT_ATTR, false);

                log?.pn(`${file}`);

                beebFiles.push(file);
            }
        }

        log?.out();

        return beebFiles;
    }

    public async getCAT(fsp: beebfs.FSP, state: beebfs.IFSState | undefined, log: utils.Log | undefined): Promise<string> {
        const dfsFSP = mustBeDFSFSP(fsp.fsFSP);

        let dfsState: DFSState | undefined;
        if (state !== undefined) {
            if (state instanceof DFSState) {
                dfsState = state;
            }
        }

        if (dfsFSP.drive === undefined || dfsFSP.name !== undefined) {
            return errors.badDrive();
        }

        const beebFiles = await this.findBeebFilesMatching(fsp.volume, new DFSFSP(dfsFSP.drive, undefined, undefined), false, undefined);

        let text = '';

        const title = await this.loadTitle(fsp.volume, dfsFSP.drive);
        if (title !== '') {
            text += title + utils.BNL;
        }

        text += 'Volume: ' + fsp.volume.name + utils.BNL;

        const boot = await this.loadBootOption(fsp.volume, dfsFSP.drive);
        text += ('Drive ' + dfsFSP.drive + ' (' + boot + ' - ' + beebfs.getBootOptionDescription(boot) + ')').padEnd(20);

        if (dfsState !== undefined) {
            text += ('Dir :' + dfsState.drive + '.' + dfsState.dir).padEnd(10);

            text += 'Lib :' + dfsState.libDrive + '.' + dfsState.libDir;
        }

        text += utils.BNL + utils.BNL;

        let dir: string;
        if (dfsFSP.dir !== undefined) {
            dir = dfsFSP.dir;
        } else if (dfsState !== undefined) {
            dir = dfsState.dir;
        } else {
            dir = '$';
        }

        for (const beebFile of beebFiles) {
            mustBeDFSFQN(beebFile.fqn.fsFQN);
        }

        beebFiles.sort((a, b) => {
            const aNameFSName = a.fqn.fsFQN as DFSFQN;
            const bNameFSName = b.fqn.fsFQN as DFSFQN;

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
        const newFQNDFSName = mustBeDFSFQN(newFQN.fsFQN);

        const newHostPath = path.join(newFQN.volume.path, this.getHostPath(newFQNDFSName));
        await utils.mustNotExist(newHostPath);

        const newFile = new beebfs.File(newHostPath, newFQN, oldFile.load, oldFile.exec, oldFile.attr, false);

        await this.writeBeebMetadata(newFile.hostPath, newFQNDFSName, newFile.load, newFile.exec, newFile.attr);

        try {
            await utils.fsRename(oldFile.hostPath, newFile.hostPath);
        } catch (error) {
            return errors.nodeError(error);
        }

        await utils.forceFsUnlink(oldFile.hostPath + inf.ext);
    }

    public async writeBeebMetadata(hostPath: string, fqn: beebfs.IFSFQN, load: number, exec: number, attr: number): Promise<void> {
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

        return utils.getFirstLine(buffer).substr(0, MAX_TITLE_LENGTH);
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

    public async findDrivesForVolume(volume: beebfs.Volume): Promise<IDFSDrive[]> {
        let names: string[];
        try {
            names = await utils.fsReaddir(volume.path);
        } catch (error) {
            return errors.nodeError(error);
        }

        const drives = [];

        for (const name of names) {
            if (DFSType.isValidDrive(name)) {
                const option = await this.loadBootOption(volume, name);
                const title = await this.loadTitle(volume, name);

                drives.push({
                    name: name.toUpperCase(),
                    option,
                    title
                });
            }
        }

        return drives;
    }

    private getCommonInfoText(file: beebfs.File, fileSize: number): string {
        const dfsFQN = mustBeDFSFQN(file.fqn.fsFQN);

        const attr = this.getAttrString(file);
        const load = utils.hex8(file.load).toUpperCase();
        const exec = utils.hex8(file.exec).toUpperCase();
        const size = utils.hex(fileSize & 0x00ffffff, 6).toUpperCase();

        // 0123456789012345678901234567890123456789
        // _.__________ L 12345678 12345678 123456
        return `${dfsFQN.dir}.${dfsFQN.name.padEnd(10)} ${attr} ${load} ${exec} ${size}`;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export default new DFSType();
