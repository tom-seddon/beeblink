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

class PCFQN implements beebfs.IFSFQN {
    public readonly name: string;

    public constructor(name: string) {
        this.name = name;
    }

    public equals(other: beebfs.IFSFQN): boolean {
        if (!(other instanceof PCFQN)) {
            return false;
        }

        if (utils.getCaseNormalizedPath(other.name) !== utils.getCaseNormalizedPath(this.name)) {
            return false;
        }

        return true;
    }

    public toString(): string {
        return `:${this.name}`;
    }

    public isWildcard(): boolean {
        for (const c of this.name) {
            if (c === utils.MATCH_N_CHAR || c === utils.MATCH_ONE_CHAR) {
                return true;
            }
        }

        return false;
    }
}

function mustBePCFQN(fsFQN: beebfs.IFSFQN): PCFQN {
    if (!(fsFQN instanceof PCFQN)) {
        throw new Error('not PCFQN');
    }

    return fsFQN;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class PCFSP implements beebfs.IFSFSP {
    public readonly name: string | undefined;

    public constructor(name: string | undefined) {
        this.name = name;
    }

    public toString(): string {
        return `:${this.name !== undefined ? this.name : '\u2026'}`;
    }
}

function mustBePCFSP(fsFSP: beebfs.IFSFSP): PCFSP {
    if (!(fsFSP instanceof PCFSP)) {
        throw new Error('not PCFSP');
    }

    return fsFSP;
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

    public getTransientSettingsString(settings: any | undefined): string {
        return ``;
    }

    public getPersistentSettings(): any | undefined {
        return undefined;
    }

    public getPersistentSettingsString(settings: any | undefined): string {
        return '';
    }

    public async getFileForRUN(fsp: beebfs.FSP, tryLibDir: boolean): Promise<beebfs.File | undefined> {
        // PC files don't have BBC-style attributes, so *RUN is impossible.
        return undefined;
    }

    public async getCAT(commandLine: string | undefined): Promise<string | undefined> {
        if (commandLine === undefined) {
            return await this.volume.type.getCAT(new beebfs.FSP(this.volume, undefined, new PCFSP(undefined)), this, this.log);
        } else {
            return undefined;
        }
    }

    public starDrive(arg: string | undefined): boolean {
        return errors.badDrive();
    }

    public starDir(fsp: beebfs.FSP): void {
        return notSupported();
    }

    public starLib(fsp: beebfs.FSP): void {
        return notSupported();
    }

    public async getDrivesOutput(): Promise<string> {
        return '';
    }

    public async getBootOption(): Promise<number> {
        return 0;
    }

    public async setBootOption(option: number): Promise<void> {
        return notSupported();
    }

    public async setTitle(title: string): Promise<void> {
        return notSupported();
    }

    public async getTitle(): Promise<string> {
        return '';
    }

    public async readNames(): Promise<string[]> {
        const files = await this.volume.type.findBeebFilesMatching(this.volume, new PCFSP(undefined), false, undefined);

        const names: string[] = [];
        for (const file of files) {
            const pcFQN = mustBePCFQN(file.fqn.fsFQN);
            names.push(pcFQN.name);
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

    public parseFileOrDirString(str: string, i: number, parseAsDir: boolean): PCFSP {
        // See note in FS.parseFileOrDirString.
        //
        // The i!==0 check is supposed to make sure this only comes in to play
        // with the volume syntax, so that '::fred:x' refers to 'x' in the
        // 'fred' volume but ':x' refers to a file called ':x' in the current
        // volume.
        //
        // This isn't very nice, but it'll probably be OK...
        if (i !== 0) {
            if (str.charAt(i) === ':') {
                ++i;
            }
        }

        if (i === str.length) {
            return new PCFSP(undefined);
        } else if (parseAsDir) {
            // every dir is a bad dir for a PC volume...
            return errors.badDir();
        } else {
            const name = str.substr(i);
            if (!this.isValidBeebFileName(name)) {
                return errors.badName();
            }

            return new PCFSP(name);
        }
    }

    public createFQN(fsp: beebfs.IFSFSP, state: beebfs.IFSState | undefined): PCFQN {
        const pcFSP = mustBePCFSP(fsp);

        if (pcFSP.name === undefined) {
            return errors.badName();
        }

        //process.stderr.write(`PCType.createFQN: pcFSP.name="${pcFSP.name}"\n`);

        return new PCFQN(pcFSP.name);
    }

    public getHostPath(fqn: beebfs.IFSFQN): string {
        const pcFQN = mustBePCFQN(fqn);

        return pcFQN.name;
    }

    public async findBeebFilesMatching(volume: beebfs.Volume, pattern: beebfs.IFSFQN | beebfs.IFSFSP | undefined, recurse: boolean, log: utils.Log | undefined): Promise<beebfs.File[]> {
        let nameRegExp: RegExp;

        if (pattern === undefined) {
            nameRegExp = utils.getRegExpFromAFSP('*');
        } else if (pattern instanceof PCFQN) {
            nameRegExp = utils.getRegExpFromAFSP(pattern.name);
        } else if (pattern instanceof PCFSP) {
            if (pattern.name !== undefined) {
                nameRegExp = utils.getRegExpFromAFSP(pattern.name);
            } else {
                nameRegExp = utils.getRegExpFromAFSP('*');
            }
        } else {
            throw new Error('not PCFQN or PCFSP');
        }

        // The recursion flag is ignored. PC folders are not (yet?)
        // hierarchical.

        let hostNames: string[];
        try {
            hostNames = await utils.fsReaddir(volume.path);
        } catch (error) {
            return [];
        }

        const beebFiles: beebfs.File[] = [];
        for (const hostName of hostNames) {
            if (!this.isValidBeebFileName(hostName)) {
                continue;
            }

            if (nameRegExp.exec(hostName) === null) {
                continue;
            }

            const hostPath = path.join(volume.path, hostName);

            const st = await utils.tryStat(hostPath);
            if (st === undefined) {
                continue;
            }

            if (!st.isFile()) {
                continue;
            }

            if (st.size > beebfs.MAX_FILE_SIZE) {
                continue;
            }

            let text = false;
            if (utils.getCaseNormalizedPath(path.extname(hostName)) === '.txt') {
                text = true;
            }

            const pcFQN = new PCFQN(hostName);
            const file = new beebfs.File(path.join(volume.path, hostName), new beebfs.FQN(volume, pcFQN), beebfs.DEFAULT_LOAD, beebfs.DEFAULT_EXEC, beebfs.R_ATTR, text);
            beebFiles.push(file);
        }

        return beebFiles;
    }

    public async getCAT(fsp: beebfs.FSP, state: beebfs.IFSState | undefined, log: utils.Log | undefined): Promise<string> {
        let text = '';

        text += `Volume: ${fsp.volume.path}${utils.BNL}${utils.BNL}`;

        const beebFiles = await this.findBeebFilesMatching(fsp.volume, new PCFSP('*'), false, undefined);
        for (const beebFile of beebFiles) {
            mustBePCFQN(beebFile.fqn.fsFQN);
        }

        beebFiles.sort((a, b) => {
            const aPCFQN = a.fqn.fsFQN as PCFQN;
            const bPCFQN = b.fqn.fsFQN as PCFQN;

            return utils.stricmp(aPCFQN.name, bPCFQN.name);
        });

        for (const beebFile of beebFiles) {
            const pcFQN = beebFile.fqn.fsFQN as PCFQN;

            text += pcFQN.name.padEnd(40);
        }

        text += utils.BNL;

        return text;
    }

    public async deleteFile(file: beebfs.File): Promise<void> {
        return notSupported();
    }

    public async renameFile(oldFile: beebfs.File, newFQN: beebfs.FQN): Promise<void> {
        return notSupported();
    }

    public async writeBeebMetadata(hostPath: string, fqn: beebfs.IFSFQN, load: number, exec: number, attr: number): Promise<void> {
        return notSupported();
    }

    public getNewAttributes(oldAttr: number, attrString: string): number | undefined {
        return notSupported();
    }

    public getInfoText(file: beebfs.File, fileSize: number): string {
        return this.getCommonInfoText(file, fileSize);
    }

    public getWideInfoText(file: beebfs.File, stats: fs.Stats): string {
        return `${this.getCommonInfoText(file, stats.size)} ${utils.getDateString(stats.mtime)}`;
    }

    public getAttrString(file: beebfs.File): string | undefined {
        return undefined;
    }

    private getCommonInfoText(file: beebfs.File, fileSize: number): string {
        const pcFQN = mustBePCFQN(file.fqn.fsFQN);

        return `${pcFQN.name.padEnd(MAX_NAME_LENGTH)}  ${utils.hex(fileSize, 6)}`;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export default new PCType();
