//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////
//
// BeebLink - BBC Micro file storage system
//
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
import * as beebfs from './beebfs';
import * as errors from './errors';
import * as server from './server';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

const TRACK_SIZE_SECTORS = 10;
const SECTOR_SIZE_BYTES = 256;
const TRACK_SIZE_BYTES = TRACK_SIZE_SECTORS * SECTOR_SIZE_BYTES;

const DFS_STAR_COMMAND = 'DISC';

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function checkSize(data: Buffer, minSize: number): void {
    if (data.length % SECTOR_SIZE_BYTES !== 0) {
        return errors.generic('Bad image size (not sector aligned)');
    }

    if (data.length < minSize) {
        return errors.generic(`Bad image size (must be >=${minSize})`);
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function getUsedTracks(data: Buffer, track0Offset: number, allSectors: boolean, log: utils.Log | undefined): number[] {
    if (data[track0Offset + 0x105] % 8 !== 0) {
        return errors.generic('Bad DFS format (file count)');
    }

    const cat0 = Buffer.from(data.buffer, track0Offset, SECTOR_SIZE_BYTES);
    const cat1 = Buffer.from(data.buffer, track0Offset + SECTOR_SIZE_BYTES, SECTOR_SIZE_BYTES);

    if (allSectors) {
        const numSectors = cat1[0x07] | ((cat1[0x08] & 0x03) << 8);

        if (numSectors % TRACK_SIZE_SECTORS !== 0) {
            return errors.generic('Bad DFS format (sector count)');
        }

        const usedTracks: number[] = [];
        for (let index = 0; index < Math.floor(numSectors / TRACK_SIZE_SECTORS); ++index) {
            usedTracks.push(index);
        }

        return usedTracks;
    } else {
        const usedTracksSet = new Set<number>();

        for (let offset = 8; offset <= cat1[0x05]; offset += 8) {

            let size = 0;
            size |= cat1[offset + 4] << 0;
            size |= cat1[offset + 5] << 8;
            size |= (cat1[offset + 6] >> 4 & 3) << 16;

            let startSector = 0;
            startSector |= cat1[offset + 7] << 0;
            startSector |= (cat1[offset + 6] & 3) << 8;

            if (log !== undefined) {
                const name = `${String.fromCharCode(cat0[offset + 7])}.${cat0.toString('binary', offset + 0, offset + 7).trimRight()} `;
                log.pn(`    ${name}: size = 0x${utils.hex8(size)}, start sector = ${startSector} (0x${utils.hex8(startSector)})`);
            }

            for (let i = 0; i < size; i += 256) {
                const sector = startSector + Math.floor(i / SECTOR_SIZE_BYTES);

                usedTracksSet.add(Math.floor(sector / TRACK_SIZE_SECTORS));
            }
        }

        const usedTracks: number[] = [];
        for (const usedTrack of usedTracksSet) {
            usedTracks.push(usedTrack);
        }

        usedTracks.sort();

        // if (log !== undefined) {
        //     log.pn(`Used tracks: ${usedTracks}`);
        // }

        return usedTracks;
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function getAddrString(side: number, track: number): string {
    return `T${track.toString().padStart(2, '0')}`;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function createReadOSWORD(drive: number, track: number, sector: number, numSectors: number): server.IDiskOSWORD {
    const block = Buffer.alloc(11);

    block.writeUInt8(drive, 0);
    block.writeUInt32LE(0xffffffff, 1);//filled in later.
    block.writeUInt8(3, 5);
    block.writeUInt8(0x53, 6);
    block.writeUInt8(track, 7);
    block.writeUInt8(sector, 8);
    block.writeUInt8(1 << 5 | numSectors, 9);

    return {
        reason: 0x7f,
        block,
        data: undefined,
    };
}

// always write whole tracks.
function createWriteOSWORD(drive: number, track: number, data: Buffer): server.IDiskOSWORD {
    const block = Buffer.alloc(11);

    block.writeUInt8(drive, 0);
    block.writeUInt32LE(0xffffffff, 1);//filled in later.
    block.writeUInt8(3, 5);
    block.writeUInt8(0x4b, 6);
    block.writeUInt8(track, 7);
    block.writeUInt8(0, 8);
    block.writeUInt8(1 << 5 | TRACK_SIZE_SECTORS, 9);

    return {
        reason: 0x7f,
        block,
        data,
    };
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

interface ITrackAddress {
    side: number;
    track: number;
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

function sortTrackAddresses(tracks: ITrackAddress[]): void {
    tracks.sort((a: ITrackAddress, b: ITrackAddress) => {
        if (a.track < b.track) {
            return -1;
        } else if (a.track > b.track) {
            return 1;
        } else {
            if (a.side < b.side) {
                return -1;
            } else if (a.side > b.side) {
                return 1;
            }
        }

        return 0;
    });
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export class WriteFlow implements server.IDiskImageFlow {
    private drive: number;
    private doubleSided: boolean;
    private tracks: ITrackAddress[];
    private partIdx: number;
    private log: utils.Log | undefined;
    private oshwm: number | undefined;
    private image: Buffer;

    public constructor(drive: number, doubleSided: boolean, allSectors: boolean, image: Buffer, log: utils.Log | undefined) {
        this.drive = drive;
        this.doubleSided = doubleSided;
        this.partIdx = 0;
        this.log = log;

        this.image = image;

        this.tracks = [];

        if (this.doubleSided) {
            checkSize(image, TRACK_SIZE_BYTES + 512);

            for (const track of getUsedTracks(this.image, 0, allSectors, this.log)) {
                this.tracks.push({ side: 0, track });
            }

            for (const track of getUsedTracks(this.image, TRACK_SIZE_BYTES, allSectors, this.log)) {
                this.tracks.push({ side: 1, track });
            }
        } else {
            checkSize(image, 512);

            for (const track of getUsedTracks(this.image, 0, allSectors, this.log)) {
                this.tracks.push({ side: 0, track });
            }
        }

        sortTrackAddresses(this.tracks);
    }

    public getOSHWM(): number {
        if (this.oshwm === undefined) {
            return errors.generic(`Bad flow (!)`);
        }

        return this.oshwm;
    }

    public start(oshwm: number, himem: number): server.IStartDiskImageFlow {
        if (oshwm + 4096 > himem) {
            return errors.generic(`No room`);
        }

        this.oshwm = oshwm;

        return { fsStarCommand: DFS_STAR_COMMAND, starCommand: ``, osword1: undefined, osword2: undefined };
    }

    public setCat(p: Buffer): void {
        // ...
    }

    public getNextPart(): server.IDiskImagePart | undefined {
        if (this.partIdx >= this.tracks.length) {
            return undefined;
        }

        const addr = this.tracks[this.partIdx];

        let imageOffset: number;
        if (this.doubleSided) {
            imageOffset = addr.track * 2 * TRACK_SIZE_BYTES + addr.side * TRACK_SIZE_BYTES;
        } else {
            imageOffset = addr.track * TRACK_SIZE_BYTES;
        }

        const data = Buffer.alloc(TRACK_SIZE_BYTES);
        for (let i = 0; i < TRACK_SIZE_BYTES && imageOffset + i < this.image.length; ++i) {
            data.writeUInt8(this.image.readUInt8(imageOffset + i), i);
        }

        return {
            message: `${String.fromCharCode(13)}Writing: S${addr.side.toString()} ${getAddrString(addr.side, addr.track)} (${((this.partIdx + 1) / this.tracks.length * 100.0).toFixed(1)}%)`,
            osword: createWriteOSWORD(this.drive + addr.side * 2, addr.track, data),
        };
    }

    public setLastOSWORDResult(data: Buffer): void {
        ++this.partIdx;
    }

    public async finish(): Promise<server.IFinishDiskImageFlow> {
        return {
            fsStarCommand: `DISC`,
            starCommand: ``,
        };
    }
}

//////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////

export class ReadFlow implements server.IDiskImageFlow {
    private drive: number;
    private doubleSided: boolean;
    private allSectors: boolean;
    private tracks: ITrackAddress[] | undefined;
    private partIdx: number;
    private log: utils.Log | undefined;
    private oshwm: number | undefined;
    private file: beebfs.File;
    private image: Buffer | undefined;

    public constructor(drive: number, doubleSided: boolean, allSectors: boolean, file: beebfs.File, log: utils.Log | undefined) {
        this.drive = drive;
        this.doubleSided = doubleSided;
        this.allSectors = allSectors;
        this.partIdx = 0;
        this.log = log;
        this.file = file;
    }

    public getOSHWM(): number {
        if (this.oshwm === undefined) {
            return errors.generic(`Bad flow (!)`);
        }

        return this.oshwm;
    }

    public start(oshwm: number, himem: number): server.IStartDiskImageFlow {
        if (oshwm + 4096 > himem) {
            return errors.generic(`No room`);
        }

        this.oshwm = oshwm;

        const osword1 = createReadOSWORD(this.drive, 0, 0, 2);

        let osword2: server.IDiskOSWORD | undefined;
        if (this.doubleSided) {
            osword2 = createReadOSWORD(this.drive | 2, 0, 0, 2);
        }

        return { fsStarCommand: DFS_STAR_COMMAND, starCommand: ``, osword1, osword2, };
    }

    public setCat(p: Buffer): void {
        if (this.tracks !== undefined) {
            return errors.generic(`Invalid setCat`);
        }

        this.tracks = [];

        if (this.doubleSided) {
            if (p.length !== 1024) {
                return errors.generic(`Bad cat size`);
            }

            for (const track of getUsedTracks(p, 0, this.allSectors, this.log)) {
                this.tracks.push({ side: 0, track });
            }

            for (const track of getUsedTracks(p, 512, this.allSectors, this.log)) {
                this.tracks.push({ side: 1, track });
            }
        } else {
            if (p.length !== 512) {
                return errors.generic(`Bad cat size`);
            }

            for (const track of getUsedTracks(p, 0, this.allSectors, this.log)) {
                this.tracks.push({ side: 0, track });
            }
        }

        sortTrackAddresses(this.tracks);

        // find max track.
        let numTracks = 0;
        for (const addr of this.tracks) {
            numTracks = Math.max(numTracks, addr.track + 1);
        }

        if (this.doubleSided) {
            this.image = Buffer.alloc(numTracks * 2 * TRACK_SIZE_BYTES);
        } else {
            this.image = Buffer.alloc(numTracks * TRACK_SIZE_BYTES);
        }

        if (this.log !== undefined) {
            this.log.pn(`${this.tracks.length} part(s)`);
        }
    }

    public getNextPart(): server.IDiskImagePart | undefined {
        if (this.tracks === undefined || this.partIdx >= this.tracks.length) {
            return undefined;
        }

        const addr = this.tracks[this.partIdx];

        return {
            message: `${String.fromCharCode(13)}Reading: S${addr.side.toString()} ${getAddrString(addr.side, addr.track)} (${((this.partIdx + 1) / this.tracks.length * 100.0).toFixed(1)}%)`,
            osword: createReadOSWORD(this.drive + addr.side * 2, addr.track, 0, TRACK_SIZE_SECTORS),
        };
    }

    public setLastOSWORDResult(data: Buffer): void {
        if (this.tracks === undefined || this.partIdx >= this.tracks.length || this.image === undefined) {
            return errors.generic(`Invalid setLastOSWORDResult`);
        }

        if (data.length !== TRACK_SIZE_BYTES) {
            return errors.generic(`Invalid track data (bad size{`);
        }

        const addr = this.tracks[this.partIdx];

        let offset: number;
        if (this.doubleSided) {
            offset = addr.track * 2 * TRACK_SIZE_BYTES + addr.side * TRACK_SIZE_BYTES;
        } else {
            offset = addr.track * TRACK_SIZE_BYTES;
        }

        data.copy(this.image, offset);

        ++this.partIdx;
    }

    public async finish(): Promise<server.IFinishDiskImageFlow> {
        if (this.tracks === undefined || this.partIdx !== this.tracks.length || this.image === undefined) {
            return errors.generic(`Invalid finish`);
        }

        await beebfs.FS.writeFile(this.file, this.image);

        return {
            fsStarCommand: '',
            starCommand: '',
        };
    }
}
