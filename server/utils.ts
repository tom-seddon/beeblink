//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
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

import * as fs from 'fs';
import * as util from 'util';
import * as os from 'os';
import { WriteStream } from 'tty';
import * as path from 'path';
import { Chalk } from 'chalk';

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

const fsWriteFileInternal = util.promisify(fs.writeFile);

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export async function fsWriteFile(name: string, data: any): Promise<void> {
    try {
        await fsMkdir(path.dirname(name));
    } catch (error) {
        // just ignore... if it's a problem, fsWriteFileInternal will throw.
    }

    await fsWriteFileInternal(name, data);
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

    public getLength() {
        return this.bytes.length;
    }

    public writeUInt8(...values: number[]) {
        for (const value of values) {
            this.bytes.push(value);
        }
    }

    public writeUInt32LE(value: number) {
        this.writeUInt8((value >> 0) & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
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

export class Log {
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

    public dumpBuffer(data: Buffer) {
        const numColumns = 16;

        if (data.length === 0) {
            this.p('no data');
        } else {
            for (let i = 0; i < data.length; i += numColumns) {
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
        }
    }

    private putchar(c: string, translateCR: boolean) {
        let print = true;

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

export function isalnum(c: string) {
    return c >= '0' && c <= '9' || isalpha(c);
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////

export function isalpha(c: string) {
    return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z';
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

export async function saveJSON(filePath: string, obj: any): Promise<void> {
    try {
        await fsWriteFile(filePath, JSON.stringify(obj));
    } catch (error) {
        process.stderr.write('WARNING: failed to save JSON to ``' + filePath + '\'\': ' + error + '\n');
    }
}

/////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////
