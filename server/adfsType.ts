//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
// Copyright (C) 2024 Tom Seddon
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

import * as beebfs from './beebfs';
import * as utils from './utils';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

const MAX_NAME_LENGTH = 10;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSPath {
    public constructor(public readonly drive: string, public readonly dir: string) { }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSTransientSettings {
    public constructor(public readonly current: ADFSPath, public readonly library: ADFSPath) { }
}

const gDefaultTransientSettings = new ADFSTransientSettings(new ADFSPath('0', '$'), new ADFSPath('0', '$'));

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSState implements beebfs.IFSState {
    public readonly volume: beebfs.Volume;

    private current: ADFSPath;
    private library: ADFSPath;

    private readonly log: utils.Log | undefined;// tslint:disable-line no-unused-variable

    public constructor(volume: beebfs.Volume, transientSettingsAny: unknown, log: utils.Log | undefined) {
        this.volume = volume;
        this.log = log;

        const transientSettings = ADFSState.getADFSTransientSettings(transientSettingsAny);

        this.current = transientSettings.current;
        this.library = transientSettings.library;
    }

    private static getADFSTransientSettings(settings: unknown): ADFSTransientSettings {
        if (settings === undefined) {
            return gDefaultTransientSettings;
        }

        if (!(settings instanceof ADFSTransientSettings)) {
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

    public getTransientSettings(): ADFSTransientSettings {
        return new ADFSTransientSettings(this.current, this.library);
    }

    public getTransientSettingsString(settingsAny: unknown): string {
        const settings = ADFSState.getADFSTransientSettings(settingsAny);

        return `Default dir :${settings.current.drive}.${settings.current.dir}${utils.BNL}Default lib :${settings.library.drive}.${settings.library.dir}${utils.BNL}`;
    }

    public getPersistentSettings(): undefined {
        return undefined;
    }

    public getPersistentSettingsString(_settings: unknown): string {
        return '';
    }

    
};

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

class ADFSType implements beebfs.IFSType {
    public readonly name = 'BeebLink/ADFS';

    public static isValidDrive(maybeDrive: string): boolean {
        return maybeDrive.length === 1 && utils.isalnum(maybeDrive);
    }

    public async createState(volume: beebfs.Volume, transientSettings: unknown, persistentSettings: unknown, log: utils.Log | undefined): Promise<beebfs.IFSState> {
        return new ADFSState(volume, transientSettings, log);
    }

    public canWrite(): boolean {
        return true;
    }

    private static isValidFileNameChar(char: string): boolean {
        const c = char.charCodeAt(0);
        return c >= 32 && c < 127;
    }

    public isValidBeebFileName(str: string): boolean {
        if (str.length > MAX_NAME_LENGTH) {
            return false;
        }

        for (let i = 0; i < str.length; ++i) {
            if (!ADFSType.isValidFileNameChar(str[i])) {
                return false;
            }
        }


        return true;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export default new ADFSType();