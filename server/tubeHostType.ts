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
import CommandLine from './CommandLine';

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

// function mustBeTubeHostType(type: beebfs.IFSType): TubeHostType {
//     if (!(type instanceof TubeHostType)) {
//         throw new Error('not TubeHostType');
//     }

//     return type;
// }

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

function driveEmptyError(): never {
    return errors.generic('Drive empty');
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function loadFolderTitle(folderPath: string): Promise<string> {
    const buffer = await utils.tryReadFile(path.join(folderPath, TITLE_FILE_NAME));
    if (buffer === undefined) {
        return DEFAULT_TITLE;
    }

    return utils.getFirstLine(buffer).substr(0, MAX_TITLE_LENGTH);
}

async function saveFolderTitle(folderPath: string, title: string): Promise<void> {
    const buffer = Buffer.from(title.substring(0, MAX_TITLE_LENGTH) + os.EOL, 'binary');
    await beebfs.writeFile(path.join(folderPath, TITLE_FILE_NAME), buffer);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function loadFolderBootOption(folderPath: string): Promise<number> {
    const filePath = path.join(folderPath, OPT4_FILE_NAME);
    //console.log(`loadFolderBootOption: \`\`${filePath}''`);
    const buffer = await utils.tryReadFile(filePath);
    if (buffer === undefined || buffer.length === 0) {
        return DEFAULT_BOOT_OPTION;
    }

    return buffer[0] & 3;//ugh.
}

async function saveFolderBootOption(folderPath: string, option: number): Promise<void> {
    const str = (option & 3).toString() + os.EOL;
    await beebfs.writeFile(path.join(folderPath, OPT4_FILE_NAME), Buffer.from(str, 'binary'));
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// function getVolumeRelativePath(volume: beebfs.Volume, ...parts: string[]): string {
//     return path.join(volume.path, ...parts);
// }

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

const gDiskNameIndexRegExp = new RegExp('^([0-9]+)\\.', 'i');

function getDiskNameIndex(diskName: string): number | undefined {
    const m = gDiskNameIndexRegExp.exec(diskName);
    if (m === null) {
        return undefined;
    }

    return parseInt(m[1], 10);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function scanTubeHostFolder(folderPath: string, log: utils.Log | undefined): Promise<ITubeHostFolder> {
    const disks: ITubeHostDisk[] = [];
    const folders: string[] = [];

    const ents: fs.Dirent[] = await utils.fsReaddir(folderPath, { withFileTypes: true });

    //const indexRegExp = new RegExp('^([0-9]+)\\.', 'i');
    let maxIndex: undefined | number;

    log?.pn(`scanTubeHostFolder: ${folderPath} - ${ents.length} entries`);

    for (const ent of ents) {
        if (ent.isDirectory()) {
            if (ent.name.startsWith('_')) {
                folders.push(ent.name);
            } else {
                const index = getDiskNameIndex(ent.name);
                if (index === undefined) {
                    disks.push({ index: -1, name: ent.name });
                } else {
                    disks.push({ index, name: ent.name });

                    if (maxIndex === undefined || index > maxIndex) {
                        maxIndex = index;
                    }
                }
            }
        }
    }

    let nextIndex = maxIndex === undefined ? 0 : maxIndex + 1;
    for (const disk of disks) {
        if (disk.index < 0) {
            disk.index = nextIndex++;
        }
    }

    if (log !== undefined) {
        try {
            log.in(`  `);
            log.pn(`${folders.length} folder(s):`);
            for (let i = 0; i < folders.length; ++i) {
                log.pn(`  ${i}. \`\`${folders[i]}''`);
            }

            log.pn(`${disks.length} disks(s):`);
            for (let i = 0; i < disks.length; ++i) {
                log.pn(`  ${i}. Index=${disks[i].index}, name=\`\`${disks[i].name}''`);
            }
        } finally {
            log.out();
        }
    }

    return { folders, disks };
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface ITubeHostDisk {
    index: number;
    name: string;
}

interface ITubeHostFolder {
    disks: ITubeHostDisk[];
    folders: string[];
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class TubeHostFQN implements beebfs.IFSFQN {
    public readonly hostFolder: string;
    public readonly drive: string;
    public readonly dir: string;
    public readonly name: string;

    public constructor(hostFolder: string, drive: string, dir: string, name: string) {
        this.hostFolder = utils.getSeparatorAndCaseNormalizedPath(hostFolder);
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

// interface ITubeHostDrive {
//     readonly name: string;
//     readonly option: number;
//     readonly title: string;
// }

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
    public readonly folderPath: string | undefined;
    public readonly driveFolders: (string | undefined)[];

    public constructor(folderPath: string | undefined, driveFolders: (string | undefined)[]) {
        this.folderPath = folderPath;

        this.driveFolders = driveFolders.slice(0, NUM_DRIVES);
        while (this.driveFolders.length < NUM_DRIVES) {
            this.driveFolders.push(undefined);
        }
    }
}

const gDefaultPersistentSettings = new TubeHostPersistentSettings(undefined, []);

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

    public folderPath: string;
    public driveFolders: (string | undefined)[];

    private readonly log: utils.Log | undefined;// tslint:disable-line no-unused-variable

    public constructor(volume: beebfs.Volume, transientSettingsAny: any | undefined, persistentSettingsAny: any | undefined, log: utils.Log | undefined) {
        this.volume = volume;
        this.log = log;

        const transientSettings = TubeHostState.getTubeHostTransientSettings(transientSettingsAny);

        this.drive = transientSettings.drive;
        this.dir = transientSettings.dir;
        this.libDrive = transientSettings.libDrive;
        this.libDir = transientSettings.libDir;

        const persistentSettings = TubeHostState.getTubeHostPersistentSettings(persistentSettingsAny);

        this.driveFolders = persistentSettings.driveFolders.slice();
        while (this.driveFolders.length < NUM_DRIVES) {
            this.driveFolders.push(undefined);
        }
        if (this.driveFolders.length > NUM_DRIVES) {
            this.driveFolders.splice(NUM_DRIVES);
        }

        if (persistentSettings.folderPath === undefined) {
            this.folderPath = '';
        } else {
            this.folderPath = persistentSettings.folderPath;
        }
    }

    public async initialise(): Promise<void> {
        // Set up initial set of disks.
        const folder = await this.scanCurrentFolder();

        for (const disk of folder.disks) {
            if (disk.index >= 0 && disk.index < this.driveFolders.length) {
                this.din(disk.index, disk.name);
            }
        }
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
        return new TubeHostPersistentSettings(this.folderPath, this.driveFolders);
    }

    public getPersistentSettingsString(settingsAny: any | undefined): string {
        const settings = TubeHostState.getTubeHostPersistentSettings(settingsAny);

        let text = '';

        for (let i = 0; i < settings.driveFolders.length; ++i) {
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
            const driveFolder = this.getDriveFolder(this.libDrive);
            if (driveFolder !== undefined) {
                const libFQN = new beebfs.FQN(fsp.volume, new TubeHostFQN(driveFolder, this.libDrive, this.libDir, fspName.name));
                const libFile = await beebfs.getBeebFile(libFQN, true, false);
                if (libFile !== undefined) {
                    return libFile;
                }
            }
        }

        return undefined;
    }

    public async getCAT(commandLine: string | undefined): Promise<string | undefined> {
        let drive: string;
        if (commandLine === undefined) {
            drive = this.drive;
            this.log?.pn(`THs getCAT: drive (from default)=\`\`${drive}''`);
        } else if (TubeHostType.isValidDrive(commandLine)) {
            drive = commandLine;
            this.log?.pn(`THs getCAT: drive (from command line)=\`\`${drive}''`);
        } else {
            return undefined;
        }

        const driveFolder = this.getDriveFolder(drive);
        if (driveFolder === undefined) {
            return driveEmptyError();
        }

        const fsp = new beebfs.FSP(this.volume, this, new TubeHostFSP(driveFolder, drive, undefined, undefined));
        this.log?.pn(`THs getCAT: fsp=${fsp}`);
        return await this.volume.type.getCAT(fsp, this, this.log);
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

    public async getDrivesOutput(): Promise<string> {
        let text = '';

        for (let i = 0; i < this.driveFolders.length; ++i) {
            if (this.driveFolders[i] !== undefined) {
                text += `Disk ${i}: ${this.driveFolders[i]}${utils.BNL}`;
            }
        }

        if (text.length === 0) {
            text += `All drives empty${utils.BNL}`;
        }

        return text;
    }

    public async getBootOption(): Promise<number> {
        return await loadFolderBootOption(this.mustGetDriveFolder(this.drive));
    }

    public async setBootOption(option: number): Promise<void> {
        await saveFolderBootOption(this.mustGetDriveFolder(this.drive), option);
    }

    public async setTitle(title: string): Promise<void> {
        await saveFolderTitle(this.mustGetDriveFolder(this.drive), title);
    }

    public async getTitle(): Promise<string> {
        return await loadFolderTitle(this.mustGetDriveFolder(this.drive));
    }

    public async readNames(): Promise<string[]> {
        const files = await this.volume.type.findBeebFilesMatching(
            this.volume,
            new TubeHostFSP(this.getDriveFolder(this.drive), this.drive, this.dir, undefined),
            false,
            undefined);

        const names: string[] = [];
        for (const file of files) {
            const tubeHostFQN = mustBeTubeHostFQN(file.fqn.fsFQN);
            names.push(tubeHostFQN.name);
        }

        return names;
    }

    public getCommands(): server.Command[] {
        return [
            new server.Command('DCAT', '(<ahsp>)', this, this.dcatCommand),
            new server.Command('DCREATE', '<hsp>', this, this.dcreateCommand),
            new server.Command('DDIR', '(<hsp>)', this, this.hcfCommand),
            new server.Command('DIN', '<drive> <hsp>|<index>', this, this.dinCommand),
            new server.Command('DOUT', '<drive>', this, this.doutCommand),
            new server.Command('HFOLDERS', undefined, this, this.hfoldersCommand),
            new server.Command('HCF', '(<hsp>)', this, this.hcfCommand),
            new server.Command('HMKF', '<hsp>', this, this.hmkfCommand),
        ];
    }

    public mustGetDriveFolder(drive: string): string {
        const driveFolder = this.getDriveFolder(drive);

        if (driveFolder === undefined) {
            return errors.generic('Drive empty');
        }

        return driveFolder;
    }

    public getDriveFolder(drive: string): string | undefined {
        return this.driveFolders[this.getDriveIndex(drive)];
    }

    private async dcreateCommand(commandLine: CommandLine): Promise<void> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const diskName = commandLine.parts[1];

        this.checkDiskName(diskName);

        const index = getDiskNameIndex(diskName);
        if (index !== undefined) {
            if (index < NUM_DRIVES && this.driveFolders[index] !== undefined) {
                throw new errors.BeebError(155, `Already have a disk in drive ${index}`);
            }
        }

        const driveFolder = path.join(this.volume.path, this.folderPath, diskName);
        await utils.fsMkdir(driveFolder);
        if (index !== undefined) {
            this.driveFolders[index] = driveFolder;
        }
    }

    private async dinCommand(commandLine: CommandLine): Promise<void> {
        if (commandLine.parts.length < 3) {
            return errors.syntax();
        }

        const driveArg = commandLine.parts[1];
        const diskArg = commandLine.parts[2];

        if (!TubeHostType.isValidDrive(driveArg)) {
            return errors.badDrive();
        }

        let diskName: string | undefined;
        if (utils.isdigit(diskArg)) {
            const diskIndex = parseInt(diskArg, 10);
            const folder = await this.scanCurrentFolder();
            for (const disk of folder.disks) {
                if (disk.index === diskIndex) {
                    diskName = disk.name;
                    break;
                }
            }
        }

        if (diskName === undefined) {
            const diskPath = path.join(this.volume.path, this.folderPath, diskArg);
            if (!await utils.isFolder(diskPath)) {
                return errors.notFound();
            }

            diskName = diskArg;
        }

        this.din(this.getDriveIndex(driveArg), diskName);
    }

    private din(drive: number, diskName: string): void {
        this.driveFolders[drive] = path.join(this.volume.path, this.folderPath, diskName);
    }

    private async doutCommand(commandLine: CommandLine): Promise<void> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        this.driveFolders[this.getDriveIndex(commandLine.parts[1])] = undefined;
    }

    private checkDiskName(name: string): void {
        for (const c of name) {
            if (utils.isalnum(c)) {
                // ok
            } else if ('_+.!@$%,-'.indexOf(c) >= 0) {
                // ok
            } else {
                return errors.badName('Bad characters present');
            }
        }
    }

    private checkHostFolderName(name: string): void {
        if (name.length === 0) {
            return errors.badName();
        }

        if (name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) {
            return errors.badString('Bad characters present');
        }

        if (name[0] !== '_') {
            return errors.badString('Bad name: missing _');
        }
    }

    private async hcfCommand(commandLine: CommandLine): Promise<string> {
        if (commandLine.parts.length >= 2) {
            const f = commandLine.parts[1];

            if (f === '^') {
                this.folderPath = '';
            } else if (f === '..') {
                this.folderPath = path.dirname(this.folderPath);

                // Annoying...
                if (this.folderPath === '.') {
                    this.folderPath = '';
                }
            } else {
                this.checkHostFolderName(f);

                const folderPath = path.join(this.folderPath, f);
                if (!await utils.isFolder(path.join(this.volume.path, folderPath))) {
                    return errors.notFound();
                }

                this.folderPath = folderPath;
            }
        }

        return `Current folder is: ${this.folderPath}${utils.BNL}`;
    }

    private async hmkfCommand(commandLine: CommandLine): Promise<void> {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const f = commandLine.parts[1];

        this.checkHostFolderName(f);

        await utils.fsMkdir(path.join(this.volume.path, this.folderPath, f));
    }

    private async scanCurrentFolder(): Promise<ITubeHostFolder> {
        return scanTubeHostFolder(path.join(this.volume.path, this.folderPath), undefined);
    }

    private async hfoldersCommand(commandLine: CommandLine): Promise<string> {
        const folder = await this.scanCurrentFolder();

        let text = '';

        if (folder.folders.length === 0) {
            text += `No folders present${utils.BNL}`;
        } else {
            folder.folders.sort();

            text += `Folders present:${utils.BNL}`;
            for (const f of folder.folders) {
                text += `  ${f}${utils.BNL}`;
            }
        }

        return text;
    }

    private async dcatCommand(commandLine: CommandLine): Promise<string> {
        // this.log.pn(`hello from *DCAT\n`);
        // this.log.pn(`this.folderPath=\`\`${this.folderPath}''`);

        const nameRegExp = commandLine.parts.length >= 2 ? utils.getRegExpFromAFSP(commandLine.parts[1]) : undefined;

        const folder = await this.scanCurrentFolder();

        folder.disks.sort((a, b) => {
            if (a.index < b.index) {
                return -1;
            } else if (b.index < a.index) {
                return 1;
            } else {
                return 0;
            }
        });

        let text = '';

        if (folder.disks.length === 0) {
            text += `No disks available${utils.BNL}`;
        } else {
            text += `Disks available:${utils.BNL}`;
            for (const disk of folder.disks) {
                if (nameRegExp === undefined || nameRegExp.exec(disk.name) !== null) {
                    text += `${disk.index.toString(10).padStart(6)}: ${disk.name}${utils.BNL}`;
                }
            }
        }

        return text;
    }

    private getDriveIndex(drive: string): number {
        if (!TubeHostType.isValidDrive(drive)) {
            return errors.badDrive();
        }

        return parseInt(drive, 10);
    }

    private getDirOrLibFQN(fsp: beebfs.FSP): TubeHostFQN {
        const tubeHostFSP = mustBeTubeHostFSP(fsp.fsFSP);

        if (fsp.wasExplicitVolume() || tubeHostFSP.name !== undefined) {
            return errors.badDir();
        }

        // the name part is bogus, but it's never used.
        const drive = tubeHostFSP.drive !== undefined ? tubeHostFSP.drive : this.drive;
        const driveFolder = this.getDriveFolder(drive);
        if (driveFolder === undefined) {
            return driveEmptyError();
        }

        const dir = tubeHostFSP.dir !== undefined ? tubeHostFSP.dir : this.dir;
        return new TubeHostFQN(driveFolder, drive, dir, '');
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

    public readonly name = 'TubeHost';

    public async createState(volume: beebfs.Volume, transientSettings: any | undefined, persistentSettings: any | undefined, log: utils.Log | undefined): Promise<beebfs.IFSState> {
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
        const tubeHostFSP: TubeHostFSP = mustBeTubeHostFSP(fsp);
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


        let hostFolder: string | undefined;
        if (tubeHostState !== undefined) {
            hostFolder = tubeHostState.getDriveFolder(drive);
            if (hostFolder === undefined) {
                return driveEmptyError();
            }
        } else {
            if (tubeHostFSP.hostFolder === undefined) {
                return errors.badName();
            }
            hostFolder = tubeHostFSP.hostFolder;
        }

        return new TubeHostFQN(hostFolder, drive, dir, tubeHostFSP.name);
    }

    public getHostPath(fqn: beebfs.IFSFQN): string {
        const tubeHostFQN = mustBeTubeHostFQN(fqn);

        return path.join(tubeHostFQN.drive.toUpperCase(), beebfs.getHostChars(tubeHostFQN.dir) + '.' + beebfs.getHostChars(fqn.name));
    }

    public async findBeebFilesMatching(volume: beebfs.Volume, pattern: beebfs.IFSFQN | beebfs.IFSFSP | undefined, recurse: boolean, log: utils.Log | undefined): Promise<beebfs.File[]> {
        const beebFiles: beebfs.File[] = [];

        log?.pn(`TH findBeebFilesMatching: volume=${volume.path} pattern=${pattern} recurse=${recurse}`);

        const addBeebFiles = async (diskPath: string, dirRegExp: RegExp | undefined, nameRegExp: RegExp | undefined) => {
            const infos = await inf.getINFsForFolder(diskPath, log);

            for (const info of infos) {
                if (!this.isValidBeebFileName(info.name)) {
                    continue;
                }

                const dir = info.name[0];
                const name = info.name.slice(2);

                if (dirRegExp !== undefined && dirRegExp.exec(dir) === null) {
                    continue;
                }

                if (nameRegExp !== undefined && nameRegExp.exec(name) === null) {
                    continue;
                }

                // The '*' indicates that the drive is unknowable.
                const tubeHostFQN = new TubeHostFQN(diskPath, '*', dir, name);

                const file = new beebfs.File(info.hostPath, new beebfs.FQN(volume, tubeHostFQN), info.load, info.exec, info.attr, false);

                log?.pn(`${file} `);

                beebFiles.push(file);
            }
        };

        const recurseFindFiles = async (folderPath: string, dirRegExp: RegExp | undefined, nameRegExp: RegExp | undefined) => {
            const tubeHostFolder = await scanTubeHostFolder(folderPath, log);

            for (const disk of tubeHostFolder.disks) {
                await addBeebFiles(path.join(folderPath, disk.name), dirRegExp, nameRegExp);
            }

            if (recurse) {
                for (const folder of tubeHostFolder.folders) {
                    await recurseFindFiles(path.join(folderPath, folder), dirRegExp, nameRegExp);
                }
            }
        };

        if (pattern === undefined) {
            // Find absolutely everything in the volume.

            await recurseFindFiles(volume.path, undefined, undefined);
        } else {
            // Only add files matching the name(s) specified.

            let hostFolder: string | undefined;
            let dirRegExp: RegExp;
            let nameRegExp: RegExp;

            if (pattern instanceof TubeHostFQN) {
                hostFolder = pattern.hostFolder;
                dirRegExp = utils.getRegExpFromAFSP(pattern.dir);
                nameRegExp = utils.getRegExpFromAFSP(pattern.name);
            } else if (pattern instanceof TubeHostFSP) {
                hostFolder = pattern.hostFolder;
                dirRegExp = utils.getRegExpFromAFSP(pattern.dir !== undefined ? pattern.dir : '*');
                nameRegExp = utils.getRegExpFromAFSP(pattern.name !== undefined ? pattern.name : '*');
            } else {
                throw new Error('not TubeHostFQN|TubeHostFSQ');
            }

            // Super ugly logic that wants tidying up.
            if (hostFolder !== undefined) {
                // An explicit host folder was provided. Search that one
                // directly. No recursion in this case; TubeHost disks can't
                // nest.
                await addBeebFiles(hostFolder, dirRegExp, nameRegExp);
            } else {
                // No explicit host folder was provided. Search the volume.
                await recurseFindFiles(volume.path, dirRegExp, nameRegExp);
            }

        }

        log?.out();

        return beebFiles;
    }

    public async getCAT(fsp: beebfs.FSP, state: beebfs.IFSState | undefined, log: utils.Log | undefined): Promise<string> {
        const tubeHostFSP = mustBeTubeHostFSP(fsp.fsFSP);

        if (tubeHostFSP.drive === undefined || tubeHostFSP.name !== undefined) {
            return errors.badDrive();
        }

        if (tubeHostFSP.hostFolder === undefined) {
            return errors.badDir();
        }

        let tubeHostState: TubeHostState | undefined;
        if (state !== undefined) {
            if (state instanceof TubeHostState) {
                tubeHostState = state;
            }
        }

        const beebFiles = await this.findBeebFilesMatching(
            fsp.volume,
            new TubeHostFSP(tubeHostFSP.hostFolder, tubeHostFSP.drive, undefined, undefined),
            false,
            log);
        log?.pn(`THt: getCAT: got ${beebFiles.length} files`);

        let text = '';

        const title = await loadFolderTitle(tubeHostFSP.hostFolder);
        if (title !== '') {
            text += title + utils.BNL;
        }

        text += 'Volume: ' + fsp.volume.name + utils.BNL;

        const boot = await loadFolderBootOption(tubeHostFSP.hostFolder);
        if (tubeHostState === undefined) {
            // It's impossible for this to have a valid drive number.
            text += `Option ${boot} - ${beebfs.getBootOptionDescription(boot)}`.padEnd(20);
        } else {
            text += ('Drive ' + tubeHostFSP.drive + ' (' + boot + ' - ' + beebfs.getBootOptionDescription(boot) + ')').padEnd(20);
        }

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
