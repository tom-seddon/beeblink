//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
// Copyright (C) 2023 Tom Seddon
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

const NUM_DRIVES = 10;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function mustBeTubeHostType(type: beebfs.IFSType): TubeHostType {
    if (!(type instanceof TubeHostType)) {
        throw new Error('not TubeHostType');
    }

    return type;
}

function mustBeTubeHostState(state: beebfs.IFSState | undefined): TubeHostState | undefined {
    if (state !== undefined) {
        if (!(state instanceof TubeHostState)) {
            throw new Error('not TubeHostState');
        }
    }

    return state;
}

function mustBeTubeHostFSP(fsp: beebfs.IFSFSP): TubeHostFSP {
    if (!(fsp instanceof TubeHostFSP)) {
        throw new Error('not TubeHostFSP');
    }

    return fsp;
}

function mustBeTubeHostFQN(fqn: beebfs.IFSFQN): TubeHostFQN {
    if (!(fqn instanceof TubeHostFQN)) {
        throw new Error('not TubeHostFQN');
    }

    return fqn;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class TubeHostFQN implements beebfs.IFSFQN {
    public readonly hostFolder: string | undefined;
    public readonly drive: string;
    public readonly dir: string;
    public readonly name: string;

    public constructor(hostFolder: string | undefined, drive: string, dir: string, name: string) {
        if (hostFolder !== undefined) {
            this.hostFolder = utils.getSeparatorAndCaseNormalizedPath(hostFolder);
        }
        this.drive = drive;
        this.dir = dir;
        this.name = name;
    }

    public equals(other: beebfs.IFSFQN): boolean {
        if (!(other instanceof TubeHostFQN)) {
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

        if (this.hostFolder !== other.hostFolder) {
            return false;
        }

        return true;
    }

    public toString(): string {
        return `:${this.drive}.${this.dir}.${this.name} (${this.hostFolder})`;
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

class TubeHostFSP implements beebfs.IFSFSP {
    public readonly hostFolder: string | undefined;
    public readonly drive: string | undefined;
    public readonly dir: string | undefined;
    public readonly name: string | undefined;

    public constructor(hostFolder: string | undefined, drive: string | undefined, dir: string | undefined, name: string | undefined) {
        this.hostFolder = hostFolder;
        this.drive = drive;
        this.dir = dir;
        this.name = name;
    }

    public toString(): string {
        return `:${this.getString(this.drive)}.${this.getString(this.dir)}.${this.getString(this.name)} (${this.getString(this.hostFolder)})`;
    }

    private getString(x: string | undefined): string {
        // 2026 = HORIZONTAL ELLIPSIS
        return x !== undefined ? x : '\u2026';
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface ITubeHostDrive {
    readonly name: string;
    readonly option: number;
    readonly title: string;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// this is a class purely so that 'instanceof' can be used.
class TubeHostTransientSettings {
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

const gDefaultTransientSettings = new TubeHostTransientSettings('0', '$', '0', '$');

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class TubeHostPersistentSettings {
    public readonly driveFolders: (string | undefined)[];

    public constructor(driveFolders: (string | undefined)[]) {
        this.driveFolders = driveFolders.slice(0, NUM_DRIVES);
        while (this.driveFolders.length < NUM_DRIVES) {
            this.driveFolders.push(undefined);
        }
    }
}

const gDefaultPersistentSettings = new TubeHostPersistentSettings([]);

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class TubeHostState implements beebfs.IFSState {
    private static getTubeHostTransientSettings(settings: any | undefined): TubeHostTransientSettings {
        if (settings === undefined) {
            return gDefaultTransientSettings;
        }

        if (!(settings instanceof TubeHostTransientSettings)) {
            return gDefaultTransientSettings;
        }

        return settings;
    }

    private static getTubeHostPersistentSettings(settings: any | undefined): TubeHostPersistentSettings {
        if (settings === undefined) {
            return gDefaultPersistentSettings;
        }

        if (!(settings instanceof TubeHostPersistentSettings)) {
            return gDefaultPersistentSettings;
        }

        return settings;
    }

    public readonly volume: beebfs.Volume;

    public drive: string;
    public dir: string;

    public libDrive: string;
    public libDir: string;

    public driveFolders: (string | undefined)[];

    private readonly log: utils.Log;// tslint:disable-line no-unused-variable

    public constructor(volume: beebfs.Volume, transientSettingsAny: any | undefined, persistentSettingsAny: any | undefined, log: utils.Log) {
        this.volume = volume;
        this.log = log;

        const transientSettings = TubeHostState.getTubeHostTransientSettings(transientSettingsAny);

        this.drive = transientSettings.drive;
        this.dir = transientSettings.dir;
        this.libDrive = transientSettings.libDrive;
        this.libDir = transientSettings.libDir;

        const persistentSettings = TubeHostState.getTubeHostPersistentSettings(persistentSettingsAny);

        this.driveFolders = persistentSettings.driveFolders.slice();
    }

    public async initialise(): Promise<void> {
        // ...
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

    public getTransientSettings(): TubeHostTransientSettings {
        return new TubeHostTransientSettings(this.drive, this.dir, this.libDrive, this.libDir);
    }

    public getTransientSettingsString(settingsAny: any | undefined): string {
        const settings = TubeHostState.getTubeHostTransientSettings(settingsAny);

        return `Default dir :${settings.drive}.${settings.dir}${utils.BNL}Default lib :${settings.libDrive}.${settings.libDir}${utils.BNL}`;
    }

    public getPersistentSettings(): TubeHostPersistentSettings {
        return new TubeHostPersistentSettings(this.driveFolders);
    }

    public getPersistentSettingsString(settingsAny: any | undefined): string {
        const settings = TubeHostState.getTubeHostPersistentSettings(settingsAny);

        let text = '';

        for (let i = 0; i < NUM_DRIVES; ++i) {
            text += `Disk ${i}: `;

            if (settings.driveFolders[i] !== undefined) {
                text += settings.driveFolders[i];
            }

            text += utils.BNL;
        }

        return text;
    }

    public async getFileForRUN(fsp: beebfs.FSP, tryLibDir: boolean): Promise<beebfs.File | undefined> {
        const fspName = mustBeTubeHostFSP(fsp.fsFSP);

        if (fspName.name === undefined) {
            return undefined;
        }

        // Additional TubeHost rules for tryLibDir.
        if (fspName.drive !== undefined || fspName.dir !== undefined) {
            tryLibDir = false;
        }

        const curFQN = new beebfs.FQN(fsp.volume, this.volume.type.createFQN(fspName, this));
        const curFile = await beebfs.getBeebFile(curFQN, true, false);
        if (curFile !== undefined) {
            return curFile;
        }

        if (tryLibDir) {
            const libFQN = new beebfs.FQN(fsp.volume, new TubeHostFQN(this.getDriveFolder(this.libDrive), this.libDrive, this.libDir, fspName.name));
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
        } else if (TubeHostType.isValidDrive(commandLine)) {
            drive = commandLine;
        } else {
            return undefined;
        }

        return await this.volume.type.getCAT(new beebfs.FSP(this.volume, undefined, new TubeHostFSP(this.getDriveFolder(drive), drive, undefined, undefined)), this);
    }

    public starDrive(arg: string | undefined): boolean {
        if (arg === undefined) {
            return errors.badDrive();
        }

        if (TubeHostType.isValidDrive(arg)) {
            this.drive = arg;
        } else {
            const fsp = mustBeTubeHostFSP(this.volume.type.parseFileOrDirString(arg, 0, true));
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

    public async starDrives(): Promise<string> {
        let text = '';

        for (let i = 0; i < this.driveFolders.length; ++i) {
            text += `Disk ${i}: `;

            if (this.driveFolders[i] !== undefined) {
                text += this.driveFolders[i];
            }

            text += utils.BNL;
        }

        return text;
    }

    public async getBootOption(): Promise<number> {
        const tubeHostType = mustBeTubeHostType(this.volume.type);
        return await tubeHostType.loadBootOption(this.volume, this.drive);
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
        const tubeHostType = mustBeTubeHostType(this.volume.type);
        return await tubeHostType.loadTitle(this.volume, this.drive);
    }

    public async readNames(): Promise<string[]> {
        const files = await this.volume.type.findBeebFilesMatching(this.volume, new TubeHostFSP(this.getDriveFolder(this.drive), this.drive, this.dir, undefined), undefined);

        const names: string[] = [];
        for (const file of files) {
            const tubeHostFQN = mustBeTubeHostFQN(file.fqn.fsFQN);
            names.push(tubeHostFQN.name);
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

    private getDriveFolder(drive: string): string | undefined {
        // had better be a valid drive!
        const driveNumber = parseInt(drive,10);
        return this.driveFolders[driveNumber];
    }

    private getDirOrLibFQN(fsp: beebfs.FSP): TubeHostFQN {
        const tubeHostFSP = mustBeTubeHostFSP(fsp.fsFSP);

        if (fsp.wasExplicitVolume() || tubeHostFSP.name !== undefined) {
            return errors.badDir();
        }

        // the name part is bogus, but it's never used.
        const drive = tubeHostFSP.drive !== undefined ? tubeHostFSP.drive : this.drive;
        const dir = tubeHostFSP.dir !== undefined ? tubeHostFSP.dir : this.dir;
        return new TubeHostFQN(this.getDriveFolder(drive), drive, dir, '');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class TubeHostType implements beebfs.IFSType {
    public static isValidDrive(maybeDrive: string): boolean {
        return maybeDrive.length === 1 && utils.isdigit(maybeDrive);
    }

    private static isValidFileNameChar(char: string) {
        const c = char.charCodeAt(0);
        return c >= 32 && c < 127;
    }

    public readonly matchAllFSP: beebfs.IFSFSP = new TubeHostFSP(undefined, undefined, undefined, undefined);

    public readonly name = 'TubeHost';

    public async createState(volume: beebfs.Volume, transientSettings: any | undefined, persistentSettings: any | undefined, log: utils.Log): Promise<beebfs.IFSState> {
        const state = new TubeHostState(volume, transientSettings, persistentSettings, log);

        await state.initialise();

        return state;
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

        if (!TubeHostType.isValidFileNameChar(str[0])) {
            return false;
        }

        for (let i = 2; i < str.length; ++i) {
            if (!TubeHostType.isValidFileNameChar(str[i])) {
                return false;
            }
        }

        return true;
    }

    public parseFileOrDirString(str: string, i: number, parseAsDir: boolean): TubeHostFSP {
        let drive: string | undefined;
        let dir: string | undefined;
        let name: string | undefined;

        if (i === str.length) {
            return new TubeHostFSP(undefined, undefined, undefined, undefined);
        }

        if (str[i] === ':' && i + 1 < str.length) {
            if (!TubeHostType.isValidDrive(str[i + 1])) {
                return errors.badDrive();
            }

            drive = str[i + 1];
            i += 2;

            if (str[i] === '.') {
                ++i;
            }
        }

        if (str[i + 1] === '.') {
            if (!TubeHostType.isValidFileNameChar(str[i])) {
                return errors.badDir();
            }

            dir = str[i];
            i += 2;
        }

        if (parseAsDir) {
            if (i < str.length && dir !== undefined || i === str.length - 1 && !TubeHostType.isValidFileNameChar(str[i])) {
                return errors.badDir();
            }

            dir = str[i];
        } else {
            if (i < str.length) {
                for (let j = i; j < str.length; ++j) {
                    if (!TubeHostType.isValidFileNameChar(str[j])) {
                        return errors.badName();
                    }
                }

                name = str.slice(i);

                if (name.length > MAX_NAME_LENGTH) {
                    return errors.badName();
                }
            }
        }

        return new TubeHostFSP(undefined, drive, dir, name);
    }

    public createFQN(fsp: beebfs.IFSFSP, state: beebfs.IFSState | undefined): TubeHostFQN {
        const tubeHostFSP = mustBeTubeHostFSP(fsp);
        const tubeHostState = mustBeTubeHostState(state);

        let drive: string;
        if (tubeHostFSP.drive === undefined) {
            if (tubeHostState === undefined) {
                return errors.badName();
            }

            drive = tubeHostState.drive;
        } else {
            drive = tubeHostFSP.drive;
        }

        let dir: string;
        if (tubeHostFSP.dir === undefined) {
            if (tubeHostState === undefined) {
                return errors.badName();
            }
            dir = tubeHostState.dir;
        } else {
            dir = tubeHostFSP.dir;
        }

        if (tubeHostFSP.name === undefined) {
            return errors.badName();
        }

        return new TubeHostFQN(undefined, drive, dir, tubeHostFSP.name);
    }

    public getHostPath(fqn: beebfs.IFSFQN): string {
        const tubeHostFQN = mustBeTubeHostFQN(fqn);

        return path.join(tubeHostFQN.drive.toUpperCase(), beebfs.getHostChars(tubeHostFQN.dir) + '.' + beebfs.getHostChars(fqn.name));
    }

    public async findBeebFilesMatching(volume: beebfs.Volume, pattern: beebfs.IFSFQN | beebfs.IFSFSP, log: utils.Log | undefined): Promise<beebfs.File[]> {
        //let driveNames: string[];
        let dirRegExp: RegExp;
        let nameRegExp: RegExp;
        let hostFolder: string | undefined;

        if (pattern instanceof TubeHostFQN) {
            //driveNames = [pattern.drive];
            hostFolder = pattern.hostFolder;
            dirRegExp = utils.getRegExpFromAFSP(pattern.dir);
            nameRegExp = utils.getRegExpFromAFSP(pattern.name);
        } else if (pattern instanceof TubeHostFSP) {
            // if (pattern.drive !== undefined) {
            //     driveNames = [pattern.drive];
            // } else {
            //     driveNames = [];
            //     for (const drive of await this.findDrivesForVolume(volume)) {
            //         driveNames.push(drive.name);
            //     }
            // }

            hostFolder = pattern.hostFolder;
            dirRegExp = utils.getRegExpFromAFSP(pattern.dir !== undefined ? pattern.dir : '*');
            nameRegExp = utils.getRegExpFromAFSP(pattern.name !== undefined ? pattern.name : '*');
        } else {
            throw new Error('not TubeHostFQN or TubeHostFSP');
        }

        const beebFiles: beebfs.File[] = [];

        const recurseFindFiles = async (folderPath: string, recurse: boolean) => {
            const ents: fs.Dirent[] = await utils.fsReaddir(folderPath, { withFileTypes: true });

            for (const ent of ents) {
                if (ent.isDirectory()) {
                    const folderPath2 = path.join(folderPath, ent.name);
                    const infos = await inf.getINFsForFolder(folderPath2, log);

                    for (const info of infos) {
                        if (!this.isValidBeebFileName(info.name)) {
                            continue;
                        }

                        const dir = info.name[0];
                        const name = info.name.slice(2);

                        if (dirRegExp.exec(dir) === null || nameRegExp.exec(name) === null) {
                            continue;
                        }

                        const tubeHostFQN = new TubeHostFQN(folderPath2, '?', dir, name);

                        const file = new beebfs.File(info.hostPath, new beebfs.FQN(volume, tubeHostFQN), info.load, info.exec, info.attr, false);

                        if (log !== undefined) {
                            log.pn(`${file}`);
                        }

                        beebFiles.push(file);
                    }

                    if (recurse) {
                        await recurseFindFiles(folderPath2, true);
                    }
                }
            }
        };

        if (hostFolder === undefined) {
            await recurseFindFiles(volume.path, true);
        } else {
            await recurseFindFiles(hostFolder, false);
        }

        if (log !== undefined) {
            log.out();
        }

        return beebFiles;
    }

    public async getCAT(fsp: beebfs.FSP, state: beebfs.IFSState | undefined): Promise<string> {
        const tubeHostFSP = mustBeTubeHostFSP(fsp.fsFSP);

        if (tubeHostFSP.drive === undefined || tubeHostFSP.name !== undefined) {
            return errors.badDrive();
        }

        if (tubeHostFSP.hostFolder === undefined) {
            return errors.generic(`Can't *CAT like this`);
        }

        let tubeHostState: TubeHostState | undefined;
        if (state !== undefined) {
            if (state instanceof TubeHostState) {
                tubeHostState = state;
            }
        }

        const beebFiles = await this.findBeebFilesMatching(fsp.volume, new TubeHostFSP(tubeHostFSP.hostFolder, tubeHostFSP.drive, undefined, undefined), undefined);

        let text = '';

        const title = await this.loadTitle(fsp.volume, tubeHostFSP.drive);
        if (title !== '') {
            text += title + utils.BNL;
        }

        text += 'Volume: ' + fsp.volume.name + utils.BNL;

        const boot = await this.loadBootOption(fsp.volume, tubeHostFSP.drive);
        text += ('Drive ' + tubeHostFSP.drive + ' (' + boot + ' - ' + beebfs.getBootOptionDescription(boot) + ')').padEnd(20);

        if (tubeHostState !== undefined) {
            text += ('Dir :' + tubeHostState.drive + '.' + tubeHostState.dir).padEnd(10);

            text += 'Lib :' + tubeHostState.libDrive + '.' + tubeHostState.libDir;
        }

        text += utils.BNL + utils.BNL;

        let dir: string;
        if (tubeHostFSP.dir !== undefined) {
            dir = tubeHostFSP.dir;
        } else if (tubeHostState !== undefined) {
            dir = tubeHostState.dir;
        } else {
            dir = '$';
        }

        for (const beebFile of beebFiles) {
            mustBeTubeHostFQN(beebFile.fqn.fsFQN);
        }

        beebFiles.sort((a, b) => {
            const aNameFSName = a.fqn.fsFQN as TubeHostFQN;
            const bNameFSName = b.fqn.fsFQN as TubeHostFQN;

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
            const fileFSName = mustBeTubeHostFQN(beebFile.fqn.fsFQN);

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
        const newFQNTubeHostName = mustBeTubeHostFQN(newFQN.fsFQN);

        const newHostPath = path.join(newFQN.volume.path, this.getHostPath(newFQNTubeHostName));
        await utils.mustNotExist(newHostPath);

        const newFile = new beebfs.File(newHostPath, newFQN, oldFile.load, oldFile.exec, oldFile.attr, false);

        await this.writeBeebMetadata(newFile.hostPath, newFQNTubeHostName, newFile.load, newFile.exec, newFile.attr);

        try {
            await utils.fsRename(oldFile.hostPath, newFile.hostPath);
        } catch (error) {
            return errors.nodeError(error);
        }

        await utils.forceFsUnlink(oldFile.hostPath + inf.ext);
    }

    public async writeBeebMetadata(hostPath: string, fqn: beebfs.IFSFQN, load: number, exec: number, attr: number): Promise<void> {
        const tubeHostFQN = mustBeTubeHostFQN(fqn);

        await inf.writeFile(hostPath, `${tubeHostFQN.dir}.${tubeHostFQN.name}`, load, exec, (attr & beebfs.L_ATTR) !== 0 ? 'L' : '');
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

    public async findDrivesForVolume(volume: beebfs.Volume): Promise<ITubeHostDrive[]> {
        let names: string[];
        try {
            names = await utils.fsReaddir(volume.path);
        } catch (error) {
            return errors.nodeError(error);
        }

        const drives = [];

        for (const name of names) {
            if (TubeHostType.isValidDrive(name)) {
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
        const tubeHostFQN = mustBeTubeHostFQN(file.fqn.fsFQN);

        const attr = this.getAttrString(file);
        const load = utils.hex8(file.load).toUpperCase();
        const exec = utils.hex8(file.exec).toUpperCase();
        const size = utils.hex(fileSize & 0x00ffffff, 6).toUpperCase();

        // 0123456789012345678901234567890123456789
        // _.__________ L 12345678 12345678 123456
        return `${tubeHostFQN.dir}.${tubeHostFQN.name.padEnd(10)} ${attr} ${load} ${exec} ${size}`;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export default new TubeHostType();
