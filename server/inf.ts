//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
// Copyright (C) 2018, 2019, 2020 Tom Seddon
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

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export const ext = '.inf';

export const extRegExp = new RegExp(`\\${ext}$$`, 'i');

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Write non-standard BeebLink-/TubeHost-style .inf file. No length field, and
// attributes always "Locked" or absent.
export async function writeNonStandardINFFile(hostPath: string, name: string, load: beebfs.FileAddress, exec: beebfs.FileAddress, locked: boolean): Promise<void> {
    let inf = `${name} ${utils.hex8(load)} ${utils.hex8(exec)}`;

    if (locked) {
        inf += ' Locked';
    }

    inf += os.EOL;//stop git moaning.

    await utils.fsMkdirAndWriteFile(hostPath + ext, Buffer.from(inf, 'binary'));
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Convert a hex address from a .inf file into a number, or undefined if it
// isn't valid. Sign-extend 6-digit DFS *INFO output if necessary.
function tryParseAddress(addressString: string): beebfs.FileAddress | undefined {
    let address = Number('0x' + addressString);
    if (Number.isNaN(address)) {
        return undefined;
    }

    // Try to work around 6-digit DFS addresses.
    if (addressString.length === 6) {
        if ((address & 0xff0000) === 0xff0000) {
            // Javascript bitwise operators work with 32-bit signed values,
            // so |=0xff000000 makes a negative mess.
            address += 0xff000000;
        }
    }

    return address as beebfs.FileAddress;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Causes a 'Exists on server' error if the given host file or metadata
// counterpart exists.
//
// This is to cater for trying to create a new file that would have the same
// PC name as an existing file. Could be due to mismatches between BBC names
// in the .inf files and the actual names on disk, could be due to loose
// non-BBC files on disk...
export async function mustNotExist(hostPath: string): Promise<void> {
    if (await utils.tryStat(hostPath) !== undefined || await utils.tryStat(hostPath + ext) !== undefined) {
        return errors.exists('Exists on server');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export interface IINF {
    // Host path for this file.
    hostPath: string;

    // Name, verbatim.
    name: string;

    // Load address.
    load: beebfs.FileAddress;

    // Execution address.
    exec: beebfs.FileAddress;

    // Attributes. "L" is translated to L_ATTR.
    attr: beebfs.FileAttributes;

    // true if the .inf file is non-existent or 0 bytes.
    noINF: boolean;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Try to parse a .inf file. infBuffer is the contents, or undefined if no .inf
// file; hostName is the basename of the host file.
//
// hostName should be path.basename(hostPath); this could be computed, but since
// the caller will already have it, might as well have it supply it.
export async function tryParse(
    infBuffer: Buffer | undefined,
    hostPath: string,
    hostName: string,
    log: utils.Log | undefined): Promise<IINF | undefined> {
    let name: string;
    let load: beebfs.FileAddress | undefined;
    let exec: beebfs.FileAddress | undefined;
    let attr: beebfs.FileAttributes;
    let noINF: boolean;

    if (infBuffer === undefined || infBuffer.length === 0) {
        name = hostName;
        load = beebfs.DEFAULT_LOAD;
        exec = beebfs.DEFAULT_EXEC;
        attr = beebfs.DEFAULT_ATTR;
        noINF = true;
    } else {
        const infString = utils.getFirstLine(infBuffer);

        log?.p(' - ``' + infString + '\'\'');

        const infParts = infString.split(new RegExp('\\s+'));
        if (infParts.length < 3) {
            log?.pn(' - too few parts');

            return undefined;
        }

        let i = 0;

        name = infParts[i++];

        load = tryParseAddress(infParts[i++]);
        if (load === undefined) {
            log?.pn(' - invalid load');

            return undefined;
        }

        exec = tryParseAddress(infParts[i++]);
        if (exec === undefined) {
            log?.pn(' - invalid exec');

            return undefined;
        }

        attr = beebfs.DEFAULT_ATTR;
        if (i < infParts.length) {
            if (infParts[i].startsWith('CRC=')) {
                // Ignore the CRC entry.
            } else if (['l', 'locked'].indexOf(infParts[i].toLowerCase()) >= 0) {
                attr = beebfs.DFS_LOCKED_ATTR;
            } else {
                attr = Number('0x' + infParts[i]) as beebfs.FileAttributes;
                if (Number.isNaN(attr)) {
                    log?.pn(' - invalid attributes');

                    return undefined;
                }
            }

            ++i;
        }

        noINF = false;
    }

    log?.pn(` - load=0x${load.toString(16)} exec=0x${exec.toString(16)} attr=0x${attr.toString(16)}`);

    return { hostPath, name, load, exec, attr, noINF };
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Find all .inf files in the given folder, call tryParse as
// appropriate, and return an array of the results.
export async function getINFsForFolder(hostFolderPath: string, log: utils.Log | undefined): Promise<IINF[]> {
    let hostNames: string[];
    try {
        hostNames = await utils.fsReaddir(hostFolderPath);
    } catch (error) {
        return [];
    }

    const beebFileInfos: IINF[] = [];

    log?.pn('getINFsForFolder:');
    log?.in(`    `);
    log?.pn(`folder path: ${hostFolderPath}`);
    log?.pn(`.inf regexp: ${extRegExp.source}`);

    for (const hostName of hostNames) {
        if (extRegExp.exec(hostName) !== null) {
            // skip .inf files.
            continue;
        }

        const hostPath = path.join(hostFolderPath, hostName);

        log?.p(`${hostName}: `);

        const infBuffer = await utils.tryReadFile(`${hostPath}${ext}`);

        const beebFileInfo = await tryParse(infBuffer, hostPath, hostName, log);
        if (beebFileInfo === undefined) {
            continue;
        }

        beebFileInfos.push(beebFileInfo);
    }

    log?.out();

    return beebFileInfos;
}

