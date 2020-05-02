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

import * as utils from './utils';
import * as inf from './inf';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export class BeebError extends Error {
    public readonly code: number;
    public readonly text: string;

    public constructor(code: number, text: string) {
        super(text + ' (' + code + ')');

        this.code = code;
        this.text = text;
    }

    public toString() {
        return this.message;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function createErrorFactory(code: number, defaultMessage: string): (message?: string) => never {
    return (message?: string): never => {
        throw new BeebError(code, message === undefined ? defaultMessage : message);
    };
}

export const tooManyOpen = createErrorFactory(192, 'Too many open');
export const readOnly = createErrorFactory(193, 'Read only');
export const open = createErrorFactory(194, 'Open');
export const locked = createErrorFactory(195, 'Locked');
export const exists = createErrorFactory(196, 'Exists');
export const tooBig = createErrorFactory(198, 'Too big');
export const discFault = createErrorFactory(199, 'Disc fault');
export const volumeReadOnly = createErrorFactory(201, 'Volume read only');
export const badName = createErrorFactory(204, 'Bad name');
export const badDrive = createErrorFactory(205, 'Bad drive');
export const badDir = createErrorFactory(206, 'Bad dir');
export const badAttribute = createErrorFactory(207, 'Bad attribute');
export const fileNotFound = createErrorFactory(214, 'File not found');
// Empty message for 220 directs the server to create a suitable one
// automatically.
export const syntax = createErrorFactory(220, '');
export const channel = createErrorFactory(222, 'Channel');
export const eof = createErrorFactory(223, 'EOF');
export const badString = createErrorFactory(253, 'Bad string');
export const badCommand = createErrorFactory(254, 'Bad command');
export const dataLost = createErrorFactory(0xca, 'Data lost');
export const wont = createErrorFactory(0x93, 'Won\'t');

// Message is mandatory for generic errors.
//
// All reuse the Disc fault code.
export function generic(message: string): never {
    throw new BeebError(199, message);
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// Try (if not very hard) to translate POSIX-style Node errors into
// something that makes more sense for the Beeb.
export function nodeError(error: NodeJS.ErrnoException): never {
    if (error.code === 'ENOENT') {
        return fileNotFound();
    } else {
        return discFault(`POSIX error: ${error.code}`);
    }
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
    if (await utils.fsExists(hostPath) || await utils.fsExists(hostPath + inf.ext)) {
        return exists('Exists on server');
    }
}

