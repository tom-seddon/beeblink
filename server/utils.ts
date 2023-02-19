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

import * as fs from 'fs';
import * as util from 'util';
import * as os from 'os';
import * as path from 'path';
import { Chalk } from 'chalk';
import * as beeblink from './beeblink';
import * as errors from './errors';
import * as inf from './inf';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export const BNL = '\r\n';

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export const fsStat = util.promisify(fs.stat);
export const fsReadFile = util.promisify(fs.readFile);
export const fsReaddir = util.promisify(fs.readdir);
export const fsUnlink = util.promisify(fs.unlink);
export const fsTruncate = util.promisify(fs.truncate);
export const fsOpen = util.promisify(fs.open);
export const fsClose = util.promisify(fs.close);
export const fsRead = util.promisify(fs.read);
export const fsRename = util.promisify(fs.rename);
export const fsMkdir = util.promisify(fs.mkdir);
export const fsExists = util.promisify(fs.exists);
export const fsWriteFile = util.promisify(fs.writeFile);

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export async function fsMkdirAndWriteFile(name: string, data: any): Promise<void> {
    try {
        await fsMkdir(path.dirname(name), { recursive: true });
    } catch (error) {
        // just ignore... if it's a problem, fsWriteFile will throw.
    }

    await fsWriteFile(name, data);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export async function forceFsUnlink(filePath: string) {
    try {
        await fsUnlink(filePath);
    } catch (error) {
        const e = error as NodeJS.ErrnoException;

        if (e.code === 'ENOENT') {
            // Ignore.
        } else {
            throw error;
        }
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// The Buffer API is rather annoying.
export class BufferBuilder {
    private bytes: number[] = [];
    private address: number | undefined;

    public constructor(address?: number) {
        this.address = address;
    }

    public getNextAddress() {
        if (this.address === undefined) {
            throw new Error('no address set');
        }

        return this.address + this.getLength();
    }

    public getLength() {
        return this.bytes.length;
    }

    public writeUInt8(...values: number[]): number {
        const offset = this.bytes.length;

        for (const value of values) {
            this.bytes.push(value);
        }

        return offset;
    }

    public setUInt8(value: number, offset: number): void {
        this.bytes[offset] = value;
    }

    public setUInt16LE(value: number, offset: number): void {
        this.bytes[offset + 0] = (value >> 0) & 0xff;
        this.bytes[offset + 1] = (value >> 8) & 0xff;
    }

    public writeUInt16LE(value: number): number {
        const offset = this.bytes.length;

        this.writeUInt8((value >> 0) & 0xff, (value >> 8) & 0xff);

        return offset;
    }

    public setUInt32LE(value: number, offset: number): void {
        this.bytes[offset + 0] = (value >> 0) & 0xff;
        this.bytes[offset + 1] = (value >> 8) & 0xff;
        this.bytes[offset + 2] = (value >> 16) & 0xff;
        this.bytes[offset + 3] = (value >> 24) & 0xff;
    }

    public maybeSetUInt32LE(value: number, offset: number | undefined): void {
        if (offset !== undefined) {
            this.setUInt32LE(value, offset);
        }
    }

    public writeUInt32LE(value: number): number {
        const offset = this.bytes.length;

        this.writeUInt8((value >> 0) & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);

        return offset;
    }

    public writeBuffer(bytes: Buffer | BufferBuilder) {
        if (bytes instanceof Buffer) {
            for (const byte of bytes) {
                this.writeUInt8(byte);
            }
        } else if (bytes instanceof BufferBuilder) {
            this.bytes = this.bytes.concat(bytes.bytes);
        }
    }

    public writeString(str: string) {
        this.writeBuffer(Buffer.from(str, 'binary'));
    }

    // if the string is longer than 255, it will be truncated at 255 characters.
    public writePascalString(str: string) {
        const buffer = Buffer.from(str, 'binary');

        let length = buffer.length;
        if (length > 255) {
            length = 255;
        }

        this.writeUInt8(length);
        for (let i = 0; i < length; ++i) {
            this.writeUInt8(buffer[i]);
        }
    }

    public createBuffer(): Buffer {
        return Buffer.from(this.bytes);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class BufferReader {
    private buffer: Buffer;
    private offset = 0;

    public constructor(buffer: Buffer) {
        this.buffer = buffer;
    }

    public readUInt8(): number {
        this.prepareForRead(1);
        return this.buffer[this.offset - 1];
    }

    public readUInt16LE(): number {
        this.prepareForRead(2);
        return this.buffer.readUInt16LE(this.offset - 2);
    }

    public readUInt32LE(): number {
        this.prepareForRead(4);
        return this.buffer.readUInt32LE(this.offset - 4);
    }

    public readString(terminator: number): string {
        let str = '';

        while (this.offset < this.buffer.length && this.buffer[this.offset] !== terminator) {
            str += String.fromCharCode(this.buffer[this.offset]);
            ++this.offset;
        }

        if (this.offset === this.buffer.length) {
            return errors.generic('Bad request');
        } else {
            ++this.offset;
        }

        return str;
    }

    public readBuffer(): Buffer {
        const buffer = Buffer.alloc(this.buffer.length - this.offset);

        this.buffer.copy(buffer, 0, this.offset);

        this.offset = this.buffer.length;

        return buffer;
    }

    private prepareForRead(n: number): void {
        if (this.offset + n >= this.buffer.length) {
            return errors.generic('Bad request');
        }

        this.offset += n;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export class Log {
    // In general, logs can't be enabled or disabled at runtime. So if the log
    // isn't enabled, it's simply not created.
    public static create(prefix: string, f: { write(buffer: Buffer | string, cb?: () => void): boolean } | undefined, enabled: boolean = true) {
        if (enabled) {
            return new Log(prefix, f, enabled);
        } else {
            return undefined;
        }
    }

    public static isEnabled(log: Log | undefined): boolean {
        if (log !== undefined) {
            return log.enabled;
        } else {
            return false;
        }
    }

    public static setEnabled(log: Log | undefined, enabled: boolean): void {
        if (log !== undefined) {
            log.enabled = enabled;
        }
    }

    public enabled: boolean;
    public f: { write(buffer: Buffer | string, cb?: () => void): boolean } | undefined;
    public colours: Chalk | undefined;

    private prefix: string;
    private indent: number;
    private indentStack: number[];
    //private bol: boolean;
    private column: number;
    private blankPrefix: boolean;
    private buffer: string;

    public constructor(prefix: string, f: { write(buffer: Buffer | string, cb?: () => void): boolean } | undefined, enabled: boolean = true) {
        this.f = f;
        this.prefix = prefix;
        this.indentStack = [];
        this.indent = 0;
        //this.bol = true;
        this.column = 0;
        this.enabled = enabled;
        this.buffer = '';
        this.blankPrefix = false;
    }

    public in(x: string) {
        this.p(x);
        this.pushAbsoluteIndent(this.column);
    }

    public out() {
        if (this.indentStack.length > 0) {
            const newIndent = this.indentStack.pop();
            if (newIndent !== undefined) {
                this.indent = newIndent;
            }
        }
    }

    public withEnabled(fun: () => void) {
        const enabled = this.enabled;
        this.enabled = true;
        fun();
        this.enabled = enabled;
    }

    // Not suitable for promises, as the finally clause will be run the first
    // time `fun' does an await.
    public withIndent<T>(prefix: string, fun: () => T): T {
        this.in(prefix);
        try {
            return fun();
        } finally {
            this.out();
        }
    }

    // Not suitable for promises, as the finally clause will be run the first
    // time `fun' does an await.
    public withNoIndent<T>(fun: () => T): T {
        this.pushAbsoluteIndent(0);
        try {
            return fun();
        } finally {
            this.out();
        }
    }

    public ensureBOL() {
        if (!this.isAtBOL()) {
            this.p('\n');
        }
    }

    public p(x: string) {
        for (const c of x) {
            this.putchar(c, false);
        }
    }

    public pn(x: string) {
        this.p(x);
        this.p('\n');
    }

    public bp(x: string) {
        for (const c of x) {
            this.putchar(c, true);
        }
    }

    public bpn(x: string) {
        this.bp(x);
        this.p('\n');
    }

    public dumpBuffer(data: Buffer, maxNumLines?: number): void {
        if (!this.enabled) {
            // this function does enough stuff that it's probably worth
            // skipping...
            return;
        }

        const numColumns = 16;

        if (data.length === 0) {
            this.pn('00000000: (no data)');
        } else {
            const numLines = Math.floor((data.length + numColumns - 1) / numColumns);
            if (maxNumLines !== undefined && numLines > maxNumLines) {
                const n = Math.floor(maxNumLines) / 2;
                for (let i = 0; i < n; ++i) {
                    this.dumpBufferLine(data, i * numColumns, numColumns);
                }
                this.pn('   (...' + ((numLines - n * 2) * numColumns) + ' bytes elided...)');
                for (let i = numLines - n; i < numLines; ++i) {
                    this.dumpBufferLine(data, i * numColumns, numColumns);
                }
            } else {
                for (let i = 0; i < numLines; ++i) {
                    this.dumpBufferLine(data, i * numColumns, numColumns);
                }
            }
        }
    }

    private dumpBufferLine(data: Buffer, i: number, numColumns: number): void {
        this.p(hex8(i));
        this.p(':');

        for (let j = 0; j < numColumns; ++j) {
            this.p(' ');
            if (i + j < data.length) {
                this.p(hex2(data[i + j]));
            } else {
                this.p('**');
            }
        }

        this.p('  ');

        for (let j = 0; j < numColumns; ++j) {
            if (i + j < data.length) {
                const c = data[i + j];
                if (c >= 32 && c < 127) {
                    this.p(String.fromCharCode(c));
                } else {
                    this.p('.');
                }
            } else {
                this.p(' ');
            }
        }

        this.p('\n');
    }

    private putchar(c: string, translateCR: boolean) {
        if (translateCR) {
            if (c === '\r') {
                c = '\n';
            }
        }

        if (c === '\n' || c === '\r') {
            this.flushBuffer(c);
        } else {
            if (c === '\t' && this.buffer.length === 0) {
                this.blankPrefix = true;
            } else {
                if (this.buffer.length === 0) {
                    for (let i = 0; i < this.indent; ++i) {
                        this.buffer += ' ';
                    }

                    this.column += this.indent;
                }

                this.buffer += c;
                ++this.column;
            }
        }
    }

    private isAtBOL() {
        return this.column === 0;
    }

    private resetBuffer() {
        this.buffer = '';
        this.blankPrefix = false;
        this.column = 0;
    }

    private flushBuffer(nl: string) {
        if (this.enabled && this.f !== undefined) {
            let output = '';

            if (this.blankPrefix) {
                output += ''.padStart(this.prefix.length + 2, ' ');
            } else if (this.prefix.length > 0) {
                output += this.prefix + ': ';
            }

            if (this.colours === undefined) {
                output += this.buffer;
            } else {
                output += this.colours(this.buffer);
            }

            output += nl;

            this.f.write(output);
        }

        this.resetBuffer();
    }

    private pushAbsoluteIndent(indent: number) {
        this.indentStack.push(this.indent);
        this.indent = indent;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function hex(n: number, width: number): string {
    return n.toString(16).padStart(width, '0');
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function hex2(n: number): string {
    return hex(n, 2);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function hex4(n: number): string {
    return hex(n, 4);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function hex8(n: number): string {
    return hex(n, 8);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function hexdec(n: number): string {
    return n.toString(10) + ' (0x' + n.toString(16) + ')';
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function hexdecch(n: number): string {
    if (n >= 32 && n < 127) {
        return hexdec(n) + '(\'' + String.fromCharCode(n) + '\')';
    } else {
        return hexdec(n);
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function getTildeExpanded(pathString: string): string {
    // yes, only with a forward slash...
    if (pathString.startsWith('~/')) {
        pathString = os.homedir() + pathString.slice(1);
    }

    return pathString;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

const CHAR0 = '0'.charCodeAt(0);
const CHAR9 = '9'.charCodeAt(0);
const CHARA = 'A'.charCodeAt(0);
const CHARZ = 'Z'.charCodeAt(0);
const CHARa = 'a'.charCodeAt(0);
const CHARz = 'z'.charCodeAt(0);

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function isdigitchar(char: number): boolean {
    return char >= CHAR0 && char <= CHAR9;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function isalphachar(char: number): boolean {
    return char >= CHARA && char <= CHARZ || char >= CHARa && char <= CHARz;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function isalnumchar(char: number): boolean {
    return isdigitchar(char) || isalphachar(char);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function isdigit(c: string): boolean {
    for (let i = 0; i < c.length; ++i) {
        if (!isdigitchar(c.charCodeAt(i))) {
            return false;
        }
    }

    return true;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function isalpha(c: string): boolean {
    for (let i = 0; i < c.length; ++i) {
        if (!isalphachar(c.charCodeAt(i))) {
            return false;
        }
    }

    return true;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function isalnum(c: string): boolean {
    for (let i = 0; i < c.length; ++i) {
        if (!isalnumchar(c.charCodeAt(i))) {
            return false;
        }
    }

    return true;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function strieq(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function stricmp(a: string, b: string): number {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();

    if (al < bl) {
        return -1;
    } else if (al > bl) {
        return 1;
    } else {
        return 0;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export async function tryReadFile(filePath: string): Promise<Buffer | undefined> {
    try {
        return await fsReadFile(filePath);
    } catch (error) {
        return undefined;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export async function tryStat(filePath: string): Promise<fs.Stats | undefined> {
    try {
        return await fsStat(filePath);
    } catch (error) {
        return undefined;
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export async function isFolder(folderPath: string): Promise<boolean> {
    const stat = await tryStat(folderPath);
    if (stat === undefined) {
        return false;
    }

    if (!stat.isDirectory()) {
        return false;
    }

    return true;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export async function saveJSON(filePath: string, obj: any): Promise<void> {
    try {
        await fsWriteFile(filePath, JSON.stringify(obj));
    } catch (error) {
        process.stderr.write('WARNING: failed to save JSON to ``' + filePath + '\'\': ' + error + '\n');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function splitTextFileLines(b: Buffer, encoding: BufferEncoding): string[] {
    const lines = [];
    let i = 0;
    let j = 0;
    while (j < b.length) {
        if (b[j] === 10 || b[j] === 13) {
            lines.push(b.toString(encoding, i, j));

            ++j;
            if (j < b.length && (b[j] === 10 || b[j] === 13) && b[j] !== b[j - 1]) {
                ++j;
            }

            i = j;
        } else {
            j++;
        }
    }

    if (i !== j) {
        lines.push(b.toString(encoding, i, j));
    }

    return lines;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function isBASIC(b: Buffer): boolean {
    let i = 0;

    while (true) {
        if (i >= b.length) {
            // Hit EOF before end of program marker.
            return false;
        }

        if (b[i] !== 0x0d) {
            // Invalid program structure.
            return false;
        }

        if (i + 1 >= b.length) {
            // Line past EOF.
            return false;
        }

        if (b[i + 1] === 0xff) {
            // End of program marker - program is valid.
            return true;
        }

        if (i + 3 >= b.length) {
            // Line header past EOF.
            return false;
        }

        if (b[i + 3] === 0) {
            // Invalid line length.
            return false;
        }

        // Skip line.
        i += b[i + 3];
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export const MATCH_N_CHAR = '*';
export const MATCH_ONE_CHAR = '#';

export function isAmbiguousAFSP(afsp: string): boolean {
    if (afsp.includes(MATCH_N_CHAR)) {
        return true;
    }

    if (afsp.includes(MATCH_ONE_CHAR)) {
        return true;
    }

    return false;
}

// The regexp is actually a bit cleverer than the afsp, at least compared to
// how DFS does it, in that a * will match chars in the middle of a string,
// not just at the end.
export function getRegExpFromAFSP(afsp: string): RegExp {
    let r = '^';

    for (const c of afsp) {
        if (c === MATCH_N_CHAR) {
            r += '.*';
        } else if (c === MATCH_ONE_CHAR) {
            r += '.';
        } else if (isalnum(c)) {
            r += c;
        } else {
            r += '\\' + c;
        }
    }

    r += '$';

    return new RegExp(r, 'i');
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

function getBeebLinkConstantsByPrefix(prefix: string): Map<number, string> {
    const map = new Map<number, string>();

    for (const kv of Object.entries(beeblink)) {
        //tslint:disable-next-line strict-type-predicates
        if (kv[0].startsWith(prefix) && typeof (kv[1]) === 'number') {
            // if there's already an entry for this value, don't overwrite it.
            // This is a bodge to handle response sub-types, which have the same
            // prefix as the main types, but (fortunately...) come later in the
            // list.
            //
            // Should really do better...
            if (!map.has(kv[1])) {
                map.set(kv[1], kv[0]);
            }
        }
    }

    return map;
}

const gRequestTypeNames = getBeebLinkConstantsByPrefix('REQUEST_');
const gResponseTypeNames = getBeebLinkConstantsByPrefix('RESPONSE_');

function getRequestOrResponseTypeName(map: Map<number, string>, c: number): string {
    let name = map.get(c);

    if (name === undefined) {
        name = '0x' + hex2(c);
    }

    return name;
}

export function getRequestTypeName(c: number): string {
    return getRequestOrResponseTypeName(gRequestTypeNames, c);
}

export function getResponseTypeName(c: number): string {
    return getRequestOrResponseTypeName(gResponseTypeNames, c);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function readUInt24LE(buffer: Buffer, index: number): number {
    return buffer[index] << 0 | buffer[index + 1] << 8 | buffer[index + 2] << 16;
}

export function writeUInt24LE(buffer: Buffer, value: number, index: number): void {
    buffer[index + 0] = (value >> 0) & 0xff;
    buffer[index + 1] = (value >> 8) & 0xff;
    buffer[index + 2] = (value >> 16) & 0xff;
}

export function readUInt24BE(buffer: Buffer, index: number): number {
    return buffer[index] << 16 | buffer[index + 1] << 8 | buffer[index + 2] << 0;
}

export function writeUInt24BE(buffer: Buffer, value: number, index: number): void {
    buffer[index + 0] = (value >> 16) & 0xff;
    buffer[index + 1] = (value >> 8) & 0xff;
    buffer[index + 2] = (value >> 0) & 0xff;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Like Number.parseInt(x,16), but barfs if there are any non-hex chars.
export function parseHex(s: string): number {
    if (s.match('^[0-9A-Fa-f]+$') === null) {
        return NaN;
    }

    return Number.parseInt(s, 16);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Scrappy path normalization stuff.

export const getCaseNormalizedPath = process.platform === 'darwin' || process.platform === 'win32' ? (x: string) => x.toLowerCase() : (x: string) => x;
export const getSeparatorAndCaseNormalizedPath = process.platform === 'win32' ? (x: string) => getCaseNormalizedPath(x).replace('\\', '/') : getCaseNormalizedPath;

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

// Get contents of first line of an 8-bit text file.
export function getFirstLine(b: Buffer): string {
    let i;

    for (i = 0; i < b.length; ++i) {
        const x = b[i];
        if (x === 10 || x === 13 || x === 26) {
            break;
        }
    }

    return b.toString('binary', 0, i).trim();
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
    if (await fsExists(hostPath) || await fsExists(hostPath + inf.ext)) {
        return errors.exists('Exists on server');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function getDateString(d: Date): string {
    const year = d.getFullYear();

    function d2(n: number): string {
        return `${Math.floor(n / 10) % 10}${(n | 0) % 10}`;
    }

    return `${d2(year / 100)}${d2(year)}-${d2(1 + d.getMonth())}-${d2(1 + d.getDate())} ${d2(d.getHours())}:${d2(d.getMinutes())}:${d2(d.getSeconds())}`;
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function getBASICStringExpr(text: Buffer): string {
    let quotes = false;
    let r = '';

    for (let i = 0; i < text.length; ++i) {
        const v = text[i];
        if (v >= 32 && v < 126) {
            if (!quotes) {
                if (i > 0) {
                    r += '+';
                }

                r += '"';
                quotes = true;
            }

            const ch = String.fromCharCode(text[i]);
            if (ch === '"') {
                r += '"';
            }

            r += ch;
        } else {
            if (quotes) {
                r += '"+';
                quotes = false;
            } else if (i > 0) {
                r += '+';
            }

            r += 'CHR$(' + v + ')';
        }
    }

    if (quotes) {
        r += '"';
    }

    return r;
}

