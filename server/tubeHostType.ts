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

// https://github.com/Microsoft/TypeScript/wiki/FAQ#can-i-make-a-type-alias-nominal

// Had more than one bug stem from mixing these up...
type AbsPath = string & { 'absPath': {} };
type VolRelPath = string & { 'volRelPath': {} };

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function mustBeTubeHostState(state: beebfs.IFSState | undefined): TubeHostState | undefined {
    if (state !== undefined) {
        if (!(state instanceof TubeHostState)) {
            throw new Error('not TubeHostState');
        }
    }

    return state;
}

function mustBeTubeHostFQN(fqn: beebfs.FQN): TubeHostFQN {
    if (!(fqn instanceof TubeHostFQN)) {
        throw new Error('not TubeHostFQN');
    }

    return fqn;
}

function driveEmptyError(message?: string): never {
    return errors.generic(message !== undefined ? message : 'Drive empty');
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function getAbsPath(volume: beebfs.Volume, volRelPath: VolRelPath): AbsPath {
    return path.join(volume.path, volRelPath) as AbsPath;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function loadFolderTitle(folderPath: AbsPath): Promise<string> {
    const buffer = await utils.tryReadFile(path.join(folderPath, TITLE_FILE_NAME));
    if (buffer === undefined) {
        return DEFAULT_TITLE;
    }

    return utils.getFirstLine(buffer).substr(0, MAX_TITLE_LENGTH);
}

async function saveFolderTitle(folderPath: AbsPath, title: string): Promise<void> {
    const buffer = Buffer.from(title.substring(0, MAX_TITLE_LENGTH) + os.EOL, 'binary');
    await beebfs.writeFile(path.join(folderPath, TITLE_FILE_NAME), buffer);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

async function loadFolderBootOption(folderPath: AbsPath): Promise<number> {
    const filePath = path.join(folderPath, OPT4_FILE_NAME);
    //console.log(`loadFolderBootOption: \`\`${filePath}''`);
    const buffer = await utils.tryReadFile(filePath);
    if (buffer === undefined || buffer.length === 0) {
        return DEFAULT_BOOT_OPTION;
    }

    return buffer[0] & 3;//ugh.
}

async function saveFolderBootOption(folderPath: AbsPath, option: number): Promise<void> {
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

async function scanTubeHostFolder(folderPath: AbsPath, log: utils.Log | undefined): Promise<ITubeHostFolder> {
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

class TubeHostFQN extends beebfs.FQN {
    public readonly hostFolder: VolRelPath | undefined;
    public readonly drive: string;
    public readonly driveExplicit: boolean;
    public readonly dir: string;
    public readonly dirExplicit: boolean;
    public readonly name: string | undefined;

    public constructor(volume: beebfs.Volume, volumeExplicit: boolean, hostFolder: VolRelPath | undefined, drive: string, driveExplicit: boolean, dir: string, dirExplicit: boolean, name: string | undefined) {
        super(volume, volumeExplicit);
        if (hostFolder !== undefined) {
            this.hostFolder = utils.getSeparatorAndCaseNormalizedPath(hostFolder) as VolRelPath;
        }
        this.drive = drive;
        this.driveExplicit = driveExplicit;
        this.dir = dir;
        this.dirExplicit = dirExplicit;
        this.name = name;
    }

    public equals(other: beebfs.FQN): boolean {
        if (!(other instanceof TubeHostFQN)) {
            return false;
        }

        if (!super.equals(other)) {
            return false;
        }

        if (!utils.struieq(this.drive, other.drive)) {
            return false;
        }

        if (!utils.struieq(this.dir, other.dir)) {
            return false;
        }

        if (!utils.struieq(this.name, other.name)) {
            return false;
        }

        if (this.hostFolder !== other.hostFolder) {
            return false;
        }

        return true;
    }

    public toString(): string {
        return `${super.toString()}:${this.drive}.${this.dir}.${this.name} (${this.hostFolder})`;
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

class TubeHostPath {
    public constructor(public readonly drive: string, public readonly dir: string) { }
}

// this is a class purely so that 'instanceof' can be used.
class TubeHostTransientSettings {
    public constructor(public readonly current: TubeHostPath, public readonly library: TubeHostPath) { }
}

const gDefaultTransientSettings = new TubeHostTransientSettings(new TubeHostPath('0', '$'), new TubeHostPath('0', '$'));

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class TubeHostPersistentSettings {
    public readonly folderPath: VolRelPath | undefined;
    public readonly driveFolders: (VolRelPath | undefined)[];

    public constructor(folderPath: VolRelPath | undefined, driveFolders: (VolRelPath | undefined)[]) {
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

    public current: TubeHostPath;
    public library: TubeHostPath;

    public folderPath: VolRelPath;
    public driveFolders: (VolRelPath | undefined)[];

    private readonly log: utils.Log | undefined;// tslint:disable-line no-unused-variable

    private persistentSettings: TubeHostPersistentSettings | undefined;

    public constructor(volume: beebfs.Volume, transientSettingsAny: any | undefined, persistentSettingsAny: any | undefined, log: utils.Log | undefined) {
        this.volume = volume;
        this.log = log;

        const transientSettings = TubeHostState.getTubeHostTransientSettings(transientSettingsAny);

        this.current = transientSettings.current;
        this.library = transientSettings.library;

        if (persistentSettingsAny !== undefined && persistentSettingsAny instanceof TubeHostPersistentSettings) {
            this.persistentSettings = persistentSettingsAny;
        }

        this.folderPath = '' as VolRelPath;
        this.driveFolders = [];
    }

    public async initialise(): Promise<void> {
        if (this.persistentSettings !== undefined) {
            // Reinstate the previous settings.
            this.driveFolders = this.persistentSettings.driveFolders.slice();
            while (this.driveFolders.length < NUM_DRIVES) {
                this.driveFolders.push(undefined);
            }
            if (this.driveFolders.length > NUM_DRIVES) {
                this.driveFolders.splice(NUM_DRIVES);
            }

            if (this.persistentSettings.folderPath === undefined) {
                this.folderPath = '' as VolRelPath;
            } else {
                this.folderPath = this.persistentSettings.folderPath;
            }
        } else {
            // Set up initial set of disks.

            this.driveFolders = [];
            while (this.driveFolders.length < NUM_DRIVES) {
                this.driveFolders.push(undefined);
            }

            const folder = await this.scanCurrentFolder();

            for (const disk of folder.disks) {
                if (disk.index >= 0 && disk.index < this.driveFolders.length) {
                    this.din(disk.index, disk.name);
                }
            }
        }
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

    public getTransientSettings(): TubeHostTransientSettings {
        return new TubeHostTransientSettings(this.current, this.library);
    }

    public getTransientSettingsString(settingsAny: any | undefined): string {
        const settings = TubeHostState.getTubeHostTransientSettings(settingsAny);

        return `Default dir :${settings.current.drive}.${settings.current.dir}${utils.BNL}Default lib :${settings.library.drive}.${settings.library.dir}${utils.BNL}`;
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

    public async getFileForRUN(fqn: beebfs.FQN, tryLibDir: boolean): Promise<beebfs.File | undefined> {
        const tubeHostFQN = mustBeTubeHostFQN(fqn);

        if (tubeHostFQN.name === undefined) {
            return undefined;
        }

        // Additional TubeHost rules for tryLibDir.
        if (!tubeHostFQN.driveExplicit && !tubeHostFQN.dirExplicit) {
            tryLibDir = false;
        }

        const curFile = await beebfs.getBeebFile(fqn, true, false);
        if (curFile !== undefined) {
            return curFile;
        }

        if (tryLibDir) {
            const driveFolder = this.getDriveFolder(this.library.drive);
            if (driveFolder !== undefined) {
                const libFQN = new TubeHostFQN(fqn.volume, true, driveFolder, this.library.drive, true, this.library.dir, true, tubeHostFQN.name);
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
            drive = this.current.drive;
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

        const fqn = new TubeHostFQN(this.volume, false, driveFolder, drive, true, this.current.dir, false, undefined);
        this.log?.pn(`THs getCAT: fqn=${fqn}`);
        return await this.volume.type.getCAT(fqn, this, this.log);
    }

    public starDrive(arg: string | undefined): boolean {
        if (arg === undefined) {
            return errors.badDrive();
        }

        if (TubeHostType.isValidDrive(arg)) {
            this.current = new TubeHostPath(arg, this.current.dir);
        } else {
            const fqn = mustBeTubeHostFQN(this.volume.type.parseFileOrDirString(arg, 0, this, true, this.volume, false));
            if (!fqn.driveExplicit || fqn.dirExplicit) {
                return errors.badDrive();
            }

            this.current = new TubeHostPath(fqn.drive, this.current.dir);
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
        return await loadFolderBootOption(this.mustGetDriveFolderAbsPath(this.current.drive));
    }

    public async setBootOption(option: number): Promise<void> {
        await saveFolderBootOption(this.mustGetDriveFolderAbsPath(this.current.drive), option);
    }

    public async setTitle(title: string): Promise<void> {
        await saveFolderTitle(this.mustGetDriveFolderAbsPath(this.current.drive), title);
    }

    public async getTitle(): Promise<string> {
        return await loadFolderTitle(this.mustGetDriveFolderAbsPath(this.current.drive));
    }

    public async readNames(): Promise<string[]> {
        const fqn = new TubeHostFQN(this.volume, false, this.mustGetDriveFolder(this.current.drive), this.current.drive, true, this.current.dir, true, undefined);
        const files = await this.volume.type.findBeebFilesMatching(fqn, false, undefined);

        const names: string[] = [];
        for (const file of files) {
            const tubeHostFQN = mustBeTubeHostFQN(file.fqn);
            names.push(tubeHostFQN.name!);
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

    public mustGetDriveFolderAbsPath(drive: string): AbsPath {
        return getAbsPath(this.volume, this.mustGetDriveFolder(drive));
    }

    public mustGetDriveFolder(drive: string): VolRelPath {
        const driveFolder = this.getDriveFolder(drive);

        if (driveFolder === undefined) {
            return errors.generic('Drive empty');
        }

        return driveFolder;
    }

    public getDriveFolder(drive: string): VolRelPath | undefined {
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

        const driveFolder = path.join(this.folderPath, diskName) as VolRelPath;
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
        this.driveFolders[drive] = path.join(this.folderPath, diskName) as VolRelPath;
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
                this.folderPath = '' as VolRelPath;
            } else if (f === '..') {
                this.folderPath = path.dirname(this.folderPath) as VolRelPath;

                // Annoying...
                if (this.folderPath === '.') {
                    this.folderPath = '' as VolRelPath;
                }
            } else {
                this.checkHostFolderName(f);

                const folderPath = path.join(this.folderPath, f) as VolRelPath;
                if (!await utils.isFolder(folderPath)) {
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

        await utils.fsMkdir(getAbsPath(this.volume, path.join(this.folderPath, f) as VolRelPath));
    }

    private async scanCurrentFolder(): Promise<ITubeHostFolder> {
        return scanTubeHostFolder(getAbsPath(this.volume, this.folderPath), this.log);
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

    private getPathFromFQN(fqn: beebfs.FQN): TubeHostPath {
        const tubeHostFQN = mustBeTubeHostFQN(fqn);

        if (tubeHostFQN.volumeExplicit || tubeHostFQN.name !== undefined) {
            return errors.badDir();
        }

        return new TubeHostPath(tubeHostFQN.drive, tubeHostFQN.dir);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class TubeHostType implements beebfs.IFSType {
    public static isValidDrive(maybeDrive: string): boolean {
        return maybeDrive.length === 1 && utils.isdigit(maybeDrive);
    }

    private static isValidFileNameChar(char: string): boolean {
        const c = char.charCodeAt(0);
        return c >= 32 && c < 127;
    }

    private static isValidFileName(name: string): boolean {
        for (const c of name) {
            if (!this.isValidFileNameChar(c)) {
                return false;
            }
        }

        return true;
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

    public parseFileOrDirString(str: string, i: number, state: beebfs.IFSState | undefined, parseAsDir: boolean, volume: beebfs.Volume, volumeExplicit: boolean): TubeHostFQN {
        const tubeHostState = mustBeTubeHostState(state);

        let drive: string | undefined;
        let dir: string | undefined;
        let name: string | undefined;

        if (i === str.length) {
            if (tubeHostState === undefined) {
                return errors.badName();
            }

            return new TubeHostFQN(volume, volumeExplicit, undefined, tubeHostState.getCurrentDrive(), false, tubeHostState.getCurrentDir(), false, undefined);
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

        let driveExplicit: boolean;
        if (drive === undefined) {
            if (tubeHostState !== undefined) {
                drive = tubeHostState.getCurrentDrive();
            } else {
                drive = gDefaultTransientSettings.current.drive;
            }

            driveExplicit = false;
        } else {
            driveExplicit = true;
        }

        let hostFolder: VolRelPath | undefined;
        if (tubeHostState !== undefined) {
            hostFolder = tubeHostState.getDriveFolder(drive);
        }

        let dirExplicit: boolean;
        if (dir === undefined) {
            if (tubeHostState !== undefined) {
                dir = tubeHostState.getCurrentDir();
            } else {
                dir = gDefaultTransientSettings.current.dir;
            }

            dirExplicit = false;
        } else {
            dirExplicit = true;
        }

        return new TubeHostFQN(volume, volumeExplicit, hostFolder, drive, driveExplicit, dir, dirExplicit, name);
    }

    public getIdealVolumeRelativeHostPath(fqn: beebfs.FQN): VolRelPath {
        const tubeHostFQN = mustBeTubeHostFQN(fqn);

        if (tubeHostFQN.name === undefined) {
            return errors.badName();
        }

        if (tubeHostFQN.hostFolder === undefined) {
            // Not certain this is the right logic...
            return driveEmptyError('Drive empty (?)');
        }

        return path.join(tubeHostFQN.hostFolder, beebfs.getHostChars(tubeHostFQN.dir) + '.' + beebfs.getHostChars(tubeHostFQN.name)) as VolRelPath;
    }

    public async findBeebFilesInVolume(volume: beebfs.Volume, log: utils.Log | undefined): Promise<beebfs.File[]> {
        const files: beebfs.File[] = [];

        await this.findBeebFilesInVolumeRecurse(volume, log, files, '' as VolRelPath);

        return files;
    }

    public async findBeebFilesMatching(fqn: beebfs.FQN, recurse: boolean, log: utils.Log | undefined): Promise<beebfs.File[]> {
        // The recurse flag is ignored. TubeHost disks don't nest.

        const tubeHostFQN = mustBeTubeHostFQN(fqn);

        if (tubeHostFQN.hostFolder === undefined) {
            // *sigh*
            return errors.generic('Unknown host folder');
        }

        //const driveRegExp = utils.getRegExpFromAFSP(tubeHostFQN.drive);
        const dirRegExp = utils.getRegExpFromAFSP(tubeHostFQN.dir);
        const nameRegExp = tubeHostFQN.name !== undefined ? utils.getRegExpFromAFSP(tubeHostFQN.name) : undefined;

        const files: beebfs.File[] = [];

        await this.addBeebFilesInFolder(files, tubeHostFQN.volume, tubeHostFQN.hostFolder, tubeHostFQN.drive, tubeHostFQN.driveExplicit, dirRegExp, nameRegExp, log);

        return files;
    }

    public async getCAT(catFQN: beebfs.FQN, state: beebfs.IFSState | undefined, log: utils.Log | undefined): Promise<string> {
        const tubeHostCatFQN = mustBeTubeHostFQN(catFQN);
        const tubeHostState = mustBeTubeHostState(state);

        if (!tubeHostCatFQN.driveExplicit || tubeHostCatFQN.dirExplicit) {
            return errors.badDrive();
        }

        const beebFiles = await this.findBeebFilesMatching(new TubeHostFQN(tubeHostCatFQN.volume, true, tubeHostCatFQN.hostFolder, tubeHostCatFQN.drive, true, '*', false, undefined), false, undefined);

        log?.pn(`THt: getCAT: got ${beebFiles.length} files in ${tubeHostCatFQN}`);

        let text = '';

        if (tubeHostCatFQN.hostFolder !== undefined) {
            const title = await loadFolderTitle(getAbsPath(tubeHostCatFQN.volume, tubeHostCatFQN.hostFolder));
            if (title !== '') {
                text += title + utils.BNL;
            }
        }

        text += 'Volume: ' + tubeHostCatFQN.volume.name + utils.BNL;

        if (tubeHostCatFQN.hostFolder !== undefined) {
            const boot = await loadFolderBootOption(getAbsPath(tubeHostCatFQN.volume, tubeHostCatFQN.hostFolder));
            if (tubeHostState === undefined) {
                // It's impossible for this to have a meaingful drive number.
                text += `Option ${boot} - ${beebfs.getBootOptionDescription(boot)}`.padEnd(20);
            } else {
                text += ('Drive ' + tubeHostCatFQN.drive + ' (' + boot + ' - ' + beebfs.getBootOptionDescription(boot) + ')').padEnd(20);
            }
        }

        if (tubeHostState !== undefined) {
            text += ('Dir :' + tubeHostState.getCurrentDrive() + '.' + tubeHostState.getCurrentDir()).padEnd(10);

            text += 'Lib :' + tubeHostState.getLibraryDrive() + '.' + tubeHostState.getLibraryDir();
        }

        text += utils.BNL + utils.BNL;

        for (const beebFile of beebFiles) {
            mustBeTubeHostFQN(beebFile.fqn);
        }

        beebFiles.sort((a, b) => {
            const tubeHostFQNA = a.fqn as TubeHostFQN;
            const tubeHostFQNB = b.fqn as TubeHostFQN;

            if (tubeHostFQNA.dir === tubeHostCatFQN.dir && tubeHostFQNB.dir !== tubeHostCatFQN.dir) {
                return -1;
            } else if (tubeHostFQNA.dir !== tubeHostCatFQN.dir && tubeHostFQNB.dir === tubeHostCatFQN.dir) {
                return 1;
            } else {
                const cmpDirs = utils.stricmp(tubeHostFQNA.dir, tubeHostFQNB.dir);
                if (cmpDirs !== 0) {
                    return cmpDirs;
                }

                return utils.stricmp(tubeHostFQNA.name!, tubeHostFQNB.name!);
            }
        });

        for (const beebFile of beebFiles) {
            const tubeHostFQN = beebFile.fqn as TubeHostFQN;

            let name;
            if (tubeHostFQN.dir === tubeHostCatFQN.dir) {
                name = `  ${tubeHostFQN.name}`;
            } else {
                name = `${tubeHostFQN.dir}.${tubeHostFQN.name}`;
            }

            while (name.length % 20 !== 14) {
                name += ' ';
            }

            if ((beebFile.attr & beebfs.L_ATTR) !== 0) {
                name += 'L';
            } else {
                name += ' ';
            }

            while (name.length % 20 !== 0) {
                name += ' ';
            }

            text += name;
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
        const newFQNTubeHostName = mustBeTubeHostFQN(newFQN);

        const newHostPath = getAbsPath(newFQN.volume, this.getIdealVolumeRelativeHostPath(newFQNTubeHostName));
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

    public async writeBeebMetadata(hostPath: string, fqn: beebfs.FQN, load: number, exec: number, attr: number): Promise<void> {
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
        const tubeHostFQN = mustBeTubeHostFQN(file.fqn);

        const attr = this.getAttrString(file);
        const load = utils.hex8(file.load).toUpperCase();
        const exec = utils.hex8(file.exec).toUpperCase();
        const size = utils.hex(fileSize & 0x00ffffff, 6).toUpperCase();

        // 0123456789012345678901234567890123456789
        // _.__________ L 12345678 12345678 123456
        return `${tubeHostFQN.dir}.${tubeHostFQN.name!.padEnd(10)} ${attr} ${load} ${exec} ${size}`;
    }

    // private async findBeebFilesRecurse(files: beebfs.File[], volume: beeebfs.Volume, folderPath: VolRelPath, log: utils.Log | undefined): Promise<void> {
    //     const tubeHostFolder = await scanTubeHostFolder(folderPath, log);

    //     for (const disk of tubeHostFolder.disks) {
    //         await this.addBeebFilesInFolder(files, path.join(folderPath, disk.name), dirRegExp, nameRegExp);
    //     }

    //     if (recurse) {
    //         for (const folder of tubeHostFolder.folders) {
    //             await recurseFindFiles(path.join(folderPath, folder), dirRegExp, nameRegExp);
    //         }
    //     }

    // }

    private async findBeebFilesInVolumeRecurse(volume: beebfs.Volume, log: utils.Log | undefined, files: beebfs.File[], volRelPath: VolRelPath): Promise<void> {
        const tubeHostFolder = await scanTubeHostFolder(getAbsPath(volume, volRelPath), log);
        for (const disk of tubeHostFolder.disks) {
            const diskPath = path.join(volRelPath, disk.name) as VolRelPath;
            await this.addBeebFilesInFolder(files, volume, diskPath, '*', true, undefined, undefined, log);
        }

        for (const folder of tubeHostFolder.folders) {
            const folderPath = path.join(volRelPath, folder) as VolRelPath;
            await this.findBeebFilesInVolumeRecurse(volume, log, files, folderPath);
        }
    }

    private async addBeebFilesInFolder(
        files: beebfs.File[],
        volume: beebfs.Volume,
        folderPath: VolRelPath,
        drive: string,
        driveExplicit: boolean,
        dirRegExp: RegExp | undefined,
        nameRegExp: RegExp | undefined,
        log: utils.Log | undefined): Promise<void> {
        const infos = await inf.getINFsForFolder(getAbsPath(volume, folderPath), log);

        for (const info of infos) {
            let dir: string;
            let name: string;
            if (info.name.length > 2 && info.name[1] === '.') {
                // BBC dir + name
                dir = info.name[0];
                name = info.name.slice(2);
            } else {
                if (info.name[0] === '.') {
                    // Ignore dot files.
                    continue;
                }

                dir = gDefaultTransientSettings.current.dir;
                name = info.name;
            }

            if (!TubeHostType.isValidFileNameChar(dir)) {
                continue;
            }

            if (!utils.matchesOptionalRegExp(dir, dirRegExp)) {
                continue;
            }

            if (!TubeHostType.isValidFileName(name)) {
                continue;
            }

            if (!utils.matchesOptionalRegExp(name, nameRegExp)) {
                continue;
            }

            const fqn = new TubeHostFQN(volume, true, folderPath, drive, driveExplicit, dir, true, name);
            const file = new beebfs.File(info.hostPath, fqn, info.load, info.exec, info.attr | beebfs.DEFAULT_ATTR, false);
            files.push(file);
        }
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export default new TubeHostType();
