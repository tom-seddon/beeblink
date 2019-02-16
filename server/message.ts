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

import * as utils from './utils';

export class Message {
    public readonly c: number;
    public readonly p: Buffer;

    protected constructor(c: number, p: Buffer) {
        this.c = c;
        this.p = p;
    }

    protected toStringHelper(cName: string): string {
        let s = 'c=' + cName + ' p=[';

        let i = 0;
        while (i < 5 && i < this.p.length) {
            if (i > 0) {
                s += ' ';
            }

            s += utils.hex2(this.p[i]);
            ++i;
        }

        if (i < this.p.length) {
            s += '...';
        }

        s += ']';

        return s;
    }
}
