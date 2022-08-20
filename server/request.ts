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

import Message from './Message';
import * as utils from './utils';
import * as beeblink from './beeblink';

export default class Request extends Message {
    public constructor(c: number, p: Buffer) {
        super(c, p);
    }

    public toString(): string {
        return this.toStringHelper(utils.getRequestTypeName(this.c));
    }

    public isFireAndForget(): boolean {
        return this.c >= beeblink.FNF_REQUESTS_BEGIN && this.c < beeblink.FNF_REQUESTS_END;
    }
}
