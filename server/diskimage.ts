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

import * as errors from './errors';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// Represents a disk low-level read/write OSWORD.
export interface IDiskOSWORD {
    // Reason code - 0x72 (ADFS) or 0x7f (DFS).
    reason: 0x72 | 0x7f;

    // Parameter block, as-is.
    //
    // This is treated as opaque, except for the dword at +1: the 32-bit BBC
    // address for the data. This just happens (fortunately) to be in the same
    // place for ADFS and DFS.
    block: Buffer;

    // If undefined, this is a read operation; otherwise, this is a write
    // operation, and this is the data to write.
    data: Buffer | undefined;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// Get transfer size for a disk OSWORD. 256-byte sectors are assumed.
//
// If a write operation, it's possible for the data to be a different size from
// the transfer size in the parameter block. Don't do that.
export function getDiskOSWORDTransferSizeBytes(o: IDiskOSWORD): number {
    if (o.data !== undefined) {
        return o.data.length;
    }

    switch (o.reason) {
        case 0x72:
            return o.block.readUInt8(9) * 256;

        case 0x7f:
            return (o.block.readUInt8(9) & 31) * 256;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// Get parameter block error byte offset for disk OSWORD.
export function getDiskOSWORDErrorOffset(o: IDiskOSWORD): number {
    switch (o.reason) {
        case 0x72:
            return 0;

        case 0x7f:
            return 10;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// Get parameter block address dword offset for disk OSWORD.
export function getDiskOSWORDAddressOffset(_o: IDiskOSWORD): number {
    return 1;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// Object representing a response to the REQUEST_START_DISK_IMAGE_FLOW request.
export interface IStartFlow {
    // FS to select, or 0 for none.
    fs: number;

    // * command to use to select filing system.
    fsStarCommand: string;

    // * command to execute once filing system selected.
    starCommand: string;

    // Max 2 disk OSWORDs to execute. Must be reads.
    osword1: IDiskOSWORD | undefined;
    osword2: IDiskOSWORD | undefined;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// Object representing a response to the REQUEST_NEXT_DISK_IMAGE_PART request.
export interface IPart {
    // Message to print.
    message: string;

    // OSWORD to execute. If a read, reply payload addr/size will be calculated
    // appropriately.
    osword: IDiskOSWORD;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// Object representing a response to the REQUEST_FINISH_DISK_IMAGE_FLOW request.
export interface IFinishFlow {
    // FS to select, or 0 for none.
    fs: number;

    // * command to use to select filing system.
    fsStarCommand: string;

    // * command to execute once filing system selected.
    starCommand: string;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

// Represents a disk image read/write flow.
export abstract class Flow {
    private bufferAddress: number | undefined;

    public getBufferAddress(): number {
        if (this.bufferAddress === undefined) {
            return errors.generic(`Flow error`);
        }

        return this.bufferAddress;
    }

    protected init(bufferAddress: number, bufferSize: number, minRequired: number): void {
        if (minRequired > bufferSize) {
            // The 40 char limit makes fitting both numbers in a bit tricky, but
            // the actual buffer size is presumably easy enough to determine at
            // the Beeb end.
            return errors.generic(`Buffer too small (need ${minRequired})`);
        }

        this.bufferAddress = bufferAddress;
    }
    
    // Start the flow. Determine buffer address, size and overall feasibility
    // based on supplied OSHWM and HIMEM values, and produce data for response.
    public abstract start(bufferAddress: number, bufferSize: number): IStartFlow;

    // Set catalogue, if reading, as returned by BBC.
    public abstract setCat(cat: Buffer): void;

    // Get next part.
    public abstract getNextPart(): IPart | undefined;

    // Set result of last OSWORD, or just an empty buffer if writing.
    public abstract setLastOSWORDResult(data: Buffer): void;

    // Finish the operation.
    public abstract finish(): Promise<IFinishFlow>;

}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
