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
import * as path from 'path';
import * as beebfs from './beebfs';
import * as utils from './utils';
import * as errors from './errors';
import * as server from './server';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// A fairly arbitrary choice. *INFO output needs to be printable in Mode 7.
const MAX_NAME_LENGTH = 31;

// 0123456789012345678901234567890123456789
// _______________________________  123456


function notSupported(): never {
    return errors.generic('Not supported');
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class PCState implements beebfs.IFSState {
    public readonly volume: beebfs.Volume;

    private readonly log: utils.Log | undefined;// tslint:disable-line no-unused-variable

    public constructor(volume: beebfs.Volume, log: utils.Log | undefined) {
        this.volume = volume;
        this.log = log;
    }

    public getCurrentDrive(): string {
        return '';
    }

    public getCurrentDir(): string {
        return '';
    }

    public getLibraryDrive(): string {
        return '';
    }

    public getLibraryDir(): string {
        return '';
    }

    public getTransientSettings(): any | undefined {
        return undefined;
    }

    public getTransientSettingsString(_settings: unknown | undefined): string {
        return ``;
    }

    public getPersistentSettings(): unknown | undefined {
        return undefined;
    }

    public getPersistentSettingsString(_settings: unknown | undefined): string {
        return '';
    }

    public async getFileForRUN(_fqn: beebfs.FQN, _tryLibDir: boolean): Promise<beebfs.File | undefined> {
        // PC files don't have BBC-style attributes, so *RUN is impossible.
        return undefined;
    }

    public async getCAT(commandLine: string | undefined): Promise<string | undefined> {
        if (commandLine === undefined) {
            return await this.volume.type.getCAT(new beebfs.FilePath(this.volume, true, '', true, '', true), this, this.log);
        } else {
            return undefined;
        }
    }

    public starDrive(_arg: string | undefined): boolean {
        return errors.badDrive();
    }

    public starDir(_filePath: beebfs.FilePath): void {
        return notSupported();
    }

    public starLib(_filePath: beebfs.FilePath): void {
        return notSupported();
    }

    public async getDrivesOutput(): Promise<string> {
        return '';
    }

    public async getBootOption(): Promise<number> {
        return 0;
    }

    public async setBootOption(_option: number): Promise<void> {
        return notSupported();
    }

    public async setTitle(_title: string): Promise<void> {
        return notSupported();
    }

    public async getTitle(): Promise<string> {
        return '';
    }

    public async readNames(): Promise<string[]> {
        const files = await this.volume.type.findBeebFilesMatching(new beebfs.FQN(new beebfs.FilePath(this.volume, true, '', true, '', true), '*'), false, undefined);

        const names: string[] = [];
        for (const file of files) {
            names.push(file.fqn.name);
        }

        return names;
    }

    public getCommands(): server.Command[] {
        return [];
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class PCType implements beebfs.IFSType {
    public readonly name = 'PC';

    public async createState(volume: beebfs.Volume, transientSettings: any | undefined, persistentSettings: any | undefined, log: utils.Log | undefined): Promise<beebfs.IFSState> {
        return new PCState(volume, log);
    }

    public canWrite(): boolean {
        return false;
    }

    public isValidBeebFileName(str: string): boolean {
        if (str.length >= MAX_NAME_LENGTH) {
            return false;
        }

        for (let i = 0; i < str.length; ++i) {
            const c = str.charCodeAt(i);
            if (c <= 32 || c >= 127) {
                return false;
            }
        }

        return true;
    }

    public parseFileString(str: string, i: number, state: beebfs.IFSState | undefined, volume: beebfs.Volume, volumeExplicit: boolean): beebfs.FQN {
        // See note in FS.parseFileOrDirString.
        //
        // The i!==0 check is supposed to make sure this only comes in to play
        // with the volume syntax, so that '::fred:x' refers to 'x' in the
        // 'fred' volume but ':x' refers to a file called ':x' in the current
        // volume.
        //
        // This isn't very nice, but it'll probably be OK...
        if (i !== 0) {
            if (str.charAt(i) === ':' || str.charAt(i) === '/') {
                ++i;
            }
        }

        if (i === str.length) {
            return errors.badName();
        } else {
            const name = str.substring(i);
            if (!this.isValidBeebFileName(name)) {
                return errors.badName();
            }

            return new beebfs.FQN(new beebfs.FilePath(volume, volumeExplicit, '', false, '', false), name);
        }
    }

    public parseDirString(str: string, i: number, _state: beebfs.IFSState | undefined, volume: beebfs.Volume, volumeExplicit: boolean): beebfs.FilePath {
        if (i === str.length) {
            return new beebfs.FilePath(volume, volumeExplicit, '', true, '', true);
        } else {
            // Sorry, no dirs for PC volumes.
            return errors.badDir();
        }
    }

    public getIdealVolumeRelativeServerPath(fqn: beebfs.FQN): string {
        return fqn.name;
    }

    public async findBeebFilesInVolume(volume: beebfs.Volume, log: utils.Log | undefined): Promise<beebfs.File[]> {
        return await this.findFiles(volume, undefined, log);
    }

    public async locateBeebFiles(fqn: beebfs.FQN, log: utils.Log | undefined): Promise<beebfs.File[]> {
        return this.findBeebFilesMatching(fqn, true, log);
    }

    public async findBeebFilesMatching(fqn: beebfs.FQN, recurse: boolean, log: utils.Log | undefined): Promise<beebfs.File[]> {
        // The recurse flag is ignored. PC folders are not currently
        // hierarchical.
        const nameRegExp = utils.getRegExpFromAFSP(fqn.name);

        return await this.findFiles(fqn.filePath.volume, nameRegExp, log);
    }

    public async getCAT(filePath: beebfs.FilePath, state: beebfs.IFSState | undefined, log: utils.Log | undefined): Promise<string> {
        let text = '';

        text += `Volume: ${filePath.volume.path}${utils.BNL}${utils.BNL}`;

        const beebFiles = await this.findBeebFilesMatching(new beebfs.FQN(filePath, '*'), false, log);

        beebFiles.sort((a, b) => {
            return utils.stricmp(a.fqn.name, b.fqn.name);
        });

        for (const beebFile of beebFiles) {
            text += beebFile.fqn.name.padEnd(40);
        }

        text += utils.BNL;

        return text;
    }

    public async deleteFile(_file: beebfs.File): Promise<void> {
        return notSupported();
    }

    public async renameFile(_oldFile: beebfs.File, _newFQN: beebfs.FQN): Promise<void> {
        return notSupported();
    }

    public async writeBeebMetadata(_serverPath: string, _fqn: beebfs.FQN, _load: beebfs.FileAddress, _exec: beebfs.FileAddress, _attr: beebfs.FileAttributes): Promise<void> {
        return notSupported();
    }

    public getNewAttributes(_oldAttr: beebfs.FileAttributes, _attrString: string): beebfs.FileAttributes | undefined {
        return notSupported();
    }

    public getInfoText(file: beebfs.File, fileSize: number): string {
        return this.getCommonInfoText(file, fileSize);
    }

    public getWideInfoText(file: beebfs.File, stats: fs.Stats): string {
        return `${this.getCommonInfoText(file, stats.size)} ${utils.getDateString(stats.mtime)}`;
    }

    public getAttrString(_file: beebfs.File): string | undefined {
        return undefined;
    }

    private getCommonInfoText(file: beebfs.File, fileSize: number): string {
        return `${file.fqn.name.padEnd(MAX_NAME_LENGTH)}  ${utils.hex(fileSize, 6)}`;
    }

    private async findFiles(volume: beebfs.Volume, nameRegExp: RegExp | undefined, _log: utils.Log | undefined): Promise<beebfs.File[]> {
        let serverNames: string[];
        try {
            serverNames = await utils.fsReaddir(volume.path);
        } catch (error) {
            return [];
        }

        const beebFiles: beebfs.File[] = [];
        for (const serverName of serverNames) {
            if (!this.isValidBeebFileName(serverName)) {
                continue;
            }

            if (nameRegExp !== undefined) {
                if (nameRegExp.exec(serverName) === null) {
                    continue;
                }
            }

            const serverPath = path.join(volume.path, serverName);

            const st = await utils.tryStat(serverPath);
            if (st === undefined) {
                continue;
            }

            if (!st.isFile()) {
                continue;
            }

            if (st.size > beebfs.MAX_FILE_SIZE) {
                continue;
            }

            const fqn = new beebfs.FQN(new beebfs.FilePath(volume, true, '', false, '', false), serverName);
            const file = new beebfs.File(path.join(volume.path, serverName), fqn, beebfs.DEFAULT_LOAD, beebfs.DEFAULT_EXEC, beebfs.R_ATTR);
            beebFiles.push(file);
        }

        return beebFiles;
    }

}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export default new PCType();
