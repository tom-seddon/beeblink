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

const OPT_KEY = 'OPT';
const DIR_TITLE_KEY = 'DIRTITLE';
const TITLE_KEY = 'TITLE';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export interface IINF {
    // Server path for this file.
    serverPath: string;

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

    // Extra data, if any (which there typically isn't).
    extra: IExtraData | undefined;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Possible extra stuff from the .inf file.
export interface IExtraData {
    // OPT=
    opt: number | undefined;

    // TITLE=
    title: string | undefined;

    // DIRTITLE=
    dirTitle: string | undefined;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Write non-standard BeebLink-/TubeHost-style .inf file. No length field, and
// attributes always "Locked" or absent.
export async function writeNonStandardINFFile(serverPath: string, name: string, load: beebfs.FileAddress, exec: beebfs.FileAddress, locked: boolean): Promise<void> {
    let inf = `${name} ${utils.hex8(load)} ${utils.hex8(exec)}`;

    if (locked) {
        inf += ' Locked';
    }

    inf += os.EOL;//stop git moaning.

    await utils.fsMkdirAndWriteFile(serverPath + ext, Buffer.from(inf, 'binary'));
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Write standard .inf file. If attr is a string, it will be written verbatim.
export async function writeStandardINFFile(servorPath: string, name: string, load: beebfs.FileAddress, exec: beebfs.FileAddress, length: number, attr: beebfs.FileAttributes | string, extra: IExtraData | undefined): Promise<void> {
    let inf = `${name} ${utils.hex8(load)} ${utils.hex8(exec)} ${utils.hex8(length)} `;
    if (typeof (attr) === 'string') {
        inf += attr;
    } else {
        inf += utils.hex2(attr);
    }

    if (extra !== undefined) {
        if (extra.dirTitle !== undefined) {
            inf += ` ${DIR_TITLE_KEY}="${extra.dirTitle}"`;
        }

        if (extra.title !== undefined) {
            inf += `${TITLE_KEY}="${extra.title}"`;
        }

        if (extra.opt !== undefined) {
            inf += ` ${OPT_KEY}=${extra.opt}`;
        }
    }

    inf += os.EOL;//stop git moaning

    await utils.fsMkdirAndWriteFile(servorPath + ext, Buffer.from(inf, 'binary'));
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function tryParseHexNumber(str: string): number | undefined {
    const value = parseInt(str, 16);
    if (Number.isNaN(value)) {
        return undefined;
    }

    return value;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Convert a hex address from a .inf file into a number, or undefined if it
// isn't valid. Sign-extend 6-digit DFS *INFO output if necessary.
function tryParseAddress(addressString: string): beebfs.FileAddress | undefined {
    let address = tryParseHexNumber(addressString);
    if (address === undefined) {
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

// Causes a 'Exists on server' error if the given server file or metadata
// counterpart exists.
//
// This is to cater for trying to create a new file that would have the same PC
// name as an existing file. Could be due to mismatches between BBC names in the
// .inf files and the actual names on disk, could be due to loose non-BBC files
// on disk...
export async function mustNotExist(serverPath: string): Promise<void> {
    if (await utils.tryStat(serverPath) !== undefined || await utils.tryStat(serverPath + ext) !== undefined) {
        return errors.exists('Exists on server');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function makeAttrCharsMap(): (number | undefined)[] {
    const attrs: (number | undefined)[] = [];

    function set(s: string, v: number): void {
        attrs[s.charCodeAt(0)] = v;
    }

    set('R', beebfs.R_ATTR);
    set('W', beebfs.W_ATTR);
    set('E', beebfs.E_ATTR);
    set('L', beebfs.L_ATTR);

    return attrs;
}

const SPACE_CHAR = 32;
const QUOTE_CHAR = '"'.charCodeAt(0);
const EQUALS_CHAR = '='.charCodeAt(0);
const DFS_LOCKED_ATTRS_LC = ['l', 'locked'];
const ATTR_CHARS_MAP = makeAttrCharsMap();

// Try to parse a .inf file. infBuffer is the contents, or undefined if no .inf
// file; serverName is the basename of the server file.
//
// serverName should be path.basename(serverPath); this could be computed, but
// since the caller will already have it, might as well have it supply it.
function tryParse2(
    infBuffer: Buffer | undefined,
    serverPath: string,
    serverName: string,
    log: utils.Log | undefined): IINF | undefined {

    if (infBuffer === undefined || infBuffer.length === 0) {
        return {
            name: serverName,
            serverPath,
            load: beebfs.DEFAULT_LOAD,
            exec: beebfs.DEFAULT_EXEC,
            attr: beebfs.DEFAULT_ATTR,
            noINF: true,
            extra: undefined
        };
    }

    // See
    // https://github.com/geraldholdsworth/DiscImageManager/blob/e81f1961556090989e9960ffc725597c08396fad/LazarusSource/DiscImageUtils.pas#L250
    // Should really supported quoted names here too. But it's not obvious
    // how the quotes might be themselves quoted.
    //
    // TubeHost/BeebLink: NAME LOAD EXEC LOCKED ...
    // Standard: NAME LOAD EXEC LENGTH ATTR EXTRA...

    // let name: string;
    // let load:beebfs.FileA| undefined;
    // let exec: beebfs.FileAddress | undefined;
    // let attr: beebfs.FileAttributes;
    let extra: IExtraData | undefined;
    const noINF = false;
    let i: number;

    // find length of first line of buffer.
    i = 0;
    while (i < infBuffer.length) {
        if (infBuffer[i] === 10 || infBuffer[i] === 13 || infBuffer[i] === 26) {
            break;
        }

        ++i;
    }
    const n = i;

    log?.p(`\`\`${infBuffer.toString('binary', 0, n)}''`);

    // consume chars matching ch. Returns false if input was exhausted.
    const consume = (ch: number): boolean => {
        while (i < n && infBuffer[i] === ch) {
            ++i;
        }

        return i < n;
    };

    // consume chars until ch encountered (return true), or eof (return
    // false).s
    const consumeUntil = (ch: number): boolean => {
        while (i < n && infBuffer[i] !== ch) {
            ++i;
        }

        return i < n;
    };

    const getExtra = (): IExtraData => {
        if (extra === undefined) {
            extra = { opt: undefined, title: undefined, dirTitle: undefined, };
        }

        return extra;
    };

    i = 0;
    // skip any leading spaces.
    if (!consume(SPACE_CHAR)) {
        log?.pn(' - line is empty');
        return undefined;
    }

    // Pull out quoted or unquoted name.
    let name: string;
    if (infBuffer[i] === QUOTE_CHAR) {
        ++i;
        if (i >= n) {
            log?.pn(' - quoted name is empty');
            return undefined;
        }

        const begin = i;
        while (i < n && infBuffer[i] !== QUOTE_CHAR) {
            ++i;
        }

        if (i >= n) {
            log?.pn(' - missing terminating "');
            return undefined;
        }

        name = infBuffer.toString('binary', begin, i);
        ++i;//skip the terminating quotes
    } else {
        const begin = i;
        consumeUntil(SPACE_CHAR);
        name = infBuffer.toString('binary', begin, i);
    }

    if (!consume(SPACE_CHAR)) {
        log?.pn(' - missing load address');
        return undefined;
    }

    const loadBegin = i;
    consumeUntil(SPACE_CHAR);
    const load = tryParseAddress(infBuffer.toString('binary', loadBegin, i));
    if (load === undefined) {
        log?.pn(' - invalid load address');
        return undefined;
    }

    if (!consume(SPACE_CHAR)) {
        log?.pn(' - missing exec address');
        return undefined;
    }

    const execBegin = i;
    consumeUntil(SPACE_CHAR);
    const exec = tryParseAddress(infBuffer.toString('binary', execBegin, i));
    if (exec === undefined) {
        log?.pn(' - invalid exec address');
        return undefined;
    }

    if (!consume(SPACE_CHAR)) {
        // BeebLink/TubeHost-style non-standard .INF file with no
        // attributes.
        log?.p(` (non-std)`);
        return { name, serverPath, load, exec, attr: beebfs.DEFAULT_ATTR, noINF, extra };
    }

    const attrsOrLengthBegin = i;
    consumeUntil(SPACE_CHAR);

    const attrsOrLength = infBuffer.toString('binary', attrsOrLengthBegin, i);
    if (DFS_LOCKED_ATTRS_LC.indexOf(attrsOrLength.toLowerCase()) >= 0) {
        // BeebLink/TubeHost-style non-standard .INF file with locked
        // attributes.
        log?.p(` (non-std+locked)`);
        return { name, serverPath, load, exec, attr: beebfs.DFS_LOCKED_ATTR, noINF, extra };
    }

    // The length is ignored, but it does have to be valid.
    if (tryParseHexNumber(attrsOrLength) === undefined) {
        log?.pn(' - invalid length');
        return undefined;
    }

    if (!consume(SPACE_CHAR)) {
        // No attributes or extra info.
        log?.p(` (std)`);
        return { name, serverPath, load, exec, attr: beebfs.DEFAULT_ATTR, noINF, extra };
    }

    const attrsBegin = i;
    consumeUntil(SPACE_CHAR);
    const attrString = infBuffer.toString('binary', attrsBegin, i);
    let attr: beebfs.FileAttributes = parseInt(attrString, 16) as beebfs.FileAttributes;
    if (Number.isNaN(attr)) {
        let attrNumber = 0;
        while (i < n && infBuffer[i] !== 32) {
            if (infBuffer[i] < ATTR_CHARS_MAP.length) {
                const attrMask = ATTR_CHARS_MAP[infBuffer[i]];
                if (attrMask === undefined) {
                    log?.pn(` - invalid attr char ${infBuffer[i]}`);
                    return undefined;
                }

                attrNumber |= attrMask;
            }
            ++i;
        }

        attr = attrNumber as beebfs.FileAttributes;
    }

    while (consume(SPACE_CHAR)) {
        const keyBegin = i;
        if (!consumeUntil(EQUALS_CHAR)) {
            log?.pn(' - \'=\' not found');
            return undefined;
        }

        const key = infBuffer.toString('binary', keyBegin, i);

        ++i;//skip the =

        let value: string;
        if (i >= n) {
            // Empty attribute at end of file
            value = '';
        } else {
            if (infBuffer[i] === QUOTE_CHAR) {
                ++i;//skip the quotes
                const valueBegin = i;
                if (!consumeUntil(QUOTE_CHAR)) {
                    log?.pn(' - unterminated quoted value');
                    return undefined;
                }
                value = infBuffer.toString('binary', valueBegin, i);
                ++i;//skip the quotes
            } else {
                const valueBegin = i;
                consumeUntil(SPACE_CHAR);
                value = infBuffer.toString('binary', valueBegin, i);
            }
        }

        if (key === 'DIRTITLE') {
            getExtra().dirTitle = value;
        } else if (key === 'TITLE') {
            getExtra().title = value;
        } else if (key === 'OPT') {
            const opt = parseInt(value);
            if (Number.isNaN(opt)) {
                log?.pn(' - invalid OPT= value');
                return undefined;
            }
            getExtra().opt = opt;
        } else {
            // For now, all other extra info keys are ignored.
        }
    }

    return { serverPath, name, load, exec, attr, noINF, extra };
}

function tryParse(
    infBuffer: Buffer | undefined,
    serverPath: string,
    serverName: string,
    log: utils.Log | undefined): IINF | undefined {

    const inf = tryParse2(infBuffer, serverPath, serverName, log);
    if (inf !== undefined && log !== undefined) {

        log.p(` - name=\`\`${inf.name}'' load=0x${inf.load.toString(16)} exec=0x${inf.exec.toString(16)} attr=0x${inf.attr.toString(16)}`);

        if (inf.extra !== undefined) {
            log.p(` (Extra info:`);

            if (inf.extra.opt !== undefined) {
                log.p(` opt=${inf.extra.opt}`);
            }

            if (inf.extra.title !== undefined) {
                log.p(` title="${inf.extra.title}"`);
            }

            if (inf.extra.dirTitle !== undefined) {
                log.p(` dirTitle="${inf.extra.dirTitle}"`);
            }

            log.p(`)`);
        }

        log.p(`\n`);
    }

    return inf;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Find all .inf files in the given folder, call tryParse as
// appropriate, and return an array of the results.
export async function getINFsForFolder(serverFolderPath: string, log: utils.Log | undefined): Promise<IINF[]> {
    let serverNames: string[];
    try {
        serverNames = await utils.fsReaddir(serverFolderPath);
    } catch (error) {
        return [];
    }

    const beebFileInfos: IINF[] = [];

    log?.pn('getINFsForFolder:');
    log?.in(`    `);
    log?.pn(`folder path: ${serverFolderPath}`);
    log?.pn(`.inf regexp: ${extRegExp.source}`);

    for (const serverName of serverNames) {
        if (extRegExp.exec(serverName) !== null) {
            // skip .inf files.
            continue;
        }

        const serverPath = path.join(serverFolderPath, serverName);

        const infBuffer = await utils.tryReadFile(`${serverPath}${ext}`);
        if (serverName[0] === '.' && infBuffer === undefined) {
            // skip server dotfiles that aren't obviously intended to be Beeb
            // files.
            continue;
        }

        log?.p(`${serverName}: `);
        const beebFileInfo = tryParse(infBuffer, serverPath, serverName, log);
        if (beebFileInfo === undefined) {
            continue;
        }

        beebFileInfos.push(beebFileInfo);
    }

    log?.out();

    return beebFileInfos;
}

