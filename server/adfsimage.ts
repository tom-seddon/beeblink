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

import * as utils from './utils';
import * as beebfs from './beebfs';
import * as errors from './errors';
import * as diskimage from './diskimage';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

const TRACK_SIZE_SECTORS = 16;
const SECTOR_SIZE_BYTES = 256;
const TRACK_SIZE_BYTES = TRACK_SIZE_SECTORS * SECTOR_SIZE_BYTES;

// 32 sectors = 8 KB. 8 KB takes about 1 second to transfer with UPURS.
//
// Don't exceed 2 seconds'-worth of data - the drive will spin down.
const MAX_PART_SIZE_SECTORS = 32;

const MAX_PART_SIZE_BYTES = MAX_PART_SIZE_SECTORS * SECTOR_SIZE_BYTES;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

const S_SIZE_BYTES = 1 * 40 * TRACK_SIZE_BYTES;
const M_SIZE_BYTES = 1 * 80 * TRACK_SIZE_BYTES;
const L_SIZE_BYTES = 2 * 80 * TRACK_SIZE_BYTES;

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function checkChecksum(sector: Buffer, index: number): void {
    let sum = 255;

    for (let i = 254; i >= 0; --i) {
        //console.log('i=' + utils.hex2(i) + ', sum=' + utils.hex2(sum) + ', sector[' + i + ']=' + utils.hex2(sector[i]));
        if (sum > 255) {
            sum = (sum + 1) & 0xff;
        }
        sum += sector[i];
        //console.log('sum now=' + utils.hex2(sum));
    }

    if ((sum & 0xff) !== sector[0xff]) {
        return errors.generic('Bad ADFS image (bad map) (' + index + ' ' + utils.hex2(sum) + ' ' + utils.hex2(sector[0xff]) + ')');
    }
}

function getNumSectors(image: Buffer): number {
    return utils.readUInt24LE(image, 0xfc);
}

function getSectorOffset(image: Buffer, logicalSector: number): number {
    if (image.length === L_SIZE_BYTES) {
        let track = Math.floor(logicalSector / TRACK_SIZE_SECTORS);
        const side = Math.floor(track / 80);
        track %= 80;
        const sector = logicalSector % TRACK_SIZE_SECTORS;

        return ((track * 2 + side) * TRACK_SIZE_SECTORS + sector) * SECTOR_SIZE_BYTES;
    } else {
        return logicalSector * SECTOR_SIZE_BYTES;
    }
}

function checkCat(image: Buffer): void {
    checkChecksum(Buffer.from(image, 0 * SECTOR_SIZE_BYTES, SECTOR_SIZE_BYTES), 0);
    checkChecksum(Buffer.from(image, 1 * SECTOR_SIZE_BYTES, SECTOR_SIZE_BYTES), 1);

    if (getNumSectors(image) >= (1 << 21)) {
        return errors.generic(`Bad ADFS image (too many sectors)`);
    }
}

function checkImage(image: Buffer): void {
    if (image.length !== S_SIZE_BYTES && image.length !== M_SIZE_BYTES && image.length !== L_SIZE_BYTES) {
        return errors.generic(`Bad ADFS image (bad size)`);
    }

    checkCat(image);
}

interface ISectors {
    beginSector: number;
    numSectors: number;
}

