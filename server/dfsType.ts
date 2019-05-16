//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
// Copyright (C) 2018 Tom Seddon
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

import * as os from 'os';
import * as path from 'path';
import * as utils from './utils';
import * as beebfs from './beebfs';
import * as errors from './errors';
import * as inf from './inf';

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

function mustBeDFSHandler(handler: beebfs.IFSType): DFSHandler {
    if (!(handler instanceof DFSHandler)) {
        throw new Error('not DFSHandler');
    }

    return handler;
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

    public getName(): string | undefined {
        return this.name;
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

const DFS_FIXED_ATTRS = beebfs.R_ATTR | beebfs.W_ATTR;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

interface IDFSDrive {
    readonly name: string;
    readonly option: number;
    readonly title: string;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class DFSState implements beebfs.IFSState {
    public readonly volume: beebfs.Volume;

    public drive: string;
    public dir: string;

    public libDrive: string;
    public libDir: string;

    private readonly log: utils.Log;

    public constructor(volume: beebfs.Volume, log: utils.Log) {
        this.volume = volume;
        this.log = log;

        this.drive = '0';
        this.dir = '$';

        this.libDrive = '0';
        this.libDir = '$';
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

    public async getFileForRUN(fsp: beebfs.FSP, tryLibDir: boolean): Promise<beebfs.File | undefined> {
        const fspName = mustBeDFSFSP(fsp.name);

        if (fspName.name === undefined) {
            return undefined;
        }

        // Additional DFS rules for tryLibDir.
        if (fspName.drive !== undefined || fspName.dir !== undefined) {
            tryLibDir = false;
        }

        const curFQN = new beebfs.FQN(fsp.volume, this.volume.handler.createFQN(fspName, this));
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

    public async getCAT(commandLine: string | undefined): Promise<string> {
        let drive: string;
        if (commandLine === undefined) {
            drive = this.drive;
        } else if (commandLine.length === 1 && utils.isdigit(commandLine)) {
            drive = commandLine;
        } else {
            return errors.badDrive();
        }

        this.log.pn(`*CAT: drive: ${drive}`);
        return await this.volume.handler.getCAT(new beebfs.FSP(this.volume, false, new DFSFSP(drive, undefined, undefined)), this);
    }

    public starDrive(arg: string | undefined): boolean {
        if (arg === undefined) {
            return errors.badDrive();
        }

        if (arg.length === 1 && utils.isdigit(arg)) {
            this.drive = arg;
        } else {
            const fsp = mustBeDFSFSP(this.volume.handler.parseFileOrDirString(arg, 0, true));
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
        const drives = await mustBeDFSHandler(this.volume.handler).findDrivesForVolume(this.volume);

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
        const dfsHandler = mustBeDFSHandler(this.volume.handler);
        return await dfsHandler.loadBootOption(this.volume, this.drive);
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
        const dfsHandler = mustBeDFSHandler(this.volume.handler);
        return await dfsHandler.loadTitle(this.volume, this.drive);
    }

    public async readNames(): Promise<string[]> {
        const files = await this.volume.handler.findBeebFilesMatching(this.volume, new DFSFSP(this.drive, this.dir, undefined), undefined);

        const names: string[] = [];
        for (const file of files) {
            const dfsFQN = mustBeDFSFQN(file.fqn.fsFQN);
            names.push(dfsFQN.name);
        }

        return names;
    }

    private getDirOrLibFQN(fsp: beebfs.FSP): DFSFQN {
        const dfsFSP = mustBeDFSFSP(fsp.name);

        if (fsp.wasExplicitVolume || dfsFSP.name !== undefined) {
            return errors.badDir();
        }

        // the name part is bogus, but it's never used.
        return new DFSFQN(dfsFSP.drive !== undefined ? dfsFSP.drive : this.drive, dfsFSP.dir !== undefined ? dfsFSP.dir : this.dir, '');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

class DFSHandler implements beebfs.IFSType {
    private static isValidFileNameChar(char: string) {
        const c = char.charCodeAt(0);
        return c >= 32 && c < 127;
    }

    public readonly matchAllFSP: beebfs.IFSFSP = new DFSFSP(undefined, undefined, undefined);

    public createState(volume: beebfs.Volume, log: utils.Log): beebfs.IFSState {
        return new DFSState(volume, log);
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

        if (!DFSHandler.isValidFileNameChar(str[0])) {
            return false;
        }

        for (let i = 2; i < str.length; ++i) {
            if (!DFSHandler.isValidFileNameChar(str[i])) {
                return false;
            }
        }

        return true;
    }

    public parseFileOrDirString(str: string, i: number, parseAsDir: boolean): DFSFSP {
        let drive: string | undefined;
        let dir: string | undefined;
        let name: string | undefined;

        if (str[i] === ':' && i + 1 < str.length) {
            if (!this.isValidDrive(str[i + 1])) {
                return errors.badDrive();
            }

            drive = str[i + 1];
            i += 2;

            if (str[i] === '.') {
                ++i;
            }
        }

        if (str[i + 1] === '.') {
            if (!DFSHandler.isValidFileNameChar(str[i])) {
                return errors.badDir();
            }

            dir = str[i];
            i += 2;
        }

        if (parseAsDir) {
            if (i < str.length && dir !== undefined || i === str.length - 1 && !DFSHandler.isValidFileNameChar(str[i])) {
                return errors.badDir();
            }

            dir = str[i];
        } else {
            if (i < str.length) {
                for (let j = i; j < str.length; ++j) {
                    if (!DFSHandler.isValidFileNameChar(str[j])) {
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

    public createFQN(fsp: DFSFSP, state: beebfs.IFSState | undefined): DFSFQN {
        mustBeDFSFSP(fsp);
        const dfsState = mustBeDFSState(state);

        let drive: string;
        if (fsp.drive === undefined) {
            if (dfsState === undefined) {
                return errors.badName();
            }

            drive = dfsState.drive;
        } else {
            drive = fsp.drive;
        }

        let dir: string;
        if (fsp.dir === undefined) {
            if (dfsState === undefined) {
                return errors.badName();
            }
            dir = dfsState.dir;
        } else {
            dir = fsp.dir;
        }

        if (fsp.name === undefined) {
            return errors.badName();
        }

        return new DFSFQN(drive, dir, fsp.name);
    }

    public getHostPath(fqn: beebfs.IFSFQN): string {
        const dfsFQN = mustBeDFSFQN(fqn);

        return path.join(dfsFQN.drive, beebfs.getHostChars(dfsFQN.dir) + '.' + beebfs.getHostChars(fqn.name));
    }

    public async findBeebFilesMatching(volume: beebfs.Volume, pattern: beebfs.IFSFQN | beebfs.IFSFSP, log: utils.Log | undefined): Promise<beebfs.File[]> {
        let driveNames: string[];
        let dirRegExp: RegExp;
        let nameRegExp: RegExp;

        if (pattern instanceof DFSFQN) {
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

        const beebFiles: beebfs.File[] = [];

        for (const driveName of driveNames) {
            const driveHostPath = path.join(volume.path, driveName);
            const beebFileInfos = await inf.getINFsForFolder(driveHostPath, log);

            for (const beebFileInfo of beebFileInfos) {
                let text = false;

                if (!this.isValidBeebFileName(beebFileInfo.name)) {
                    continue;
                }

                const dir = beebFileInfo.name[0];
                const name = beebFileInfo.name.slice(2);

                if (dirRegExp.exec(dir) === null || nameRegExp.exec(name) === null) {
                    continue;
                }

                if (beebFileInfo.noINF) {
                    if (beebFileInfo.name[0] === '!') {
                        text = true;
                    }
                }

                const dfsFQN = new DFSFQN(driveName, dir, name);

                const file = new beebfs.File(beebFileInfo.hostPath, new beebfs.FQN(volume, dfsFQN), beebFileInfo.load, beebFileInfo.exec, beebFileInfo.attr | DFS_FIXED_ATTRS, text);

                if (log !== undefined) {
                    log.pn(`${file}`);
                }

                beebFiles.push(file);
            }
        }

        if (log !== undefined) {
            log.out();
        }

        return beebFiles;
    }

    public async getCAT(fsp: beebfs.FSP, state: beebfs.IFSState | undefined): Promise<string> {
        const fspDFSName = mustBeDFSFSP(fsp.name);
        const dfsState = mustBeDFSState(state);

        if (fspDFSName.drive === undefined || fspDFSName.name !== undefined) {
            return errors.badDrive();
        }

        const beebFiles = await this.findBeebFilesMatching(fsp.volume, new DFSFSP(fspDFSName.drive, undefined, undefined), undefined);

        let text = '';

        const title = await this.loadTitle(fsp.volume, fspDFSName.drive);
        if (title !== '') {
            text += title + utils.BNL;
        }

        text += 'Volume: ' + fsp.volume.name + utils.BNL;

        const boot = await this.loadBootOption(fsp.volume, fspDFSName.drive);
        text += ('Drive ' + fspDFSName.drive + ' (' + boot + ' - ' + beebfs.getBootOptionDescription(boot) + ')').padEnd(20);

        if (dfsState !== undefined) {
            text += ('Dir :' + dfsState.dir + '.' + dfsState.dir).padEnd(10);

            text += 'Lib :' + dfsState.libDrive + '.' + dfsState.libDir;
        }

        text += utils.BNL + utils.BNL;

        let dir: string;
        if (dfsState !== undefined) {
            dir = dfsState.dir;
        } else {
            dir = '$';
        }

        beebFiles.sort((a, b) => {
            const aNameFSName = mustBeDFSFQN(a.fqn.fsFQN);
            const bNameFSName = mustBeDFSFQN(b.fqn.fsFQN);

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
        await errors.mustNotExist(newHostPath);

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
            return DFS_FIXED_ATTRS;
        } else if (attrString.toLowerCase() === 'l') {
            return DFS_FIXED_ATTRS | beebfs.L_ATTR;
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
        const dfsFQN = mustBeDFSFQN(file.fqn.fsFQN);

        const attr = (file.attr & beebfs.L_ATTR) !== 0 ? 'L' : ' ';
        const load = utils.hex8(file.load).toUpperCase();
        const exec = utils.hex8(file.exec).toUpperCase();
        const size = utils.hex(fileSize & 0x00ffffff, 6).toUpperCase();

        // 0123456789012345678901234567890123456789
        // _.__________ L 12345678 12345678 123456
        return `${dfsFQN.dir}.${dfsFQN.name.padEnd(10)} ${attr} ${load} ${exec} ${size}`;
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
            if (this.isValidDrive(name)) {
                const option = await this.loadBootOption(volume, name);
                const title = await this.loadTitle(volume, name);

                drives.push({ name, option, title });
            }
        }

        return drives;
    }

    private isValidDrive(maybeDrive: string): boolean {
        return maybeDrive.length === 1 && utils.isdigit(maybeDrive);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export default new DFSHandler();
