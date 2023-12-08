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

// The choice of 200 is fairly arbitrary. It could probably be 254 or 255 but if
// I'm going to wing it I'd rather do it with some headroom.
const MAX_NAME_LENGTH = 200;

// Must be <255, but aside from that it's an arbitrary limit. (39 = it fits in
// Mode 7.)
const MAX_TITLE_LENGTH = 39;

const OPT4_FILE_NAME = '.opt4';
const TITLE_FILE_NAME = '.title';

const DEFAULT_TITLE = '';
const DEFAULT_BOOT_OPTION = 0;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// https://github.com/Microsoft/TypeScript/wiki/FAQ#can-i-make-a-type-alias-nominal

// Had more than one bug stem from mixing these up...
type AbsPath = string & { 'absPath': object; };
type VolRelPath = string & { 'volRelPath': object; };

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// _Library is a bit weird, because it's a disk that's named like a folder.
const LIBRARY_DISK_NAME = '_Library' as VolRelPath;
const LIBRARY_DISK_NAME_CASE_NORMALIZED = utils.getCaseNormalizedPath(LIBRARY_DISK_NAME) as VolRelPath;
const LIBRARY_DRIVE_NAME = 'L';

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

    return utils.getFirstLine(buffer).substring(0, MAX_TITLE_LENGTH);
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

    let ents: fs.Dirent[];
    try {
        ents = await utils.fsReaddir(folderPath, { withFileTypes: true });
    } catch (error) {
        return errors.nodeError(error);
    }

    //const indexRegExp = new RegExp('^([0-9]+)\\.', 'i');
    let maxIndex: undefined | number;

    log?.pn(`scanTubeHostFolder: ${folderPath} - ${ents.length} entries`);

    for (const ent of ents) {
        if (ent.isDirectory()) {
            if (ent.name.startsWith('_') && utils.getCaseNormalizedPath(ent.name) !== LIBRARY_DISK_NAME_CASE_NORMALIZED) {
                folders.push(ent.name);
            } else {
                const index = getDiskNameIndex(ent.name);
                if (index === undefined) {
                    disks.push({ index: -1, prefixIndex: undefined, name: ent.name });
                } else {
                    disks.push({ index, prefixIndex: index, name: ent.name });

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
                log.p(`  ${i}. Index=${disks[i].index}`);
                if (disks[i].prefixIndex !== undefined) {
                    log.p(` (prefix: ${disks[i].prefixIndex})`);
                }
                log.pn(`, name=\`\`${disks[i].name}''`);
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
    // Index for *DIN shorthand purposes.
    index: number;

    // Index from the file name, if present. Used to auto-insert disks on
    // startup.
    prefixIndex: number | undefined;

    name: string;
}

interface ITubeHostFolder {
    disks: ITubeHostDisk[];
    folders: string[];
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class TubeHostFilePath extends beebfs.FilePath {
    public readonly serverFolder: VolRelPath | undefined;

    public constructor(volume: beebfs.Volume, volumeExplicit: boolean, drive: string, driveExplicit: boolean, dir: string, dirExplicit: boolean, serverFolder: VolRelPath | undefined) {
        super(volume, volumeExplicit, drive, driveExplicit, dir, dirExplicit);
        if (serverFolder !== undefined) {
            this.serverFolder = utils.getSeparatorAndCaseNormalizedPath(serverFolder) as VolRelPath;
        }
    }

    public override getFQNSuffix(): string | undefined {
        return this.serverFolder;
    }
}

function mustBeTubeHostFilePath(filePath: beebfs.FilePath): TubeHostFilePath {
    if (!(filePath instanceof TubeHostFilePath)) {
        throw new Error('not TubeHostFilePath');
    }

    return filePath;
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

interface ITubeHostDriveState {
    name: string;
    folder: VolRelPath | undefined;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class TubeHostPersistentSettings {
    public readonly folderPath: VolRelPath | undefined;
    public readonly drives: ITubeHostDriveState[];

    public constructor(folderPath: VolRelPath | undefined, drives: ITubeHostDriveState[]) {
        this.folderPath = folderPath;

        this.drives = [];
        for (const drive of drives) {
            this.drives.push({ ...drive });
        }
    }
}

const gDefaultPersistentSettings = new TubeHostPersistentSettings(undefined, []);

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class TubeHostState implements beebfs.IFSState {
    public readonly volume: beebfs.Volume;

    private current: TubeHostPath;
    private library: TubeHostPath;

    private folderPath: VolRelPath;
    private readonly drives: ITubeHostDriveState[];
    private readonly drivesMap: (ITubeHostDriveState | undefined)[];//indexed by charCodeAt

    private readonly log: utils.Log | undefined;// tslint:disable-line no-unused-variable

    private persistentSettings: TubeHostPersistentSettings | undefined;

    public constructor(volume: beebfs.Volume, transientSettingsAny: unknown | undefined, persistentSettingsAny: unknown | undefined, log: utils.Log | undefined) {
        this.volume = volume;
        this.log = log;

        const transientSettings = TubeHostState.getTubeHostTransientSettings(transientSettingsAny);

        this.current = transientSettings.current;
        this.library = transientSettings.library;

        if (persistentSettingsAny !== undefined && persistentSettingsAny instanceof TubeHostPersistentSettings) {
            this.persistentSettings = persistentSettingsAny;
        }

        this.folderPath = '' as VolRelPath;
        this.drives = [];

        for (let i = 0; i < 10; ++i) {
            this.drives.push({
                name: `${i}`,
                folder: undefined,
            });
        }

        this.drives.push({
            name: LIBRARY_DRIVE_NAME,
            folder: undefined,
        });

        this.drivesMap = [];
        for (let i = 0; i < 128; ++i) {
            this.drivesMap[i] = undefined;
        }

        for (const drive of this.drives) {
            for (const c of [drive.name.toLowerCase(), drive.name.toUpperCase()]) {
                const i = c.charCodeAt(0);
                if (i >= 0 && i < this.drivesMap.length) {
                    this.drivesMap[i] = drive;
                }
            }
        }

        this.log?.pn(`TubeHostState created`);
    }

    private static getTubeHostTransientSettings(settings: any | undefined): TubeHostTransientSettings {
        if (settings === undefined) {
            return gDefaultTransientSettings;
        }

        if (!(settings instanceof TubeHostTransientSettings)) {
            return gDefaultTransientSettings;
        }

        return settings;
    }

    private static getTubeHostPersistentSettings(settings: unknown | undefined): TubeHostPersistentSettings {
        if (settings === undefined) {
            return gDefaultPersistentSettings;
        }

        if (!(settings instanceof TubeHostPersistentSettings)) {
            return gDefaultPersistentSettings;
        }

        return settings;
    }

    public getDriveStateByName(maybeDrive: string): ITubeHostDriveState | undefined {
        if (maybeDrive.length === 1) {
            const i = maybeDrive.charCodeAt(0);
            if (i >= 0 && i < this.drivesMap.length) {
                return this.drivesMap[i];
            }
        }

        return undefined;
    }

    public mustGetDriveStateByName(maybeDrive: string): ITubeHostDriveState {
        const drive = this.getDriveStateByName(maybeDrive);
        if (drive === undefined) {
            return errors.badDrive();
        }

        return drive;
    }

    public async initialise(): Promise<void> {
        if (this.persistentSettings !== undefined) {
            // Reinstate the previous settings.
            for (const oldDrive of this.persistentSettings.drives) {
                const drive = this.getDriveStateByName(oldDrive.name);
                if (drive !== undefined) {
                    drive.folder = oldDrive.folder;
                }
            }

            if (this.persistentSettings.folderPath === undefined) {
                this.folderPath = '' as VolRelPath;
            } else {
                this.folderPath = this.persistentSettings.folderPath;
            }
        } else {
            const folder = await this.scanCurrentFolder();

            for (const disk of folder.disks) {
                if (disk.prefixIndex !== undefined && disk.prefixIndex >= 0 && disk.prefixIndex < 10) {
                    this.din(this.drives[disk.prefixIndex], disk.name);
                }
            }

            if (await utils.isFolder(getAbsPath(this.volume, LIBRARY_DISK_NAME))) {
                this.mustGetDriveStateByName(LIBRARY_DRIVE_NAME).folder = LIBRARY_DISK_NAME;
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
        const drives: ITubeHostDriveState[] = [];
        for (const drive of this.drives) {
            drives.push({ ...drive });
        }

        return new TubeHostPersistentSettings(this.folderPath, drives);
    }

    public getPersistentSettingsString(settingsAny: unknown | undefined): string {
        const settings = TubeHostState.getTubeHostPersistentSettings(settingsAny);

        let text = '';

        for (const drive of settings.drives) {
            text += `Disk ${drive.name}: `;

            if (drive.folder !== undefined) {
                text += drive.folder;
            }

            text += utils.BNL;
        }

        return text;
    }

    public async getFileForRUN(fqn: beebfs.FQN, tryLibDir: boolean): Promise<beebfs.File | undefined> {
        this.log?.p(`getFileForRUN: ${fqn} -`);

        // Additional TubeHost rules for tryLibDir.
        if (fqn.filePath.driveExplicit) {
            this.log?.pn(` (explicit drive, ignoring lib)`);
            tryLibDir = false;
        }

        if (fqn.filePath.dirExplicit) {
            this.log?.pn(` (explicit dir, ignoring lib)`);
            tryLibDir = false;
        }

        const curFile = await beebfs.getBeebFile(fqn, true, this.log);
        if (curFile !== undefined) {
            this.log?.pn(` - found`);
            return curFile;
        }

        this.log?.pn(` - not found`);

        if (tryLibDir) {
            const libFile = await this.findLibFile(fqn.filePath.volume, this.library.drive, this.library.dir, fqn.name);
            if (libFile !== undefined) {
                return libFile;
            }

            const libFile2 = await this.findLibFile(fqn.filePath.volume, LIBRARY_DRIVE_NAME, '$', fqn.name);
            if (libFile2 !== undefined) {
                return libFile2;
            }
        }

        return undefined;
    }

    public async getCAT(commandLine: string | undefined): Promise<string | undefined> {
        let driveName: string;
        if (commandLine === undefined) {
            driveName = this.current.drive;
            this.log?.pn(`THs getCAT: drive (from default)=\`\`${driveName}''`);
        } else if (commandLine.length === 1) {
            driveName = commandLine;
            this.log?.pn(`THs getCAT: drive (from command line)=\`\`${driveName}''`);
        } else {
            return undefined;
        }

        const drive = this.mustGetDriveStateByName(driveName);

        // Generate "Drive empty" if appropriate. *CAT bypasses the parseFQN
        // handling that normally generates this error.
        if (drive.folder === undefined) {
            return driveEmptyError();
        }

        const filePath = new TubeHostFilePath(this.volume, false, driveName, true, this.current.dir, false, drive.folder);
        this.log?.pn(`THs getCAT: filePath=${filePath}`);
        return await this.volume.type.getCAT(filePath, this, this.log);
    }

    public starDrive(arg: string | undefined): boolean {
        if (arg === undefined) {
            return errors.badDrive();
        }

        if (this.getDriveStateByName(arg) !== undefined) {
            this.current = new TubeHostPath(arg, this.current.dir);
        } else {
            const filePath = this.volume.type.parseDirString(arg, 0, this, this.volume, false);
            if (!filePath.driveExplicit || filePath.dirExplicit) {
                return errors.badDrive();
            }

            this.current = new TubeHostPath(filePath.drive, this.current.dir);
        }

        return true;
    }

    public starDir(filePath: beebfs.FilePath): void {
        this.current = this.getTubeHostPathFromFilePath(filePath);
    }

    public starLib(filePath: beebfs.FilePath): void {
        this.library = this.getTubeHostPathFromFilePath(filePath);
    }

    public async getDrivesOutput(): Promise<string> {
        let text = '';

        for (const drive of this.drives) {
            if (drive.folder !== undefined) {
                text += `Disk ${drive.name}: ${drive.folder}${utils.BNL}`;
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
        const filePath = new TubeHostFilePath(this.volume, false, this.current.drive, true, this.current.dir, true, this.mustGetDriveFolder(this.current.drive));
        const fqn = new beebfs.FQN(filePath, '*');
        const files = await this.volume.type.findBeebFilesMatching(fqn, false, undefined);

        const names: string[] = [];
        for (const file of files) {
            names.push(file.fqn.name);
        }

        return names;
    }

    public getCommands(): server.Command[] {
        return [
            new server.Command('DCAT', '(<ahsp>)', this.dcatCommand),
            new server.Command('DCREATE', '<hsp>', this.dcreateCommand),
            new server.Command('DDIR', '(<hsp>)', this.hcfCommand),
            new server.Command('DIN', '<drive> <hsp>|<index>', this.dinCommand),
            new server.Command('DOUT', '<drive>', this.doutCommand),
            new server.Command('HFOLDERS', undefined, this.hfoldersCommand),
            new server.Command('HCF', '(<hsp>)', this.hcfCommand),
            new server.Command('HMKF', '<hsp>', this.hmkfCommand),
        ];
    }

    public mustGetDriveFolderAbsPath(driveName: string): AbsPath {
        return getAbsPath(this.volume, this.mustGetDriveFolder(driveName));
    }

    public mustGetDriveFolder(driveName: string): VolRelPath {
        const drive = this.mustGetDriveStateByName(driveName);

        if (drive.folder === undefined) {
            return errors.generic('Drive empty');
        }

        return drive.folder;
    }

    // public getDriveState(driveName: string): ITubeHostDriveState {
    //     const index = TubeHostState.getDriveIndex(driveName);
    //     if (index === undefined) {
    //         return errors.badDrive();
    //     }

    //     return this.drives[index];
    // }

    private readonly dcreateCommand = async (commandLine: CommandLine): Promise<void> => {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const diskName = commandLine.parts[1];

        this.checkDiskName(diskName);

        const index = getDiskNameIndex(diskName);
        if (index !== undefined) {
            if (index < 10 && this.drives[index].folder !== undefined) {
                throw new errors.BeebError(155, `Already have a disk in drive ${index}`);
            }
        }

        const driveFolder = path.join(this.folderPath, diskName) as VolRelPath;
        await utils.fsMkdir(driveFolder);
        if (index !== undefined) {
            this.drives[index].folder = driveFolder;
        }
    };

    private readonly dinCommand = async (commandLine: CommandLine): Promise<void> => {
        if (commandLine.parts.length < 3) {
            return errors.syntax();
        }

        const drive = this.mustGetDriveStateByName(commandLine.parts[1]);
        const diskArg = commandLine.parts[2];

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

        this.din(drive, diskName);
    };

    private din(drive: ITubeHostDriveState, diskName: string): void {
        drive.folder = path.join(this.folderPath, diskName) as VolRelPath;
    }

    private readonly doutCommand = async (commandLine: CommandLine): Promise<void> => {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const drive = this.mustGetDriveStateByName(commandLine.parts[1]);
        drive.folder = undefined;
    };

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

    private checkServerFolderName(name: string): void {
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

    private readonly hcfCommand = async (commandLine: CommandLine): Promise<string> => {
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
                this.checkServerFolderName(f);

                const folderPath = path.join(this.folderPath, f) as VolRelPath;
                if (!await utils.isFolder(getAbsPath(this.volume, folderPath))) {
                    return errors.notFound();
                }

                this.folderPath = folderPath;
            }
        }

        return `Current folder is: ${this.folderPath}${utils.BNL}`;
    };

    private readonly hmkfCommand = async (commandLine: CommandLine): Promise<void> => {
        if (commandLine.parts.length < 2) {
            return errors.syntax();
        }

        const f = commandLine.parts[1];

        this.checkServerFolderName(f);

        await utils.fsMkdir(getAbsPath(this.volume, path.join(this.folderPath, f) as VolRelPath));
    };

    private async scanCurrentFolder(): Promise<ITubeHostFolder> {
        return scanTubeHostFolder(getAbsPath(this.volume, this.folderPath), this.log);
    }

    private readonly hfoldersCommand = async (_commandLine: CommandLine): Promise<string> => {
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
    };

    private readonly dcatCommand = async (commandLine: CommandLine): Promise<string> => {
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
    };

    private getTubeHostPathFromFilePath(filePath: beebfs.FilePath): TubeHostPath {
        if (filePath.volumeExplicit) {
            return errors.badDir();
        }

        if (this.getDriveStateByName(filePath.drive) === undefined) {
            return errors.badDrive();
        }

        return new TubeHostPath(filePath.drive, filePath.dir);
    }

    private async findLibFile(volume: beebfs.Volume, libDriveName: string, libDir: string, name: string): Promise<beebfs.File | undefined> {
        this.log?.p(`findLibFile: ::${volume.name}:${libDriveName}.${libDir}.${name} - `);
        const drive = this.getDriveStateByName(libDriveName);
        if (drive === undefined) {
            this.log?.pn(`bad drive name`);
            return undefined;
        }

        if (drive.folder === undefined) {
            this.log?.pn(`drive empty`);
            return undefined;
        }

        const fqn = new beebfs.FQN(new TubeHostFilePath(volume, true, libDriveName, true, libDir, true, drive.folder), name);
        const file = await beebfs.getBeebFile(fqn, true, this.log);
        this.log?.pn(`FQN: ${fqn}: exists=${file !== undefined}`);
        if (file === undefined) {
            return undefined;
        }

        return file;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// interface IParseResult {
//     drive: string;
//     driveExplicit: boolean;
//     dir: string;
//     dirExplicit: boolean;
//     name: string | undefined;
//     hostFolder: VolRelPath | undefined;
// }

class TubeHostType implements beebfs.IFSType {
    public readonly name = 'TubeHost';

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

    public async createState(volume: beebfs.Volume, transientSettings: any | undefined, persistentSettings: any | undefined, log: utils.Log | undefined): Promise<beebfs.IFSState> {
        const state = new TubeHostState(volume, transientSettings, persistentSettings, log);

        await state.initialise();

        return state;
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

    public parseDirString(str: string, i: number, state: beebfs.IFSState | undefined, volume: beebfs.Volume, volumeExplicit: boolean): TubeHostFilePath {
        const parseResult = this.parseFileOrDirString(str, i, state, false, volume, volumeExplicit);
        return parseResult.filePath;
    }

    public getIdealVolumeRelativeServerPath(fqn: beebfs.FQN): VolRelPath {
        const tubeHostFilePath = mustBeTubeHostFilePath(fqn.filePath);

        if (tubeHostFilePath.serverFolder === undefined) {
            // Not certain this is the right logic...
            return driveEmptyError('Drive empty (?)');
        }

        return path.join(tubeHostFilePath.serverFolder, beebfs.getServerChars(fqn.filePath.dir) + '.' + beebfs.getServerChars(fqn.name)) as VolRelPath;
    }

    public async findBeebFilesInVolume(volumeOrFQN: beebfs.Volume | beebfs.FQN, log: utils.Log | undefined): Promise<beebfs.File[]> {
        const files: beebfs.File[] = [];

        let volume: beebfs.Volume;
        let dirRegExp: RegExp | undefined;
        let nameRegExp: RegExp | undefined;
        if (volumeOrFQN instanceof beebfs.FQN) {
            // TubeHost volume files have unknowable drives, but that will still
            // match an explicit '#' or '*'.
            if (volumeOrFQN.filePath.driveExplicit &&
                volumeOrFQN.filePath.drive !== utils.MATCH_N_CHAR &&
                volumeOrFQN.filePath.drive !== utils.MATCH_ONE_CHAR) {
                return files;
            }

            volume = volumeOrFQN.filePath.volume;
            dirRegExp = utils.getRegExpFromAFSP(volumeOrFQN.filePath.dir);
            nameRegExp = utils.getRegExpFromAFSP(volumeOrFQN.name);
        } else {
            volume = volumeOrFQN;
        }

        await this.findBeebFilesInVolumeRecurse(volume, log, files, dirRegExp, nameRegExp, '' as VolRelPath);

        return files;
    }

    public async findBeebFilesMatching(fqn: beebfs.FQN, recurse: boolean, log: utils.Log | undefined): Promise<beebfs.File[]> {
        // The recurse flag is ignored. TubeHost disks don't nest.

        const tubeHostFilePath = mustBeTubeHostFilePath(fqn.filePath);

        if (tubeHostFilePath.serverFolder === undefined) {
            // *sigh*
            return errors.generic('Unknown server folder');
        }

        //const driveRegExp = utils.getRegExpFromAFSP(tubeHostFQN.drive);
        const dirRegExp = tubeHostFilePath.dirExplicit ? utils.getRegExpFromAFSP(tubeHostFilePath.dir) : utils.MATCH_ANY_REG_EXP;
        const nameRegExp = utils.getRegExpFromAFSP(fqn.name);

        const files: beebfs.File[] = [];

        await this.addBeebFilesInFolder(files, tubeHostFilePath.volume, tubeHostFilePath.serverFolder, tubeHostFilePath.drive, tubeHostFilePath.driveExplicit, dirRegExp, nameRegExp, log);

        return files;
    }

    public async getCAT(catFilePath: beebfs.FilePath, state: beebfs.IFSState | undefined, log: utils.Log | undefined): Promise<string> {
        const tubeHostCatFilePath = mustBeTubeHostFilePath(catFilePath);
        const tubeHostState = mustBeTubeHostState(state);

        if (!catFilePath.driveExplicit || catFilePath.dirExplicit) {
            return errors.badDrive();
        }

        const catFQN = new beebfs.FQN(new TubeHostFilePath(tubeHostCatFilePath.volume, tubeHostCatFilePath.volumeExplicit, tubeHostCatFilePath.drive, tubeHostCatFilePath.driveExplicit, '*', false, tubeHostCatFilePath.serverFolder), '*');
        log?.pn(`Tht: getCAT: catFQN=${catFQN}`);

        const beebFiles = await this.findBeebFilesMatching(catFQN, false, undefined);

        log?.pn(`THt: getCAT: got ${beebFiles.length} files matching ${catFQN}`);

        let text = '';

        if (tubeHostCatFilePath.serverFolder !== undefined) {
            const title = await loadFolderTitle(getAbsPath(tubeHostCatFilePath.volume, tubeHostCatFilePath.serverFolder));
            if (title !== '') {
                text += title + utils.BNL;
            }
        }

        text += 'Volume: ' + tubeHostCatFilePath.volume.name + utils.BNL;

        if (tubeHostCatFilePath.serverFolder !== undefined) {
            const boot = await loadFolderBootOption(getAbsPath(tubeHostCatFilePath.volume, tubeHostCatFilePath.serverFolder));
            if (tubeHostState === undefined) {
                // It's impossible for this to have a meaingful drive number.
                text += `Option ${boot} - ${beebfs.getBootOptionDescription(boot)}`.padEnd(20);
            } else {
                text += ('Drive ' + tubeHostCatFilePath.drive + ' (' + boot + ' - ' + beebfs.getBootOptionDescription(boot) + ')').padEnd(20);
            }
        }

        if (tubeHostState !== undefined) {
            text += ('Dir :' + tubeHostState.getCurrentDrive() + '.' + tubeHostState.getCurrentDir()).padEnd(10);

            text += 'Lib :' + tubeHostState.getLibraryDrive() + '.' + tubeHostState.getLibraryDir();
        }

        text += utils.BNL + utils.BNL;

        beebFiles.sort((a, b) => {
            if (a.fqn.filePath.dir === tubeHostCatFilePath.dir && b.fqn.filePath.dir !== tubeHostCatFilePath.dir) {
                return -1;
            } else if (a.fqn.filePath.dir !== tubeHostCatFilePath.dir && b.fqn.filePath.dir === tubeHostCatFilePath.dir) {
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
            if (beebFile.fqn.filePath.dir === tubeHostCatFilePath.dir) {
                name = `  ${beebFile.fqn.name}`;
            } else {
                name = `${beebFile.fqn.filePath.dir}.${beebFile.fqn.name}`;
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
            await utils.forceFsUnlink(file.serverPath + inf.ext);
            await utils.forceFsUnlink(file.serverPath);
        } catch (error) {
            errors.nodeError(error as NodeJS.ErrnoException);
        }
    }

    public async renameFile(oldFile: beebfs.File, newFQN: beebfs.FQN): Promise<void> {
        const newServerPath = getAbsPath(newFQN.filePath.volume, this.getIdealVolumeRelativeServerPath(newFQN));
        await inf.mustNotExist(newServerPath);

        const newFile = new beebfs.File(newServerPath, newFQN, oldFile.load, oldFile.exec, oldFile.attr, false);

        await this.writeBeebMetadata(newFile.serverPath, newFQN, newFile.load, newFile.exec, newFile.attr);

        try {
            await utils.fsRename(oldFile.serverPath, newFile.serverPath);
        } catch (error) {
            return errors.nodeError(error);
        }

        await utils.forceFsUnlink(oldFile.serverPath + inf.ext);
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
        const attr = this.getAttrString(file);
        const load = utils.hex8(file.load).toUpperCase();
        const exec = utils.hex8(file.exec).toUpperCase();
        const size = utils.hex(fileSize & 0x00ffffff, 6).toUpperCase();

        // 0123456789012345678901234567890123456789
        // _.__________ L 12345678 12345678 123456
        return `${file.fqn.filePath.dir}.${file.fqn.name.padEnd(10)} ${attr} ${load} ${exec} ${size}`;
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

    private async findBeebFilesInVolumeRecurse(
        volume: beebfs.Volume,
        log: utils.Log | undefined,
        files: beebfs.File[],
        dirRegExp: RegExp | undefined,
        nameRegExp: RegExp | undefined,
        volRelPath: VolRelPath): Promise<void> {
        const tubeHostFolder = await scanTubeHostFolder(getAbsPath(volume, volRelPath), log);
        for (const disk of tubeHostFolder.disks) {
            const diskPath = path.join(volRelPath, disk.name) as VolRelPath;
            await this.addBeebFilesInFolder(files, volume, diskPath, '*', true, dirRegExp, nameRegExp, log);
        }

        for (const folder of tubeHostFolder.folders) {
            const folderPath = path.join(volRelPath, folder) as VolRelPath;
            await this.findBeebFilesInVolumeRecurse(volume, log, files, dirRegExp, nameRegExp, folderPath);
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

            const fqn = new beebfs.FQN(new TubeHostFilePath(volume, true, drive, driveExplicit, dir, true, folderPath), name);
            const file = new beebfs.File(info.serverPath, fqn, info.load, info.exec, info.attr, false);
            files.push(file);
        }
    }

    private parseFileOrDirString(
        str: string,
        i: number,
        state: beebfs.IFSState | undefined,
        parseAsDir: boolean,
        volume: beebfs.Volume,
        volumeExplicit: boolean): { filePath: TubeHostFilePath; name: string | undefined; i: number; } {
        const tubeHostState = mustBeTubeHostState(state);

        let drive: string | undefined;
        let dir: string | undefined;
        let name: string | undefined;

        if (i === str.length) {
            if (tubeHostState === undefined) {
                return errors.badName();
            }

            return {
                filePath: new TubeHostFilePath(
                    volume, volumeExplicit,
                    tubeHostState.getCurrentDrive(), false,
                    tubeHostState.getCurrentDir(), false,
                    undefined),
                name: undefined,
                i: 0,
            };
        }

        if (str[i] === ':' && i + 1 < str.length) {
            // The drive isn't checked for validity until the name is actually used.

            // if (!TubeHostType.isValidDrive(str[i + 1])) {
            //     return errors.badDrive();
            // }

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

        let serverFolder: VolRelPath | undefined;
        if (tubeHostState !== undefined) {
            serverFolder = tubeHostState.mustGetDriveStateByName(drive).folder;
            if (serverFolder === undefined) {
                // Is this the right place to do this?
                return driveEmptyError();
            }
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

        return {
            filePath: new TubeHostFilePath(
                volume, volumeExplicit,
                drive, driveExplicit,
                dir, dirExplicit,
                serverFolder),
            i,
            name,
        };
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export default new TubeHostType();
