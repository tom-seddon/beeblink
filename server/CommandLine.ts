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

import * as errors from './errors';

// Server-side string parsing, a bit like GSINIT/GSREAD.
//
// The precise logic for this stuff eluded me, so I just threw together this
// mishmash of nonsense that kind of does roughly the same thing as the DFS.

export default class CommandLine {
    public readonly parts: string[];
    private part: string | undefined;
    private partOffset: number | undefined;
    private y: number;

    public constructor(str: string) {
        let i = 0;
        let quotes = false;
        let mask = 0;

        this.parts = [];
        this.y = -1;

        while (i < str.length) {
            const offset = i;

            if (str[i] === '|') {
                this.gotChar(offset);
                ++i;
                if (i >= str.length) {
                    return errors.badString();
                }

                let ch: number | undefined;
                if (str[i] === '!') {
                    ++i;
                    mask = 0x80;
                } else {
                    ch = str.charCodeAt(i);
                    ++i;

                    if (ch < 32) {
                        return errors.badString();
                    } else if (ch === 0x3f) {
                        ch = 0x7f;//"|?"
                    } else if (ch >= 0x40 && ch <= 0x5f || ch >= 0x61 && ch <= 0x7b || ch === 0x7d || ch === 0x7e) {
                        ch &= 0x1f;
                    } else if (ch === 0x60) {
                        ch = 31;
                    } else if (ch >= 0x80) {
                        ch ^= 0x20;
                    } else {
                        // ch >= 32 && ch < 0x3f || ch === 0x7c ("|") || ch == 0x7f - pass through
                    }
                }

                if (ch !== undefined) {
                    this.addToPart(offset, String.fromCharCode(ch | mask));
                    mask = 0;
                }
            } else {
                let ch = str.charCodeAt(i);
                ch |= mask;
                mask = 0;

                if (ch === '"'.charCodeAt(0)) {
                    ++i;
                    if (quotes) {
                        if (i < str.length && str[i + 1] === '"') {
                            this.addToPart(offset, '"');
                            ++i;
                        } else {
                            quotes = false;

                            if (this.part === undefined) {
                                // Handle "".
                                this.part = '';
                            }

                            this.addPart();
                        }
                    } else {
                        this.addPart();
                        quotes = true;
                        this.gotChar(offset);
                    }
                } else if (ch === 32) {
                    ++i;
                    if (quotes) {
                        this.addToPart(offset, ' ');
                    } else {
                        this.addPart();
                    }
                } else {
                    ++i;
                    this.addToPart(offset, String.fromCharCode(ch));
                }
            }
        }

        if (quotes) {
            return errors.badString();
        }

        this.addPart();

        if (this.y < 0) {
            this.y = str.length;
        }
    }

    public getY(): number {
        return this.y;
    }

    private gotChar(offset: number) {
        if (this.partOffset === undefined) {
            this.partOffset = offset;
        }
    }

    private addToPart(offset: number, ch: string) {
        if (this.part === undefined) {
            this.gotChar(offset);
            this.part = '';
        }

        this.part += ch;
    }

    private addPart() {
        if (this.part !== undefined) {
            this.parts.push(this.part);

            if (this.parts.length === 2) {
                this.y = this.partOffset!;
            }

            this.part = undefined;
            this.partOffset = undefined;
        }
    }
}