function getUsedSectors(image: Buffer, maxNumSectors: number, allSectors: boolean): ISectors[] {
    const totalNumSectors = getNumSectors(image);

    const isSectorUsed: boolean[] = [];
    for (let i = 0; i < totalNumSectors; ++i) {
        isSectorUsed.push(true);
    }

    if (!allSectors) {
        for (let i = 0; i < image[0x1fe]; i += 3) {
            const startSector = utils.readUInt24LE(image, 0 * SECTOR_SIZE_BYTES + i);
            const numSectors = utils.readUInt24LE(image, 1 * SECTOR_SIZE_BYTES + i);

            for (let j = 0; j < numSectors; ++j) {
                const sector = startSector + j;
                if (sector >= totalNumSectors) {
                    return errors.generic('Bad ADFS image (invalid free space map)');
                }

                if (!isSectorUsed[sector]) {
                    return errors.generic('Bad ADFS image (free space overlap)');
                }

                isSectorUsed[sector] = false;
            }
        }
    }

    const parts: ISectors[] = [];
    let part: ISectors | undefined;

    for (let i = 0; i < totalNumSectors; ++i) {
        if (isSectorUsed[i]) {
            if (part === undefined) {
                part = { beginSector: i, numSectors: 0 };
                parts.push(part);
            }

            ++part.numSectors;

            if (part.numSectors === maxNumSectors) {
                part = undefined;
            }
        } else {
            part = undefined;
        }
    }

    return parts;
}

// MasRef J.11-13 says (regarding the drive argument for OSWORD $72): "Bits 5-7
// of XY +6 are ORed with the current drive number to give the drive number to
// be accessed. The absolute sector number is a 21-bit value, high order bits
// first."
//
// So set the drive elsewhere. Doesn't matter that it might be mounting a disk
// that's about to be overwritten - the target disk has to be a valid ADFS disk
// anyway.

function createReadOSWORD(sector: number, numSectors: number): diskimage.IDiskOSWORD {
    const block = Buffer.alloc(15);

    block.writeUInt32LE(0xffffffff, 1);//fileld in later.
    block.writeUInt8(0x08, 5);//8 = read
    utils.writeUInt24BE(block, sector & 0x1fffff, 6);
    block.writeUInt8(numSectors, 9);

    return {
        reason: 0x72,
        block,
        data: undefined,
    };
}

function createWriteOSWORD(sector: number, data: Buffer): diskimage.IDiskOSWORD {
    const block = Buffer.alloc(15);

    block.writeUInt32LE(0xffffffff, 1);//fileld in later.
    block.writeUInt8(0x0a, 5);//a = read
    utils.writeUInt24BE(block, sector & 0x1fffff, 6);
    block.writeUInt32LE(data.length, 11);

    return {
        reason: 0x72,
        block,
        data,
    };
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function getMessage(sector: number, numSectorsTransferred: number, numSectorsUsed: number): string {
    return `S${utils.hex(sector, 6).toUpperCase()} (${(numSectorsTransferred / numSectorsUsed * 100.0).toFixed(1)}%)`;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export class WriteFlow extends diskimage.Flow {
    private drive: number;
    private allSectors: boolean;
    private image: Buffer;
    private log: utils.Log | undefined;// tslint:disable-line no-unused-variable
    private parts: ISectors[];
    private numSectorsUsed: number;
    private numSectorsWritten: number;
    private partIdx: number;

    public constructor(drive: number, allSectors: boolean, image: Buffer, log: utils.Log | undefined) {
        super();

        this.drive = drive;
        this.allSectors = allSectors;
        this.image = image;
        this.log = log;

        this.parts = getUsedSectors(this.image, MAX_PART_SIZE_SECTORS, this.allSectors);
        this.partIdx = 0;

        this.numSectorsWritten = 0;

        this.numSectorsUsed = 0;
        for (const part of this.parts) {
            this.numSectorsUsed += part.numSectors;
        }

        checkImage(image);
    }

    public start(bufferAddress: number, bufferSize: number): diskimage.IStartFlow {
        // 8 KB = ~1 second with UPURS. Don't exceed 2 seconds'-worth of data,
        // as the disk will spin down.
        this.init(bufferAddress, bufferSize, 256 + MAX_PART_SIZE_BYTES);

        return {
            fs: 0,
            fsStarCommand: `FADFS`,
            starCommand: `MOUNT ${this.drive}`,
            osword1: createReadOSWORD(0, 2),
            osword2: undefined,
        };
    }

    public setCat(p: Buffer): void {
        if (getNumSectors(p) !== getNumSectors(this.image)) {
            return errors.generic(`Disk/image size mismatch`);
        }
    }

    public getNextPart(): diskimage.IPart | undefined {
        if (this.partIdx >= this.parts.length) {
            return undefined;
        }

        const part = this.parts[this.partIdx];

        this.numSectorsWritten += part.numSectors;

        const message = `Write ${getMessage(part.beginSector, this.numSectorsWritten, this.numSectorsUsed)}`;

        const data = Buffer.alloc(part.numSectors * SECTOR_SIZE_BYTES);

        let destOffset = 0;

        for (let i = 0; i < part.numSectors; ++i) {
            const offset = getSectorOffset(this.image, part.beginSector + i);

            for (let j = 0; j < SECTOR_SIZE_BYTES; ++j) {
                data[destOffset++] = this.image[offset + j];
            }
        }

        return {
            message,
            osword: createWriteOSWORD(part.beginSector, data),
        };
    }

    public setLastOSWORDResult(data: Buffer): void {
        ++this.partIdx;
    }

    public async finish(): Promise<diskimage.IFinishFlow> {
        return {
            fs: 0,
            fsStarCommand: `FADFS`,
            starCommand: `MOUNT ${this.drive}`,
        };
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export class ReadFlow extends diskimage.Flow {
    private drive: number;
    private allSectors: boolean;
    private file: beebfs.File;
    private log: utils.Log | undefined;// tslint:disable-line no-unused-variable
    private parts: ISectors[];
    private partIdx: number;
    private image: Buffer | undefined;
    private numSectorsRead: number;
    private numSectorsUsed: number;

    public constructor(drive: number, allSectors: boolean, file: beebfs.File, log: utils.Log | undefined) {
        super();

        this.drive = drive;
        this.allSectors = allSectors;
        this.file = file;
        this.log = log;
        this.parts = [];
        this.partIdx = 0;

        this.numSectorsRead = 0;
        this.numSectorsUsed = 0;
    }

    public start(bufferAddress: number, bufferSize: number): diskimage.IStartFlow {
        this.init(bufferAddress, bufferSize, 256 + MAX_PART_SIZE_BYTES);

        return {
            fs: 0,
            fsStarCommand: `FADFS`,
            starCommand: `MOUNT ${this.drive}`,
            osword1: createReadOSWORD(0, 2),
            osword2: undefined,
        };
    }

    public setCat(p: Buffer): void {
        checkCat(p);
        this.parts = getUsedSectors(p, MAX_PART_SIZE_SECTORS, this.allSectors);
        this.image = Buffer.alloc(getNumSectors(p) * SECTOR_SIZE_BYTES);

        for (const part of this.parts) {
            this.numSectorsUsed += part.numSectors;
        }
    }

    public getNextPart(): diskimage.IPart | undefined {
        if (this.image === undefined) {
            return errors.generic(`Flow error`);
        }

        if (this.partIdx >= this.parts.length) {
            return undefined;
        }

        const part = this.parts[this.partIdx];

        this.numSectorsRead += part.numSectors;

        const message = `Read ${getMessage(part.beginSector, this.numSectorsRead, this.numSectorsUsed)}`;

        return {
            message,
            osword: createReadOSWORD(part.beginSector, part.numSectors),
        };
    }

    public setLastOSWORDResult(data: Buffer): void {
        if (this.image === undefined) {
            return errors.generic(`Flow error `);
        }

        const part = this.parts[this.partIdx];

        let srcOffset = 0;

        for (let i = 0; i < part.numSectors; ++i) {
            const destOffset = getSectorOffset(this.image, part.beginSector + i);
            for (let j = 0; j < SECTOR_SIZE_BYTES; ++j) {
                this.image[destOffset + j] = data[srcOffset++];
            }
        }

        ++this.partIdx;
    }

    public async finish(): Promise<diskimage.IFinishFlow> {
        if (this.image === undefined) {
            return errors.generic(`Flow error`);
        }

        await beebfs.FS.writeFile(this.file, this.image);

        return {
            fs: 0,
            fsStarCommand: ``,
            starCommand: ``,
        };
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
